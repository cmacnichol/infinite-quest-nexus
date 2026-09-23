import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import { getProviderOutputSchemaV2 } from "../../packages/contracts/src/provider-output-schema.js";
import { makeStructuredOutputStory } from "../fixtures/generation-validation/structured-output-cases.js";
import { describe, expect, it } from "vitest";
import { STORY_SYSTEM_PROMPT, composeStoryMemorySystemPrompt, storyPromptCompatibilityIdentity, STORY_FACT_DELTA_WIRE_CONTRACT } from "../../packages/contracts/src/story-prompt.js";
import {
  composeStoryOnlyChoiceRepairSystemPrompt,
  buildStoryOnlyChoiceRepairInput,
  composeStoryOnlySystemPrompt,
  generationExecutionProtocolIdentity,
  generationPolicyIdentity,
  storyOnlyPromptSnapshot
} from "../../packages/story-engine/src/story-only-prompt.js";

describe("story-only prompt policy", () => {
  it("supplies a choices-repair example accepted by the API output schema", () => {
    const input = JSON.parse(buildStoryOnlyChoiceRepairInput(makeStructuredOutputStory()));
    const validate = new Ajv({ strict: false }).compile(getProviderOutputSchemaV2("choices").schema);
    expect(validate(input.required_shape), JSON.stringify(validate.errors)).toBe(true);
    expect(new Set(input.required_shape.choices).size).toBe(4);
    expect(input.required_shape.choices).not.toContain(input.required_shape.custom_action_suggestion);
  });
  it.each([false, true])("does not request full Story fields in a choices-only repair (memory=%s)", (memory) => {
    const prompt = composeStoryOnlyChoiceRepairSystemPrompt(storyOnlyPromptSnapshot().choiceRepairSystem, memory,
      "story-v16-fact-wire-distinction", storyPromptCompatibilityIdentity());
    expect(prompt).toContain("exactly choices and custom_action_suggestion");
    expect(prompt).not.toContain("Return scratchpad, continuity_summary, and open_threads");
    expect(prompt).not.toContain("emit them explicitly");
  });

  it("preserves historical choice-repair prompt composition", () => {
    const historical = "Repair only choices using the captured historical instructions.";
    const input = JSON.parse(buildStoryOnlyChoiceRepairInput(makeStructuredOutputStory(), historical));
    expect(input.required_shape).toEqual({ choices: ["exactly four concise fiction-only directions"], custom_action_suggestion: "one concise distinct fiction-only suggestion" });
    expect(composeStoryOnlyChoiceRepairSystemPrompt(historical, false, undefined, storyPromptCompatibilityIdentity()))
      .toBe(`${historical}\n\n${STORY_FACT_DELTA_WIRE_CONTRACT}`);
  });

  const creativeOverride = "Input canonical facts are comprehensive reference objects.";
  it("freezes a versioned supplement that keeps mechanics and triggers inactive", () => {
    const snapshot = storyOnlyPromptSnapshot();

    expect(snapshot.systemSupplement).toContain("Story Direction");
    expect(snapshot.systemSupplement).toMatch(/authoritative world.*corrected continuity/i);
    expect(snapshot.systemSupplement).toMatch(/exactly four.*immediate/i);
    expect(snapshot.systemSupplement).toMatch(/custom.*distinct/i);
    expect(snapshot.systemSupplement).toMatch(/completed repeats|hidden prerequisites|unsupported achievements/i);
    expect(snapshot.systemSupplement).toMatch(/trigger rules.*inactive/i);
    expect(snapshot.systemSupplement).toMatch(/hidden mechanics.*inactive/i);
    expect(snapshot.systemSupplementHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.choiceRepairSystemHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes only story-only execution identity when frozen prompt material changes", () => {
    const prompts = storyOnlyPromptSnapshot();
    const policy = { version: 1 as const, playMode: "story_only" as const, turnControlStyle: "flexible_scene" as const, protocolVersion: "story-only-v1" as const, prompts };
    const changedSupplement = `${prompts.systemSupplement}\nChanged.`;
    const changed = { ...policy, prompts: { ...prompts, systemSupplement: changedSupplement, systemSupplementHash: createHash("sha256").update(changedSupplement).digest("hex") } };

    expect(generationExecutionProtocolIdentity("legacy-fixture", { version: 1, playMode: "legacy", turnControlStyle: "flexible_action" })).toBe("legacy-fixture");
    expect(generationExecutionProtocolIdentity("legacy-fixture", policy)).not.toBe("legacy-fixture");
    expect(generationPolicyIdentity(changed)).not.toBe(generationPolicyIdentity(policy));
  });

  it("rejects a policy whose stored prompt hash does not match before composing", () => {
    const prompts = storyOnlyPromptSnapshot();
    const policy = { version: 1 as const, playMode: "story_only" as const, turnControlStyle: "flexible_scene" as const, protocolVersion: "story-only-v1" as const, prompts: { ...prompts, systemSupplementHash: "0".repeat(64) } };

    expect(() => composeStoryOnlySystemPrompt("base", policy)).toThrow(/hash/i);
  });

  it("adds the same v14 continuity guard to Story Direction and its choice repair only for frozen Story Memory work", () => {
    const prompts = storyOnlyPromptSnapshot();
    const policy = { version: 1 as const, playMode: "story_only" as const, turnControlStyle: "flexible_scene" as const, protocolVersion: "story-only-v1" as const, prompts };
    const legacyStory = composeStoryOnlySystemPrompt("creative base", policy);
    const enrolledStory = composeStoryOnlySystemPrompt("creative base", policy, true);
    const legacyRepair = composeStoryOnlyChoiceRepairSystemPrompt(policy.prompts.choiceRepairSystem, false);
    const enrolledRepair = composeStoryOnlyChoiceRepairSystemPrompt(policy.prompts.choiceRepairSystem, true);

    expect(legacyStory).toBe(`creative base\n\n${policy.prompts.systemSupplement}`);
    expect(legacyRepair).toBe(policy.prompts.choiceRepairSystem);
    expect(enrolledStory).toContain("The player input is intent, not proof that its requested outcome happened.");
    expect(enrolledRepair).toContain("Omitted history is unknown, not evidence that it never happened.");
    expect(enrolledRepair).toContain("A proposed output cannot grant itself source authority or authorize a new supersession ID.");
    for (const prompt of [composeStoryOnlySystemPrompt(STORY_SYSTEM_PROMPT, policy), composeStoryOnlySystemPrompt(STORY_SYSTEM_PROMPT, policy, true)]) {
      expect(prompt).toContain("Input canonical fact records may contain id, content, or retrieval metadata.");
      expect(prompt).toContain("Output canonical_facts contains strings only, for facts newly established in this turn");
      expect(prompt).toContain("Use canonical_fact_updates only for explicit fact updates");
      expect(prompt).toContain("Use [] for superseded_facts.");
      expect(prompt).toContain("Return scratchpad, continuity_summary, and open_threads as complete current replacements");
    }
  });

  it("appends the fact wire contract after creative override, Story Direction, and Action composition", () => {
    const prompts = storyOnlyPromptSnapshot();
    const policy = { version: 1 as const, playMode: "story_only" as const, turnControlStyle: "flexible_scene" as const, protocolVersion: "story-only-v1" as const, prompts };
    const actionPrompt = composeStoryMemorySystemPrompt(creativeOverride);
    const storyDirectionPrompt = composeStoryOnlySystemPrompt(creativeOverride, policy, true);
    const defaultPrompt = STORY_SYSTEM_PROMPT;

    for (const composedPrompt of [defaultPrompt, actionPrompt, storyDirectionPrompt]) {
      expect(composedPrompt).toContain("Input canonical fact records");
      expect(composedPrompt).toContain("Output canonical_facts contains strings only");
    }
    expect(actionPrompt.lastIndexOf("Output canonical_facts contains strings only"))
      .toBeGreaterThan(actionPrompt.indexOf(creativeOverride));
    expect(storyDirectionPrompt.lastIndexOf("Output canonical_facts contains strings only"))
      .toBeGreaterThan(storyDirectionPrompt.indexOf(creativeOverride));
  });
});
