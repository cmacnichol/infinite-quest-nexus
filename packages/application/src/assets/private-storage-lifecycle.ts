import type { AssetFilesystemDiagnosticCode, AssetOwnerScope, AssetScope } from "./types.js";

declare const durableFilesystemOperationIdBrand: unique symbol;
declare const databaseIssuedStorageLocatorBrand: unique symbol;
declare const assetPublicationCandidateBrand: unique symbol;
declare const reservedFilesystemOperationBrand: unique symbol;
declare const attachedFilesystemOperationBrand: unique symbol;

export type DurableFilesystemOperationId = string & Readonly<{
  [durableFilesystemOperationIdBrand]: true;
}>;

/** Database-issued and adapter-private; public asset delivery never receives it. */
export type DatabaseIssuedStorageLocator = string & Readonly<{
  [databaseIssuedStorageLocatorBrand]: true;
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

export type DurableFilesystemReserveRequest = Readonly<{
  purpose: DurableFilesystemPurpose;
  expiresAt: string;
}>;

export type DurableFilesystemAttachResult =
  | Readonly<{
    outcome: "attached";
    operation: AttachedFilesystemOperation;
    locator: DatabaseIssuedStorageLocator;
  }>
  | Readonly<{ outcome: "stale" | "candidate_mismatch" }>;

export type DurableFilesystemFinalizeResult = Readonly<{
  outcome: "finalized" | "already_finalized" | "stale";
}>;

export type DurableFilesystemCleanupRequest = Readonly<{
  cause: "rollback" | "recovery";
  diagnosticCode?: AssetFilesystemDiagnosticCode;
}>;

export type DurableFilesystemCleanupResult = Readonly<{
  outcome: "cleanup_pending" | "already_cleaned" | "stale";
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
  }>
  | Readonly<{
    action: "cleanup";
    operation: ReservedFilesystemOperation | AttachedFilesystemOperation;
  }>;

/** Private secure-storage seam for redeeming database authority into immutable file identity. */
export interface PrivateStorageLocatorRedemptionPort {
  redeemStorageLocator(
    scope: DurableFilesystemScope,
    locator: DatabaseIssuedStorageLocator,
  ): Promise<PrivateStorageDescriptor | null>;
}

/**
 * Durable three-phase journal. Callers reserve before filesystem mutation,
 * attach the identity-bound candidate in their transaction, then finalize
 * only after commit. Rollback and restart recovery mark cleanup instead.
 */
export interface DurableFilesystemJournalPort {
  reserve(scope: DurableFilesystemScope, request: DurableFilesystemReserveRequest): Promise<ReservedFilesystemOperation>;
  attach(
    database: DurableFilesystemTransactionContext,
    reservation: ReservedFilesystemOperation,
    candidate: AssetPublicationCandidate,
  ): Promise<DurableFilesystemAttachResult>;
  finalizeAfterCommit(operation: AttachedFilesystemOperation): Promise<DurableFilesystemFinalizeResult>;
  markCleanup(
    operation: ReservedFilesystemOperation | AttachedFilesystemOperation,
    request: DurableFilesystemCleanupRequest,
  ): Promise<DurableFilesystemCleanupResult>;
  recover(request: DurableFilesystemRecoveryRequest): Promise<readonly DurableFilesystemRecoveryRecord[]>;
}

export interface DurableFilesystemLifecycle extends DurableFilesystemJournalPort {}

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

/** Pure validating use case; adapters own transactions, persistence, and filesystem work. */
export function createDurableFilesystemLifecycle(journal: DurableFilesystemJournalPort): DurableFilesystemLifecycle {
  return {
    reserve: async (scope, request) => {
      requireScope(scope);
      if (!nonBlank(request.expiresAt) || !Number.isFinite(Date.parse(request.expiresAt))) {
        throw new Error("filesystem_operation_invalid");
      }
      return journal.reserve(scope, request);
    },
    attach: async (database, reservation, candidate) => {
      requireOperation(reservation);
      if (!nonBlank(candidate)) throw new Error("filesystem_candidate_invalid");
      return journal.attach(database, reservation, candidate);
    },
    finalizeAfterCommit: async (operation) => {
      requireOperation(operation);
      return journal.finalizeAfterCommit(operation);
    },
    markCleanup: async (operation, request) => {
      requireOperation(operation);
      return journal.markCleanup(operation, request);
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
