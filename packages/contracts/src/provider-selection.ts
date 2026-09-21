import { z } from "zod";

const presetSlugSchema = z.string().regex(
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
  "OpenRouter preset slugs must contain lowercase letters, numbers, periods, underscores, or hyphens."
).max(200);

export const textModelSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model"), modelId: z.string().trim().max(500) }).strict(),
  z.object({ kind: z.literal("openrouter_preset"), slug: presetSlugSchema }).strict()
]);

export type TextModelSelection = z.infer<typeof textModelSelectionSchema>;

type TextSelectionInput = Readonly<{
  providerType: string;
  providerRole: string;
  defaultModel: string;
  textSelection?: TextModelSelection | undefined;
}>;

function assertPresetAllowed(input: TextSelectionInput): void {
  if (input.providerType !== "openrouter" || (input.providerRole !== "text" && input.providerRole !== "intent")) {
    throw new Error("OpenRouter presets are available only for OpenRouter text or intent provider profiles.");
  }
}

export function selectionCompatibilityId(selection: TextModelSelection): string {
  return selection.kind === "model" ? selection.modelId : `@preset/${selection.slug}`;
}

/**
 * Converts the old single-string profile field into the public typed selection.
 * Only exact aliases become presets, so historical custom model IDs remain intact.
 */
export function normalizeTextSelection(input: TextSelectionInput): TextModelSelection {
  if (input.textSelection) {
    const selection = textModelSelectionSchema.parse(input.textSelection);
    if (selection.kind === "openrouter_preset") assertPresetAllowed(input);
    if (input.defaultModel.trim() && input.defaultModel.trim() !== selectionCompatibilityId(selection)) {
      throw new Error("defaultModel and textSelection contradict each other.");
    }
    return selection;
  }
  const model = input.defaultModel.trim();
  if (model.startsWith("@preset/")) {
    const match = /^@preset\/([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)$/.exec(model);
    if (!match) return { kind: "model", modelId: model };
    assertPresetAllowed(input);
    return { kind: "openrouter_preset", slug: match[1]! };
  }
  if (model.includes("@preset/")) throw new Error("Unsupported combined model/preset syntax.");
  return { kind: "model", modelId: model };
}
