import { z } from "zod";
import {
  worldContentSchema,
  type WorldContent
} from "../../contracts/src/world-library.js";

export type GeneratedWorldIssue = {
  path: string;
  code: string;
  message: string;
};

const GENERATED_WORLD_ISSUE_LIMIT = 20;
const GENERATED_WORLD_ISSUE_PATH_LIMIT = 500;
const GENERATED_WORLD_ISSUE_CODE_LIMIT = 100;

const GENERATED_WORLD_ISSUE_MESSAGES: Readonly<Record<string, string>> = {
  invalid_json: "Generated world JSON is malformed.",
  invalid_type: "Generated content has an invalid type.",
  too_small: "Generated content is missing a required value.",
  too_big: "Generated content exceeds an allowed limit.",
  invalid_value: "Generated content contains an unsupported value.",
  invalid_union: "Generated content does not match an allowed structure.",
  invalid_format: "Generated content has an invalid format.",
  unrecognized_keys: "Generated content contains unsupported fields.",
  not_multiple_of: "Generated content contains an invalid numeric value."
};

const GENERATED_WORLD_CUSTOM_PATH_MESSAGES: Readonly<Record<string, string>> = {
  title: "Generated title is required.",
  "world.title": "Generated title is required.",
  genre: "Generated genre is required.",
  "world.genre": "Generated genre is required.",
  tone: "Generated tone is required.",
  "world.tone": "Generated tone is required.",
  backgroundStory: "Generated background and canon are required.",
  "world.backgroundStory": "Generated background and canon are required.",
  premise: "Generated premise is required.",
  "world.premise": "Generated premise is required.",
  firstAction: "Generated opening action is required.",
  "world.firstAction": "Generated opening action is required.",
  story_rules: "Generated rules are required.",
  "world.rules": "Generated rules are required.",
  playableCharacters: "Generated worlds require three or four playable characters."
};

function controlledGeneratedWorldIssueMessage(path: string, code: string): string {
  if (code !== "custom") {
    return GENERATED_WORLD_ISSUE_MESSAGES[code] || "Generated content failed validation.";
  }
  const exact = GENERATED_WORLD_CUSTOM_PATH_MESSAGES[path];
  if (exact) return exact;
  if (/^playableCharacters\.\d+\.id$/.test(path)) return "Generated character IDs must be distinct.";
  if (/^playableCharacters\.\d+\.name$/.test(path)) return "Generated character names must be distinct.";
  if (/^(?:playableCharacters\.\d+\.characterText|playable_characters\.\d+\.character_text|character_text)$/.test(path)) {
    return "Generated character guidance is required.";
  }
  if (/^(?:playableCharacters\.\d+\.profile|playable_characters\.\d+\.profile|profile)$/.test(path)) {
    return "Generated structured character profile is required.";
  }
  return "Generated content failed validation.";
}

export function generatedCharacterNameKey(name: string): string {
  return name.trim().toLowerCase();
}

const generatedWorldBaseSchema = worldContentSchema.superRefine((content, context) => {
  const requiredWorldFields = [
    ["title", "Generated title is required."],
    ["genre", "Generated genre is required."],
    ["tone", "Generated tone is required."],
    ["premise", "Generated premise is required."],
    ["backgroundStory", "Generated background and canon are required."],
    ["firstAction", "Generated opening action is required."],
    ["rules", "Generated rules are required."]
  ] as const;

  for (const [field, message] of requiredWorldFields) {
    if (!String(content.world[field] || "").trim()) {
      context.addIssue({ code: "custom", path: ["world", field], message });
    }
  }

  if (content.playableCharacters.length < 3 || content.playableCharacters.length > 4) {
    context.addIssue({
      code: "custom",
      path: ["playableCharacters"],
      message: "Generated worlds require three or four playable characters."
    });
  }

  const characterIds = new Set<string>();
  const characterNames = new Set<string>();
  content.playableCharacters.forEach((character, index) => {
    if (characterIds.has(character.id)) {
      context.addIssue({
        code: "custom",
        path: ["playableCharacters", index, "id"],
        message: "Generated character IDs must be distinct."
      });
    }
    characterIds.add(character.id);
    const nameKey = generatedCharacterNameKey(character.name);
    if (characterNames.has(nameKey)) {
      context.addIssue({
        code: "custom",
        path: ["playableCharacters", index, "name"],
        message: "Generated character names must be distinct."
      });
    }
    characterNames.add(nameKey);
    if (!character.characterText.trim()) {
      context.addIssue({
        code: "custom",
        path: ["playableCharacters", index, "characterText"],
        message: "Generated character guidance is required."
      });
    }
    if (!character.profile) {
      context.addIssue({
        code: "custom",
        path: ["playableCharacters", index, "profile"],
        message: "Generated structured character profile is required."
      });
    }
  });
});

export const generatedWorldContentSchema: z.ZodType<WorldContent> = generatedWorldBaseSchema;

export function parseCompleteGeneratedWorld(content: unknown): WorldContent {
  return generatedWorldContentSchema.parse(content);
}

export function projectGeneratedWorldIssues(value: unknown): GeneratedWorldIssue[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, GENERATED_WORLD_ISSUE_LIMIT).flatMap((issue) => {
    if (!issue || typeof issue !== "object") return [];
    const candidate = issue as Record<string, unknown>;
    const path = typeof candidate.path === "string"
      ? candidate.path.slice(0, GENERATED_WORLD_ISSUE_PATH_LIMIT)
      : "";
    const code = typeof candidate.code === "string"
      ? candidate.code.slice(0, GENERATED_WORLD_ISSUE_CODE_LIMIT)
      : "custom";
    return [{
      path,
      code,
      message: controlledGeneratedWorldIssueMessage(path, code)
    }];
  });
}

export function generatedWorldIssues(error: unknown): GeneratedWorldIssue[] {
  if (error instanceof SyntaxError) {
    return projectGeneratedWorldIssues([{
      path: "generatedWorld",
      code: "invalid_json",
      message: "Generated world JSON is malformed."
    }]);
  }
  if (!(error instanceof z.ZodError)) return [];
  return projectGeneratedWorldIssues(error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message
  })));
}
