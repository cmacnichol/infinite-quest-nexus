import { createHash } from "node:crypto";
import { bindPrivateBoundedStreamLimits } from "../../../packages/application/src/assets/private-secure-storage.js";
import type {
  PrivateAssetMetadataBackfillClaim,
  PrivateAssetMetadataBackfillExecutionRequest,
  PrivateAssetMetadataBackfillOutcome
} from "../../../packages/application/src/assets/private-metadata-backfill.js";
import type { AssetFilesystemDiagnosticCode } from "../../../packages/application/src/assets/types.js";
import { createPostgresAssetMetadataBackfillExecutorRepository } from "../../../packages/database/src/asset-metadata-backfill-executor-repository.js";
import { withTransaction, type DatabasePool } from "../../../packages/database/src/pool.js";
import { createAssetImportStorageComposition } from "./asset-import-composition.js";
import { normalizePrivateImageArtifact } from "./private-image-normalization.js";

const MAXIMUM_ORIGINAL_BYTES = 16 * 1024 * 1024;
const MAXIMUM_IMAGE_PIXELS = 20_000_000;

function diagnosticFor(error: unknown): AssetFilesystemDiagnosticCode {
  const message = error instanceof Error ? error.message : "";
  if (/hash|content_hash|stream_hash/u.test(message)) return "asset_hash_mismatch";
  if (/size|byte|too_large|limit/u.test(message)) return "asset_too_large";
  if (/signature|mime|decode|dimensions|unsupported/u.test(message)) return "asset_unsupported_media";
  if (/containment|link|path|identity|race/u.test(message)) return "filesystem_containment_denied";
  if (/ENOENT|no such file|delivery|storage|stream|filesystem/u.test(message)) return "asset_storage_unavailable";
  return "asset_metadata_unavailable";
}

function leaseExpiry(leaseSeconds: number): string {
  return new Date(Date.now() + Math.max(2, leaseSeconds) * 1000).toISOString();
}

function matchesStoredOriginalHash(bytes: Uint8Array, expectedContentHash: string): boolean {
  const rawHash = createHash("sha256").update(bytes).digest("hex");
  if (rawHash === expectedContentHash) return true;
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const legacyHash = createHash("sha256").update(source.toString("base64")).digest("hex");
  return legacyHash === expectedContentHash;
}

async function readBoundedOriginal(
  adapter: Awaited<ReturnType<typeof createAssetImportStorageComposition>>["adapter"],
  claim: PrivateAssetMetadataBackfillClaim,
): Promise<Uint8Array> {
  if (claim.expectedByteLength > MAXIMUM_ORIGINAL_BYTES) throw new Error("asset_metadata_backfill_size_invalid");
  const session = await adapter.openAssetSession({
    scope: { ownerUserId: claim.ownerUserId, assetId: claim.assetId },
    request: { kind: "original" },
    limits: bindPrivateBoundedStreamLimits({
      maximumBytes: Math.min(MAXIMUM_ORIGINAL_BYTES, claim.expectedByteLength),
      chunkBytes: Math.min(64 * 1024, claim.expectedByteLength),
      deadlineAt: claim.leaseExpiresAt
    })
  });
  if (!session || session.contentType !== claim.expectedMimeType || session.byteLength !== claim.expectedByteLength) {
    throw new Error("asset_metadata_backfill_delivery_invalid");
  }
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for await (const chunk of session.chunks) {
      length += chunk.byteLength;
      if (length > claim.expectedByteLength || length > MAXIMUM_ORIGINAL_BYTES) {
        throw new Error("asset_metadata_backfill_size_invalid");
      }
      parts.push(chunk);
    }
  } finally {
    await session.finalize("eof").catch(() => undefined);
  }
  if (length !== claim.expectedByteLength) throw new Error("asset_metadata_backfill_size_invalid");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  if (!matchesStoredOriginalHash(bytes, claim.expectedContentHash)) {
    throw new Error("asset_metadata_backfill_hash_invalid");
  }
  return bytes;
}

export type PrivateAssetMetadataBackfillComposition = Readonly<{
  executor: Readonly<{
    processOne(request: PrivateAssetMetadataBackfillExecutionRequest): Promise<PrivateAssetMetadataBackfillOutcome>;
  }>;
  close(): Promise<void>;
}>;

/**
 * Additive e5 runtime graph. It is intentionally private and unconsumed by
 * worker/API/default composition until e3e7 binds the maintenance lane.
 */
export async function createPrivateAssetMetadataBackfillComposition(
  pool: DatabasePool,
  roots: Readonly<{ archiveRoot: string; assetRoot: string }>,
): Promise<PrivateAssetMetadataBackfillComposition> {
  const storage = await createAssetImportStorageComposition(pool, roots);
  const repository = createPostgresAssetMetadataBackfillExecutorRepository(pool, storage.journal);

  async function decodeWithHeartbeats(
    initialClaim: PrivateAssetMetadataBackfillClaim,
    leaseSeconds: number,
  ): Promise<Readonly<{
    claim: PrivateAssetMetadataBackfillClaim;
    normalized: Awaited<ReturnType<typeof normalizePrivateImageArtifact>>;
  }> | null> {
    let claim = initialClaim;
    let heartbeat: Promise<void> | undefined;
    let leaseLost = false;
    const pulse = (): Promise<void> => {
      heartbeat ??= repository.heartbeat(claim, leaseSeconds)
        .then((renewed) => {
          if (renewed) claim = renewed;
          else leaseLost = true;
        })
        .catch(() => { leaseLost = true; })
        .finally(() => { heartbeat = undefined; });
      return heartbeat;
    };
    const interval = setInterval(() => { void pulse(); }, Math.max(250, Math.floor(leaseSeconds * 333)));
    try {
      const bytes = await readBoundedOriginal(storage.adapter, claim);
      const normalized = await normalizePrivateImageArtifact({
        bytes,
        declaredMimeType: claim.expectedMimeType,
        maximumBytes: MAXIMUM_ORIGINAL_BYTES,
        maximumPixels: MAXIMUM_IMAGE_PIXELS,
        diagnosticPrefix: "portable_import_image"
      });
      await pulse();
      return leaseLost ? null : Object.freeze({ claim, normalized });
    } finally {
      clearInterval(interval);
      await heartbeat;
    }
  }

  const processClaim = async (
    initialClaim: PrivateAssetMetadataBackfillClaim,
    leaseSeconds: number,
  ): Promise<PrivateAssetMetadataBackfillOutcome> => {
    let claim = initialClaim;
    try {
      const pending = await repository.pendingFinalization(claim, leaseSeconds);
      if (pending) {
        await storage.adapter.finalizeAssetPublication([pending]);
        const completed = await repository.completeFinalization(claim, pending.operation.operationId);
        return completed === "completed"
          ? { outcome: "completed", assetId: claim.assetId }
          : { outcome: completed, assetId: claim.assetId };
      }
      const renewedBeforeRead = await repository.heartbeat(claim, leaseSeconds);
      if (!renewedBeforeRead) return { outcome: "lease_lost", assetId: claim.assetId };
      claim = renewedBeforeRead;
      const decoded = await decodeWithHeartbeats(claim, leaseSeconds);
      if (!decoded) return { outcome: "lease_lost", assetId: claim.assetId };
      claim = decoded.claim;
      const normalized = decoded.normalized;
      if (!matchesStoredOriginalHash(normalized.original.bytes, claim.expectedContentHash)
        || normalized.original.byteLength !== claim.expectedByteLength
        || normalized.original.mimeType !== claim.expectedMimeType) {
        throw new Error("asset_metadata_backfill_identity_invalid");
      }
      const thumbnail = Object.freeze({
        bytes: normalized.thumbnail.artifact.bytes,
        contentHash: normalized.thumbnail.artifact.contentHash,
        byteLength: normalized.thumbnail.artifact.byteLength,
        mimeType: "image/webp" as const,
        pixelWidth: normalized.thumbnail.slot.pixelWidth,
        pixelHeight: normalized.thumbnail.slot.pixelHeight,
        transformVersion: 1 as const
      });
      const technicalMetadata = Object.freeze({
        format: normalized.original.technicalMetadata.format,
        pages: 1 as const,
        orientation: normalized.original.technicalMetadata.orientation
      });
      const existing = await repository.completeWithExistingThumbnail(claim, thumbnail, technicalMetadata);
      if (existing === "completed") return { outcome: "completed", assetId: claim.assetId };
      const renewedBeforePrepare = await repository.heartbeat(claim, leaseSeconds);
      if (!renewedBeforePrepare) return { outcome: "lease_lost", assetId: claim.assetId };
      claim = renewedBeforePrepare;
      const prepared = await storage.adapter.prepareMetadataBackfillThumbnail({
        claim,
        expiresAt: leaseExpiry(leaseSeconds),
        thumbnail
      });
      let attachmentCommitted = false;
      try {
        const renewedBeforeAttach = await repository.heartbeat(claim, leaseSeconds);
        if (!renewedBeforeAttach) {
          await prepared.rollback();
          return { outcome: "lease_lost", assetId: claim.assetId };
        }
        claim = renewedBeforeAttach;
        const finalization = await withTransaction(pool, (database) => repository.attachThumbnail(
          database,
          claim,
          thumbnail,
          prepared.attachment,
          technicalMetadata,
        ));
        if (!finalization) {
          await prepared.rollback();
          return { outcome: "lease_lost", assetId: claim.assetId };
        }
        // After this transaction commits, the durable attached operation and
        // derivative row are recovery evidence. A later finalization failure
        // must leave them intact for the next claim, never roll them back.
        attachmentCommitted = true;
        await storage.adapter.finalizeAssetPublication([finalization]);
        const completed = await repository.completeFinalization(claim, finalization.operation.operationId);
        return completed === "completed"
          ? { outcome: "completed", assetId: claim.assetId }
          : { outcome: completed, assetId: claim.assetId };
      } catch (error) {
        if (!attachmentCommitted) await prepared.rollback().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      const diagnosticCode = diagnosticFor(error);
      const outcome = await repository.fail(claim, diagnosticCode).catch(() => "lease_lost" as const);
      return outcome === "recoverable" || outcome === "failed"
        ? { outcome, assetId: claim.assetId, diagnosticCode }
        : { outcome, assetId: claim.assetId };
    }
  };

  return Object.freeze({
    executor: Object.freeze({
      async processOne(request: PrivateAssetMetadataBackfillExecutionRequest): Promise<PrivateAssetMetadataBackfillOutcome> {
        // Migration 0053 seeded pre-existing originals. The active worker must
        // also discover legacy originals written after startup so the durable
        // executor preserves the former continuous backfill behavior.
        await repository.enqueueMissing(100);
        const claimed = await repository.claimNext(request);
        return claimed ? processClaim(claimed, request.leaseSeconds) : { outcome: "idle" as const };
      }
    }),
    close: () => storage.close()
  });
}
