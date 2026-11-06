import { describe, expect, it } from "vitest";
import { findCastMentions } from "../../packages/domain/src/campaign-cast-mentions.js";
import { buildCastDiscoverySource } from "../../packages/domain/src/campaign-cast-discovery.js";
import type { CastCharacter } from "../../packages/contracts/src/campaign-cast.js";
const uuid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const person = (n: number, name: string, aliases: string[] = []): CastCharacter => ({ id: uuid(n), name, aliases,
  origin: { kind: "manual" }, profile: {}, pinned: false, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 0 });
const source = (narration: string) => buildCastDiscoverySource({ scope: { ownerUserId: uuid(8), campaignId: uuid(9) },
  turnId: uuid(10), turnNumber: 1, narrationRevision: 0, timelineRevision: 0, narration });
describe("lexical cast mentions", () => {
  it.each([
    ["Mara sees Mara.", [person(1, "Mara")], ["Mara", "Mara"]],
    ["I hope so. Hope waits.", [person(1, "Hope")], ["Hope"]],
    ["Émara Mara!", [person(1, "Mara")], ["Mara"]],
    ["Captain waits.", [person(1, "Captain")], []],
    ["Mara waits.", [person(1, "Mara"), { ...person(2, "Other", ["Mara"]), ignored: true }], []],
    ["Mara waits.", [{ ...person(1, "Mara"), origin: { kind: "protagonist", selectedCharacterId: null } }], []]
  ])("matches only unambiguous bounded names in %s", (text, people, quotes) => {
    const found = findCastMentions(source(text), people as CastCharacter[]);
    expect(found.map((item) => item.quote)).toEqual(quotes);
    for (const match of found) expect(text.slice(match.start, match.end)).toBe(match.quote);
  });
});
