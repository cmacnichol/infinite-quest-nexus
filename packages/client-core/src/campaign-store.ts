import type {
  CampaignRuntimeStateResponse,
  CampaignSyncStatus,
  GenerationResult,
  TurnInputModeSource,
  TurnInputSelection,
  TurnListResponse,
  TurnSummary
} from "@infinite-quest/contracts";
import type { GenerationEvent, GenerationRun } from "./generation/types.js";
import {
  copyOperation,
  copySnapshot,
  copyStateSnapshot,
  safeFailureMessage,
  safeUnavailableError,
  turnFromGenerationResult,
  type GenerationOperation
} from "./generation/projection.js";
import type {
  CampaignProjection,
  GenerationJobProjection,
  GenerationOperationProjection,
  HydratedGenerationProjection
} from "./campaign-projection.js";
import { createWritableStore, type Immutable, type Store } from "./store.js";

export type CampaignProjectionProtocolErrorKind =
  | "campaign_not_loaded"
  | "campaign_mismatch"
  | "page_campaign_mismatch"
  | "runtime_state_campaign_mismatch"
  | "unchanged_window_without_baseline"
  | "job_mismatch"
  | "duplicate_turn_id"
  | "duplicate_turn_number"
  | "result_turn_mismatch"
  | "replacement_target_missing"
  | "replacement_target_mismatch"
  | "result_retry_not_available";

export class CampaignProjectionProtocolError extends Error {
  readonly kind: CampaignProjectionProtocolErrorKind;

  constructor(kind: CampaignProjectionProtocolErrorKind) {
    super(kind);
    this.name = "CampaignProjectionProtocolError";
    this.kind = kind;
  }
}

export interface GenerationProjectionSession {
  readonly campaignId: string;
  readonly jobId: string;
  apply(event: GenerationEvent): void;
  retryResult(): Promise<void>;
}

export interface CampaignStoreController {
  readonly store: Store<CampaignProjection>;
  load(sync: CampaignSyncStatus): void;
  loadRuntimeState(runtime: CampaignRuntimeStateResponse): void;
  prependOlderTurns(page: TurnListResponse): void;
  setTurnInput(mode: TurnInputSelection, source: TurnInputModeSource | null): void;
  attachGeneration(run: GenerationRun): GenerationProjectionSession;
}

const EMPTY_PROJECTION: CampaignProjection = {
  campaign: null,
  world: null,
  playerConfig: null,
  turns: [],
  nextTurnsCursor: null,
  syncToken: null,
  historySyncRequired: false,
  runtimeState: null,
  latestStateSnapshot: null,
  requestedTurnInputMode: "action",
  nextTurnInputModeSource: null,
  generation: null
};

interface LiveGeneration {
  run: GenerationRun;
  session: GenerationProjectionSession;
}

export function createCampaignStore(): CampaignStoreController {
  const writable = createWritableStore<CampaignProjection>(EMPTY_PROJECTION);
  let liveGeneration: LiveGeneration | null = null;

  function current(): Immutable<CampaignProjection> {
    return writable.get();
  }

  function load(sync: CampaignSyncStatus): void {
    if (sync.id !== sync.campaign.id) throw protocol("campaign_mismatch");
    const previous = current();
    const switchingCampaign = previous.campaign !== null && previous.campaign.id !== sync.campaign.id;
    const isSameCampaign = previous.campaign?.id === sync.campaign.id;
    const nextWindow = resolveWindow(sync, previous, isSameCampaign);
    const hydratedGeneration = hydrateGeneration(sync, nextWindow.turns);
    const generation = mergeMatchingLiveGeneration(previous.generation, hydratedGeneration, liveGeneration);

    if (switchingCampaign || (liveGeneration && liveGeneration.run.jobId !== generation?.jobId)) {
      liveGeneration = null;
    }
    writable.set({
      campaign: clone(sync.campaign),
      world: clone(sync.world),
      playerConfig: clone(sync.playerConfig),
      turns: nextWindow.turns,
      nextTurnsCursor: nextWindow.nextTurnsCursor,
      syncToken: sync.syncToken,
      historySyncRequired: false,
      runtimeState: switchingCampaign ? null : previous.runtimeState,
      latestStateSnapshot: switchingCampaign ? null : previous.latestStateSnapshot,
      requestedTurnInputMode: previous.requestedTurnInputMode,
      nextTurnInputModeSource: previous.nextTurnInputModeSource,
      generation
    });
  }

  function loadRuntimeState(runtime: CampaignRuntimeStateResponse): void {
    const previous = current();
    if (previous.campaign === null) throw protocol("campaign_not_loaded");
    if (runtime.campaignId !== previous.campaign.id) throw protocol("runtime_state_campaign_mismatch");
    writable.set({ ...previous, runtimeState: clone(runtime) });
  }

  function prependOlderTurns(page: TurnListResponse): void {
    const previous = current();
    if (previous.campaign === null) throw protocol("campaign_not_loaded");
    if (page.campaignId !== previous.campaign.id) throw protocol("page_campaign_mismatch");
    const turns = mergeOlderTurns(previous.turns, page.turns);
    writable.set({ ...previous, turns, nextTurnsCursor: page.nextCursor });
  }

  function setTurnInput(mode: TurnInputSelection, source: TurnInputModeSource | null): void {
    const previous = current();
    writable.set({ ...previous, requestedTurnInputMode: mode, nextTurnInputModeSource: source });
  }

  function attachGeneration(run: GenerationRun): GenerationProjectionSession {
    const previous = current();
    if (previous.campaign === null || previous.campaign.id !== run.campaignId) throw protocol("campaign_mismatch");
    let session: GenerationProjectionSession;
    session = createSession(
      run,
      () => liveGeneration?.session === session,
      (event) => applyGenerationEvent(run, event),
      async () => {
        const generation = current().generation;
        if (generation?.result.state !== "unavailable") throw protocol("result_retry_not_available");
        applyGenerationEvent(run, await run.fetchResult());
      }
    );
    liveGeneration = { run, session };
    const existing = previous.generation;
    const generation: GenerationJobProjection = existing?.jobId === run.jobId
      ? { ...existing, monitoring: "attached" }
      : {
          campaignId: run.campaignId,
          jobId: run.jobId,
          origin: "live",
          operation: operationOf(run),
          monitoring: "attached",
          hydratedGeneration: null,
          snapshot: null,
          narration: "",
          transport: { state: "unobserved" },
          result: { state: "pending" }
        };
    writable.set({ ...previous, generation });
    return session;
  }

  function resolveWindow(
    sync: CampaignSyncStatus,
    previous: Immutable<CampaignProjection>,
    isSameCampaign: boolean
  ): Pick<CampaignProjection, "turns" | "nextTurnsCursor"> {
    if (sync.turnWindowMode === "unchanged") {
      if (!isSameCampaign || previous.syncToken === null) throw protocol("unchanged_window_without_baseline");
      return { turns: previous.turns, nextTurnsCursor: previous.nextTurnsCursor };
    }
    if (sync.turns.campaignId !== sync.id || sync.turns.campaignId !== sync.campaign.id) throw protocol("page_campaign_mismatch");
    return { turns: normalizeTurns(sync.turns.turns), nextTurnsCursor: sync.turns.nextCursor };
  }

  function hydrateGeneration(sync: CampaignSyncStatus, turns: readonly Immutable<TurnSummary>[]): GenerationJobProjection | null {
    const pending = sync.pendingGeneration;
    if (pending) {
      return hydratedJob(sync.campaign.id, "hydrated_pending", copyPending(pending), { state: "pending" });
    }
    const recovery = sync.generationRecovery;
    if (!recovery || (recovery.status === "completed" && recovery.resultTurnId !== null && turns.some((turn) => turn.id === recovery.resultTurnId))) return null;
    const summary: HydratedGenerationProjection = {
      source: "recovery",
      id: recovery.id,
      status: recovery.status,
      action: null,
      expectedTurnNumber: recovery.expectedTurnNumber,
      attempts: recovery.attempts,
      resultTurnId: recovery.resultTurnId,
      operation: operationOf(recovery)
    };
    const result = recovery.status === "failed"
      ? { state: "failed" as const, outcome: "failed" as const, message: "Generation could not complete." }
      : recovery.status === "completed"
        ? { state: "unavailable" as const, message: "Accepted result is ready to load.", correlationId: null }
        : { state: "pending" as const };
    return hydratedJob(sync.campaign.id, "hydrated_recovery", summary, result);
  }

  function mergeMatchingLiveGeneration(
    previous: Immutable<GenerationJobProjection> | null,
    hydrated: GenerationJobProjection | null,
    live: LiveGeneration | null
  ): GenerationJobProjection | null {
    if (hydrated === null
      || previous === null
      || live === null
      || hydrated.jobId !== live.run.jobId
      || previous.jobId !== live.run.jobId) return hydrated;
    return {
      ...hydrated,
      monitoring: "attached",
      snapshot: previous.snapshot,
      narration: previous.narration,
      transport: previous.transport
    };
  }

  function copyPending(pending: NonNullable<CampaignSyncStatus["pendingGeneration"]>): HydratedGenerationProjection {
    return {
      source: "pending",
      id: pending.id,
      status: pending.status,
      action: pending.action,
      expectedTurnNumber: pending.expectedTurnNumber,
      attempts: null,
      resultTurnId: null,
      operation: operationOf(pending)
    };
  }

  function hydratedJob(
    campaignId: string,
    origin: "hydrated_pending" | "hydrated_recovery",
    hydratedGeneration: HydratedGenerationProjection,
    result: GenerationJobProjection["result"]
  ): GenerationJobProjection {
    return {
      campaignId,
      jobId: hydratedGeneration.id,
      origin,
      operation: hydratedGeneration.operation,
      monitoring: "detached",
      hydratedGeneration: clone(hydratedGeneration),
      snapshot: null,
      narration: "",
      transport: { state: "unobserved" },
      result
    };
  }

  function applyGenerationEvent(run: GenerationRun, event: GenerationEvent): void {
    const previous = current();
    const generation = previous.generation;
    if (generation === null) return;

    if (event.type === "status") {
      if (event.snapshot.id !== run.jobId) throw protocol("job_mismatch");
      if (event.snapshot.campaignId !== run.campaignId) throw protocol("campaign_mismatch");
      if (event.snapshot.operationKind !== run.operationKind
        || event.snapshot.replacementTurnId !== run.replacementTurnId) throw protocol("job_mismatch");
      writable.set({
        ...previous,
        generation: {
          ...generation,
          operation: operationOf(event.snapshot),
          hydratedGeneration: null,
          snapshot: copySnapshot(event.snapshot),
          transport: { state: "healthy" },
          result: { state: "pending" }
        }
      });
      return;
    }

    if (event.type === "narration") {
      writable.set({ ...previous, generation: { ...generation, narration: event.text } });
      return;
    }

    if (event.type === "degraded") {
      writable.set({
        ...previous,
        generation: {
          ...generation,
          transport: { state: "degraded", reason: event.reason, consecutiveFailures: event.consecutiveFailures }
        }
      });
      return;
    }

    if (event.type === "detached") {
      if (event.jobId !== run.jobId) throw protocol("job_mismatch");
      writable.set({ ...previous, generation: { ...generation, monitoring: "detached" } });
      return;
    }

    if (event.type === "result_unavailable") {
      if (event.jobId !== run.jobId) throw protocol("job_mismatch");
      const safe = safeUnavailableError(event.error);
      writable.set({
        ...previous,
        generation: { ...generation, result: { state: "unavailable", ...safe } }
      });
      return;
    }

    if (event.type !== "settled") return;

    if (event.outcome === "cancelled" || event.outcome === "discarded") {
      liveGeneration = null;
      writable.set({ ...previous, generation: null });
      return;
    }

    if (event.outcome === "failed" || event.outcome === "unrecoverable") {
      writable.set({
        ...previous,
        generation: {
          ...generation,
          result: { state: "failed", outcome: event.outcome, message: safeFailureMessage(event.error) }
        }
      });
      return;
    }

    if (event.outcome !== "completed") return;
    applyCompletedResult(run, event.result, previous, generation);
  }

  function applyCompletedResult(
    run: GenerationRun,
    result: GenerationResult,
    previous: Immutable<CampaignProjection>,
    generation: Immutable<GenerationJobProjection>
  ): void {
    if (result.id !== run.jobId) throw protocol("job_mismatch");
    if (result.campaignId !== run.campaignId) throw protocol("campaign_mismatch");
    if (result.expectedTurnNumber !== result.turnNumber) throw protocol("result_turn_mismatch");
    if (previous.campaign === null) throw protocol("campaign_not_loaded");

    const accepted = turnFromGenerationResult(result);
    const matching = previous.turns.find((turn) => turn.id === accepted.id);
    const sameNumber = previous.turns.find((turn) => turn.turnNumber === accepted.turnNumber);
    const outsideWindow = previous.turns.length > 0
      && accepted.turnNumber < previous.turns[0]!.turnNumber
      && previous.nextTurnsCursor !== null;
    let turns = previous.turns;
    let locallyChanged = false;

    if (matching !== undefined) {
      if (matching.turnNumber !== accepted.turnNumber) throw protocol("duplicate_turn_id");
    } else if (outsideWindow) {
      // The bounded page cannot safely accept a disconnected historical turn.
    } else if (generation.operation.operationKind === "append") {
      if (sameNumber !== undefined) throw protocol("duplicate_turn_number");
      turns = normalizeTurns([...previous.turns, accepted]);
      locallyChanged = true;
    } else {
      const target = previous.turns.find((turn) => turn.id === generation.operation.replacementTurnId);
      if (target === undefined) throw protocol("replacement_target_missing");
      if (target.turnNumber !== accepted.turnNumber) throw protocol("replacement_target_mismatch");
      if (sameNumber !== undefined && sameNumber.id !== target.id) throw protocol("replacement_target_mismatch");
      turns = previous.turns.map((turn) => turn.id === target.id ? clone(accepted) : turn);
      locallyChanged = true;
    }

    const campaign = locallyChanged
      ? clone({ ...previous.campaign, activeTurnNumber: accepted.turnNumber }) as CampaignSyncStatus["campaign"]
      : previous.campaign;
    liveGeneration = null;
    writable.set({
      ...previous,
      campaign,
      turns,
      nextTurnsCursor: locallyChanged ? null : previous.nextTurnsCursor,
      syncToken: locallyChanged ? null : previous.syncToken,
      historySyncRequired: locallyChanged || previous.historySyncRequired,
      runtimeState: null,
      latestStateSnapshot: copyStateSnapshot(result.stateSnapshot),
      generation: null
    });
  }

  return { store: writable, load, loadRuntimeState, prependOlderTurns, setTurnInput, attachGeneration };
}

function createSession(
  run: GenerationRun,
  isActive: () => boolean,
  applyEvent: (event: GenerationEvent) => void,
  retryResult: () => Promise<void>
): GenerationProjectionSession {
  return {
    campaignId: run.campaignId,
    jobId: run.jobId,
    apply(event: GenerationEvent) {
      if (!isActive()) return;
      applyEvent(event);
    },
    async retryResult() {
      if (!isActive()) return;
      await retryResult();
    }
  };
}

function normalizeTurns(turns: readonly Immutable<TurnSummary>[]): readonly Immutable<TurnSummary>[] {
  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const turn of turns) {
    if (ids.has(turn.id)) throw protocol("duplicate_turn_id");
    if (numbers.has(turn.turnNumber)) throw protocol("duplicate_turn_number");
    ids.add(turn.id);
    numbers.add(turn.turnNumber);
  }
  return turns.map((turn) => clone(turn)).sort((left, right) => left.turnNumber - right.turnNumber);
}

function mergeOlderTurns(
  currentTurns: readonly Immutable<TurnSummary>[],
  olderTurns: readonly Immutable<TurnSummary>[]
): readonly Immutable<TurnSummary>[] {
  const normalizedOlderTurns = normalizeTurns(olderTurns);
  const byId = new Map<string, Immutable<TurnSummary>>();
  const byNumber = new Map<number, Immutable<TurnSummary>>();
  for (const turn of currentTurns) {
    byId.set(turn.id, turn);
    byNumber.set(turn.turnNumber, turn);
  }

  for (const incoming of normalizedOlderTurns) {
    const sameId = byId.get(incoming.id);
    const sameNumber = byNumber.get(incoming.turnNumber);
    if (sameId !== undefined && sameId.turnNumber !== incoming.turnNumber) throw protocol("duplicate_turn_id");
    if (sameNumber !== undefined && sameNumber.id !== incoming.id) throw protocol("duplicate_turn_number");
    if (sameId !== undefined) {
      const selected = richerTurn(sameId, incoming);
      byId.set(selected.id, selected);
      byNumber.set(selected.turnNumber, selected);
      continue;
    }
    const copied = clone(incoming);
    byId.set(copied.id, copied);
    byNumber.set(copied.turnNumber, copied);
  }

  return [...byNumber.values()].sort((left, right) => left.turnNumber - right.turnNumber);
}

function richerTurn(
  existing: Immutable<TurnSummary>,
  incoming: Immutable<TurnSummary>
): Immutable<TurnSummary> {
  const score = (turn: Immutable<TurnSummary>): number => (
    (turn.imageUrl === null ? 0 : 4)
    + (turn.reportedCost === null ? 0 : 2)
    + (turn.choices.length > 0 ? 1 : 0)
    + (turn.narration.length > 0 ? 1 : 0)
  );
  return score(incoming) > score(existing) ? clone(incoming) : existing;
}

function operationOf(value: GenerationOperation): GenerationOperationProjection {
  return copyOperation(value);
}

function protocol(kind: CampaignProjectionProtocolErrorKind): CampaignProjectionProtocolError {
  return new CampaignProjectionProtocolError(kind);
}

type DateValue = { getTime: () => number; setTime: (milliseconds: number) => number; constructor: new (milliseconds: number) => unknown };

function isDateValue(value: object): value is DateValue {
  return "getTime" in value
    && "setTime" in value
    && "getFullYear" in value
    && "setFullYear" in value
    && "toISOString" in value;
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (value !== null && typeof value === "object") {
    if (isDateValue(value)) return new value.constructor(value.getTime()) as T;
    const copied: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copied[key] = clone(item);
    return copied as T;
  }
  return value;
}
