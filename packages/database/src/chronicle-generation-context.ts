import type { CurrentContinuity } from "../../contracts/src/memory.js";
import { currentContinuitySchema } from "../../contracts/src/memory.js";
import type { DatabaseClient } from "./pool.js";
import {
  resolveGenerationAuthoritySnapshot,
  type GenerationBaseIdentity
} from "./generation-authority.js";
import { stableStringify } from "../../domain/src/index.js";
import {
  loadCurrentContinuityCorrection,
  materializeGenerationContinuity
} from "./campaign-continuity-repository.js";

export type GenerationContextScope = Readonly<{
  ownerUserId: string;
  campaignId: string;
  worldVersionId: string;
  operationKind: "append" | "replace_latest";
  expectedTurnNumber: number;
  query: string;
  expectedBaseIdentity?: GenerationBaseIdentity;
}>;

export type GenerationContextCandidate = Readonly<{
  id: string;
  turnId: string | null;
  ordinal: number;
  kind: "turn_fiction" | "legacy_summary" | "campaign_summary" | "canonical_fact" | "open_thread";
  content: string;
  tokenEstimate: number;
  rank: number;
}>;

export type GenerationContextAuthority = Readonly<{
  rules: readonly string[];
  worldCanon: Readonly<Record<string, unknown>>;
  selectedCharacterId: string | null;
  currentContinuity: CurrentContinuity | null;
  scratchpad: string;
  openThreads: readonly string[];
  canonicalFacts: readonly Readonly<{ id: string; content: string }>[];
  latestTurn: Readonly<{ action: string; narration: string }> | null;
}>;

export type GenerationContext = Readonly<{
  authority: GenerationContextAuthority;
  candidates: readonly GenerationContextCandidate[];
  baseIdentity: GenerationBaseIdentity;
}>;

function invalidRules(): never {
  throw Object.assign(new Error("The authoritative rules are invalid."), {
    code: "authoritative_context_invalid",
    field: "rules"
  });
}

function completeRules(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.length > 20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    return invalidRules();
  }
  return value ? [value] : [];
}

/**
 * Reads generation authority before retrieval. This deliberately shares Task
 * 2's transaction-owned resolver and exposes no public projection.
 */
export async function loadPostgresChronicleGenerationContext(
  client: DatabaseClient,
  scope: GenerationContextScope,
): Promise<GenerationContext> {
  const resolved = await resolveGenerationAuthoritySnapshot(client, scope);
  if (scope.expectedBaseIdentity
    && stableStringify(resolved.baseIdentity) !== stableStringify(scope.expectedBaseIdentity)) {
    throw Object.assign(new Error("Generation authority no longer matches the enqueued identity."), {
      code: "authoritative_context_invalid",
      field: "context_settings"
    });
  }
  if (resolved.worldVersionId !== scope.worldVersionId) {
    throw new Error("Generation authority world version no longer matches the requested scope.");
  }
  const baseTurnNumber = resolved.baseIdentity.baseTurnNumber;
  const campaign = await client.query<{
    world_content: Record<string, unknown>; selected_character_id: string | null;
    initial_state_snapshot: unknown; scratchpad_private: string;
  }>(
    `SELECT /* generation_context_state */ wv.content AS world_content, c.selected_character_id,
            cs.initial_state_snapshot, cs.scratchpad_private
       FROM campaigns c
       JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
       JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
      WHERE c.id = $1 AND c.owner_user_id = $2 AND c.world_version_id = $3`,
    [scope.campaignId, scope.ownerUserId, scope.worldVersionId]
  );
  const campaignRow = campaign.rows[0];
  if (!campaignRow) throw new Error("Generation authority campaign was not found.");
  const currentContinuity = await loadCurrentContinuityCorrection(client, scope, baseTurnNumber);
  const acceptedState = currentContinuity === null && baseTurnNumber > 0 ? await client.query<{ state_snapshot_private: unknown }>(
    `SELECT state_snapshot_private FROM turns
      WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_number = $3`,
    [scope.ownerUserId, scope.campaignId, baseTurnNumber]
  ) : null;
  const latest = baseTurnNumber === 0 ? null : await client.query<{ action: string; narration: string }>(
    `SELECT turn_row.action, effective.effective_narration AS narration
       FROM effective_turn_narrations effective
       JOIN turns turn_row ON turn_row.id = effective.turn_id
        AND turn_row.owner_user_id = effective.owner_user_id AND turn_row.campaign_id = effective.campaign_id
      WHERE effective.owner_user_id = $1 AND effective.campaign_id = $2 AND effective.turn_number = $3`,
    [scope.ownerUserId, scope.campaignId, baseTurnNumber]
  );
  const facts = await client.query<{ id: string; content: string }>(
    `SELECT id, content FROM campaign_canonical_facts
      WHERE owner_user_id = $1 AND campaign_id = $2 AND world_version_id = $3
        AND valid_from_turn <= $4 AND (valid_until_turn IS NULL OR valid_until_turn > $4)
      ORDER BY source_turn_number, source_fact_index, id`,
    [scope.ownerUserId, scope.campaignId, scope.worldVersionId, baseTurnNumber]
  );
  const candidates = await client.query<{
    id: string; turn_id: string | null; ordinal: number; memory_kind: GenerationContextCandidate["kind"]; content: string; token_estimate: number;
  }>(
    `SELECT id, turn_id, ordinal, memory_kind, content, token_estimate
       FROM chronicle_memories
      WHERE owner_user_id = $1 AND campaign_id = $2 AND world_version_id = $3
        AND ordinal <= $4
      ORDER BY CASE WHEN $5 = '' THEN 0
                    ELSE ts_rank_cd(search_document, websearch_to_tsquery('english', $5)) END DESC,
               ordinal DESC, importance DESC, id
      LIMIT 512`,
    [scope.ownerUserId, scope.campaignId, scope.worldVersionId, baseTurnNumber, scope.query.trim()]
  );
  const worldCanon = typeof campaignRow.world_content.world === "object" && campaignRow.world_content.world !== null
    ? campaignRow.world_content.world as Record<string, unknown>
    : campaignRow.world_content;
  const continuity = currentContinuity === null
    ? materializeGenerationContinuity(
      baseTurnNumber === 0 ? campaignRow.initial_state_snapshot : acceptedState?.rows[0]?.state_snapshot_private,
      facts.rows
    )
    : currentContinuitySchema.parse(currentContinuity);
  return {
    authority: {
      rules: completeRules(worldCanon.rules ?? worldCanon.story_rules ?? ""),
      worldCanon,
      selectedCharacterId: campaignRow.selected_character_id,
      currentContinuity: continuity,
      scratchpad: continuity?.scratchpad ?? "",
      openThreads: continuity?.openThreads ?? [],
      canonicalFacts: facts.rows,
      latestTurn: latest?.rows[0] ?? null
    },
    candidates: candidates.rows.map((candidate, index) => ({
      id: candidate.id,
      turnId: candidate.turn_id,
      ordinal: candidate.ordinal,
      kind: candidate.memory_kind,
      content: candidate.content,
      tokenEstimate: candidate.token_estimate,
      rank: index + 1
    })),
    baseIdentity: resolved.baseIdentity
  };
}
