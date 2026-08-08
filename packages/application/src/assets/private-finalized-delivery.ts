import type {
  AssetDeliveryDescriptor,
  AssetDeliveryRequest,
  AssetScope
} from "./types.js";
import type { DatabaseIssuedStorageLocator } from "./private-storage-lifecycle.js";

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
    cleanupAuthority: "none";
  }>);

export interface FinalizedAssetDeliveryResolverPort {
  resolveFinalizedAssetDelivery(
    scope: AssetScope,
    request: AssetDeliveryRequest,
  ): Promise<PrivateFinalizedAssetDeliveryResolution | null>;
}
