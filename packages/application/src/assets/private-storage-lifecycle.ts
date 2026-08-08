import type { AssetFilesystemDiagnosticCode, AssetOwnerScope, AssetScope } from "./types.js";

declare const durableFilesystemOperationIdBrand: unique symbol;
declare const assetPublicationCandidateBrand: unique symbol;
declare const reservedFilesystemOperationBrand: unique symbol;
declare const attachedFilesystemOperationBrand: unique symbol;
declare const durableFilesystemRecoveryClaimBrand: unique symbol;
declare const privateFilesystemCandidateAuthorityBrand: unique symbol;

export type DurableFilesystemOperationId = string & Readonly<{
  [durableFilesystemOperationIdBrand]: true;
}>;

/** Filesystem-issued, immutable-identity-bound candidate for transactional attachment. */
export type AssetPublicationCandidate = string & Readonly<{
  [assetPublicationCandidateBrand]: true;
}>;

export type PrivateFilesystemIdentity = Readonly<{
  deviceId: string;
  fileId: string;
  changeToken: string;
}>;

/** Private redemption result; relative path and filesystem identity never cross a public barrel. */
export type PrivateStorageDescriptor = Readonly<{
  relativePath: string;
  identity: PrivateFilesystemIdentity;
  contentHash: string;
  byteLength: number;
}>;

/** Durable cleanup authority persisted before a temporary asset is adopted. */
export type PrivatePublicationPreparation = Readonly<{
  deliveryRelativePath: string;
  cleanupDescriptors: readonly [PrivateStorageDescriptor, ...PrivateStorageDescriptor[]];
}>;

export type DurableFilesystemTransactionContext = object;
export type DurableFilesystemPurpose =
  | "asset_original"
  | "asset_derivative"
  | "portable_staging"
  | "portable_export";

export type DurableFilesystemScope =
  | (AssetScope & Readonly<{ resourceKind: "asset" }>)
  | (AssetOwnerScope & Readonly<{ resourceKind: "portable"; operationScopeId: string }>);

export type ReservedFilesystemOperation = DurableFilesystemScope & Readonly<{
  operationId: DurableFilesystemOperationId;
  purpose: DurableFilesystemPurpose;
  expiresAt: string;
  [reservedFilesystemOperationBrand]: true;
}>;

export type AttachedFilesystemOperation = DurableFilesystemScope & Readonly<{
  operationId: DurableFilesystemOperationId;
  purpose: DurableFilesystemPurpose;
  [attachedFilesystemOperationBrand]: true;
}>;

/**
 * Immutable adapter-private proof that one candidate belongs to one reserved
 * operation and one observed filesystem identity. Persisted adapters can
 * reconstruct this authority from hashed candidate evidence after restart.
 */
export type PrivateFilesystemCandidateAuthority = Readonly<{
  reservation: ReservedFilesystemOperation;
  candidate: AssetPublicationCandidate;
  descriptor: PrivateStorageDescriptor;
  expiresAt: string;
  [privateFilesystemCandidateAuthorityBrand]: true;
}>;

/** Opaque journal-issued authority fenced to one operation work version and lease. */
export type DurableFilesystemRecoveryClaim = Readonly<{
  operationId: DurableFilesystemOperationId;
  leaseId: string;
  leaseOwner: string;
  workVersion: number;
  leaseExpiresAt: string;
  [durableFilesystemRecoveryClaimBrand]: true;
}>;

export type DurableFilesystemReserveRequest = Readonly<{
  purpose: DurableFilesystemPurpose;
  leaseOwner: string;
  expiresAt: string;
}>;

export type DurableFilesystemReserveResult = Readonly<{
  operation: ReservedFilesystemOperation;
  claim: DurableFilesystemRecoveryClaim;
}>;

export type DurableFilesystemAttachResult =
  | Readonly<{
    outcome: "attached";
    operation: AttachedFilesystemOperation;
    claim: DurableFilesystemRecoveryClaim;
  }>
  | Readonly<{ outcome: "stale" | "candidate_mismatch" }>;

export type DurableFilesystemFinalizeResult = Readonly<{
  outcome: "finalized" | "already_finalized" | "stale" | "lease_lost";
}>;

export type DurableFilesystemCleanupRequest = Readonly<{
  cause: "rollback" | "recovery";
  diagnosticCode?: AssetFilesystemDiagnosticCode;
}>;

export type DurableFilesystemCleanupResult = Readonly<{
  outcome: "cleanup_pending" | "already_cleaned" | "stale" | "lease_lost";
}>;

export type DurableFilesystemCleanupCompletionResult = Readonly<{
  outcome: "cleaned" | "already_cleaned" | "stale" | "lease_lost";
}>;

export type DurableFilesystemRecoveryRequest = Readonly<{
  leaseOwner: string;
  leaseSeconds: number;
  limit: number;
}>;

export type DurableFilesystemRecoveryRecord =
  | Readonly<{
    action: "finalize";
    operation: AttachedFilesystemOperation;
    claim: DurableFilesystemRecoveryClaim;
  }>
  | Readonly<{
    action: "cleanup";
    operation: ReservedFilesystemOperation | AttachedFilesystemOperation;
    claim: DurableFilesystemRecoveryClaim;
  }>;

/**
 * Durable three-phase journal. Callers reserve before filesystem mutation,
 * attach the identity-bound candidate in their transaction, then finalize
 * only after commit. Rollback and restart recovery mark cleanup instead.
 */
export interface DurableFilesystemJournalPort {
  reserve(scope: DurableFilesystemScope, request: DurableFilesystemReserveRequest): Promise<DurableFilesystemReserveResult>;
  attach(
    database: DurableFilesystemTransactionContext,
    reservation: ReservedFilesystemOperation,
    candidate: AssetPublicationCandidate,
  ): Promise<DurableFilesystemAttachResult>;
  finalizeAfterCommit(
    operation: AttachedFilesystemOperation,
    claim: DurableFilesystemRecoveryClaim,
  ): Promise<DurableFilesystemFinalizeResult>;
  markCleanup(
    operation: ReservedFilesystemOperation | AttachedFilesystemOperation,
    claim: DurableFilesystemRecoveryClaim,
    request: DurableFilesystemCleanupRequest,
  ): Promise<DurableFilesystemCleanupResult>;
  completeCleanup(
    operation: ReservedFilesystemOperation | AttachedFilesystemOperation,
    claim: DurableFilesystemRecoveryClaim,
  ): Promise<DurableFilesystemCleanupCompletionResult>;
  recover(request: DurableFilesystemRecoveryRequest): Promise<readonly DurableFilesystemRecoveryRecord[]>;
}

export interface DurableFilesystemLifecycle extends DurableFilesystemJournalPort {}

export type PrivatePublicationCleanupPreparation =
  | Readonly<{ outcome: "cleanup_required"; descriptors: readonly PrivateStorageDescriptor[] }>
  | Readonly<{ outcome: "already_cleaned" | "stale" | "lease_lost" }>;

function nonBlank(value: string): boolean {
  return value.trim().length > 0;
}

function requireScope(scope: DurableFilesystemScope): void {
  if (!nonBlank(scope.ownerUserId)) throw new Error("filesystem_scope_invalid");
  if (scope.resourceKind === "asset" && !nonBlank(scope.assetId)) throw new Error("filesystem_scope_invalid");
  if (scope.resourceKind === "portable" && !nonBlank(scope.operationScopeId)) throw new Error("filesystem_scope_invalid");
}

function requireOperation(operation: ReservedFilesystemOperation | AttachedFilesystemOperation): void {
  requireScope(operation);
  if (!nonBlank(operation.operationId)) throw new Error("filesystem_operation_invalid");
}

function requireFutureTimestamp(value: string, diagnostic: string): void {
  const timestamp = Date.parse(value);
  if (!nonBlank(value) || !Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new Error(diagnostic);
  }
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

function snapshotScope<Operation extends ReservedFilesystemOperation | AttachedFilesystemOperation>(
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

/** Pure validation/binding; raw candidate persistence remains an adapter concern. */
export function bindPrivateFilesystemCandidateAuthority(
  reservation: ReservedFilesystemOperation,
  candidate: AssetPublicationCandidate,
  descriptor: PrivateStorageDescriptor,
): PrivateFilesystemCandidateAuthority {
  requireOperation(reservation);
  if (!nonBlank(candidate)) throw new Error("filesystem_candidate_invalid");
  requireDescriptor(descriptor);
  requireFutureTimestamp(reservation.expiresAt, "filesystem_operation_expired");
  return Object.freeze({
    reservation: snapshotScope(reservation),
    candidate,
    descriptor: snapshotDescriptor(descriptor),
    expiresAt: reservation.expiresAt
  }) as PrivateFilesystemCandidateAuthority;
}

function requireClaim(claim: DurableFilesystemRecoveryClaim): void {
  if (!nonBlank(claim.operationId)
    || !nonBlank(claim.leaseId)
    || !nonBlank(claim.leaseOwner)
    || !Number.isInteger(claim.workVersion)
    || claim.workVersion <= 0
    || !nonBlank(claim.leaseExpiresAt)
    || !Number.isFinite(Date.parse(claim.leaseExpiresAt))) {
    throw new Error("filesystem_recovery_claim_invalid");
  }
}

/** Pure validating use case; adapters own transactions, persistence, and filesystem work. */
export function createDurableFilesystemLifecycle(journal: DurableFilesystemJournalPort): DurableFilesystemLifecycle {
  return {
    reserve: async (scope, request) => {
      requireScope(scope);
      if (!nonBlank(request.leaseOwner)
        || !nonBlank(request.expiresAt)
        || !Number.isFinite(Date.parse(request.expiresAt))) {
        throw new Error("filesystem_operation_invalid");
      }
      return journal.reserve(scope, request);
    },
    attach: async (database, reservation, candidate) => {
      requireOperation(reservation);
      if (!nonBlank(candidate)) throw new Error("filesystem_candidate_invalid");
      const result = await journal.attach(database, reservation, candidate);
      return result.outcome === "attached"
        ? {
          outcome: result.outcome,
          operation: result.operation,
          claim: result.claim
        }
        : result;
    },
    finalizeAfterCommit: async (operation, claim) => {
      requireOperation(operation);
      requireClaim(claim);
      return journal.finalizeAfterCommit(operation, claim);
    },
    markCleanup: async (operation, claim, request) => {
      requireOperation(operation);
      requireClaim(claim);
      return journal.markCleanup(operation, claim, request);
    },
    completeCleanup: async (operation, claim) => {
      requireOperation(operation);
      requireClaim(claim);
      return journal.completeCleanup(operation, claim);
    },
    recover: async (request) => {
      if (!nonBlank(request.leaseOwner)
        || !Number.isInteger(request.leaseSeconds)
        || request.leaseSeconds <= 0
        || !Number.isInteger(request.limit)
        || request.limit <= 0) {
        throw new Error("filesystem_recovery_scope_invalid");
      }
      return journal.recover(request);
    }
  };
}
