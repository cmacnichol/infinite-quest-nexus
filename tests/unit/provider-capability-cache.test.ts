import { describe, expect, it, vi } from "vitest";
import { ProviderCapabilityCache } from "../../services/runtime/src/provider-capability-cache.js";

const key = {
  ownerUserId: "owner", providerProfileId: "profile", providerType: "openrouter" as const,
  endpointIdentity: "endpoint", model: "model", routeConfigHash: "route", adapterProtocol: "text-schema-adapter-v1" as const
};

describe("provider capability cache", () => {
  it("single-flights matching loads and expires exactly at twenty-four hours", async () => {
    let now = 0;
    const cache = new ProviderCapabilityCache({ now: () => now });
    const load = vi.fn(async () => ({ supportedParameters: ["response_format"], discoveredAt: "now" }));
    await Promise.all([cache.load(key, load), cache.load(key, load)]);
    expect(load).toHaveBeenCalledTimes(1);
    now = 86_400_000;
    await cache.load(key, load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
