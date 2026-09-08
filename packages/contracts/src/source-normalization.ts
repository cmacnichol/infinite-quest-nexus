import { sourceIntakeTextSchema, type SourceDocument } from "./source-authoring.js";

/** Browser-safe source representation: remove exactly one leading BOM and normalize line endings. */
export function normalizeSourceText(text: string): string {
  sourceIntakeTextSchema.parse(text);
  return text.replace(/^\uFEFF/u, "").replace(/\r\n|\r/gu, "\n");
}

function blankLine(characters: readonly string[]): boolean {
  return characters.every((character) => /\s/u.test(character));
}

/** Code-point offsets are shared by browser previews and the persisted source document. */
export function sourceParagraphMap(text: string): SourceDocument["paragraphs"] {
  const characters = Array.from(text);
  const paragraphs: SourceDocument["paragraphs"] = [];
  let lineStart = 0;
  let paragraphStart: number | null = null;
  let paragraphEnd = 0;
  for (let index = 0; index <= characters.length; index += 1) {
    if (index !== characters.length && characters[index] !== "\n") continue;
    const lineEnd = index;
    if (blankLine(characters.slice(lineStart, lineEnd))) {
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
  if (paragraphStart !== null) paragraphs.push({ id: `paragraph:${paragraphs.length}`, start: paragraphStart, end: paragraphEnd });
  return paragraphs;
}
