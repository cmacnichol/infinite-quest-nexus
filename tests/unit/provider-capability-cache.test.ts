import { describe, expect, it, vi } from "vitest";
import { capabilityRouteConfigHash, ProviderCapabilityCache } from "../../services/runtime/src/provider-capability-cache.js";
import { createProviderResponseFormatCapabilities } from "../../services/runtime/src/provider-response-format-capabilities.js";
import { providerEndpointIdentity } from "../../packages/contracts/src/provider-capability-identity.js";

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

  it("partitions every capability tuple field, treats a new cache as a restart miss, and drops stale data after a failed refresh", async () => {
    const cache = new ProviderCapabilityCache<{ supportedParameters: readonly string[]; discoveredAt: string }>({ now: () => 0 });
    const load = vi.fn(async () => ({ supportedParameters: ["response_format"], discoveredAt: "first" }));
    const tupleFields = ["ownerUserId", "providerProfileId", "providerType", "endpointIdentity", "model", "routeConfigHash", "adapterProtocol"] as const;
    for (const field of tupleFields) await cache.load({ ...key, [field]: `${key[field]}-other` }, load);
    expect(load).toHaveBeenCalledTimes(tupleFields.length);

    await cache.load(key, load);
    await expect(cache.load(key, async () => { throw new Error("refresh unavailable"); }, true)).rejects.toThrow("refresh unavailable");
    await cache.load(key, load);
    expect(load).toHaveBeenCalledTimes(tupleFields.length + 2);

    const restarted = new ProviderCapabilityCache<{ supportedParameters: readonly string[]; discoveredAt: string }>({ now: () => 0 });
    await restarted.load(key, load);
    expect(load).toHaveBeenCalledTimes(tupleFields.length + 3);
  });

  it("evicts the least recently used entry after 1,000 entries", async () => {
    const cache = new ProviderCapabilityCache<number>({ now: () => 0 });
    const load = vi.fn(async () => load.mock.calls.length);
    const entry = (model: string) => ({ ...key, model });
    for (let index = 0; index < 1_000; index += 1) await cache.load(entry(`model-${index}`), load);
    await cache.load(entry("model-0"), load);
    await cache.load(entry("model-1000"), load);
    await cache.load(entry("model-0"), load);
    await cache.load(entry("model-1"), load);
    expect(load).toHaveBeenCalledTimes(1_002);
  });

  it("partitions only capability-relevant non-secret configuration", () => {
    expect(capabilityRouteConfigHash({ streaming: true, apiKey: "secret", ignored: "one" }))
      .toBe(capabilityRouteConfigHash({ streaming: true, credential: "other", ignored: "two" }));
    expect(capabilityRouteConfigHash({ streaming: true })).not.toBe(capabilityRouteConfigHash({ streaming: false }));
    expect(capabilityRouteConfigHash({ streamingSupport: true })).not.toBe(capabilityRouteConfigHash({ streamingSupport: false }));
    expect(capabilityRouteConfigHash({ textResponseFormatPolicy: "auto" })).not.toBe(capabilityRouteConfigHash({ textResponseFormatPolicy: "required" }));
  });

  it("preserves stable cross-layer capability identities", () => {
    expect(capabilityRouteConfigHash({})).toBe("2430f1a2ad2982d0067885488a4c89e21ad1d7c83b115ba8f1b20acc88dfaea8");
    expect(providerEndpointIdentity("https://example.test/api///")).toBe("066c887c55bc422605d7b5dd62443bcff0dbfb13bb965b4a981a372b94a7367d");
  });

  it("keeps transaction-local discovery out of the global cache until a successful commit invalidates it", async () => {
    const capabilities = createProviderResponseFormatCapabilities();
    const staged = capabilities.transactionLocal();
    const stale = { supportedParameters: ["response_format"], discoveredAt: "before" };
    const replacement = { supportedParameters: ["structured_outputs"], discoveredAt: "after" };

    await capabilities.discover(key, async () => stale);
    await staged.discover(key, async () => replacement);

    await expect(capabilities.discover(key, async () => ({ supportedParameters: [], discoveredAt: "unexpected" }))).resolves.toEqual(stale);
    capabilities.invalidate(key.providerProfileId);
    await expect(capabilities.discover(key, async () => replacement)).resolves.toEqual(replacement);
  });

  it("does not publish staged capability metadata when a transaction rolls back", async () => {
    const capabilities = createProviderResponseFormatCapabilities({ registryDigest: "registry-v1" });
    const staged = capabilities.transactionLocal();
    const committed = { supportedParameters: ["response_format"], discoveredAt: "committed" };
    const rolledBack = { supportedParameters: ["structured_outputs"], discoveredAt: "rolled-back" };

    await capabilities.discover(key, async () => committed);
    await staged.discover(key, async () => rolledBack);

    expect(staged).not.toBe(capabilities);
    expect(staged.registryDigest).toBe(capabilities.registryDigest);
    await expect(capabilities.discover(key, async () => ({ supportedParameters: [], discoveredAt: "unexpected" }))).resolves.toEqual(committed);
  });
});
