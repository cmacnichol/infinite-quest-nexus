import type { AssetFilesystemDiagnosticCode, AssetOwnerScope, AssetScope } from "./types.js";
import type {
  ImportOwnerScope,
  PortableArchiveExportRetrieval,
  PortableStagedInput
} from "../imports/types.js";

declare const durableFilesystemOperationIdBrand: unique symbol;
declare const databaseIssuedStorageLocatorBrand: unique symbol;
declare const assetPublicationCandidateBrand: unique symbol;
declare const reservedFilesystemOperationBrand: unique symbol;
declare const attachedFilesystemOperationBrand: unique symbol;
declare const durableFilesystemRecoveryClaimBrand: unique symbol;

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
    locator: DatabaseIssuedStorageLocator;
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

export type PrivateCapabilityCleanupPreparation =
  | Readonly<{ outcome: "cleanup_required"; descriptor: PrivateStorageDescriptor }>
  | Readonly<{ outcome: "already_cleaned" | "stale" }>;

export type PrivatePublicationCleanupPreparation =
  | Readonly<{ outcome: "cleanup_required"; descriptors: readonly PrivateStorageDescriptor[] }>
  | Readonly<{ outcome: "already_cleaned" | "stale" | "lease_lost" }>;

export type PrivateCapabilityCleanupCompletion = Readonly<{
  outcome: "cleaned" | "already_cleaned" | "stale";
}>;

/**
 * Adapter-private persistence boundary. A database implementation issues the
 * opaque handles and persists only their hashes together with owner, purpose,
 * lifecycle, immutable identity, content hash, and byte length.
 */
export interface PrivateFilesystemCapabilityPersistencePort extends PrivateStorageLocatorRedemptionPort {
  journal: DurableFilesystemJournalPort;
  issueStagedInput(owner: ImportOwnerScope, descriptor: PrivateStorageDescriptor): Promise<PortableStagedInput>;
  redeemStagedInput(owner: ImportOwnerScope, stagedInput: PortableStagedInput): Promise<PrivateStorageDescriptor | null>;
  beginStagedCleanup(
    owner: ImportOwnerScope,
    stagedInput: PortableStagedInput,
  ): Promise<PrivateCapabilityCleanupPreparation>;
  completeStagedCleanup(
    owner: ImportOwnerScope,
    stagedInput: PortableStagedInput,
  ): Promise<PrivateCapabilityCleanupCompletion>;
  issueExportRetrieval(
    owner: ImportOwnerScope,
    descriptor: PrivateStorageDescriptor,
  ): Promise<PortableArchiveExportRetrieval>;
  redeemExportRetrieval(
    owner: ImportOwnerScope,
    retrieval: PortableArchiveExportRetrieval,
  ): Promise<PrivateStorageDescriptor | null>;
  beginExportCleanup(
    owner: ImportOwnerScope,
    retrieval: PortableArchiveExportRetrieval,
  ): Promise<PrivateCapabilityCleanupPreparation>;
  completeExportCleanup(
    owner: ImportOwnerScope,
    retrieval: PortableArchiveExportRetrieval,
  ): Promise<PrivateCapabilityCleanupCompletion>;
  issuePublicationCandidate(
    reservation: ReservedFilesystemOperation,
    preparation: PrivatePublicationPreparation,
  ): Promise<AssetPublicationCandidate>;
  completePublicationCandidate(
    reservation: ReservedFilesystemOperation,
    candidate: AssetPublicationCandidate,
    descriptor: PrivateStorageDescriptor,
  ): Promise<void>;
  preparePublicationCleanup(
    operation: ReservedFilesystemOperation | AttachedFilesystemOperation,
    claim: DurableFilesystemRecoveryClaim,
  ): Promise<PrivatePublicationCleanupPreparation>;
}

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
      return journal.attach(database, reservation, candidate);
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
