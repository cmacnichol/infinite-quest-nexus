import type {
  CampaignRuntimeStateResponse,
  CampaignSyncStatus,
  TurnInputModeSource,
  TurnInputSelection,
  TurnListResponse,
  TurnSummary
} from "@infinite-quest/contracts";
import type { GenerationEvent, GenerationRun } from "./generation/types.js";
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
    const generation = hydrateGeneration(sync, nextWindow.turns);

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
    const turns = normalizeTurns([...page.turns, ...previous.turns]);
    writable.set({ ...previous, turns, nextTurnsCursor: page.nextCursor });
  }

  function setTurnInput(mode: TurnInputSelection, source: TurnInputModeSource | null): void {
    const previous = current();
    writable.set({ ...previous, requestedTurnInputMode: mode, nextTurnInputModeSource: source });
  }

  function attachGeneration(run: GenerationRun): GenerationProjectionSession {
    const previous = current();
    if (previous.campaign === null || previous.campaign.id !== run.campaignId) throw protocol("campaign_mismatch");
    const session = createSession(run, () => liveGeneration?.session === session);
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

  return { store: writable, load, loadRuntimeState, prependOlderTurns, setTurnInput, attachGeneration };
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

function createSession(run: GenerationRun, isActive: () => boolean): GenerationProjectionSession {
  return {
    campaignId: run.campaignId,
    jobId: run.jobId,
    apply(_event: GenerationEvent) {
      if (!isActive()) return;
      // Task 7c owns event reduction. The session identity exists now so stale
      // app iterators cannot become a second authority during hydration.
    },
    async retryResult() {
      if (!isActive()) return;
      throw protocol("result_retry_not_available");
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

function operationOf(value: { operationKind: "append"; replacementTurnId: null } | { operationKind: "replace_latest"; replacementTurnId: string }): GenerationOperationProjection {
  return value.operationKind === "append"
    ? { operationKind: "append", replacementTurnId: null }
    : { operationKind: "replace_latest", replacementTurnId: value.replacementTurnId };
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
