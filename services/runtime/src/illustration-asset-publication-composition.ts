import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  bindPrivateNormalizedAssetPublicationRequest,
  type PrivateNormalizedAssetArtifact,
  type PrivateNormalizedAssetDerivative,
  type PrivateNormalizedAssetPublicationRequest
} from "../../../packages/application/src/assets/private-normalized-asset-publication.js";
import { toAssetMutationIdempotencyKey } from "../../../packages/application/src/assets/types.js";
import type {
  PrivateCompletedIllustrationImageExecutionResult,
  PrivateIllustrationArtifactDownloadPort,
  PrivateIllustrationAssetPublicationCoordinator,
  PrivateIllustrationCompletionOutcome,
  PrivateIllustrationFinalizationRecoveryOutcome
} from "../../../packages/application/src/illustration/private-illustration-asset-publication.js";
import {
  createPostgresIllustrationAssetPublicationRepository,
  type PrivateIllustrationAttachedPublication,
  type PrivateIllustrationPublicationJob
} from "../../../packages/database/src/illustration-asset-publication-repository.js";
import { withTransaction, type DatabasePool } from "../../../packages/database/src/pool.js";
import { createPrivateNormalizedAssetPublicationComposition } from "./normalized-asset-publication-composition.js";

const THUMBNAIL_TRANSFORM_VERSION = 1;
const THUMBNAIL_MAXIMUM_EDGE = 480;
const MAXIMUM_ARTIFACT_BYTES = 25 * 1024 * 1024;
const MAXIMUM_ARTIFACT_PIXELS = 40_000_000;
type SharpMetadata = Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;

type SupportedIllustrationFormat = Readonly<{
  format: "png" | "jpeg" | "webp";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}>;

export type PrivateNormalizedIllustrationArtifact = Readonly<{
  original: PrivateNormalizedAssetArtifact;
  thumbnail: PrivateNormalizedAssetDerivative;
}>;

function stableError(code: string): Error {
  return new Error(code);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function signedFormat(bytes: Uint8Array): SupportedIllustrationFormat | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a) {
    return { format: "png", mimeType: "image/png" };
  }
  if (bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff) {
    return { format: "jpeg", mimeType: "image/jpeg" };
  }
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") {
    return { format: "webp", mimeType: "image/webp" };
  }
  return null;
}

function displayDimensions(
  width: number,
  height: number,
  orientation: number | undefined,
): Readonly<{ width: number; height: number }> {
  return orientation !== undefined && orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}

/**
 * Private, bounded image normalization used only by the replacement
 * illustration publication graph. Hashes always cover the exact raw bytes.
 */
export async function normalizePrivateIllustrationArtifact(input: Readonly<{
  bytes: Uint8Array;
  declaredMimeType: string;
  maximumBytes: number;
  maximumPixels: number;
}>): Promise<PrivateNormalizedIllustrationArtifact> {
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > input.maximumBytes) {
    throw stableError("illustration_artifact_size_invalid");
  }
  const signed = signedFormat(input.bytes);
  if (!signed) {
    throw stableError("illustration_artifact_signature_invalid");
  }
  const declaredMimeType = input.declaredMimeType.split(";", 1)[0]?.trim().toLowerCase();
  if (declaredMimeType !== signed.mimeType) {
    throw stableError("illustration_artifact_mime_mismatch");
  }

  const source = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  let metadata: SharpMetadata;
  try {
    metadata = await sharp(source, {
      animated: false,
      failOn: "warning",
      limitInputPixels: input.maximumPixels,
      pages: 1,
      sequentialRead: true
    }).metadata();
  } catch {
    throw stableError("illustration_artifact_dimensions_invalid");
  }
  if (metadata.format !== signed.format) {
    throw stableError("illustration_artifact_mime_mismatch");
  }
  if (!metadata.width || !metadata.height
    || (metadata.pages ?? 1) !== 1
    || metadata.width * metadata.height > input.maximumPixels) {
    throw stableError("illustration_artifact_dimensions_invalid");
  }
  const displayed = displayDimensions(metadata.width, metadata.height, metadata.orientation);

  let thumbnailBytes: Buffer;
  let thumbnailMetadata: SharpMetadata;
  try {
    thumbnailBytes = await sharp(source, {
      animated: false,
      failOn: "warning",
      limitInputPixels: input.maximumPixels,
      pages: 1,
      sequentialRead: true
    })
      .rotate()
      .resize({
        width: THUMBNAIL_MAXIMUM_EDGE,
        height: THUMBNAIL_MAXIMUM_EDGE,
        fit: "inside",
        withoutEnlargement: true
      })
      .webp({ quality: 78, effort: 4, smartSubsample: false })
      .toBuffer();
    thumbnailMetadata = await sharp(thumbnailBytes, {
      animated: false,
      failOn: "warning",
      limitInputPixels: input.maximumPixels,
      pages: 1,
      sequentialRead: true
    }).metadata();
  } catch {
    throw stableError("illustration_artifact_decode_invalid");
  }
  if (thumbnailMetadata.format !== "webp"
    || !thumbnailMetadata.width
    || !thumbnailMetadata.height
    || (thumbnailMetadata.pages ?? 1) !== 1) {
    throw stableError("illustration_artifact_decode_invalid");
  }

  const original: PrivateNormalizedAssetArtifact = Object.freeze({
    bytes: input.bytes,
    mimeType: signed.mimeType,
    byteLength: input.bytes.byteLength,
    contentHash: sha256(input.bytes),
    technicalMetadata: Object.freeze({
      state: "verified" as const,
      pixelWidth: displayed.width,
      pixelHeight: displayed.height,
      format: signed.format,
      pages: 1,
      orientation: metadata.orientation ?? null
    })
  });
  const thumbnailArtifact: PrivateNormalizedAssetArtifact = Object.freeze({
    bytes: thumbnailBytes,
    mimeType: "image/webp" as const,
    byteLength: thumbnailBytes.byteLength,
    contentHash: sha256(thumbnailBytes),
    technicalMetadata: Object.freeze({
      state: "verified" as const,
      pixelWidth: thumbnailMetadata.width,
      pixelHeight: thumbnailMetadata.height,
      format: "webp" as const,
      pages: 1,
      orientation: null
    })
  });
  return Object.freeze({
    original,
    thumbnail: Object.freeze({
      slot: Object.freeze({
        derivativeKind: "thumbnail" as const,
        transformVersion: THUMBNAIL_TRANSFORM_VERSION,
        pixelWidth: thumbnailMetadata.width,
        pixelHeight: thumbnailMetadata.height
      }),
      artifact: thumbnailArtifact
    })
  });
}

function sanitizedMetadata(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.slice(0, 2_000);
  if (Array.isArray(value)) return value.slice(0, 100).map((child) => sanitizedMetadata(child, depth + 1));
  if (typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/(?:url|uri|authorization|token|secret|path|descriptor|bearer|error)/iu.test(key))
    .filter(([key]) => !["__proto__", "constructor", "prototype"].includes(key))
    .slice(0, 100)
    .map(([key, child]) => [key.slice(0, 200), sanitizedMetadata(child, depth + 1)]));
}

function responseId(
  result: PrivateCompletedIllustrationImageExecutionResult,
  job: PrivateIllustrationPublicationJob,
): string {
  const candidate = result.metadata.responseId;
  return (typeof candidate === "string" ? candidate : job.remoteJobId ?? "").slice(0, 1_000);
}

function assertReportedCost(
  value: PrivateCompletedIllustrationImageExecutionResult["reportedCost"],
): void {
  if (!value) return;
  if (!/^\d+(?:\.\d+)?$/u.test(value.amount)
    || Number(value.amount) < 0
    || !/^[A-Z]{3}$/u.test(value.currency)) {
    throw stableError("illustration_reported_cost_invalid");
  }
}

function finalVariantIndices(job: PrivateIllustrationPublicationJob): readonly number[] {
  const rawVariantIndex = job.providerRequestMetadata.targetVariantIndex;
  const requestedVariantIndex = Number(rawVariantIndex);
  const firstVariantIndex = job.segmentId
    && rawVariantIndex !== null
    && rawVariantIndex !== undefined
    && Number.isSafeInteger(requestedVariantIndex)
    ? requestedVariantIndex
    : 0;
  const variants = Array.from({ length: job.imageCount }, (_, index) => firstVariantIndex + index);
  if (variants.some((variantIndex) => variantIndex < 0 || variantIndex > 1)) {
    throw stableError("illustration_variant_index_invalid");
  }
  return Object.freeze(variants);
}

function publicationRequest(
  job: PrivateIllustrationPublicationJob,
  variantIndex: number,
  artifact: PrivateNormalizedIllustrationArtifact,
): PrivateNormalizedAssetPublicationRequest {
  const contextIntentKey = `illustration-context-${variantIndex}`;
  const referenceIntentKey = `illustration-reference-${variantIndex}`;
  const library = Object.freeze({
    title: job.targetType === "world_cover" ? "World Cover" : "Turn Illustration",
    caption: "",
    notes: "",
    tags: Object.freeze(["illustration", "generated"]),
    origin: "generated" as const,
    reviewStatus: "eligible" as const,
    reuseScope: job.targetType === "world_cover" ? "world" as const : "campaign" as const,
    automaticReuseEnabled: true,
    contentCategories: Object.freeze([]) as readonly string[],
    favorite: false
  });
  return bindPrivateNormalizedAssetPublicationRequest({
    owner: { ownerUserId: job.ownerUserId },
    idempotencyKey: toAssetMutationIdempotencyKey(
      `illustration:${job.id}:${job.generationRevision}:${variantIndex}`,
    ),
    original: artifact.original,
    derivatives: [artifact.thumbnail],
    requestedLibrary: library,
    sourceRecords: [],
    provenance: {
      kind: "illustration",
      imageJobId: job.id,
      variantIndex,
      fictionPromptIdentity: job.promptHash,
      providerProfileId: job.providerProfileId,
      providerType: job.providerType,
      model: job.requestedModel,
      parameters: {
        size: job.size,
        aspectRatio: job.aspectRatio,
        quality: job.quality,
        outputFormat: job.outputFormat
      }
    },
    contextIntents: [{
      intentKey: contextIntentKey,
      targetType: job.targetType,
      variantIndex,
      worldId: job.worldId,
      worldVersionId: job.worldVersionId,
      campaignId: job.campaignId,
      turnId: job.turnId,
      fictionPromptIdentity: job.promptHash
    }],
    referencePolicy: job.campaignId
      ? {
        mode: "attach",
        intents: [{
          intentKey: referenceIntentKey,
          assetRole: "turn_illustration",
          campaignId: job.campaignId,
          turnId: job.turnId
        }]
      }
      : { mode: "omit" }
  });
}

function sameCompletionAuthority(
  expected: PrivateIllustrationPublicationJob,
  actual: PrivateIllustrationPublicationJob,
): boolean {
  return expected.id === actual.id
    && expected.ownerUserId === actual.ownerUserId
    && expected.generationRevision === actual.generationRevision
    && expected.imageCount === actual.imageCount
    && expected.targetType === actual.targetType
    && expected.segmentId === actual.segmentId
    && expected.generationJobId === actual.generationJobId
    && expected.campaignId === actual.campaignId
    && expected.turnId === actual.turnId
    && expected.worldId === actual.worldId
    && expected.worldVersionId === actual.worldVersionId
    && expected.providerProfileId === actual.providerProfileId
    && expected.requestedModel === actual.requestedModel
    && expected.prompt === actual.prompt
    && expected.promptHash === actual.promptHash
    && expected.providerType === actual.providerType
    && expected.remoteJobId === actual.remoteJobId
    && expected.size === actual.size
    && expected.aspectRatio === actual.aspectRatio
    && expected.quality === actual.quality
    && expected.outputFormat === actual.outputFormat
    && JSON.stringify(expected.providerRequestMetadata)
      === JSON.stringify(actual.providerRequestMetadata);
}

export type PrivateIllustrationAssetPublicationComposition = Readonly<{
  coordinator: PrivateIllustrationAssetPublicationCoordinator;
  close(): Promise<void>;
}>;

/** Additive e3 replacement graph; callers deliberately do not bind this live yet. */
export async function createPrivateIllustrationAssetPublicationComposition(
  pool: DatabasePool,
  roots: Readonly<{ archiveRoot: string; assetRoot: string }>,
  artifactDownload: PrivateIllustrationArtifactDownloadPort,
): Promise<PrivateIllustrationAssetPublicationComposition> {
  const normalized = await createPrivateNormalizedAssetPublicationComposition(pool, roots);
  const repository = createPostgresIllustrationAssetPublicationRepository(pool);

  const finalizedOutcome = async (
    imageJobId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<PrivateIllustrationFinalizationRecoveryOutcome> => {
    const publications = await repository.loadFinalizations(imageJobId);
    if (publications.length === 0) {
      return Object.freeze({
        outcome: "committed_finalization_pending" as const,
        diagnostic: "asset_publication_finalization_recoverable" as const
      });
    }
    for (const publication of publications) {
      if (publication.publicationState === "published") continue;
      const result = await normalized.publication.finalize(publication.finalization, {
        leaseOwner: `illustration-finalization:${workerId}`.slice(0, 200),
        leaseSeconds
      });
      if (result.outcome === "published") {
        await repository.markFinalizationPublished(publication);
      } else {
        await repository.recordFinalizationRecoverable(publication);
      }
    }
    const assets = await repository.readPublishedAssets(imageJobId);
    return assets
      ? Object.freeze({ outcome: "published" as const, assets })
      : Object.freeze({
        outcome: "committed_finalization_pending" as const,
        diagnostic: "asset_publication_finalization_recoverable" as const
      });
  };

  const completeClaimedImageJob: PrivateIllustrationAssetPublicationCoordinator["completeClaimedImageJob"] = async (
    command,
  ): Promise<PrivateIllustrationCompletionOutcome> => {
    const job = await repository.loadClaimedPublication(command);
    if (!job) return Object.freeze({ outcome: "noop" as const });
    if ((command.result as Readonly<{ status: unknown }>).status !== "completed") {
      throw stableError("illustration_provider_result_not_completed");
    }
    if (command.result.providerRole !== "image"
      || command.result.providerProfileId !== job.providerProfileId
      || command.result.model !== job.requestedModel
      || command.result.artifacts.length !== job.imageCount) {
      throw stableError("illustration_artifact_count_invalid");
    }
    assertReportedCost(command.result.reportedCost);
    const variantIndices = finalVariantIndices(job);
    const downloaded = await Promise.all(command.result.artifacts.map((artifact) => (
      artifactDownload.downloadArtifact({
        ownerUserId: job.ownerUserId,
        imageJobId: job.id,
        artifact,
        timeoutMs: command.result.artifactDownloadTimeoutMs,
        allowPrivateHosts: command.result.allowPrivateArtifactHosts,
        maximumBytes: MAXIMUM_ARTIFACT_BYTES
      })
    )));
    const artifacts = await Promise.all(downloaded.map((download) => (
      normalizePrivateIllustrationArtifact({
        bytes: download.bytes,
        declaredMimeType: download.mimeType,
        maximumBytes: MAXIMUM_ARTIFACT_BYTES,
        maximumPixels: MAXIMUM_ARTIFACT_PIXELS
      })
    )));
    const requests = artifacts.map((artifact, index) => (
      publicationRequest(job, variantIndices[index]!, artifact)
    ));
    const reservations = await normalized.publication.reserveBatch(requests.map((request) => ({
      request,
      leaseOwner: `illustration-reservation:${command.workerId}`.slice(0, 200),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
    })));

    let committed = false;
    try {
      const attached = await withTransaction(pool, async (database) => {
        const current = await repository.lockCompletionInTransaction(database, {
          job,
          workerId: command.workerId
        });
        if (!current || !sameCompletionAuthority(job, current)) return null;
        const publications: PrivateIllustrationAttachedPublication[] = [];
        for (const [index, reservation] of reservations.entries()) {
          const variantIndex = variantIndices[index]!;
          const publication = await normalized.publication.attachInTransaction(
            database,
            reservation,
            (result) => repository.attachChildrenInTransaction(
              database,
              current,
              variantIndex,
              result,
            ),
          );
          const attachedPublication = Object.freeze({
            variantIndex,
            result: publication.result,
            finalization: publication.finalization
          });
          await repository.recordMappingInTransaction(database, current, attachedPublication);
          publications.push(attachedPublication);
        }
        const providerMetadata = sanitizedMetadata(command.result.metadata) as Readonly<Record<string, unknown>>;
        const usage = sanitizedMetadata(command.result.usage) as Readonly<Record<string, unknown>>;
        await repository.completeInTransaction(
          database,
          current,
          command.workerId,
          publications,
          {
            usage,
            reportedCost: command.result.reportedCost,
            providerMetadata,
            providerResponseId: responseId(command.result, current),
            primaryMimeType: artifacts[0]!.original.mimeType,
            primaryByteLength: artifacts[0]!.original.byteLength
          },
        );
        return Object.freeze(publications);
      });
      if (!attached) {
        await Promise.allSettled(reservations.map((reservation) => (
          normalized.publication.discardAfterRollback(reservation)
        )));
        return Object.freeze({ outcome: "noop" as const });
      }
      committed = true;
    } catch (error) {
      await Promise.allSettled(reservations.map((reservation) => (
        normalized.publication.discardAfterRollback(reservation)
      )));
      throw error;
    }
    if (!committed) return Object.freeze({ outcome: "noop" as const });
    return finalizedOutcome(job.id, command.workerId, 30);
  };

  const coordinator: PrivateIllustrationAssetPublicationCoordinator = Object.freeze({
    completeClaimedImageJob,
    recoverFinalization(
      command: Parameters<PrivateIllustrationAssetPublicationCoordinator["recoverFinalization"]>[0],
    ) {
      return finalizedOutcome(command.imageJobId, command.workerId, command.leaseSeconds);
    }
  });

  let closed: Promise<void> | undefined;
  return Object.freeze({
    coordinator,
    close() {
      closed ??= normalized.close();
      return closed;
    }
  });
}
