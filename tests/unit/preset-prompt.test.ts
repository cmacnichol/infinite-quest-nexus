import { describe, expect, it } from "vitest";
import { composePresetPrompt } from "../../packages/story-engine/src/preset-prompt.js";

describe("preset prompt composition", () => {
  it("includes a preset instruction exactly once before the required operation protocol", () => {
    const prompt = composePresetPrompt({ presetPrompt: "Use spare prose.", operationPrompt: "Return the required Story JSON." });

    expect(prompt.match(/Use spare prose\./g)).toHaveLength(1);
    expect(prompt).toContain("Return the required Story JSON.");
    expect(prompt).toBe("Use spare prose.\n\nReturn the required Story JSON.");
  });

  it("leaves the operation protocol authoritative when no preset prompt exists", () => {
    expect(composePresetPrompt({ presetPrompt: "", operationPrompt: "Return JSON." })).toBe("Return JSON.");
  });
});
