import { describe, expect, it, vi } from "vitest";
import { capabilityRouteConfigHash, ProviderCapabilityCache } from "../../services/runtime/src/provider-capability-cache.js";

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

  it("detaches an invalidated in-flight load so a fresh discovery cannot be overwritten", async () => {
    let resolveFirst: ((value: { supportedParameters: readonly string[]; discoveredAt: string }) => void) | undefined;
    const cache = new ProviderCapabilityCache<{ supportedParameters: readonly string[]; discoveredAt: string }>({ now: () => 0 });
    const first = cache.load(key, () => new Promise((resolve) => { resolveFirst = resolve; }));
    cache.invalidate(key.providerProfileId);
    const second = cache.load(key, async () => ({ supportedParameters: ["structured_outputs"], discoveredAt: "second" }));
    resolveFirst?.({ supportedParameters: ["response_format"], discoveredAt: "first" });

    await expect(first).resolves.toMatchObject({ discoveredAt: "first" });
    await expect(second).resolves.toMatchObject({ discoveredAt: "second" });
    await expect(cache.load(key, async () => ({ supportedParameters: [], discoveredAt: "unexpected" }))).resolves.toMatchObject({ discoveredAt: "second" });
  });

  it("replaces an ordinary in-flight discovery when an explicit refresh arrives", async () => {
    let resolveFirst: ((value: { supportedParameters: readonly string[]; discoveredAt: string }) => void) | undefined;
    const cache = new ProviderCapabilityCache<{ supportedParameters: readonly string[]; discoveredAt: string }>({ now: () => 0 });
    const first = cache.load(key, () => new Promise((resolve) => { resolveFirst = resolve; }));
    const refreshed = cache.load(key, async () => ({ supportedParameters: ["structured_outputs"], discoveredAt: "refresh" }), true);
    resolveFirst?.({ supportedParameters: ["response_format"], discoveredAt: "first" });

    await expect(first).resolves.toMatchObject({ discoveredAt: "first" });
    await expect(refreshed).resolves.toMatchObject({ discoveredAt: "refresh" });
    await expect(cache.load(key, async () => ({ supportedParameters: [], discoveredAt: "unexpected" }))).resolves.toMatchObject({ discoveredAt: "refresh" });
  });

  it("single-flights concurrent explicit refreshes", async () => {
    const cache = new ProviderCapabilityCache<{ supportedParameters: readonly string[]; discoveredAt: string }>({ now: () => 0 });
    const load = vi.fn(async () => ({ supportedParameters: ["response_format"], discoveredAt: "refresh" }));
    await Promise.all([cache.load(key, load, true), cache.load(key, load, true)]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not restore a stale load after invalidation when the replacement discovery fails", async () => {
    let resolveFirst: ((value: { supportedParameters: readonly string[]; discoveredAt: string }) => void) | undefined;
    const cache = new ProviderCapabilityCache<{ supportedParameters: readonly string[]; discoveredAt: string }>({ now: () => 0 });
    const first = cache.load(key, () => new Promise((resolve) => { resolveFirst = resolve; }));
    cache.invalidate(key.providerProfileId);
    await expect(cache.load(key, async () => { throw new Error("unavailable"); })).rejects.toThrow("unavailable");
    resolveFirst?.({ supportedParameters: ["response_format"], discoveredAt: "stale" });
    await first;
    await expect(cache.load(key, async () => ({ supportedParameters: ["structured_outputs"], discoveredAt: "fresh" }))).resolves.toMatchObject({ discoveredAt: "fresh" });
  });

  it("partitions only capability-relevant non-secret configuration", () => {
    expect(capabilityRouteConfigHash({ streaming: true, apiKey: "secret", ignored: "one" }))
      .toBe(capabilityRouteConfigHash({ streaming: true, credential: "other", ignored: "two" }));
    expect(capabilityRouteConfigHash({ streaming: true })).not.toBe(capabilityRouteConfigHash({ streaming: false }));
    expect(capabilityRouteConfigHash({ streamingSupport: true })).not.toBe(capabilityRouteConfigHash({ streamingSupport: false }));
    expect(capabilityRouteConfigHash({ textResponseFormatPolicy: "auto" })).not.toBe(capabilityRouteConfigHash({ textResponseFormatPolicy: "required" }));
  });
});
