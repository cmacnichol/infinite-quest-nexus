import { describe, expect, it } from "vitest";
import { composeEffectiveStorySystemPrompt } from "../../packages/story-engine/src/effective-story-system-prompt.js";
import { CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION, STORY_OUTPUT_ENCODING_CONTRACT_V3, storyMemoryMandatoryContract } from "../../packages/contracts/src/story-prompt.js";

describe("composeEffectiveStorySystemPrompt", () => {
  it("orders writer, Story Memory contract, then encoding contract", () => {
    const prompt = composeEffectiveStorySystemPrompt({ writerPrompt: "WRITER", storyOnlyPolicy: null,
      storyMemoryPromptProtocol: CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION, encodingContract: STORY_OUTPUT_ENCODING_CONTRACT_V3 });
    expect(prompt.startsWith("WRITER")).toBe(true);
    expect(prompt.indexOf(storyMemoryMandatoryContract(CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION))).toBeGreaterThan(0);
    expect(prompt.endsWith(STORY_OUTPUT_ENCODING_CONTRACT_V3)).toBe(true);
  });
  it("returns the bare writer prompt for a non-enrolled shipped v2 job", () => {
    expect(composeEffectiveStorySystemPrompt({ writerPrompt: "WRITER", storyOnlyPolicy: null, storyMemoryPromptProtocol: null, encodingContract: "" })).toBe("WRITER");
  });
});
