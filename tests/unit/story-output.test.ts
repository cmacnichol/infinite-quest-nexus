import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential } from "../../packages/story-engine/src/credentials.js";
import { parseStoryOutput } from "../../packages/story-engine/src/output.js";
import { buildStoryUserPrompt, STORY_SYSTEM_PROMPT, recoveryInstruction } from "../../packages/story-engine/src/prompt.js";

function story(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    narration: "Location Alpha opens and Marker One becomes visible.",
    choices: ["Enter Location Alpha.", "Call Test Character.", "Inspect Marker One.", "Wait."],
    custom_action_suggestion: "Inspect Object Delta.",
    scratchpad: "Private synthetic continuity marker.",
    tracker_updates: [],
    image_prompt: "Synthetic Location Alpha with Marker One visible.",
    ...overrides
  });
}

describe("story output integrity", () => {
  it("accepts a complete fiction-only story object", () => {
    const result = parseStoryOutput(`\`\`\`json\n${story()}\n\`\`\``);
    expect(result.ok).toBe(true);
  });

  it("refuses truncated JSON rather than accepting a partial turn", () => {
    const result = parseStoryOutput(story().slice(0, -18));
    expect(result).toMatchObject({ ok: false, code: "invalid_json" });
  });

  it("rejects mechanics leakage in every story field", () => {
    for (const contaminated of [
      { narration: "Test Character rolls a 17 and opens Location Gamma." },
      { choices: ["Roll the dice.", "Wait.", "Leave.", "Listen."] },
      { scratchpad: "The next skill check is difficult." },
      { image_prompt: "A hero celebrating a successful d20 roll." }
    ]) {
      expect(parseStoryOutput(story(contaminated))).toMatchObject({ ok: false, code: "mechanics_leak" });
    }
  });

  it("encrypts provider credentials with authenticated encryption", () => {
    const encrypted = encryptCredential("private-provider-key", "test-master-secret");
    expect(encrypted.ciphertext).not.toContain("private-provider-key");
    expect(decryptCredential(encrypted, "test-master-secret")).toBe("private-provider-key");
    expect(() => decryptCredential(encrypted, "wrong-secret")).toThrow();
  });

  it("does not prime the narrative prompt with roll or dice vocabulary", () => {
    expect(STORY_SYSTEM_PROMPT).not.toMatch(/\broll(?:s|ed|ing)?\b|\bdice?\b/i);
    expect(recoveryInstruction("mechanics_leak")).not.toMatch(/\broll(?:s|ed|ing)?\b|\bdice?\b/i);
  });

  it("gives schema repair enough typed detail to correct tracker arrays", () => {
    const repair = recoveryInstruction("invalid_schema", ["tracker_updates.0: expected record, received string"]);
    expect(STORY_SYSTEM_PROMPT).toContain("tracker_updates must be an array of JSON objects");
    expect(repair).toContain("tracker_updates.0: expected record, received string");
    expect(repair).toContain('[{"name":"fictional tracker name","value":"new fictional value"}]');
  });

  it("keeps typed fictional guidance separate from authoritative context", () => {
    const prompt = buildStoryUserPrompt(
      { campaign: { location: "Location Gamma" } },
      "Open Location Gamma.",
      false,
      ["The catch yields, but the hinges announce the character's arrival."]
    );
    expect(prompt).toContain("fiction_only_outcome_guidance");
    expect(prompt).toContain("hinges announce");
    expect(prompt).not.toMatch(/\broll(?:s|ed|ing)?\b|\bdice?\b/i);
  });
});
