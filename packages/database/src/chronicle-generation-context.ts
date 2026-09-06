import type { CampaignRuntimeStateContent } from "../../contracts/src/generation.js";
import { currentContinuitySchema } from "../../contracts/src/memory.js";
import type { DatabaseClient } from "./pool.js";
import {
  resolveGenerationAuthoritySnapshot,
  type GenerationBaseIdentity
} from "./generation-authority.js";
import { stableStringify } from "../../domain/src/index.js";
import { buildPostgresChronicleContextPreview } from "./chronicle-context-repository.js";
import type { ChronicleGenerationTransactionDependencies } from "./chronicle-repository.js";
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
  currentContinuity: CampaignRuntimeStateContent;
  scratchpad: string;
  openThreads: readonly string[];
  canonicalFacts: readonly Readonly<{ id: string | null; content: string }>[];
  trackers: CampaignRuntimeStateContent["trackers"];
  rpgStats: CampaignRuntimeStateContent["rpgStats"];
  eventTriggers: CampaignRuntimeStateContent["eventTriggers"];
  pendingEventTriggers: CampaignRuntimeStateContent["pendingEventTriggers"];
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
  dependencies?: ChronicleGenerationTransactionDependencies,
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
  const acceptedState = baseTurnNumber > 0 ? await client.query<{ state_snapshot_private: unknown }>(
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
  const worldCanon = typeof campaignRow.world_content.world === "object" && campaignRow.world_content.world !== null
    ? campaignRow.world_content.world as Record<string, unknown>
    : campaignRow.world_content;
  const acceptedContinuity = materializeGenerationContinuity(
    baseTurnNumber === 0 ? campaignRow.initial_state_snapshot : acceptedState?.rows[0]?.state_snapshot_private ?? currentContinuity
  );
  const correction = currentContinuity === null ? null : currentContinuitySchema.parse(currentContinuity);
  const continuity = correction === null ? acceptedContinuity : {
    ...acceptedContinuity,
    continuitySummary: correction.continuitySummary,
    scratchpad: correction.scratchpad,
    openThreads: correction.openThreads,
    canonicalFacts: correction.canonicalFacts
  };
  const preview = dependencies ? await buildPostgresChronicleContextPreview(client, {
    ownerUserId: scope.ownerUserId,
    campaignId: scope.campaignId,
    worldVersionId: scope.worldVersionId,
    request: {
      budgetTokens: 32_000,
      compression: "auto",
      query: scope.query,
      recentTurns: 8,
      throughTurnNumber: baseTurnNumber
    }
  }, dependencies) : null;
  const retrieved = (preview?.scopes as { chronicle?: unknown[] } | undefined)?.chronicle ?? [];
  const candidates = retrieved.flatMap((candidate, index): GenerationContextCandidate[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const value = candidate as Record<string, unknown>;
    if (typeof value.id !== "string" || typeof value.ordinal !== "number" || typeof value.content !== "string") return [];
    const kind = value.kind;
    if (!(["turn_fiction", "legacy_summary", "campaign_summary", "canonical_fact", "open_thread"] as const).includes(kind as GenerationContextCandidate["kind"])) return [];
    return [{ id: value.id, turnId: typeof value.turnId === "string" ? value.turnId : null,
      ordinal: value.ordinal, kind: kind as GenerationContextCandidate["kind"], content: value.content,
      tokenEstimate: typeof value.estimatedTokens === "number" ? value.estimatedTokens : 0, rank: index + 1 }];
  });
  return {
    authority: {
      rules: completeRules(worldCanon.rules ?? worldCanon.story_rules ?? ""),
      worldCanon,
      selectedCharacterId: campaignRow.selected_character_id,
      currentContinuity: continuity,
      scratchpad: continuity?.scratchpad ?? "",
      openThreads: continuity?.openThreads ?? [],
      canonicalFacts: continuity.canonicalFacts,
      trackers: continuity.trackers,
      rpgStats: continuity.rpgStats,
      eventTriggers: continuity.eventTriggers,
      pendingEventTriggers: continuity.pendingEventTriggers,
      latestTurn: latest?.rows[0] ?? null
    },
    candidates,
    baseIdentity: resolved.baseIdentity,
    ...(preview?.chronicleRetrieval ? { chronicleRetrieval: preview.chronicleRetrieval } : {})
  };
}
