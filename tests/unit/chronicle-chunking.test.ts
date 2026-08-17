import { describe, expect, it } from "vitest";
import {
  CHRONICLE_CHUNK_PROTOCOL_VERSION,
  CHRONICLE_CHUNK_SKIP_REASONS,
  DEFAULT_CHRONICLE_CHUNKING_POLICY,
  chunkChronicleMemory,
  sanitizeChronicleChunkSkipReason,
  type ChronicleMemoryParent
} from "../../packages/domain/src/chronicle-chunking.js";
import { resolveEmbeddingCapability, splitChunkForCapability } from "../../packages/domain/src/chronicle-embedding-capabilities.js";

function parent(overrides: Partial<ChronicleMemoryParent> = {}): ChronicleMemoryParent {
  return {
    id: "memory-1",
    memoryKind: "turn_fiction",
    content: "Turn 7\r\nPlayer action: Open the gate.\r\nNarration: The gate opens into the courtyard.",
    ...overrides
  };
}

describe("Chronicle chunking", () => {
  it("normalizes every supported memory kind into stable fiction-only chunks", () => {
    const parents = [
      parent(),
      parent({ id: "memory-2", memoryKind: "canonical_fact", content: "The gate is open." }),
      parent({ id: "memory-3", memoryKind: "open_thread", content: "Who left the lantern burning?" }),
      parent({ id: "memory-4", memoryKind: "campaign_summary", content: "## Current scene\r\nThe party reached the gate." }),
      parent({ id: "memory-5", memoryKind: "legacy_summary", content: "The party reached the gate." })
    ];

    const chunks = parents.flatMap((value) => chunkChronicleMemory(value, DEFAULT_CHRONICLE_CHUNKING_POLICY));

    expect(chunks.map((chunk) => chunk.kind)).toEqual([
      "turn_action", "turn_narration", "canonical_fact", "open_thread", "campaign_summary", "legacy_summary"
    ]);
    expect(chunks.every((chunk) => chunk.protocolVersion === CHRONICLE_CHUNK_PROTOCOL_VERSION)).toBe(true);
    expect(chunks.every((chunk) => !chunk.content.includes("\r"))).toBe(true);
    expect(chunks.every((chunk) => !/d20|private reasoning/i.test(chunk.content))).toBe(true);
  });

  it("uses NFKC/LF normalized source offsets and identical hashes in identical order", () => {
    const value = parent({
      content: "Turn 7\r\nPlayer action: Open the Ｇate.\r\nNarration: The gate opens."
    });

    const first = chunkChronicleMemory(value, DEFAULT_CHRONICLE_CHUNKING_POLICY);
    const second = chunkChronicleMemory(value, DEFAULT_CHRONICLE_CHUNKING_POLICY);

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      content: "Open the Gate.",
      sourceStartOffset: 22,
      sourceEndOffset: 36
    });
    expect(first.map((chunk) => chunk.contentHash)).toEqual([
      "0c57f35a06841391b7be0e7deff4457f90d3f319a6d6c1d38c25896b5bc86fd7",
      "abcacc8cf39120c4ca02d0ad0c9f9197b012652b862eddee5003b9c17c08c64d"
    ]);
  });

  it("paragraph-packs summaries, splits sentences, and preserves adjacency overlap", () => {
    const sentence = (word: string, count: number) => `${Array.from({ length: count }, () => word).join(" ")}.`;
    const summary = [sentence("first", 100), sentence("second", 80), "", sentence("third", 80)].join("\n\n");

    const chunks = chunkChronicleMemory(parent({ memoryKind: "campaign_summary", content: summary }), {
      ...DEFAULT_CHRONICLE_CHUNKING_POLICY,
      targetTokens: 300,
      overlapTokens: 32
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.content).toContain("first");
    expect(chunks[0]?.content).toContain("second");
    expect(chunks[1]?.content).toContain("second");
    expect(chunks[1]?.content).toContain("third");
    expect(chunks.every((chunk) => chunk.estimatedTokens <= 300)).toBe(true);
  });

  it("splits a single overlong sentence at deterministic word boundaries", () => {
    const chunks = chunkChronicleMemory(parent({
      memoryKind: "campaign_summary",
      content: `${Array.from({ length: 220 }, (_, index) => `word${index}`).join(" ")}.`
    }), {
      ...DEFAULT_CHRONICLE_CHUNKING_POLICY,
      targetTokens: 64,
      overlapTokens: 0
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.estimatedTokens <= 64)).toBe(true);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index));
  });

  it("never lets adjacency overlap make a packed narration exceed its token target", () => {
    const sentence = (word: string, count: number) => `${Array.from({ length: count }, () => word).join(" ")}.`;
    const chunks = chunkChronicleMemory(parent({
      memoryKind: "campaign_summary",
      content: `${sentence("first", 100)} ${sentence("second", 160)}`
    }), {
      ...DEFAULT_CHRONICLE_CHUNKING_POLICY,
      targetTokens: 300,
      overlapTokens: 32
    });

    expect(chunks.every((chunk) => chunk.estimatedTokens <= 300)).toBe(true);
  });

  it("drops mechanics and private reasoning before any chunk is drafted", () => {
    const chunks = chunkChronicleMemory(parent({
      content: "Turn 7\nPlayer action: Roll a d20.\nNarration: The fox crosses the courtyard. Private reasoning chooses the hidden door. The lantern goes dark."
    }), DEFAULT_CHRONICLE_CHUNKING_POLICY);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain("The fox crosses the courtyard.");
    expect(chunks[0]?.content).toContain("The lantern goes dark.");
    expect(JSON.stringify(chunks)).not.toMatch(/d20|private reasoning/i);
  });

  it("resplits an oversized chunk after reserving document prefix and safety tokens", () => {
    const oversized = chunkChronicleMemory(parent({
      memoryKind: "campaign_summary",
      content: `${Array.from({ length: 160 }, () => "courtyard").join(" ")}.`
    }), DEFAULT_CHRONICLE_CHUNKING_POLICY)[0]!;
    const capability = resolveEmbeddingCapability({
      model: "nomic-embed-text-v1.5",
      contextWindowTokens: 128,
      requestTimeoutMs: 9_000,
      configuration: { embeddingMaxInputTokens: 128 }
    });

    const split = splitChunkForCapability(oversized, capability);

    expect(split.length).toBeGreaterThan(1);
    expect(split.every((chunk) =>
      chunk.estimatedTokens + capability.documentPrefixTokens + capability.safetyMarginTokens
        <= capability.maxInputTokens
    )).toBe(true);
  });

  it("preserves declared skip reasons and collapses anything else into the generic bucket", () => {
    for (const reason of CHRONICLE_CHUNK_SKIP_REASONS) {
      expect(sanitizeChronicleChunkSkipReason(reason)).toBe(reason);
    }
    expect(sanitizeChronicleChunkSkipReason(null)).toBeNull();
    expect(sanitizeChronicleChunkSkipReason("")).toBeNull();
    expect(sanitizeChronicleChunkSkipReason(undefined)).toBeNull();
  });

  it("never returns provider text, endpoints, or credentials as a skip reason", () => {
    for (const unsafe of [
      "https://provider.invalid?token=must-not-persist",
      "Bearer sk-live-abcdef",
      "connect ECONNREFUSED 10.0.0.5:11434",
      "SEMANTIC_RETRIEVAL_DISABLED"
    ]) {
      expect(sanitizeChronicleChunkSkipReason(unsafe)).toBe("chunk_embedding_skipped");
    }
  });

  it("declares every skip reason as a safe lowercase retrieval code", () => {
    for (const reason of CHRONICLE_CHUNK_SKIP_REASONS) {
      expect(reason).toMatch(/^[a-z0-9][a-z0-9_.:-]*$/u);
    }
    expect(new Set(CHRONICLE_CHUNK_SKIP_REASONS).size).toBe(CHRONICLE_CHUNK_SKIP_REASONS.length);
  });
});
