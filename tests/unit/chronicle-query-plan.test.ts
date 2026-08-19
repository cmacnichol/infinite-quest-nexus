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

  it("orders normalized Unicode terms by stable code points instead of the host locale", () => {
    const plan = planChronicleQueries({
      action: "Seek the herald",
      entityHints: [
        { ordinal: 1, entityId: "world:äther", terms: ["Äther"] },
        { ordinal: 1, entityId: "world:zeta", terms: ["Zeta"] }
      ]
    });

    expect(plan.find((variant) => variant.kind === "entity_expanded")).toEqual({
      kind: "entity_expanded",
      query: "Seek the herald Zeta Äther",
      entityIds: ["world:zeta", "world:äther"]
    });
  });

  it("omits an open-thread variant when action and scene already cover its substantive terms", () => {
    const plan = planChronicleQueries({
      action: "Ask Mara about the moon gate",
      sceneHints: [{ ordinal: 2, content: "Mara waits beside the moon gate." }],
      openThreadHints: [{ ordinal: 2, content: "Ask Mara about the moon gate again." }]
    });

    expect(plan.map((variant) => variant.kind)).toEqual(["action", "scene"]);
  });

  it("does not treat case, punctuation, Unicode forms, or connective words as novel query information", () => {
    const plan = planChronicleQueries({
      action: "Seek the Moon Gate",
      sceneHints: [{ ordinal: 2, content: "Shade waits beside the gate." }],
      openThreadHints: [{ ordinal: 2, content: "About THE ＭＯＯＮ-gate; SHADE, again with their." }]
    });

    expect(plan.map((variant) => variant.kind)).toEqual(["action", "scene"]);
  });

  it("retains entity expansion when it carries a newly scoped entity id despite overlapping visible terms", () => {
    const plan = planChronicleQueries({
      action: "Find Mara",
      entityHints: [
        { ordinal: 2, entityId: "world:moon-gate", terms: ["Moon Gate"] },
        { ordinal: 2, entityId: "world:mara", terms: ["Mara"] }
      ]
    });

    expect(plan).toEqual([
      { kind: "action", query: "Find Mara", entityIds: [] },
      {
        kind: "entity_expanded",
        query: "Find Mara Moon Gate",
        entityIds: ["world:mara", "world:moon-gate"]
      }
    ]);
  });

  it("retains scene and open-thread variants when a vague action lacks their substantive names and events", () => {
    const plan = planChronicleQueries({
      action: "Ask him about it again",
      sceneHints: [{ ordinal: 2, content: "Captain Rhea enters the Observatory." }],
      openThreadHints: [{ ordinal: 2, content: "Recover the Astral Key before dawn." }]
    });

    expect(plan.map((variant) => variant.kind)).toEqual(["action", "scene", "open_thread"]);
  });

  it("excludes future-only hints before checking distinct query information", () => {
    const plan = planChronicleQueries({
      action: "Seek the moon gate",
      throughTurnNumber: 2,
      sceneHints: [
        { ordinal: 2, content: "The moon gate opens at dusk." },
        { ordinal: 3, content: "The Future Oracle names the hidden vault." }
      ],
      openThreadHints: [{ ordinal: 3, content: "Ask the Future Oracle about the hidden vault." }]
    });

    expect(plan.map((variant) => variant.kind)).toEqual(["action", "scene"]);
    expect(plan.map((variant) => variant.query).join("\n")).not.toMatch(/future oracle|hidden vault/i);
  });
});
