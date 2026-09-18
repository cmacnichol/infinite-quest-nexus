export type ProviderCapabilityCacheKey = Readonly<{ ownerUserId: string; providerProfileId: string; providerType: string; endpointIdentity: string; model: string; routeConfigHash: string; adapterProtocol: string }>;
type CacheEntry<T> = Readonly<{ loadedAt: number; value: T }>;
const DAY_MS = 86_400_000;
export class ProviderCapabilityCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly generations = new Map<string, number>();
  private readonly now: () => number;
  constructor(options: Readonly<{ now?: () => number }> = {}) { this.now = options.now ?? Date.now; }
  async load(key: ProviderCapabilityCacheKey, loader: () => Promise<T>, refresh = false): Promise<T> {
    const identity = JSON.stringify([key.ownerUserId, key.providerProfileId, key.providerType, key.endpointIdentity, key.model, key.routeConfigHash, key.adapterProtocol]);
    const existing = this.entries.get(identity);
    if (!refresh && existing && this.now() - existing.loadedAt < DAY_MS) { this.entries.delete(identity); this.entries.set(identity, existing); return existing.value; }
    if (refresh) {
      this.entries.delete(identity);
      this.inFlight.delete(identity);
      this.generations.set(identity, (this.generations.get(identity) ?? 0) + 1);
    }
    const pending = this.inFlight.get(identity); if (pending) return pending;
    const generation = this.generations.get(identity) ?? 0;
    const request = loader().then((value) => {
      if ((this.generations.get(identity) ?? 0) === generation) {
        this.entries.set(identity, { loadedAt: this.now(), value });
        while (this.entries.size > 1000) {
          const evicted = this.entries.keys().next().value!;
          this.entries.delete(evicted);
          if (!this.inFlight.has(evicted)) this.generations.delete(evicted);
        }
      }
      return value;
    }).finally(() => {
      if (this.inFlight.get(identity) === request) this.inFlight.delete(identity);
      if (!this.inFlight.has(identity) && !this.entries.has(identity)) this.generations.delete(identity);
    });
    this.inFlight.set(identity, request); return request;
  }
  invalidate(providerProfileId: string): void {
    for (const key of new Set([...this.entries.keys(), ...this.inFlight.keys(), ...this.generations.keys()])) {
      if (JSON.parse(key)[1] !== providerProfileId) continue;
      this.entries.delete(key);
      this.inFlight.delete(key);
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    }
  }
}
