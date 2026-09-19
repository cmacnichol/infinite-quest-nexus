import { describe, expect, it } from "vitest";
import { createRuntimeProviderAdapter } from "../../services/runtime/src/provider-credential-transport-adapter.js";
import type { ProviderTransport } from "../../packages/story-engine/src/provider-transport.js";

const profileId = "00000000-0000-4000-8000-000000000111";
const ownerA = "00000000-0000-4000-8000-000000000001";
const ownerB = "00000000-0000-4000-8000-000000000002";

function response(slug: string) {
  return new Response(JSON.stringify({ data: [{ slug, name: slug, status: "active", designated_version_id: "v", updated_at: "2026-09-19T00:00:00Z" }], total_count: 1 }), { status: 200 });
}

describe("preset summary cache identity and refresh fence", () => {
  it("does not share same-slug summaries across owners or endpoint revisions", async () => {
    let endpoint = "https://one.example/api/v1";
    const database = { query: async (_sql: string, parameters: readonly unknown[]) => ({ rows: parameters[1] === ownerA || parameters[1] === ownerB ? [{ id: parameters[0], name: "OpenRouter", provider_role: "text", provider_type: "openrouter", base_url: endpoint, default_model: "model", context_window_tokens: 8192, max_output_tokens: 1024, temperature: 0.7, request_timeout_ms: 60_000, configuration: {}, encrypted_api_key: null, credential_nonce: null, credential_auth_tag: null, credential_key_version: null }] : [] }) } as never;
    let calls = 0;
    const transport: ProviderTransport = { fetch: async () => response(`preset-${++calls}`), validateSdkEndpoint: async () => undefined, close: async () => undefined };
    const adapter = createRuntimeProviderAdapter({ database, credentialSecret: "x", transport, health: { recordHealth: async () => undefined } });
    const request = { providerProfileId: profileId, offset: 0, limit: 50 };
    expect((await adapter.inventory.listPresets({ ...request, ownerUserId: ownerA })).page.presets[0]?.slug).toBe("preset-1");
    expect((await adapter.inventory.listPresets({ ...request, ownerUserId: ownerB })).page.presets[0]?.slug).toBe("preset-2");
    endpoint = "https://two.example/api/v1";
    expect((await adapter.inventory.listPresets({ ...request, ownerUserId: ownerA })).page.presets[0]?.slug).toBe("preset-3");
    await expect(adapter.inventory.listPresets({ ...request, ownerUserId: "00000000-0000-4000-8000-000000000099" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("keeps the refreshed cache entry when an older in-flight request fails", async () => {
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<Response>((_resolve, reject) => { rejectFirst = reject; });
    let calls = 0;
    const transport: ProviderTransport = { fetch: async () => ++calls === 1 ? first : response("fresh"), validateSdkEndpoint: async () => undefined, close: async () => undefined };
    const database = { query: async (_sql: string, parameters: readonly unknown[]) => ({ rows: [{ id: parameters[0], name: "OpenRouter", provider_role: "text", provider_type: "openrouter", base_url: "https://one.example/api/v1", default_model: "model", context_window_tokens: 8192, max_output_tokens: 1024, temperature: 0.7, request_timeout_ms: 60_000, configuration: {}, encrypted_api_key: null, credential_nonce: null, credential_auth_tag: null, credential_key_version: null }] }) } as never;
    const adapter = createRuntimeProviderAdapter({ database, credentialSecret: "x", transport, health: { recordHealth: async () => undefined } });
    const request = { ownerUserId: ownerA, providerProfileId: profileId, offset: 0, limit: 50 };
    const old = adapter.inventory.listPresets(request);
    const fresh = await adapter.inventory.listPresets({ ...request, refresh: true });
    rejectFirst(new Error("obsolete failure"));
    await expect(old).rejects.toBeDefined();
    expect((await adapter.inventory.listPresets(request)).page.presets[0]?.slug).toBe("fresh");
    expect(calls).toBe(2);
  });
});
