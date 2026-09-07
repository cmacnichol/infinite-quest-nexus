import { createHash } from "node:crypto";
import {
  sourceDocumentIdSchema,
  sourceDocumentNameSchema,
  sourceCitationSchema,
  sourceDocumentSchema,
  sourceIntakeTextSchema,
  type SourceCitation,
  type SourceDocument
} from "../../contracts/src/source-authoring.js";

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

function sameParagraphMap(left: SourceDocument["paragraphs"], right: SourceDocument["paragraphs"]): boolean {
  return left.length === right.length && left.every((paragraph, index) => {
    const candidate = right[index];
    return candidate !== undefined && paragraph.id === candidate.id && paragraph.start === candidate.start && paragraph.end === candidate.end;
  });
}

function hasValidSourceIntegrity(source: SourceDocument): boolean {
  if (!sourceDocumentSchema.safeParse(source).success) return false;
  // Intake removes only one BOM. A retained BOM may therefore be the preserved
  // second BOM from raw input and cannot be distinguished from this projection.
  if (source.text.includes("\r")) return false;
  return source.sha256 === sha256(source.text) && sameParagraphMap(source.paragraphs, paragraphMap(source.text));
}

export function normalizeSourceDocument(name: string, text: string, id: string): SourceDocument {
  const normalized = normalizeSourceText(text);
  return sourceDocumentSchema.parse({
    id: sourceDocumentIdSchema.parse(id),
    name: sourceDocumentNameSchema.parse(name),
    text: normalized,
    sha256: sha256(normalized),
    paragraphs: paragraphMap(normalized)
  });
}

/** Validates a citation against the retained complete source document. */
export function validateSourceCitation(source: SourceDocument, citation: SourceCitation): boolean {
  if (!hasValidSourceIntegrity(source) || !sourceCitationSchema.safeParse(citation).success) return false;
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
