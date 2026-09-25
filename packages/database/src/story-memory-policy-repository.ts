import { defaultStoryMemoryPolicy, effectiveProviderConfigurationFingerprint, resolveStoryMemoryPolicy, storyMemoryPolicyHash, storyMemoryPolicySchema, type StoryMemoryCapability, type StoryMemoryLevel, type StoryMemoryPolicySnapshot, type StoryMemorySettings } from "../../contracts/src/story-memory-policy.js";
import { STORY_MEMORY_CONTEXT_POLICY_VERSION, STORY_MEMORY_PROMPT_PROTOCOL_VERSION, CAST_STORY_MEMORY_CONTEXT_POLICY_VERSION, CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION } from "../../contracts/src/story-prompt.js";
import { sha256 } from "../../domain/src/index.js";
import { resolveEffectiveContextWindowTokens } from "../../story-engine/src/context-budget.js";
import { GenerationApplicationError } from "../../application/src/generation/errors.js";
import { toSafeProviderConfiguration } from "../../application/src/providers/index.js";
import type { TextExecutionRouteBasis } from "../../contracts/src/text-execution-plan.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

export type StoryMemoryOperatorConfig = Readonly<{ installedCapability: StoryMemoryCapability | null; enforceEnabled: boolean; castContextEnabled?: boolean }>;
export type StoryMemoryEnrollmentInput = Readonly<{ capability: StoryMemoryCapability; reviewMode: "off" | "observe" | "enforce" }>;

function availableLevels(config: StoryMemoryOperatorConfig): StoryMemoryLevel[] {
  const levels: StoryMemoryLevel[] = ["off"];
  if (config.installedCapability && supports(config.installedCapability, "r1")) levels.push("standard");
  if (config.installedCapability && supports(config.installedCapability, "r2")) levels.push("enhanced");
  if (config.installedCapability === "r3") levels.push("max");
  return levels;
}

function levelForEnrollment(row: { capability: StoryMemoryCapability; reviewMode: "off" | "observe" | "enforce" } | undefined): StoryMemoryLevel {
  if (!row) return "off";
  if (row.capability === "r1") return "standard";
  if (row.capability === "r2") return "enhanced";
  return "max";
}

function enrollmentForLevel(level: StoryMemoryLevel, continuityReviewEnabled: boolean): StoryMemoryEnrollmentInput | null {
  if (continuityReviewEnabled && level !== "max") throw enrollmentError("Continuity review requires Max memory.", "story_memory_enrollment_invalid", 400);
  if (level === "off") return null;
  if (level === "standard") return { capability: "r1", reviewMode: "off" };
  if (level === "enhanced") return { capability: "r2", reviewMode: "off" };
  return { capability: "r3", reviewMode: continuityReviewEnabled ? "enforce" : "off" };
}

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

export async function readStoryMemorySettings(pool: DatabasePool, scope: Readonly<{ ownerUserId: string; campaignId: string }>, config: StoryMemoryOperatorConfig): Promise<StoryMemorySettings> {
  const result = await pool.query<{ capability: StoryMemoryCapability | null; review_mode: "off" | "observe" | "enforce" | null }>(
    `SELECT enrollment.capability,enrollment.review_mode
       FROM campaigns campaign
       LEFT JOIN campaign_story_memory_enrollments enrollment
         ON enrollment.campaign_id=campaign.id AND enrollment.owner_user_id=campaign.owner_user_id
      WHERE campaign.id=$1 AND campaign.owner_user_id=$2`,
    [scope.campaignId, scope.ownerUserId]
  );
  const row = result.rows[0];
  if (!row) throw enrollmentError("Campaign not found.", "not_found", 404);
  const enrollment = row.capability && row.review_mode ? { capability: row.capability, reviewMode: row.review_mode } : undefined;
  return { level: levelForEnrollment(enrollment), reviewMode: enrollment?.reviewMode ?? "off", availableLevels: availableLevels(config) };
}

export async function saveStoryMemorySettings(pool: DatabasePool, scope: Readonly<{ ownerUserId: string; campaignId: string }>, level: StoryMemoryLevel, config: StoryMemoryOperatorConfig, continuityReviewEnabled = false): Promise<StoryMemorySettings> {
  const enrollment = enrollmentForLevel(level, continuityReviewEnabled);
  if (enrollment) await saveStoryMemoryEnrollment(pool, scope, enrollment, config);
  else await clearStoryMemoryEnrollment(pool, scope);
  return readStoryMemorySettings(pool, scope, config);
}

export async function resolveStoryMemoryPolicySnapshot(client: DatabaseClient, scope: Readonly<{
  ownerUserId: string; campaignId: string; providerProfileId: string; requestedModel: string; modelContextWindowTokens?: number;
  textExecutionRouteBasis?: TextExecutionRouteBasis;
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
  const frozenCandidate = scope.textExecutionRouteBasis?.candidates[0];
  const effectiveContextWindowTokens = resolveEffectiveContextWindowTokens(
    frozenCandidate?.contextWindowTokens ?? row.context_window_tokens,
    scope.modelContextWindowTokens
  );
  return {
    policy, policyHash: storyMemoryPolicyHash(policy),
    ...(config.castContextEnabled ? { castContext: true as const, contextProtocol: CAST_STORY_MEMORY_CONTEXT_POLICY_VERSION, promptProtocol: CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION }
      : { contextProtocol: STORY_MEMORY_CONTEXT_POLICY_VERSION, promptProtocol: STORY_MEMORY_PROMPT_PROTOCOL_VERSION }),
    providerConfigurationFingerprint: effectiveProviderConfigurationFingerprint({
      providerId: scope.providerProfileId, providerType: row.provider_type,
      endpointIdentity: scope.textExecutionRouteBasis?.endpointReference ?? sha256(row.base_url.replace(/\/+$/, "")),
      model: frozenCandidate?.modelId ?? (scope.requestedModel.trim() || row.model.trim()), contextWindowTokens: frozenCandidate?.contextWindowTokens ?? row.context_window_tokens,
      maxOutputTokens: frozenCandidate?.maxOutputTokens ?? row.max_output_tokens,
      // A captured route keeps an intentional omission stable. Historical
      // no-basis jobs instead fingerprint the profile setting that they will
      // execute with.
      temperature: scope.textExecutionRouteBasis
        ? scope.textExecutionRouteBasis.parameters.temperature ?? 0
        : row.temperature,
      requestTimeoutMs: scope.textExecutionRouteBasis?.requestTimeoutMs ?? row.request_timeout_ms,
      configuration: frozenCandidate ? {
        parameters: scope.textExecutionRouteBasis!.parameters,
        providerPolicy: frozenCandidate.providerPolicy
      } : toSafeProviderConfiguration(row.configuration),
      effectiveContextWindowTokens,
      inputSafetyPolicy: "estimated_20_percent_plus_1024"
    })
  };
}
