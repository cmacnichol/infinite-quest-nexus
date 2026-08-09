import type {
  PrivateAssetPublicationContextIntentInput,
  PrivateAssetPublicationReferencePolicyInput,
  PrivateAssetPublicationSourceRecordInput,
  PrivateNormalizedAssetFinalizationHandle,
  PrivateNormalizedAssetPublicationRequest,
  PrivateNormalizedAssetRequestChildBindingsInput,
  PrivateRequestedAssetLibrarySnapshotInput,
  SafeNormalizedAssetPublicationResult
} from "../assets/private-normalized-asset-publication.js";
import type { DurableFilesystemTransactionContext } from "../assets/private-storage-lifecycle.js";
import type { AssetMutationIdempotencyKey } from "../assets/types.js";

export type PrivatePortableNormalizedPublicationScope = Readonly<{
  operationId: string;
  ownerUserId: string;
  importKind: "campaign_zip" | "legacy_story";
  authorityFingerprint: string;
  commitIdempotencyKeyHash: string;
}>;

export type PrivatePortableNormalizedPublicationIntent = Readonly<{
  request: PrivateNormalizedAssetPublicationRequest;
}>;

export type PrivatePortableNormalizedRetirementReason =
  | "duplicate"
  | "abandoned"
  | "optional_unavailable";

export type PrivatePortableNormalizedAssetInput = Readonly<{
  idempotencyKey: AssetMutationIdempotencyKey;
  artifact: Readonly<{
    bytes: Uint8Array;
    declaredMimeType: string;
    byteLength: number;
    contentHash: string;
  }>;
  requestedLibrary: PrivateRequestedAssetLibrarySnapshotInput;
  sourceRecords: readonly PrivateAssetPublicationSourceRecordInput[];
  sourceInstallationId: string | null;
  contextIntents: readonly PrivateAssetPublicationContextIntentInput[];
  referencePolicy: PrivateAssetPublicationReferencePolicyInput;
}>;

export type PrivatePortableNormalizedAttachedPublication = Readonly<{
  assetOrdinal: number;
  result: SafeNormalizedAssetPublicationResult;
  finalization: PrivateNormalizedAssetFinalizationHandle;
}>;

export type PrivatePortableNormalizedPendingFinalization = Readonly<{
  operationId: string;
  ownerUserId: string;
  assetOrdinal: number;
  result: SafeNormalizedAssetPublicationResult;
  finalization: PrivateNormalizedAssetFinalizationHandle;
  publicationState: "committed_finalization_pending" | "published";
}>;

declare const privatePortableNormalizedReservationBrand: unique symbol;

/** Opaque process-local batch authority. Operation/request identity remains durable in PostgreSQL. */
export type PrivatePortableNormalizedReservationHandle = Readonly<{
  [privatePortableNormalizedReservationBrand]: true;
}>;

export type PrivatePortableNormalizedFinalizationOutcome =
  | Readonly<{ outcome: "noop" }>
  | Readonly<{
    outcome: "published";
    assets: readonly SafeNormalizedAssetPublicationResult[];
  }>
  | Readonly<{
    outcome: "committed_finalization_pending";
    diagnostic: "asset_publication_finalization_recoverable";
  }>;

export interface PrivatePortableNormalizedAssetPublicationCoordinator {
  reserve(input: Readonly<{
    scope: PrivatePortableNormalizedPublicationScope;
    assets: readonly PrivatePortableNormalizedAssetInput[];
    leaseOwner: string;
    expiresAt: string;
  }>): Promise<PrivatePortableNormalizedReservationHandle>;
  attachInTransaction<Result>(
    database: DurableFilesystemTransactionContext,
    reservation: PrivatePortableNormalizedReservationHandle,
    attachDomain: (
      results: readonly SafeNormalizedAssetPublicationResult[],
    ) => Promise<Readonly<{
      importId: string;
      childBindings: readonly PrivateNormalizedAssetRequestChildBindingsInput[];
      value: Result;
    }>>,
  ): Promise<Readonly<{
    value: Result;
    publications: readonly PrivatePortableNormalizedAttachedPublication[];
  }>>;
  beginRetirementInTransaction(
    database: DurableFilesystemTransactionContext,
    reservation: PrivatePortableNormalizedReservationHandle,
    reason: PrivatePortableNormalizedRetirementReason,
  ): Promise<void>;
  retireAbandonedOperationInTransaction(
    database: DurableFilesystemTransactionContext,
    input: Readonly<{ operationId: string; ownerUserId: string }>,
  ): Promise<void>;
  completeRetirement(reservation: PrivatePortableNormalizedReservationHandle): Promise<void>;
  discardAfterRollback(reservation: PrivatePortableNormalizedReservationHandle): Promise<void>;
  finalizeOperation(input: Readonly<{
    ownerUserId: string;
    operationId: string;
    leaseOwner: string;
    leaseSeconds: number;
  }>): Promise<PrivatePortableNormalizedFinalizationOutcome>;
  /** Private durable-recovery reconciliation; accepts only database-derived IDs. */
  reconcileRetirements(input: Readonly<{
    ownerUserId: string;
    operationId: string;
  }>): Promise<Readonly<{ retired: number; pending: number }>>;
  recoverCommitted(input: Readonly<{
    ownerUserId: string;
    previewToken: string;
    leaseOwner: string;
    leaseSeconds: number;
  }>): Promise<PrivatePortableNormalizedFinalizationOutcome>;
}
