import type {
  AssetPublicationCandidate,
  AttachedFilesystemOperation,
  DurableFilesystemAttachResult,
  DurableFilesystemRecoveryClaim,
  DurableFilesystemTransactionContext,
  PrivatePublicationPreparation,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation
} from "./private-storage-lifecycle.js";

declare const privateFilesystemCandidateAttachmentBrand: unique symbol;

/** Exact database and filesystem evidence consumed by durable candidate attachment. */
export type PrivateFilesystemCandidateAttachment = Readonly<{
  operation: ReservedFilesystemOperation;
  candidate: AssetPublicationCandidate;
  descriptor: PrivateStorageDescriptor;
  claim: DurableFilesystemRecoveryClaim;
  [privateFilesystemCandidateAttachmentBrand]: true;
}>;

/** Adapter-private, restart-safe persistence and redemption of candidate authority. */
export interface PrivateFilesystemCandidatePersistencePort {
  issuePublicationCandidate(
    reservation: ReservedFilesystemOperation,
    preparation: PrivatePublicationPreparation,
  ): Promise<AssetPublicationCandidate>;
  completePublicationCandidate(
    reservation: ReservedFilesystemOperation,
    candidate: AssetPublicationCandidate,
    descriptor: PrivateStorageDescriptor,
  ): Promise<void>;
  persistCandidate(attachment: PrivateFilesystemCandidateAttachment): Promise<void>;
  redeemCandidate(attachment: PrivateFilesystemCandidateAttachment): Promise<PrivateStorageDescriptor | null>;
  attachCandidate(
    database: DurableFilesystemTransactionContext,
    attachment: PrivateFilesystemCandidateAttachment,
  ): Promise<DurableFilesystemAttachResult>;
}

/**
 * Private, process-spanning serialization for content-addressed asset bytes.
 * The callback owns no authority; it merely keeps deterministic hash locks
 * while a caller reserves, verifies/reuses, and attaches a physical node.
 */
export interface PrivateFilesystemPublicationLockPort {
  lockPublicationContent(
    database: DurableFilesystemTransactionContext,
    contentHashes: readonly string[],
  ): Promise<void>;
  withPublicationContentLocks<Result>(
    contentHashes: readonly string[],
    work: () => Promise<Result>,
  ): Promise<Result>;
}

function nonBlank(value: string): boolean {
  return value.trim().length > 0;
}

function requireDescriptor(descriptor: PrivateStorageDescriptor): void {
  const pathIsInvalid = !nonBlank(descriptor.relativePath)
    || descriptor.relativePath.startsWith("/")
    || /^[A-Za-z]:/u.test(descriptor.relativePath)
    || descriptor.relativePath.includes("\\")
    || descriptor.relativePath.split("/").some((segment) => segment === "." || segment === "..");
  if (pathIsInvalid
    || !nonBlank(descriptor.identity.deviceId)
    || !nonBlank(descriptor.identity.fileId)
    || !nonBlank(descriptor.identity.changeToken)
    || !/^[0-9a-f]{64}$/u.test(descriptor.contentHash)
    || !Number.isSafeInteger(descriptor.byteLength)
    || descriptor.byteLength < 0) {
    throw new Error("filesystem_descriptor_invalid");
  }
}

function requireOperation(operation: ReservedFilesystemOperation | AttachedFilesystemOperation): void {
  const scopeIsInvalid = !nonBlank(operation.operationId)
    || !nonBlank(operation.ownerUserId)
    || (operation.resourceKind === "asset" && !nonBlank(operation.assetId))
    || (operation.resourceKind === "portable" && !nonBlank(operation.operationScopeId))
    || (operation.resourceKind === "asset"
      && !["asset_original", "asset_derivative"].includes(operation.purpose))
    || (operation.resourceKind === "portable"
      && !["portable_staging", "portable_export"].includes(operation.purpose));
  if (scopeIsInvalid) throw new Error("filesystem_scope_invalid");
}

function requireFreshClaim(
  operation: ReservedFilesystemOperation | AttachedFilesystemOperation,
  claim: DurableFilesystemRecoveryClaim,
): void {
  if (!nonBlank(claim.operationId)
    || !nonBlank(claim.leaseId)
    || !nonBlank(claim.leaseOwner)
    || !Number.isInteger(claim.workVersion)
    || claim.workVersion <= 0
    || !nonBlank(claim.leaseExpiresAt)
    || !Number.isFinite(Date.parse(claim.leaseExpiresAt))) {
    throw new Error("filesystem_recovery_claim_invalid");
  }
  if (claim.operationId !== operation.operationId) {
    throw new Error("filesystem_recovery_claim_mismatch");
  }
  if (Date.parse(claim.leaseExpiresAt) <= Date.now()) {
    throw new Error("filesystem_recovery_claim_expired");
  }
}

function snapshotOperation<Operation extends ReservedFilesystemOperation | AttachedFilesystemOperation>(
  operation: Operation,
): Operation {
  const scope = operation.resourceKind === "asset"
    ? { resourceKind: "asset" as const, ownerUserId: operation.ownerUserId, assetId: operation.assetId }
    : {
      resourceKind: "portable" as const,
      ownerUserId: operation.ownerUserId,
      operationScopeId: operation.operationScopeId
    };
  return Object.freeze({
    ...scope,
    operationId: operation.operationId,
    purpose: operation.purpose,
    ...(Object.hasOwn(operation, "expiresAt")
      ? { expiresAt: (operation as ReservedFilesystemOperation).expiresAt }
      : {})
  }) as Operation;
}

function snapshotDescriptor(descriptor: PrivateStorageDescriptor): PrivateStorageDescriptor {
  return Object.freeze({
    relativePath: descriptor.relativePath,
    identity: Object.freeze({ ...descriptor.identity }),
    contentHash: descriptor.contentHash,
    byteLength: descriptor.byteLength
  });
}

function snapshotClaim(claim: DurableFilesystemRecoveryClaim): DurableFilesystemRecoveryClaim {
  return Object.freeze({
    operationId: claim.operationId,
    leaseId: claim.leaseId,
    leaseOwner: claim.leaseOwner,
    workVersion: claim.workVersion,
    leaseExpiresAt: claim.leaseExpiresAt
  }) as DurableFilesystemRecoveryClaim;
}

export function bindPrivateFilesystemCandidateAttachment(
  operation: ReservedFilesystemOperation,
  candidate: AssetPublicationCandidate,
  descriptor: PrivateStorageDescriptor,
  claim: DurableFilesystemRecoveryClaim,
): PrivateFilesystemCandidateAttachment {
  requireOperation(operation);
  if (!nonBlank(operation.expiresAt) || Date.parse(operation.expiresAt) <= Date.now()) {
    throw new Error("filesystem_operation_expired");
  }
  if (!nonBlank(candidate)) throw new Error("filesystem_candidate_invalid");
  requireDescriptor(descriptor);
  requireFreshClaim(operation, claim);
  return Object.freeze({
    operation: snapshotOperation(operation),
    candidate,
    descriptor: snapshotDescriptor(descriptor),
    claim: snapshotClaim(claim)
  }) as PrivateFilesystemCandidateAttachment;
}
