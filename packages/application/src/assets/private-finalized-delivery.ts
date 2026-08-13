import type {
  AssetDeliveryDescriptor,
  AssetDeliveryRequest,
  AssetScope
} from "./types.js";
import type { PrivateStorageDescriptor } from "./private-storage-lifecycle.js";

declare const privateFinalizedAssetDeliveryGrantBrand: unique symbol;
declare const privateLegacyAnchoredReadCapabilityBrand: unique symbol;

/** Opaque, one-time bearer for an exact finalized asset delivery row. */
export type PrivateFinalizedAssetDeliveryGrant = string & Readonly<{
  [privateFinalizedAssetDeliveryGrantBrand]: true;
}>;

/**
 * Opaque adapter-private handle to one exact legacy-null asset row snapshot.
 * The database stores only its hash and redemption grants no cleanup authority.
 */
export type PrivateLegacyAnchoredReadCapability = string & Readonly<{
  [privateLegacyAnchoredReadCapabilityBrand]: true;
}>;

/** Read-only legacy row snapshot; b4 performs the bounded secure open. */
export type PrivateLegacyReadDescriptor = Readonly<{
  relativePath: string;
  contentHash: string;
  byteLength: number;
}>;

type PrivateFinalizedAssetDeliveryBase = Readonly<{
  scope: AssetScope;
  request: AssetDeliveryRequest;
  descriptor: AssetDeliveryDescriptor;
}>;

/**
 * Adapter-private delivery authority. Both variants carry only an opaque,
 * one-time bearer and the safe HTTP descriptor. Paths and filesystem identity
 * appear only after private redemption by the later storage adapter.
 */
export type PrivateFinalizedAssetDeliveryResolution =
  | (PrivateFinalizedAssetDeliveryBase & Readonly<{
    kind: "durable_finalized";
    grant: PrivateFinalizedAssetDeliveryGrant;
    cleanupAuthority: "none";
  }>)
  | (PrivateFinalizedAssetDeliveryBase & Readonly<{
    kind: "legacy_retained";
    anchoredRead: PrivateLegacyAnchoredReadCapability;
    cleanupAuthority: "none";
  }>);

export interface FinalizedAssetDeliveryResolverPort {
  resolveFinalizedAssetDelivery(
    scope: AssetScope,
    request: AssetDeliveryRequest,
  ): Promise<PrivateFinalizedAssetDeliveryResolution | null>;
  redeemFinalizedDeliveryGrant(
    scope: AssetScope,
    request: AssetDeliveryRequest,
    grant: PrivateFinalizedAssetDeliveryGrant,
  ): Promise<PrivateStorageDescriptor | null>;
  redeemLegacyAnchoredRead(
    scope: AssetScope,
    request: AssetDeliveryRequest,
    capability: PrivateLegacyAnchoredReadCapability,
  ): Promise<PrivateLegacyReadDescriptor | null>;
}
