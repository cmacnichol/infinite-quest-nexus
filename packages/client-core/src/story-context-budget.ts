import {
  DEFAULT_STORY_CONTEXT_BUDGET_TOKENS,
  STORY_CONTEXT_BUDGET_TOKEN_VALUES,
  storyContextBudgetTokensFromUnknown,
  type StoryContextBudgetTokens
} from "@infinite-quest/contracts";

export { DEFAULT_STORY_CONTEXT_BUDGET_TOKENS };
export type { StoryContextBudgetTokens };

export const STORY_CONTEXT_BUDGET_PRESETS = [
  { value: STORY_CONTEXT_BUDGET_TOKEN_VALUES[0], label: "Standard · 32K" },
  { value: STORY_CONTEXT_BUDGET_TOKEN_VALUES[1], label: "Expanded · 64K" },
  { value: STORY_CONTEXT_BUDGET_TOKEN_VALUES[2], label: "Large · 128K" },
  { value: STORY_CONTEXT_BUDGET_TOKEN_VALUES[3], label: "Very large · 256K" },
  { value: STORY_CONTEXT_BUDGET_TOKEN_VALUES[4], label: "Large context · 1M" },
  { value: STORY_CONTEXT_BUDGET_TOKEN_VALUES[5], label: "Expanded context · 2M" },
  { value: STORY_CONTEXT_BUDGET_TOKEN_VALUES[6], label: "Maximum available · up to 4M" }
] as const;

export function normalizeStoryContextBudgetTokens(value: unknown): StoryContextBudgetTokens {
  return storyContextBudgetTokensFromUnknown(value);
}
