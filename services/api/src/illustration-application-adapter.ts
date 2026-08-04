import type {
  IllustrationArtifactDownloadPort,
  IllustrationAssetPort,
  IllustrationImageArtifact,
  IllustrationImageExecutionResult,
  IllustrationImageProviderPort,
  IllustrationPromptRefinementPort
} from "../../../packages/application/src/index.js";
import {
  type DatabaseClient,
  type DatabasePool
} from "../../../packages/database/src/pool.js";
import {
  type callTextProvider,
  type pollImageProvider,
  type submitImageProvider,
  type ImageProviderArtifact
} from "../../../packages/story-engine/src/index.js";

export type ImageProviderAdapterDependencies = Readonly<{
  loadImageProvider(
    pool: DatabasePool,
    ownerUserId: string,
    providerProfileId: string,
    credentialSecret: string,
    model: string,
  ): Promise<Parameters<typeof submitImageProvider>[0]>;
  submitImageProvider: typeof submitImageProvider;
  pollImageProvider: typeof pollImageProvider;
  recordProviderHealth(
    pool: DatabasePool,
    ownerUserId: string,
    providerProfileId: string,
    healthy: boolean,
    errorMessage?: string,
  ): Promise<void>;
}>;

export type PromptRefinementAdapterDependencies = Readonly<{
  loadTextProvider(
    pool: DatabasePool,
    ownerUserId: string,
    providerProfileId: string,
    credentialSecret: string,
    model: string,
  ): Promise<Parameters<typeof callTextProvider>[0]>;
  callTextProvider: typeof callTextProvider;
  recordProviderHealth: ImageProviderAdapterDependencies["recordProviderHealth"];
  buildRefinementInput(fictionText: string, storyContext: string): string;
  parseRefinedPrompt(content: string): string;
}>;

export type ArtifactDownloadAdapterDependencies = Readonly<{
  downloadArtifact(
    artifact: ImageProviderArtifact,
    timeoutMs: number,
    allowPrivateHosts: boolean,
  ): Promise<Readonly<{ bytes: Uint8Array; mimeType: string }>>;
}>;

export type IllustrationAssetStore = Readonly<{ root: string }>;

type PersistedIllustrationAsset = Readonly<{ id: string }>;

type IllustrationAssetGenerationContext = Readonly<{
  imageJobId: string;
  targetType: "turn_illustration" | "world_cover" | "streaming_illustration";
  variantIndex: number;
  prompt: string;
  providerProfileId: string;
  providerType: string;
  model: string;
  generationParameters: Readonly<Record<string, unknown>>;
}>;

export type AssetAdapterDependencies = Readonly<{
  transaction<T>(
    pool: DatabasePool,
    work: (client: DatabaseClient) => Promise<T>,
  ): Promise<T>;
  persistTurnImage(
    client: DatabaseClient,
    store: IllustrationAssetStore,
    ownerUserId: string,
    campaignId: string,
    turnId: string | null,
    bytes: Buffer,
    mimeType: string,
    options: Readonly<{
      generationContext: IllustrationAssetGenerationContext;
      attachReference: boolean;
    }>,
  ): Promise<PersistedIllustrationAsset>;
  persistWorldCover(
    client: DatabaseClient,
    store: IllustrationAssetStore,
    ownerUserId: string,
    bytes: Buffer,
    mimeType: string,
    options: Readonly<{ generationContext: IllustrationAssetGenerationContext }>,
  ): Promise<PersistedIllustrationAsset>;
}>;

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
  dependencies: ImageProviderAdapterDependencies,
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
  dependencies: PromptRefinementAdapterDependencies,
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
          input: dependencies.buildRefinementInput(request.fictionText, request.storyContext)
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
          prompt: dependencies.parseRefinedPrompt(result.content),
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
  dependencies: ArtifactDownloadAdapterDependencies,
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
  store: IllustrationAssetStore,
  dependencies: AssetAdapterDependencies,
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
