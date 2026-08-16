import { describe, expect, it } from "vitest";
import { planChronicleQueries } from "../../packages/domain/src/chronicle-query-plan.js";

describe("Chronicle query planning", () => {
  it("builds deterministic independently bounded fiction-only variants through the requested turn", () => {
    const input = {
      action: "Follow Shade through the moon gate [[roll d20 target 15]].",
      throughTurnNumber: 3,
      entityHints: [
        { ordinal: 2, entityId: "world:moon-warden", terms: ["Moon Warden", "Shade"] },
        { ordinal: 8, entityId: "world:future-oracle", terms: ["Future Oracle"] }
      ],
      sceneHints: [
        { ordinal: 3, content: "Moonlight spills across the gate while the Warden waits." },
        { ordinal: 4, content: "The future vault is already open." }
      ],
      openThreadHints: [
        { ordinal: 2, content: "Discover why the Moon Warden guards the gate." },
        { ordinal: 9, content: "Ask the Future Oracle for the hidden answer." }
      ],
      limits: { action: 72, entity_expanded: 96, scene: 104, open_thread: 112 },
      mechanics: { roll: 20, target: 15 },
      privateScratchpad: "The private traitor is the Warden."
    } as const;

    const first = planChronicleQueries(input);
    const second = planChronicleQueries(input);

    expect(first).toEqual(second);
    expect(first.map((variant) => variant.kind)).toEqual(["action", "entity_expanded", "scene", "open_thread"]);
    const lengths = Object.fromEntries(first.map((variant) => [variant.kind, variant.query.length]));
    expect(lengths.action).toBeLessThanOrEqual(72);
    expect(lengths.entity_expanded).toBeLessThanOrEqual(96);
    expect(lengths.scene).toBeLessThanOrEqual(104);
    expect(lengths.open_thread).toBeLessThanOrEqual(112);
    expect(first.find((variant) => variant.kind === "entity_expanded")?.entityIds)
      .toEqual(["world:moon-warden"]);
    expect(first.find((variant) => variant.kind === "action")?.entityIds).toEqual([]);
    expect(first.map((variant) => variant.query).join("\n")).not.toMatch(
      /roll|d20|target 15|Future Oracle|future vault|hidden answer|private traitor/i
    );
  });

  it("deduplicates equivalent normalized variants without spending one variant's limit on another", () => {
    const plan = planChronicleQueries({
      action: "Approach the Moon Gate",
      entityHints: [{ ordinal: 1, entityId: "world:moon-gate", terms: [" moon   gate "] }],
      sceneHints: [{ ordinal: 1, content: "APPROACH THE MOON GATE" }],
      openThreadHints: [{ ordinal: 1, content: "Approach the Moon Gate" }],
      limits: { action: 80, entity_expanded: 80, scene: 80, open_thread: 80 }
    });

    expect(plan).toEqual([{
      kind: "action",
      query: "Approach the Moon Gate",
      entityIds: ["world:moon-gate"]
    }]);
  });

  it("retains matched entity ids when the exact entity name needs no query expansion", () => {
    const plan = planChronicleQueries({
      action: "Moon Warden",
      entityHints: [{ ordinal: 1, entityId: "world:moon-warden", terms: ["Moon Warden"] }]
    });

    expect(plan).toEqual([{
      kind: "action",
      query: "Moon Warden",
      entityIds: ["world:moon-warden"]
    }]);
  });
});
