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
});
