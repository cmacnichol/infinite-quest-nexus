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
  content.playableCharacters.forEach((character, index) => {
    if (characterIds.has(character.id)) {
      context.addIssue({
        code: "custom",
        path: ["playableCharacters", index, "id"],
        message: "Generated character IDs must be distinct."
      });
    }
    characterIds.add(character.id);
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

export function generatedWorldIssues(error: unknown): GeneratedWorldIssue[] {
  if (!(error instanceof z.ZodError)) return [];
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message
  }));
}
