import type { OwnerScope } from "../generation/types.js";

/** Trusted server or claimed-job scope; it is never browser-supplied authority. */
export type AssetOwnerScope = OwnerScope;
export type AssetScope = AssetOwnerScope & Readonly<{ assetId: string }>;
export type CampaignAssetScope = AssetOwnerScope & Readonly<{ campaignId: string; assetId: string }>;
export type TurnAssetScope = CampaignAssetScope & Readonly<{ turnId: string }>;
export type WorldAssetScope = AssetOwnerScope & Readonly<{ worldId: string; assetId: string }>;
export type WorldVersionAssetScope = WorldAssetScope & Readonly<{ worldVersionId: string }>;
export type TurnAssetSelectionScope = AssetOwnerScope & Readonly<{ campaignId: string; turnId: string }>;
export type WorldAssetSelectionScope = AssetOwnerScope & Readonly<{ worldId: string }>;

/** Opaque context supplied by the transaction owner; adapters must not open a nested transaction. */
export type AssetTransactionContext = object;

export type AssetIdempotencyKey = string & Readonly<{ readonly __assetIdempotencyKey: unique symbol }>;

export type AssetLibraryQuery = Readonly<{
  cursor?: string;
  limit?: number;
  campaignId?: string;
  worldId?: string;
  worldVersionId?: string;
}>;

/** This public projection deliberately has no storage driver, filesystem path, or caught error field. */
export type AssetLibraryItemView = Readonly<{
  assetId: string;
  url: string;
  thumbnailUrl: string | null;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  byteLength: number;
  campaignId: string | null;
  worldId: string | null;
  worldVersionId: string | null;
  title: string;
  createdAt: string;
}>;

export type AssetLibraryView = Readonly<{
  assets: readonly AssetLibraryItemView[];
  nextCursor: string | null;
  total: number;
}>;

export type AssetContentView = Readonly<{
  assetId: string;
  mimeType: AssetLibraryItemView["mimeType"];
  byteLength: number;
}>;

export type AssetSelectionCommand = Readonly<{
  /** `null` is an explicit authorized clear; omitted is invalid and must not clear a selection. */
  assetId: string | null;
  idempotencyKey: string;
}>;

export type AssetSelectionView = Readonly<{
  assetId: string | null;
  selected: boolean;
}>;

/** Owner-scoped metadata mutation; later adapters preserve its optimistic revision semantics. */
export type AssetMetadataUpdateCommand = Readonly<{
  expectedRevision: number;
  title?: string;
  caption?: string;
  notes?: string;
  tags?: readonly string[];
  reuseScope?: "private" | "campaign" | "world" | "owner_library" | "shared";
  automaticReuseEnabled?: boolean;
  reviewStatus?: "unreviewed" | "eligible" | "restricted" | "blocked";
  contentCategories?: readonly string[];
  favorite?: boolean;
  archived?: boolean;
  idempotencyKey: string;
}>;

export type AssetMetadataUpdateView = Readonly<{
  assetId: string;
  metadataRevision: number;
}>;

/** Safe delivery intent; neither variant includes a storage path, stream, or raw failure. */
export type AssetDeliveryRequest =
  | Readonly<{ kind: "original" }>
  | Readonly<{ kind: "derivative"; derivativeKind: "thumbnail" }>;

type AssetDeliveryDescriptorBase = Readonly<{
  assetId: string;
  mimeType: AssetLibraryItemView["mimeType"];
  byteLength: number;
  etag: string;
}>;

export type AssetDeliveryDescriptor =
  | (AssetDeliveryDescriptorBase & Readonly<{ kind: "original"; derivativeKind: null }>)
  | (AssetDeliveryDescriptorBase & Readonly<{ kind: "derivative"; derivativeKind: "thumbnail" }>);

/** The worker receives this only from a repository claim, never from an API payload. */
export type AssetMetadataBackfillClaim = AssetScope & Readonly<{
  leaseId: string;
  leaseExpiresAt: string;
}>;

export type AssetMetadataBackfillClaimRequest = Readonly<{
  workerId: string;
  leaseSeconds: number;
}>;

export type AssetMetadataBackfillResult = Readonly<{
  assetId: string;
  outcome: "updated" | "already_current" | "safe_failure";
  diagnosticCode?: AssetFilesystemDiagnosticCode;
}>;

/** Bounded categories may cross an application boundary; paths and raw errors may not. */
export type AssetFilesystemDiagnosticCode =
  | "asset_content_invalid"
  | "asset_hash_mismatch"
  | "asset_metadata_unavailable"
  | "asset_storage_unavailable"
  | "asset_unsupported_media"
  | "asset_too_large"
  | "filesystem_containment_denied"
  | "filesystem_link_denied"
  | "filesystem_path_invalid"
  | "filesystem_race_detected";
