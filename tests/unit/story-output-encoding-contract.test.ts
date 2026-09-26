import { describe, expect, it } from "vitest";
import {
  appendStoryOutputEncodingContract,
  STORY_OUTPUT_ENCODING_CONTRACT_V3,
  storyOutputEncodingContract
} from "../../packages/contracts/src/story-prompt.js";

describe("story output encoding contract", () => {
  it("applies only to story-native-v3", () => {
    expect(storyOutputEncodingContract("story-native-v3")).toBe(STORY_OUTPUT_ENCODING_CONTRACT_V3);
    expect(storyOutputEncodingContract("story-native-v2")).toBe("");
    expect(storyOutputEncodingContract(null)).toBe("");
  });
  it("leaves v2 prompts byte-identical and appends last for v3", () => {
    expect(appendStoryOutputEncodingContract("Writer.", "")).toBe("Writer.");
    expect(appendStoryOutputEncodingContract("Writer.", STORY_OUTPUT_ENCODING_CONTRACT_V3)).toBe(`Writer.\n\n${STORY_OUTPUT_ENCODING_CONTRACT_V3}`);
  });
  it("states precedence, the paragraph field, typographic quotes, and the no-forced-dialogue rule", () => {
    expect(STORY_OUTPUT_ENCODING_CONTRACT_V3).toContain("takes precedence");
    expect(STORY_OUTPUT_ENCODING_CONTRACT_V3).toContain("narration_paragraphs");
    expect(STORY_OUTPUT_ENCODING_CONTRACT_V3).toContain("“");
    expect(STORY_OUTPUT_ENCODING_CONTRACT_V3).toContain("solitary or nonverbal");
    expect(STORY_OUTPUT_ENCODING_CONTRACT_V3).not.toMatch(/\\"/);
  });
});
