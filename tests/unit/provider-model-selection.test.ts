import { describe, expect, it } from "vitest";
import {
  appendModel,
  comparePresetSnapshots,
  minimumKnownContextWindow,
  moveModel,
  normalizeModelSelection,
  normalizeRoutingSelection,
  reconcileModelSelection,
  removeModel,
  selectPresetSnapshot
} from "../../apps/web/public/provider-model-selection.js";

describe("provider model selection", () => {
  it("normalizes an explicit plan to five unique model IDs", () => {
    expect(normalizeModelSelection([" primary ", "", "fallback", "primary", "two", "three", "four", "five"])).toEqual([
      "primary", "fallback", "two", "three", "four"
    ]);
  });

  it("appends discovered or custom models without replacing the primary and stops at the maximum", () => {
    expect(appendModel(["primary"], "custom/fallback")).toEqual(["primary", "custom/fallback"]);
    expect(appendModel(["one", "two", "three", "four", "five"], "six")).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("moves and removes only the selected routing position", () => {
    expect(moveModel(["primary", "first", "second"], 2, -1)).toEqual(["primary", "second", "first"]);
    expect(moveModel(["primary", "first"], 0, -1)).toEqual(["primary", "first"]);
    expect(removeModel(["primary", "first", "second"], 1)).toEqual(["primary", "second"]);
  });

  it("keeps explicit custom and unavailable IDs when discovery refreshes", () => {
    expect(reconcileModelSelection(
      ["primary", "missing-fallback", "known-fallback"],
      [{ id: "primary", contextLength: 128_000 }, { id: "known-fallback", contextLength: 32_000 }]
    )).toEqual(["primary", "missing-fallback", "known-fallback"]);
  });

  it("uses the minimum advertised context only when every selection is known", () => {
    expect(minimumKnownContextWindow(["primary", "fallback"], [
      { id: "primary", contextLength: 128_000 },
      { id: "fallback", contextLength: 32_000 }
    ])).toBe(32_000);
    expect(minimumKnownContextWindow(["primary", "custom"], [{ id: "primary", contextLength: 128_000 }])).toBeNull();
  });

  it("allows presets only for OpenRouter text and intent while retaining the inactive explicit draft", () => {
    expect(normalizeRoutingSelection({
      routingSource: "openrouter_preset",
      models: ["primary", "fallback"],
      presetSlug: "story-router",
      providerType: "openrouter",
      providerRole: "text"
    })).toEqual({ routingSource: "openrouter_preset", models: ["primary", "fallback"], presetSlug: "story-router" });
    expect(normalizeRoutingSelection({
      routingSource: "openrouter_preset",
      models: ["primary"],
      presetSlug: "story-router",
      providerType: "openrouter",
      providerRole: "image"
    })).toEqual({ routingSource: "models", models: ["primary"], presetSlug: "" });
  });

  it("captures a resolved preset and reports a remote update without adopting it", () => {
    const saved = selectPresetSnapshot({
      slug: "story-router",
      designatedVersionId: "version-a",
      version: 2,
      configHash: "a".repeat(64),
      models: ["primary", "fallback"],
      providerPolicy: { allow_fallbacks: true }
    });
    expect(saved).toMatchObject({ routingSource: "openrouter_preset", presetSlug: "story-router", models: ["primary", "fallback"] });
    expect(comparePresetSnapshots(saved.snapshot, { ...saved.snapshot, version: 3, configHash: "b".repeat(64) })).toEqual({ changed: true, reason: "version" });
    expect(comparePresetSnapshots(saved.snapshot, saved.snapshot)).toEqual({ changed: false, reason: "current" });
  });
});
