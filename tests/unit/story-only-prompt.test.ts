import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  composeStoryOnlySystemPrompt,
  generationExecutionProtocolIdentity,
  generationPolicyIdentity,
  storyOnlyPromptSnapshot
} from "../../packages/story-engine/src/story-only-prompt.js";

describe("story-only prompt policy", () => {
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
});
