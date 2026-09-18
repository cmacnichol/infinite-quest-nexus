export type ProviderCapabilityCacheKey = Readonly<{ ownerUserId: string; providerProfileId: string; providerType: string; endpointIdentity: string; model: string; routeConfigHash: string; adapterProtocol: string }>;
type CacheEntry<T> = Readonly<{ loadedAt: number; value: T }>;
type InFlightEntry<T> = Readonly<{ promise: Promise<T>; refresh: boolean }>;
const DAY_MS = 86_400_000;

export class ProviderCapabilityCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, InFlightEntry<T>>();
  private readonly now: () => number;
  constructor(options: Readonly<{ now?: () => number }> = {}) { this.now = options.now ?? Date.now; }
  async load(key: ProviderCapabilityCacheKey, loader: () => Promise<T>, refresh = false): Promise<T> {
    const identity = JSON.stringify([key.ownerUserId, key.providerProfileId, key.providerType, key.endpointIdentity, key.model, key.routeConfigHash, key.adapterProtocol]);
    const existing = this.entries.get(identity);
    if (!refresh && existing && this.now() - existing.loadedAt < DAY_MS) { this.entries.delete(identity); this.entries.set(identity, existing); return existing.value; }
    if (refresh) this.entries.delete(identity);
    const pending = this.inFlight.get(identity);
    // An explicit refresh supersedes an ordinary observation, while concurrent
    // refreshes join the replacement flight.
    if (pending && (!refresh || pending.refresh)) return pending.promise;
    const request = loader().then((value) => {
      if (this.inFlight.get(identity)?.promise === request) {
        this.entries.set(identity, { loadedAt: this.now(), value });
        while (this.entries.size > 1000) {
          const evicted = this.entries.keys().next().value!;
          this.entries.delete(evicted);
        }
      }
      return value;
    }).finally(() => {
      if (this.inFlight.get(identity)?.promise === request) this.inFlight.delete(identity);
    });
    this.inFlight.set(identity, { promise: request, refresh }); return request;
  }
  invalidate(providerProfileId: string): void {
    for (const key of new Set([...this.entries.keys(), ...this.inFlight.keys()])) {
      if (JSON.parse(key)[1] !== providerProfileId) continue;
      this.entries.delete(key);
      this.inFlight.delete(key);
    }
  }
}
import { capabilityRouteConfigHash, providerEndpointIdentity } from "../../../packages/contracts/src/provider-capability-identity.js";

export { capabilityRouteConfigHash, providerEndpointIdentity };
