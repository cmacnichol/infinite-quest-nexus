import { describe, expect, it } from "vitest";
import { normalizeSourceDocument } from "../../packages/domain/src/source-authoring.js";
import {
  assertSourceCoverage,
  planSourceChunks,
  type AuthoringBudget,
  type SourceChunk
} from "../../packages/domain/src/index.js";

const byteBudget = (contextWindowTokens = 1_000, maxOutputTokens = 100): AuthoringBudget => ({
  contextWindowTokens,
  maxOutputTokens,
  countTokens: (text) => new TextEncoder().encode(text).length
});

function chunkText(sourceText: string, chunks: readonly SourceChunk[]): string {
  const codePoints = Array.from(sourceText);
  return chunks.flatMap((chunk) => chunk.spans.map((span) => codePoints.slice(span.start, span.end).join(""))).join("");
}

describe("source authoring budget", () => {
  it("packs the complete selected prefix into byte-budgeted requests and excludes the tail", () => {
    const source = normalizeSourceDocument(
      "chapter.txt",
      "First scene.\n\nSecond scene with an emoji 😀.\n\nThis tail stays out.",
      "source-1"
    );
    const boundary = source.paragraphs[1]!;
    const budget = byteBudget(240, 40);
    const chunks = planSourceChunks({
      source,
      boundaryParagraphId: boundary.id,
      systemPrompt: "Extract only cited facts.",
      instructions: "Return JSON.",
      budget
    });

    expect(chunks).not.toHaveLength(0);
    expect(() => assertSourceCoverage(source, chunks, boundary.id)).not.toThrow();
    expect(chunkText(source.text, chunks)).toContain("First scene.");
    expect(chunkText(source.text, chunks)).toContain("Second scene with an emoji 😀.");
    expect(chunkText(source.text, chunks)).not.toContain("This tail stays out.");
    for (const chunk of chunks) {
      expect(chunk.sourceId).toBe(source.id);
      expect(chunk.spans.every((span) => span.end <= boundary.end)).toBe(true);
    }
  });

  it("splits an oversized paragraph at code-point boundaries without losing coverage", () => {
    const source = normalizeSourceDocument("chapter.txt", "😀".repeat(80), "source-1");
    const chunks = planSourceChunks({
      source,
      boundaryParagraphId: source.paragraphs[0]!.id,
      systemPrompt: "facts",
      instructions: "json",
      budget: byteBudget(240, 20)
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(() => assertSourceCoverage(source, chunks, source.paragraphs[0]!.id)).not.toThrow();
    expect(chunkText(source.text, chunks)).toBe("😀".repeat(80));
    expect(chunks.flatMap((chunk) => chunk.spans).every((span) => Number.isInteger(span.start) && Number.isInteger(span.end))).toBe(true);
  });

  it("preserves separators in an emitted range without widening paragraph evidence spans", () => {
    const source = normalizeSourceDocument("chapter.txt", "\n\nFirst.\n\nSecond.", "source-1");
    const chunks = planSourceChunks({
      source,
      boundaryParagraphId: source.paragraphs[1]!.id,
      systemPrompt: "facts",
      instructions: "json",
      budget: byteBudget()
    });

    expect(chunks[0]!.sourceRange).toMatchObject({ start: 0, end: source.paragraphs[1]!.end });
    for (const span of chunks.flatMap((chunk) => chunk.spans)) {
      const paragraph = source.paragraphs.find((candidate) => candidate.id === span.paragraphId)!;
      expect(span.start).toBeGreaterThanOrEqual(paragraph.start);
      expect(span.end).toBeLessThanOrEqual(paragraph.end);
    }
  });

  it("classifies a leading separator prefix that cannot fit with its first paragraph character as context exceeded", () => {
    const source = normalizeSourceDocument("chapter.txt", "\n\nA", "source-1");

    expect(() => planSourceChunks({
      source,
      boundaryParagraphId: source.paragraphs[0]!.id,
      systemPrompt: "",
      instructions: "",
      budget: byteBudget(4, 1),
      renderRequest: (request) => request.sourceText
    })).toThrow(expect.objectContaining({ code: "authoring_context_exceeded" }));
  });

  it("packs complete paragraphs before code-point splitting an oversized paragraph", () => {
    const source = normalizeSourceDocument("chapter.txt", `${"A".repeat(20)}\n\n${"B".repeat(50)}`, "source-1");
    const chunks = planSourceChunks({
      source,
      boundaryParagraphId: source.paragraphs[1]!.id,
      systemPrompt: "ignored by this deterministic renderer",
      instructions: "ignored",
      budget: byteBudget(100, 20),
      renderRequest: (request) => request.sourceText
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.sourceRange).toEqual({ start: 0, end: source.paragraphs[1]!.start });
    expect(chunks[0]!.spans).toEqual([{ paragraphId: source.paragraphs[0]!.id, start: 0, end: source.paragraphs[0]!.end }]);
    expect(chunks[1]!.sourceRange).toEqual({ start: source.paragraphs[1]!.start, end: source.paragraphs[1]!.end });
    expect(() => assertSourceCoverage(source, chunks, source.paragraphs[1]!.id)).not.toThrow();
  });

  it("uses bounded serialized-request probes for a near-limit source", () => {
    const source = normalizeSourceDocument("chapter.txt", "a".repeat(200_000), "source-1");
    let rendered = 0;
    const chunks = planSourceChunks({
      source,
      boundaryParagraphId: source.paragraphs[0]!.id,
      systemPrompt: "facts",
      instructions: "json",
      budget: byteBudget(300_000, 100),
      renderRequest: (request) => {
        rendered += 1;
        return JSON.stringify(request);
      }
    });

    expect(chunks).toHaveLength(1);
    expect(rendered).toBeLessThan(100);
  });

  it("fails before execution when mandatory request material exceeds the effective budget", () => {
    const source = normalizeSourceDocument("chapter.txt", "A chapter.", "source-1");

    expect(() => planSourceChunks({
      source,
      boundaryParagraphId: source.paragraphs[0]!.id,
      systemPrompt: "A contract larger than the model context",
      instructions: "",
      budget: {
        contextWindowTokens: 16,
        maxOutputTokens: 12,
        countTokens: (text) => new TextEncoder().encode(text).length
      }
    })).toThrow();
  });

  it("rejects a nonpositive context limit instead of assuming an unlimited model", () => {
    const source = normalizeSourceDocument("chapter.txt", "A chapter.", "source-1");

    expect(() => planSourceChunks({
      source,
      boundaryParagraphId: source.paragraphs[0]!.id,
      systemPrompt: "facts",
      instructions: "json",
      budget: byteBudget(0, 20)
    })).toThrow(/context/i);
  });

  it("reports the computed chunk count when complete coverage needs more than 200 chunks", () => {
    const source = normalizeSourceDocument("chapter.txt", "a".repeat(201), "source-1");

    expect(() => planSourceChunks({
      source,
      boundaryParagraphId: source.paragraphs[0]!.id,
      systemPrompt: "",
      instructions: "",
      budget: byteBudget(52, 40),
      renderRequest: (request) => request.sourceText
    })).toThrow(expect.objectContaining({ code: "source_requires_larger_context", requiredChunkCount: 201 }));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    "rejects an invalid effective context limit of %p",
    (contextWindowTokens) => {
      const source = normalizeSourceDocument("chapter.txt", "A chapter.", "source-1");

      expect(() => planSourceChunks({
        source,
        boundaryParagraphId: source.paragraphs[0]!.id,
        systemPrompt: "facts",
        instructions: "json",
        budget: byteBudget(contextWindowTokens, 20)
      })).toThrow(/context/i);
    }
  );

  it("validates source integrity once before packing instead of trusting a self-consistent shape", () => {
    const source = normalizeSourceDocument("chapter.txt", "A chapter.", "source-1");

    expect(() => planSourceChunks({
      source: { ...source, sha256: "0".repeat(64) },
      boundaryParagraphId: source.paragraphs[0]!.id,
      systemPrompt: "facts",
      instructions: "json",
      budget: byteBudget()
    })).toThrow(/integrity/i);
  });

  it("rejects a chunk whose emitted-range hash was tampered after planning", () => {
    const source = normalizeSourceDocument("chapter.txt", "A chapter.", "source-1");
    const chunks = planSourceChunks({
      source,
      boundaryParagraphId: source.paragraphs[0]!.id,
      systemPrompt: "facts",
      instructions: "json",
      budget: byteBudget()
    });
    const tampered = [{ ...chunks[0]!, contentHash: "0".repeat(64) }];

    expect(() => assertSourceCoverage(source, tampered, source.paragraphs[0]!.id))
      .toThrow(expect.objectContaining({ code: "source_coverage_incomplete" }));
  });

  it("keeps the selected prefix plan unchanged when the excluded tail changes", () => {
    const first = normalizeSourceDocument("chapter.txt", "Selected one.\n\nSelected two.\n\nFirst excluded tail.", "source-1");
    const second = normalizeSourceDocument("chapter.txt", "Selected one.\n\nSelected two.\n\nDifferent excluded tail with 😀.", "source-1");
    const budget = byteBudget(240, 20);
    const firstBodies: string[] = [];
    const secondBodies: string[] = [];
    const firstChunks = planSourceChunks({
      source: first,
      boundaryParagraphId: first.paragraphs[1]!.id,
      systemPrompt: "facts",
      instructions: "json",
      budget,
      renderRequest: (request) => {
        const body = JSON.stringify(request);
        firstBodies.push(body);
        return body;
      }
    });
    const secondChunks = planSourceChunks({
      source: second,
      boundaryParagraphId: second.paragraphs[1]!.id,
      systemPrompt: "facts",
      instructions: "json",
      budget,
      renderRequest: (request) => {
        const body = JSON.stringify(request);
        secondBodies.push(body);
        return body;
      }
    });

    expect(secondChunks).toEqual(firstChunks);
    expect(firstChunks.every((chunk) => /^[0-9a-f]{64}$/u.test(chunk.contentHash))).toBe(true);
    expect(firstChunks.map((chunk) => chunk.contentHash)).toEqual(secondChunks.map((chunk) => chunk.contentHash));
    expect(secondBodies).toEqual(firstBodies);
  });
});
