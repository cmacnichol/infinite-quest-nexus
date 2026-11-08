import { describe, expect, it } from "vitest";
import { previewEntityConversions } from "../../packages/client-core/src/characters/entity-conversion.js";

describe("entity conversion preview", () => {
  it("maps legacy entity maps and reports fields left on the entity", () => {
    const [preview] = previewEntityConversions({ old: { type: "npc", name: "Mara", alias: "Watcher", role: "Guide", lore: "A sailor", description: "Blue coat", age: 40 } });
    expect(preview).toMatchObject({ entityId: "old", name: "Mara", unconverted: { age: 40 },
      profile: { identity: { aliases: ["Watcher"] }, story: { role: "Guide", background: "A sailor" }, unclassifiedNotes: "Blue coat" } });
  });
  it("skips non-people and already linked records", () => {
    expect(previewEntityConversions([{ id: "a", kind: "npc", name: "A", linkedCharacterId: "existing" }, { id: "b", kind: "place", name: "B" }])).toEqual([]);
  });
});
