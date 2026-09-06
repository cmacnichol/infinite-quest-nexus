import type {
  MemoryGenerationAuthorityContext,
  MemoryGenerationAuthorityScope
} from "../../application/src/memory/types.js";
import type { CampaignRuntimeStateContent } from "../../contracts/src/generation.js";
import type { DatabaseClient } from "./pool.js";
import { resolveGenerationAuthoritySnapshot } from "./generation-authority.js";
import { stableStringify, stripMechanicsLeakage } from "../../domain/src/index.js";
import { loadPostgresChronicleGenerationCandidates } from "./chronicle-context-repository.js";
import type { ChronicleGenerationTransactionDependencies } from "./chronicle-repository.js";
import {
  loadCurrentContinuityCorrection,
  materializeGenerationContinuity
} from "./campaign-continuity-repository.js";

type GenerationContextCandidate = Readonly<{
  id: string;
  turnId: string | null;
  ordinal: number;
  kind: "turn_fiction" | "legacy_summary" | "campaign_summary" | "canonical_fact" | "open_thread";
  content: string;
  tokenEstimate: number;
  rank: number;
}>;

type GenerationContextAuthority = Readonly<{
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
/**
 * Captures only immutable generation authority while the caller holds its
 * transaction. Optional Chronicle retrieval is deliberately separate because
 * a query embedding can wait on an external provider.
 */
export async function loadPostgresChronicleGenerationAuthorityContext(
  client: DatabaseClient,
  scope: MemoryGenerationAuthorityScope,
): Promise<MemoryGenerationAuthorityContext> {
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
  const acceptedState = baseTurnNumber > 0 ? await client.query<{ state_snapshot_private: unknown; model_metadata: Record<string, unknown> }>(
    `SELECT state_snapshot_private, model_metadata FROM turns
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
  // Legacy snapshots may retain imported scratchpad text that was never
  // validated for prompt use. Only accepted generation output may carry a
  // scratchpad forward into a later provider request.
  const hasPromptSafeScratchpad = baseTurnNumber > 0
    && typeof acceptedState?.rows[0]?.model_metadata?.promptProtocolVersion === "string";
  const promptSafeContinuity = hasPromptSafeScratchpad
    ? acceptedContinuity
    : { ...acceptedContinuity, scratchpad: "" };
  // A state edit is the authoritative full runtime snapshot at its effective
  // turn, including trackers and event state as well as prose continuity.
  const continuity = currentContinuity === null
    ? promptSafeContinuity
    : currentContinuity;
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
      latestTurn: latest?.rows[0] ? {
        action: stripMechanicsLeakage(latest.rows[0].action).text,
        narration: stripMechanicsLeakage(latest.rows[0].narration).text
      } : null
    },
    candidates: [],
    baseIdentity: resolved.baseIdentity
  };
}

/**
 * Reads optional, derived Chronicle candidates after authority has already
 * been captured. The cutoff comes from that immutable snapshot, so retrieval
 * remains campaign/world/base-turn isolated without holding authority locks
 * across provider I/O.
 */
export async function loadPostgresChronicleGenerationCandidatesContext(
  client: DatabaseClient,
  scope: MemoryGenerationAuthorityScope,
  authorityContext: MemoryGenerationAuthorityContext,
  dependencies: ChronicleGenerationTransactionDependencies,
  options: Readonly<{ useSavepoints?: boolean }> = {},
): Promise<MemoryGenerationAuthorityContext> {
  const baseTurnNumber = Number(authorityContext.baseIdentity.baseTurnNumber);
  const retrieval = await loadPostgresChronicleGenerationCandidates(client, {
    ownerUserId: scope.ownerUserId,
    campaignId: scope.campaignId,
    worldVersionId: scope.worldVersionId,
    query: scope.query,
    throughTurnNumber: baseTurnNumber,
    ...(scope.retrievalBudgetTokens === undefined ? {} : { retrievalBudgetTokens: scope.retrievalBudgetTokens })
  }, dependencies, options);
  const candidates: readonly GenerationContextCandidate[] = retrieval.candidates;
  return {
    ...authorityContext,
    candidates,
    chronicleRetrieval: retrieval.chronicleRetrieval
  };
}

/**
 * Direct callers own their transaction, so they receive authority only. A
 * pool-backed caller can explicitly create the independent retrieval phase.
 */
export async function loadPostgresChronicleGenerationContext(
  client: DatabaseClient,
  scope: MemoryGenerationAuthorityScope,
): Promise<MemoryGenerationAuthorityContext> {
  return loadPostgresChronicleGenerationAuthorityContext(client, scope);
}
