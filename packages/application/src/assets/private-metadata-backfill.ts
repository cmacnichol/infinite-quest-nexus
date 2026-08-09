import type { PrivateFilesystemCandidateAttachment } from "./private-filesystem-repository.js";
import type {
  AttachedFilesystemOperation,
  DurableFilesystemRecoveryClaim
} from "./private-storage-lifecycle.js";
import type { AssetFilesystemDiagnosticCode, AssetOwnerScope } from "./types.js";

export type PrivateAssetMetadataBackfillClaim = AssetOwnerScope & Readonly<{
  assetId: string;
  leaseId: string;
  leaseOwner: string;
  workVersion: number;
  leaseExpiresAt: string;
  expectedContentHash: string;
  expectedMimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  expectedByteLength: number;
}>;

export type PrivateAssetMetadataBackfillThumbnail = Readonly<{
  bytes: Uint8Array;
  contentHash: string;
  byteLength: number;
  mimeType: "image/webp";
  pixelWidth: number;
  pixelHeight: number;
  transformVersion: 1;
}>;

/** Private secure-storage input for an existing asset; it cannot create or replace its original. */
export type PrivateMetadataBackfillThumbnailPreparation = Readonly<{
  claim: PrivateAssetMetadataBackfillClaim;
  expiresAt: string;
  thumbnail: PrivateAssetMetadataBackfillThumbnail;
}>;

export type PrivatePreparedMetadataBackfillThumbnail = Readonly<{
  attachment: PrivateFilesystemCandidateAttachment;
  rollback(): Promise<void>;
}>;

export type PrivateAssetMetadataBackfillFinalization = Readonly<{
  operation: AttachedFilesystemOperation;
  claim: DurableFilesystemRecoveryClaim;
}>;

export type PrivateAssetMetadataBackfillOutcome =
  | Readonly<{ outcome: "completed"; assetId: string }>
  | Readonly<{ outcome: "idle" }>
  | Readonly<{ outcome: "recoverable" | "failed"; assetId: string; diagnosticCode: AssetFilesystemDiagnosticCode }>
  | Readonly<{ outcome: "stale" | "lease_lost"; assetId: string }>;

export type PrivateAssetMetadataBackfillExecutionRequest = Readonly<{
  workerId: string;
  leaseSeconds: number;
}>;
