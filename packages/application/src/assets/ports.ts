import type {
  AssetContentView,
  AssetDeliveryDescriptor,
  AssetDeliveryRequest,
  AssetLibraryQuery,
  AssetLibraryView,
  AssetMetadataBackfillClaim,
  AssetMetadataBackfillClaimRequest,
  AssetMetadataBackfillResult,
  AssetMetadataUpdateCommand,
  AssetMetadataUpdateView,
  AssetScope,
  AssetSelectionCommand,
  AssetSelectionView,
  AssetTransactionContext,
  TurnAssetSelectionScope,
  WorldAssetSelectionScope
} from "./types.js";
import type { AssetOwnerScope } from "./types.js";

/** Owner-scoped library reads and transport-safe content metadata. */
export interface AssetLibraryPort {
  listAssets(scope: AssetOwnerScope, query: AssetLibraryQuery): Promise<AssetLibraryView>;
  readAsset(scope: AssetScope): Promise<AssetContentView>;
}

/** Selection is separate from listing so each mutation carries its target scope and idempotency key. */
export interface AssetSelectionPort {
  selectTurnIllustration(scope: TurnAssetSelectionScope, command: AssetSelectionCommand): Promise<AssetSelectionView>;
  selectWorldCover(scope: WorldAssetSelectionScope, command: AssetSelectionCommand): Promise<AssetSelectionView>;
}

/** Owner-scoped metadata changes plus caller-owned transaction binding for worker metadata persistence. */
export interface AssetMetadataBackfillPort {
  updateAssetMetadata(scope: AssetScope, command: AssetMetadataUpdateCommand): Promise<AssetMetadataUpdateView>;
  claimNextMetadataBackfill(request: AssetMetadataBackfillClaimRequest): Promise<AssetMetadataBackfillClaim | null>;
  backfillMetadata(
    database: AssetTransactionContext,
    claim: AssetMetadataBackfillClaim,
  ): Promise<AssetMetadataBackfillResult>;
}

/** Describes a safe original or derivative response without exposing storage implementation details. */
export interface AssetDeliveryPort {
  describeAssetDelivery(scope: AssetScope, request: AssetDeliveryRequest): Promise<AssetDeliveryDescriptor>;
}

export type AssetApplicationDependencies = Readonly<{
  library: AssetLibraryPort;
  selection: AssetSelectionPort;
  metadata: AssetMetadataBackfillPort;
  delivery: AssetDeliveryPort;
}>;

export interface AssetApplication extends AssetLibraryPort, AssetSelectionPort, AssetMetadataBackfillPort, AssetDeliveryPort {}
