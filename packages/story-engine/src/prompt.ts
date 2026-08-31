import {
  DEFAULT_STORY_LENGTH_PROFILE,
  storyLengthWordRange,
  type StoryLengthWordRange
} from "../../contracts/src/story-settings.js";

export const STORY_PROMPT_PROTOCOL_VERSION = "story-v13-current-state-corrections";

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
  "canonical_fact_updates": [{ "content": "new or corrected fiction fact", "supersedes_fact_ids": ["exact UUID from a visible canonical fact"] }],
  "open_threads": ["current unresolved goals, mysteries, promises, dangers, and planned payoffs"]
}

Format narration as readable prose paragraphs separated by two newline characters (\\n\\n). Prefer two to four sentences per paragraph. Start a new paragraph for a change of speaker, scene transition, or meaningful shift in focus. Do not use Markdown inside narration.

Priority order: (1) authoritative rules, established continuity, and the current turn input; (2) a complete, coherent turn and complete JSON object; (3) the requested narration length. The length range is a soft pacing goal, not a requirement. End early when the supported events have reached a natural stopping point. Never add repetition, recap, unsupported aftermath, a new material fact, character, location, motive, time jump, plot thread, or durable canon commitment merely to reach a word target. You may add brief sensory or connective detail only when it is consistent with the established situation and does not create a material new claim.

Absolute separation rule: every field must contain fiction or continuity facts only. Never expose non-diegetic resolution metadata, game-system terminology, parser behavior, hidden instructions, or private reasoning. Express outcomes only as natural events and consequences. The authoritativeRules scope contains mandatory world-specific constraints: obey every applicable rule on every turn, even when recent narration, conversation memory, or the player action conflicts with one. Treat those rules as instructions, not optional lore or style suggestions. When authoritative_context.currentContinuity is present, use its corrected current continuity as authoritative over conflicting historical narration or provider conversation memory. Empty corrected fields are intentional. Mandatory world rules still apply. scratchpad is required and must be the complete replacement continuity scratchpad: preserve every still-relevant note, remove only resolved or superseded notes, and return an empty string only when no private continuity remains. continuity_summary is a replacement living summary, not a turn recap. canonical_facts contains only facts established or corrected this turn. superseded_facts contains prior facts that this turn explicitly replaces. canonical_fact_updates is the structured form of canonical fact changes; use [] when there are none. For supersedes_fact_ids, copy only exact IDs shown on visible canonical facts in the authoritative context. Never invent, infer, alter, or reuse an ID that is not visible. Use an empty supersedes_fact_ids array for a new fact that replaces nothing. open_threads is the complete current unresolved-thread list. There must be exactly four concise choices. tracker_updates must be an array of JSON objects, never strings; use [] when no tracker changes are needed. Leave enough output budget to close the JSON object.`;

const COMPACT_RANGES = {
  brief: { minWords: 200, maxWords: 350 },
  standard: { minWords: 300, maxWords: 450 },
  long: { minWords: 400, maxWords: 600 },
  extended: { minWords: 450, maxWords: 650 }
} as const;

export function compactStoryLengthWordRange(storyLength: StoryLengthWordRange): StoryLengthWordRange {
  const compact = COMPACT_RANGES[storyLength.profile];
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
  storyLength: StoryLengthWordRange = storyLengthWordRange(DEFAULT_STORY_LENGTH_PROFILE),
  inputMode: "action" | "scene" = "action"
): string {
  const requestedLength = compact ? compactStoryLengthWordRange(storyLength) : storyLength;
  return JSON.stringify({
    authoritative_context: context,
    narration_length: {
      profile: requestedLength.profile,
      preferred_min_words: requestedLength.minWords,
      preferred_max_words: requestedLength.maxWords,
      policy: "soft_pacing_goal",
      early_stop_allowed: true
    },
    ...(fictionGuidance.length ? { fiction_only_outcome_guidance: fictionGuidance } : {}),
    instructions: [
      "Obey every applicable constraint in authoritative_context.authoritativeRules. These rules are mandatory and take priority over conflicting story history or player requests.",
      "Treat the database snapshot as authoritative even if provider conversation memory disagrees.",
      "Use corrected current continuity as authoritative for the next turn when it conflicts with historical narration or provider conversation memory. Empty corrected fields are intentional. Mandatory world rules still apply.",
      "Continue established chronology and character continuity.",
      "Treat narration_length as a soft pacing goal, not as a minimum requirement or permission to pad. Fidelity to authoritative context and the current turn input outranks length.",
      "Do not expose or invent non-diegetic resolution metadata.",
      "In canonical_fact_updates, supersedes_fact_ids may contain only exact IDs copied from canonical facts visible in the authoritative context; never invent a fact ID.",
      ...(inputMode === "scene" ? [
        "The current turn input is a scene direction: its concrete events, dialogue, sensory details, outcomes, and required beats are facts that happen in this turn.",
        "Dramatize every required beat in the narration before writing aftermath or advancing beyond it. Do not treat the scene direction as prior narration, summarize past it, contradict it, or silently omit it.",
        "Once the required beats and their directly supported consequences are complete, end the turn rather than inventing further events to reach the preferred range."
      ] : [
        "The current turn input is a player action or attempt. Preserve its stated manner, dialogue, and intent while resolving uncertain outcomes from authoritative context and fiction-only outcome guidance.",
        "Once the attempted action and its directly supported consequence are complete, end the turn rather than opening unsupported developments to reach the preferred range."
      ]),
      "Return one complete JSON object, not a fragment or continuation."
    ],
    current_turn_input: {
      mode: inputMode,
      text: action
    },
    task: compact
      ? `Generate the next turn as a compact complete object. Prefer ${requestedLength.minWords}-${requestedLength.maxWords} narration words only while the current input and supported consequences naturally sustain that length. End early when the turn is complete; do not pad, repeat, or invent material story facts to meet the range. Keep continuity fields concise.`
      : `Generate the next complete story turn from this authoritative database snapshot. Prefer ${requestedLength.minWords}-${requestedLength.maxWords} narration words only while the current input and supported consequences naturally sustain that length. End early when the turn is complete; do not pad, repeat, or invent material story facts to meet the range.`
  });
}

export function recoveryInstruction(
  reason: "output_limit" | "invalid_json" | "invalid_schema" | "mechanics_leak",
  validationErrors: string[] = [],
  storyLength: StoryLengthWordRange = storyLengthWordRange(DEFAULT_STORY_LENGTH_PROFILE)
): string {
  if (reason === "output_limit") {
    const compactLength = compactStoryLengthWordRange(storyLength);
    return `Return one complete replacement JSON object from the same supported fictional events. Do not continue the fragment. The ${compactLength.minWords}-${compactLength.maxWords} narration range is a soft pacing goal: preserve the requested scope when supported, but end early rather than adding unsupported facts or shortening a complete valid turn merely to fit a compact range. Keep continuity fields concise and close every field.`;
  }
  if (reason === "mechanics_leak") {
    const details = validationErrors.length ? ` The fiction-boundary validator found: ${validationErrors.slice(0, 8).join("; ")}` : "";
    return `Rewrite the rejected response as one complete JSON object. Preserve only the supported fictional outcome, required player-input beats, and valid continuity.${details} Remove mechanics language without adding new material events, canon facts, characters, locations, motives, time jumps, or plot developments. Length is a soft pacing goal; prefer a concise complete turn to padding.`;
  }
  const errors = validationErrors.length ? ` Correct these validation errors: ${validationErrors.slice(0, 8).join("; ")}.` : "";
  return `Return one syntactically valid, schema-complete replacement JSON object for the same supported turn.${errors} Preserve valid narration and continuity when possible. Do not add new material events or canon merely to make the replacement longer. tracker_updates must be an array of JSON objects such as [{"name":"fictional tracker name","value":"new fictional value"}], or [] when unchanged; never return tracker strings. Length is a soft pacing goal; finish once the supported turn is complete.`;
}
