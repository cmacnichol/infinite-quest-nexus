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
  it("walks each returned page offset from the documented data envelope without prompt disclosure", async () => {
    const calls: string[] = [];
    const pages = [
      new Response(JSON.stringify({
        data: Array.from({ length: 50 }, (_, index) => ({ slug: `night-shift-${index}`, name: `Night Shift ${index}`, status: "active", designated_version_id: `v${index}`, updated_at: "2026-09-19T00:00:00Z" })),
        total_count: 101
      }), { status: 200 }),
      new Response(JSON.stringify({
        data: [{ slug: "night-shift-100", name: "Night Shift 100", status: "active", designated_version_id: "v100", updated_at: "2026-09-19T00:00:00Z" }],
        total_count: 101
      }), { status: 200 })
    ];
    const twoPageTransport: ProviderTransport = {
      fetch: async (_profile, _operation, url) => { calls.push(url); return pages.shift() ?? new Response("missing", { status: 500 }); },
      validateSdkEndpoint: async () => undefined, close: async () => undefined
    };
    const result = await discoverOpenRouterPresets(profile, { offset: 50, limit: 50 }, twoPageTransport);

    expect(result).toEqual({
      presets: expect.arrayContaining([{ slug: "night-shift-0", name: "Night Shift 0", status: "active", designatedVersionId: "v0", updatedAt: "2026-09-19T00:00:00Z" }]),
      totalCount: 101,
      offset: 50,
      nextOffset: 100
    });
    const finalPage = await discoverOpenRouterPresets(profile, { offset: result.nextOffset!, limit: 50 }, twoPageTransport);
    expect(finalPage).toMatchObject({ offset: 100, nextOffset: null, presets: [{ slug: "night-shift-100" }] });
    expect(calls).toEqual([
      "https://openrouter.example/api/v1/presets?offset=50&limit=50",
      "https://openrouter.example/api/v1/presets?offset=100&limit=50"
    ]);
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
    await expect(discoverOpenRouterPreset(profile, "night-shift", transport([new Response(JSON.stringify({ data: { slug: "night-shift", name: "Night Shift", status: "active", designated_version: { id: "v", version: 1, system_prompt: "x", config: { provider: { arbitrary: true } } } } }), { status: 200 })]))).rejects.toMatchObject({ diagnosticCode: "preset_config_unsupported" });
  });

  it("accepts only range-valid typed generation and provider-routing fields", async () => {
    const detail = (config: unknown) => discoverOpenRouterPreset(profile, "night-shift", transport([new Response(JSON.stringify({ data: { slug: "night-shift", name: "Night Shift", status: "active", designated_version: { id: "v", version: 1, system_prompt: "x", config } } }), { status: 200 })]));
    await expect(detail({ model: "openai/gpt-4o", models: ["openai/gpt-4o"], temperature: 1, top_p: 0.5, top_k: 20, frequency_penalty: 1, presence_penalty: -1, repetition_penalty: 1.1, min_p: 0.1, top_a: 0.2, seed: 42, max_tokens: 512, max_completion_tokens: 512, provider: { order: ["openai"], only: ["openai"], ignore: ["anthropic"], allow_fallbacks: true, require_parameters: true, data_collection: "allow", sort: "price", quantizations: ["fp16"], enforce_distillable_text: true, preferred_min_throughput: 1, preferred_max_latency: 2, max_price: { prompt: 1, completion: 2 } } })).resolves.toMatchObject({ slug: "night-shift" });
    for (const config of [
      { temperature: "warm" }, { top_p: 2 }, { top_k: -1 }, { frequency_penalty: Infinity }, { presence_penalty: 3 }, { repetition_penalty: 0 }, { min_p: -0.1 }, { top_a: 2 }, { seed: 1.5 }, { max_tokens: 0 }, { models: [1] }, { provider: { allow_fallbacks: "yes" } }, { provider: { order: [1] } }, { provider: { data_collection: "unknown" } }, { provider: { sort: "unknown" } }, { provider: { max_price: 1 } }
    ]) await expect(detail(config)).rejects.toMatchObject({ diagnosticCode: "preset_config_unsupported" });
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
    expect(signal!.aborted).toBe(false);
    const failing: ProviderTransport = { fetch: async () => { throw new Error(`connection failed for ${profile.apiKey}`); }, validateSdkEndpoint: async () => undefined, close: async () => undefined };
    await expect(discoverOpenRouterPresets(profile, { offset: 0, limit: 50 }, failing)).rejects.toMatchObject({ diagnosticCode: "discovery_unavailable" });
    await expect(discoverOpenRouterPresets(profile, { offset: 0, limit: 50 }, failing)).rejects.not.toThrow(profile.apiKey);
  });

  it("releases the structural cancellation listener after successful and failed reads", async () => {
    const listeners = new Set<() => void>();
    let adds = 0;
    let removes = 0;
    const signal = {
      aborted: false,
      addEventListener: (_type: "abort", listener: () => void) => { adds++; listeners.add(listener); },
      removeEventListener: (_type: "abort", listener: () => void) => { removes++; listeners.delete(listener); }
    };
    await discoverOpenRouterPresets(profile, { offset: 0, limit: 50, signal }, transport([new Response(JSON.stringify({ data: [], total_count: 0 }), { status: 200 })]));
    expect({ adds, removes, listenerCount: listeners.size }).toEqual({ adds: 1, removes: 1, listenerCount: 0 });
    await expect(discoverOpenRouterPresets(profile, { offset: 0, limit: 50, signal }, { fetch: async () => { throw new Error("network down"); }, validateSdkEndpoint: async () => undefined, close: async () => undefined })).rejects.toMatchObject({ diagnosticCode: "discovery_unavailable" });
    expect({ adds, removes, listenerCount: listeners.size }).toEqual({ adds: 2, removes: 2, listenerCount: 0 });
  });

  it("forwards a structural source abort reason to the native transport signal", async () => {
    const reason = new Error("caller cancelled");
    let listener: (() => void) | undefined;
    const source = {
      aborted: false,
      reason: undefined as unknown,
      addEventListener: (_type: "abort", callback: () => void) => { listener = callback; },
      removeEventListener: () => { listener = undefined; }
    };
    let nativeSignal: AbortSignal | undefined;
    const blocking: ProviderTransport = {
      fetch: async (_profile, _operation, _url, init) => new Promise<Response>((_resolve, reject) => {
        nativeSignal = init.signal ?? undefined;
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      }), validateSdkEndpoint: async () => undefined, close: async () => undefined
    };
    const pending = discoverOpenRouterPresets(profile, { offset: 0, limit: 50, signal: source }, blocking);
    await Promise.resolve();
    source.aborted = true;
    source.reason = reason;
    listener!();
    await expect(pending).rejects.toMatchObject({ diagnosticCode: "discovery_unavailable" });
    expect(nativeSignal?.reason).toBe(reason);
    expect(listener).toBeUndefined();
  });
});
