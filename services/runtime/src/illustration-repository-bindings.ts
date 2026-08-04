import type {
  CampaignIllustrationSegments,
  IllustrationGenerationTransactionPort,
  IllustrationImageJob,
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
  enqueueAcceptedTurnIllustration,
  enqueueIllustration,
  enqueueWorldCover,
  getIllustrationConfig,
  getImageJob,
  getLatestWorldCoverJob,
  listCampaignImageJobs,
  retryImageJob,
  setIllustrationConfig
} from "./illustration-image-job-adapter.js";
import {
  getTurnIllustrationResolution,
  rematchTurnIllustration
} from "./illustration-resolution-job-adapter.js";
import {
  createProvisionalSegment,
  createProvisionalSet,
  enqueueAcceptedTurnIllustrationSegments,
  enqueueIllustrationBackfill,
  generateTurnIllustrationSegments,
  listCampaignIllustrationSegments,
  loadConfig,
  orphanProvisionalSet,
  previewIllustrationBackfill,
  promoteProvisionalSet,
  regenerateSegmentIllustration,
  removeSegmentIllustrationVariant,
  type SegmentConfigRow
} from "./illustration-segment-job-adapter.js";

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

export function createIllustrationGenerationTransactionPort(): IllustrationGenerationTransactionPort {
  return {
    loadStreamingIllustrationConfig: async (database, scope) => streamingConfig(await loadConfig(
      database as DatabaseClient,
      scope.ownerUserId,
      scope.campaignId,
    )),
    createProvisionalSet: (database, scope, request) => createProvisionalSet(
      database as DatabaseClient,
      scope.ownerUserId,
      scope.campaignId,
      scope.generationJobId,
      request.visualReference,
    ),
    createProvisionalSegment: (database, scope, request) => createProvisionalSegment(
      database as DatabaseClient,
      scope.ownerUserId,
      scope.campaignId,
      scope.generationJobId,
      scope.setId,
      request.segment,
      segmentConfig(request.config),
      request.visualReference,
    ),
    promoteProvisionalSet: (database, scope, request) => promoteProvisionalSet(
      database as DatabaseClient,
      scope.ownerUserId,
      scope.generationJobId,
      scope.turnId,
      scope.campaignId,
      request.finalNarration,
      segmentConfig(request.config),
      request.visualReference,
    ),
    orphanProvisionalSet: (database, scope) => orphanProvisionalSet(
      database as DatabaseClient,
      scope.ownerUserId,
      scope.generationJobId,
    ),
    enqueueAcceptedTurnIllustrationSegments: (database, scope) => enqueueAcceptedTurnIllustrationSegments(
      database as DatabaseClient,
      scope.ownerUserId,
      scope.campaignId,
      scope.turnId,
    )
  };
}

/** Runtime-only binding for the concrete illustration job state machines. */
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
          ? { id: result.id, duplicate: result.duplicate, segmentId: result.segmentId, variantIndex: result.variantIndex, status: "queued" as const }
          : { id: result.id, duplicate: result.duplicate, segmentId: result.segmentId, variantIndex: result.variantIndex };
      },
      async removeSegmentIllustrationVariant(scope, variantIndex) {
        await assertInitialOwner(pool, scope.ownerUserId);
        return { ...await removeSegmentIllustrationVariant(pool, scope.segmentId, variantIndex), retainedInLibrary: true as const };
      }
    }),
    createResolutionRepository: (pool) => ({
      async getTurnIllustrationResolution(scope) {
        await assertInitialOwner(pool, scope.ownerUserId);
        return resolutionView(await getTurnIllustrationResolution(pool, scope.turnId));
      },
      async rematchTurnIllustration(scope) {
        await assertInitialOwner(pool, scope.ownerUserId);
        return { ...await rematchTurnIllustration(pool, scope.turnId), status: "queued" as const };
      }
    }),
    createStreamingRepository: (pool) => ({
      async loadStreamingIllustrationConfig(scope) {
        return streamingConfig(await loadConfig(pool, scope.ownerUserId, scope.campaignId));
      },
      createProvisionalSet: (scope, request) => createProvisionalSet(
        pool, scope.ownerUserId, scope.campaignId, scope.generationJobId, request.visualReference,
      ),
      createProvisionalSegment: (scope, request) => createProvisionalSegment(
        pool, scope.ownerUserId, scope.campaignId, scope.generationJobId, scope.setId,
        request.segment, segmentConfig(request.config), request.visualReference,
      ),
      promoteProvisionalSet: (scope, request) => promoteProvisionalSet(
        pool, scope.ownerUserId, scope.generationJobId, scope.turnId, scope.campaignId,
        request.finalNarration, segmentConfig(request.config), request.visualReference,
      ),
      orphanProvisionalSet: (scope) => orphanProvisionalSet(pool, scope.ownerUserId, scope.generationJobId)
    }),
    createGenerationTransactionPort: () => createIllustrationGenerationTransactionPort()
  };
}
