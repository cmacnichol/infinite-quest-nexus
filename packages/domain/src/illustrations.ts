export type IllustrationSegment = {
  ordinal: number;
  startOffset: number;
  endOffset: number;
  startWord: number;
  endWord: number;
  wordCount: number;
  text: string;
};

export function isIllustrationSegmentEligible(
  segment: Pick<IllustrationSegment, "wordCount">,
  configuredWordCount: number
): boolean {
  return segment.wordCount >= configuredWordCount / 2;
}

function wordTokens(text: string): Array<{ index: number; end: number }> {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  return [...segmenter.segment(text)]
    .filter((part) => part.isWordLike)
    .map((part) => ({ index: part.index, end: part.index + part.segment.length }));
}

function isSentenceBoundary(text: string): boolean {
  return /[.!?][”"'’)\]]*\s*$/u.test(text);
}

export function segmentIllustrationText(text: string, maximumWords: number): IllustrationSegment[] {
  if (!Number.isInteger(maximumWords) || maximumWords < 1) throw new Error("Segment word count must be a positive integer.");
  const words = wordTokens(text);
  if (!words.length) return [];

  const segments: IllustrationSegment[] = [];
  let startWord = 0;
  while (startWord < words.length) {
    const maximumEndWord = Math.min(words.length, startWord + maximumWords);
    let endWord = maximumEndWord;
    if (maximumEndWord < words.length) {
      for (let candidate = maximumEndWord; candidate > startWord; candidate -= 1) {
        const candidateEnd = words[candidate]?.index ?? text.length;
        const candidateStart = startWord === 0 ? 0 : words[startWord]!.index;
        if (isSentenceBoundary(text.slice(candidateStart, candidateEnd))) {
          endWord = candidate;
          break;
        }
      }
    }
    if (endWord <= startWord) endWord = maximumEndWord;
    const startOffset = startWord === 0 ? 0 : words[startWord]!.index;
    const endOffset = endWord >= words.length ? text.length : words[endWord]!.index;
    segments.push({
      ordinal: segments.length,
      startOffset,
      endOffset,
      startWord,
      endWord,
      wordCount: endWord - startWord,
      text: text.slice(startOffset, endOffset)
    });
    startWord = endWord;
  }
  return segments;
}

export class StreamingSegmentTracker {
  public emittedSegmentCount = 0;
  public accumulatedWordCount = 0;
  private lastProcessedWordIndex = 0;

  constructor(private readonly segmentWordCount: number) {
    if (!Number.isInteger(segmentWordCount) || segmentWordCount < 1) {
      throw new Error("Segment word count must be a positive integer.");
    }
  }

  detectNewSegments(narrationText: string): IllustrationSegment[] {
    const words = wordTokens(narrationText);
    this.accumulatedWordCount = words.length;

    if (words.length === 0 || words.length - this.lastProcessedWordIndex < this.segmentWordCount) {
      return [];
    }

    const segments = segmentIllustrationText(narrationText, this.segmentWordCount);
    
    // Filter to only segments that we haven't emitted yet AND that are "complete"
    // A segment is complete if it's not the last one, OR if we have enough words beyond it
    // to consider the next segment started. Actually, if it's the last one in the `segments` array,
    // it might still be growing, unless it perfectly aligns with the end of the text.
    // To be safe during streaming, we only emit a segment if there are words AFTER it 
    // (i.e. it's not the final segment in the array), OR if its word count reached the exact maximum and we're sure it's done.
    // Simpler rule: just don't emit the very last segment from segmentIllustrationText during streaming, 
    // because it represents the "current" incomplete segment.
    
    const completeSegments = segments.slice(0, -1); 
    const newSegments = completeSegments.filter(s => s.ordinal >= this.emittedSegmentCount);

    if (newSegments.length > 0) {
      const lastNew = newSegments[newSegments.length - 1]!;
      this.lastProcessedWordIndex = lastNew.endWord;
      this.emittedSegmentCount += newSegments.length;
    }

    return newSegments;
  }
}

export function directIllustrationPrompt(segmentText: string, template?: string): string {
  const segment = stripMechanicsLeakage(stripPromptPart(segmentText)).text;
  return renderPromptTemplate(template || PROMPT_TEMPLATE_CATALOG.illustration_direct.defaultContent, { segment });
}

/**
 * Image endpoints cap prompt length (4,000 characters for some OpenAI models).
 * The budget leaves room for the exclusions a provider adapter may append.
 */
export const MAX_ILLUSTRATION_PROVIDER_PROMPT_CHARACTERS = 3_400;

const COMPOSED_PROMPT_BLOCK = /\n\s*(?:ART STYLE|CANONICAL CHARACTER REFERENCE):\s*\n/i;

/** The scene part of a provider prompt, without the blocks composition appends. */
export function illustrationScenePrompt(prompt: string): string {
  return stripPromptPart(prompt).split(COMPOSED_PROMPT_BLOCK, 1)[0]!.trim();
}

/**
 * Wording every illustration prompt shares: the template text around its
 * variables. Library matching ignores it so prompts compare by scene content.
 */
export function illustrationTemplateWording(templates: readonly (string | undefined)[] = []): string {
  return [
    PROMPT_TEMPLATE_CATALOG.illustration_direct.defaultContent,
    PROMPT_TEMPLATE_CATALOG.illustration_character_reference.defaultContent,
    ...templates
  ].filter((template): template is string => Boolean(template))
    .map((template) => template.replace(/{{[A-Za-z][A-Za-z0-9_]*}}/g, " "))
    .join("\n");
}

export type IllustrationPromptCompositionOptions = Readonly<{
  /** Campaign-wide medium and style, kept identical across every image. */
  artStyle?: string;
  maximumCharacters?: number;
}>;

export function composeIllustrationProviderPrompt(
  scenePrompt: string,
  characterVisualReference: string,
  template?: string,
  options: IllustrationPromptCompositionOptions = {},
): string {
  const scene = stripMechanicsLeakage(illustrationScenePrompt(scenePrompt)).text;
  const character = stripMechanicsLeakage(stripPromptPart(characterVisualReference)).text;
  const artStyle = stripMechanicsLeakage(stripPromptPart(options.artStyle ?? "")).text;
  const maximumCharacters = options.maximumCharacters ?? MAX_ILLUSTRATION_PROVIDER_PROMPT_CHARACTERS;
  const render = (sceneText: string) => {
    const styled = artStyle ? `${sceneText}\n\nART STYLE:\n${artStyle}` : sceneText;
    return character
      ? renderPromptTemplate(template || PROMPT_TEMPLATE_CATALOG.illustration_character_reference.defaultContent, { scene: styled, character })
      : styled;
  };
  const full = render(scene);
  if (full.length <= maximumCharacters) return full;
  // Shorten only the scene so the style and character reference survive.
  const overhead = full.length - scene.length;
  return render(truncateAtBoundary(scene, Math.max(200, maximumCharacters - overhead)));
}

function stripPromptPart(value: string): string {
  return String(value || "").trim();
}
import { PROMPT_TEMPLATE_CATALOG, renderPromptTemplate } from "../../contracts/src/prompt-library.js";
import { stripMechanicsLeakage, truncateAtBoundary } from "./text.js";
