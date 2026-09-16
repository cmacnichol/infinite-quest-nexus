import { describe, expect, it } from "vitest";
import { chunkChronicleMemory, DEFAULT_CHRONICLE_CHUNKING_POLICY } from "../../packages/domain/src/chronicle-chunking.js";
import { normalizeStoryEvidenceSource, verifyStoryEvidenceSpan } from "../../packages/domain/src/story-evidence-spans.js";
import { buildAcceptedTurnFictionMemory } from "../../packages/domain/src/chronicle-memory-helpers.js";
import { resolveEmbeddingCapability, splitChunkForCapability } from "../../packages/domain/src/chronicle-embedding-capabilities.js";

describe("exact Chronicle source spans", () => {
  it.each([
    "The bell rings. The bell rings.\r\n\r\nThe bell is silent.",
    "The ﬃ ligature gleams. Ｇates open. 😀".repeat(30),
    "The fox waits. [DC 15] Private reasoning chooses a door. The fox leaves.",
    "😀".repeat(300),
    "unbroken".repeat(300)
  ])("reconstructs every chunk and provider subchunk from normalized fiction source", (content) => {
    const source = normalizeStoryEvidenceSource(content);
    const chunks = chunkChronicleMemory({ id: "parent", memoryKind: "campaign_summary", content },
      { ...DEFAULT_CHRONICLE_CHUNKING_POLICY, targetTokens: 32, overlapTokens: 4 });
    const capability = resolveEmbeddingCapability({ model: "test", contextWindowTokens: 24, requestTimeoutMs: 1000,
      configuration: { embeddingMaxInputTokens: 24 } });
    for (const chunk of [...chunks, ...chunks.flatMap((chunk) => splitChunkForCapability(chunk, capability))]) {
      expect(chunk.sourceEvidence).toBeDefined();
      expect(verifyStoryEvidenceSpan(source, chunk.sourceEvidence!, chunk.content)).toBe(true);
      expect(source.slice(chunk.sourceStartOffset, chunk.sourceEndOffset)).toBe(chunk.content);
      expect(Array.from(chunk.content).every((value) => value.length === 2 || !/[\uD800-\uDFFF]/u.test(value))).toBe(true);
      expect(verifyStoryEvidenceSpan(`${source} edited`, chunk.sourceEvidence!, chunk.content)).toBe(false);
    }
  });
  it("labels direction as intent and recognizes both historical and current labels", () => {
    const memory = buildAcceptedTurnFictionMemory({ accepted: true, action: "The keeper may return.", narration: "The hall is empty.", inputMode: "scene" }, 2)!;
    expect(memory.content).toContain("Story Direction (intent): The keeper may return.");
    for (const content of [memory.content, memory.content.replace("Story Direction (intent):", "Player action:")]) {
      const chunks = chunkChronicleMemory({ id: "parent", memoryKind: "turn_fiction", content });
      expect(chunks.map((chunk) => chunk.kind)).toEqual(["turn_action", "turn_narration"]);
      expect(chunks[1]!.content).toBe("The hall is empty.");
      for (const chunk of chunks) expect(verifyStoryEvidenceSpan(normalizeStoryEvidenceSource(content), chunk.sourceEvidence!, chunk.content)).toBe(true);
    }
  });
  it("does not confuse repeated header text with action offsets and retains lone-surrogate source identity", () => {
    for (const content of ["Turn 7\nPlayer action: Turn 7\nNarration: Turn 7", "The old glyph \uD800 remains."]) {
      const source = normalizeStoryEvidenceSource(content);
      for (const chunk of chunkChronicleMemory({ id: "parent", memoryKind: "turn_fiction", content })) {
        expect(verifyStoryEvidenceSpan(source, chunk.sourceEvidence!, chunk.content)).toBe(true);
      }
    }
  });
});
