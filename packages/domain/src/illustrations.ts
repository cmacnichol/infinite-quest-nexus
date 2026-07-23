export type IllustrationSegment = {
  ordinal: number;
  startOffset: number;
  endOffset: number;
  startWord: number;
  endWord: number;
  wordCount: number;
  text: string;
};

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

export function directIllustrationPrompt(segmentText: string): string {
  return [
    "Create one polished story illustration depicting only the concrete scene described in this passage.",
    "Preserve the visible characters, setting, mood, actions, and chronology. Do not add typography, captions, logos, interface elements, or non-diegetic overlays.",
    "",
    segmentText.trim()
  ].join("\n");
}
