import { createHash } from "node:crypto";
import { normalizeSourceText, sourceParagraphMap } from "../../contracts/src/source-normalization.js";
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

export type SourceWorldFieldFactRule = Readonly<{
  kind: SourceFact["kind"];
  predicate: string;
}>;

/** Closed canon fields may only be supported by these exact source fact shapes. */
const sourceWorldFieldFactRules = new Map<string, SourceWorldFieldFactRule>([
  ["world.rules", { kind: "rule", predicate: "rule" }],
  ["world.tone", { kind: "tone", predicate: "tone" }],
  ["profile.appearance.clothing", { kind: "character", predicate: "clothing" }],
  ["profile.appearance.hair", { kind: "character", predicate: "hair" }],
  ["profile.appearance.eyes", { kind: "character", predicate: "eyes" }],
  ["profile.appearance.apparentAge", { kind: "character", predicate: "age" }]
]);

export function sourceWorldFieldFactRule(path: string): SourceWorldFieldFactRule | undefined {
  return sourceWorldFieldFactRules.get(path);
}

/** Closed prompt and validator mapping; callers must not infer additional paths. */
export function sourceWorldFieldFactRequirements(): readonly Readonly<{ path: string; kind: SourceFact["kind"]; predicate: string }>[] {
  return [...sourceWorldFieldFactRules.entries()].map(([path, rule]) => ({ path, ...rule }));
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
  return source.sha256 === sha256(source.text) && sameParagraphMap(source.paragraphs, sourceParagraphMap(source.text));
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
    paragraphs: sourceParagraphMap(text)
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
    const expectedRule = worldPath === null ? undefined : sourceWorldFieldFactRule(`world.${worldPath[1]}`);
    const expected = worldPath === null || expectedRule === undefined
      ? undefined
      : { value: content.world[worldPath[1] as "tone" | "rules"], ...expectedRule };
    const character = characterPath === null ? undefined : content.playableCharacters.find((candidate) => candidate.id === characterPath[1]);
    const characterRule = characterPath === null ? undefined : sourceWorldFieldFactRule(`profile.appearance.${characterPath[3]}`);
    const characterExpected = characterPath === null || !character || characterRule === undefined
      ? undefined
      : { value: character.profile?.appearance[characterPath[3] as "clothing" | "hair" | "eyes" | "apparentAge"], ...characterRule, representativeFactId: characterPath[2] };
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

const sourceExtractionLegacyCitationSchema = z.object({
  paragraphId: sourceDocumentIdSchema,
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  quote: z.string().min(1)
}).strict();
const sourceExtractionQuoteAnchorCitationSchema = z.object({
  paragraphId: sourceDocumentIdSchema,
  quote: z.string().min(1)
}).strict();
const sourceExtractionCitationSchema = z.union([
  sourceExtractionLegacyCitationSchema,
  sourceExtractionQuoteAnchorCitationSchema
]);

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

function sourceEvidenceIssue(path: Array<string | number>, authoringReason: "source_evidence" | "source_schema" | "source_citation_target" | "source_coordinate_order" | "source_coordinates" | "source_quote" | "source_quote_ambiguous" = "source_evidence"): z.ZodIssue {
  return {
    code: "custom",
    path,
    message: "Generated source facts need exact evidence inside the selected source chunk.",
    params: { authoringReason }
  };
}

function deriveUniqueQuoteAnchor(
  source: SourceDocument,
  characters: readonly string[],
  paragraph: SourceDocument["paragraphs"][number],
  span: SourceChunk["spans"][number],
  citation: z.infer<typeof sourceExtractionQuoteAnchorCitationSchema>,
  issuePath: Array<string | number>
): SourceCitation {
  const spanText = characters.slice(span.start, span.end).join("");
  const firstUtf16 = spanText.indexOf(citation.quote);
  if (firstUtf16 < 0) throw new z.ZodError([sourceEvidenceIssue(issuePath, "source_quote")]);
  if (spanText.indexOf(citation.quote, firstUtf16 + 1) >= 0) {
    throw new z.ZodError([sourceEvidenceIssue(issuePath, "source_quote_ambiguous")]);
  }
  const start = span.start + Array.from(spanText.slice(0, firstUtf16)).length;
  const end = start + Array.from(citation.quote).length;
  if (start < paragraph.start || end > paragraph.end || start < span.start || end > span.end) {
    throw new z.ZodError([sourceEvidenceIssue(issuePath, "source_coordinates")]);
  }
  if (characters.slice(start, end).join("") !== citation.quote) {
    throw new z.ZodError([sourceEvidenceIssue(issuePath, "source_quote")]);
  }
  return { sourceId: source.id, paragraphId: citation.paragraphId, start, end, quote: citation.quote };
}

/**
 * Retain a useful structural location without ever returning a provider-supplied
 * object key. The public projector accepts this closed source path grammar.
 */
function safeSourceSchemaIssuePath(path: readonly PropertyKey[]): Array<string | number> {
  const factIndex = path[0];
  if (typeof factIndex !== "number" || !Number.isInteger(factIndex) || factIndex < 0) return ["facts"];
  const base: Array<string | number> = ["facts", factIndex];
  const field = path[1];
  if (field === "category" || field === "subject" || field === "predicate" || field === "value" || field === "provenance") {
    return [...base, field];
  }
  if (field !== "citations") return base;
  const citationIndex = path[2];
  if (typeof citationIndex !== "number" || !Number.isInteger(citationIndex) || citationIndex < 0) return [...base, "citations"];
  const citationBase: Array<string | number> = [...base, "citations", citationIndex];
  const citationField = path[3];
  return citationField === "paragraphId" || citationField === "start" || citationField === "end" || citationField === "quote"
    ? [...citationBase, citationField]
    : citationBase;
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
    const oversized = error.issues.find((issue) => issue.code === "too_big");
    if (oversized) {
      throw new z.ZodError([{
        code: "too_big",
        origin: "array",
        maximum: 200,
        inclusive: true,
        path: ["facts", ...oversized.path],
        message: "Generated source facts need exact evidence inside the selected source chunk."
      } as z.ZodIssue]);
    }
    throw new z.ZodError(error.issues.slice(0, 20).map((issue): z.ZodIssue => ({
      code: issue.code,
      path: safeSourceSchemaIssuePath(issue.path),
      message: "Generated source facts do not match the required fields.",
      ...(issue.code === "custom" ? { params: { authoringReason: "source_schema" } } : {})
    }) as z.ZodIssue));
  }
  const integrity = boundaryParagraphId === undefined
    ? hasValidSourceChunkIntegrity(source, chunk)
    : hasValidSourceChunkWithinBoundary(source, chunk, boundaryParagraphId);
  if (!integrity) throw new z.ZodError([sourceEvidenceIssue(["facts", 0, "citations"], "source_coordinates")]);
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
      if (!paragraph || !span || (boundaryIndex !== undefined && (paragraphIndex === undefined || paragraphIndex > boundaryIndex))) {
        throw new z.ZodError([sourceEvidenceIssue(["facts", factIndex, "citations", citationIndex], "source_citation_target")]);
      }
      if (!("start" in citation)) {
        return deriveUniqueQuoteAnchor(source, characters, paragraph, span, citation, ["facts", factIndex, "citations", citationIndex]);
      }
      if (citation.start >= citation.end) {
        throw new z.ZodError([sourceEvidenceIssue(["facts", factIndex, "citations", citationIndex], "source_coordinate_order")]);
      }
      if (citation.start < paragraph.start || citation.end > paragraph.end
        || citation.start < span.start || citation.end > span.end
      ) {
        throw new z.ZodError([sourceEvidenceIssue(["facts", factIndex, "citations", citationIndex], "source_coordinates")]);
      }
      if (characters.slice(citation.start, citation.end).join("") !== citation.quote) {
        throw new z.ZodError([sourceEvidenceIssue(["facts", factIndex, "citations", citationIndex], "source_quote")]);
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
