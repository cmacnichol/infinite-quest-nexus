import { z } from "zod";
import { logger } from "../../../packages/logger/src/index.js";
import type { SourceDocument, SourceFact } from "../../../packages/contracts/src/source-authoring.js";
import {
  hasValidSourceChunkWithinBoundary,
  validateExtractedSourceFactsWithinBoundary
} from "../../../packages/domain/src/source-authoring.js";
import type { SourceChunk } from "../../../packages/domain/src/source-authoring-budget.js";
import { buildSourceExtractionPrompt } from "../../../packages/domain/src/authoring-prompts.js";
import { buildSourceWorldPrompt } from "../../../packages/domain/src/authoring-prompts.js";
import {
  assembleSourceWorldProposalWithEvidence,
  SourceWorldProposalError,
  validateSourceWorldSelection,
  type SourceWorldProposalAssembly,
  type SourceWorldSelection
} from "../../../packages/domain/src/source-world-proposal.js";
import { projectAuthoringIssues } from "../../../packages/domain/src/authoring-output.js";
import type { ProviderRequest, ProviderResult } from "../../../packages/story-engine/src/providers.js";
import { AuthoringResponseError, runAuthoringResponse, type AuthoringDiagnosticContext } from "./authoring-response-adapter.js";

const MAX_SOURCE_FACTS_PER_CHUNK = 200;

export type SourceExtractionInput = Readonly<{
  source: SourceDocument;
  chunk: SourceChunk;
  /** Trusted persisted job selection; never inferred from a provider or chunk payload. */
  boundaryParagraphId: string;
  mode: "faithful" | "expand";
  instructions: string;
}>;

export type SourceExtractionRequestBudget = Readonly<{
  executeInitial(request: ProviderRequest): Promise<ProviderResult>;
  executeRepair(request: ProviderRequest): Promise<ProviderResult>;
}>;

export type SourceExtractionRequestFrame = Readonly<{
  instructions: string;
  sourceText: string;
  sourceRange: Readonly<{ start: number; end: number }>;
  paragraphSpans: ReadonlyArray<Readonly<{ paragraphId: string; start: number; end: number }>>;
  mode: "faithful" | "expand";
  repair: boolean;
  issues?: unknown;
  rejectedResponse?: string;
}>;

export class SourceExtractionSplitNeededError extends Error {
  readonly code = "source_split_needed" as const;
  readonly chunkId: string;

  constructor(chunkId: string) {
    super("Source extraction output needs a smaller bounded chunk.");
    this.name = "SourceExtractionSplitNeededError";
    this.chunkId = chunkId;
  }
}

function sourceChunkText(source: SourceDocument, chunk: SourceChunk): string {
  return Array.from(source.text).slice(chunk.sourceRange.start, chunk.sourceRange.end).join("");
}

/** Pure request frame: P3.4 can serialize this exact metadata while planning candidate chunks. */
export function renderSourceExtractionRequest(input: SourceExtractionInput, repair: boolean, issues: unknown, rejectedResponse?: string): ProviderRequest {
  return renderSourceExtractionProviderRequest({
    instructions: input.instructions,
    sourceText: sourceChunkText(input.source, input.chunk),
    sourceRange: input.chunk.sourceRange,
    paragraphSpans: input.chunk.spans,
    mode: input.mode,
    repair,
    issues,
    ...(rejectedResponse === undefined ? {} : { rejectedResponse })
  });
}

export function renderSourceExtractionProviderRequest(input: SourceExtractionRequestFrame): ProviderRequest {
  const prompt = buildSourceExtractionPrompt({
    instructions: input.instructions,
    sourceText: input.sourceText,
    mode: input.mode,
    chunk: { sourceRange: input.sourceRange, paragraphSpans: input.paragraphSpans },
    repair: input.repair
  });
  return {
    systemPrompt: prompt.systemPrompt,
    input: prompt.input,
    responseFormatFallback: "forbid",
    ...(input.repair ? { recoveryInput: JSON.stringify({ issues: input.issues ?? [] }) } : {}),
    ...(input.rejectedResponse === undefined ? {} : { rejectedResponse: input.rejectedResponse })
  };
}

function sourceOutputIssue(path: Array<string | number>, authoringReason: "source_json_decode" | "source_envelope" | "source_output_limit"): z.ZodError {
  return new z.ZodError([{
    code: "custom",
    path,
    message: "Generated source response failed validation.",
    params: { authoringReason }
  }]);
}

const sourceExtractionEnvelopeSchema = z.object({ facts: z.unknown() }).strict();

type CitationDiagnosticContext = AuthoringDiagnosticContext & Readonly<{ requestAttempt: number; repair: boolean }>;

/** Explain rejected citations; temporary source-text logging requires an exact job opt-in. */
function logCitationMismatches(input: SourceExtractionInput, candidates: unknown, error: unknown, context: CitationDiagnosticContext): void {
  if (!(error instanceof z.ZodError)) return;
  const characters = Array.from(input.source.text);
  const boundary = input.source.paragraphs.find((paragraph) => paragraph.id === input.boundaryParagraphId);
  if (!boundary) return;
  const paragraphs = input.source.paragraphs.filter((paragraph) => paragraph.end <= boundary.end);
  const selectedText = characters.slice(0, boundary.end).join("");
  const whitespace = (text: string) => text.replace(/\s+/gu, " ").trim();
  const quotationMarks = (text: string) => text.replace(/[\u2018\u2019]/gu, "'").replace(/[\u201c\u201d]/gu, '"');
  const normalizers = [
    ["whitespace", whitespace],
    ["unicode", (text: string) => text.normalize("NFC")],
    ["quotation_marks", quotationMarks],
    ["combined", (text: string) => whitespace(quotationMarks(text.normalize("NFC")))]
  ] as const;
  for (const issue of error.issues.slice(0, 20)) {
    if (issue.code !== "custom" || issue.params?.authoringReason !== "source_quote") continue;
    const [root, factIndex, field, citationIndex] = issue.path;
    if (root !== "facts" || field !== "citations" || typeof factIndex !== "number" || typeof citationIndex !== "number") continue;
    const citation = Array.isArray(candidates) ? candidates[factIndex]?.citations?.[citationIndex] : undefined;
    if (typeof citation?.quote !== "string") continue;
    const paragraph = paragraphs.find((paragraph) => paragraph.id === citation.paragraphId);
    const span = input.chunk.spans.find((span) => span.paragraphId === paragraph?.id);
    if (!paragraph || !span) continue;
    const quote: string = citation.quote;
    const spanText = characters.slice(span.start, span.end).join("");
    const exactParagraph = characters.slice(paragraph.start, paragraph.end).join("").includes(quote)
      ? paragraph
      : paragraphs.find((candidate) => characters.slice(candidate.start, candidate.end).join("").includes(quote));
    let matchCategory = "changed_text";
    let normalization: string | undefined;
    if (spanText.includes(quote)) matchCategory = "coordinate_mismatch";
    else if (exactParagraph) matchCategory = exactParagraph.id === paragraph.id ? "outside_chunk" : "wrong_paragraph";
    else if (selectedText.includes(quote)) matchCategory = "cross_paragraph";
    else {
      for (const [name, normalize] of normalizers) {
        const normalizedQuote = normalize(quote);
        if (normalizedQuote && normalize(spanText).includes(normalizedQuote)) {
          matchCategory = "formatting_difference";
          normalization = name;
          break;
        }
      }
    }
    logger.warn({
      event: "authoring_citation_mismatch", ...context, factIndex, citationIndex,
      paragraphId: paragraph.id, quoteCodePoints: Array.from(quote).length,
      paragraphCodePoints: paragraph.end - paragraph.start, spanCodePoints: span.end - span.start,
      matchCategory, ...(normalization === undefined ? {} : { normalization }),
      ...(exactParagraph === undefined ? {} : { matchedParagraphId: exactParagraph.id }),
      // Temporary troubleshooting only. Remove after the citation incident is resolved.
      ...(process.env.AI_AUTHORING_CITATION_DEBUG_JOB_ID?.trim() === context.authoringJobId ? {
        sourceDebug: {
          rejectedQuote: quote,
          citedParagraphText: characters.slice(paragraph.start, paragraph.end).join(""),
          providedSpanText: spanText
        }
      } : {})
    });
  }
}

function parseCandidates(input: SourceExtractionInput, content: string, outputLimited: boolean, diagnostics?: CitationDiagnosticContext): SourceFact[] {
  if (outputLimited) throw sourceOutputIssue(["facts"], "source_output_limit");
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    throw sourceOutputIssue(["facts"], "source_json_decode");
  }
  let envelope: { facts: unknown };
  try {
    envelope = sourceExtractionEnvelopeSchema.parse(decoded);
  } catch {
    throw sourceOutputIssue(["facts"], "source_envelope");
  }
  let facts: SourceFact[];
  try {
    facts = validateExtractedSourceFactsWithinBoundary(input.source, input.chunk, input.boundaryParagraphId, envelope.facts);
  } catch (error) {
    try {
      if (diagnostics) logCitationMismatches(input, envelope.facts, error, diagnostics);
    } catch { /* Diagnostics must preserve the original validation failure. */ }
    throw error;
  }
  if (input.mode === "faithful") {
    const inferredIndex = facts.findIndex((fact) => fact.provenance !== "stated");
    if (inferredIndex >= 0) throw new z.ZodError([{
      code: "custom", path: ["facts", inferredIndex, "provenance"], message: "Generated source facts must be stated in faithful mode.",
      params: { authoringReason: "source_schema" }
    }]);
  }
  return facts;
}

function hasOutputLimitIssue(error: unknown): boolean {
  return error instanceof AuthoringResponseError
    && (error.authoringFailure.code === "authoring_output_limit"
      || error.authoringFailure.issues.some((issue) => issue.code === "too_big"));
}

export function createSourceAuthoringAdapter(options: Readonly<{
  requestBudget: SourceExtractionRequestBudget;
  diagnosticContext?: AuthoringDiagnosticContext;
  delay(milliseconds: number): Promise<void>;
}>): Readonly<{ extractSourceChunk(input: SourceExtractionInput, currentClaim?: () => Promise<boolean>): Promise<SourceFact[]> }> {
  return Object.freeze({
    async extractSourceChunk(input: SourceExtractionInput, currentClaim?: () => Promise<boolean>): Promise<SourceFact[]> {
      if (!hasValidSourceChunkWithinBoundary(input.source, input.chunk, input.boundaryParagraphId)) {
        throw new Error("The source chunk does not match the selected source boundary.");
      }
      let outputLimited = false;
      let requestAttempt = 0;
      let repair = false;
      try {
        return await runAuthoringResponse({
          stage: "source",
          ...(options.diagnosticContext === undefined ? {} : { diagnosticContext: options.diagnosticContext }),
          request: async (attempt) => {
            requestAttempt += 1;
            repair = attempt.repair;
            const request = renderSourceExtractionRequest(input, attempt.repair, attempt.issues, attempt.rejectedResponse);
            const result = await (attempt.repair
              ? options.requestBudget.executeRepair(request)
              : options.requestBudget.executeInitial(request));
            outputLimited = result.outputLimited;
            return result;
          },
          parse: (content) => parseCandidates(input, content, outputLimited, options.diagnosticContext
            ? { ...options.diagnosticContext, requestAttempt, repair }
            : undefined),
          delay: options.delay,
          ...(currentClaim === undefined ? {} : { currentClaim })
        });
      } catch (error) {
        if (hasOutputLimitIssue(error)) throw new SourceExtractionSplitNeededError(input.chunk.id);
        throw error;
      }
    }
  });
}

export type SourceAuthoringAdapter = ReturnType<typeof createSourceAuthoringAdapter>;
export { MAX_SOURCE_FACTS_PER_CHUNK };

export type SourceWorldSynthesisInput = Readonly<{
  selection: SourceWorldSelection;
  reviewGeneration: number;
  instructions: string;
}>;

function sourceWorldOutputIssue(path: Array<string | number>, authoringReason: "source_world_json" | "source_world_schema" | SourceWorldProposalError["reason"]): z.ZodError {
  return new z.ZodError([{
    code: "custom",
    path,
    message: "Generated source-world response failed validation.",
    params: { authoringReason }
  }]);
}

function safeSourceWorldSchemaPath(path: readonly PropertyKey[]): Array<string | number> {
  const root = path[0];
  if (root !== "fields" && root !== "characterFields" && root !== "expansionCandidates") return ["fields"];
  if (typeof path[1] !== "number" || !Number.isInteger(path[1]) || path[1] < 0) return [root];
  const base: Array<string | number> = [root, path[1]];
  if (root === "fields" || root === "expansionCandidates") return ["path", "value", "supportingFactIds", "target"].includes(String(path[2])) ? [...base, String(path[2])] : base;
  if (path[2] === "selectedCharacterFactId") return [...base, "selectedCharacterFactId"];
  if (path[2] !== "fields" || typeof path[3] !== "number" || !Number.isInteger(path[3]) || path[3] < 0) return base;
  const fieldBase: Array<string | number> = [...base, "fields", path[3]];
  return ["path", "value", "supportingFactIds"].includes(String(path[4])) ? [...fieldBase, String(path[4])] : fieldBase;
}

function parseSourceWorldResponse(input: SourceWorldSynthesisInput, content: string): SourceWorldProposalAssembly {
  let generated: unknown;
  try {
    generated = JSON.parse(content);
  } catch {
    throw sourceWorldOutputIssue(["fields"], "source_world_json");
  }
  try {
    return assembleSourceWorldProposalWithEvidence(input.selection, generated);
  } catch (error) {
    if (error instanceof SourceWorldProposalError) throw sourceWorldOutputIssue([...error.path], error.reason);
    if (error instanceof z.ZodError) {
      throw new z.ZodError(error.issues.slice(0, 20).map((issue) => ({
        code: "custom" as const,
        path: safeSourceWorldSchemaPath(issue.path),
        message: "Generated source-world response failed validation.",
        params: { authoringReason: "source_world_schema" }
      })));
    }
    throw sourceWorldOutputIssue(["fields"], "source_world_selection");
  }
}

/** Rendered through the same bounded source transport as extraction. */
export function renderSourceWorldProviderRequest(
  input: SourceWorldSynthesisInput,
  repair: boolean,
  issues: unknown,
  rejectedResponse?: string
): ProviderRequest {
  const prompt = buildSourceWorldPrompt({
    instructions: input.instructions,
    reviewGeneration: input.reviewGeneration,
    selection: input.selection,
    repair
  });
  return {
    systemPrompt: prompt.systemPrompt,
    input: prompt.input,
    responseFormatFallback: "forbid",
    ...(repair ? { recoveryInput: JSON.stringify({ issues }) } : {}),
    ...(rejectedResponse === undefined ? {} : { rejectedResponse })
  };
}

export function createSourceWorldAuthoringAdapter(options: Readonly<{
  requestBudget: SourceExtractionRequestBudget;
  diagnosticContext?: AuthoringDiagnosticContext;
  delay(milliseconds: number): Promise<void>;
}>): Readonly<{ synthesizeSourceWorld(input: SourceWorldSynthesisInput, currentClaim?: () => Promise<boolean>): Promise<SourceWorldProposalAssembly> }> {
  return Object.freeze({
    async synthesizeSourceWorld(input, currentClaim) {
      try {
        validateSourceWorldSelection(input.selection);
      } catch (error) {
        if (error instanceof SourceWorldProposalError) {
          throw new AuthoringResponseError({
            code: "source_review_conflict",
            stage: "source",
            retryable: false,
            issues: projectAuthoringIssues(sourceWorldOutputIssue([...error.path], error.reason))
          });
        }
        throw error;
      }
      return runAuthoringResponse({
        stage: "source",
        ...(options.diagnosticContext === undefined ? {} : { diagnosticContext: options.diagnosticContext }),
        request: async (attempt) => {
          const request = renderSourceWorldProviderRequest(input, attempt.repair, attempt.issues, attempt.rejectedResponse);
          return attempt.repair
            ? options.requestBudget.executeRepair(request)
            : options.requestBudget.executeInitial(request);
        },
        parse: (content) => parseSourceWorldResponse(input, content),
        delay: options.delay,
        ...(currentClaim === undefined ? {} : { currentClaim })
      });
    }
  });
}
