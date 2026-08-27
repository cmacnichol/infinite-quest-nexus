import { describe, expect, it, vi } from "vitest";
import { MAX_MEMORY_CONTEXT_BUDGET_TOKENS } from "@infinite-quest/contracts";
import {
  DEFAULT_STORY_CONTEXT_BUDGET_TOKENS,
  STORY_CONTEXT_BUDGET_PRESETS,
  STORY_CONTEXT_BUDGET_STORAGE_KEY,
  loadStoryContextBudgetTokens,
  normalizeStoryContextBudgetTokens,
  saveStoryContextBudgetTokens
} from "../../../packages/client-core/src/index.js";

describe("Story context budget preference", () => {
  it("uses the configured preset when browser storage contains one", () => {
    const storage = {
      getItem: vi.fn(() => "128000")
    };

    expect(loadStoryContextBudgetTokens(storage)).toBe(128_000);
    expect(storage.getItem).toHaveBeenCalledWith("infinite-quest.story.context-budget-tokens");
  });

  it.each([undefined, null, "", "64000x", 512, 48_000, 1_000_001])(
    "falls back to Standard when %j is not a supported preset",
    (value) => {
      expect(normalizeStoryContextBudgetTokens(value)).toBe(32_000);
    }
  );

  it("uses Standard when stored data is invalid or browser storage is blocked", () => {
    const invalidStorage = { getItem: () => "48000" };
    const blockedStorage = { getItem: () => { throw new Error("storage blocked"); } };

    expect(loadStoryContextBudgetTokens(invalidStorage)).toBe(DEFAULT_STORY_CONTEXT_BUDGET_TOKENS);
    expect(loadStoryContextBudgetTokens(blockedStorage)).toBe(DEFAULT_STORY_CONTEXT_BUDGET_TOKENS);
  });

  it("keeps a valid selection usable when saving to browser storage is blocked", () => {
    const storage = {
      setItem: vi.fn(() => { throw new Error("storage blocked"); })
    };

    expect(saveStoryContextBudgetTokens(storage, 256_000)).toBe(256_000);
    expect(storage.setItem).toHaveBeenCalledWith("infinite-quest.story.context-budget-tokens", "256000");
  });

  it("keeps the maximum Story preset aligned with the context contract", () => {
    expect(STORY_CONTEXT_BUDGET_PRESETS.map(({ value }) => value)).toEqual([
      32_000, 64_000, 128_000, 256_000, 1_000_000
    ]);
    expect(STORY_CONTEXT_BUDGET_PRESETS.at(-1)?.value).toBe(MAX_MEMORY_CONTEXT_BUDGET_TOKENS);
    expect(STORY_CONTEXT_BUDGET_STORAGE_KEY).toBe("infinite-quest.story.context-budget-tokens");
  });
});
