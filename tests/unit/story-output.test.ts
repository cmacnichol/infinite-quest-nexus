import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential } from "../../packages/story-engine/src/credentials.js";
import { extractPartialNarration, parseStoryOutput } from "../../packages/story-engine/src/output.js";
import { buildStoryUserPrompt, STORY_PROMPT_PROTOCOL_VERSION, STORY_SYSTEM_PROMPT, recoveryInstruction } from "../../packages/story-engine/src/prompt.js";

function story(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    narration: "Location Alpha opens and Marker One becomes visible.",
    choices: ["Enter Location Alpha.", "Call Test Character.", "Inspect Marker One.", "Wait."],
    custom_action_suggestion: "Inspect Object Delta.",
    scratchpad: "Private synthetic continuity marker.",
    tracker_updates: [],
    image_prompt: "Synthetic Location Alpha with Marker One visible.",
    continuity_summary: "Object Delta is visible at Location Alpha.",
    canonical_facts: ["Marker One is visible."],
    superseded_facts: [],
    canonical_fact_updates: [],
    open_threads: ["Determine what Marker One indicates."],
    ...overrides
  });
}

describe("story output integrity", () => {
  it("accepts a complete fiction-only story object", () => {
    const result = parseStoryOutput(`\`\`\`json\n${story()}\n\`\`\``);
    expect(result.ok).toBe(true);
  });

  it("requires an explicit replacement scratchpad instead of silently clearing continuity", () => {
    const parsed = JSON.parse(story());
    delete parsed.scratchpad;
    const result = parseStoryOutput(JSON.stringify(parsed));
    expect(result).toMatchObject({ ok: false, code: "invalid_schema" });
  });

  it("recovers omitted Chronicle metadata without discarding a valid story turn", () => {
    const incomplete = JSON.parse(story());
    delete incomplete.continuity_summary;
    delete incomplete.canonical_facts;
    delete incomplete.superseded_facts;
    delete incomplete.open_threads;
    const result = parseStoryOutput(JSON.stringify(incomplete), {
      continuitySummary: "Earlier campaign continuity remains authoritative.",
      openThreads: ["Resolve the existing mystery."]
    });
    expect(result).toMatchObject({
      ok: true,
      story: {
        continuity_summary: "Earlier campaign continuity remains authoritative.",
        canonical_facts: [],
        superseded_facts: [],
        open_threads: ["Resolve the existing mystery."]
      }
    });
  });

  it("still rejects malformed Chronicle metadata when the model supplies it", () => {
    expect(parseStoryOutput(story({ canonical_facts: "not an array" }))).toMatchObject({ ok: false, code: "invalid_schema" });
  });

  it("accepts structured canonical fact updates and defaults the optional field", () => {
    const factId = "11111111-1111-4111-8111-111111111111";
    const structured = parseStoryOutput(story({
      canonical_fact_updates: [{ content: "Marker One is now dark.", supersedes_fact_ids: [factId] }]
    }));
    expect(structured).toMatchObject({
      ok: true,
      story: { canonical_fact_updates: [{ content: "Marker One is now dark.", supersedes_fact_ids: [factId] }] }
    });

    const legacy = JSON.parse(story());
    delete legacy.canonical_fact_updates;
    expect(parseStoryOutput(JSON.stringify(legacy))).toMatchObject({
      ok: true,
      story: { canonical_fact_updates: [] }
    });
  });

  it("validates structured canonical fact updates and their fiction boundary", () => {
    expect(parseStoryOutput(story({
      canonical_fact_updates: [{ content: "Marker One is dark.", supersedes_fact_ids: ["invented-id"] }]
    }))).toMatchObject({ ok: false, code: "invalid_schema" });
    expect(parseStoryOutput(story({
      canonical_fact_updates: [{ content: "A successful d20 check opens Marker One.", supersedes_fact_ids: [] }]
    }))).toMatchObject({ ok: false, code: "mechanics_leak" });
  });

  it("refuses truncated JSON rather than accepting a partial turn", () => {
    const result = parseStoryOutput(story().slice(0, -18));
    expect(result).toMatchObject({ ok: false, code: "invalid_json" });
  });

  it("handles strings with no JSON objects", () => {
    const result = parseStoryOutput("Just some plain text without any JSON object.");
    expect(result).toMatchObject({ ok: false, code: "invalid_json" });
    if (!result.ok && result.code === "invalid_json") {
      expect(result.errors[0]).toContain("The response did not contain a JSON object.");
    }
  });

  it("reports invalid JSON errors when extracted JSON has syntax errors", () => {
    const result = parseStoryOutput('{ "narration": }');
    expect(result).toMatchObject({ ok: false, code: "invalid_json" });
    if (!result.ok && result.code === "invalid_json") {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(typeof result.errors[0]).toBe("string");
    }
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

  it("accepts ordinary roll and difficulty language in fiction and image prompts", () => {
    const result = parseStoryOutput(story({
      narration: "A large roll-up door closes as wheels approach on a rolling track. She crosses the uneven floor with difficulty.",
      image_prompt: "An industrial loading bay with a closed roll-up door and a rolling cart."
    }));
    expect(result).toMatchObject({ ok: true });
  });

  it("formats long accepted narration before it reaches the turn ledger", () => {
    const narration = [
      "Location Alpha darkens as Test Character approaches the sealed northern entrance beneath the old observatory.",
      "A narrow band of violet light passes over Marker One and disappears into the brass frame around the door.",
      "You follow at a careful distance while rain moves across the glass roof in long silver curtains.",
      "Something crosses the archive beyond the entrance and stops where the interior latch should be.",
      "Test Character lowers the lantern and listens until a second, lighter footstep answers the first.",
      "The speaking tube beside you clicks open, but no voice emerges from its dark metal mouth.",
      "Three possible routes remain visible while the observatory machinery gathers speed beneath the floor."
    ].join(" ");
    const result = parseStoryOutput(story({ narration }));
    expect(result.ok && result.story.narration).toContain("\n\n");
    expect(result.ok && result.story.narration.replace(/\s/gu, ""))
      .toBe(narration.replace(/\s/gu, ""));
  });

  it("detects singular die resolution and returns actionable validation detail", () => {
    expect(parseStoryOutput(story({ narration: "The die shows seventeen, so the door opens." }))).toMatchObject({
      ok: false,
      code: "mechanics_leak",
      errors: [expect.stringContaining('"The die shows"')]
    });
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

  it("includes fiction-boundary findings in mechanics cleanup instructions", () => {
    const instruction = recoveryInstruction("mechanics_leak", ['Mechanics language detected in narration: "rolls a 17".']);
    expect(instruction).toContain('"rolls a 17"');
    expect(instruction).toContain("Rewrite the rejected response");
  });

  it("gives schema repair enough typed detail to correct tracker arrays", () => {
    const repair = recoveryInstruction("invalid_schema", ["tracker_updates.0: expected record, received string"]);
    expect(STORY_SYSTEM_PROMPT).toContain("tracker_updates must be an array of JSON objects");
    expect(STORY_SYSTEM_PROMPT).toContain("continuity_summary");
    expect(STORY_SYSTEM_PROMPT).toContain("canonical_facts");
    expect(STORY_SYSTEM_PROMPT).toContain("superseded_facts");
    expect(STORY_SYSTEM_PROMPT).toContain("canonical_fact_updates");
    expect(STORY_SYSTEM_PROMPT).toContain("copy only exact IDs shown on visible canonical facts");
    expect(STORY_SYSTEM_PROMPT).toContain("Never invent, infer, alter, or reuse an ID");
    expect(STORY_SYSTEM_PROMPT).toContain("open_threads");
    expect(repair).toContain("tracker_updates.0: expected record, received string");
    expect(repair).toContain('[{"name":"fictional tracker name","value":"new fictional value"}]');
  });

  it("handles invalid json by asking for schema-complete json", () => {
    const repair = recoveryInstruction("invalid_json");
    expect(repair).toContain("The preceding response was not a valid complete Infinite Quest story object. Recover the intended events and return one syntactically valid, schema-complete JSON object.");
    expect(repair).toContain('tracker_updates must be an array of JSON objects such as [{"name":"fictional tracker name","value":"new fictional value"}], or [] when unchanged');

    const repairWithErrors = recoveryInstruction("invalid_json", ["Unexpected end of JSON input"]);
    expect(repairWithErrors).toContain("Correct these validation errors: Unexpected end of JSON input.");
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

  it("frames world rules as mandatory turn constraints", () => {
    const prompt = buildStoryUserPrompt(
      { authoritativeRules: "Doors open only when their true names are spoken.", worldCanon: {} },
      "Force the door open."
    );
    expect(STORY_SYSTEM_PROMPT).toContain("authoritativeRules scope contains mandatory world-specific constraints");
    expect(prompt).toContain("Obey every applicable constraint in authoritative_context.authoritativeRules");
    expect(prompt).toContain("Doors open only when their true names are spoken.");
  });

  it("places the campaign story-length profile in normal and recovery prompts", () => {
    const extended = { profile: "extended" as const, minWords: 1200, maxWords: 2000 };
    const prompt = buildStoryUserPrompt({ campaign: { location: "Location Gamma" } }, "Continue.", false, [], extended);
    const payload = JSON.parse(prompt);
    expect(payload.narration_length).toEqual({ profile: "extended", target_min_words: 1200, target_max_words: 2000 });
    expect(payload.task).toContain("1200-2000 narration words");
    expect(recoveryInstruction("output_limit", [], extended)).toContain("450-650 narration words");
  });

  it("privately requests readable narration paragraphs with a versioned protocol", () => {
    expect(STORY_PROMPT_PROTOCOL_VERSION).toBe("story-v9-structured-facts");
    expect(STORY_SYSTEM_PROMPT).toContain("paragraphs separated by two newline characters");
    expect(STORY_SYSTEM_PROMPT).toContain("change of speaker, scene transition, or meaningful shift in focus");
  });

  it("extracts partial narration safely from incomplete streaming JSON", () => {
    const partial = `{"narration": "The heavy stone door creaked open.\\n\\nA shadow moved ahead`;
    const extracted = extractPartialNarration(partial);
    expect(extracted).toBe("The heavy stone door creaked open.\n\nA shadow moved ahead");
  });

  it("extracts finished narration from JSON that is still streaming choices", () => {
    const partial = `{"narration": "The heavy stone door creaked open.", "choices": ["Enter the tunnel."`;
    const extracted = extractPartialNarration(partial);
    expect(extracted).toBe("The heavy stone door creaked open.");
  });

  it("suppresses partial narration if mechanics terms appear during streaming", () => {
    const partialWithMechanics = `{"narration": "You attempt to open the chest. d100 check required`;
    expect(extractPartialNarration(partialWithMechanics)).toBe("");
  });

  it("safely handles incomplete escape sequences at chunk boundaries", () => {
    const chunkAtEscape = `{"narration": "The door\\`;
    expect(extractPartialNarration(chunkAtEscape)).toBe("The door");
  });
});
