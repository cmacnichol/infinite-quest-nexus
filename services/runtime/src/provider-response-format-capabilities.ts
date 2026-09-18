import type { ModelParameterAdvertisement, SchemaVerification } from "@infinite-quest/contracts";
import { resolveResponseFormatEligibility, type ResponseFormatEligibilityInput } from "../../../packages/application/src/providers/response-format.js";
import { ProviderCapabilityCache, type ProviderCapabilityCacheKey } from "./provider-capability-cache.js";

export type ProviderResponseFormatCapabilities = Readonly<{
  registryDigest: string;
  discover(key: ProviderCapabilityCacheKey, load: () => Promise<ModelParameterAdvertisement | null>, refresh?: boolean): Promise<ModelParameterAdvertisement | null>;
  eligibility(input: Omit<ResponseFormatEligibilityInput, "verifications"> & Readonly<{ expectedRegistryDigest?: string }>): ReturnType<typeof resolveResponseFormatEligibility>;
  invalidate(providerProfileId: string): void;
}>;
export function createProviderResponseFormatCapabilities(options: Readonly<{ records?: readonly SchemaVerification[]; registryDigest?: string; now?: () => number; cache?: ProviderCapabilityCache }> = {}): ProviderResponseFormatCapabilities {
  const cache = options.cache ?? new ProviderCapabilityCache({ now: options.now });
  const registryDigest = options.registryDigest ?? "";
  return Object.freeze({ registryDigest, discover: (key, load, refresh) => cache.load(key, load, refresh), invalidate: (id) => cache.invalidate(id), eligibility: (input) => input.expectedRegistryDigest !== undefined && input.expectedRegistryDigest !== registryDigest ? { status: "unknown", reason: "discovery_unavailable", verification: null } : resolveResponseFormatEligibility({ ...input, verifications: options.records ?? [] }) });
}
