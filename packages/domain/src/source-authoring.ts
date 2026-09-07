import { createHash } from "node:crypto";
import {
  sourceDocumentIdSchema,
  sourceDocumentNameSchema,
  sourceCitationSchema,
  sourceDocumentSchema,
  sourceIntakeTextSchema,
  sourceFactSchema,
  type SourceCitation,
  type SourceDocument,
  type SourceFact
} from "../../contracts/src/source-authoring.js";
import { sourceFactKindSchema } from "../../contracts/src/source-authoring.js";
import {
  worldSourceMaterialSchema,
  type WorldContent,
  type WorldSourceMaterial
} from "../../contracts/src/world-library.js";
import { z } from "zod";
import type { SourceChunk } from "./source-authoring-budget.js";

function normalizeSourceText(text: string): string {
  sourceIntakeTextSchema.parse(text);
  return text.replace(/^\uFEFF/u, "").replace(/\r\n|\r/gu, "\n");
}

function isBlankLine(characters: readonly string[]): boolean {
  return characters.every((character) => /\s/u.test(character));
}

function paragraphMap(text: string): SourceDocument["paragraphs"] {
  const characters = Array.from(text);
  const paragraphs: SourceDocument["paragraphs"] = [];
  let lineStart = 0;
  let paragraphStart: number | null = null;
  let paragraphEnd = 0;
  for (let index = 0; index <= characters.length; index += 1) {
    if (index !== characters.length && characters[index] !== "\n") continue;
    const lineEnd = index;
    if (isBlankLine(characters.slice(lineStart, lineEnd))) {
      if (paragraphStart !== null) {
        paragraphs.push({ id: `paragraph:${paragraphs.length}`, start: paragraphStart, end: paragraphEnd });
        paragraphStart = null;
      }
    } else {
      if (paragraphStart === null) paragraphStart = lineStart;
      paragraphEnd = lineEnd;
    }
    lineStart = index + 1;
  }
  if (paragraphStart !== null) {
    paragraphs.push({ id: `paragraph:${paragraphs.length}`, start: paragraphStart, end: paragraphEnd });
  }
  return paragraphs;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sourceCharacters(source: SourceDocument): string[] {
  return Array.from(source.text);
}

function sameParagraphMap(left: SourceDocument["paragraphs"], right: SourceDocument["paragraphs"]): boolean {
  return left.length === right.length && left.every((paragraph, index) => {
    const candidate = right[index];
    return candidate !== undefined && paragraph.id === candidate.id && paragraph.start === candidate.start && paragraph.end === candidate.end;
  });
}

/** Validates the retained normalized source once before any downstream planning. */
export function hasValidSourceDocumentIntegrity(source: SourceDocument): boolean {
  if (!sourceDocumentSchema.safeParse(source).success) return false;
  // Intake removes only one BOM. A retained BOM may therefore be the preserved
  // second BOM from raw input and cannot be distinguished from this projection.
  if (source.text.includes("\r")) return false;
  return source.sha256 === sha256(source.text) && sameParagraphMap(source.paragraphs, paragraphMap(source.text));
}

export function normalizeSourceDocument(name: string, text: string, id: string): SourceDocument {
  const normalized = normalizeSourceText(text);
  return sourceDocumentFromNormalizedText(name, normalized, id);
}

/** Reconstruct the exact persisted normalization without applying BOM/line-ending normalization again. */
export function sourceDocumentFromNormalizedText(name: string, text: string, id: string): SourceDocument {
  sourceIntakeTextSchema.parse(text);
  if (text.includes("\r")) throw new TypeError("Persisted normalized source text cannot contain carriage returns.");
  return sourceDocumentSchema.parse({
    id: sourceDocumentIdSchema.parse(id),
    name: sourceDocumentNameSchema.parse(name),
    text,
    sha256: sha256(text),
    paragraphs: paragraphMap(text)
  });
}

/** Validates a citation against the retained complete source document. */
export function validateSourceCitation(source: SourceDocument, citation: SourceCitation): boolean {
  if (!hasValidSourceDocumentIntegrity(source) || !sourceCitationSchema.safeParse(citation).success) return false;
  if (citation.sourceId !== source.id || citation.start >= citation.end) return false;
  const paragraph = source.paragraphs.find((candidate) => candidate.id === citation.paragraphId);
  if (!paragraph || citation.start < paragraph.start || citation.end > paragraph.end) return false;
  return Array.from(source.text).slice(citation.start, citation.end).join("") === citation.quote;
}

/** Validates a citation against the selected source boundary as well as its paragraph. */
export function validateSourceCitationWithinBoundary(
  source: SourceDocument,
  citation: SourceCitation,
  boundaryParagraphId: string
): boolean {
  if (!validateSourceCitation(source, citation)) return false;
  const boundaryIndex = source.paragraphs.findIndex((paragraph) => paragraph.id === boundaryParagraphId);
  const citationIndex = source.paragraphs.findIndex((paragraph) => paragraph.id === citation.paragraphId);
  return boundaryIndex >= 0 && citationIndex >= 0 && citationIndex <= boundaryIndex;
}

/**
 * Validates the portable appendix after structural contract parsing. The retained
 * document is deliberately a selected prefix: its boundary is its final paragraph.
 */
export function validateWorldSourceMaterial(value: unknown): WorldSourceMaterial {
  const material = worldSourceMaterialSchema.parse(value);
  const source = material.documents[0]!;
  if (!hasValidSourceDocumentIntegrity(source)
    || material.boundary.sourceId !== source.id
    || source.paragraphs.at(-1)?.id !== material.boundary.paragraphId
    || source.paragraphs.at(-1)?.end !== Array.from(source.text).length) {
    throw new TypeError("Portable source material has invalid selected-source integrity.");
  }
  const facts = material.acceptedFacts.map((fact) => sourceFactSchema.parse(fact));
  const byId = new Map<string, SourceFact>();
  for (const fact of facts) {
    if (byId.has(fact.id)) throw new TypeError("Portable source material repeats an accepted fact.");
    const cited = fact.provenance === "stated" || fact.provenance === "inferred";
    if ((cited && (!fact.citations.length || !fact.citations.every((citation) => validateSourceCitationWithinBoundary(source, citation, material.boundary.paragraphId))))
      || (!cited && fact.citations.length !== 0)) {
      throw new TypeError("Portable source material has invalid accepted evidence.");
    }
    byId.set(fact.id, fact);
  }
  const paths = new Set<string>();
  for (const evidence of material.fieldEvidence) {
    if (paths.has(evidence.path) || new Set(evidence.factIds).size !== evidence.factIds.length || evidence.factIds.some((id) => !byId.has(id))) {
      throw new TypeError("Portable source material has invalid field evidence.");
    }
    paths.add(evidence.path);
  }
  const acceptedCharacterIds = new Set(facts.filter((fact) => fact.kind === "character").map((fact) => fact.id));
  const groups = material.characterIdentityGroups ?? [];
  const grouped = new Set<string>();
  for (const group of groups) {
    if (!group.factIds.includes(group.representativeFactId)
      || group.factIds.some((id) => grouped.has(id) || !acceptedCharacterIds.has(id))) {
      throw new TypeError("Portable source material has invalid character identity groups.");
    }
    for (const id of group.factIds) grouped.add(id);
  }
  const characterEvidence = material.fieldEvidence.filter((evidence) => evidence.path.startsWith("playableCharacters."));
  if (characterEvidence.length && (!material.characterIdentityGroups || grouped.size !== acceptedCharacterIds.size)) {
    throw new TypeError("Portable source material character evidence requires complete reviewed identity groups.");
  }
  return material;
}

/** Construct a prefix-only portable appendix and revalidate it before persistence. */
export function buildWorldSourceMaterial(input: Readonly<{
  source: SourceDocument;
  boundaryParagraphId: string;
  acceptedFacts: readonly SourceFact[];
  fieldEvidence: readonly WorldSourceMaterial["fieldEvidence"][number][];
  characterIdentityGroups?: WorldSourceMaterial["characterIdentityGroups"];
}>): WorldSourceMaterial {
  if (!hasValidSourceDocumentIntegrity(input.source)) throw new TypeError("Source document integrity is invalid.");
  const boundary = input.source.paragraphs.find((paragraph) => paragraph.id === input.boundaryParagraphId);
  if (!boundary) throw new TypeError("Selected source boundary is invalid.");
  const text = Array.from(input.source.text).slice(0, boundary.end).join("");
  const source = sourceDocumentFromNormalizedText(input.source.name, text, input.source.id);
  return validateWorldSourceMaterial({
    version: 1,
    documents: [source],
    boundary: { sourceId: source.id, paragraphId: boundary.id },
    acceptedFacts: input.acceptedFacts,
    fieldEvidence: input.fieldEvidence,
    ...(input.characterIdentityGroups === undefined ? {} : { characterIdentityGroups: input.characterIdentityGroups })
  });
}

/** Reject portable stale evidence after an import, rather than silently relabeling edited canon. */
export function validateWorldSourceMaterialForContent(content: WorldContent): WorldContent {
  if (!content.sourceMaterial) return content;
  const material = validateWorldSourceMaterial(content.sourceMaterial);
  const facts = new Map(material.acceptedFacts.map((fact) => [fact.id, fact]));
  for (const evidence of material.fieldEvidence) {
    const worldPath = /^world\.(tone|rules)$/u.exec(evidence.path);
    const characterPath = /^playableCharacters\.(source-character:(.+))\.profile\.appearance\.(clothing|hair|eyes|apparentAge)$/u.exec(evidence.path);
    const expected = worldPath === null
      ? undefined
      : { value: content.world[worldPath[1] as "tone" | "rules"], kind: worldPath[1] === "tone" ? "tone" : "rule", predicate: worldPath[1] };
    const character = characterPath === null ? undefined : content.playableCharacters.find((candidate) => candidate.id === characterPath[1]);
    const characterExpected = characterPath === null || !character
      ? undefined
      : { value: character.profile?.appearance[characterPath[3] as "clothing" | "hair" | "eyes" | "apparentAge"], kind: "character" as const, predicate: characterPath[3], representativeFactId: characterPath[2] };
    const target = expected ?? characterExpected;
    const group = characterExpected === undefined ? undefined : material.characterIdentityGroups?.find((candidate) => candidate.representativeFactId === characterExpected.representativeFactId);
    const predicate = expected?.predicate ?? characterExpected?.predicate;
    if (!target || typeof target.value !== "string" || predicate === undefined
      || evidence.factIds.some((id) => {
        const fact = facts.get(id);
        return !fact || fact.value !== target.value || fact.kind !== target.kind || fact.predicate.trim().toLocaleLowerCase() !== predicate.toLocaleLowerCase()
          || (characterExpected !== undefined && !group?.factIds.includes(id));
      })) {
      throw new TypeError("Portable source material field evidence does not match canonical content.");
    }
  }
  return content;
}

function normalizedFactValue(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function citationKey(citation: SourceCitation): string {
  return [citation.sourceId, citation.paragraphId, citation.start, citation.end, citation.quote]
    .map((part) => JSON.stringify(part)).join("|");
}

/**
 * Dedupe only exact normalized statements. Names alone are never an identity
 * signal, so differing predicate/value/provenance remains separately reviewable.
 */
export function mergeSourceFacts(facts: readonly SourceFact[]): SourceFact[] {
  const merged: Array<SourceFact & { readonly __mergeKey?: string }> = [];
  for (const fact of facts) {
    const key = [fact.kind, fact.subject, fact.predicate, fact.value, fact.provenance]
      .map(normalizedFactValue).join("\u0000");
    const factCitationKeys = new Set(fact.citations.map(citationKey));
    const index = merged.findIndex((candidate) => candidate.__mergeKey === key
      && candidate.citations.some((citation) => factCitationKeys.has(citationKey(citation))));
    const current = index < 0 ? undefined : merged[index];
    if (!current) {
      merged.push({ ...fact, citations: [...fact.citations], __mergeKey: key });
      continue;
    }
    const citations = new Map(current.citations.map((citation) => [citationKey(citation), citation]));
    for (const citation of fact.citations) citations.set(citationKey(citation), citation);
    merged[index] = { ...current, citations: [...citations.values()] };
  }
  return merged.map(({ __mergeKey: _mergeKey, ...fact }) => fact);
}

/** Validates the emitted text identity and paragraph spans of one planned chunk. */
export function hasValidSourceChunkIntegrity(source: SourceDocument, chunk: SourceChunk): boolean {
  if (!hasValidSourceDocumentIntegrity(source) || chunk.sourceId !== source.id) return false;
  const characters = sourceCharacters(source);
  const { start, end } = chunk.sourceRange;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > characters.length || start >= end) return false;
  if (sha256(characters.slice(start, end).join("")) !== chunk.contentHash) return false;
  const expected = source.paragraphs.filter((paragraph) => paragraph.end > start && paragraph.start < end);
  const spansByParagraphId = new Map<string, SourceChunk["spans"][number]>();
  for (const span of chunk.spans) {
    if (spansByParagraphId.has(span.paragraphId)) return false;
    spansByParagraphId.set(span.paragraphId, span);
  }
  return chunk.spans.length === expected.length && spansByParagraphId.size === expected.length && expected.every((paragraph) => {
    const span = spansByParagraphId.get(paragraph.id);
    return span !== undefined
      && span.start === Math.max(start, paragraph.start)
      && span.end === Math.min(end, paragraph.end)
      && span.start < span.end;
  });
}

/** Checks a trusted selected boundary without deriving it from untrusted chunk metadata. */
export function hasValidSourceChunkWithinBoundary(source: SourceDocument, chunk: SourceChunk, boundaryParagraphId: string): boolean {
  const boundary = source.paragraphs.find((paragraph) => paragraph.id === boundaryParagraphId);
  return boundary !== undefined && hasValidSourceChunkIntegrity(source, chunk)
    && chunk.sourceRange.end <= boundary.end
    && chunk.spans.every((span) => span.end <= boundary.end);
}

const sourceExtractionCitationSchema = z.object({
  paragraphId: sourceDocumentIdSchema,
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  quote: z.string().min(1)
}).strict();

const sourceExtractionCandidateSchema = z.object({
  category: sourceFactKindSchema,
  subject: z.string().trim().min(1).max(4_000),
  predicate: z.string().trim().min(1).max(4_000),
  value: z.string().trim().min(1).max(4_000),
  provenance: z.enum(["stated", "inferred"]),
  citations: z.array(sourceExtractionCitationSchema).min(1).max(200)
}).strict();

const sourceExtractionCandidatesSchema = z.array(sourceExtractionCandidateSchema).max(200);
type SourceExtractionCandidate = z.infer<typeof sourceExtractionCandidateSchema>;

function sourceEvidenceIssue(path: Array<string | number>): z.ZodIssue {
  return {
    code: "custom",
    path,
    message: "Generated source facts need exact evidence inside the selected source chunk.",
    params: { authoringReason: "source_evidence" }
  };
}

function stableSourceFactId(source: SourceDocument, fact: SourceExtractionCandidate, citations: SourceCitation[]): string {
  const evidence = citations
    .map((citation) => [citation.paragraphId, citation.start, citation.end, citation.quote].map((value) => JSON.stringify(value)).join(":"))
    .sort()
    .join("|");
  return `source-fact:${sha256([source.id, fact.category, fact.subject, fact.predicate, fact.value, fact.provenance, evidence].map((value) => JSON.stringify(value)).join("|"))}`;
}

function validateExtractedSourceFactsWithBoundary(
  source: SourceDocument,
  chunk: SourceChunk,
  input: unknown,
  boundaryParagraphId?: string
) {
  let parsed: SourceExtractionCandidate[];
  try {
    parsed = sourceExtractionCandidatesSchema.parse(input);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    throw new z.ZodError(error.issues.map((issue) => issue.code === "too_big"
      ? ({
        code: "too_big",
        origin: "array",
        maximum: 200,
        inclusive: true,
        path: ["facts", ...issue.path],
        message: "Generated source facts need exact evidence inside the selected source chunk."
      } as z.ZodIssue)
      : ({
        code: "custom",
        path: ["facts", ...issue.path],
        message: "Generated source facts need exact evidence inside the selected source chunk.",
        params: { authoringReason: "source_evidence" }
      } as z.ZodIssue)));
  }
  const integrity = boundaryParagraphId === undefined
    ? hasValidSourceChunkIntegrity(source, chunk)
    : hasValidSourceChunkWithinBoundary(source, chunk, boundaryParagraphId);
  if (!integrity) throw new z.ZodError([sourceEvidenceIssue(["facts", 0, "citations"])]);
  const characters = sourceCharacters(source);
  const paragraphById = new Map(source.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const paragraphIndexById = new Map(source.paragraphs.map((paragraph, index) => [paragraph.id, index]));
  const spanByParagraph = new Map(chunk.spans.map((span) => [span.paragraphId, span]));
  const boundaryIndex = boundaryParagraphId === undefined ? undefined : paragraphIndexById.get(boundaryParagraphId);
  const facts = parsed.map((candidate, factIndex) => {
    const citations = candidate.citations.map((citation, citationIndex) => {
      const paragraph = paragraphById.get(citation.paragraphId);
      const span = spanByParagraph.get(citation.paragraphId);
      const paragraphIndex = paragraphIndexById.get(citation.paragraphId);
      if (!paragraph || !span || citation.start >= citation.end
        || citation.start < paragraph.start || citation.end > paragraph.end
        || citation.start < span.start || citation.end > span.end
        || (boundaryIndex !== undefined && (paragraphIndex === undefined || paragraphIndex > boundaryIndex))
        || characters.slice(citation.start, citation.end).join("") !== citation.quote) {
        throw new z.ZodError([sourceEvidenceIssue(["facts", factIndex, "citations", citationIndex])]);
      }
      return { sourceId: source.id, ...citation };
    });
    return {
      id: stableSourceFactId(source, candidate, citations),
      kind: candidate.category,
      subject: candidate.subject,
      predicate: candidate.predicate,
      value: candidate.value,
      provenance: candidate.provenance,
      citations
    };
  });
  return facts;
}

/** Structural evidence validation; exact quotes do not establish semantic entailment. */
export function validateExtractedSourceFacts(source: SourceDocument, chunk: SourceChunk, input: unknown) {
  return validateExtractedSourceFactsWithBoundary(source, chunk, input);
}

/** Structural evidence validation with a trusted selected source boundary. */
export function validateExtractedSourceFactsWithinBoundary(
  source: SourceDocument,
  chunk: SourceChunk,
  boundaryParagraphId: string,
  input: unknown
) {
  return validateExtractedSourceFactsWithBoundary(source, chunk, input, boundaryParagraphId);
}
