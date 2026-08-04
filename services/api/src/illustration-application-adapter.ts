import type {
  CampaignIllustrationSegments,
  IllustrationArtifactDownloadPort,
  IllustrationAssetPort,
  IllustrationImageJob,
  IllustrationImageArtifact,
  IllustrationImageExecutionResult,
  IllustrationImageProviderPort,
  IllustrationPromptRefinementPort,
  StreamingIllustrationConfig,
  TurnIllustrationResolution
} from "../../../packages/application/src/index.js";
import { DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT } from "../../../packages/contracts/src/generation.js";
import type { IllustrationRepositoryFactories } from "../../../packages/database/src/illustration-repository.js";
import {
  initialOwnerId,
  withTransaction,
  type DatabaseClient,
  type DatabasePool
} from "../../../packages/database/src/pool.js";
import {
  callTextProvider,
  pollImageProvider,
  submitImageProvider,
  type ImageProviderArtifact
} from "../../../packages/story-engine/src/index.js";
import {
  persistTurnImage,
  persistWorldCover,
  type FilesystemAssetStore
} from "./asset-service.js";
import {
  downloadArtifact,
  enqueueAcceptedTurnIllustration,
  enqueueIllustration,
  enqueueWorldCover,
  getIllustrationConfig,
  getImageJob,
  getLatestWorldCoverJob,
  listCampaignImageJobs,
  retryImageJob,
  setIllustrationConfig
} from "./image-service.js";
import {
  getTurnIllustrationResolution,
  rematchTurnIllustration
} from "./illustration-resolution-service.js";
import {
  loadImageProvider,
  loadTextProvider,
  recordProviderHealth
} from "./provider-service.js";
import {
  buildIllustrationRefinementInput,
  createProvisionalSegment,
  createProvisionalSet,
  enqueueAcceptedTurnIllustrationSegments,
  enqueueIllustrationBackfill,
  generateTurnIllustrationSegments,
  listCampaignIllustrationSegments,
  loadConfig,
  orphanProvisionalSet,
  parseRefinedPrompt,
  previewIllustrationBackfill,
  promoteProvisionalSet,
  regenerateSegmentIllustration,
  removeSegmentIllustrationVariant,
  type SegmentConfigRow
} from "./segmented-illustration-service.js";

type ImageProviderAdapterDependencies = Readonly<{
  loadImageProvider: typeof loadImageProvider;
  submitImageProvider: typeof submitImageProvider;
  pollImageProvider: typeof pollImageProvider;
  recordProviderHealth: typeof recordProviderHealth;
}>;

type PromptRefinementAdapterDependencies = Readonly<{
  loadTextProvider: typeof loadTextProvider;
  callTextProvider: typeof callTextProvider;
  recordProviderHealth: typeof recordProviderHealth;
}>;

type ArtifactDownloadAdapterDependencies = Readonly<{
  downloadArtifact: typeof downloadArtifact;
}>;

type AssetAdapterDependencies = Readonly<{
  transaction<T>(
    pool: DatabasePool,
    work: (client: DatabaseClient) => Promise<T>,
  ): Promise<T>;
  persistTurnImage: typeof persistTurnImage;
  persistWorldCover: typeof persistWorldCover;
}>;

const imageProviderDependencies: ImageProviderAdapterDependencies = {
  loadImageProvider,
  submitImageProvider,
  pollImageProvider,
  recordProviderHealth
};

const promptRefinementDependencies: PromptRefinementAdapterDependencies = {
  loadTextProvider,
  callTextProvider,
  recordProviderHealth
};

const artifactDownloadDependencies: ArtifactDownloadAdapterDependencies = {
  downloadArtifact
};

const assetAdapterDependencies: AssetAdapterDependencies = {
  transaction: withTransaction,
  persistTurnImage,
  persistWorldCover
};

function sanitizedProviderMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/(?:url|uri|authorization|token|secret)/i.test(key))
      .map(([key, nested]) => [key, sanitize(nested)]));
  };
  return sanitize(metadata ?? {}) as Readonly<Record<string, unknown>>;
}

function imageArtifact(artifact: ImageProviderArtifact): IllustrationImageArtifact {
  return artifact.source === "base64"
    ? { source: "base64", base64: artifact.base64, mimeType: artifact.mimeType }
    : { source: "url", url: artifact.url, ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}) };
}

function completedImageResult(
  providerProfileId: string,
  model: string,
  result: Readonly<{
    artifacts: readonly ImageProviderArtifact[];
    usage: Readonly<Record<string, unknown>>;
    reportedCost: Readonly<{ amount: string; currency: string }> | null;
    providerMetadata: Readonly<Record<string, unknown>>;
  }>,
): IllustrationImageExecutionResult {
  return {
    providerRole: "image",
    providerProfileId,
    model,
    status: "completed",
    artifacts: result.artifacts.map(imageArtifact),
    usage: result.usage,
    reportedCost: result.reportedCost,
    metadata: sanitizedProviderMetadata(result.providerMetadata)
  };
}

export function createIllustrationImageProviderAdapter(
  pool: DatabasePool,
  credentialSecret: string,
  dependencies: ImageProviderAdapterDependencies = imageProviderDependencies,
): IllustrationImageProviderPort {
  return {
    async executeImage(request) {
      try {
        const provider = await dependencies.loadImageProvider(
          pool,
          request.ownerUserId,
          request.providerProfileId,
          credentialSecret,
          request.model,
        );
        if (request.remoteJobId) {
          const result = await dependencies.pollImageProvider(provider, {
            remoteJobId: request.remoteJobId
          });
          if (result.status === "failed") {
            throw Object.assign(new Error(result.error.message), {
              code: result.error.code || "provider_generation_failed",
              permanent: !result.error.retryable,
              remoteTerminal: true
            });
          }
          await dependencies.recordProviderHealth(
            pool,
            request.ownerUserId,
            request.providerProfileId,
            true,
          );
          if (result.status === "pending") {
            return {
              providerRole: "image",
              providerProfileId: request.providerProfileId,
              model: request.model,
              status: "pending",
              remoteJobId: request.remoteJobId,
              pollAfterMs: result.pollAfterMs ?? 0,
              progress: result.progress ?? null,
              queuePosition: result.queuePosition ?? null,
              etaSeconds: result.etaSeconds ?? null,
              metadata: sanitizedProviderMetadata(result.providerMetadata)
            };
          }
          return completedImageResult(request.providerProfileId, request.model, result);
        }

        const result = await dependencies.submitImageProvider(provider, {
          prompt: request.prompt,
          size: request.size,
          aspectRatio: request.aspectRatio,
          quality: request.quality,
          outputFormat: request.outputFormat,
          idempotencyKey: request.idempotencyKey,
          imageCount: request.imageCount
        });
        await dependencies.recordProviderHealth(
          pool,
          request.ownerUserId,
          request.providerProfileId,
          true,
        );
        if (result.mode === "pending") {
          return {
            providerRole: "image",
            providerProfileId: request.providerProfileId,
            model: request.model,
            status: "pending",
            remoteJobId: result.remoteJobId,
            pollAfterMs: result.pollAfterMs ?? 0,
            progress: result.progress ?? null,
            queuePosition: result.queuePosition ?? null,
            etaSeconds: result.etaSeconds ?? null,
            metadata: sanitizedProviderMetadata(result.providerMetadata)
          };
        }
        return completedImageResult(request.providerProfileId, request.model, result);
      } catch (error) {
        await dependencies.recordProviderHealth(
          pool,
          request.ownerUserId,
          request.providerProfileId,
          false,
          error instanceof Error ? error.message : String(error),
        ).catch(() => undefined);
        throw error;
      }
    }
  };
}

export function createIllustrationPromptRefinementAdapter(
  pool: DatabasePool,
  credentialSecret: string,
  dependencies: PromptRefinementAdapterDependencies = promptRefinementDependencies,
): IllustrationPromptRefinementPort {
  return {
    async refinePrompt(request) {
      try {
        const provider = await dependencies.loadTextProvider(
          pool,
          request.ownerUserId,
          request.providerProfileId,
          credentialSecret,
          request.model,
        );
        const result = await dependencies.callTextProvider(provider, {
          systemPrompt: request.systemPrompt,
          input: buildIllustrationRefinementInput(request.fictionText, request.storyContext)
        });
        await dependencies.recordProviderHealth(
          pool,
          request.ownerUserId,
          request.providerProfileId,
          true,
        );
        return {
          providerRole: "text",
          providerProfileId: request.providerProfileId,
          model: request.model,
          prompt: parseRefinedPrompt(result.content),
          metadata: sanitizedProviderMetadata({
            responseId: result.responseId,
            finishReason: result.finishReason,
            usage: result.usage,
            reportedCost: result.reportedCost
          })
        };
      } catch (error) {
        await dependencies.recordProviderHealth(
          pool,
          request.ownerUserId,
          request.providerProfileId,
          false,
          error instanceof Error ? error.message : String(error),
        ).catch(() => undefined);
        throw error;
      }
    }
  };
}

export function createIllustrationArtifactDownloadAdapter(
  dependencies: ArtifactDownloadAdapterDependencies = artifactDownloadDependencies,
): IllustrationArtifactDownloadPort {
  return {
    async downloadArtifact(request) {
      const result = await dependencies.downloadArtifact(
        request.artifact as ImageProviderArtifact,
        request.timeoutMs,
        request.allowPrivateHosts,
      );
      if (result.bytes.length > request.maximumBytes) {
        throw Object.assign(new Error("Generated image exceeded the requested artifact byte limit."), {
          code: "image_too_large",
          permanent: true
        });
      }
      return { bytes: new Uint8Array(result.bytes), mimeType: result.mimeType };
    }
  };
}

type AssetGenerationContextRow = Readonly<{
  campaign_id: string | null;
  turn_id: string | null;
  world_id: string | null;
  target_type: "turn_illustration" | "world_cover" | "streaming_illustration";
  prompt: string;
  provider_profile_id: string;
  provider_type: string;
  requested_model: string;
  size: string;
  aspect_ratio: string;
  quality: string;
  output_format: string;
}>;

async function loadAssetGenerationContext(
  client: DatabaseClient,
  ownerUserId: string,
  imageJobId: string,
  scope: Readonly<{ campaignId: string; turnId: string | null }> | Readonly<{ worldId: string }>,
) {
  const result = await client.query<AssetGenerationContextRow>(
    `SELECT campaign_id, turn_id, world_id, target_type, prompt,
            provider_profile_id, provider_type, requested_model,
            size, aspect_ratio, quality, output_format
       FROM image_jobs WHERE id = $1 AND owner_user_id = $2 FOR SHARE`,
    [imageJobId, ownerUserId],
  );
  const job = result.rows[0];
  if (!job) throw notFound("Image job");
  if ("worldId" in scope) {
    if (job.world_id !== scope.worldId || job.target_type !== "world_cover") {
      throw notFound("Image job");
    }
  } else if (job.campaign_id !== scope.campaignId || job.turn_id !== scope.turnId
    || job.target_type === "world_cover") {
    throw notFound("Image job");
  }
  return {
    imageJobId,
    targetType: job.target_type,
    variantIndex: 0,
    prompt: job.prompt,
    providerProfileId: job.provider_profile_id,
    providerType: job.provider_type,
    model: job.requested_model,
    generationParameters: {
      size: job.size,
      aspectRatio: job.aspect_ratio,
      quality: job.quality,
      outputFormat: job.output_format
    }
  };
}

export function createIllustrationAssetAdapter(
  pool: DatabasePool,
  store: FilesystemAssetStore,
  dependencies: AssetAdapterDependencies = assetAdapterDependencies,
): IllustrationAssetPort {
  return {
    persistTurnIllustration: (input) => dependencies.transaction(pool, async (client) => {
      const generationContext = await loadAssetGenerationContext(
        client,
        input.ownerUserId,
        input.imageJobId,
        { campaignId: input.campaignId, turnId: input.turnId },
      );
      const asset = await dependencies.persistTurnImage(
        client,
        store,
        input.ownerUserId,
        input.campaignId,
        input.turnId,
        Buffer.from(input.bytes),
        input.mimeType,
        {
          generationContext,
          attachReference: input.turnId !== null
        },
      );
      return { assetId: asset.id };
    }),
    persistWorldCover: (input) => dependencies.transaction(pool, async (client) => {
      const generationContext = await loadAssetGenerationContext(
        client,
        input.ownerUserId,
        input.imageJobId,
        { worldId: input.worldId },
      );
      const asset = await dependencies.persistWorldCover(
        client,
        store,
        input.ownerUserId,
        Buffer.from(input.bytes),
        input.mimeType,
        { generationContext },
      );
      return { assetId: asset.id };
    }),
    bindSegmentAsset: (input) => dependencies.transaction(pool, async (client) => {
      const result = await client.query<{ bound: boolean }>(
        `INSERT INTO turn_illustration_segment_assets (
           segment_id, owner_user_id, asset_id, image_job_id, variant_index
         )
         SELECT segments.id, segments.owner_user_id, assets.id, jobs.id, $7
           FROM turn_illustration_segments segments
           JOIN assets ON assets.id = $5 AND assets.owner_user_id = segments.owner_user_id
           JOIN image_jobs jobs ON jobs.id = $6 AND jobs.owner_user_id = segments.owner_user_id
          WHERE segments.id = $1 AND segments.owner_user_id = $2
            AND segments.campaign_id = $3
            AND segments.turn_id IS NOT DISTINCT FROM $4::uuid
            AND jobs.segment_id = segments.id
            AND jobs.campaign_id = segments.campaign_id
            AND jobs.turn_id IS NOT DISTINCT FROM segments.turn_id
         ON CONFLICT (segment_id, variant_index) DO UPDATE
           SET asset_id = EXCLUDED.asset_id,
               image_job_id = EXCLUDED.image_job_id,
               created_at = now()
         RETURNING true AS bound`,
        [
          input.segmentId,
          input.ownerUserId,
          input.campaignId,
          input.turnId,
          input.assetId,
          input.imageJobId,
          input.variantIndex
        ],
      );
      return result.rows[0]?.bound === true;
    })
  };
}

function notFound(resource: string): Error & { statusCode: number } {
  return Object.assign(new Error(`${resource} not found.`), { statusCode: 404 });
}

async function assertInitialOwner(pool: DatabasePool, ownerUserId: string): Promise<void> {
  if (await initialOwnerId(pool) !== ownerUserId) throw notFound("Illustration resource");
}

function timestamp(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function imageJob(job: Awaited<ReturnType<typeof getImageJob>>): IllustrationImageJob {
  return {
    ...job,
    providerEtaAt: timestamp(job.providerEtaAt),
    submittedAt: timestamp(job.submittedAt),
    lastPolledAt: timestamp(job.lastPolledAt),
    nextPollAt: timestamp(job.nextPollAt),
    generationDeadline: timestamp(job.generationDeadline),
    createdAt: timestamp(job.createdAt)!,
    updatedAt: timestamp(job.updatedAt)!,
    completedAt: timestamp(job.completedAt)
  };
}

function segmentViews(
  result: Awaited<ReturnType<typeof listCampaignIllustrationSegments>>,
): CampaignIllustrationSegments {
  return {
    segments: result.segments.map((segment) => ({
      ...segment,
      providerProgress: segment.providerProgress === null
        ? null
        : Number(segment.providerProgress),
      variants: (segment.variants as Array<Record<string, unknown>>).map((variant) => ({
        ...variant,
        createdAt: timestamp(variant.createdAt as Date | string)!
      }))
    }))
  } as CampaignIllustrationSegments;
}

function resolutionView(
  result: Awaited<ReturnType<typeof getTurnIllustrationResolution>>,
): TurnIllustrationResolution | null {
  if (!result) return null;
  return {
    ...result,
    ...(result.createdAt === undefined ? {} : { createdAt: timestamp(result.createdAt)! }),
    ...(result.updatedAt === undefined ? {} : { updatedAt: timestamp(result.updatedAt)! }),
    ...(result.completedAt === undefined ? {} : { completedAt: timestamp(result.completedAt) })
  } as TurnIllustrationResolution;
}

function streamingConfig(config: SegmentConfigRow): StreamingIllustrationConfig {
  return {
    enabled: config.enabled,
    sourcePolicy: config.source_policy,
    matchingScope: config.matching_scope,
    confidenceProfile: config.confidence_profile,
    repetitionWindow: config.repetition_window,
    providerProfileId: config.provider_profile_id,
    model: config.model,
    size: config.size,
    aspectRatio: config.aspect_ratio,
    quality: config.quality,
    outputFormat: config.output_format,
    maxAttempts: config.max_attempts,
    segmentWordCount: config.segment_word_count,
    imagesPerSegment: config.images_per_segment,
    segmentPromptMode: config.segment_prompt_mode,
    refinementPrompt: config.refinement_prompt,
    defaultRefinementPrompt: DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT,
    updatedAt: config.updated_at.toISOString(),
    campaignImageProviderProfileId: config.campaign_image_provider_id,
    campaignTextProviderProfileId: config.campaign_text_provider_id
  };
}

function segmentConfig(config: StreamingIllustrationConfig): SegmentConfigRow {
  return {
    enabled: config.enabled,
    source_policy: config.sourcePolicy,
    matching_scope: config.matchingScope,
    confidence_profile: config.confidenceProfile,
    repetition_window: config.repetitionWindow,
    provider_profile_id: config.providerProfileId,
    campaign_image_provider_id: config.campaignImageProviderProfileId,
    campaign_text_provider_id: config.campaignTextProviderProfileId,
    model: config.model,
    size: config.size,
    aspect_ratio: config.aspectRatio,
    quality: config.quality,
    output_format: config.outputFormat,
    max_attempts: config.maxAttempts,
    segment_word_count: config.segmentWordCount,
    images_per_segment: config.imagesPerSegment as 1 | 2,
    segment_prompt_mode: config.segmentPromptMode,
    refinement_prompt: config.refinementPrompt,
    updated_at: config.updatedAt ? new Date(config.updatedAt) : new Date(0)
  };
}

/**
 * Temporary 14a2 bridge around the established PostgreSQL operations. Task
 * 14a3 switches callers to these repositories and can then reduce the legacy
 * service exports without changing the application contracts again.
 */
export function createIllustrationRepositoryFactories(): IllustrationRepositoryFactories {
  return {
    createConfigRepository: (pool) => ({
      async getIllustrationConfig(scope) {
        await assertInitialOwner(pool, scope.ownerUserId);
        return getIllustrationConfig(pool, scope.campaignId);
      },
      async setIllustrationConfig(scope, config) {
        await assertInitialOwner(pool, scope.ownerUserId);
        return setIllustrationConfig(pool, scope.campaignId, config);
      }
    }),
    createJobRepository: (pool) => ({
      async enqueueWorldCover(scope, request) {
        await assertInitialOwner(pool, scope.ownerUserId);
        const result = await enqueueWorldCover(pool, scope.worldId, request);
        return { ...imageJob(result), duplicate: result.duplicate };
      },
      async getLatestWorldCoverJob(scope) {
        await assertInitialOwner(pool, scope.ownerUserId);
        const result = await getLatestWorldCoverJob(pool, scope.worldId);
        return result ? imageJob(result) : null;
      },
      enqueueAcceptedTurnIllustration: (scope, request) => withTransaction(
        pool,
        (client) => enqueueAcceptedTurnIllustration(
          client,
          scope.ownerUserId,
          scope.campaignId,
          scope.turnId,
          request.imagePrompt,
        ),
      ),
      async enqueueIllustration(scope, request) {
        await assertInitialOwner(pool, scope.ownerUserId);
        const result = await enqueueIllustration(pool, scope.turnId, request);
        return { ...imageJob(result), duplicate: result.duplicate };
      },
      async getImageJob(scope) {
        await assertInitialOwner(pool, scope.ownerUserId);
        return imageJob(await getImageJob(pool, scope.jobId));
      },
      async listCampaignImageJobs(scope) {
        await assertInitialOwner(pool, scope.ownerUserId);
        return (await listCampaignImageJobs(pool, scope.campaignId)).map(imageJob);
      },
      async retryImageJob(scope) {
        await assertInitialOwner(pool, scope.ownerUserId);
        return imageJob(await retryImageJob(pool, scope.jobId));
      }
    }),
    createSegmentRepository: (pool) => ({
      async generateTurnIllustrationSegments(scope, request) {
        await assertInitialOwner(pool, scope.ownerUserId);
        return generateTurnIllustrationSegments(pool, scope.turnId, request);
      },
      enqueueAcceptedTurnIllustrationSegments: (scope) => withTransaction(
        pool,
        (client) => enqueueAcceptedTurnIllustrationSegments(
          client,
          scope.ownerUserId,
          scope.campaignId,
          scope.turnId,
        ),
      ),
      async previewIllustrationBackfill(scope, request) {
        await assertInitialOwner(pool, scope.ownerUserId);
        return previewIllustrationBackfill(pool, scope.campaignId, request.mode);
      },
      async enqueueIllustrationBackfill(scope, request) {
        await assertInitialOwner(pool, scope.ownerUserId);
        return enqueueIllustrationBackfill(pool, scope.campaignId, request);
      },
      async listCampaignIllustrationSegments(scope) {
        await assertInitialOwner(pool, scope.ownerUserId);
        return segmentViews(await listCampaignIllustrationSegments(pool, scope.campaignId));
      },
      async regenerateSegmentIllustration(scope, request) {
        await assertInitialOwner(pool, scope.ownerUserId);
        const result = await regenerateSegmentIllustration(pool, scope.segmentId, request);
        return result.status
          ? {
              id: result.id,
              duplicate: result.duplicate,
              segmentId: result.segmentId,
              variantIndex: result.variantIndex,
              status: "queued" as const
            }
          : {
              id: result.id,
              duplicate: result.duplicate,
              segmentId: result.segmentId,
              variantIndex: result.variantIndex
            };
      },
      async removeSegmentIllustrationVariant(scope, variantIndex) {
        await assertInitialOwner(pool, scope.ownerUserId);
        return {
          ...await removeSegmentIllustrationVariant(pool, scope.segmentId, variantIndex),
          retainedInLibrary: true as const
        };
      }
    }),
    createResolutionRepository: (pool) => ({
      async getTurnIllustrationResolution(scope) {
        await assertInitialOwner(pool, scope.ownerUserId);
        return resolutionView(await getTurnIllustrationResolution(pool, scope.turnId));
      },
      async rematchTurnIllustration(scope) {
        await assertInitialOwner(pool, scope.ownerUserId);
        return {
          ...await rematchTurnIllustration(pool, scope.turnId),
          status: "queued" as const
        };
      }
    }),
    createStreamingRepository: (pool) => ({
      async loadStreamingIllustrationConfig(scope) {
        return streamingConfig(await loadConfig(pool, scope.ownerUserId, scope.campaignId));
      },
      createProvisionalSet: (scope, request) => createProvisionalSet(
        pool,
        scope.ownerUserId,
        scope.campaignId,
        scope.generationJobId,
        request.visualReference,
      ),
      createProvisionalSegment: (scope, request) => createProvisionalSegment(
        pool,
        scope.ownerUserId,
        scope.campaignId,
        scope.generationJobId,
        scope.setId,
        request.segment,
        segmentConfig(request.config),
        request.visualReference,
      ),
      promoteProvisionalSet: (scope, request) => promoteProvisionalSet(
        pool,
        scope.ownerUserId,
        scope.generationJobId,
        scope.turnId,
        scope.campaignId,
        request.finalNarration,
        segmentConfig(request.config),
        request.visualReference,
      ),
      orphanProvisionalSet: (scope) => orphanProvisionalSet(
        pool,
        scope.ownerUserId,
        scope.generationJobId,
      )
    })
  };
}
