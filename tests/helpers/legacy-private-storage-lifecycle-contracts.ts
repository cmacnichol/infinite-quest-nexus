import type {
  AssetPublicationCandidate,
  AttachedFilesystemOperation,
  DurableFilesystemLifecycle,
  DurableFilesystemJournalPort,
  DurableFilesystemRecoveryClaim,
  DurableFilesystemScope,
  DurableFilesystemTransactionContext,
  PrivatePublicationCleanupPreparation,
  PrivatePublicationPreparation,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import type {
  ImportOwnerScope,
  PortableArchiveExportRetrieval,
  PortableStagedInput
} from "../../packages/application/src/imports/types.js";

declare const legacyDatabaseIssuedStorageLocatorBrand: unique symbol;

export type DatabaseIssuedStorageLocator = string & Readonly<{
  [legacyDatabaseIssuedStorageLocatorBrand]: true;
}>;

export type LegacyDurableFilesystemAttachResult =
  | Readonly<{
    outcome: "attached";
    operation: AttachedFilesystemOperation;
    locator: DatabaseIssuedStorageLocator;
    claim: DurableFilesystemRecoveryClaim;
  }>
  | Readonly<{ outcome: "stale" | "candidate_mismatch" }>;

export interface LegacyDurableFilesystemJournalPort
  extends Omit<DurableFilesystemJournalPort, "attach"> {
  attach(
    database: DurableFilesystemTransactionContext,
    reservation: ReservedFilesystemOperation,
    candidate: AssetPublicationCandidate,
  ): Promise<LegacyDurableFilesystemAttachResult>;
}

export interface LegacyDurableFilesystemLifecycle
  extends Omit<DurableFilesystemLifecycle, "attach"> {
  attach(
    database: DurableFilesystemTransactionContext,
    reservation: ReservedFilesystemOperation,
    candidate: AssetPublicationCandidate,
  ): Promise<LegacyDurableFilesystemAttachResult>;
}

export interface LegacyPrivateStorageLocatorRedemptionPort {
  redeemStorageLocator(
    scope: DurableFilesystemScope,
    locator: DatabaseIssuedStorageLocator,
  ): Promise<PrivateStorageDescriptor | null>;
}

export type LegacyPrivateCapabilityCleanupPreparation =
  | Readonly<{ outcome: "cleanup_required"; descriptor: PrivateStorageDescriptor }>
  | Readonly<{ outcome: "already_cleaned" | "stale" }>;

export type LegacyPrivateCapabilityCleanupCompletion = Readonly<{
  outcome: "cleaned" | "already_cleaned" | "stale";
}>;

/** Historical single-adapter contract retained only for regression fixtures. */
export interface LegacyPrivateFilesystemCapabilityPersistencePort
  extends LegacyPrivateStorageLocatorRedemptionPort {
  journal: LegacyDurableFilesystemJournalPort;
  issueStagedInput(owner: ImportOwnerScope, descriptor: PrivateStorageDescriptor): Promise<PortableStagedInput>;
  redeemStagedInput(owner: ImportOwnerScope, stagedInput: PortableStagedInput): Promise<PrivateStorageDescriptor | null>;
  beginStagedCleanup(
    owner: ImportOwnerScope,
    stagedInput: PortableStagedInput,
  ): Promise<LegacyPrivateCapabilityCleanupPreparation>;
  completeStagedCleanup(
    owner: ImportOwnerScope,
    stagedInput: PortableStagedInput,
  ): Promise<LegacyPrivateCapabilityCleanupCompletion>;
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
  ): Promise<LegacyPrivateCapabilityCleanupPreparation>;
  completeExportCleanup(
    owner: ImportOwnerScope,
    retrieval: PortableArchiveExportRetrieval,
  ): Promise<LegacyPrivateCapabilityCleanupCompletion>;
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
