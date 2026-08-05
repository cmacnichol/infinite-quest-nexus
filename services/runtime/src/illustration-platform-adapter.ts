// Concrete provider, artifact, and asset adapters belong to the runtime
// composition layer. Their dependencies are supplied as typed ports so API
// routes and application use cases remain platform-free.
import type {
  IllustrationArtifactDownloadPort,
  IllustrationAssetPort,
  IllustrationImageArtifact,
  IllustrationImageExecutionResult,
  IllustrationImageProviderPort,
  IllustrationPromptRefinementPort,
  IllustrationTransactionContext
} from "../../../packages/application/src/index.js";
import {
  type DatabaseClient,
  type DatabasePool
} from "../../../packages/database/src/pool.js";
import {
  type ImageProviderArtifact
} from "../../../packages/story-engine/src/index.js";
import type {
  RuntimeImageExecution,
  RuntimeTextExecution
} from "./provider-credential-transport-adapter.js";

export type ImageProviderAdapterDependencies = Readonly<{
  loadImageExecution(
    ownerUserId: string,
    providerProfileId: string,
    model: string,
  ): Promise<RuntimeImageExecution>;
  recordProviderHealth(
    pool: DatabasePool,
    ownerUserId: string,
    providerProfileId: string,
    healthy: boolean,
    errorMessage?: string,
  ): Promise<void>;
}>;

export type PromptRefinementAdapterDependencies = Readonly<{
  loadTextExecution(
    ownerUserId: string,
    providerProfileId: string,
    model: string,
  ): Promise<RuntimeTextExecution>;
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

function boundedProviderSetting(
  provider: RuntimeImageExecution,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = Number(provider.configuration?.[key]);
  return Number.isFinite(candidate)
    ? Math.min(maximum, Math.max(minimum, candidate))
    : fallback;
}

function imageExecutionPolicy(provider: RuntimeImageExecution) {
  return {
    artifactDownloadTimeoutMs: boundedProviderSetting(provider, "artifactDownloadTimeoutMs", 30_000, 5_000, 120_000),
    allowPrivateArtifactHosts: provider.configuration?.allowPrivateArtifactHosts === true,
    generationTimeoutMs: boundedProviderSetting(
      provider,
      "generationTimeoutMs",
      provider.providerType === "sogni_sdk" ? 600_000 : 180_000,
      30_000,
      provider.providerType === "sogni_sdk" ? 3_600_000 : 600_000,
    )
  } as const;
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
  policy: ReturnType<typeof imageExecutionPolicy>,
): IllustrationImageExecutionResult {
  return {
    providerRole: "image",
    providerProfileId,
    model,
    status: "completed",
    artifacts: result.artifacts.map(imageArtifact),
    usage: result.usage,
    reportedCost: result.reportedCost,
    metadata: sanitizedProviderMetadata(result.providerMetadata),
    ...policy
  };
}

export function createIllustrationImageProviderAdapter(
  pool: DatabasePool,
  dependencies: ImageProviderAdapterDependencies,
): IllustrationImageProviderPort {
  return {
    async executeImage(request) {
      try {
        const provider = await dependencies.loadImageExecution(
          request.ownerUserId,
          request.providerProfileId,
          request.model,
        );
        if (request.remoteJobId) {
          const result = await provider.poll(request.remoteJobId);
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
          const policy = imageExecutionPolicy(provider);
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
              metadata: sanitizedProviderMetadata(result.providerMetadata),
              ...policy
            };
          }
          return completedImageResult(request.providerProfileId, request.model, result, policy);
        }

        const result = await provider.submit({
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
        const policy = imageExecutionPolicy(provider);
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
            metadata: sanitizedProviderMetadata(result.providerMetadata),
            ...policy
          };
        }
        return completedImageResult(request.providerProfileId, request.model, result, policy);
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
  dependencies: PromptRefinementAdapterDependencies,
): IllustrationPromptRefinementPort {
  return {
    async refinePrompt(request) {
      try {
        const provider = await dependencies.loadTextExecution(
          request.ownerUserId,
          request.providerProfileId,
          request.model,
        );
        const result = await provider.execute({
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
  segment_id: string | null;
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
            size, aspect_ratio, quality, output_format, segment_id
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
    segmentId: job.segment_id,
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
  _pool: DatabasePool,
  store: IllustrationAssetStore,
  dependencies: AssetAdapterDependencies,
): IllustrationAssetPort {
  return {
    persistTurnIllustration: async (input) => {
      const client = input.database as DatabaseClient;
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
          generationContext: { ...generationContext, variantIndex: input.variantIndex },
          attachReference: generationContext.segmentId === null && input.variantIndex === 0
        },
      );
      return { assetId: asset.id };
    },
    persistWorldCover: async (input) => {
      const client = input.database as DatabaseClient;
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
        { generationContext: { ...generationContext, variantIndex: input.variantIndex } },
      );
      return { assetId: asset.id };
    },
    bindSegmentAsset: async (input) => {
      const client = input.database as DatabaseClient;
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
    }
  };
}

function notFound(resource: string): Error & { statusCode: number } {
  return Object.assign(new Error(`${resource} not found.`), { statusCode: 404 });
}
