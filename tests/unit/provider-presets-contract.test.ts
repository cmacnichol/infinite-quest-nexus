import { describe, expect, it } from "vitest";
import { projectSafePresetDetail, projectSafePresetPage, safePresetDetailSchema, safePresetPageSchema } from "../../packages/contracts/src/provider-presets.js";

describe("safe provider Preset contracts", () => {
  it("projects only the strict owner-visible list fields", () => {
    const privateCanary = "PRIVATE_LIST_CANARY";
    const projected = projectSafePresetPage({ presets: [{
      slug: "night-shift", name: "Night Shift", status: "active", designatedVersionId: "v2", updatedAt: "2026-09-20T00:00:00.000Z",
      credentialReference: privateCanary
    }], totalCount: 1, offset: 0, nextOffset: null });
    expect(safePresetPageSchema.parse(projected)).toEqual({
      presets: [{ slug: "night-shift", name: "Night Shift", status: "active", designatedVersionId: "v2", updatedAt: "2026-09-20T00:00:00.000Z" }],
      totalCount: 1, offset: 0, nextOffset: null
    });
    expect(JSON.stringify(projected)).not.toContain(privateCanary);
  });

  it("projects prompt, ordered candidates, complete finite routing policy, parameters, and honest limits without raw config", () => {
    const privateCanary = "PRIVATE_DETAIL_CANARY";
    const projected = projectSafePresetDetail({
      slug: "night-shift", name: "Night Shift", versionId: "v2", version: 2, systemPrompt: "Owner-visible standard prompt.", configHash: "a".repeat(64),
      config: {
        model: "route/primary", models: ["route/secondary", "route/primary"], temperature: 0.7, max_tokens: 1200, max_completion_tokens: 900,
        provider: { order: ["openai", "anthropic"], only: ["openai", "anthropic"], ignore: ["untrusted"], allow_fallbacks: true, require_parameters: true, data_collection: "deny", quantizations: ["fp8"], enforce_distillable_text: true, preferred_min_throughput: 12, preferred_max_latency: 5, max_price: { prompt: 1, completion: 2 }, zdr: true },
        credentialReference: privateCanary
      }
    });
    expect(safePresetDetailSchema.parse(projected)).toMatchObject({
      candidateModelIds: ["route/primary", "route/secondary"], excludedProviderSlugs: ["untrusted"], parameters: { temperature: 0.7, max_tokens: 1200, max_completion_tokens: 900 },
      providerPolicy: { order: ["openai", "anthropic"], only: ["openai", "anthropic"], ignore: ["untrusted"], allow_fallbacks: true, require_parameters: true, data_collection: "deny", quantizations: ["fp8"], enforce_distillable_text: true, preferred_min_throughput: 12, preferred_max_latency: 5, max_price: { prompt: 1, completion: 2 }, zdr: true },
      limits: { configuredMaxTokens: 1200, configuredMaxCompletionTokens: 900, effectiveMaxOutputTokens: 900, contextWindowTokens: { status: "unknown", value: null } },
      responseFormat: { mode: "json_schema", assurance: "trusted_preset" }
    });
    expect(JSON.stringify(projected)).not.toContain(privateCanary);
    expect(JSON.stringify(projected)).not.toContain("configHash");
  });

  it("rejects malformed source collections and configured routing intent", () => {
    expect(() => projectSafePresetPage({ presets: "not-an-array", totalCount: 0, offset: 0, nextOffset: null })).toThrow();
    expect(() => projectSafePresetDetail({
      slug: "night-shift", name: "Night Shift", versionId: "v2", version: 2, systemPrompt: "Prompt.",
      config: { models: ["route/model", 7], provider: { order: "not-an-array" } }
    })).toThrow();
  });
});
