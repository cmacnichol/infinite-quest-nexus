import { storyTurnOutputSchema, type StoryTurnOutput } from "../../contracts/src/generation.js";

const MECHANICS_PATTERNS = [
  /\broll(?:s|ed|ing)?\b/i,
  /\bdice?\b/i,
  /\bd(?:4|6|8|10|12|20|100)\b/i,
  /\b(?:stat|skill|ability)\s+check\b/i,
  /\bdifficulty(?:\s+(?:class|modifier|label))?\b/i,
  /\bmodifier\s*[:=]?\s*[+-]?\d+/i,
  /\btarget\s+(?:number\s+)?\d{1,3}%?/i,
  /\b(?:success|failure)\s+by\s+\d+/i,
  /\b(?:critical|automatic)\s+(?:success|failure)\b/i,
  /\bpercentile\b/i
];

export function containsMechanicsLanguage(value: string): boolean {
  return MECHANICS_PATTERNS.some((pattern) => pattern.test(String(value ?? "")));
}

export type StoryParseResult =
  | { ok: true; story: StoryTurnOutput }
  | { ok: false; code: "invalid_json" | "invalid_schema" | "mechanics_leak"; errors: string[] };

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

function storyTextFields(story: StoryTurnOutput): Array<[string, string]> {
  return [
    ["narration", story.narration],
    ...story.choices.map((choice, index) => [`choices[${index}]`, choice] as [string, string]),
    ["custom_action_suggestion", story.custom_action_suggestion],
    ["scratchpad", story.scratchpad],
    ["image_prompt", story.image_prompt],
    ["tracker_updates", JSON.stringify(story.tracker_updates)]
  ];
}

export function mechanicsLeakFields(story: StoryTurnOutput): string[] {
  return storyTextFields(story)
    .filter(([, value]) => containsMechanicsLanguage(value))
    .map(([field]) => field);
}

export function parseStoryOutput(content: string): StoryParseResult {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(content);
  } catch (error) {
    return { ok: false, code: "invalid_json", errors: [error instanceof Error ? error.message : String(error)] };
  }
  const validated = storyTurnOutputSchema.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, code: "invalid_schema", errors: validated.error.issues.map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`) };
  }
  const leaked = mechanicsLeakFields(validated.data);
  if (leaked.length) return { ok: false, code: "mechanics_leak", errors: leaked.map((field) => `Mechanics language detected in ${field}.`) };
  return { ok: true, story: validated.data };
}
