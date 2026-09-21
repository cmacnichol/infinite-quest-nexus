import { describe, expect, it, vi } from "vitest";
import { ApiContractError, NexusApiError } from "../../packages/client-core/src/errors.js";
import { createNexusHttpClient } from "../../packages/client-web/src/http-client.js";
import {
  ProviderPresetsUnsupportedError,
  createProviderPresetsApi,
  nativePresetSupport
} from "../../packages/client-web/src/provider-presets-api.js";

const providerId = "11111111-1111-4111-8111-111111111111";
const candidate = {
  name: "Unsaved OpenRouter", providerType: "openrouter" as const, providerRole: "text" as const,
  baseUrl: "https://openrouter.ai/api/v1", defaultModel: "@preset/night-shift",
  textSelection: { kind: "openrouter_preset" as const, slug: "night-shift" },
  contextWindowTokens: 32768, maxOutputTokens: 4096, temperature: 0.8, requestTimeoutMs: 300000,
  apiKey: "write-only-secret", enabled: true, isDefault: false, configuration: {}
};
const page = { presets: [{ slug: "night-shift", name: "Night Shift", status: "active", designatedVersionId: "v2", updatedAt: "2026-09-20T00:00:00.000Z" }], totalCount: 1, offset: 0, nextOffset: null };
const detail = {
  slug: "night-shift", name: "Night Shift", versionId: "v2", version: 2, standardPrompt: "Write nocturnal stories.",
  candidateModelIds: ["openai/gpt-5"], providerPolicy: { order: ["openai"] }, excludedProviderSlugs: [], parameters: { temperature: 0.7 },
  limits: { configuredMaxTokens: 1000, configuredMaxCompletionTokens: null, effectiveMaxOutputTokens: 1000, contextWindowTokens: { status: "unknown", value: null } },
  responseFormat: { mode: "json_schema", assurance: "trusted_preset" }
};

function api(fetchImpl: typeof fetch) {
  return createProviderPresetsApi(createNexusHttpClient({
    basePath: "/api/v1", session: { authorization: async () => ({}), onUnauthorized: async () => false }, fetchImpl
  }));
}

describe("provider Presets API", () => {
  it("loads saved list/detail routes with encoded inputs and AbortSignal", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(String(input).includes("/night-shift") ? detail : page), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = api(fetchImpl);
    const signal = new AbortController().signal;
    await expect(client.listSaved(providerId, { offset: 0, limit: 50, refresh: true }, signal)).resolves.toEqual(page);
    await expect(client.detailSaved(providerId, "night-shift", signal)).resolves.toEqual(detail);
    expect(requests.map((request) => request.url)).toEqual([
      `/api/v1/providers/${providerId}/presets?offset=0&limit=50&refresh=true`,
      `/api/v1/providers/${providerId}/presets/night-shift`
    ]);
    expect(requests.every((request) => request.init?.signal === signal)).toBe(true);
  });

  it("uses the write-only candidate boundary for unsaved list/detail discovery", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(String(input).includes("resolve-preset") ? detail : page), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = api(fetchImpl);
    await client.listCandidate(candidate, { offset: 5, limit: 25 });
    await client.detailCandidate(candidate, "night-shift");
    expect(requests.map((request) => [request.url, request.init?.method])).toEqual([
      ["/api/v1/providers/discover-presets?offset=5&limit=25", "POST"],
      ["/api/v1/providers/resolve-preset?slug=night-shift", "POST"]
    ]);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(candidate);
  });

  it("strictly rejects unsafe or malformed server payloads", async () => {
    const client = api(async () => new Response(JSON.stringify({ ...detail, credentialReference: "private" }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(client.detailSaved(providerId, "night-shift")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("reports an old server explicitly as unsupported", async () => {
    const client = api(async () => new Response(JSON.stringify({ error: "Not Found", message: "Not Found", correlationId: "old-server", details: {} }), { status: 404, headers: { "content-type": "application/json" } }));
    await expect(client.listSaved(providerId, { offset: 0, limit: 50 })).rejects.toBeInstanceOf(ProviderPresetsUnsupportedError);
    expect(nativePresetSupport({ application: { name: "Infinite Quest Nexus", version: "old", commit: null, builtAt: null }, capabilities: { systemArchive: true } } as never)).toEqual({ state: "unsupported" });
    expect(nativePresetSupport({ application: { name: "Infinite Quest Nexus", version: "new", commit: null, builtAt: null }, capabilities: { systemArchive: true, nativeTextExecutionPlans: true } })).toEqual({ state: "supported" });
  });

  it("does not turn a detail-level missing Preset into an old-server error", async () => {
    const client = api(async () => new Response(JSON.stringify({ error: "Not Found", message: "Preset missing", correlationId: "missing", details: {} }), { status: 404, headers: { "content-type": "application/json" } }));
    await expect(client.detailSaved(providerId, "missing")).rejects.toBeInstanceOf(NexusApiError);
  });
});
