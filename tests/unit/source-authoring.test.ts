import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authoringFailureSchema,
  authoringJobListItemSchema,
  authoringJobViewSchema,
  authoringSubmitSchema,
  parseAuthoringCommandForJob
} from "../../packages/contracts/src/authoring.js";
import { worldContentSchema } from "../../packages/contracts/src/world-library.js";
import {
  sourceAuthoringInputSchema,
  sourceAuthoringViewSchema,
  sourceCitationSchema,
  utf8ByteLength
} from "../../packages/contracts/src/source-authoring.js";
import {
  normalizeSourceDocument,
  validateSourceCitation,
  validateSourceCitationWithinBoundary
} from "../../packages/domain/src/source-authoring.js";

const sourceInput = {
  kind: "story_source" as const,
  idempotencyKey: "source-request",
  target: { kind: "new_world" as const },
  name: "chapter.txt",
  text: "Blue coat.",
  mode: "faithful" as const,
  boundaryParagraphId: "paragraph:0",
  instructions: ""
};

describe("source authoring provenance", () => {
  it("normalizes one leading BOM and line endings while preserving paragraph code-point offsets", () => {
    const source = normalizeSourceDocument("chapter.txt", "\uFEFFA\r\n\r\nBlue coat.", "source-1");

    expect(source.text).toBe("A\n\nBlue coat.");
    expect(source.paragraphs).toEqual([
      { id: "paragraph:0", start: 0, end: 1 },
      { id: "paragraph:1", start: 3, end: 13 }
    ]);
  });

  it("removes exactly one leading BOM and preserves a second BOM for citation integrity", () => {
    const source = normalizeSourceDocument("chapter.txt", "\uFEFF\uFEFFA", "source-1");
    const paragraph = source.paragraphs[0]!;
    const citation = { sourceId: source.id, paragraphId: paragraph.id, start: 0, end: 2, quote: "\uFEFFA" };

    expect(source.text).toBe("\uFEFFA");
    expect(validateSourceCitation(source, citation)).toBe(true);
  });

  it("uses Unicode code-point offsets and preserves non-separator whitespace", () => {
    const source = normalizeSourceDocument("chapter.txt", "😀 first\r\n\r\n  Tail  ", "source-1");

    expect(source.text).toBe("😀 first\n\n  Tail  ");
    expect(source.paragraphs).toEqual([
      { id: "paragraph:0", start: 0, end: 7 },
      { id: "paragraph:1", start: 9, end: 17 }
    ]);
  });

  it("accepts a non-BMP exact-span quote by code points and rejects a quote over that limit", () => {
    const text = "😀".repeat(100_001);
    const source = normalizeSourceDocument("chapter.txt", text, "source-1");
    const paragraph = source.paragraphs[0]!;
    const citation = { sourceId: source.id, paragraphId: paragraph.id, start: 0, end: 100_001, quote: text };

    expect(sourceCitationSchema.safeParse(citation).success).toBe(true);
    expect(validateSourceCitation(source, citation)).toBe(true);
    expect(sourceCitationSchema.safeParse({ ...citation, quote: "😀".repeat(200_001) }).success).toBe(false);
  });

  it("rejects empty source construction and assigns deterministic paragraph IDs", () => {
    const first = normalizeSourceDocument("chapter.txt", "A\n\nB", "source-1");
    const second = normalizeSourceDocument("chapter.txt", "A\n\nB", "source-1");

    expect(() => normalizeSourceDocument("empty.txt", "", "source-empty")).toThrow(/non-whitespace/u);
    expect(first.paragraphs).toEqual(second.paragraphs);
  });

  it("verifies the complete normalized document, paragraph-contained code-point spans, and exact quotes", () => {
    const source = normalizeSourceDocument("chapter.txt", "A\n\nBlue coat.", "source-1");
    const paragraph = source.paragraphs[1]!;
    const citation = {
      sourceId: source.id,
      paragraphId: paragraph.id,
      start: paragraph.start,
      end: paragraph.end,
      quote: "Blue coat."
    };

    expect(validateSourceCitation(source, citation)).toBe(true);
    expect(validateSourceCitation(source, { ...citation, start: 0, quote: "A\n\nBlue coat." })).toBe(false);
    expect(validateSourceCitation(source, { ...citation, quote: "Blue cloak." })).toBe(false);
    expect(validateSourceCitation(source, { ...citation, sourceId: "other-source" })).toBe(false);
    expect(validateSourceCitation({ ...source, sha256: "0".repeat(64) }, citation)).toBe(false);
  });

  it("rejects a self-consistent hash and map over unnormalized retained text", () => {
    const text = "\uFEFFA\r\n\r\nBlue coat.";
    const source = {
      id: "source-1",
      name: "chapter.txt",
      text,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      paragraphs: [
        { id: "paragraph:0", start: 0, end: 3 },
        { id: "paragraph:1", start: 6, end: 16 }
      ]
    };
    const citation = { sourceId: source.id, paragraphId: "paragraph:1", start: 6, end: 16, quote: "Blue coat." };

    expect(validateSourceCitation(source, citation)).toBe(false);
  });

  it("rejects citations after the selected boundary with an explicit boundary helper", () => {
    const source = normalizeSourceDocument("chapter.txt", "Before.\n\nAfter.", "source-1");
    const before = source.paragraphs[0]!;
    const after = source.paragraphs[1]!;
    const beforeCitation = { sourceId: source.id, paragraphId: before.id, start: before.start, end: before.end, quote: "Before." };
    const afterCitation = { sourceId: source.id, paragraphId: after.id, start: after.start, end: after.end, quote: "After." };

    expect(validateSourceCitationWithinBoundary(source, beforeCitation, before.id)).toBe(true);
    expect(validateSourceCitationWithinBoundary(source, afterCitation, before.id)).toBe(false);
    expect(validateSourceCitationWithinBoundary(source, beforeCitation, "missing-boundary")).toBe(false);
  });

  it("keeps raw source limits and instructions separate from the existing concept prompt limit", () => {
    expect(utf8ByteLength("A😀")).toBe(5);
    expect(sourceAuthoringInputSchema.parse(sourceInput)).toEqual(sourceInput);
    expect(sourceAuthoringInputSchema.safeParse({ ...sourceInput, prompt: "not accepted" }).success).toBe(false);
    expect(sourceAuthoringInputSchema.safeParse({ ...sourceInput, text: "" }).success).toBe(false);
    expect(sourceAuthoringInputSchema.safeParse({ ...sourceInput, text: "\uFEFF" }).success).toBe(false);
    expect(sourceAuthoringInputSchema.safeParse({ ...sourceInput, text: " \r\n\t" }).success).toBe(false);
    expect(sourceAuthoringInputSchema.safeParse({ ...sourceInput, text: "\0" }).success).toBe(false);
    for (const text of ["\uD800", "\uD800A"]) {
      expect(sourceAuthoringInputSchema.safeParse({ ...sourceInput, text }).success).toBe(false);
    }
    expect(sourceAuthoringInputSchema.safeParse({ ...sourceInput, text: "😀".repeat(200_001) }).success).toBe(false);
    expect(sourceAuthoringInputSchema.safeParse({ ...sourceInput, text: "x".repeat(1_048_577) }).success).toBe(false);
    expect(sourceAuthoringInputSchema.safeParse({ ...sourceInput, text: `\uFEFF${"x".repeat(1_048_574)}` }).success).toBe(false);
    expect(sourceAuthoringInputSchema.safeParse({ ...sourceInput, name: "x".repeat(201) }).success).toBe(false);
    expect(sourceAuthoringInputSchema.safeParse({ ...sourceInput, instructions: "x".repeat(20_001) }).success).toBe(false);
    const concept = authoringSubmitSchema.parse({ kind: "world_concept", idempotencyKey: "concept", target: { kind: "new_world" }, prompt: "x".repeat(200_000) });
    if (concept.kind !== "world_concept") throw new Error("Expected a world concept input.");
    expect(concept.prompt).toHaveLength(200_000);
  });

  it("refuses unpaired surrogates before UTF-8 hashing can replace them", () => {
    for (const text of ["\uD800", "\uD800A"]) {
      expect(() => normalizeSourceDocument("chapter.txt", text, "source-1")).toThrow(/surrogate/u);
    }
  });

  it("adds story source to the canonical submit union and retains strict source detail only on owner views", () => {
    const source = normalizeSourceDocument("chapter.txt", sourceInput.text, "source-1");
    const fact = {
      id: "fact-1",
      kind: "tone" as const,
      subject: "chapter",
      predicate: "has tone",
      value: "quiet",
      provenance: "stated" as const,
      citations: [{ sourceId: source.id, paragraphId: source.paragraphs[0]!.id, start: 0, end: 10, quote: "Blue coat." }]
    };
    const detail = {
      source,
      boundaryParagraphId: source.paragraphs[0]!.id,
      mode: "faithful" as const,
      facts: [fact],
      extractionComplete: true,
      acceptedFactIds: [fact.id],
      rejectedFactIds: [],
      selectedCharacterFactIds: [],
      expansionCandidates: []
    };
    const job = {
      id: "source-job",
      revision: 0,
      status: "awaiting_review" as const,
      target: { kind: "new_world" as const },
      stages: [],
      expiresAt: "2026-09-14T00:00:00.000Z",
      canApply: false,
      incomplete: false,
      kind: "story_source" as const,
      request: sourceInput,
      source: detail
    };
    const result = worldContentSchema.parse({ world: { title: "Source World" } });

    expect(authoringSubmitSchema.parse(sourceInput)).toEqual(sourceInput);
    expect(sourceAuthoringViewSchema.parse(detail)).toEqual(detail);
    expect(() => sourceAuthoringViewSchema.parse({ ...detail, extra: true })).toThrow();
    expect(authoringJobViewSchema.parse({ ...job, result, reviewedContent: result, reviewedStageIds: [] })).toMatchObject({
      kind: "story_source", source: detail, result, reviewedContent: result, reviewedStageIds: []
    });
    expect(() => authoringJobListItemSchema.parse({ ...job, source: detail })).toThrow();
    expect(() => parseAuthoringCommandForJob({ kind: "story_source", target: { kind: "new_world" } }, "review", {
      expectedRevision: 0,
      content: { schemaVersion: 5, world: { title: "World" } },
      selectedStageIds: []
    })).toThrow(/not available/u);
  });

  it("allows the fixed source failures only at the source stage", () => {
    expect(authoringFailureSchema.parse({ code: "source_evidence_invalid", stage: "source", retryable: false, issues: [] })).toMatchObject({
      code: "source_evidence_invalid",
      stage: "source"
    });
  });
});
