import { describe, expect, it } from "vitest";
import {
  chronicleParentTokens,
  selectDiverseChronicleParents,
  type ChronicleParentCandidate
} from "../../packages/domain/src/chronicle-diversity.js";

function candidate(overrides: Partial<ChronicleParentCandidate> = {}): ChronicleParentCandidate {
  return {
    candidateId: "chunk-a",
    parentMemoryId: "parent-a",
    parentTurnId: "turn-a",
    ordinal: 4,
    memoryKind: "turn_fiction",
    parentContent: "Turn 4\nPlayer action: Open the western gate.\nNarration: Moonlight fills the court.",
    parentMetadata: {},
    entities: ["Western Gate"],
    entityIds: ["world:western-gate"],
    chunkOrdinal: 0,
    chunkKind: "turn_action",
    chunkContent: "Open the western gate.",
    embedding: [1, 0],
    fusedRank: 1,
    ...overrides
  };
}

describe("Chronicle parent diversity", () => {
  it("skips an oversized parent and selects a later parent that fits the token allowance", () => {
    const fittingContent = "A compact, later parent.";
    const selection = selectDiverseChronicleParents([
      candidate({
        candidateId: "oversized",
        parentMemoryId: "oversized-parent",
        parentTurnId: "oversized-turn",
        parentContent: "Oversized parent. ".repeat(400),
        chunkContent: "Oversized parent. ".repeat(400),
        fusedRank: 1
      }),
      candidate({
        candidateId: "fitting",
        parentMemoryId: "fitting-parent",
        parentTurnId: "fitting-turn",
        parentContent: "A compact, later parent.",
        chunkContent: "A compact, later parent.",
        fusedRank: 2
      })
    ], { maximumParents: 2, maximumParentTokens: chronicleParentTokens(fittingContent) });

    expect(selection.parents.map((parent) => parent.parentMemoryId)).toEqual(["fitting-parent"]);
    expect(selection.diagnostics).toMatchObject({
      maximumParentTokens: chronicleParentTokens(fittingContent),
      selectedParentTokens: chronicleParentTokens(fittingContent),
      tokenLimitParentsRemoved: 1,
      stopReason: "token_limit"
    });
  });

  it("includes a parent exactly at the token boundary and terminates zero, negative, and invalid token allowances", () => {
    const content = "Exact boundary parent.";
    const exact = selectDiverseChronicleParents([
      candidate({ parentContent: content, chunkContent: content })
    ], { maximumParents: 1, maximumParentTokens: chronicleParentTokens(content) });
    const invalid = selectDiverseChronicleParents([
      candidate({ parentContent: content, chunkContent: content })
    ], { maximumParents: 1, maximumParentTokens: Number.NaN });
    const zero = selectDiverseChronicleParents([
      candidate({ parentContent: content, chunkContent: content })
    ], { maximumParents: 1, maximumParentTokens: 0 });
    const negative = selectDiverseChronicleParents([
      candidate({ parentContent: content, chunkContent: content })
    ], { maximumParents: 1, maximumParentTokens: -1 });

    expect(exact.parents).toHaveLength(1);
    expect(exact.diagnostics).toMatchObject({ selectedParentTokens: chronicleParentTokens(content), stopReason: "exhausted" });
    expect(invalid.parents).toEqual([]);
    expect(invalid.diagnostics).toMatchObject({ maximumParentTokens: 0, selectedParentTokens: 0, stopReason: "token_limit" });
    expect(zero.diagnostics).toMatchObject({ maximumParentTokens: 0, selectedParentTokens: 0, tokenLimitParentsRemoved: 1, stopReason: "token_limit" });
    expect(negative.diagnostics).toMatchObject({ maximumParentTokens: 0, selectedParentTokens: 0, tokenLimitParentsRemoved: 1, stopReason: "token_limit" });
  });

  it("keeps an excerpt-capable turn candidate when its complete parent exceeds the allowance", () => {
    const certifiedExcerpt = "Narration: The verified narration excerpt names the moon gate.";
    const selection = selectDiverseChronicleParents([
      candidate({
        parentContent: `Turn 4\\n${"Unrelated narration. ".repeat(500)}`,
        chunkContent: "Unrelated narration. ".repeat(500),
        chunkKind: "turn_narration",
        tokenContent: certifiedExcerpt,
        fusedRank: 1
      })
    ], {
      maximumParents: 1,
      maximumParentTokens: chronicleParentTokens(certifiedExcerpt)
    });

    expect(selection.parents).toMatchObject([{ content: `Narration: ${"Unrelated narration. ".repeat(500)}` }]);
    expect(selection.diagnostics).toMatchObject({ stopReason: "exhausted", selectedParentTokens: chronicleParentTokens(certifiedExcerpt) });
  });

  it("charges the complete source when a narration chunk has no verified excerpt projection", () => {
    const chunk = "Narration: compact chunk.";
    const selection = selectDiverseChronicleParents([candidate({
      parentContent: `Turn 4\\n${"Unverified source. ".repeat(500)}`,
      chunkKind: "turn_narration",
      chunkContent: "compact chunk."
    })], { maximumParents: 1, maximumParentTokens: chronicleParentTokens(chunk) });

    expect(selection.parents).toEqual([]);
    expect(selection.diagnostics).toMatchObject({ selectedParentTokens: 0, tokenLimitParentsRemoved: 1, stopReason: "token_limit" });
  });

  it.each([
    {
      chunkKind: "turn_action" as const,
      memoryKind: "turn_fiction" as const,
      parentContent: "Turn 4\nPlayer action: Open the western gate.\nNarration: Moonlight fills the court.",
      chunkContent: "Open the western gate.",
      siblings: [candidate({
        candidateId: "chunk-narration",
        chunkOrdinal: 1,
        chunkKind: "turn_narration",
        chunkContent: "Moonlight fills the court.",
        fusedRank: 8
      })],
      expected: "Player action: Open the western gate.\nNarration: Moonlight fills the court."
    },
    {
      chunkKind: "turn_narration" as const,
      memoryKind: "turn_fiction" as const,
      parentContent: "Turn 4\nPlayer action: Open the western gate.\nNarration: Moonlight fills the court.",
      chunkContent: "Moonlight fills the court.",
      siblings: [candidate({
        candidateId: "chunk-action",
        chunkOrdinal: 0,
        chunkKind: "turn_action",
        chunkContent: "Open the western gate.",
        fusedRank: 8
      })],
      expected: "Player action: Open the western gate.\nNarration: Moonlight fills the court."
    },
    {
      chunkKind: "campaign_summary" as const,
      memoryKind: "campaign_summary" as const,
      parentContent: "The full campaign summary contains unrelated history.",
      chunkContent: "The moon sigil opens the western gate at midnight.",
      siblings: [],
      expected: "The moon sigil opens the western gate at midnight."
    },
    {
      chunkKind: "legacy_summary" as const,
      memoryKind: "legacy_summary" as const,
      parentContent: "The full legacy summary contains unrelated history.",
      chunkContent: "The moon sigil opens the western gate at midnight.",
      siblings: [],
      expected: "The moon sigil opens the western gate at midnight."
    },
    {
      chunkKind: "canonical_fact" as const,
      memoryKind: "canonical_fact" as const,
      parentContent: "The complete canonical fact remains atomic.",
      chunkContent: "A clipped canonical fact would be wrong.",
      siblings: [],
      expected: "The complete canonical fact remains atomic."
    },
    {
      chunkKind: "open_thread" as const,
      memoryKind: "open_thread" as const,
      parentContent: "The complete open thread remains atomic.",
      chunkContent: "A clipped open thread would be wrong.",
      siblings: [],
      expected: "The complete open thread remains atomic."
    }
  ])("renders the matched $chunkKind chunk without changing parent selection", ({
    chunkKind,
    memoryKind,
    parentContent,
    chunkContent,
    siblings,
    expected
  }) => {
    const selection = selectDiverseChronicleParents([
      candidate({ chunkKind, memoryKind, parentContent, chunkContent, fusedRank: 1 }),
      ...siblings
    ], { maximumParents: 8, includeAdjacentNarration: true });

    expect(selection.parents[0]?.content).toBe(expected);
    expect(selection.diagnostics).toMatchObject({
      candidateChunks: siblings.length + 1,
      candidateParents: 1,
      collapsedChunks: siblings.length,
      selectedParents: 1
    });
  });

  it.each([
    {
      chunkKind: "turn_narration" as const,
      chunkContent: "Moonlight fills the court.",
      expected: "Narration: Moonlight fills the court."
    },
    {
      chunkKind: "turn_action" as const,
      chunkContent: "Open the western gate.",
      expected: "Player action: Open the western gate."
    }
  ])("renders a $chunkKind chunk without its missing sibling", ({ chunkKind, chunkContent, expected }) => {
    const selection = selectDiverseChronicleParents([
      candidate({ chunkKind, chunkContent, fusedRank: 1 })
    ], { maximumParents: 8, includeAdjacentNarration: true });

    expect(selection.parents[0]?.content).toBe(expected);
  });

  it("can render a strongest action chunk with its adjacent narration as a coherent excerpt", () => {
    const selection = selectDiverseChronicleParents([
      candidate({ candidateId: "chunk-action", chunkOrdinal: 0, fusedRank: 1 }),
      candidate({
        candidateId: "chunk-narration",
        chunkOrdinal: 1,
        chunkKind: "turn_narration",
        chunkContent: "Moonlight fills the court.",
        fusedRank: 6
      })
    ], { maximumParents: 8, includeAdjacentNarration: true });

    expect(selection.parents[0]?.content).toBe(
      "Player action: Open the western gate.\nNarration: Moonlight fills the court."
    );
  });

  it("limits optional history to two selected parents from the same turn", () => {
    const selection = selectDiverseChronicleParents([
      candidate({ candidateId: "chunk-a", parentMemoryId: "parent-a", parentContent: "First parent.", fusedRank: 1 }),
      candidate({
        candidateId: "chunk-b",
        parentMemoryId: "parent-b",
        parentContent: "Second parent.",
        fusedRank: 2,
        memoryKind: "canonical_fact"
      }),
      candidate({
        candidateId: "chunk-c",
        parentMemoryId: "parent-c",
        parentContent: "Third parent.",
        fusedRank: 3,
        memoryKind: "open_thread"
      }),
      candidate({
        candidateId: "chunk-d",
        parentMemoryId: "parent-d",
        parentTurnId: "turn-b",
        parentContent: "Fourth parent.",
        ordinal: 5,
        fusedRank: 4
      })
    ], { maximumParents: 8 });

    expect(selection.parents.map((parent) => parent.parentMemoryId)).toEqual(["parent-a", "parent-b", "parent-d"]);
    expect(selection.diagnostics).toMatchObject({ turnLimitParentsRemoved: 1 });
  });

  it("removes duplicate parent content with deterministic NFKC lowercase hashes", () => {
    const selection = selectDiverseChronicleParents([
      candidate({
        candidateId: "chunk-cafe-a",
        parentMemoryId: "parent-a",
        parentTurnId: "turn-a",
        parentContent: "Caf\u00e9 opens at moonrise.",
        fusedRank: 1
      }),
      candidate({
        candidateId: "chunk-cafe-b",
        parentMemoryId: "parent-b",
        parentTurnId: "turn-b",
        parentContent: "  CAFE\u0301   OPENS AT MOONRISE.  ",
        fusedRank: 2
      })
    ], { maximumParents: 8 });

    expect(selection.parents.map((parent) => parent.parentMemoryId)).toEqual(["parent-a"]);
    expect(selection.diagnostics).toMatchObject({ normalizedDuplicatesRemoved: 1 });
  });

  it("collapses canonical parents that carry the same structured fact lineage", () => {
    const selection = selectDiverseChronicleParents([
      candidate({
        candidateId: "chunk-fact-a",
        parentMemoryId: "fact-parent-a",
        parentTurnId: "turn-a",
        memoryKind: "canonical_fact",
        parentContent: "The moon key opens the gate.",
        parentMetadata: { structuredFactIds: ["fact-root", "fact-current"] },
        fusedRank: 1
      }),
      candidate({
        candidateId: "chunk-fact-b",
        parentMemoryId: "fact-parent-b",
        parentTurnId: "turn-b",
        memoryKind: "canonical_fact",
        parentContent: "The gate answers to the moon key.",
        parentMetadata: { structuredFactIds: ["fact-current"] },
        fusedRank: 2
      })
    ], { maximumParents: 8 });

    expect(selection.parents.map((parent) => parent.parentMemoryId)).toEqual(["fact-parent-a"]);
    expect(selection.diagnostics).toMatchObject({ canonicalLineagesCollapsed: 1 });
  });

  it("uses cosine similarity only as a penalty against parents already selected", () => {
    const selection = selectDiverseChronicleParents([
      candidate({
        candidateId: "chunk-first",
        parentMemoryId: "parent-first",
        parentTurnId: "turn-first",
        parentContent: "The moon gate opens.",
        fusedRank: 1,
        embedding: [1, 0]
      }),
      candidate({
        candidateId: "chunk-similar",
        parentMemoryId: "parent-similar",
        parentTurnId: "turn-similar",
        parentContent: "The moon gate stands open.",
        fusedRank: 2,
        embedding: [0.99, 0.01]
      }),
      candidate({
        candidateId: "chunk-different",
        parentMemoryId: "parent-different",
        parentTurnId: "turn-different",
        parentContent: "The river oracle names a new debt.",
        fusedRank: 3,
        embedding: [0, 1]
      })
    ], { maximumParents: 3, semanticSimilarityPenalty: 4 });

    expect(selection.parents.map((parent) => parent.parentMemoryId)).toEqual([
      "parent-first",
      "parent-different",
      "parent-similar"
    ]);
    expect(selection.diagnostics).toMatchObject({ semanticPenaltiesApplied: 1 });
  });

  it("prefers variety across memory kinds and entities when fused ranks are close", () => {
    const selection = selectDiverseChronicleParents([
      candidate({
        candidateId: "chunk-first",
        parentMemoryId: "parent-first",
        parentTurnId: "turn-first",
        parentContent: "The western gate opens.",
        fusedRank: 1,
        embedding: null
      }),
      candidate({
        candidateId: "chunk-repeated",
        parentMemoryId: "parent-repeated",
        parentTurnId: "turn-repeated",
        parentContent: "The western gate remains open.",
        fusedRank: 2,
        embedding: null
      }),
      candidate({
        candidateId: "chunk-varied",
        parentMemoryId: "parent-varied",
        parentTurnId: "turn-varied",
        parentContent: "Discover why the river oracle vanished.",
        memoryKind: "open_thread",
        entities: ["River Oracle"],
        entityIds: ["world:river-oracle"],
        fusedRank: 3,
        embedding: null
      })
    ], {
      maximumParents: 3,
      kindDiversityBonus: 2,
      entityDiversityBonus: 1
    });

    expect(selection.parents.map((parent) => parent.parentMemoryId)).toEqual([
      "parent-first",
      "parent-varied",
      "parent-repeated"
    ]);
    expect(selection.diagnostics).toMatchObject({ selectedKinds: 2, selectedEntityIds: 2 });
  });

  it("protects the latest scene from duplication in optional Chronicle history", () => {
    const selection = selectDiverseChronicleParents([
      candidate({
        candidateId: "chunk-latest",
        parentMemoryId: "parent-latest",
        parentTurnId: "turn-latest",
        parentContent: "The current scene belongs only in currentScene.",
        ordinal: 9,
        fusedRank: 1
      }),
      candidate({
        candidateId: "chunk-history",
        parentMemoryId: "parent-history",
        parentTurnId: "turn-history",
        parentContent: "An earlier scene remains useful history.",
        ordinal: 8,
        fusedRank: 2
      })
    ], { maximumParents: 8, latestSceneParentMemoryId: "parent-latest" });

    expect(selection.parents.map((parent) => parent.parentMemoryId)).toEqual(["parent-history"]);
    expect(selection.diagnostics).toMatchObject({ latestSceneParentsProtected: 1 });
  });

  it("breaks fused-rank ties by ordinal and parent ID without exposing candidate payloads", () => {
    const selection = selectDiverseChronicleParents([
      candidate({
        candidateId: "secret-chunk-z",
        parentMemoryId: "parent-z",
        parentTurnId: "turn-z",
        parentContent: "Private candidate z.",
        ordinal: 2,
        embedding: [0.25, 0.75],
        fusedRank: 1
      }),
      candidate({
        candidateId: "secret-chunk-b",
        parentMemoryId: "parent-b",
        parentTurnId: "turn-b",
        parentContent: "Private candidate b.",
        ordinal: 1,
        embedding: [0.75, 0.25],
        fusedRank: 1
      }),
      candidate({
        candidateId: "secret-chunk-a",
        parentMemoryId: "parent-a",
        parentTurnId: "turn-a",
        parentContent: "Private candidate a.",
        ordinal: 1,
        embedding: [0.5, 0.5],
        fusedRank: 1
      })
    ], {
      maximumParents: 3,
      semanticSimilarityPenalty: 0,
      kindDiversityBonus: 0,
      entityDiversityBonus: 0
    });

    expect(selection.parents.map((parent) => parent.parentMemoryId)).toEqual([
      "parent-a",
      "parent-b",
      "parent-z"
    ]);
    const diagnostics = JSON.stringify(selection.diagnostics);
    expect(diagnostics).not.toMatch(/secret-chunk|private candidate|0\.25|0\.75/i);
  });

  it("updates vector similarity once per remaining candidate as the parent budget grows", () => {
    const candidateCount = 96;
    const selectedCount = 32;
    const vectorDimensions = 3;
    let vectorElementReads = 0;
    const countedVector = (seed: number): readonly number[] => new Proxy([
      1 + seed / 1000,
      0.5 + (seed % 7) / 100,
      0.25 + (seed % 11) / 100
    ], {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) vectorElementReads += 1;
        return Reflect.get(target, property, receiver);
      }
    }) as unknown as readonly number[];
    const selection = selectDiverseChronicleParents(
      Array.from({ length: candidateCount }, (_, index) => candidate({
        candidateId: `chunk-${index}`,
        parentMemoryId: `parent-${index}`,
        parentTurnId: null,
        ordinal: index,
        parentContent: `Distinct parent ${index}.`,
        embedding: countedVector(index),
        fusedRank: index + 1
      })),
      {
        maximumParents: selectedCount,
        semanticSimilarityPenalty: 4,
        kindDiversityBonus: 0,
        entityDiversityBonus: 0
      }
    );

    expect(selection.parents).toHaveLength(selectedCount);
    expect(vectorElementReads).toBeLessThanOrEqual(2 * vectorDimensions * candidateCount * selectedCount + 256);
  });
});
