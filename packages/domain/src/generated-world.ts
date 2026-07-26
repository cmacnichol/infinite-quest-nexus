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
const GENERATED_WORLD_ISSUE_MESSAGE_LIMIT = 500;

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
    return [{
      path: typeof candidate.path === "string"
        ? candidate.path.slice(0, GENERATED_WORLD_ISSUE_PATH_LIMIT)
        : "",
      code: typeof candidate.code === "string"
        ? candidate.code.slice(0, GENERATED_WORLD_ISSUE_CODE_LIMIT)
        : "custom",
      message: typeof candidate.message === "string"
        ? candidate.message.slice(0, GENERATED_WORLD_ISSUE_MESSAGE_LIMIT)
        : "Generated content is incomplete."
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
