import { defaultStoryMemoryPolicy, effectiveProviderConfigurationFingerprint, resolveStoryMemoryPolicy, storyMemoryPolicyHash, storyMemoryPolicySchema, type StoryMemoryCapability, type StoryMemoryPolicySnapshot } from "../../contracts/src/story-memory-policy.js";
import { STORY_MEMORY_CONTEXT_POLICY_VERSION, STORY_MEMORY_PROMPT_PROTOCOL_VERSION } from "../../contracts/src/story-prompt.js";
import { sha256 } from "../../domain/src/index.js";
import { resolveEffectiveContextWindowTokens } from "../../story-engine/src/context-budget.js";
import { GenerationApplicationError } from "../../application/src/generation/errors.js";
import { toSafeProviderConfiguration } from "../../application/src/providers/index.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

export type StoryMemoryOperatorConfig = Readonly<{ installedCapability: StoryMemoryCapability | null; enforceEnabled: boolean }>;
export type StoryMemoryEnrollmentInput = Readonly<{ capability: StoryMemoryCapability; reviewMode: "off" | "observe" | "enforce" }>;

function supports(installed: StoryMemoryCapability, requested: StoryMemoryCapability): boolean {
  return (["r1", "r2", "r3"] as const).indexOf(requested) <= (["r1", "r2", "r3"] as const).indexOf(installed);
}

function enrollmentError(message: string, code: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

async function saveStoryMemoryEnrollmentInTransaction(client: DatabaseClient, scope: Readonly<{ ownerUserId: string; campaignId: string }>, input: StoryMemoryEnrollmentInput, config: StoryMemoryOperatorConfig): Promise<void> {
  if (!config.installedCapability || !supports(config.installedCapability, input.capability)) throw enrollmentError("Story Memory capability is unavailable.", "story_memory_capability_unavailable", 409);
  if ((input.capability === "r1" || input.capability === "r2") && input.reviewMode !== "off") throw enrollmentError("Only R3 can enable review.", "story_memory_enrollment_invalid", 400);
  if (input.capability === "r3" && input.reviewMode === "enforce" && !config.enforceEnabled) throw enrollmentError("Story Memory enforce mode is disabled by the operator.", "story_memory_enforce_disabled", 409);
  const owned = await client.query("SELECT 1 FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [scope.campaignId, scope.ownerUserId]);
  if (!owned.rows[0]) throw enrollmentError("Campaign not found.", "not_found", 404);
  await client.query(
    `INSERT INTO campaign_story_memory_enrollments(campaign_id,owner_user_id,capability,review_mode)
     VALUES($1,$2,$3,$4) ON CONFLICT(campaign_id) DO UPDATE SET capability=excluded.capability,review_mode=excluded.review_mode,updated_at=now()`,
    [scope.campaignId, scope.ownerUserId, input.capability, input.reviewMode]
  );
}

export async function saveStoryMemoryEnrollment(pool: DatabasePool, scope: Readonly<{ ownerUserId: string; campaignId: string }>, input: StoryMemoryEnrollmentInput, config: StoryMemoryOperatorConfig): Promise<void> {
  await withTransaction(pool, (client) => saveStoryMemoryEnrollmentInTransaction(client, scope, input, config));
}

export async function clearStoryMemoryEnrollment(pool: DatabasePool, scope: Readonly<{ ownerUserId: string; campaignId: string }>): Promise<void> {
  await withTransaction(pool, async (client) => {
    const owned = await client.query("SELECT 1 FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [scope.campaignId, scope.ownerUserId]);
    if (!owned.rows[0]) throw enrollmentError("Campaign not found.", "not_found", 404);
    await client.query("DELETE FROM campaign_story_memory_enrollments WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId]);
  });
}

export async function resolveStoryMemoryPolicySnapshot(client: DatabaseClient, scope: Readonly<{
  ownerUserId: string; campaignId: string; providerProfileId: string; requestedModel: string; modelContextWindowTokens?: number;
}>, config: StoryMemoryOperatorConfig): Promise<StoryMemoryPolicySnapshot | null> {
  const result = await client.query<{
    capability: StoryMemoryCapability; review_mode: "off" | "observe" | "enforce"; model: string;
    provider_type: string; base_url: string; context_window_tokens: number; max_output_tokens: number;
    temperature: number; request_timeout_ms: number; configuration: unknown;
  }>(
    `SELECT enrollment.capability,enrollment.review_mode,provider.default_model AS model,provider.provider_type,
            provider.base_url,provider.context_window_tokens,provider.max_output_tokens,provider.temperature,
            provider.request_timeout_ms,provider.configuration
       FROM campaign_story_memory_enrollments enrollment
       JOIN provider_profiles provider ON provider.id=$3 AND provider.owner_user_id=enrollment.owner_user_id
      WHERE enrollment.campaign_id=$1 AND enrollment.owner_user_id=$2`,
    [scope.campaignId, scope.ownerUserId, scope.providerProfileId]
  );
  const row = result.rows[0];
  if (!row) return null;
  try {
    resolveStoryMemoryPolicy({ installedCapability: config.installedCapability, campaignEnrollment: row.capability });
  } catch {
    throw new GenerationApplicationError("conflict", { reason: "story_memory_capability_unavailable" });
  }
  if (row.review_mode === "enforce" && !config.enforceEnabled) {
    throw new GenerationApplicationError("conflict", { reason: "story_memory_enforce_disabled" });
  }
  const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy(row.capability), continuityReview: row.review_mode });
  const effectiveContextWindowTokens = resolveEffectiveContextWindowTokens(
    row.context_window_tokens,
    scope.modelContextWindowTokens
  );
  return {
    policy, policyHash: storyMemoryPolicyHash(policy), contextProtocol: STORY_MEMORY_CONTEXT_POLICY_VERSION, promptProtocol: STORY_MEMORY_PROMPT_PROTOCOL_VERSION,
    providerConfigurationFingerprint: effectiveProviderConfigurationFingerprint({
      providerId: scope.providerProfileId, providerType: row.provider_type,
      endpointIdentity: sha256(row.base_url.replace(/\/+$/, "")),
      model: scope.requestedModel.trim() || row.model.trim(), contextWindowTokens: row.context_window_tokens,
      maxOutputTokens: row.max_output_tokens, temperature: row.temperature, requestTimeoutMs: row.request_timeout_ms,
      configuration: toSafeProviderConfiguration(row.configuration),
      effectiveContextWindowTokens,
      inputSafetyPolicy: "estimated_20_percent_plus_1024"
    })
  };
}
