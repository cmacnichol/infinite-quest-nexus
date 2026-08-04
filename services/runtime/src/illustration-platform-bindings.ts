import type { DatabasePool } from "../../../packages/database/src/pool.js";
import type { IllustrationCostPort } from "../../../packages/application/src/index.js";
import {
  callTextProvider,
  pollImageProvider,
  submitImageProvider
} from "../../../packages/story-engine/src/index.js";
import {
  persistTurnImage,
  persistWorldCover,
  type FilesystemAssetStore
} from "../../api/src/asset-service.js";
import { downloadArtifact } from "./illustration-image-job-adapter.js";
import {
  buildIllustrationRefinementInput,
  parseRefinedPrompt
} from "./illustration-segment-job-adapter.js";
import {
  loadImageProvider,
  loadTextProvider,
  recordProviderHealth
} from "../../api/src/provider-service.js";
import { recordProviderCost, type CostAttribution } from "../../api/src/cost-service.js";
import type {
  ArtifactDownloadAdapterDependencies,
  AssetAdapterDependencies,
  ImageProviderAdapterDependencies,
  PromptRefinementAdapterDependencies
} from "../../api/src/illustration-application-adapter.js";

export type IllustrationPlatformBindings = Readonly<{
  imageProvider: ImageProviderAdapterDependencies;
  promptRefinement: PromptRefinementAdapterDependencies;
  artifactDownload: ArtifactDownloadAdapterDependencies;
  assets: AssetAdapterDependencies;
  /** Task 14d owns replacement of this temporary provider-cost binding. */
  costs: IllustrationCostPort;
}>;

/**
 * Runtime is the only composition layer that binds legacy provider and asset
 * services to illustration adapters. The API adapter remains independent of
 * those business services until their Task 14d/14e extractions.
 */
export function createIllustrationPlatformBindings(
  _pool: DatabasePool,
  _credentialSecret: string,
  _store: FilesystemAssetStore,
): IllustrationPlatformBindings {
  return {
    imageProvider: {
      loadImageProvider,
      submitImageProvider,
      pollImageProvider,
      recordProviderHealth
    },
    promptRefinement: {
      loadTextProvider,
      callTextProvider,
      recordProviderHealth,
      buildRefinementInput: buildIllustrationRefinementInput,
      parseRefinedPrompt
    },
    artifactDownload: { downloadArtifact },
    costs: {
      recordIllustrationCost: (database, input) => {
        const attribution: CostAttribution = {
          ownerUserId: input.ownerUserId,
          campaignId: input.campaignId,
          providerProfileId: input.providerProfileId,
          providerType: input.providerType,
          requestedModel: input.requestedModel,
          category: "image",
          operation: input.operation,
          usage: input.usage
        };
        if (input.turnId !== undefined) attribution.turnId = input.turnId;
        if (input.imageJobId) attribution.imageJobId = input.imageJobId;
        const localCallId = input.promptJobId ?? input.imageJobId;
        if (localCallId !== undefined) attribution.localCallId = localCallId;
        return recordProviderCost(database as never, attribution, {
          reportedCost: input.reportedCost,
          responseId: input.responseId,
          usage: input.usage
        });
      }
    },
    assets: {
      persistTurnImage,
      persistWorldCover
    }
  };
}
