import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId } from "../../../packages/database/src/pool.js";
import type { TurnInputClassificationRequest, TurnInputMode } from "../../../packages/contracts/src/generation.js";
import {
  buildTurnIntentPrompt,
  callTextProvider,
  parseTurnIntentOutput,
  TURN_INTENT_SYSTEM_PROMPT,
  type TextProviderProfile
} from "../../../packages/story-engine/src/index.js";
import { sha256 } from "../../../packages/domain/src/text.js";
import {
  loadIntentProvider,
  loadTextProvider,
  recordProviderHealth,
  resolveDefaultIntentProviderId,
  resolveEffectiveProviderId
} from "./provider-service.js";
import { recordProfileCost } from "./cost-service.js";

type TurnControlStyle = "action_only" | "flexible_auto" | "flexible_action" | "flexible_scene";

function styleFallback(style: TurnControlStyle, preferred?: TurnInputMode): TurnInputMode {
  if (style === "action_only") return "action";
  if (preferred) return preferred;
  return style === "flexible_action" ? "action" : "scene";
}

async function classifyWithProvider(
  pool: DatabasePool,
  ownerUserId: string,
  campaignId: string,
  profile: TextProviderProfile & { id: string; name: string },
  text: string,
  operation: string
) {
  const result = await callTextProvider({ ...profile, maxOutputTokens: Math.min(profile.maxOutputTokens, 256), temperature: 0 }, {
    systemPrompt: TURN_INTENT_SYSTEM_PROMPT,
    input: buildTurnIntentPrompt(text)
  });
  if (result.outputLimited) throw new Error("Turn intent classification reached its output limit.");
  const parsed = parseTurnIntentOutput(result.content);
  await recordProfileCost(pool, profile, {
    ownerUserId,
    campaignId,
    category: "story",
    operation
  }, result);
  return parsed;
}

export async function classifyTurnInput(
  pool: DatabasePool,
  campaignId: string,
  request: TurnInputClassificationRequest,
  credentialSecret: string
) {
  const ownerUserId = await initialOwnerId(pool);
  await pool.query(
    "DELETE FROM turn_input_classifications WHERE owner_user_id = $1 AND expires_at < now()",
    [ownerUserId]
  );
  const campaignResult = await pool.query<{
    turn_control_style: TurnControlStyle;
    text_provider_profile_id: string | null;
  }>(
    `SELECT turn_control_style, text_provider_profile_id
       FROM campaigns WHERE id = $1 AND owner_user_id = $2`,
    [campaignId, ownerUserId]
  );
  const campaign = campaignResult.rows[0];
  if (!campaign) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
  const fallback = styleFallback(campaign.turn_control_style, request.preferredFallback);
  if (campaign.turn_control_style === "action_only") {
    return persistClassification(pool, {
      ownerUserId, campaignId, inputHash: sha256(request.text), classification: "action", resolvedMode: "action",
      confidenceBand: "clear", providerProfileId: null, providerSource: "campaign_fallback", diagnostics: { reason: "action_only" }
    });
  }

  const intentProviderId = await resolveDefaultIntentProviderId(pool, ownerUserId);
  const storyProviderId = await resolveEffectiveProviderId(pool, ownerUserId, "text", campaign.text_provider_profile_id);
  let failure = "";
  if (intentProviderId) {
    try {
      const profile = await loadIntentProvider(pool, ownerUserId, intentProviderId, credentialSecret);
      const result = await classifyWithProvider(pool, ownerUserId, campaignId, profile, request.text, "turn_input_classification");
      await recordProviderHealth(pool, ownerUserId, intentProviderId, true);
      return persistModelClassification(pool, ownerUserId, campaignId, request.text, result, fallback, intentProviderId, "intent_default");
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      await recordProviderHealth(pool, ownerUserId, intentProviderId, false, failure);
    }
  }
  if (storyProviderId) {
    try {
      const profile = await loadTextProvider(pool, ownerUserId, storyProviderId, credentialSecret);
      const result = await classifyWithProvider(pool, ownerUserId, campaignId, profile, request.text,
        intentProviderId ? "turn_input_classification_fallback" : "turn_input_classification");
      return persistModelClassification(pool, ownerUserId, campaignId, request.text, result, fallback, storyProviderId, "story_text", failure);
    } catch (error) {
      failure = [failure, error instanceof Error ? error.message : String(error)].filter(Boolean).join("; ");
    }
  }
  return persistClassification(pool, {
    ownerUserId, campaignId, inputHash: sha256(request.text), classification: "uncertain", resolvedMode: fallback,
    confidenceBand: "ambiguous", providerProfileId: null, providerSource: "campaign_fallback",
    diagnostics: { reason: "provider_unavailable", error: failure.slice(0, 500) }
  });
}

function resolvedMode(classification: "action" | "scene" | "mixed" | "uncertain", fallback: TurnInputMode): TurnInputMode {
  return classification === "action" || classification === "scene" ? classification : fallback;
}

async function persistModelClassification(
  pool: DatabasePool,
  ownerUserId: string,
  campaignId: string,
  text: string,
  result: ReturnType<typeof parseTurnIntentOutput>,
  fallback: TurnInputMode,
  providerProfileId: string,
  providerSource: "intent_default" | "story_text",
  priorFailure = ""
) {
  return persistClassification(pool, {
    ownerUserId, campaignId, inputHash: sha256(text), classification: result.classification,
    resolvedMode: resolvedMode(result.classification, fallback), confidenceBand: result.confidenceBand,
    providerProfileId, providerSource,
    diagnostics: { confidence: result.confidence, ...(priorFailure ? { fallbackReason: priorFailure.slice(0, 500) } : {}) }
  });
}

async function persistClassification(pool: DatabasePool, input: {
  ownerUserId: string;
  campaignId: string;
  inputHash: string;
  classification: "action" | "scene" | "mixed" | "uncertain";
  resolvedMode: TurnInputMode;
  confidenceBand: "clear" | "probable" | "ambiguous";
  providerProfileId: string | null;
  providerSource: "intent_default" | "story_text" | "campaign_fallback";
  diagnostics: Record<string, unknown>;
}) {
  const inserted = await pool.query<{
    id: string;
    expires_at: Date;
  }>(
    `INSERT INTO turn_input_classifications (
       owner_user_id, campaign_id, input_hash, classification, resolved_mode, confidence_band,
       provider_profile_id, provider_source, diagnostics
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, expires_at`,
    [input.ownerUserId, input.campaignId, input.inputHash, input.classification, input.resolvedMode,
      input.confidenceBand, input.providerProfileId, input.providerSource, JSON.stringify(input.diagnostics)]
  );
  const row = inserted.rows[0]!;
  return {
    classificationId: row.id,
    classification: input.classification,
    resolvedMode: input.resolvedMode,
    confidenceBand: input.confidenceBand,
    providerSource: input.providerSource,
    expiresAt: row.expires_at
  };
}
