import type {
  AttachedFilesystemOperation,
  DurableFilesystemCleanupCompletionResult,
  DurableFilesystemRecoveryClaim,
  DurableFilesystemTransactionContext,
  PrivateStorageDescriptor
} from "../assets/private-storage-lifecycle.js";
import type { PortableExportScope } from "./private-portable-authority.js";
import type {
  ImportOwnerScope,
  PortableArchiveExportRetrieval,
  PortableStagedInput
} from "./types.js";

declare const privatePortableStagedRehydrationBrand: unique symbol;
declare const privatePortableExportRehydrationBrand: unique symbol;
declare const privatePortableStagedCleanupPreparationBrand: unique symbol;
declare const privatePortableExportCleanupPreparationBrand: unique symbol;

export type PrivatePortableClaimRequest = Readonly<{
  leaseOwner: string;
  leaseSeconds: number;
}>;

export type PrivatePortableStagedIdentity = Readonly<{
  ownerUserId: string;
  stagedInput: PortableStagedInput;
}>;

export type PrivatePortableExportIdentity = Readonly<{
  exportScope: PortableExportScope;
  retrieval: PortableArchiveExportRetrieval;
}>;

export type PrivatePortableStagedRehydration = Readonly<{
  identity: PrivatePortableStagedIdentity;
  operation: AttachedFilesystemOperation;
  claim: DurableFilesystemRecoveryClaim;
  descriptor: PrivateStorageDescriptor;
  [privatePortableStagedRehydrationBrand]: true;
}>;

export type PrivatePortableExportRehydration = Readonly<{
  identity: PrivatePortableExportIdentity;
  operation: AttachedFilesystemOperation;
  claim: DurableFilesystemRecoveryClaim;
  descriptor: PrivateStorageDescriptor;
  [privatePortableExportRehydrationBrand]: true;
}>;

export type PrivatePortableStagedCleanupPreparation = Readonly<{
  identity: PrivatePortableStagedIdentity;
  operation: AttachedFilesystemOperation;
  claim: DurableFilesystemRecoveryClaim;
  descriptors: readonly [PrivateStorageDescriptor, ...PrivateStorageDescriptor[]];
  [privatePortableStagedCleanupPreparationBrand]: true;
}>;

export type PrivatePortableExportCleanupPreparation = Readonly<{
  identity: PrivatePortableExportIdentity;
  operation: AttachedFilesystemOperation;
  claim: DurableFilesystemRecoveryClaim;
  descriptors: readonly [PrivateStorageDescriptor, ...PrivateStorageDescriptor[]];
  [privatePortableExportCleanupPreparationBrand]: true;
}>;

export interface PrivatePortableRepositoryPort {
  rehydrateStagedInput(
    owner: ImportOwnerScope,
    stagedInput: PortableStagedInput,
    request: PrivatePortableClaimRequest,
  ): Promise<PrivatePortableStagedRehydration | null>;
  prepareStagedCleanup(
    rehydration: PrivatePortableStagedRehydration,
  ): Promise<PrivatePortableStagedCleanupPreparation>;
  acknowledgeStagedCleanup(
    database: DurableFilesystemTransactionContext,
    preparation: PrivatePortableStagedCleanupPreparation,
  ): Promise<DurableFilesystemCleanupCompletionResult>;
  rehydrateExportArtifact(
    scope: PortableExportScope,
    retrieval: PortableArchiveExportRetrieval,
    request: PrivatePortableClaimRequest,
  ): Promise<PrivatePortableExportRehydration | null>;
  prepareExportCleanup(
    rehydration: PrivatePortableExportRehydration,
  ): Promise<PrivatePortableExportCleanupPreparation>;
  acknowledgeExportCleanup(
    database: DurableFilesystemTransactionContext,
    preparation: PrivatePortableExportCleanupPreparation,
  ): Promise<DurableFilesystemCleanupCompletionResult>;
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

function requireOperation(
  operation: AttachedFilesystemOperation,
  ownerUserId: string,
  purpose: "portable_staging" | "portable_export",
): void {
  if (operation.resourceKind !== "portable"
    || operation.ownerUserId !== ownerUserId
    || operation.purpose !== purpose
    || !nonBlank(operation.operationId)
    || !nonBlank(operation.operationScopeId)) {
    throw new Error("filesystem_scope_invalid");
  }
}

function requireFreshClaim(
  operation: AttachedFilesystemOperation,
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

function requireExportScope(scope: PortableExportScope): void {
  const baseIsInvalid = !nonBlank(scope.ownerUserId)
    || !nonBlank(scope.worldId)
    || !nonBlank(scope.worldVersionId);
  const kindIsInvalid = !["campaign_zip", "world_json"].includes(scope.exportKind)
    || (scope.exportKind === "campaign_zip" && (scope.campaignId === null || !nonBlank(scope.campaignId)))
    || (scope.exportKind === "world_json" && scope.campaignId !== null);
  if (baseIsInvalid || kindIsInvalid) throw new Error("portable_export_scope_invalid");
}

function snapshotOperation(operation: AttachedFilesystemOperation): AttachedFilesystemOperation {
  if (operation.resourceKind !== "portable") throw new Error("filesystem_scope_invalid");
  return Object.freeze({
    resourceKind: "portable" as const,
    ownerUserId: operation.ownerUserId,
    operationScopeId: operation.operationScopeId,
    operationId: operation.operationId,
    purpose: operation.purpose
  }) as AttachedFilesystemOperation;
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

function snapshotDescriptor(descriptor: PrivateStorageDescriptor): PrivateStorageDescriptor {
  requireDescriptor(descriptor);
  return Object.freeze({
    relativePath: descriptor.relativePath,
    identity: Object.freeze({ ...descriptor.identity }),
    contentHash: descriptor.contentHash,
    byteLength: descriptor.byteLength
  });
}

function snapshotDescriptors(
  descriptors: readonly [PrivateStorageDescriptor, ...PrivateStorageDescriptor[]],
): readonly [PrivateStorageDescriptor, ...PrivateStorageDescriptor[]] {
  return Object.freeze(descriptors.map(snapshotDescriptor)) as unknown as readonly [
    PrivateStorageDescriptor,
    ...PrivateStorageDescriptor[]
  ];
}

export function bindPrivatePortableStagedRehydration(
  identity: PrivatePortableStagedIdentity,
  operation: AttachedFilesystemOperation,
  claim: DurableFilesystemRecoveryClaim,
  descriptor: PrivateStorageDescriptor,
): PrivatePortableStagedRehydration {
  if (!nonBlank(identity.ownerUserId) || !nonBlank(identity.stagedInput)) {
    throw new Error("portable_staged_identity_invalid");
  }
  requireOperation(operation, identity.ownerUserId, "portable_staging");
  requireFreshClaim(operation, claim);
  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    operation: snapshotOperation(operation),
    claim: snapshotClaim(claim),
    descriptor: snapshotDescriptor(descriptor)
  }) as PrivatePortableStagedRehydration;
}

export function bindPrivatePortableExportRehydration(
  identity: PrivatePortableExportIdentity,
  operation: AttachedFilesystemOperation,
  claim: DurableFilesystemRecoveryClaim,
  descriptor: PrivateStorageDescriptor,
): PrivatePortableExportRehydration {
  requireExportScope(identity.exportScope);
  if (!nonBlank(identity.retrieval)) throw new Error("portable_export_identity_invalid");
  requireOperation(operation, identity.exportScope.ownerUserId, "portable_export");
  requireFreshClaim(operation, claim);
  return Object.freeze({
    identity: Object.freeze({
      exportScope: Object.freeze({ ...identity.exportScope }),
      retrieval: identity.retrieval
    }),
    operation: snapshotOperation(operation),
    claim: snapshotClaim(claim),
    descriptor: snapshotDescriptor(descriptor)
  }) as PrivatePortableExportRehydration;
}

export function bindPrivatePortableStagedCleanupPreparation(
  rehydration: PrivatePortableStagedRehydration,
  descriptors: readonly [PrivateStorageDescriptor, ...PrivateStorageDescriptor[]],
): PrivatePortableStagedCleanupPreparation {
  requireOperation(rehydration.operation, rehydration.identity.ownerUserId, "portable_staging");
  requireFreshClaim(rehydration.operation, rehydration.claim);
  return Object.freeze({
    identity: Object.freeze({ ...rehydration.identity }),
    operation: snapshotOperation(rehydration.operation),
    claim: snapshotClaim(rehydration.claim),
    descriptors: snapshotDescriptors(descriptors)
  }) as PrivatePortableStagedCleanupPreparation;
}

export function bindPrivatePortableExportCleanupPreparation(
  rehydration: PrivatePortableExportRehydration,
  descriptors: readonly [PrivateStorageDescriptor, ...PrivateStorageDescriptor[]],
): PrivatePortableExportCleanupPreparation {
  requireExportScope(rehydration.identity.exportScope);
  requireOperation(rehydration.operation, rehydration.identity.exportScope.ownerUserId, "portable_export");
  requireFreshClaim(rehydration.operation, rehydration.claim);
  return Object.freeze({
    identity: Object.freeze({
      exportScope: Object.freeze({ ...rehydration.identity.exportScope }),
      retrieval: rehydration.identity.retrieval
    }),
    operation: snapshotOperation(rehydration.operation),
    claim: snapshotClaim(rehydration.claim),
    descriptors: snapshotDescriptors(descriptors)
  }) as PrivatePortableExportCleanupPreparation;
}
