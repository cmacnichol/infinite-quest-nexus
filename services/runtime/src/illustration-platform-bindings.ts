import type { DatabasePool } from "../../../packages/database/src/pool.js";
import type { IllustrationCostPort } from "../../../packages/application/src/index.js";
import type { ProviderCostRecordCommand } from "../../../packages/application/src/providers/index.js";
import { downloadArtifact } from "./illustration-image-job-adapter.js";
import {
  buildIllustrationRefinementInput,
  parseRefinedPrompt
} from "./illustration-segment-job-adapter.js";
import type { IllustrationProviderCollaborators } from "./provider-application-composition.js";
import type {
  ArtifactDownloadAdapterDependencies,
  ImageProviderAdapterDependencies,
  PromptRefinementAdapterDependencies
} from "./illustration-platform-adapter.js";

export type IllustrationPlatformBindings = Readonly<{
  imageProvider: ImageProviderAdapterDependencies;
  promptRefinement: PromptRefinementAdapterDependencies;
  artifactDownload: ArtifactDownloadAdapterDependencies;
  /** Named provider cost collaborator; no API-service or compatibility binding remains. */
  costs: IllustrationCostPort;
}>;

/**
 * Runtime is the only composition layer that binds provider and asset
 * adapters to illustration ports.
 */
export function createIllustrationPlatformBindings(
  _pool: DatabasePool,
  providers: IllustrationProviderCollaborators,
): IllustrationPlatformBindings {
  return {
    imageProvider: {
      loadImageExecution: (ownerUserId, providerProfileId, model) => providers.execution.image(
        { ownerUserId },
        providerProfileId,
        model
      ),
      recordProviderHealth: (_pool, ownerUserId, providerProfileId, healthy) => providers.health.recordHealth({
        ownerUserId,
        providerProfileId,
        outcome: healthy ? "healthy" : "failed",
        ...(healthy ? {} : { diagnosticCode: "provider_unavailable" })
      })
    },
    promptRefinement: {
      loadTextExecution: (ownerUserId, providerProfileId, model) => providers.execution.text(
        { ownerUserId },
        providerProfileId,
        "text",
        model
      ),
      recordProviderHealth: (_pool, ownerUserId, providerProfileId, healthy) => providers.health.recordHealth({
        ownerUserId,
        providerProfileId,
        outcome: healthy ? "healthy" : "failed",
        ...(healthy ? {} : { diagnosticCode: "provider_unavailable" })
      }),
      buildRefinementInput: buildIllustrationRefinementInput,
      parseRefinedPrompt
    },
    artifactDownload: { downloadArtifact },
    costs: {
      recordIllustrationCost: (database, input) => {
        return providers.costs.recordIllustrationCost(providers.costContext(database as never), {
          ownerUserId: input.ownerUserId,
          campaignId: input.campaignId,
          providerProfileId: input.providerProfileId,
          providerType: input.providerType as ProviderCostRecordCommand["providerType"],
          requestedModel: input.requestedModel,
          operation: input.operation,
          usage: input.usage,
          reportedCost: input.reportedCost,
          providerResponseId: input.responseId,
          category: "image",
          resolvedModel: input.requestedModel,
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
          ...(input.imageJobId ? { imageJobId: input.imageJobId } : {}),
          ...((input.promptJobId ?? input.imageJobId) ? {
            localCallId: input.promptJobId ?? input.imageJobId
          } : {})
        });
      }
    }
  };
}
