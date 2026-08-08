import type {
  AssetDeliveryDescriptor,
  AssetDeliveryRequest,
  AssetScope
} from "./types.js";
import type { DatabaseIssuedStorageLocator } from "./private-storage-lifecycle.js";

declare const privateLegacyAnchoredReadCapabilityBrand: unique symbol;

/**
 * Opaque adapter-private handle to an already anchored legacy file. It grants
 * read-only access and deliberately carries no deletion authority or raw path.
 */
export type PrivateLegacyAnchoredReadCapability = Readonly<{
  cleanupAuthority: "none";
  [privateLegacyAnchoredReadCapabilityBrand]: true;
}>;

type PrivateFinalizedAssetDeliveryBase = Readonly<{
  scope: AssetScope;
  request: AssetDeliveryRequest;
  descriptor: AssetDeliveryDescriptor;
}>;

/**
 * Adapter-private delivery authority. Durable rows carry a finalized,
 * database-issued locator. Pre-0053 rows carry no locator, path, or cleanup
 * claim and can only use the retained legacy read fallback in the later
 * production adapter.
 */
export type PrivateFinalizedAssetDeliveryResolution =
  | (PrivateFinalizedAssetDeliveryBase & Readonly<{
    kind: "durable_finalized";
    locator: DatabaseIssuedStorageLocator;
    cleanupAuthority: "durable_journal_only";
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
}
