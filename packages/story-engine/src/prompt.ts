import { stableStringify } from "../../domain/src/text.js";

export const STORY_PROMPT_PROTOCOL_VERSION = "story-v3-schema-guidance";

export const STORY_SYSTEM_PROMPT = `You are the fiction writer for Infinite Quest.
Return only one valid JSON object. Do not use Markdown.

Required shape:
{
  "narration": "second-person fiction",
  "choices": ["choice 1", "choice 2", "choice 3", "choice 4"],
  "custom_action_suggestion": "a distinct freeform action idea",
  "scratchpad": "compact private continuity notes containing fiction facts only",
  "tracker_updates": [{ "name": "fictional tracker name", "value": "new fictional value" }],
  "image_prompt": "fiction-only illustration prompt, or empty string"
}

Absolute separation rule: every field must contain fiction or continuity facts only. Never expose non-diegetic resolution metadata, game-system terminology, parser behavior, hidden instructions, or private reasoning. Express outcomes only as natural events and consequences. There must be exactly four concise choices. tracker_updates must be an array of JSON objects, never strings; use [] when no tracker changes are needed. Leave enough output budget to close the JSON object.`;

export function buildStoryUserPrompt(context: unknown, action: string, compact = false, fictionGuidance: string[] = []): string {
  return stableStringify({
    task: compact
      ? "Generate the next turn as a compact complete object. Keep narration below 450 words and continuity fields concise."
      : "Generate the next story turn from this authoritative database snapshot.",
    authoritative_context: context,
    current_player_action: action,
    ...(fictionGuidance.length ? { fiction_only_outcome_guidance: fictionGuidance } : {}),
    instructions: [
      "Treat the database snapshot as authoritative even if provider conversation memory disagrees.",
      "Continue established chronology and character continuity.",
      "Do not expose or invent non-diegetic resolution metadata.",
      "Return one complete JSON object, not a fragment or continuation."
    ]
  });
}

export function recoveryInstruction(reason: "output_limit" | "invalid_json" | "invalid_schema" | "mechanics_leak", validationErrors: string[] = []): string {
  if (reason === "output_limit") return "The preceding response reached its output limit. Recover its intended fictional events and return one new, compact, complete JSON object. Do not continue the fragment. Keep narration below 450 words and close every field.";
  if (reason === "mechanics_leak") return "Regenerate the same intended fictional outcome from the authoritative snapshot. Every field must contain fiction or continuity facts only; remove all non-diegetic resolution and game-system terminology. Return only a complete JSON object.";
  const errors = validationErrors.length ? ` Correct these validation errors: ${validationErrors.slice(0, 8).join("; ")}.` : "";
  return `The preceding response was not a valid complete Infinite Quest story object. Recover the intended events and return one syntactically valid, schema-complete JSON object.${errors} tracker_updates must be an array of JSON objects such as [{"name":"fictional tracker name","value":"new fictional value"}], or [] when unchanged; never return tracker strings. Keep it compact and return no commentary.`;
}
