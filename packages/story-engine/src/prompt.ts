import {
  DEFAULT_STORY_LENGTH_PROFILE,
  storyLengthWordRange,
  type StoryLengthWordRange
} from "../../contracts/src/story-settings.js";
import {
  PROMPT_TEMPLATE_CATALOG,
  renderPromptTemplate
} from "../../contracts/src/prompt-library.js";
export { STORY_PROMPT_PROTOCOL_VERSION, STORY_SYSTEM_PROMPT } from "../../contracts/src/story-prompt.js";

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
    return renderPromptTemplate(PROMPT_TEMPLATE_CATALOG.story_recovery_output_limit.defaultContent, compactLength);
  }
  if (reason === "mechanics_leak") {
    const details = validationErrors.length ? ` The fiction-boundary validator found: ${validationErrors.slice(0, 8).join("; ")}` : "";
    return renderPromptTemplate(PROMPT_TEMPLATE_CATALOG.story_recovery_mechanics.defaultContent, { details });
  }
  const errors = validationErrors.length ? ` Correct these validation errors: ${validationErrors.slice(0, 8).join("; ")}.` : "";
  return renderPromptTemplate(PROMPT_TEMPLATE_CATALOG.story_recovery_schema.defaultContent, { errors });
}
