import {
  toSafeProviderConfiguration,
  type ProviderCostRecordCommand
} from "../../../packages/application/src/providers/index.js";
import type { DatabaseClient } from "../../../packages/database/src/pool.js";
import { logProviderExecutionError } from "../../../packages/story-engine/src/index.js";
import {
  createChronicleEmbeddingProviderPort,
  type ChronicleEmbeddingProviderPort
} from "./chronicle-platform-adapter.js";
import type { ChronicleProviderCollaborators } from "./provider-application-composition.js";

/** Binds Chronicle exclusively to the named provider application collaborators. */
export function createChroniclePlatformBindings(
  providers: ChronicleProviderCollaborators,
): Readonly<{ embeddings: ChronicleEmbeddingProviderPort }> {
  return {
    embeddings: createChronicleEmbeddingProviderPort({
      loadEmbeddingExecution: async (ownerUserId, providerProfileId, model) => {
        const resolution = await providers.resolution.resolveEmbedding({
          ownerUserId,
          selectedProviderProfileId: providerProfileId,
          model,
          allowTextFallback: true,
        });
        if (resolution.status !== "resolved" || resolution.providerProfileId !== providerProfileId) {
          throw new Error("The configured Chronicle embedding provider is unavailable.");
        }
        const execution = await providers.execution.embedding(
          { ownerUserId },
          resolution.providerProfileId,
          resolution.resolvedRole,
          resolution.model,
        );
        return {
          id: execution.id,
          model: execution.model,
          providerType: execution.providerType,
          configuration: toSafeProviderConfiguration(execution.configuration),
          embed: execution.embed,
        };
      },
      resolveEmbeddingProvider: async (_database, ownerUserId, _campaignId, selectedProviderProfileId, model) => {
        const resolution = await providers.resolution.resolveEmbedding({
          ownerUserId,
          ...(selectedProviderProfileId === undefined ? {} : { selectedProviderProfileId }),
          ...(model === undefined ? {} : { model }),
          allowTextFallback: true,
        });
        if (resolution.status === "unconfigured") {
          return {
            status: "unconfigured",
            resolutionSource: "none",
            resolvedRole: null,
          };
        }
        return {
          status: "resolved",
          resolutionSource: resolution.source,
          resolvedRole: resolution.resolvedRole,
          providerProfileId: resolution.providerProfileId,
          providerType: resolution.providerType,
          model: resolution.model,
        };
      },
      recordProviderHealth: (_database, ownerUserId, providerProfileId, healthy) =>
        providers.health.recordHealth({
          ownerUserId,
          providerProfileId,
          outcome: healthy ? "healthy" : "failed",
          ...(healthy ? {} : { diagnosticCode: "provider_unavailable" }),
        }),
      recordProfileCost: (database, provider, attribution, result) =>
        providers.costs.recordChronicleCost(providers.costContext(database as DatabaseClient), {
          ...attribution,
          providerProfileId: provider.id,
          providerType: provider.providerType as ProviderCostRecordCommand["providerType"],
          requestedModel: provider.model,
          resolvedModel: provider.model,
          providerResponseId: result.responseId,
          category: "memory",
          usage: result.usage && typeof result.usage === "object"
            ? result.usage as Record<string, unknown>
            : {},
          reportedCost: result.reportedCost,
        }),
      logProviderTransportError: logProviderExecutionError,
    }),
  };
}
