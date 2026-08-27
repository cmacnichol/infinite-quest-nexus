import { MAX_MEMORY_CONTEXT_BUDGET_TOKENS } from "@infinite-quest/contracts";

export const DEFAULT_STORY_CONTEXT_BUDGET_TOKENS = 32_000;
export const STORY_CONTEXT_BUDGET_STORAGE_KEY = "infinite-quest.story.context-budget-tokens";

export const STORY_CONTEXT_BUDGET_PRESETS = [
  { value: 32_000, label: "Standard · 32K" },
  { value: 64_000, label: "Expanded · 64K" },
  { value: 128_000, label: "Large · 128K" },
  { value: 256_000, label: "Very large · 256K" },
  { value: MAX_MEMORY_CONTEXT_BUDGET_TOKENS, label: "Maximum available · up to 1M" }
] as const;

export type StoryContextBudgetTokens = (typeof STORY_CONTEXT_BUDGET_PRESETS)[number]["value"];

export type StoryContextBudgetStorage = Readonly<{
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}>;

export function normalizeStoryContextBudgetTokens(value: unknown): StoryContextBudgetTokens {
  if (
    value === 32_000
    || value === 64_000
    || value === 128_000
    || value === 256_000
    || value === MAX_MEMORY_CONTEXT_BUDGET_TOKENS
  ) return value;
  return DEFAULT_STORY_CONTEXT_BUDGET_TOKENS;
}

export function loadStoryContextBudgetTokens(
  storage: Pick<StoryContextBudgetStorage, "getItem"> | null | undefined
): StoryContextBudgetTokens {
  try {
    const stored = storage?.getItem(STORY_CONTEXT_BUDGET_STORAGE_KEY);
    return typeof stored === "string" && /^\d+$/u.test(stored)
      ? normalizeStoryContextBudgetTokens(Number(stored))
      : DEFAULT_STORY_CONTEXT_BUDGET_TOKENS;
  } catch {
    return DEFAULT_STORY_CONTEXT_BUDGET_TOKENS;
  }
}

export function saveStoryContextBudgetTokens(
  storage: Pick<StoryContextBudgetStorage, "setItem"> | null | undefined,
  value: unknown
): StoryContextBudgetTokens {
  const normalized = normalizeStoryContextBudgetTokens(value);
  try {
    storage?.setItem(STORY_CONTEXT_BUDGET_STORAGE_KEY, String(normalized));
  } catch {
    // Story controls continue to work when browser storage is blocked.
  }
  return normalized;
}
