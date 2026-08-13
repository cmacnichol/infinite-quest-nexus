import type {
  AssetListQuery,
  AssetOrigin,
  AssetReuseScope,
  AssetReviewStatus
} from "@infinite-quest/contracts";
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

declare const assetMutationIdempotencyKeyBrand: unique symbol;

/**
 * API transports bind this value from the caller's `Idempotency-Key` header.
 * Correlation/request IDs and deterministic target-derived values are not
 * durable mutation keys and must never be substituted by an adapter.
 */
export type AssetMutationIdempotencyKey = string & Readonly<{
  [assetMutationIdempotencyKeyBrand]: true;
}>;

/** Lower-case form used by Node/Fastify request header maps. */
export const ASSET_MUTATION_IDEMPOTENCY_HEADER = "idempotency-key" as const;

/** @deprecated Use AssetMutationIdempotencyKey for durable mutation ingress. */
export type AssetIdempotencyKey = AssetMutationIdempotencyKey;

/** Exact validated `/api/v1/assets` and `/api/v1/assets/facets` query surface. */
export type AssetLibraryQuery = Readonly<AssetListQuery>;

/** This public projection deliberately has no storage driver, filesystem path, or caught error field. */
export type AssetLibraryItemView = Readonly<{
  assetId: string;
  id: string;
  url: string;
  thumbnailUrl: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  byteLength: number;
  width: number | null;
  height: number | null;
  createdAt: string;
  campaignId: string | null;
  turnId: string | null;
  title: string;
  caption: string;
  alt: string;
  tags: readonly string[];
  origin: AssetOrigin;
  reuseScope: AssetReuseScope;
  automaticReuseEnabled: boolean;
  reviewStatus: AssetReviewStatus;
  contentCategories: readonly string[];
  favorite: boolean;
  archived: boolean;
  metadataRevision: number;
  provider: string | null;
  model: string | null;
  worldId: string | null;
  worldVersionId: string | null;
  usageCount: number;
}>;

export type AssetLibraryFacetsView = Readonly<{
  origin: Readonly<Record<string, number>>;
  reviewStatus: Readonly<Record<string, number>>;
  reuseScope: Readonly<Record<string, number>>;
  tags: Readonly<Record<string, number>>;
}>;

export type AssetLibraryView = Readonly<{
  assets: readonly AssetLibraryItemView[];
  nextCursor: string | null;
  total: number;
  facets: AssetLibraryFacetsView;
}>;

export type AssetContentView = Readonly<{
  assetId: string;
  mimeType: AssetLibraryItemView["mimeType"];
  byteLength: number;
}>;

export type AssetSelectionCommand = Readonly<{
  /** `null` is an explicit authorized clear; omitted is invalid and must not clear a selection. */
  assetId: string | null;
  idempotencyKey: AssetMutationIdempotencyKey;
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
  idempotencyKey: AssetMutationIdempotencyKey;
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
  leaseOwner: string;
  workVersion: number;
  leaseExpiresAt: string;
}>;

export type AssetMetadataBackfillClaimRequest = Readonly<{
  workerId: string;
  leaseSeconds: number;
}>;

export type AssetMetadataBackfillHeartbeatRequest = Readonly<{
  leaseSeconds: number;
}>;

export type AssetMetadataBackfillHeartbeatResult =
  | Readonly<{ outcome: "renewed"; claim: AssetMetadataBackfillClaim }>
  | Readonly<{ outcome: "stale" | "lease_lost" }>;

export type AssetMetadataBackfillRequeueRequest = Readonly<{
  diagnosticCode?: AssetFilesystemDiagnosticCode;
}>;

export type AssetMetadataBackfillRequeueResult = Readonly<{
  outcome: "requeued" | "stale" | "lease_lost";
}>;

export type AssetMetadataBackfillResult = Readonly<{
  assetId: string;
  outcome: "updated" | "already_current" | "safe_failure" | "stale" | "lease_lost";
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

export function toAssetMutationIdempotencyKey(value: string): AssetMutationIdempotencyKey {
  if (value.length < 1 || value.length > 200 || !/^[!-~]+$/u.test(value)) {
    throw new Error("asset_idempotency_key_invalid");
  }
  return value as AssetMutationIdempotencyKey;
}
