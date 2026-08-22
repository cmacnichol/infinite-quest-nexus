import type {
  PromptSnapshotVersion,
  ProviderCostPort,
  ProviderHealthPort,
  ProviderResolutionPort,
  PromptLibraryPort,
  TurnIntentClassificationPort
} from "../../../packages/application/src/providers/index.js";
import type { TurnInputMode } from "../../../packages/contracts/src/generation.js";
import { createProviderCostTransactionContext } from "../../../packages/database/src/cost-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { withTransaction } from "../../../packages/database/src/pool.js";
import { sha256 } from "../../../packages/domain/src/text.js";
import {
  buildTurnIntentPrompt,
  parseTurnIntentOutput
} from "../../../packages/story-engine/src/index.js";
import type { RuntimeProviderAdapter } from "./provider-credential-transport-adapter.js";

type TurnControlStyle = "action_only" | "flexible_auto" | "flexible_action" | "flexible_scene";

function styleFallback(style: TurnControlStyle, preferred?: TurnInputMode): TurnInputMode {
  if (style === "action_only") return "action";
  if (preferred) return preferred;
  return style === "flexible_action" ? "action" : "scene";
}

function promptContent(version: PromptSnapshotVersion, key: keyof PromptSnapshotVersion["snapshot"]): string {
  return version.snapshot[key].content;
}

function resolvedMode(
  classification: "action" | "scene" | "mixed" | "uncertain",
  fallback: TurnInputMode,
): TurnInputMode {
  return classification === "action" || classification === "scene" ? classification : fallback;
}

export function createTurnIntentClassificationAdapter(options: Readonly<{
  pool: DatabasePool;
  resolution: ProviderResolutionPort;
  runtime: RuntimeProviderAdapter;
  prompts: PromptLibraryPort;
  costs: ProviderCostPort;
  health: ProviderHealthPort;
}>): TurnIntentClassificationPort {
  async function persist(input: Readonly<{
    ownerUserId: string;
    campaignId: string;
    inputHash: string;
    classification: "action" | "scene" | "mixed" | "uncertain";
    resolvedMode: TurnInputMode;
    confidenceBand: "clear" | "probable" | "ambiguous";
    providerProfileId: string | null;
    providerSource: "intent_default" | "campaign_fallback";
    diagnostics: Readonly<Record<string, unknown>>;
  }>) {
    const inserted = await options.pool.query<{ id: string; expires_at: Date | string }>(
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
      expiresAt: new Date(row.expires_at).toISOString()
    } as const;
  }

  return {
    async classifyTurnIntent(command) {
      await options.pool.query(
        "DELETE FROM turn_input_classifications WHERE owner_user_id = $1 AND expires_at < now()",
        [command.ownerUserId]
      );
      const campaignResult = await options.pool.query<{
        turn_control_style: TurnControlStyle;
      }>(
        "SELECT turn_control_style FROM campaigns WHERE id = $1 AND owner_user_id = $2",
        [command.campaignId, command.ownerUserId]
      );
      const campaign = campaignResult.rows[0];
      if (!campaign) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
      const fallback = styleFallback(campaign.turn_control_style, command.preferredFallback);
      const inputHash = sha256(command.text);
      if (campaign.turn_control_style === "action_only") {
        return persist({
          ownerUserId: command.ownerUserId,
          campaignId: command.campaignId,
          inputHash,
          classification: "action",
          resolvedMode: "action",
          confidenceBand: "clear",
          providerProfileId: null,
          providerSource: "campaign_fallback",
          diagnostics: { reason: "action_only" }
        });
      }

      const resolution = await options.resolution.resolveDirect({
        ownerUserId: command.ownerUserId,
        providerRole: "intent"
      });
      if (resolution.status === "resolved") {
        try {
          const provider = await options.runtime.execution.text(
            { ownerUserId: command.ownerUserId },
            resolution
          );
          const prompts = await options.prompts.loadPromptSnapshot({
            ownerUserId: command.ownerUserId,
            scope: "campaign",
            campaignId: command.campaignId
          });
          const result = await provider.execute({
            systemPrompt: promptContent(prompts, "turn_intent"),
            input: buildTurnIntentPrompt(command.text)
          }, { maxOutputTokens: Math.min(provider.maxOutputTokens, 256), temperature: 0 });
          if (result.outputLimited) throw new Error("Turn intent classification reached its output limit.");
          const parsed = parseTurnIntentOutput(result.content);
          await withTransaction(options.pool, async (client) => options.costs.recordCost(
            createProviderCostTransactionContext(client),
            {
              ownerUserId: command.ownerUserId,
              campaignId: command.campaignId,
              providerProfileId: provider.id,
              providerType: provider.providerType,
              requestedModel: provider.model,
              ...(result.modelInstanceId === undefined ? {} : { resolvedModel: result.modelInstanceId }),
              providerResponseId: result.responseId,
              category: "story",
              operation: "turn_input_classification",
              usage: result.usage,
              reportedCost: result.reportedCost
            }
          ));
          await options.health.recordHealth({
            ownerUserId: command.ownerUserId,
            providerProfileId: provider.id,
            outcome: "healthy"
          });
          const parsedMode = resolvedMode(parsed.classification, fallback);
          return persist({
            ownerUserId: command.ownerUserId,
            campaignId: command.campaignId,
            inputHash,
            classification: parsed.classification,
            resolvedMode: parsedMode,
            confidenceBand: parsed.confidenceBand,
            providerProfileId: provider.id,
            providerSource: "intent_default",
            diagnostics: { confidence: parsed.confidence }
          });
        } catch {
          await options.health.recordHealth({
            ownerUserId: command.ownerUserId,
            providerProfileId: resolution.providerProfileId,
            outcome: "failed",
            diagnosticCode: "provider_unavailable"
          });
        }
      }
      return persist({
        ownerUserId: command.ownerUserId,
        campaignId: command.campaignId,
        inputHash,
        classification: "uncertain",
        resolvedMode: fallback,
        confidenceBand: "ambiguous",
        providerProfileId: null,
        providerSource: "campaign_fallback",
        diagnostics: { reason: "provider_unavailable" }
      });
    }
  };
}
