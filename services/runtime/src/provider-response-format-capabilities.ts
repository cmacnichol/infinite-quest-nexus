import type { ModelParameterAdvertisement, SchemaVerification } from "@infinite-quest/contracts";
import { resolveResponseFormatEligibility, type ResponseFormatEligibilityInput } from "../../../packages/application/src/providers/response-format.js";
import { ProviderCapabilityCache, type ProviderCapabilityCacheKey } from "./provider-capability-cache.js";
import type { ProviderModelInventory } from "../../../packages/application/src/providers/types.js";
import { sha256, stableStringify } from "../../../packages/domain/src/text.js";

export type ProviderResponseFormatCapabilities = Readonly<{
  registryDigest: string;
  now(): string;
  discover(key: ProviderCapabilityCacheKey, load: () => Promise<ModelParameterAdvertisement | null>, refresh?: boolean): Promise<ModelParameterAdvertisement | null>;
  discoverInventory(key: ProviderCapabilityCacheKey, load: () => Promise<ProviderModelInventory>, refresh?: boolean): Promise<ProviderModelInventory>;
  eligibility(input: Omit<ResponseFormatEligibilityInput, "verifications"> & Readonly<{ expectedRegistryDigest?: string }>): ReturnType<typeof resolveResponseFormatEligibility>;
  invalidate(providerProfileId: string): void;
  transactionLocal(): ProviderResponseFormatCapabilities;
}>;
export function createProviderResponseFormatCapabilities(options: Readonly<{ records?: readonly SchemaVerification[]; registryDigest?: string; now?: () => number; cache?: ProviderCapabilityCache<ModelParameterAdvertisement | null>; inventoryCache?: ProviderCapabilityCache<ProviderModelInventory> }> = {}): ProviderResponseFormatCapabilities {
  const cache = options.cache ?? new ProviderCapabilityCache<ModelParameterAdvertisement | null>(options.now ? { now: options.now } : {});
  const inventoryCache = options.inventoryCache ?? new ProviderCapabilityCache<ProviderModelInventory>(options.now ? { now: options.now } : {});
  const records = options.records ?? [];
  // The file loader uses SHA-256 of zero bytes for an absent registry.  Direct
  // composition must carry that same valid identity; non-empty injected
  // records receive a deterministic identity unless an explicit file digest
  // was supplied.
  const registryDigest = options.registryDigest ?? (records.length === 0 ? sha256("") : sha256(stableStringify(records)));
  const now = () => new Date((options.now ?? Date.now)()).toISOString();
  return Object.freeze({ registryDigest, now, discover: async (key, load, refresh) => {
    try { return await cache.load(key, load, refresh); } catch { return null; }
  }, discoverInventory: (key, load, refresh) => inventoryCache.load(key, load, refresh), invalidate: (id) => { cache.invalidate(id); inventoryCache.invalidate(id); }, transactionLocal: () => createProviderResponseFormatCapabilities({
    records,
    registryDigest,
    ...(options.now ? { now: options.now } : {})
  }), eligibility: (input) => input.expectedRegistryDigest !== undefined && input.expectedRegistryDigest !== registryDigest ? { status: "unknown", reason: "discovery_unavailable", verification: null } : resolveResponseFormatEligibility({ ...input, verifications: records }) });
}
