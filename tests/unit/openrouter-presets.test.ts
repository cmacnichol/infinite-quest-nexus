import { describe, expect, it } from "vitest";
import { discoverOpenRouterPreset, discoverOpenRouterPresets } from "../../packages/story-engine/src/openrouter-presets.js";
import type { ProviderTransport } from "../../packages/story-engine/src/provider-transport.js";

const profile = {
  providerType: "openrouter",
  baseUrl: "https://openrouter.example/api/v1",
  model: "unused",
  apiKey: "test-only-secret"
} as const;

function transport(responses: readonly Response[]): ProviderTransport {
  let index = 0;
  return {
    fetch: async () => responses[index++] ?? new Response("missing", { status: 500 }),
    validateSdkEndpoint: async () => undefined,
    close: async () => undefined
  };
}

describe("OpenRouter preset metadata discovery", () => {
  it("projects an incremental page from the documented data envelope without prompt disclosure", async () => {
    const result = await discoverOpenRouterPresets(profile, { offset: 50, limit: 50 }, transport([
      new Response(JSON.stringify({
        data: Array.from({ length: 50 }, (_, index) => ({ slug: `night-shift-${index}`, name: `Night Shift ${index}`, status: "active", designated_version_id: `v${index}`, updated_at: "2026-09-19T00:00:00Z" })),
        total_count: 101
      }), { status: 200 })
    ]));

    expect(result).toEqual({
      presets: expect.arrayContaining([{ slug: "night-shift-0", name: "Night Shift 0", status: "active", designatedVersionId: "v0", updatedAt: "2026-09-19T00:00:00Z" }]),
      totalCount: 101,
      offset: 50,
      nextOffset: 100
    });
  });

  it("retains the selected version standard prompt and supported config from a fresh detail response", async () => {
    const result = await discoverOpenRouterPreset(profile, "night-shift", transport([
      new Response(JSON.stringify({
        data: {
          slug: "night-shift", name: "Night Shift", status: "active",
          designated_version: {
            id: "version-2", version: 2, system_prompt: "Stay in character.",
            config: { models: ["openai/gpt-4o"], temperature: 0.7 }
          }
        }
      }), { status: 200 })
    ]));

    expect(result).toEqual({
      slug: "night-shift", name: "Night Shift", versionId: "version-2", version: 2,
      systemPrompt: "Stay in character.", config: { models: ["openai/gpt-4o"], temperature: 0.7 },
      configHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it("rejects a detail response whose slug does not match the requested preset", async () => {
    await expect(discoverOpenRouterPreset(profile, "night-shift", transport([
      new Response(JSON.stringify({ data: { slug: "different", name: "Different", status: "active", designated_version: { id: "version-2", version: 2, system_prompt: "Prompt", config: {} } } }), { status: 200 })
    ]))).rejects.toMatchObject({ diagnosticCode: "invalid_response" });
  });

  it("uses finite diagnostics for malformed totals, inactive versions, invalid versions, and unsupported protocol fields", async () => {
    const cases: readonly [unknown, string, string][] = [
      [{ data: [], total_count: -1 }, "list", "invalid_response"],
      [{ data: { slug: "night-shift", name: "Night Shift", status: "inactive", designated_version: { id: "v", version: 1, system_prompt: "x", config: {} } } }, "detail", "preset_inactive"],
      [{ data: { slug: "night-shift", name: "Night Shift", status: "active", designated_version: { id: "v", version: 0, system_prompt: "x", config: {} } } }, "detail", "invalid_response"],
      [{ data: { slug: "night-shift", name: "Night Shift", status: "active", designated_version: { id: "v", version: 1, system_prompt: "x", config: { tools: [{ type: "function" }] } } } }, "detail", "preset_config_unsupported"]
    ];
    for (const [payload, mode, diagnosticCode] of cases) {
      const action = mode === "list"
        ? discoverOpenRouterPresets(profile, { offset: 0, limit: 50 }, transport([new Response(JSON.stringify(payload), { status: 200 })]))
        : discoverOpenRouterPreset(profile, "night-shift", transport([new Response(JSON.stringify(payload), { status: 200 })]));
      await expect(action).rejects.toMatchObject({ diagnosticCode });
    }
  });

  it("bounds response and prompt/config sizes while keeping credentials out of failures", async () => {
    const oversized = "x".repeat(1_048_577);
    await expect(discoverOpenRouterPresets(profile, { offset: 0, limit: 50 }, transport([new Response(oversized, { status: 200 })]))).rejects.toMatchObject({ diagnosticCode: "invalid_response" });
    await expect(discoverOpenRouterPreset(profile, "night-shift", transport([new Response(JSON.stringify({ data: { slug: "night-shift", name: "Night Shift", status: "active", designated_version: { id: "v", version: 1, system_prompt: "x".repeat(200_001), config: {} } } }), { status: 200 })]))).rejects.toMatchObject({ diagnosticCode: "preset_config_unsupported" });
  });

  it("encodes detail slugs, supplies cancellation, and redacts a thrown transport failure", async () => {
    let url = "";
    let signal: AbortSignal | undefined;
    const recording: ProviderTransport = {
      fetch: async (_profile, _operation, requestedUrl, init) => {
        url = requestedUrl;
        signal = init.signal ?? undefined;
        return new Response(JSON.stringify({ data: { slug: "night shift", name: "Night Shift", status: "active", designated_version: { id: "v", version: 1, system_prompt: "x", config: {} } } }), { status: 200 });
      }, validateSdkEndpoint: async () => undefined, close: async () => undefined
    };
    const controller = new AbortController();
    await discoverOpenRouterPreset(profile, "night shift", recording, controller.signal);
    expect(url).toContain("/presets/night%20shift");
    expect(signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(signal!.aborted).toBe(true);
    const failing: ProviderTransport = { fetch: async () => { throw new Error(`connection failed for ${profile.apiKey}`); }, validateSdkEndpoint: async () => undefined, close: async () => undefined };
    await expect(discoverOpenRouterPresets(profile, { offset: 0, limit: 50 }, failing)).rejects.toMatchObject({ diagnosticCode: "discovery_unavailable" });
    await expect(discoverOpenRouterPresets(profile, { offset: 0, limit: 50 }, failing)).rejects.not.toThrow(profile.apiKey);
  });
});
