import { withTransaction, type DatabasePool } from "../../../packages/database/src/pool.js";
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
    assets: {
      transaction: withTransaction,
      persistTurnImage,
      persistWorldCover
    }
  };
}
