import { z } from "zod";
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
  type SourceWorldProposalAssembly,
  type SourceWorldSelection
} from "../../../packages/domain/src/source-world-proposal.js";
import type { ProviderRequest, ProviderResult } from "../../../packages/story-engine/src/providers.js";
import { AuthoringResponseError, runAuthoringResponse } from "./authoring-response-adapter.js";

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

function sourceOutputIssue(path: Array<string | number>): z.ZodError {
  return new z.ZodError([{
    code: "custom",
    path,
    message: "Generated source facts need exact evidence inside the selected source chunk.",
    params: { authoringReason: "source_evidence" }
  }]);
}

const sourceExtractionEnvelopeSchema = z.object({ facts: z.unknown() }).strict();

function parseCandidates(input: SourceExtractionInput, content: string, outputLimited: boolean): SourceFact[] {
  if (outputLimited) throw sourceOutputIssue(["facts"]);
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    throw sourceOutputIssue(["facts"]);
  }
  let envelope: { facts: unknown };
  try {
    envelope = sourceExtractionEnvelopeSchema.parse(decoded);
  } catch {
    throw sourceOutputIssue(["facts"]);
  }
  const facts = validateExtractedSourceFactsWithinBoundary(
    input.source,
    input.chunk,
    input.boundaryParagraphId,
    envelope.facts
  );
  if (input.mode === "faithful") {
    const inferredIndex = facts.findIndex((fact) => fact.provenance !== "stated");
    if (inferredIndex >= 0) throw sourceOutputIssue(["facts", inferredIndex, "provenance"]);
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
  delay(milliseconds: number): Promise<void>;
}>): Readonly<{ extractSourceChunk(input: SourceExtractionInput): Promise<SourceFact[]> }> {
  return Object.freeze({
    async extractSourceChunk(input: SourceExtractionInput): Promise<SourceFact[]> {
      if (!hasValidSourceChunkWithinBoundary(input.source, input.chunk, input.boundaryParagraphId)) {
        throw new Error("The source chunk does not match the selected source boundary.");
      }
      let outputLimited = false;
      try {
        return await runAuthoringResponse({
          stage: "source",
          request: async (attempt) => {
            const request = renderSourceExtractionRequest(input, attempt.repair, attempt.issues, attempt.rejectedResponse);
            const result = await (attempt.repair
              ? options.requestBudget.executeRepair(request)
              : options.requestBudget.executeInitial(request));
            outputLimited = result.outputLimited;
            return result;
          },
          parse: (content) => parseCandidates(input, content, outputLimited),
          delay: options.delay
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

function sourceWorldOutputIssue(): z.ZodError {
  return new z.ZodError([{
    code: "custom",
    path: ["sourceWorld"],
    message: "Generated source-world fields must use the reviewed closed target mapping.",
    params: { authoringReason: "source_evidence" }
  }]);
}

function parseSourceWorldResponse(input: SourceWorldSynthesisInput, content: string): SourceWorldProposalAssembly {
  let generated: unknown;
  try {
    generated = JSON.parse(content);
  } catch {
    throw sourceWorldOutputIssue();
  }
  try {
    return assembleSourceWorldProposalWithEvidence(input.selection, generated);
  } catch {
    throw sourceWorldOutputIssue();
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
  delay(milliseconds: number): Promise<void>;
}>): Readonly<{ synthesizeSourceWorld(input: SourceWorldSynthesisInput, currentClaim?: () => Promise<boolean>): Promise<SourceWorldProposalAssembly> }> {
  return Object.freeze({
    async synthesizeSourceWorld(input, currentClaim) {
      return runAuthoringResponse({
        stage: "source",
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
