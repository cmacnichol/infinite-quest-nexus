import type {
  AssetContentView,
  AssetLibraryQuery,
  AssetLibraryView,
  AssetMetadataBackfillClaim,
  AssetMetadataBackfillClaimRequest,
  AssetMetadataBackfillResult,
  AssetScope,
  AssetSelectionCommand,
  AssetSelectionView,
  AssetTransactionContext,
  TurnAssetScope,
  WorldAssetScope
} from "./types.js";
import type { AssetOwnerScope } from "./types.js";

/** Owner-scoped library reads and transport-safe content metadata. */
export interface AssetLibraryPort {
  listAssets(scope: AssetOwnerScope, query: AssetLibraryQuery): Promise<AssetLibraryView>;
  readAsset(scope: AssetScope): Promise<AssetContentView>;
}

/** Selection is separate from listing so each mutation carries its target scope and idempotency key. */
export interface AssetSelectionPort {
  selectTurnIllustration(scope: TurnAssetScope, command: AssetSelectionCommand): Promise<AssetSelectionView>;
  selectWorldCover(scope: WorldAssetScope, command: AssetSelectionCommand): Promise<AssetSelectionView>;
}

/** Caller-owned transaction binding for worker metadata persistence. */
export interface AssetMetadataBackfillPort {
  claimNextMetadataBackfill(request: AssetMetadataBackfillClaimRequest): Promise<AssetMetadataBackfillClaim | null>;
  backfillMetadata(
    database: AssetTransactionContext,
    claim: AssetMetadataBackfillClaim,
  ): Promise<AssetMetadataBackfillResult>;
}

export type AssetApplicationDependencies = Readonly<{
  library: AssetLibraryPort;
  selection: AssetSelectionPort;
  metadata: AssetMetadataBackfillPort;
}>;

export interface AssetApplication extends AssetLibraryPort, AssetSelectionPort, AssetMetadataBackfillPort {}
