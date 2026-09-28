import { describe, expect, it } from "vitest";
import { planChronicleQueries, sceneHintTail } from "../../packages/domain/src/chronicle-query-plan.js";

describe("Chronicle query planning", () => {
  it("normalizes and bounds a scene tail without losing the ending or splitting Unicode", () => {
    expect(sceneHintTail("", 1000)).toBe("");
    expect(sceneHintTail("  A quiet   scene.\n", 1000)).toBe("A quiet scene.");
    expect(sceneHintTail(`OPENING_CANARY ${"word ".repeat(300)}ENDING_CANARY`, 1_000)).toContain("ENDING_CANARY");
    expect(sceneHintTail(`OPENING_CANARY ${"word ".repeat(300)}ENDING_CANARY`, 1_000)).not.toContain("OPENING_CANARY");
    expect(sceneHintTail(`OPENING_CANARY ${"word ".repeat(300)}ENDING_CANARY`, 1_000).length).toBeLessThanOrEqual(1_000);
    expect(sceneHintTail(`OPENING_CANARY ${"x".repeat(1_200)}ENDING_CANARY`, 80)).toContain("ENDING_CANARY");
    expect(sceneHintTail(`OPENING_CANARY ${"x".repeat(1_200)}ENDING_CANARY`, 80).length).toBeLessThanOrEqual(80);
    expect(sceneHintTail(`OPENING_CANARY ${"story ".repeat(300)}ENDING_CANARY`, 100)).toContain("ENDING_CANARY");
    expect(sceneHintTail("A multibyte 🧙🏽‍♀️ ending", 8)).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(sceneHintTail("prefix 🧙", 2)).toBe("🧙");
    expect(sceneHintTail("prefix 👩‍🚀", 3)).toBe("");
    expect(sceneHintTail("prefix 👩‍🚀", 5)).toBe("👩‍🚀");
    expect(sceneHintTail("A multibyte 🧙🏽‍♀️ ending", 0)).toBe("");
    expect(sceneHintTail("A multibyte 🧙🏽‍♀️ ending", -1)).toBe("");
    expect(sceneHintTail("A multibyte 🧙🏽‍♀️ ending", Number.NaN)).toBe("");
    expect(sceneHintTail("A multibyte 🧙🏽‍♀️ ending", Number.POSITIVE_INFINITY)).toBe("");
    expect(sceneHintTail("A multibyte 🧙🏽‍♀️ ending", 1.5)).toBe("");
    expect(sceneHintTail("A multibyte 🧙🏽‍♀️ ending", 5_000).length).toBeLessThanOrEqual(1_000);
  });

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

  it("retains entity expansion solely for a fresh entity id when normalized visible terms add nothing", () => {
    const plan = planChronicleQueries({
      action: "Find Mara",
      entityHints: [{ ordinal: 2, entityId: "world:mara", terms: ["Mara!"] }]
    });

    expect(plan).toEqual([
      { kind: "action", query: "Find Mara", entityIds: [] },
      {
        kind: "entity_expanded",
        query: "Find Mara Mara!",
        entityIds: ["world:mara"]
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
