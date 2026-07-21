import { storyTurnOutputSchema, type StoryTurnOutput } from "../../contracts/src/generation.js";
import { containsMechanicsLanguage, mechanicsLanguageMatches } from "../../domain/src/text.js";
import { formatNarrationParagraphs } from "./narration-formatting.js";

export { containsMechanicsLanguage, mechanicsLanguageMatches } from "../../domain/src/text.js";

export type StoryParseResult =
  | { ok: true; story: StoryTurnOutput }
  | { ok: false; code: "invalid_json" | "invalid_schema" | "mechanics_leak"; errors: string[] };

export type StoryMemoryDefaults = {
  continuitySummary?: string;
  canonicalFacts?: string[];
  supersededFacts?: string[];
  openThreads?: string[];
};

export function extractJsonObject(content: string): unknown {
  const value = String(content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = value.indexOf("{");
  if (start < 0) throw new SyntaxError("The response did not contain a JSON object.");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(value.slice(start, index + 1));
    }
  }
  throw new SyntaxError("The JSON object ended before its closing brace.");
}

function unescapeJsonString(str: string): string {
  let cleaned = str.replace(/\\(?:u[0-9a-fA-F]{0,3}|[0-9a-fA-F]{0,3})?$/u, "");
  if (cleaned.endsWith("\\")) cleaned = cleaned.slice(0, -1);
  return cleaned
    .replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/gu, "\n")
    .replace(/\\r/gu, "\r")
    .replace(/\\t/gu, "\t")
    .replace(/\\"/gu, '"')
    .replace(/\\\\/gu, "\\")
    .replace(/\\\//gu, "/")
    .replace(/\\b/gu, "\b")
    .replace(/\\f/gu, "\f");
}

export function extractPartialNarration(content: string): string {
  const raw = String(content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!raw) return "";
  if (raw.startsWith("{")) {
    const match = /["']narration["']\s*:\s*"/i.exec(raw);
    if (!match) return "";
    const start = match.index + match[0].length;
    let end = raw.length;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const character = raw[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        end = index;
        break;
      }
    }
    const slice = raw.slice(start, end);
    const unescaped = unescapeJsonString(slice);
    if (containsMechanicsLanguage(unescaped)) return "";
    return formatNarrationParagraphs(unescaped);
  }
  const unescaped = unescapeJsonString(raw);
  if (containsMechanicsLanguage(unescaped)) return "";
  return formatNarrationParagraphs(unescaped);
}

function storyTextFields(story: StoryTurnOutput): Array<[string, string]> {
  return [
    ["narration", story.narration],
    ...story.choices.map((choice, index) => [`choices[${index}]`, choice] as [string, string]),
    ["custom_action_suggestion", story.custom_action_suggestion],
    ["scratchpad", story.scratchpad],
    ["image_prompt", story.image_prompt],
    ["tracker_updates", JSON.stringify(story.tracker_updates)],
    ["continuity_summary", story.continuity_summary],
    ["canonical_facts", JSON.stringify(story.canonical_facts)],
    ["superseded_facts", JSON.stringify(story.superseded_facts)],
    ["open_threads", JSON.stringify(story.open_threads)]
  ];
}

export function mechanicsLeakFields(story: StoryTurnOutput): string[] {
  return storyTextFields(story)
    .filter(([, value]) => containsMechanicsLanguage(value))
    .map(([field]) => field);
}

export function mechanicsLeakErrors(story: StoryTurnOutput): string[] {
  return storyTextFields(story).flatMap(([field, value]) => {
    const matches = mechanicsLanguageMatches(value);
    if (!matches.length) return [];
    const terms = [...new Set(matches.map((match) => match.text))].slice(0, 5);
    return [`Mechanics language detected in ${field}: ${terms.map((term) => JSON.stringify(term)).join(", ")}.`];
  });
}

function withRecoverableMemoryFields(parsed: unknown, defaults: StoryMemoryDefaults): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const story = parsed as Record<string, unknown>;
  const narration = typeof story.narration === "string" ? story.narration.trim() : "";
  return {
    ...story,
    continuity_summary: story.continuity_summary === undefined
      ? String(defaults.continuitySummary || narration).trim().slice(0, 20_000)
      : story.continuity_summary,
    canonical_facts: story.canonical_facts === undefined ? (defaults.canonicalFacts || []) : story.canonical_facts,
    superseded_facts: story.superseded_facts === undefined ? (defaults.supersededFacts || []) : story.superseded_facts,
    open_threads: story.open_threads === undefined ? (defaults.openThreads || []) : story.open_threads
  };
}

export function parseStoryOutput(content: string, memoryDefaults: StoryMemoryDefaults = {}): StoryParseResult {
  let parsed: unknown;
  try {
    parsed = withRecoverableMemoryFields(extractJsonObject(content), memoryDefaults);
  } catch (error) {
    return { ok: false, code: "invalid_json", errors: [error instanceof Error ? error.message : String(error)] };
  }
  const validated = storyTurnOutputSchema.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, code: "invalid_schema", errors: validated.error.issues.map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`) };
  }
  const story = {
    ...validated.data,
    narration: formatNarrationParagraphs(validated.data.narration)
  };
  const leakErrors = mechanicsLeakErrors(story);
  if (leakErrors.length) return { ok: false, code: "mechanics_leak", errors: leakErrors };
  return { ok: true, story };
}
