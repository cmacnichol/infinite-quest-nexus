import type {
  DurableFilesystemRecoveryClaim,
  DurableFilesystemRecoveryRecord,
  DurableFilesystemTransactionContext,
  ReservedFilesystemOperation
} from "./private-storage-lifecycle.js";

declare const privatePrewriteNodeAuthorityBrand: unique symbol;
declare const privatePrewriteCleanupPreparationBrand: unique symbol;
declare const privateBoundedStreamLimitsBrand: unique symbol;
declare const legacyPathV1PreviewDescriptorBrand: unique symbol;

export type PrivateFilesystemNodeIdentity = Readonly<{
  deviceId: string;
  fileId: string;
}>;

/**
 * Immutable evidence persisted after O_EXCL create/fstat and before the first
 * content byte is written. The operation-derived target never comes from a
 * browser or bearer.
 */
export type PrivatePrewriteNodeAuthority = Readonly<{
  operation: ReservedFilesystemOperation;
  relativePath: string;
  identity: PrivateFilesystemNodeIdentity;
  [privatePrewriteNodeAuthorityBrand]: true;
}>;

export type PrivatePrewriteCleanupPreparation = Readonly<{
  outcome: "cleanup_required";
  operation: ReservedFilesystemOperation;
  claim: DurableFilesystemRecoveryClaim;
  relativePath: string;
  identity: PrivateFilesystemNodeIdentity;
  [privatePrewriteCleanupPreparationBrand]: true;
}>;

export type PrivatePrewriteCleanupResult =
  | PrivatePrewriteCleanupPreparation
  | Readonly<{ outcome: "already_cleaned" | "stale" | "lease_lost" }>;

export interface PrivatePrewriteNodeRepositoryPort {
  recordPrewriteNode(authority: PrivatePrewriteNodeAuthority): Promise<void>;
  preparePrewriteCleanup(
    database: DurableFilesystemTransactionContext,
    recovery: DurableFilesystemRecoveryRecord,
  ): Promise<PrivatePrewriteCleanupResult>;
}

export interface PrivatePortableExpiryRecoveryPort {
  claimExpiredPortableWork(request: Readonly<{
    leaseOwner: string;
    leaseSeconds: number;
    limit: number;
  }>): Promise<readonly DurableFilesystemRecoveryRecord[]>;
}

export type PrivateBoundedStreamLimits = Readonly<{
  maximumBytes: number;
  chunkBytes: number;
  deadlineAt: string;
  [privateBoundedStreamLimitsBrand]: true;
}>;

export type PrivateStreamTerminalReason =
  | "eof"
  | "close"
  | "abort"
  | "timeout"
  | "pre_send_failure"
  | "read_failure";

/** A single anchored descriptor handle with one memoized terminal action. */
export interface PrivateBoundedStreamSession {
  readonly contentType: string;
  readonly byteLength: number;
  readonly chunks: AsyncIterable<Uint8Array>;
  finalize(reason: PrivateStreamTerminalReason): Promise<void>;
}

/** Server-derived compatibility descriptor. It is read-only and never reaped. */
export type LegacyPathV1PreviewDescriptor = Readonly<{
  kind: "legacy_path_v1";
  relativePath: string;
  contentType: "application/zip" | "application/json";
  contentHash: string;
  byteLength: number;
  [legacyPathV1PreviewDescriptorBrand]: true;
}>;

function nonBlank(value: string): boolean {
  return value.trim().length > 0;
}

function requireRelativePath(relativePath: string): void {
  if (!nonBlank(relativePath)
    || relativePath.startsWith("/")
    || /^[A-Za-z]:/u.test(relativePath)
    || relativePath.includes("\\")
    || relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("filesystem_path_invalid");
  }
}

export function bindPrivatePrewriteNodeAuthority(
  operation: ReservedFilesystemOperation,
  relativePath: string,
  identity: PrivateFilesystemNodeIdentity,
): PrivatePrewriteNodeAuthority {
  if (!nonBlank(operation.operationId)
    || !nonBlank(operation.ownerUserId)
    || !nonBlank(operation.expiresAt)
    || !Number.isFinite(Date.parse(operation.expiresAt))
    || Date.parse(operation.expiresAt) <= Date.now()) {
    throw new Error("filesystem_operation_invalid");
  }
  if ((operation.resourceKind === "asset" && !nonBlank(operation.assetId))
    || (operation.resourceKind === "portable" && !nonBlank(operation.operationScopeId))) {
    throw new Error("filesystem_scope_invalid");
  }
  requireRelativePath(relativePath);
  if (!nonBlank(identity.deviceId) || !nonBlank(identity.fileId)) {
    throw new Error("filesystem_identity_invalid");
  }
  return Object.freeze({
    operation: Object.freeze({ ...operation }),
    relativePath,
    identity: Object.freeze({ ...identity })
  }) as PrivatePrewriteNodeAuthority;
}

export function bindPrivatePrewriteCleanupPreparation(
  operation: ReservedFilesystemOperation,
  claim: DurableFilesystemRecoveryClaim,
  relativePath: string,
  identity: PrivateFilesystemNodeIdentity,
): PrivatePrewriteCleanupPreparation {
  requireRelativePath(relativePath);
  if (claim.operationId !== operation.operationId
    || !nonBlank(claim.leaseId)
    || !nonBlank(claim.leaseOwner)
    || !Number.isInteger(claim.workVersion)
    || claim.workVersion <= 0
    || !Number.isFinite(Date.parse(claim.leaseExpiresAt))) {
    throw new Error("filesystem_recovery_claim_invalid");
  }
  if (!nonBlank(identity.deviceId) || !nonBlank(identity.fileId)) {
    throw new Error("filesystem_identity_invalid");
  }
  return Object.freeze({
    outcome: "cleanup_required" as const,
    operation: Object.freeze({ ...operation }),
    claim: Object.freeze({ ...claim }) as DurableFilesystemRecoveryClaim,
    relativePath,
    identity: Object.freeze({ ...identity })
  }) as PrivatePrewriteCleanupPreparation;
}

export function bindPrivateBoundedStreamLimits(input: Readonly<{
  maximumBytes: number;
  chunkBytes?: number;
  deadlineAt: string;
}>): PrivateBoundedStreamLimits {
  const chunkBytes = input.chunkBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(input.maximumBytes)
    || input.maximumBytes < 0
    || !Number.isSafeInteger(chunkBytes)
    || chunkBytes <= 0
    || chunkBytes > Math.max(1, input.maximumBytes)
    || !nonBlank(input.deadlineAt)
    || !Number.isFinite(Date.parse(input.deadlineAt))
    || Date.parse(input.deadlineAt) <= Date.now()) {
    throw new Error("filesystem_stream_limits_invalid");
  }
  return Object.freeze({
    maximumBytes: input.maximumBytes,
    chunkBytes,
    deadlineAt: input.deadlineAt
  }) as PrivateBoundedStreamLimits;
}

export function bindLegacyPathV1PreviewDescriptor(input: Readonly<{
  relativePath: string;
  contentType: "application/zip" | "application/json";
  contentHash: string;
  byteLength: number;
}>): LegacyPathV1PreviewDescriptor {
  requireRelativePath(input.relativePath);
  if (!["application/zip", "application/json"].includes(input.contentType)
    || !/^[0-9a-f]{64}$/u.test(input.contentHash)
    || !Number.isSafeInteger(input.byteLength)
    || input.byteLength < 0) {
    throw new Error("legacy_path_v1_descriptor_invalid");
  }
  return Object.freeze({
    kind: "legacy_path_v1" as const,
    relativePath: input.relativePath,
    contentType: input.contentType,
    contentHash: input.contentHash,
    byteLength: input.byteLength
  }) as LegacyPathV1PreviewDescriptor;
}
