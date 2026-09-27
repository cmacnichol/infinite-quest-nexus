import type { CampaignWorldVersionMemoryScope } from "../../application/src/memory/index.js";
import { campaignRuntimeStateContentSchema, type CampaignRuntimeStateContent } from "../../contracts/src/generation.js";
import type { DatabaseClient } from "./pool.js";
import { z } from "zod";
import { buildCanonicalChronicleFacts, combineCanonicalChronicleFacts } from "../../domain/src/chronicle-memory-helpers.js";
import { createCorrectionCanonicalFactId, normalizeCanonicalFactContent } from "../../domain/src/canonical-facts.js";
import type { ProtectedFact, ProtectedFactSourceCoverage } from "../../application/src/memory/story-history-facts.js";
import type { GenerationOptionalFactFrontier } from "../../application/src/memory/types.js";

type VerifiedFact = Readonly<{ id: string; content: string; factIndex?: number; sourceStateEditId?: string | null }>;
type ProtectedFactCandidate = Readonly<{
  id: string;
  content: string | null;
  source_turn_number: number;
  source_fact_index: number;
  source_turn_id: string | null;
  source_state_edit_id: string | null;
}>;

export const MAX_PROTECTED_FACT_CANDIDATE_ROWS = 512;
export const MAX_PROTECTED_FACT_SOURCE_BYTES = 1_000_000;
export const MAX_PROTECTED_FACT_CONTENT_CHARACTERS = 4_000;
export const MAX_PROTECTED_FACT_CONTENT_BYTES = 16_000;
/** Deferred retrieval verifies a finite selected candidate set, never a new frontier. */
export const MAX_OPTIONAL_GENERATION_FACT_CANDIDATES = 2_048;
const acceptedFactsSchema = z.object({
  canonicalFacts: z.array(z.union([z.string().min(1).max(4_000), z.object({ id: z.uuid().nullable(), content: z.string().min(1).max(4_000) }).strict()])).max(100).default([]),
  canonicalFactUpdates: z.array(z.object({ content: z.string().min(1).max(4_000),
    supersedesFactIds: z.array(z.uuid()).max(100).default([]) })).max(100).default([])
});

function authorityBoundary<T>(read: () => T): T {
  try { return read(); }
  catch {
    throw Object.assign(new Error("The canonical fact authority is invalid."), {
      code: "authoritative_context_invalid", field: "canonical_facts"
    });
  }
}

function verifiedFactId(id: string, content: string, activeFacts: readonly VerifiedFact[], expectedIndex?: number): string | null {
  return activeFacts.some((fact) => fact.id === id && (expectedIndex === undefined || fact.factIndex === expectedIndex)
    && normalizeCanonicalFactContent(fact.content) === normalizeCanonicalFactContent(content)) ? id : null;
}

function acceptedFactCandidates(snapshot: unknown, source: Readonly<{ campaignId: string; turnId: string }>) {
  const additions = authorityBoundary(() => acceptedFactsSchema.parse(snapshot));
  const facts = buildCanonicalChronicleFacts({ ...additions, ...source, entityCatalog: [],
    canonicalFacts: additions.canonicalFacts.map((fact) => typeof fact === "string" ? fact : fact.content) });
  return facts.map((fact) => {
    const key = normalizeCanonicalFactContent(fact.content).toLocaleLowerCase("en-US");
    const portable = additions.canonicalFacts.find((entry) => typeof entry !== "string"
      && normalizeCanonicalFactContent(entry.content).toLocaleLowerCase("en-US") === key);
    const structured = additions.canonicalFactUpdates.some((entry) => normalizeCanonicalFactContent(entry.content).toLocaleLowerCase("en-US") === key);
    // System Archive preserves object-shaped snapshots. An explicit null is not
    // permission to invent an identity; non-null IDs still require scoped rows.
    return portable && typeof portable !== "string" && !structured
      ? { id: portable.id, content: fact.content, factIndex: fact.factIndex }
      : { id: fact.id, content: fact.content, factIndex: fact.factIndex };
  });
}

/** Accepted additions have an explicit turn origin; no correction or initial-state identity is guessed. */
export function materializeAcceptedGenerationContinuity(snapshot: unknown,
  source: Readonly<{ campaignId: string; turnId: string }>, activeFacts: readonly VerifiedFact[]): CampaignRuntimeStateContent {
  const facts = acceptedFactCandidates(snapshot, source);
  const state = authorityBoundary(() => materializeGenerationContinuity({ ...(snapshot as Record<string, unknown>), canonicalFacts: [] }));
  return { ...state, canonicalFacts: facts.map((fact) => ({
    id: fact.id ? verifiedFactId(fact.id, fact.content, activeFacts, fact.factIndex) : null, content: fact.content
  })) };
}

/** Exact correction snapshots are complete replacement authority, including intentionally empty values. */
export function materializeCorrectedGenerationContinuity(snapshot: unknown,
  source: Readonly<{ campaignId: string; stateEditId: string }>, activeFacts: readonly VerifiedFact[]): CampaignRuntimeStateContent {
  const state = authorityBoundary(() => campaignRuntimeStateContentSchema.parse(snapshot));
  return { ...state, canonicalFacts: state.canonicalFacts.map((fact, index) => ({ ...fact,
    id: verifiedFactId(fact.id ?? createCorrectionCanonicalFactId(source.campaignId, source.stateEditId, index), fact.content, activeFacts,
      fact.id === null || activeFacts.some((active) => active.id === fact.id && active.sourceStateEditId === source.stateEditId) ? index : undefined)
  })) };
}

/** This reader never repairs derived state. Missing or inconsistent rows grant no supersession authority. */
export async function loadActiveGenerationFacts(client: DatabaseClient, scope: CampaignWorldVersionMemoryScope,
  baseTurnNumber: number, candidateIds: readonly string[],
  source: Readonly<{ turnId?: string; stateEditId?: string; retainedIds?: readonly string[] }> = {}): Promise<readonly VerifiedFact[]> {
  if (!candidateIds.length) return [];
  const result = await client.query<VerifiedFact>(`SELECT id,content,source_fact_index AS "factIndex",source_state_edit_id AS "sourceStateEditId" FROM campaign_canonical_facts
    WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3
      AND valid_from_turn <= $4 AND (valid_until_turn IS NULL OR valid_until_turn > $4)
      AND id=ANY($5::uuid[])
      AND ($6::uuid IS NULL OR source_turn_id=$6)
      AND ($7::uuid IS NULL OR source_state_edit_id=$7 OR id=ANY($8::uuid[]))`,
  [scope.ownerUserId, scope.campaignId, scope.worldVersionId, baseTurnNumber, [...candidateIds],
    source.turnId ?? null, source.stateEditId ?? null, [...(source.retainedIds ?? [])]]);
  return result.rows;
}

export async function loadAcceptedGenerationContinuity(client: DatabaseClient, scope: CampaignWorldVersionMemoryScope,
  source: Readonly<{ turnId: string; turnNumber: number; snapshot: unknown }>): Promise<CampaignRuntimeStateContent> {
  const identity = { campaignId: scope.campaignId, turnId: source.turnId };
  const candidates = acceptedFactCandidates(source.snapshot, identity);
  const active = await loadActiveGenerationFacts(client, scope, source.turnNumber, candidates.flatMap((fact) => fact.id ? [fact.id] : []), { turnId: source.turnId });
  return materializeAcceptedGenerationContinuity(source.snapshot, identity, active);
}

/** Imported initial state has no accepted-turn source; preserve text without inventing supersession IDs. */
export function materializeInitialGenerationContinuity(snapshot: unknown): CampaignRuntimeStateContent {
  const state = authorityBoundary(() => materializeGenerationContinuity(snapshot));
  const source = snapshot as Record<string, unknown>;
  const structured = authorityBoundary(() => acceptedFactsSchema.shape.canonicalFactUpdates.parse(source.canonicalFactUpdates));
  const additions = combineCanonicalChronicleFacts({ canonicalFactUpdates: structured });
  const unique = new Set<string>();
  const canonicalFacts = [...additions, ...state.canonicalFacts].flatMap((fact) => {
    const key = normalizeCanonicalFactContent(fact.content).toLocaleLowerCase("en-US");
    if (unique.has(key)) return [];
    unique.add(key);
    return [{ id: null, content: fact.content }];
  });
  return authorityBoundary(() => campaignRuntimeStateContentSchema.parse({ ...state, canonicalFacts }));
}

/**
 * Loads the complete user correction that applies to precisely one generation
 * base turn. Empty fields are a saved authority, not a missing correction.
 */
export async function loadCurrentContinuityCorrection(
  client: DatabaseClient,
  scope: CampaignWorldVersionMemoryScope,
  baseTurnNumber: number,
  options: Readonly<{ complete?: boolean }> = {},
): Promise<CampaignRuntimeStateContent | null> {
  const result = await client.query<{ id: string; state_snapshot_private: unknown }>(
    `SELECT edit.id, edit.state_snapshot_private
       FROM campaigns campaign
       JOIN campaign_state_edits edit
         ON edit.campaign_id = campaign.id
        AND edit.owner_user_id = campaign.owner_user_id
      WHERE campaign.id = $2
        AND campaign.owner_user_id = $1
        AND campaign.world_version_id = $3
        AND edit.effective_turn_number = $4
      ORDER BY edit.revision DESC
      LIMIT 1`,
    [scope.ownerUserId, scope.campaignId, scope.worldVersionId, baseTurnNumber]
  );
  const row = result.rows[0];
  if (row && options.complete) {
    const state = authorityBoundary(() => campaignRuntimeStateContentSchema.parse(row.state_snapshot_private));
    const ids = state.canonicalFacts.map((fact, index) => fact.id ?? createCorrectionCanonicalFactId(scope.campaignId, row.id, index));
    const active = await loadActiveGenerationFacts(client, scope, baseTurnNumber, ids, {
      stateEditId: row.id, retainedIds: state.canonicalFacts.flatMap((fact) => fact.id ? [fact.id] : [])
    });
    return materializeCorrectedGenerationContinuity(state, { campaignId: scope.campaignId, stateEditId: row.id }, active);
  }
  return row ? materializeGenerationContinuity(row.state_snapshot_private) : null;
}

/**
 * Normalizes an accepted or initial state snapshot for private generation.
 * This is intentionally separate from an exact correction: a saved empty
 * correction is already complete authority and must never be merged here.
 */
export function materializeGenerationContinuity(
  snapshot: unknown,
): CampaignRuntimeStateContent {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Generation authority state snapshot is invalid.");
  }
  const source = snapshot as Record<string, unknown>;
  const canonicalFacts = Array.isArray(source.canonicalFacts)
    ? source.canonicalFacts.map((fact) => typeof fact === "string" ? { id: null, content: fact } : fact)
    : source.canonicalFacts ?? [];
  return campaignRuntimeStateContentSchema.parse({
    continuitySummary: source.continuitySummary ?? "",
    scratchpad: source.scratchpad ?? "",
    openThreads: source.openThreads ?? [],
    canonicalFacts,
    trackers: source.trackers ?? [],
    rpgStats: source.rpgStats ?? [],
    eventTriggers: source.eventTriggers ?? [],
    pendingEventTriggers: source.pendingEventTriggers ?? []
  });
}

function compactCorrectionSnapshot(canonicalFacts: unknown): Record<string, unknown> {
  return {
    continuitySummary: "", scratchpad: "", openThreads: [], canonicalFacts,
    trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: []
  };
}

function canonicalFactMatches(candidate: ProtectedFactCandidate & { content: string }, facts: readonly Readonly<{ id: string | null; content: string }>[]): boolean {
  return facts.some((fact) => fact.id === candidate.id
    && normalizeCanonicalFactContent(fact.content) === normalizeCanonicalFactContent(candidate.content));
}

function sourceIndexMatches(candidate: ProtectedFactCandidate & { content: string }, facts: readonly Readonly<{ id: string | null; content: string }>[]): boolean {
  const sourceFact = facts[candidate.source_fact_index];
  return sourceFact?.id === candidate.id
    && normalizeCanonicalFactContent(sourceFact.content) === normalizeCanonicalFactContent(candidate.content);
}

function safelyMaterialize<T>(read: () => T): T | null {
  try { return read(); }
  catch { return null; }
}

/**
 * Reads complete canonical-fact authority without rebuilding its derived
 * projection. Candidate rows are merely pointers: source snapshots and their
 * original fact indices must still verify before an ID is returned.
 */
export async function loadVerifiedProtectedFacts(
  client: DatabaseClient,
  scope: CampaignWorldVersionMemoryScope,
  baseTurnNumber: number,
): Promise<Readonly<{
  facts: readonly ProtectedFact[];
  omittedCount: number;
  candidateRows: number;
  sourceBytes: number;
  sourceLimitReached: boolean;
  coverage: ProtectedFactSourceCoverage;
}>> {
  const candidates = await client.query<ProtectedFactCandidate>(`SELECT fact.id,
      CASE WHEN fact.source_turn_number <= $4 AND char_length(fact.content) <= $6 AND octet_length(fact.content) <= $7
        THEN fact.content ELSE NULL END AS content,fact.source_turn_number,fact.source_fact_index,
      fact.source_turn_id,fact.source_state_edit_id
    FROM campaign_canonical_facts fact
    WHERE fact.owner_user_id=$1 AND fact.campaign_id=$2 AND fact.world_version_id=$3
      AND fact.valid_from_turn <= $4 AND (fact.valid_until_turn IS NULL OR fact.valid_until_turn > $4)
    ORDER BY fact.source_turn_number DESC,fact.source_fact_index DESC,fact.id DESC
    LIMIT $5`, [scope.ownerUserId, scope.campaignId, scope.worldVersionId, baseTurnNumber, MAX_PROTECTED_FACT_CANDIDATE_ROWS,
    MAX_PROTECTED_FACT_CONTENT_CHARACTERS, MAX_PROTECTED_FACT_CONTENT_BYTES]);
  const newestFirst = candidates.rows;
  const ordered = [...newestFirst].sort((left, right) => left.source_turn_number - right.source_turn_number
    || left.source_fact_index - right.source_fact_index || left.id.localeCompare(right.id));
  const futureSourceCount = ordered.filter((candidate) => candidate.source_turn_number > baseTurnNumber).length;
  const oversizedCandidateCount = ordered.filter((candidate) => candidate.source_turn_number <= baseTurnNumber && candidate.content === null).length;
  const eligible = ordered.filter((candidate): candidate is ProtectedFactCandidate & { content: string } => candidate.content !== null
    && candidate.source_turn_number <= baseTurnNumber);
  const frontierResult = await client.query<{ id: string; effective_turn_number: number; canonical_facts: unknown | null; source_bytes: number }>(
    `SELECT edit.id,edit.effective_turn_number,
        CASE WHEN octet_length(COALESCE(edit.state_snapshot_private->'canonicalFacts','[]'::jsonb)::text) <= $5
          THEN COALESCE(edit.state_snapshot_private->'canonicalFacts','[]'::jsonb) ELSE NULL END AS canonical_facts,
        octet_length(COALESCE(edit.state_snapshot_private->'canonicalFacts','[]'::jsonb)::text)::integer AS source_bytes
      FROM campaign_state_edits edit
      JOIN campaigns campaign ON campaign.id=edit.campaign_id AND campaign.owner_user_id=edit.owner_user_id
      WHERE edit.owner_user_id=$1 AND edit.campaign_id=$2 AND campaign.world_version_id=$3
        AND edit.effective_turn_number <= $4
      ORDER BY edit.effective_turn_number DESC,edit.revision DESC LIMIT 1`,
    [scope.ownerUserId, scope.campaignId, scope.worldVersionId, baseTurnNumber, MAX_PROTECTED_FACT_SOURCE_BYTES]
  );
  const frontier = frontierResult.rows[0] ?? null;
  let sourceBytes = frontier?.canonical_facts === null ? 0 : frontier?.source_bytes ?? 0;
  const frontierFacts = frontier?.canonical_facts === null ? null : frontier
    ? safelyMaterialize(() => materializeCorrectedGenerationContinuity(compactCorrectionSnapshot(frontier.canonical_facts),
      { campaignId: scope.campaignId, stateEditId: frontier.id }, eligible.map((candidate) => ({
        id: candidate.id, content: candidate.content, factIndex: candidate.source_fact_index,
        sourceStateEditId: candidate.source_state_edit_id
      }))))
    : null;

  const acceptedIds = [...new Set(newestFirst.flatMap((candidate) => candidate.content !== null && candidate.source_turn_number <= baseTurnNumber
    && candidate.source_turn_id ? [candidate.source_turn_id] : []))];
  const acceptedSizes = acceptedIds.length ? await client.query<{ id: string; source_bytes: number }>(`SELECT turn_row.id,
      (octet_length(COALESCE(turn_row.state_snapshot_private->'canonicalFacts','[]'::jsonb)::text)
       + octet_length(COALESCE(turn_row.state_snapshot_private->'canonicalFactUpdates','[]'::jsonb)::text))::integer AS source_bytes
    FROM turns turn_row
    JOIN campaigns campaign ON campaign.id=turn_row.campaign_id AND campaign.owner_user_id=turn_row.owner_user_id
    WHERE turn_row.owner_user_id=$1 AND turn_row.campaign_id=$2 AND campaign.world_version_id=$3
      AND turn_row.accepted_at IS NOT NULL AND turn_row.id=ANY($4::uuid[]) AND turn_row.turn_number <= $5`,
  [scope.ownerUserId, scope.campaignId, scope.worldVersionId, acceptedIds, baseTurnNumber]) : { rows: [] as { id: string; source_bytes: number }[] };
  const acceptedAllowed: string[] = [];
  for (const source of acceptedSizes.rows.sort((left, right) => acceptedIds.indexOf(left.id) - acceptedIds.indexOf(right.id))) {
    if (source.source_bytes > MAX_PROTECTED_FACT_SOURCE_BYTES - sourceBytes) continue;
    acceptedAllowed.push(source.id);
    sourceBytes += source.source_bytes;
  }
  const acceptedSources = acceptedAllowed.length ? await client.query<{ id: string; turn_number: number; canonical_facts: unknown; canonical_fact_updates: unknown }>(
    `SELECT turn_row.id,turn_row.turn_number,COALESCE(turn_row.state_snapshot_private->'canonicalFacts','[]'::jsonb) AS canonical_facts,
       COALESCE(turn_row.state_snapshot_private->'canonicalFactUpdates','[]'::jsonb) AS canonical_fact_updates
      FROM turns turn_row
      JOIN campaigns campaign ON campaign.id=turn_row.campaign_id AND campaign.owner_user_id=turn_row.owner_user_id
      WHERE turn_row.owner_user_id=$1 AND turn_row.campaign_id=$2 AND campaign.world_version_id=$3
        AND turn_row.accepted_at IS NOT NULL AND turn_row.id=ANY($4::uuid[]) AND turn_row.turn_number <= $5`,
  [scope.ownerUserId, scope.campaignId, scope.worldVersionId, acceptedAllowed, baseTurnNumber]) : { rows: [] as { id: string; turn_number: number; canonical_facts: unknown; canonical_fact_updates: unknown }[] };
  const acceptedById = new Map(acceptedSources.rows.map((source) => [source.id, source]));
  const editIds = [...new Set(newestFirst.flatMap((candidate) => candidate.content !== null && candidate.source_turn_number <= baseTurnNumber && candidate.source_state_edit_id && !candidate.source_turn_id
    && candidate.source_state_edit_id !== frontier?.id ? [candidate.source_state_edit_id] : []))];
  const editSizes = editIds.length ? await client.query<{ id: string; source_bytes: number }>(`SELECT edit.id,
      octet_length(COALESCE(edit.state_snapshot_private->'canonicalFacts','[]'::jsonb)::text)::integer AS source_bytes
    FROM campaign_state_edits edit
    JOIN campaigns campaign ON campaign.id=edit.campaign_id AND campaign.owner_user_id=edit.owner_user_id
    WHERE edit.owner_user_id=$1 AND edit.campaign_id=$2 AND campaign.world_version_id=$3 AND edit.id=ANY($4::uuid[]) AND edit.effective_turn_number <= $5`,
  [scope.ownerUserId, scope.campaignId, scope.worldVersionId, editIds, baseTurnNumber]) : { rows: [] as { id: string; source_bytes: number }[] };
  const editAllowed: string[] = [];
  for (const source of editSizes.rows.sort((left, right) => editIds.indexOf(left.id) - editIds.indexOf(right.id))) {
    if (source.source_bytes > MAX_PROTECTED_FACT_SOURCE_BYTES - sourceBytes) continue;
    editAllowed.push(source.id);
    sourceBytes += source.source_bytes;
  }
  const edits = editAllowed.length ? await client.query<{ id: string; effective_turn_number: number; canonical_facts: unknown }>(`SELECT edit.id,edit.effective_turn_number,
      COALESCE(edit.state_snapshot_private->'canonicalFacts','[]'::jsonb) AS canonical_facts
    FROM campaign_state_edits edit
    JOIN campaigns campaign ON campaign.id=edit.campaign_id AND campaign.owner_user_id=edit.owner_user_id
    WHERE edit.owner_user_id=$1 AND edit.campaign_id=$2 AND campaign.world_version_id=$3 AND edit.id=ANY($4::uuid[]) AND edit.effective_turn_number <= $5`,
  [scope.ownerUserId, scope.campaignId, scope.worldVersionId, editAllowed, baseTurnNumber]) : { rows: [] as { id: string; effective_turn_number: number; canonical_facts: unknown }[] };
  const editsById = new Map(edits.rows.map((edit) => [edit.id, edit]));
  if (frontier && frontier.canonical_facts !== null) editsById.set(frontier.id, {
    id: frontier.id, effective_turn_number: frontier.effective_turn_number, canonical_facts: frontier.canonical_facts
  });
  const acceptedGroups = new Map<string, Array<ProtectedFactCandidate & { content: string }>>();
  const editGroups = new Map<string, Array<ProtectedFactCandidate & { content: string }>>();
  for (const candidate of eligible) {
    if (candidate.source_turn_id && !candidate.source_state_edit_id) {
      const group = acceptedGroups.get(candidate.source_turn_id) ?? [];
      group.push(candidate);
      acceptedGroups.set(candidate.source_turn_id, group);
    } else if (!candidate.source_turn_id && candidate.source_state_edit_id) {
      const group = editGroups.get(candidate.source_state_edit_id) ?? [];
      group.push(candidate);
      editGroups.set(candidate.source_state_edit_id, group);
    }
  }
  const verifiedById = new Map<string, ProtectedFact>();
  for (const [sourceId, candidatesForSource] of acceptedGroups) {
    const source = acceptedById.get(sourceId);
    const matchingTurn = source ? candidatesForSource.filter((candidate) => candidate.source_turn_number === source.turn_number) : [];
    const materialized = source && matchingTurn.length ? safelyMaterialize(() => materializeAcceptedGenerationContinuity({
      canonicalFacts: source.canonical_facts, canonicalFactUpdates: source.canonical_fact_updates
    }, { campaignId: scope.campaignId, turnId: source.id }, matchingTurn.map((candidate) => ({
      id: candidate.id, content: candidate.content, factIndex: candidate.source_fact_index
    })))) : null;
    if (!materialized) continue;
    for (const candidate of matchingTurn) if (sourceIndexMatches(candidate, materialized.canonicalFacts)) {
      verifiedById.set(candidate.id, { id: candidate.id, turnNumber: candidate.source_turn_number, content: candidate.content });
    }
  }
  for (const [sourceId, candidatesForSource] of editGroups) {
    const source = editsById.get(sourceId);
    const matchingTurn = source ? candidatesForSource.filter((candidate) => candidate.source_turn_number === source.effective_turn_number) : [];
    const materialized = source && matchingTurn.length ? safelyMaterialize(() => materializeCorrectedGenerationContinuity(
      compactCorrectionSnapshot(source.canonical_facts), { campaignId: scope.campaignId, stateEditId: source.id },
      matchingTurn.map((candidate) => ({ id: candidate.id, content: candidate.content, factIndex: candidate.source_fact_index,
        sourceStateEditId: candidate.source_state_edit_id }))
    )) : null;
    if (!materialized) continue;
    for (const candidate of matchingTurn) if (sourceIndexMatches(candidate, materialized.canonicalFacts)) {
      verifiedById.set(candidate.id, { id: candidate.id, turnNumber: candidate.source_turn_number, content: candidate.content });
    }
  }
  const facts = ordered.flatMap((candidate) => {
    if (candidate.content === null) return [];
    const completeCandidate = candidate as ProtectedFactCandidate & { content: string };
    const verified = verifiedById.get(candidate.id);
    if (!verified) return [];
    if (frontier && candidate.source_turn_number <= frontier.effective_turn_number) {
      if (!frontierFacts || !canonicalFactMatches(completeCandidate, frontierFacts.canonicalFacts)) return [];
    }
    return [verified];
  });
  const coverage: ProtectedFactSourceCoverage = {
    candidateRows: ordered.length, sourceBytes, sourceLimitReached: ordered.length === MAX_PROTECTED_FACT_CANDIDATE_ROWS,
    oversizedCandidateCount, futureSourceCount, withheldCandidateCount: ordered.length - facts.length
  };
  return { facts, omittedCount: ordered.length - facts.length, candidateRows: ordered.length, sourceBytes,
    sourceLimitReached: coverage.sourceLimitReached, coverage };
}

/**
 * Verifies only the optional fact IDs that survived bounded Chronicle
 * retrieval. The correction frontier came from the authority transaction;
 * this function may read immutable accepted-turn snapshots but never resolves
 * a newer correction or repairs a derived projection.
 */
export async function verifyCapturedOptionalGenerationFacts(
  client: DatabaseClient,
  scope: CampaignWorldVersionMemoryScope,
  baseTurnNumber: number,
  candidateIds: readonly string[],
  frontier: GenerationOptionalFactFrontier | undefined,
): Promise<readonly string[]> {
  const ids = [...new Set(candidateIds)].slice(0, MAX_OPTIONAL_GENERATION_FACT_CANDIDATES);
  if (!ids.length) return [];
  const candidates = await client.query<ProtectedFactCandidate>(`SELECT id,content,source_turn_number,source_fact_index,
      source_turn_id,source_state_edit_id
    FROM campaign_canonical_facts
    WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3
      AND id=ANY($4::uuid[]) AND valid_from_turn <= $5
      AND (valid_until_turn IS NULL OR valid_until_turn > $5)
      AND char_length(content) <= $6 AND octet_length(content) <= $7`,
  [scope.ownerUserId, scope.campaignId, scope.worldVersionId, ids, baseTurnNumber,
    MAX_PROTECTED_FACT_CONTENT_CHARACTERS, MAX_PROTECTED_FACT_CONTENT_BYTES]);
  const verified = new Set<string>();
  const frontierFacts = new Map((frontier?.facts ?? []).map((fact) => [fact.id, fact.content]));
  const postFrontier = candidates.rows.filter((candidate) => !frontier || candidate.source_turn_number > frontier.effectiveTurnNumber);
  for (const candidate of candidates.rows) {
    if (!frontier || candidate.source_turn_number > frontier.effectiveTurnNumber) continue;
    if (frontierFacts.get(candidate.id) !== undefined
      && normalizeCanonicalFactContent(frontierFacts.get(candidate.id)!) === normalizeCanonicalFactContent(candidate.content!)) {
      verified.add(candidate.id);
    }
  }
  const sourceIds = [...new Set(postFrontier.flatMap((candidate) => candidate.source_turn_id ? [candidate.source_turn_id] : []))];
  if (!sourceIds.length) return [...verified];
  const sources = await client.query<{ id: string; turn_number: number; canonical_facts: unknown; canonical_fact_updates: unknown }>(`SELECT id,turn_number,
      COALESCE(state_snapshot_private->'canonicalFacts','[]'::jsonb) AS canonical_facts,
      COALESCE(state_snapshot_private->'canonicalFactUpdates','[]'::jsonb) AS canonical_fact_updates
    FROM turns
    WHERE owner_user_id=$1 AND campaign_id=$2 AND id=ANY($3::uuid[])
      AND accepted_at IS NOT NULL AND turn_number <= $4`,
  [scope.ownerUserId, scope.campaignId, sourceIds, baseTurnNumber]);
  const sourcesById = new Map(sources.rows.map((source) => [source.id, source]));
  for (const candidate of postFrontier) {
    if (!candidate.source_turn_id || candidate.source_state_edit_id) continue;
    const source = sourcesById.get(candidate.source_turn_id);
    if (!source || source.turn_number !== candidate.source_turn_number) continue;
    const materialized = safelyMaterialize(() => materializeAcceptedGenerationContinuity({
      canonicalFacts: source.canonical_facts, canonicalFactUpdates: source.canonical_fact_updates
    }, { campaignId: scope.campaignId, turnId: source.id }, [{
      id: candidate.id, content: candidate.content!, factIndex: candidate.source_fact_index
    }]));
    if (materialized && sourceIndexMatches(candidate as ProtectedFactCandidate & { content: string }, materialized.canonicalFacts)) {
      verified.add(candidate.id);
    }
  }
  return [...verified];
}
