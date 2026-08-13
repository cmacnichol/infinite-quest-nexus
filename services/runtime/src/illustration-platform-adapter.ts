// Concrete provider and artifact adapters belong to the runtime
// composition layer. Their dependencies are supplied as typed ports so API
// routes and application use cases remain platform-free.
import type {
  IllustrationArtifactDownloadPort,
  IllustrationImageArtifact,
  IllustrationImageExecutionResult,
  IllustrationImageProviderPort,
  IllustrationPromptRefinementPort,
  IllustrationTransactionContext
} from "../../../packages/application/src/index.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
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

function notFound(resource: string): Error & { statusCode: number } {
  return Object.assign(new Error(`${resource} not found.`), { statusCode: 404 });
}
