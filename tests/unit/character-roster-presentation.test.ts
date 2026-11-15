import { describe, expect, it } from "vitest";
import type { CastCharacter, CastDiscoveryStatus } from "@infinite-quest/contracts";
import { castRosterRow, characterProvenanceLabel, trackingSummary } from "../../packages/client-core/src/index.js";

const person = (changes: Partial<CastCharacter> = {}): CastCharacter => ({ id: "id", name: "Name", aliases: [], origin: { kind: "manual" } as CastCharacter["origin"], profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 0, lastObservedTurn: 4, lastMentionedTurn: null, ...changes });
const origin = (kind: string) => ({ kind } as CastCharacter["origin"]);
const status = (changes: Partial<CastDiscoveryStatus> = {}): CastDiscoveryStatus => ({ enabled: true, activeTurnNumber: 8, coverageStartTurn: null, trackedThroughTurn: null, state: "complete", unresolvedCount: 0, firstGap: null, ...changes });

describe("cast roster presentation", () => {
  it("labels each origin", () => {
    expect(["protagonist", "world", "discovered", "manual"].map(kind => characterProvenanceLabel({ origin: origin(kind) }))).toEqual(["Main character", "From world", "Discovered", "Added by you"]);
  });
  it("orders badges with counts", () => {
    expect(castRosterRow(person({ origin: origin("protagonist"), pinned: true, ignored: true, removed: true }), { review: true, reviewCount: 3, conflict: true, conflictCount: 1 }).badges.map(b => b.label)).toEqual(["Main", "Pinned", "Ignored", "Removed", "Needs review (3)", "Conflict (1)"]);
  });
  it("truncates a role to at most 120 code points including the ellipsis", () => {
    const summary = castRosterRow(person({ profile: { "story.role": "🜂".repeat(130) } })).summary;
    expect(Array.from(summary)).toHaveLength(120); expect(summary.endsWith("…")).toBe(true);
  });
  it("reports the later observed or mentioned turn", () => {
    expect(castRosterRow(person({ lastMentionedTurn: 9 })).lastSeen).toBe("Last seen turn 9");
    expect(castRosterRow(person()).lastSeen).toBe("Last seen turn 4");
  });
  it("summarises tracking states and review counts", () => {
    expect(trackingSummary(null)).toEqual({ tone: "warning", headline: "Character tracking status is unavailable. Saved characters are still available.", details: [] });
    expect(trackingSummary(status({ coverageStartTurn: 2, trackedThroughTurn: 8 }))).toEqual({ tone: "ok", headline: "Character tracking is up to date.", details: ["Tracked turns 2–8. Earlier turns are not included."] });
    expect(trackingSummary(status({ state: "failed" })).tone).toBe("error");
    expect(trackingSummary(status({ state: "catching_up", unresolvedCount: 1 })).details).toContain("1 character match needs review.");
    expect(trackingSummary(status({ unresolvedCount: 2 })).details).toContain("2 character matches need review.");
  });
});
