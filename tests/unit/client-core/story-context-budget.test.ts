import { describe, expect, it } from "vitest";
import * as clientCore from "../../../packages/client-core/src/index.js";
import {
  DEFAULT_STORY_CONTEXT_BUDGET_TOKENS,
  STORY_CONTEXT_BUDGET_PRESETS,
  normalizeStoryContextBudgetTokens
} from "../../../packages/client-core/src/index.js";

describe("Story context budget contract", () => {
  it.each([undefined, null, "", "64000", "64000x", 512, 48_000, 1_000_001])(
    "falls back to Standard when %j is not a supported preset",
    (value) => {
      expect(normalizeStoryContextBudgetTokens(value)).toBe(32_000);
    }
  );

  it("exposes the shared presets and no browser-storage API", () => {
    expect(STORY_CONTEXT_BUDGET_PRESETS.map(({ value }) => value)).toEqual([
      32_000, 64_000, 128_000, 256_000, 1_000_000
    ]);
    expect(STORY_CONTEXT_BUDGET_PRESETS.map(({ label }) => label)).toEqual([
      "Standard · 32K", "Expanded · 64K", "Large · 128K", "Very large · 256K", "Maximum available · up to 1M"
    ]);
    expect(clientCore).not.toHaveProperty("STORY_CONTEXT_BUDGET_STORAGE_KEY");
    expect(clientCore).not.toHaveProperty("loadStoryContextBudgetTokens");
    expect(clientCore).not.toHaveProperty("saveStoryContextBudgetTokens");
  });
});
