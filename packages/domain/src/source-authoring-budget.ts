import { createHash } from "node:crypto";
import { sourceDocumentSchema, type SourceDocument } from "../../contracts/src/source-authoring.js";
import { hasValidSourceDocumentIntegrity } from "./source-authoring.js";

export const SOURCE_REQUEST_CONTEXT_FRACTION = 0.8;
export const MAX_SOURCE_CHUNKS = 200;

export type AuthoringBudget = Readonly<{
  contextWindowTokens: number;
  maxOutputTokens: number;
  countTokens(text: string): number;
}>;

export type SourceChunk = Readonly<{
  id: string;
  sourceId: string;
  /** Exact contiguous source code-point range emitted to the provider, including separators. */
  sourceRange: Readonly<{ start: number; end: number }>;
  /** Hash of only the emitted range, so excluded-tail changes do not alter it. */
  contentHash: string;
  /** Citation-eligible ranges; each remains inside its declared paragraph. */
  spans: ReadonlyArray<Readonly<{ paragraphId: string; start: number; end: number }>>;
}>;

export type SourceRequestRenderInput = Readonly<{
  systemPrompt: string;
  instructions: string;
  sourceText: string;
  repair: boolean;
}>;

/**
 * The default is only a deterministic domain-test frame. Runtime callers must
 * bind this to the provider serializer before issuing an authoring request.
 */
export type SourceRequestRenderer = (input: SourceRequestRenderInput) => string;

export type SourceChunkPlanInput = Readonly<{
  source: SourceDocument;
  boundaryParagraphId: string;
  systemPrompt: string;
  instructions: string;
  budget: AuthoringBudget;
  renderRequest?: SourceRequestRenderer;
}>;

export class SourceAuthoringBudgetError extends Error {
  readonly code: "authoring_context_exceeded" | "source_requires_larger_context" | "source_coverage_incomplete";
  readonly requiredChunkCount?: number;

  constructor(
    code: SourceAuthoringBudgetError["code"],
    message: string,
    requiredChunkCount?: number
  ) {
    super(message);
    this.name = "SourceAuthoringBudgetError";
    this.code = code;
    if (requiredChunkCount !== undefined) this.requiredChunkCount = requiredChunkCount;
  }
}

function defaultRenderRequest(input: SourceRequestRenderInput): string {
  return JSON.stringify({
    systemPrompt: input.systemPrompt,
    instructions: input.instructions,
    source: input.sourceText,
    repair: input.repair
  });
}

function sourceCodePoints(source: SourceDocument): string[] {
  sourceDocumentSchema.parse(source);
  if (!hasValidSourceDocumentIntegrity(source)) {
    throw new SourceAuthoringBudgetError("source_coverage_incomplete", "The normalized source integrity check failed before chunk planning.");
  }
  return Array.from(source.text);
}

function selectedPrefixEnd(source: SourceDocument, boundaryParagraphId: string): number {
  const boundary = source.paragraphs.find((paragraph) => paragraph.id === boundaryParagraphId);
  if (!boundary) {
    throw new SourceAuthoringBudgetError("source_coverage_incomplete", "The selected source boundary is not present in the normalized source.");
  }
  return boundary.end;
}

function inputLimit(budget: AuthoringBudget): number {
  if (!Number.isFinite(budget.contextWindowTokens) || budget.contextWindowTokens <= 0) {
    throw new SourceAuthoringBudgetError("authoring_context_exceeded", "A positive effective model context limit is required before source extraction.");
  }
  if (!Number.isFinite(budget.maxOutputTokens) || budget.maxOutputTokens <= 0) {
    throw new SourceAuthoringBudgetError("authoring_context_exceeded", "A positive output reservation is required before source extraction.");
  }
  const limit = Math.floor(budget.contextWindowTokens * SOURCE_REQUEST_CONTEXT_FRACTION) - budget.maxOutputTokens;
  if (limit <= 0) {
    throw new SourceAuthoringBudgetError("authoring_context_exceeded", "The effective model context does not leave room for source extraction output.");
  }
  return limit;
}

function countRenderedRequest(
  renderRequest: SourceRequestRenderer,
  systemPrompt: string,
  instructions: string,
  sourceText: string,
  repair: boolean,
  budget: AuthoringBudget
): number {
  const count = budget.countTokens(renderRequest({ systemPrompt, instructions, sourceText, repair }));
  if (!Number.isFinite(count) || count < 0) {
    throw new SourceAuthoringBudgetError("authoring_context_exceeded", "The source request counter returned an invalid value.");
  }
  return count;
}

function fitsBothRequests(
  renderRequest: SourceRequestRenderer,
  systemPrompt: string,
  instructions: string,
  sourceText: string,
  budget: AuthoringBudget,
  limit: number
): boolean {
  return countRenderedRequest(renderRequest, systemPrompt, instructions, sourceText, false, budget) <= limit
    && countRenderedRequest(renderRequest, systemPrompt, instructions, sourceText, true, budget) <= limit;
}

function spansForRange(source: SourceDocument, start: number, end: number): SourceChunk["spans"] {
  const intersecting = source.paragraphs.filter((paragraph) => paragraph.end > start && paragraph.start < end);
  if (intersecting.length === 0) {
    throw new SourceAuthoringBudgetError("source_coverage_incomplete", "A source request range does not include a paragraph.");
  }
  return intersecting.map((paragraph) => ({
    paragraphId: paragraph.id,
    start: Math.max(start, paragraph.start),
    end: Math.min(end, paragraph.end)
  }));
}

function makeChunk(source: SourceDocument, characters: readonly string[], start: number, end: number, index: number): SourceChunk {
  const sourceText = requestText(characters, start, end);
  return Object.freeze({
    id: `source-chunk:${index}`,
    sourceId: source.id,
    sourceRange: Object.freeze({ start, end }),
    contentHash: createHash("sha256").update(sourceText, "utf8").digest("hex"),
    spans: Object.freeze(spansForRange(source, start, end).map((span) => Object.freeze(span)))
  });
}

function chunkRange(chunk: SourceChunk): Readonly<{ start: number; end: number }> {
  return chunk.sourceRange;
}

function requestText(sourceCharacters: readonly string[], start: number, end: number): string {
  return sourceCharacters.slice(start, end).join("");
}

/** A request range may include separators, but must also contain source text. */
function firstMeaningfulEnd(source: SourceDocument, start: number, selectedEnd: number): number {
  const paragraph = source.paragraphs.find((candidate) => candidate.end > start && candidate.start < selectedEnd);
  if (!paragraph) {
    throw new SourceAuthoringBudgetError("source_coverage_incomplete", "The selected source range has no paragraph text.");
  }
  return Math.max(start, paragraph.start) + 1;
}

/** Prefer a complete paragraph prefix; split by code point only when none fits. */
function paragraphPackingEnd(source: SourceDocument, start: number, acceptedEnd: number): number {
  const complete = source.paragraphs.filter((paragraph) => paragraph.start >= start && paragraph.end <= acceptedEnd).at(-1);
  if (!complete) return acceptedEnd;
  const following = source.paragraphs.find((paragraph) => paragraph.start >= complete.end);
  // Keep an inter-paragraph separator with the preceding complete paragraph
  // when it fits, without admitting any part of the following paragraph.
  return following && following.start <= acceptedEnd ? following.start : complete.end;
}

function addOptionalOverlap(
  chunks: readonly SourceChunk[],
  source: SourceDocument,
  characters: readonly string[],
  systemPrompt: string,
  instructions: string,
  budget: AuthoringBudget,
  limit: number,
  renderRequest: SourceRequestRenderer
): SourceChunk[] {
  return chunks.map((chunk, index) => {
    if (index === 0) return chunk;
    const range = chunkRange(chunk);
    const priorParagraph = [...source.paragraphs].reverse().find((paragraph) => paragraph.end <= range.start);
    if (!priorParagraph) return chunk;
    const overlapText = requestText(characters, priorParagraph.start, range.end);
    if (!fitsBothRequests(renderRequest, systemPrompt, instructions, overlapText, budget, limit)) return chunk;
    return makeChunk(source, characters, priorParagraph.start, range.end, index);
  });
}

function assertSourceCoverageWithValidatedSource(
  source: SourceDocument,
  characters: readonly string[],
  chunks: readonly SourceChunk[],
  boundaryParagraphId: string
): void {
  const selectedEnd = selectedPrefixEnd(source, boundaryParagraphId);
  if (chunks.length === 0) {
    throw new SourceAuthoringBudgetError("source_coverage_incomplete", "The selected source has no planned chunks.");
  }
  const ranges = chunks.map(chunkRange).sort((left, right) => left.start - right.start || left.end - right.end);
  let coveredEnd = 0;
  for (const range of ranges) {
    if (range.start > coveredEnd || range.end > selectedEnd || range.start < 0 || range.end > characters.length || range.start >= range.end) {
      throw new SourceAuthoringBudgetError("source_coverage_incomplete", "The selected source is not completely covered by request chunks.");
    }
    coveredEnd = Math.max(coveredEnd, range.end);
  }
  if (coveredEnd !== selectedEnd) {
    throw new SourceAuthoringBudgetError("source_coverage_incomplete", "The selected source boundary is not covered by request chunks.");
  }
  for (const chunk of chunks) {
    if (chunk.sourceId !== source.id) {
      throw new SourceAuthoringBudgetError("source_coverage_incomplete", "A chunk references a different source document.");
    }
    const range = chunkRange(chunk);
    const expectedHash = createHash("sha256").update(requestText(characters, range.start, range.end), "utf8").digest("hex");
    if (chunk.contentHash !== expectedHash) {
      throw new SourceAuthoringBudgetError("source_coverage_incomplete", "A chunk emitted-range hash does not match its source range.");
    }
    const expected = source.paragraphs.filter((paragraph) => paragraph.end > range.start && paragraph.start < range.end);
    if (chunk.spans.length !== expected.length) {
      throw new SourceAuthoringBudgetError("source_coverage_incomplete", "A chunk does not retain each citation-eligible paragraph span.");
    }
    for (const paragraph of expected) {
      const span = chunk.spans.find((candidate) => candidate.paragraphId === paragraph.id);
      if (!span || span.start !== Math.max(range.start, paragraph.start) || span.end !== Math.min(range.end, paragraph.end)
          || span.start < paragraph.start || span.end > paragraph.end || span.start >= span.end) {
        throw new SourceAuthoringBudgetError("source_coverage_incomplete", "A chunk contains an invalid paragraph evidence span.");
      }
    }
  }
}

export function assertSourceCoverage(source: SourceDocument, chunks: readonly SourceChunk[], boundaryParagraphId: string): void {
  const characters = sourceCodePoints(source);
  assertSourceCoverageWithValidatedSource(source, characters, chunks, boundaryParagraphId);
}

export function planSourceChunks(input: SourceChunkPlanInput): SourceChunk[] {
  const characters = sourceCodePoints(input.source);
  const selectedEnd = selectedPrefixEnd(input.source, input.boundaryParagraphId);
  const limit = inputLimit(input.budget);
  const renderRequest = input.renderRequest ?? defaultRenderRequest;
  if (!fitsBothRequests(renderRequest, input.systemPrompt, input.instructions, "", input.budget, limit)) {
    throw new SourceAuthoringBudgetError("authoring_context_exceeded", "Mandatory source extraction instructions exceed the effective request budget.");
  }

  const chunks: SourceChunk[] = [];
  let start = 0;
  while (start < selectedEnd) {
    const fitsEnd = (end: number) => fitsBothRequests(
      renderRequest,
      input.systemPrompt,
      input.instructions,
      requestText(characters, start, end),
      input.budget,
      limit
    );
    const minimumEnd = firstMeaningfulEnd(input.source, start, selectedEnd);
    if (!fitsEnd(minimumEnd)) {
      throw new SourceAuthoringBudgetError("authoring_context_exceeded", "One source code point cannot fit with the mandatory extraction request material.");
    }
    let acceptedEnd = minimumEnd;
    let rejectedEnd = selectedEnd + 1;
    while (acceptedEnd + 1 < rejectedEnd) {
      const candidateEnd = acceptedEnd + Math.ceil((rejectedEnd - acceptedEnd) / 2);
      if (fitsEnd(candidateEnd)) acceptedEnd = candidateEnd;
      else rejectedEnd = candidateEnd;
    }
    acceptedEnd = paragraphPackingEnd(input.source, start, acceptedEnd);
    chunks.push(makeChunk(input.source, characters, start, acceptedEnd, chunks.length));
    start = acceptedEnd;
  }

  const planned = addOptionalOverlap(chunks, input.source, characters, input.systemPrompt, input.instructions, input.budget, limit, renderRequest);
  if (planned.length > MAX_SOURCE_CHUNKS) {
    throw new SourceAuthoringBudgetError(
      "source_requires_larger_context",
      `The selected source requires ${planned.length} chunks, exceeding the ${MAX_SOURCE_CHUNKS}-chunk limit.`,
      planned.length
    );
  }
  assertSourceCoverageWithValidatedSource(input.source, characters, planned, input.boundaryParagraphId);
  return planned;
}
