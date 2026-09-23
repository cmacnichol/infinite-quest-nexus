import { describe, expect, it } from "vitest";
import { defaultStoryMemoryPolicy, storyMemoryPolicyHash, storyMemoryPolicySnapshotSchema } from "../../packages/contracts/src/story-memory-policy.js";
import { CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION, CAST_STORY_MEMORY_CONTEXT_POLICY_VERSION, castStoryMemoryPromptCompatibilityIdentity,
  composeStoryMemorySystemPrompt, STORY_MEMORY_MANDATORY_CONTRACT, STORY_MEMORY_PROMPT_PROTOCOL_VERSION } from "../../packages/contracts/src/story-prompt.js";
import { readPromptSnapshot, legacyPromptTemplateKeys } from "../../packages/contracts/src/prompt-library.js";
import { sha256Hex } from "../../packages/contracts/src/hash.js";

describe("frozen cast generation protocol", () => {
  const policy = defaultStoryMemoryPolicy("r1");
  const oldSnapshot = { policy, policyHash: storyMemoryPolicyHash(policy), contextProtocol: "current-continuity-v3",
    promptProtocol: STORY_MEMORY_PROMPT_PROTOCOL_VERSION, providerConfigurationFingerprint: "a".repeat(64) };
  it("requires explicit cast capability and the matching context/prompt pair", () => {
    const castSnapshot = { ...oldSnapshot, castContext: true, contextProtocol: "current-continuity-v4", promptProtocol: "story-v17-campaign-cast" };
    expect(storyMemoryPolicySnapshotSchema.parse(castSnapshot)).toEqual(castSnapshot);
    expect(storyMemoryPolicySnapshotSchema.parse(oldSnapshot)).toEqual(oldSnapshot);
    for (const invalid of [{ ...oldSnapshot, castContext: true }, { ...castSnapshot, castContext: undefined },
      { ...castSnapshot, promptProtocol: oldSnapshot.promptProtocol }, { ...castSnapshot, contextProtocol: oldSnapshot.contextProtocol }]) {
      expect(storyMemoryPolicySnapshotSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it("adds cast authority semantics only to the explicit new protocol", () => {
    expect(CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION).toBe("story-v17-campaign-cast");
    expect(CAST_STORY_MEMORY_CONTEXT_POLICY_VERSION).toBe("current-continuity-v4");
    expect(composeStoryMemorySystemPrompt("Creative", "", STORY_MEMORY_PROMPT_PROTOCOL_VERSION)).toBe(`Creative\n\n${STORY_MEMORY_MANDATORY_CONTRACT}`);
    const cast = composeStoryMemorySystemPrompt("Creative", "", CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION);
    expect(cast).toContain("cast"); expect(cast).toContain("effective turn"); expect(cast).toContain("historical");
  });
  it("reads cast prompt proofs without rewriting frozen creative template bytes", () => {
    const templates = Object.fromEntries(legacyPromptTemplateKeys.map((key) => [key, { content: key, hash: sha256Hex(key), source: "shipped" }]));
    const snapshot = readPromptSnapshot({ version: 2, templates, continuityReview: null, storyMemoryCompatibility: {
      protocolIdentity: castStoryMemoryPromptCompatibilityIdentity(), templateHashes: {
        story_system: templates.story_system!.hash, event_extension: templates.event_extension!.hash }
    } });
    expect(snapshot.template("story_system").content).toBe("story_system");
    expect(snapshot.storyMemoryCompatibility!.protocolIdentity).toBe("story-v17-campaign-cast|story-output-v2|current-continuity-v4");
  });
});
