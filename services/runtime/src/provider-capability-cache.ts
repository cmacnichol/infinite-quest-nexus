import type { ModelParameterAdvertisement } from "@infinite-quest/contracts";

export type ProviderCapabilityCacheKey = Readonly<{ ownerUserId: string; providerProfileId: string; providerType: string; endpointIdentity: string; model: string; routeConfigHash: string; adapterProtocol: string }>;
type CacheEntry = Readonly<{ loadedAt: number; value: ModelParameterAdvertisement | null }>;
const DAY_MS = 86_400_000;
export class ProviderCapabilityCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<ModelParameterAdvertisement | null>>();
  private readonly generations = new Map<string, number>();
  private readonly now: () => number;
  constructor(options: Readonly<{ now?: () => number }> = {}) { this.now = options.now ?? Date.now; }
  async load(key: ProviderCapabilityCacheKey, loader: () => Promise<ModelParameterAdvertisement | null>, refresh = false): Promise<ModelParameterAdvertisement | null> {
    const identity = JSON.stringify([key.ownerUserId, key.providerProfileId, key.providerType, key.endpointIdentity, key.model, key.routeConfigHash, key.adapterProtocol]);
    const existing = this.entries.get(identity);
    if (!refresh && existing && this.now() - existing.loadedAt < DAY_MS) { this.entries.delete(identity); this.entries.set(identity, existing); return existing.value; }
    const pending = this.inFlight.get(identity); if (pending) return pending;
    const generation = this.generations.get(identity) ?? 0;
    const request = loader().then((value) => { if ((this.generations.get(identity) ?? 0) === generation) { this.entries.set(identity, { loadedAt: this.now(), value }); while (this.entries.size > 1000) this.entries.delete(this.entries.keys().next().value!); } return value; }).catch(() => { if ((this.generations.get(identity) ?? 0) === generation) this.entries.set(identity, { loadedAt: this.now(), value: null }); return null; }).finally(() => this.inFlight.delete(identity));
    this.inFlight.set(identity, request); return request;
  }
  invalidate(providerProfileId: string): void { for (const key of new Set([...this.entries.keys(), ...this.inFlight.keys(), ...this.generations.keys()])) if (JSON.parse(key)[1] === providerProfileId) { this.entries.delete(key); this.generations.set(key, (this.generations.get(key) ?? 0) + 1); } }
}
