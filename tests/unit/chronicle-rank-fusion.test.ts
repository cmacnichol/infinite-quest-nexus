import { describe, expect, it } from "vitest";
import {
  fuseChronicleRanks,
  type ChronicleRankCandidate,
  type ChronicleRankInput
} from "../../packages/domain/src/chronicle-rank-fusion.js";

function candidate(
  candidateId: string,
  parentMemoryId: string,
  overrides: Partial<ChronicleRankCandidate> = {}
): ChronicleRankCandidate {
  return {
    candidateId,
    parentMemoryId,
    parentTurnId: null,
    parentOrdinal: 1,
    memoryKind: "turn_fiction",
    activeFact: true,
    ...overrides
  };
}

describe("query family maximum aggregation", () => {
  it("does not grant repeated action fragments extra votes and retains late-only and thread candidates", () => {
    const early = candidate("early", "early");
    const late = candidate("late", "late");
    const thread = candidate("thread", "thread");
    const inputs = [0, 1, 2, 3].map((index) => ({
      signal: "semantic" as const, variant: "action" as const, variantId: `segment-${index}`,
      candidates: index === 3 ? [early, late] : [early]
    }));
    const profile = { rrfK: 60, weights: {}, rankAggregation: "query_family_max_v1" as const };
    const fused = fuseChronicleRanks([...inputs, { signal: "semantic", variant: "open_thread", variantId: "thread", candidates: [thread] }], profile);
    expect(fused.find((value) => value.candidateId === "early")?.score).toBe(1 / 61);
    expect(fused.find((value) => value.candidateId === "thread")?.score).toBe(1 / 61);
    expect(fused.find((value) => value.candidateId === "late")?.score).toBe(1 / 62);
    expect(fused.find((value) => value.candidateId === "early")?.contributions).toHaveLength(4);
    expect(fuseChronicleRanks(inputs, profile)).toEqual(fuseChronicleRanks([...inputs].reverse(), profile));
    expect(fuseChronicleRanks(inputs, { rrfK: 60, weights: {} })[0]?.score).toBe(4 / 61);
  });
});

describe("Chronicle reciprocal-rank fusion", () => {
  it("fuses separate signal lists and breaks equal scores by parent id", () => {
    const parentA = candidate("chunk-a", "parent-a");
    const parentB = candidate("chunk-b", "parent-b");
    const inputs: readonly ChronicleRankInput[] = [
      { signal: "semantic", variant: "action", candidates: [parentB, parentA] },
      { signal: "full_text", variant: "action", candidates: [parentA, parentB] }
    ];
    const weights = {
      signals: { semantic: 1, full_text: 1 },
      variants: { action: 1 }
    } as const;

    expect(fuseChronicleRanks(inputs, { rrfK: 60, weights }).map((value) => value.parentMemoryId))
      .toEqual(["parent-a", "parent-b"]);
  });

  it("excludes inactive canonical facts before assigning ranks", () => {
    const inactive = candidate("chunk-inactive", "parent-inactive", {
      memoryKind: "canonical_fact",
      activeFact: false
    });
    const active = candidate("chunk-active", "parent-active", {
      memoryKind: "canonical_fact",
      activeFact: true
    });

    const fused = fuseChronicleRanks([
      { signal: "semantic", variant: "entity_expanded", candidates: [inactive, active] },
      { signal: "importance", variant: "action", candidates: [inactive, active] }
    ], {
      rrfK: 20,
      weights: {
        signals: { semantic: 1, importance: 1 },
        variants: { action: 1, entity_expanded: 1 }
      }
    });

    expect(fused.map((value) => value.parentMemoryId)).toEqual(["parent-active"]);
    expect(fused[0]?.contributions.map((value) => value.rank)).toEqual([1, 1]);
  });

  it("applies signal and variant weights without counting duplicate candidates twice in one list", () => {
    const exact = candidate("chunk-exact", "parent-exact");
    const semantic = candidate("chunk-semantic", "parent-semantic");
    const fused = fuseChronicleRanks([
      { signal: "full_text", variant: "action", candidates: [exact, exact, semantic] },
      { signal: "semantic", variant: "scene", candidates: [semantic, exact] }
    ], {
      rrfK: 20,
      weights: {
        signals: { full_text: 1, semantic: 2 },
        variants: { action: 1, scene: 1.5 }
      }
    });

    expect(fused.map((value) => value.parentMemoryId)).toEqual(["parent-semantic", "parent-exact"]);
    expect(fused.find((value) => value.parentMemoryId === "parent-exact")?.contributions).toHaveLength(2);
  });

  it("breaks Unicode ties by stable code points instead of the host locale", () => {
    const fused = fuseChronicleRanks([{
      signal: "recency",
      variant: "action",
      candidates: [
        candidate("chunk-ä", "parent-ä"),
        candidate("chunk-z", "parent-z")
      ]
    }], { rrfK: 0, weights: {} });

    expect(fused.map((value) => value.parentMemoryId)).toEqual(["parent-ä", "parent-z"]);
    const tied = fuseChronicleRanks([
      { signal: "recency", variant: "action", candidates: [candidate("chunk-ä", "parent-ä")] },
      { signal: "chronology", variant: "action", candidates: [candidate("chunk-z", "parent-z")] }
    ], { rrfK: 60, weights: {} });
    expect(tied.map((value) => value.parentMemoryId)).toEqual(["parent-z", "parent-ä"]);
  });
});
