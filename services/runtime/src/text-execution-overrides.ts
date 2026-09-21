import {
  normalizeTextSelection,
  selectionCompatibilityId,
  textExecutionOverridesSchema,
  textModelSelectionSchema,
  type TextExecutionOverrides,
  type TextModelSelection
} from "@infinite-quest/contracts";
import type { RuntimeTextExecution } from "./provider-credential-transport-adapter.js";
import type { TextExecutionPlanOverrides } from "./provider-preset-resolution.js";

function normalizedOverrides(value: TextExecutionOverrides): TextExecutionPlanOverrides {
  return {
    ...(value.parameters === undefined ? {} : { parameters: value.parameters }),
    ...(value.conservativeContextWindowTokens === undefined
      ? {}
      : { conservativeContextWindowTokens: value.conservativeContextWindowTokens })
  };
}

/**
 * Resolves the one effective override object before route preparation. Saved
 * intent follows only the profile's semantic selection; an explicit request
 * object replaces it, while null restores preset/profile inheritance.
 */
export function resolveEffectiveTextExecutionOverrides(input: Readonly<{
  execution: Pick<RuntimeTextExecution, "providerType" | "providerRole" | "model" | "textSelection" | "configuration">;
  selection: TextModelSelection;
  requestOverrides?: TextExecutionOverrides | null;
}>): TextExecutionPlanOverrides | undefined {
  if (input.requestOverrides !== undefined) {
    return input.requestOverrides === null
      ? undefined
      : normalizedOverrides(textExecutionOverridesSchema.parse(input.requestOverrides));
  }
  const profileSelection = input.execution.textSelection === undefined
    ? normalizeTextSelection({
      providerType: input.execution.providerType,
      providerRole: input.execution.providerRole,
      defaultModel: input.execution.model
    })
    : textModelSelectionSchema.parse(input.execution.textSelection);
  if (selectionCompatibilityId(input.selection) !== selectionCompatibilityId(profileSelection)) return undefined;
  const saved = input.execution.configuration.textExecutionOverrides;
  return saved === undefined ? undefined : normalizedOverrides(textExecutionOverridesSchema.parse(saved));
}
