import { describe, expect, it } from "vitest";
import { validateOpenRouterPresetConfig } from "../../packages/story-engine/src/openrouter-presets.js";
import { providerRoutingPolicySchema } from "../../packages/contracts/src/text-execution-plan.js";
import { projectSafePresetDetail } from "../../packages/contracts/src/provider-presets.js";

describe("documented OpenRouter preset routing formats", () => {
  it.each([
    [{ order: null, sort: { by: "price", partition: null } }, { sort: { by: "price" } }],
    [{ order: [], sort: "latency" }, { order: [], sort: "latency" }],
    [{ order: ["route-a"], sort: "price" }, { order: ["route-a"], sort: "price" }],
    [{ sort: { by: "throughput", partition: "none" } }, { sort: { by: "throughput", partition: "none" } }],
    [{ sort: { by: null, partition: "model" } }, { sort: { partition: "model" } }],
    [{ sort: "exacto" }, { sort: "exacto" }],
    [{ sort: { by: "exacto", partition: "model" } }, { sort: { by: "exacto", partition: "model" } }],
    [{ sort: { by: null, partition: null }, preferred_max_latency: { p50: null }, max_price: {} },
      { sort: {}, preferred_max_latency: {}, max_price: {} }],
    [{ preferred_min_throughput: { p50: 100, p75: null, p90: 50, p99: 0 }, preferred_max_latency: { p50: 1, p75: 2, p90: 3, p99: 5 } },
      { preferred_min_throughput: { p50: 100, p90: 50, p99: 0 }, preferred_max_latency: { p50: 1, p75: 2, p90: 3, p99: 5 } }],
    [{ max_price: { prompt: "0.000000000000000001", completion: 2, image: "0", request: "1e-3", audio: "0.25" } },
      { max_price: { prompt: "0.000000000000000001", completion: 2, image: "0", request: "1e-3", audio: "0.25" } }],
    [{ only: null, ignore: null, order: null, sort: null, quantizations: null, allow_fallbacks: null, require_parameters: null,
      data_collection: null, enforce_distillable_text: null, zdr: null, preferred_min_throughput: null, preferred_max_latency: null }, {}],
    [{ allow_fallbacks: false, require_parameters: false, preferred_min_throughput: 0, preferred_max_latency: 0 },
      { allow_fallbacks: false, require_parameters: false, preferred_min_throughput: 0, preferred_max_latency: 0 }]
  ])("normalizes routing %j without losing its effective settings", (provider, expected) => {
    const original = structuredClone(provider);
    const config = validateOpenRouterPresetConfig({ model: "fixture/model", provider });
    expect(config.provider).toEqual(expected);
    expect(provider).toEqual(original);
    expect(providerRoutingPolicySchema.parse(config.provider)).toEqual(expected);
    const detail = projectSafePresetDetail({ slug: "fixture", name: "Fixture", versionId: "v1", version: 1,
      systemPrompt: "Fixture prompt", config });
    expect(detail.providerPolicy).toEqual(expected);
  });

  it("treats a null provider block as unset", () => {
    expect(validateOpenRouterPresetConfig({ model: "fixture/model", provider: null })).toEqual({ model: "fixture/model" });
  });

  it.each([
    { sort: { by: "random" } }, { sort: { by: "price", partition: "invalid" } }, { sort: { secret: null } },
    { preferred_max_latency: { p95: 1 } }, { preferred_min_throughput: { p90: -1 } },
    { preferred_max_latency: { p99: "3" } }, { preferred_max_latency: [] },
    { max_price: { prompt: "NaN" } }, { max_price: { prompt: "Infinity" } }, { max_price: { prompt: "" } },
    { max_price: { prompt: "-1" } }, { max_price: { prompt: "0x10" } }, { max_price: { prompt: null } },
    { max_price: null }, { unknown_private_field: null }, { options: { "route-a": { arbitrary: true } } }
  ])("rejects malformed or unsupported routing without exposing values: %j", (provider) => {
    expect(() => validateOpenRouterPresetConfig({ provider })).toThrow(expect.objectContaining({ diagnosticCode: "preset_config_unsupported" }));
  });
});
