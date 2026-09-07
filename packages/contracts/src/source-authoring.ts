import { z } from "zod";

export const MAX_SOURCE_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_SOURCE_DOCUMENT_CODE_POINTS = 200_000;
export const MAX_SOURCE_INSTRUCTIONS_CODE_POINTS = 20_000;

export const sourceDocumentIdSchema = z.string().trim().min(1).max(200);
export const sourceDocumentNameSchema = z.string().superRefine((value, context) => {
  if (!value.trim()) context.addIssue({ code: "custom", message: "A source name is required." });
  if (Array.from(value).length > 200) context.addIssue({ code: "too_big", maximum: 200, origin: "string", inclusive: true, message: "The source name is too long." });
});

/** UTF-8 replaces unpaired surrogates, so source intake rejects them before hashing. */
export function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

/** Exact UTF-8 byte count for valid JavaScript strings without a Node or DOM dependency. */
export function utf8ByteLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) length += 1;
    else if (unit <= 0x7ff) length += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      length += 4;
      index += 1;
    } else length += 3;
  }
  return length;
}

function sourceTextSchema(options: Readonly<{ requireContent: boolean }>) {
  return z.string().superRefine((value, context) => {
    if (value.includes("\0")) context.addIssue({ code: "custom", message: "Source text cannot contain NUL characters." });
    if (hasUnpairedSurrogate(value)) context.addIssue({ code: "custom", message: "Source text cannot contain unpaired surrogate code units." });
    if (Array.from(value).length > MAX_SOURCE_DOCUMENT_CODE_POINTS) context.addIssue({ code: "too_big", maximum: MAX_SOURCE_DOCUMENT_CODE_POINTS, origin: "string", inclusive: true, message: "The source text exceeds the code-point limit." });
    if (utf8ByteLength(value) > MAX_SOURCE_DOCUMENT_BYTES) context.addIssue({ code: "too_big", maximum: MAX_SOURCE_DOCUMENT_BYTES, origin: "string", inclusive: true, message: "The source text exceeds the UTF-8 byte limit." });
    if (options.requireContent && value.replace(/^\uFEFF/u, "").replace(/\r\n|\r/gu, "\n").trim().length === 0) {
      context.addIssue({ code: "custom", message: "Source text must contain non-whitespace content." });
    }
  });
}

/** Raw bytes are checked before normalization can remove a BOM or shrink CRLF. */
export const sourceIntakeTextSchema = sourceTextSchema({ requireContent: true });

const sourceInstructionsSchema = z.string().superRefine((value, context) => {
  if (Array.from(value).length > MAX_SOURCE_INSTRUCTIONS_CODE_POINTS) {
    context.addIssue({ code: "too_big", maximum: MAX_SOURCE_INSTRUCTIONS_CODE_POINTS, origin: "string", inclusive: true, message: "Source instructions exceed the prompt limit." });
  }
});

const sourceParagraphSchema = z.object({
  id: sourceDocumentIdSchema,
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative()
}).strict();

export const sourceDocumentSchema = z.object({
  id: sourceDocumentIdSchema,
  name: sourceDocumentNameSchema,
  text: sourceIntakeTextSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  paragraphs: z.array(sourceParagraphSchema).max(MAX_SOURCE_DOCUMENT_CODE_POINTS)
}).strict();

export const sourceCitationSchema = z.object({
  sourceId: sourceDocumentIdSchema,
  paragraphId: sourceDocumentIdSchema,
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  quote: z.string().min(1).superRefine((value, context) => {
    if (Array.from(value).length > MAX_SOURCE_DOCUMENT_CODE_POINTS) {
      context.addIssue({ code: "too_big", maximum: MAX_SOURCE_DOCUMENT_CODE_POINTS, origin: "string", inclusive: true, message: "The source citation quote exceeds the code-point limit." });
    }
  })
}).strict();

export const sourceFactKindSchema = z.enum([
  "character", "location", "faction", "relationship", "rule", "event", "tone"
]);
export const sourceFactProvenanceSchema = z.enum(["stated", "inferred", "invented", "manual"]);
export const sourceFactSchema = z.object({
  id: sourceDocumentIdSchema,
  kind: sourceFactKindSchema,
  subject: z.string().trim().min(1).max(4_000),
  predicate: z.string().trim().min(1).max(4_000),
  value: z.string().trim().min(1).max(4_000),
  provenance: sourceFactProvenanceSchema,
  citations: z.array(sourceCitationSchema).max(200)
}).strict();

export const sourceAuthoringInputSchema = z.object({
  kind: z.literal("story_source"),
  idempotencyKey: z.string().trim().min(1).max(512),
  target: z.object({ kind: z.literal("new_world") }).strict(),
  name: sourceDocumentNameSchema,
  text: sourceIntakeTextSchema,
  mode: z.enum(["faithful", "expand"]),
  boundaryParagraphId: sourceDocumentIdSchema,
  instructions: sourceInstructionsSchema
}).strict();

/** Owner-only source extraction and review detail. List projections never include it. */
export const sourceAuthoringViewSchema = z.object({
  source: sourceDocumentSchema,
  boundaryParagraphId: sourceDocumentIdSchema,
  mode: z.enum(["faithful", "expand"]),
  facts: z.array(sourceFactSchema).max(50_000),
  extractionComplete: z.boolean(),
  acceptedFactIds: z.array(sourceDocumentIdSchema).max(50_000),
  rejectedFactIds: z.array(sourceDocumentIdSchema).max(50_000),
  selectedCharacterFactIds: z.array(sourceDocumentIdSchema).max(20),
  expansionCandidates: z.array(sourceFactSchema).max(50_000)
}).strict();

export type SourceDocument = z.infer<typeof sourceDocumentSchema>;
export type SourceCitation = z.infer<typeof sourceCitationSchema>;
export type SourceFact = z.infer<typeof sourceFactSchema>;
export type SourceAuthoringInput = z.infer<typeof sourceAuthoringInputSchema>;
export type SourceAuthoringView = z.infer<typeof sourceAuthoringViewSchema>;
