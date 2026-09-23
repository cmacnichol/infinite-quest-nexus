import { describe, expect, it } from "vitest";
import { castDiscoveryWorldIdentities } from "../../packages/domain/src/campaign-cast-world-identities.js";

describe("pinned world discovery identities", () => {
  it("excludes unsafe names and aliases instead of restoring raw rejected identity text", () => {
    const result = castDiscoveryWorldIdentities({ entities: [{ id: "mara", kind: "npc", name: "Mara", aliases: ["Watcher", "DC 20"] },
      { id: "mechanics", kind: "npc", name: "DC 20" }], playableCharacters: [{ id: "bad", name: "DC 20", characterText: "hello" }] });
    expect(result).toEqual([{ entityId: "mara", name: "Mara", aliases: ["Watcher"], identityHints: [] }]);
  });
  it("accepts legacy entity maps and playable fiction without serializing mechanics or unknown extensions", () => {
    const result = castDiscoveryWorldIdentities({ entities: {
      mara: { type: "person", name: "Mara", alias: "Watcher", description: "blue eyes", role: "Strength score 20", secret: "hidden" },
      bridge: { type: "location", name: "Bridge", description: "stone bridge" }
    }, playableCharacters: [{ id: "iven", name: "Iven", characterText: "Iven is a ferryman.", privateReasoning: "hidden", rpgStats: ["DC 20"] }] });
    expect(result).toEqual([{ entityId: "mara", name: "Mara", aliases: ["Watcher"], identityHints: ["blue eyes"] },
      { entityId: "iven", name: "Iven", aliases: [], identityHints: ["Iven is a ferryman."] }]);
  });
  it("keeps same-name and conflicting ID declarations available for ambiguity checks", () => {
    const result = castDiscoveryWorldIdentities({ entities: [{ id: "mara", kind: "npc", name: "Mara" },
      { id: "mara-other", kind: "npc", name: "Mara" }], playableCharacters: [{ id: "mara", name: "Mara", characterText: "blue eyes" }] });
    expect(result.map((person) => person.entityId)).toEqual(["mara", "mara-other", "mara"]);
  });
  it("ignores malformed identities and omits oversized hints without turning a prefix into evidence", () => {
    expect(castDiscoveryWorldIdentities(null)).toEqual([]);
    expect(castDiscoveryWorldIdentities({ playableCharacters: [null, {}, { id: "", name: "Mara" }] })).toEqual([]);
    const result = castDiscoveryWorldIdentities({ entities: [{ id: "mara", kind: "npc", name: "Mara", description: "a".repeat(2001) }] });
    expect(result[0]?.identityHints).toEqual([]);
  });
});
