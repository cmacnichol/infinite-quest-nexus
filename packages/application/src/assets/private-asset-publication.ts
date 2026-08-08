import type { AssetOrigin } from "@infinite-quest/contracts";
import type { PrivateFilesystemCandidateAttachment } from "./private-filesystem-repository.js";
import type {
  AttachedFilesystemOperation,
  DurableFilesystemRecoveryClaim,
  DurableFilesystemTransactionContext
} from "./private-storage-lifecycle.js";
import type { AssetMutationIdempotencyKey, AssetOwnerScope } from "./types.js";

declare const privateAssetPublicationIdentityBrand: unique symbol;

export type PrivateAssetPublicationArtifact = Readonly<{
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  byteLength: number;
  contentHash: string;
  bytes: Uint8Array;
}>;

export type PrivateAssetPublicationDerivative = PrivateAssetPublicationArtifact & Readonly<{
  derivativeKind: "thumbnail";
  transformVersion: number;
  pixelWidth: number;
  pixelHeight: number;
}>;

/** Server/worker-derived provenance only; no browser owner or filesystem authority enters this shape. */
export type PrivateAssetPublicationProvenance = Readonly<{
  origin: AssetOrigin;
  campaignId?: string;
  turnId?: string;
  worldId?: string;
  worldVersionId?: string;
  targetType?: "world_cover" | "turn_illustration" | "streaming_illustration" | "other";
}>;

export type PrivateAssetPublicationCommand = Readonly<{
  owner: AssetOwnerScope;
  idempotencyKey: AssetMutationIdempotencyKey;
  leaseOwner: string;
  expiresAt: string;
  original: PrivateAssetPublicationArtifact;
  derivatives: readonly PrivateAssetPublicationDerivative[];
  provenance: PrivateAssetPublicationProvenance;
}>;

/** Durable retry identity; it is private so callers cannot turn it into ownership authority. */
export type PrivateAssetPublicationIdentity = Readonly<{
  assetId: string;
  ownerUserId: string;
  lifecycle: "prepared" | "attached" | "published";
  result?: PrivateAssetPublicationResult;
  finalization?: readonly PrivateAssetPublicationFinalization[];
  [privateAssetPublicationIdentityBrand]: true;
}>;

export type PrivatePreparedAssetPublicationArtifact = Readonly<{
  kind: "original" | "derivative";
  derivativeIndex: number | null;
  attachment: PrivateFilesystemCandidateAttachment;
  rollback(): Promise<void>;
}>;

export type PrivatePreparedAssetPublication = Readonly<{
  original: PrivatePreparedAssetPublicationArtifact;
  derivatives: readonly PrivatePreparedAssetPublicationArtifact[];
}>;

/** Safe result shape: no paths, candidates, descriptors, bearer values, or raw errors. */
export type PrivateAssetPublicationResult = Readonly<{
  assetId: string;
  mimeType: PrivateAssetPublicationArtifact["mimeType"];
  byteLength: number;
  contentHash: string;
  derivativeIds: readonly Readonly<{
    derivativeId: string;
    derivativeKind: "thumbnail";
  }>[];
}>;

/** Attachment evidence stays private until the secure adapter finalizes post-commit. */
export type PrivateAssetPublicationFinalization = Readonly<{
  operation: AttachedFilesystemOperation;
  claim: DurableFilesystemRecoveryClaim;
}>;

export type PrivateAttachedAssetPublication = Readonly<{
  identity: PrivateAssetPublicationIdentity;
  result: PrivateAssetPublicationResult;
  finalization: readonly PrivateAssetPublicationFinalization[];
}>;

/** Private replay result after checking the durable finalization state under an identity lock. */
export type PrivateAttachedAssetPublicationReconciliation =
  | Readonly<{ outcome: "published"; result: PrivateAssetPublicationResult }>
  | Readonly<{ outcome: "ready_to_finalize"; identity: PrivateAssetPublicationIdentity }>
  | Readonly<{ outcome: "recoverable" }>;

export interface PrivateAssetPublicationIdentityPort {
  prepareIdentity(command: PrivateAssetPublicationCommand): Promise<PrivateAssetPublicationIdentity>;
  attachPublication(
    database: DurableFilesystemTransactionContext,
    identity: PrivateAssetPublicationIdentity,
    command: PrivateAssetPublicationCommand,
    prepared: PrivatePreparedAssetPublication,
  ): Promise<PrivateAttachedAssetPublication>;
  reconcileAttachedPublication(
    identity: PrivateAssetPublicationIdentity,
  ): Promise<PrivateAttachedAssetPublicationReconciliation>;
  completePublication(identity: PrivateAssetPublicationIdentity): Promise<PrivateAssetPublicationResult>;
}

export interface PrivateAssetPublicationFilesystemPort {
  prepareAssetPublication(
    command: PrivateAssetPublicationCommand,
    identity: PrivateAssetPublicationIdentity,
  ): Promise<PrivatePreparedAssetPublication>;
  finalizeAssetPublication(finalization: readonly PrivateAssetPublicationFinalization[]): Promise<void>;
}

function validHash(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function validArtifact(value: PrivateAssetPublicationArtifact): boolean {
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(value.mimeType)
    && Number.isSafeInteger(value.byteLength)
    && value.byteLength >= 0
    && value.bytes.byteLength === value.byteLength
    && validHash(value.contentHash);
}

/** Pure boundary validation before a storage adapter receives bytes or scope. */
export function validatePrivateAssetPublicationCommand(
  command: PrivateAssetPublicationCommand,
): void {
  if (command.owner.ownerUserId.trim().length === 0
    || command.idempotencyKey.trim().length === 0
    || command.leaseOwner.trim().length === 0
    || !Number.isFinite(Date.parse(command.expiresAt))
    || Date.parse(command.expiresAt) <= Date.now()
    || !validArtifact(command.original)
    || !["generated", "imported", "uploaded"].includes(command.provenance.origin)) {
    throw new Error("asset_publication_invalid");
  }
  for (const derivative of command.derivatives) {
    if (!validArtifact(derivative)
      || derivative.derivativeKind !== "thumbnail"
      || !Number.isSafeInteger(derivative.transformVersion)
      || derivative.transformVersion <= 0
      || !Number.isSafeInteger(derivative.pixelWidth)
      || derivative.pixelWidth <= 0
      || !Number.isSafeInteger(derivative.pixelHeight)
      || derivative.pixelHeight <= 0) {
      throw new Error("asset_publication_derivative_invalid");
    }
  }
}

function snapshotArtifact(
  artifact: PrivateAssetPublicationArtifact,
): PrivateAssetPublicationArtifact {
  const snapshot = Object.freeze({
    mimeType: artifact.mimeType,
    byteLength: artifact.byteLength,
    contentHash: artifact.contentHash,
    // The copied buffer is held only by the private command snapshot; callers
    // cannot change bytes after reserve begins by retaining their input view.
    bytes: new Uint8Array(artifact.bytes)
  });
  return snapshot;
}

/** The runtime owns the cryptographic primitive; this pure boundary owns the comparison. */
export function verifyPrivateAssetPublicationContentHashes(
  command: PrivateAssetPublicationCommand,
  sha256: (bytes: Uint8Array) => string,
): void {
  for (const artifact of [command.original, ...command.derivatives]) {
    if (sha256(artifact.bytes) !== artifact.contentHash) {
      throw new Error("asset_publication_content_hash_mismatch");
    }
  }
}

/** Capture every mutable input before the composition performs its first await. */
export function snapshotPrivateAssetPublicationCommand(
  command: PrivateAssetPublicationCommand,
): PrivateAssetPublicationCommand {
  const snapshot = Object.freeze({
    owner: Object.freeze({ ownerUserId: command.owner.ownerUserId }),
    idempotencyKey: command.idempotencyKey,
    leaseOwner: command.leaseOwner,
    expiresAt: command.expiresAt,
    original: snapshotArtifact(command.original),
    derivatives: Object.freeze(command.derivatives.map((derivative) => Object.freeze({
      ...snapshotArtifact(derivative),
      derivativeKind: derivative.derivativeKind,
      transformVersion: derivative.transformVersion,
      pixelWidth: derivative.pixelWidth,
      pixelHeight: derivative.pixelHeight
    }))),
    provenance: Object.freeze({ ...command.provenance })
  }) as PrivateAssetPublicationCommand;
  validatePrivateAssetPublicationCommand(snapshot);
  return snapshot;
}
