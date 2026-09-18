import type { ModelParameterAdvertisement, SchemaVerification } from "@infinite-quest/contracts";
import { resolveResponseFormatEligibility, type ResponseFormatEligibilityInput } from "../../../packages/application/src/providers/response-format.js";
import { ProviderCapabilityCache, type ProviderCapabilityCacheKey } from "./provider-capability-cache.js";
import type { ProviderModelInventory } from "../../../packages/application/src/providers/types.js";

export type ProviderResponseFormatCapabilities = Readonly<{
  registryDigest: string;
  discover(key: ProviderCapabilityCacheKey, load: () => Promise<ModelParameterAdvertisement | null>, refresh?: boolean): Promise<ModelParameterAdvertisement | null>;
  discoverInventory(key: ProviderCapabilityCacheKey, load: () => Promise<ProviderModelInventory>, refresh?: boolean): Promise<ProviderModelInventory>;
  eligibility(input: Omit<ResponseFormatEligibilityInput, "verifications"> & Readonly<{ expectedRegistryDigest?: string }>): ReturnType<typeof resolveResponseFormatEligibility>;
  invalidate(providerProfileId: string): void;
}>;
export function createProviderResponseFormatCapabilities(options: Readonly<{ records?: readonly SchemaVerification[]; registryDigest?: string; now?: () => number; cache?: ProviderCapabilityCache<ModelParameterAdvertisement | null>; inventoryCache?: ProviderCapabilityCache<ProviderModelInventory> }> = {}): ProviderResponseFormatCapabilities {
  const cache = options.cache ?? new ProviderCapabilityCache<ModelParameterAdvertisement | null>(options.now ? { now: options.now } : {});
  const inventoryCache = options.inventoryCache ?? new ProviderCapabilityCache<ProviderModelInventory>(options.now ? { now: options.now } : {});
  const registryDigest = options.registryDigest ?? "";
  return Object.freeze({ registryDigest, discover: async (key, load, refresh) => {
    try { return await cache.load(key, load, refresh); } catch { return null; }
  }, discoverInventory: (key, load, refresh) => inventoryCache.load(key, load, refresh), invalidate: (id) => { cache.invalidate(id); inventoryCache.invalidate(id); }, eligibility: (input) => input.expectedRegistryDigest !== undefined && input.expectedRegistryDigest !== registryDigest ? { status: "unknown", reason: "discovery_unavailable", verification: null } : resolveResponseFormatEligibility({ ...input, verifications: options.records ?? [] }) });
}
