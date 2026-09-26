export type NarrationFormatSignals = Readonly<{
  rawParagraphBreaks: number;
  dialogueMarks: number;
  speechTagsWithoutMarks: number;
  suspectedUnquotedSpeech: boolean;
  paragraphsSynthesized: boolean;
}>;

const DIALOGUE_MARKS = /["“”«»]/gu;
// A speech verb directly after clause-ending punctuation and a speaker: "? Mara asks", ", you say".
const SPEECH_TAG = /[?!,]\s+(?:I|you|he|she|they|we|[A-Z][a-z]+)\s+(?:say|says|said|ask|asks|asked|reply|replies|replied|whisper|whispers|whispered|mutter|mutters|muttered|shout|shouts|shouted)\b/gu;

/** Advisory only: never used to reject, rewrite, or insert quotation marks. */
export function narrationFormatSignals(rawNarration: string, acceptedNarration: string): NarrationFormatSignals {
  const rawParagraphBreaks = (rawNarration.match(/\n\s*\n/gu) ?? []).length;
  const dialogueMarks = (rawNarration.match(DIALOGUE_MARKS) ?? []).length;
  const speechTagsWithoutMarks = dialogueMarks > 0 ? 0 : (rawNarration.match(SPEECH_TAG) ?? []).length;
  return {
    rawParagraphBreaks,
    dialogueMarks,
    speechTagsWithoutMarks,
    suspectedUnquotedSpeech: dialogueMarks === 0 && speechTagsWithoutMarks >= 2,
    paragraphsSynthesized: rawParagraphBreaks === 0 && /\n\s*\n/u.test(acceptedNarration)
  };
}
