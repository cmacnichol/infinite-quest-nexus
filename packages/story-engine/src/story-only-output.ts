import { z } from "zod";
import type { StoryTurnOutput } from "../../contracts/src/generation.js";
import { containsMechanicsLanguage } from "../../domain/src/text.js";
import { extractJsonObject, parseStoryOutput, type StoryParseResult } from "./output.js";

export type ChoiceFields = Pick<StoryTurnOutput, "choices" | "custom_action_suggestion">;
export type StoryWithoutChoices = Omit<StoryTurnOutput, keyof ChoiceFields>;
type ChoiceReason = "missing" | "count" | "length" | "duplicate" | "mechanics";

export type StoryOnlyParseResult =
  | { ok: true; story: StoryTurnOutput }
  | { ok: false; kind: "choices"; base: StoryWithoutChoices; reasons: readonly ChoiceReason[] }
  | { ok: false; kind: "story"; failure: StoryParseResult & { ok: false } };

const repairSchema = z.object({
  choices: z.array(z.string().trim().min(1).max(2000)).length(4),
  custom_action_suggestion: z.string().trim().min(1).max(2000)
}).strict();

const placeholderChoices: ChoiceFields = {
  choices: ["Continue.", "Observe.", "Wait.", "Speak."],
  custom_action_suggestion: "Describe your next move."
};

function normalizeChoice(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function choiceReasons(value: Record<string, unknown>): ChoiceReason[] {
  const reasons: ChoiceReason[] = [];
  const choices = value.choices;
  const custom = value.custom_action_suggestion;
  if (!Array.isArray(choices) || typeof custom !== "string" || !custom.trim()) reasons.push("missing");
  if (Array.isArray(choices) && choices.length !== 4) reasons.push("count");
  const values = [...(Array.isArray(choices) ? choices : []), custom];
  if (values.some((entry) => typeof entry !== "string" || entry.trim().length === 0 || entry.trim().length > 2000)) reasons.push("length");
  const strings = values.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0 && entry.trim().length <= 2000);
  const normalized = strings.map(normalizeChoice);
  if (new Set(normalized).size !== normalized.length) reasons.push("duplicate");
  if (strings.some(containsMechanicsLanguage)) reasons.push("mechanics");
  return reasons;
}

function protectedBase(value: Record<string, unknown>): StoryParseResult {
  return parseStoryOutput(JSON.stringify({ ...value, ...placeholderChoices }));
}

export function parseStoryOnlyOutput(content: string): StoryOnlyParseResult {
  const complete = parseStoryOutput(content);
  if (complete.ok) {
    const reasons = choiceReasons(complete.story as unknown as Record<string, unknown>);
    return reasons.length ? { ok: false, kind: "choices", base: omitChoices(complete.story), reasons } : complete;
  }
  let raw: unknown;
  try {
    raw = extractJsonObject(content);
  } catch {
    return { ok: false, kind: "story", failure: complete };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, kind: "story", failure: complete };
  const base = protectedBase(raw as Record<string, unknown>);
  if (!base.ok) return { ok: false, kind: "story", failure: complete };
  const reasons = choiceReasons(raw as Record<string, unknown>);
  return reasons.length
    ? { ok: false, kind: "choices", base: omitChoices(base.story), reasons }
    : { ok: false, kind: "story", failure: complete };
}

export function parseChoiceRepair(content: string): ChoiceFields {
  const parsed = repairSchema.parse(extractJsonObject(content));
  const reasons = choiceReasons(parsed);
  if (reasons.length) throw new Error(`Invalid choice repair: ${reasons.join(", ")}.`);
  return parsed;
}

export function mergeChoiceRepair(base: StoryWithoutChoices, fields: ChoiceFields): StoryTurnOutput {
  const parsed = parseStoryOnlyOutput(JSON.stringify({
    ...base,
    choices: fields.choices,
    custom_action_suggestion: fields.custom_action_suggestion
  }));
  if (!parsed.ok) throw new Error(parsed.kind === "choices"
    ? `Invalid choice repair: ${parsed.reasons.join(", ")}.`
    : `Invalid choice repair: ${parsed.failure.errors.join(" ")}`);
  return parsed.story;
}

function omitChoices(story: StoryTurnOutput): StoryWithoutChoices {
  const { choices: _choices, custom_action_suggestion: _suggestion, ...base } = story;
  return base;
}
