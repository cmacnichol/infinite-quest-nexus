import { narrationRevisionFingerprint } from "../../packages/domain/src/narration-revision-fingerprint.js";

export type RepairState = Readonly<{
  continuitySummary: string;
  openThreads: string[];
  canonicalFacts: Array<{ id: string | null; content: string }>;
  scratchpad: string;
  trackers: unknown[];
  rpgStats: unknown[];
  eventTriggers: unknown[];
  pendingEventTriggers: unknown[];
}>;

export type RepairSource = Readonly<{
  campaignId: string;
  ownerUserId: string;
  worldVersionId: string;
  baseRevision: number;
  baseTurnNumber: number;
  activeTurnNumber: number;
  currentState: RepairState;
  acceptedSnapshots: Array<{ turnId: string; turnNumber: number; snapshot: Partial<RepairState> }>;
  effectiveNarrations: Array<{ turnId: string; turnNumber: number; correctionRevision: number; text: string }>;
  stateEdits: Array<{ id: string; revision: number; effectiveTurnNumber: number; snapshot: Partial<RepairState> }>;
  missingSources?: Array<{ reference: string }>;
  retiredFactIds?: string[];
}>;

type Evidence = { id: string | null; content: string; source: Record<string, unknown>; turnNumber: number; revision: number };

const stateKeys = ["continuitySummary", "openThreads", "canonicalFacts", "scratchpad", "trackers", "rpgStats", "eventTriggers", "pendingEventTriggers"] as const;

function completeState(value: Partial<RepairState>): RepairState {
  return {
    continuitySummary: value.continuitySummary ?? "", openThreads: value.openThreads ?? [], canonicalFacts: value.canonicalFacts ?? [], scratchpad: value.scratchpad ?? "",
    trackers: value.trackers ?? [], rpgStats: value.rpgStats ?? [], eventTriggers: value.eventTriggers ?? [], pendingEventTriggers: value.pendingEventTriggers ?? []
  };
}

function valueKey(fact: { id: string | null; content: string }): string {
  return fact.id ?? `content:${fact.content.normalize("NFKC").trim().toLocaleLowerCase()}`;
}

function sourceAction(input: RepairSource, canonicalFacts: Array<{ id: string | null; content: string }>) {
  return {
    method: "PATCH" as const,
    path: `/api/v1/campaigns/${input.campaignId}/state`,
    body: { ...completeState(input.currentState), canonicalFacts, expectedTurnNumber: input.activeTurnNumber, expectedRevision: input.baseRevision, effectiveTurnNumber: input.activeTurnNumber, expectedNarrationRevisionFingerprint: narrationRevisionFingerprint(input.effectiveNarrations) }
  };
}

/** Creates a review-only artifact from retained authority. It does not infer facts from narration. */
export function buildContinuityRepairProposal(input: RepairSource) {
  const current = completeState(input.currentState);
  const currentFacts = new Map(current.canonicalFacts.map((fact) => [valueKey(fact), fact]));
  const retiredFactIds = new Set(input.retiredFactIds ?? []);
  const evidence = new Map<string, Evidence[]>();
  for (const snapshot of input.acceptedSnapshots) {
    for (const fact of snapshot.snapshot.canonicalFacts ?? []) {
      const key = valueKey(fact);
      evidence.set(key, [...(evidence.get(key) ?? []), { ...fact, source: { kind: "accepted_snapshot", turnId: snapshot.turnId, turnNumber: snapshot.turnNumber }, turnNumber: snapshot.turnNumber, revision: -1 }]);
    }
  }
  for (const edit of input.stateEdits) {
    for (const fact of edit.snapshot.canonicalFacts ?? []) {
      const key = valueKey(fact);
      evidence.set(key, [...(evidence.get(key) ?? []), { ...fact, source: { kind: "state_edit", id: edit.id, revision: edit.revision, effectiveTurnNumber: edit.effectiveTurnNumber }, turnNumber: edit.effectiveTurnNumber, revision: edit.revision }]);
    }
  }
  const proposals: Array<Record<string, unknown>> = [];
  const vetoes: Array<Record<string, unknown>> = [];
  const unrecoverable: Array<Record<string, unknown>> = (input.missingSources ?? []).map((source) => ({ reason: "retained_source_unavailable", source }));
  for (const [key, records] of evidence) {
    if (currentFacts.has(key)) continue;
    if (records.some((record) => record.id !== null && retiredFactIds.has(record.id))) {
      vetoes.push({ key, reason: "superseded_or_deleted_fact", evidence: records.map(({ source }) => source) });
      continue;
    }
    const latest = [...records].sort((a, b) => b.turnNumber - a.turnNumber || b.revision - a.revision)[0]!;
    const newest = records.filter((record) => record.turnNumber === latest.turnNumber && record.revision === latest.revision);
    const contents = new Set(records.map((record) => record.content));
    // A turn snapshot records state, not a claim that a later differing value
    // supersedes it. Only an explicit state edit can establish that intent.
    if (contents.size > 1 && newest.some((record) => record.source.kind !== "state_edit")) {
      unrecoverable.push({ key, reason: "ambiguous_retained_evidence", evidence: records.map(({ source, content }) => ({ source, content })) });
      continue;
    }
    const selected = newest[0]!;
    const laterOverride = input.stateEdits.find((edit) => (edit.effectiveTurnNumber > selected.turnNumber || (edit.effectiveTurnNumber === selected.turnNumber && edit.revision > selected.revision))
      && Array.isArray(edit.snapshot.canonicalFacts) && !edit.snapshot.canonicalFacts.some((fact) => valueKey(fact) === key));
    if (laterOverride) {
      vetoes.push({ key, reason: laterOverride.snapshot.canonicalFacts!.length ? "later_explicit_correction_deletion" : "later_explicit_empty_correction", laterOverride: { id: laterOverride.id, revision: laterOverride.revision, effectiveTurnNumber: laterOverride.effectiveTurnNumber } });
      continue;
    }
    const correctedSource = selected.source.kind === "accepted_snapshot" ? input.effectiveNarrations.find((narration) => narration.turnId === selected.source.turnId && narration.correctionRevision > 0 && !narration.text.includes(selected.content)) : undefined;
    if (correctedSource) {
      unrecoverable.push({ key, reason: "corrected_source_requires_review", source: selected.source, correctionRevision: correctedSource.correctionRevision });
      continue;
    }
    // Historical IDs are evidence only; the state API creates a fresh fact from null.
    const proposedFacts = [...current.canonicalFacts, { id: null, content: selected.content }];
    const narrationEvidence = input.effectiveNarrations.flatMap((narration) => {
      const offset = narration.text.indexOf(selected.content);
      return offset === -1 ? [] : [{ turnId: narration.turnId, turnNumber: narration.turnNumber, correctionRevision: narration.correctionRevision, quote: selected.content, startOffset: offset, endOffset: offset + selected.content.length }];
    });
    proposals.push({ id: `canonical-fact:${key}`, status: "proposed", field: "canonicalFacts", currentValue: null, proposedValue: selected.content, confidence: "retained_source_verified", ambiguity: "Human review must check later narration and changed circumstances.", source: selected.source, narrationEvidence, laterOverrides: [], ...(input.baseTurnNumber === input.activeTurnNumber ? { apply: sourceAction(input, proposedFacts) } : { requiresSeparateAuthorizedAction: "historical_base_turn" }) });
  }
  return {
    version: "continuity-repair-proposal-v1",
    mode: "read_only_review",
    campaign: { id: input.campaignId, ownerUserId: input.ownerUserId, worldVersionId: input.worldVersionId },
    revisionGuard: { campaignId: input.campaignId, worldVersionId: input.worldVersionId, expectedRevision: input.baseRevision, expectedTurnNumber: input.activeTurnNumber, baseTurnNumber: input.baseTurnNumber },
    effectiveNarrations: input.effectiveNarrations.map(({ turnId, turnNumber, correctionRevision }) => ({ turnId, turnNumber, correctionRevision })),
    proposals, vetoes, unrecoverable,
    review: { required: true, eachProposalIndependent: true, derivedRebuildRequiresSeparateAuthorization: true },
    sourceFields: stateKeys
  };
}

/** A reviewer must re-read these guards immediately before the separate API action. */
export function proposalRevisionIsStale(
  proposal: ReturnType<typeof buildContinuityRepairProposal>,
  observed: { stateRevision: number; narrationCorrectionRevisions: Array<{ turnId: string; correctionRevision: number }> }
): boolean {
  if (proposal.revisionGuard.expectedRevision !== observed.stateRevision) return true;
  const expected = new Map(proposal.effectiveNarrations.map((item) => [item.turnId, item.correctionRevision]));
  if (expected.size !== observed.narrationCorrectionRevisions.length) return true;
  return observed.narrationCorrectionRevisions.some((item) => expected.get(item.turnId) !== item.correctionRevision);
}

export type Queryable = { query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };

/** Reads all authority under one repeatable, read-only transaction. */
export async function loadContinuityRepairSource(client: Queryable, campaignId: string, ownerUserId: string, worldVersionId: string, baseTurnNumber: number): Promise<RepairSource> {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const state = await client.query<{ active_turn_number: number; revision: number; initial_state_snapshot: Partial<RepairState>; scratchpad_private: string; trackers: unknown[]; rpg_stats: unknown[]; event_triggers: unknown[]; pending_event_triggers: unknown[] }>(
      `SELECT campaign.active_turn_number, state.revision, state.initial_state_snapshot, state.scratchpad_private,state.trackers,state.rpg_stats,state.event_triggers,state.pending_event_triggers FROM campaigns campaign JOIN campaign_state state ON state.campaign_id=campaign.id AND state.owner_user_id=campaign.owner_user_id WHERE campaign.id=$1 AND campaign.owner_user_id=$2 AND campaign.world_version_id=$3`, [campaignId, ownerUserId, worldVersionId]);
    const row = state.rows[0];
    if (!row) throw new Error("Campaign is not authorized for continuity repair.");
    if (!Number.isInteger(baseTurnNumber) || baseTurnNumber < 0 || baseTurnNumber > row.active_turn_number) throw new Error("Base turn is not available for this campaign.");
    const snapshots = await client.query<{ turn_id: string; turn_number: number; state_snapshot_private: Partial<RepairState> }>("SELECT id AS turn_id,turn_number,state_snapshot_private FROM turns WHERE campaign_id=$1 AND owner_user_id=$2 AND turn_number <= $3 ORDER BY turn_number", [campaignId, ownerUserId, baseTurnNumber]);
    const narrations = await client.query<{ turn_id: string; turn_number: number; correction_revision: number; effective_narration: string }>("SELECT turn_id,turn_number,correction_revision,effective_narration FROM effective_turn_narrations WHERE campaign_id=$1 AND owner_user_id=$2 AND turn_number <= $3 ORDER BY turn_number", [campaignId, ownerUserId, baseTurnNumber]);
    const edits = await client.query<{ id: string; revision: number; effective_turn_number: number; state_snapshot_private: Partial<RepairState> }>("SELECT id,revision,effective_turn_number,state_snapshot_private FROM campaign_state_edits WHERE campaign_id=$1 AND owner_user_id=$2 AND effective_turn_number <= $3 ORDER BY effective_turn_number,revision", [campaignId, ownerUserId, baseTurnNumber]);
    const activeFacts = await client.query<{ id: string; content: string }>("SELECT id,content FROM campaign_canonical_facts WHERE campaign_id=$1 AND owner_user_id=$2 AND valid_from_turn <= $3 AND (valid_until_turn IS NULL OR valid_until_turn > $3) ORDER BY source_turn_number,source_fact_index", [campaignId, ownerUserId, baseTurnNumber]);
    const retiredFacts = await client.query<{ id: string }>("SELECT id FROM campaign_canonical_facts WHERE campaign_id=$1 AND owner_user_id=$2 AND valid_from_turn <= $3 AND (valid_until_turn IS NOT NULL AND valid_until_turn <= $3 OR superseded_by_fact_id IS NOT NULL)", [campaignId, ownerUserId, baseTurnNumber]);
    await client.query("COMMIT");
    const acceptedSnapshots = snapshots.rows.map((item) => ({ turnId: item.turn_id, turnNumber: item.turn_number, snapshot: item.state_snapshot_private }));
    const stateEdits = edits.rows.map((item) => ({ id: item.id, revision: item.revision, effectiveTurnNumber: item.effective_turn_number, snapshot: item.state_snapshot_private }));
    const exactEdit = [...stateEdits].filter((edit) => edit.effectiveTurnNumber === baseTurnNumber).at(-1);
    const acceptedState = acceptedSnapshots.find((snapshot) => snapshot.turnNumber === baseTurnNumber)?.snapshot ?? row.initial_state_snapshot;
    const currentState = completeState(exactEdit?.snapshot ?? (baseTurnNumber === row.active_turn_number ? { ...acceptedState, scratchpad: row.scratchpad_private, trackers: row.trackers, rpgStats: row.rpg_stats, eventTriggers: row.event_triggers, pendingEventTriggers: row.pending_event_triggers, canonicalFacts: activeFacts.rows } : { ...acceptedState, canonicalFacts: activeFacts.rows }));
    return { campaignId, ownerUserId, worldVersionId, baseRevision: row.revision, baseTurnNumber, activeTurnNumber: row.active_turn_number, currentState, acceptedSnapshots, effectiveNarrations: narrations.rows.map((item) => ({ turnId: item.turn_id, turnNumber: item.turn_number, correctionRevision: item.correction_revision, text: item.effective_narration })), stateEdits, retiredFactIds: retiredFacts.rows.map((fact) => fact.id) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
