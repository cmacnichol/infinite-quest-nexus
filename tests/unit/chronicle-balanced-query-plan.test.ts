import { describe, expect, it } from "vitest";
import { planBalancedChronicleQueries } from "../../packages/domain/src/chronicle-query-plan.js";

describe("balanced generation queries", () => {
  it("covers a late direction and preserves independent hints within a fixed budget", () => {
    const action = `${"Walk through the quiet courtyard. ".repeat(330)}Find Zephyra and resolve the missing sapphire.`;
    const result = planBalancedChronicleQueries({
      action, throughTurnNumber: 12,
      entityHints: [{ ordinal: 3, entityId: "zephyra", terms: ["Zephyra", "Keeper of sapphires"] }],
      sceneHints: [{ ordinal: 12, content: "The orchard gate remains locked." }],
      openThreadHints: [{ ordinal: 8, content: "The missing courier awaits rescue." }, { ordinal: 13, content: "Future secret must stay absent." }]
    });
    expect(result.variants.some((variant) => variant.query.includes("missing sapphire"))).toBe(true);
    expect(result.variants.find((variant) => variant.kind === "scene")?.query).toContain("orchard gate");
    expect(result.variants.find((variant) => variant.kind === "open_thread")?.query).toContain("courier awaits rescue");
    expect(JSON.stringify(result)).not.toContain("Future secret");
    expect(result.variants.length).toBeLessThanOrEqual(8);
    expect(result.totalCharacters).toBeLessThanOrEqual(8_000);
    expect(result.variants.every((variant) => variant.query.length <= 1_600)).toBe(true);
    expect(planBalancedChronicleQueries({ action, throughTurnNumber: 12 })).toEqual(planBalancedChronicleQueries({ action, throughTurnNumber: 12 }));
  });

  it("keeps UTF-16 source spans valid for a multilingual single sentence", () => {
    const action = `${"静かな森を歩く 🌲 ".repeat(700)}最後の門を開く`;
    const result = planBalancedChronicleQueries({ action });
    for (const variant of result.variants.filter((value) => value.kind === "action")) {
      expect(action.slice(variant.actionSegment!.start, variant.actionSegment!.end)).toBe(variant.query);
      expect(variant.query).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    }
    expect(result.variants.some((variant) => variant.query.includes("最後の門を開く"))).toBe(true);
  });

  it("keeps new entity coverage from the middle and prevents future temporal hints", () => {
    const action = `${"Quiet road. ".repeat(170)}Visit Umbriel and recover the broken compass. ${"Quiet road. ".repeat(500)}`;
    const result = planBalancedChronicleQueries({ action, throughTurnNumber: 4,
      entityHints: [{ ordinal: 2, entityId: "umbriel", terms: ["Umbriel"] }],
      temporalHint: { throughTurnNumber: 5, label: "accepted turn 5" } });
    expect(result.variants.some((value) => value.kind === "action" && value.query.includes("Umbriel"))).toBe(true);
    expect(result.variants.some((value) => value.kind === "temporal_hint")).toBe(false);
    expect(result.variants.flatMap((value) => value.entityIds)).toContain("umbriel");
    expect(result.uncoveredSegmentCount).toBeGreaterThanOrEqual(0);
  });

  it("bounds all eight variants and excludes mechanics and unsupported input fields", () => {
    const result = planBalancedChronicleQueries({ action: "A".repeat(11_960) + " Search the lighthouse.", throughTurnNumber: 9,
      entityHints: [{ ordinal: 1, entityId: "light", terms: ["lighthouse"] }],
      sceneHints: [{ ordinal: 3, content: "The red lighthouse overlooks the bay. [DC 15]" }],
      openThreadHints: [{ ordinal: 2, content: "Rescue the shipwrecked crew." }],
      temporalHint: { throughTurnNumber: 2, label: "accepted turn 2" },
      ...{ scratchpad: "SECRET must not enter queries" }
    });
    expect(result.variants.length).toBeLessThanOrEqual(8);
    expect(result.totalCharacters).toBeLessThanOrEqual(8_000);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|DC 15/);
    expect(result.variants.some((value) => value.kind === "temporal_hint")).toBe(true);
    expect(result.variants.some((value) => value.query.includes("Search the lighthouse"))).toBe(true);
  });
});
