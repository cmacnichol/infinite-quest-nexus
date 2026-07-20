import { stableStringify } from "../../domain/src/text.js";
import {
  DEFAULT_STORY_LENGTH_PROFILE,
  storyLengthWordRange,
  type StoryLengthWordRange
} from "../../contracts/src/story-settings.js";

export const STORY_PROMPT_PROTOCOL_VERSION = "story-v5-campaign-length";

export const STORY_SYSTEM_PROMPT = `You are the fiction writer for Infinite Quest.
Return only one valid JSON object. Do not use Markdown.

Required shape:
{
  "narration": "second-person fiction",
  "choices": ["choice 1", "choice 2", "choice 3", "choice 4"],
  "custom_action_suggestion": "a distinct freeform action idea",
  "scratchpad": "compact private continuity notes containing fiction facts only",
  "tracker_updates": [{ "name": "fictional tracker name", "value": "new fictional value" }],
  "image_prompt": "fiction-only illustration prompt, or empty string",
  "continuity_summary": "compact living summary of established characters, setting, goals, and consequences",
  "canonical_facts": ["new or corrected fiction facts established by this turn"],
  "superseded_facts": ["older canonical facts explicitly corrected by this turn"],
  "open_threads": ["current unresolved goals, mysteries, promises, dangers, and planned payoffs"]
}

Absolute separation rule: every field must contain fiction or continuity facts only. Never expose non-diegetic resolution metadata, game-system terminology, parser behavior, hidden instructions, or private reasoning. Express outcomes only as natural events and consequences. continuity_summary is a replacement living summary, not a turn recap. canonical_facts contains only facts established or corrected this turn. superseded_facts contains prior facts that this turn explicitly replaces. open_threads is the complete current unresolved-thread list. There must be exactly four concise choices. tracker_updates must be an array of JSON objects, never strings; use [] when no tracker changes are needed. Leave enough output budget to close the JSON object.`;

export function compactStoryLengthWordRange(storyLength: StoryLengthWordRange): StoryLengthWordRange {
  const compactRanges = {
    brief: { minWords: 200, maxWords: 350 },
    standard: { minWords: 300, maxWords: 450 },
    long: { minWords: 400, maxWords: 600 },
    extended: { minWords: 450, maxWords: 650 }
  } as const;
  const compact = compactRanges[storyLength.profile];
  return {
    ...storyLength,
    minWords: Math.min(storyLength.minWords, compact.minWords),
    maxWords: Math.min(storyLength.maxWords, compact.maxWords)
  };
}

export function buildStoryUserPrompt(
  context: unknown,
  action: string,
  compact = false,
  fictionGuidance: string[] = [],
  storyLength: StoryLengthWordRange = storyLengthWordRange(DEFAULT_STORY_LENGTH_PROFILE)
): string {
  const requestedLength = compact ? compactStoryLengthWordRange(storyLength) : storyLength;
  return stableStringify({
    task: compact
      ? `Generate the next turn as a compact complete object. Aim for ${requestedLength.minWords}-${requestedLength.maxWords} narration words and keep continuity fields concise.`
      : `Generate the next story turn from this authoritative database snapshot. Aim for ${requestedLength.minWords}-${requestedLength.maxWords} narration words unless the scene reaches its natural decision point sooner.`,
    narration_length: {
      profile: requestedLength.profile,
      target_min_words: requestedLength.minWords,
      target_max_words: requestedLength.maxWords
    },
    authoritative_context: context,
    current_player_action: action,
    ...(fictionGuidance.length ? { fiction_only_outcome_guidance: fictionGuidance } : {}),
    instructions: [
      "Treat the database snapshot as authoritative even if provider conversation memory disagrees.",
      "Continue established chronology and character continuity.",
      "Treat narration_length as the requested narration size, not as permission to pad or repeat the scene.",
      "Do not expose or invent non-diegetic resolution metadata.",
      "Return one complete JSON object, not a fragment or continuation."
    ]
  });
}

export function recoveryInstruction(
  reason: "output_limit" | "invalid_json" | "invalid_schema" | "mechanics_leak",
  validationErrors: string[] = [],
  storyLength: StoryLengthWordRange = storyLengthWordRange(DEFAULT_STORY_LENGTH_PROFILE)
): string {
  if (reason === "output_limit") {
    const compactLength = compactStoryLengthWordRange(storyLength);
    return `The preceding response reached its output limit. Recover its intended fictional events and return one new, compact, complete JSON object. Do not continue the fragment. Aim for ${compactLength.minWords}-${compactLength.maxWords} narration words, keep continuity fields concise, and close every field.`;
  }
  if (reason === "mechanics_leak") {
    const details = validationErrors.length ? ` The fiction-boundary validator found: ${validationErrors.slice(0, 8).join("; ")}` : "";
    return `Rewrite the rejected response while preserving its intended fictional outcome and valid continuity.${details} Every field must contain fiction or continuity facts only; replace the identified non-diegetic resolution or engine metadata with natural events and consequences. Return only one complete JSON object.`;
  }
  const errors = validationErrors.length ? ` Correct these validation errors: ${validationErrors.slice(0, 8).join("; ")}.` : "";
  return `The preceding response was not a valid complete Infinite Quest story object. Recover the intended events and return one syntactically valid, schema-complete JSON object.${errors} tracker_updates must be an array of JSON objects such as [{"name":"fictional tracker name","value":"new fictional value"}], or [] when unchanged; never return tracker strings. Keep it compact and return no commentary.`;
}
