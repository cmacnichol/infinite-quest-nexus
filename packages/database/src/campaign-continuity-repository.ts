import type { CampaignWorldVersionMemoryScope } from "../../application/src/memory/index.js";
import { campaignRuntimeStateContentSchema, type CampaignRuntimeStateContent } from "../../contracts/src/generation.js";
import type { DatabaseClient } from "./pool.js";
import { z } from "zod";
import { buildCanonicalChronicleFacts, combineCanonicalChronicleFacts } from "../../domain/src/chronicle-memory-helpers.js";
import { createCorrectionCanonicalFactId, normalizeCanonicalFactContent } from "../../domain/src/canonical-facts.js";

type VerifiedFact = Readonly<{ id: string; content: string; factIndex?: number }>;
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
      ? { id: portable.id, content: fact.content, factIndex: undefined }
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
    id: verifiedFactId(fact.id ?? createCorrectionCanonicalFactId(source.campaignId, source.stateEditId, index), fact.content, activeFacts, fact.id ? undefined : index)
  })) };
}

/** This reader never repairs derived state. Missing or inconsistent rows grant no supersession authority. */
export async function loadActiveGenerationFacts(client: DatabaseClient, scope: CampaignWorldVersionMemoryScope,
  baseTurnNumber: number, candidateIds: readonly string[],
  source: Readonly<{ turnId?: string; stateEditId?: string; retainedIds?: readonly string[] }> = {}): Promise<readonly VerifiedFact[]> {
  if (!candidateIds.length) return [];
  const result = await client.query<VerifiedFact>(`SELECT id,content,source_fact_index AS "factIndex" FROM campaign_canonical_facts
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
