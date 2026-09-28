import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  defaultStoryMemoryPolicy,
  effectiveProviderConfigurationFingerprint,
  HISTORY_COVERAGE_POLICY,
  isHistoryCoverageContextProtocol,
  storyMemoryCapabilitySchema,
  storyMemoryPolicySchema,
  storyMemoryPolicyHash,
  storyMemoryPolicySnapshotSchema,
  resolveStoryMemoryPolicy,
} from "../../packages/contracts/src/story-memory-policy.js";
import {
  CAST_STORY_MEMORY_CONTEXT_POLICY_VERSION,
  CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION,
  HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION,
  STORY_MEMORY_CONTEXT_POLICY_VERSION,
  STORY_MEMORY_PROMPT_PROTOCOL_VERSION,
} from "../../packages/contracts/src/story-prompt.js";
import {
  legacyPromptTemplateKeys,
  readPromptSnapshot,
  type PromptSnapshot,
} from "../../packages/contracts/src/prompt-library.js";

describe("Story memory policy", () => {
  it("admits only the tested capability combinations", () => {
    expect(storyMemoryPolicySchema.parse(defaultStoryMemoryPolicy("r1"))).toMatchObject({
      capability: "r1", recentTurnTarget: 1, recentResidualShare: 0,
      worldResidualShare: 0.15, excerptPolicy: "whole_only", continuityReview: "off"
    });
    expect(storyMemoryPolicySchema.parse(defaultStoryMemoryPolicy("r2"))).toMatchObject({
      capability: "r2", recentTurnTarget: 3, recentResidualShare: 0.30,
      excerptPolicy: "whole_only", continuityReview: "off"
    });
    expect(storyMemoryPolicySchema.parse(defaultStoryMemoryPolicy("r3"))).toMatchObject({
      capability: "r3", recentTurnTarget: 3, recentResidualShare: 0.30,
      excerptPolicy: "verified_spans_v1", continuityReview: "observe"
    });
    expect(storyMemoryPolicySchema.safeParse({ ...defaultStoryMemoryPolicy("r1"), excerptPolicy: "verified_spans_v1" }).success).toBe(false);
    expect(storyMemoryPolicySchema.safeParse({ ...defaultStoryMemoryPolicy("r2"), continuityReview: "observe" }).success).toBe(false);
    expect(storyMemoryPolicySchema.safeParse({ ...defaultStoryMemoryPolicy("r3"), continuityReview: "enforce" }).success).toBe(true);
    expect(storyMemoryCapabilitySchema.safeParse("r4").success).toBe(false);
  });

  it("leaves uninstalled or unenrolled campaigns on named legacy behavior", () => {
    expect(() => resolveStoryMemoryPolicy({ installedCapability: null, campaignEnrollment: "r1" })).toThrow(/unavailable/i);
    expect(resolveStoryMemoryPolicy({ installedCapability: "r3", campaignEnrollment: null })).toEqual({ kind: "legacy" });
    expect(() => resolveStoryMemoryPolicy({ installedCapability: "r1", campaignEnrollment: "r2" })).toThrow(/unavailable/i);
    expect(resolveStoryMemoryPolicy({ installedCapability: "r3", campaignEnrollment: "r2" })).toMatchObject({
      kind: "policy", policy: { capability: "r2" }
    });
  });

  it("freezes every material effective provider setting without using its display name", () => {
    const baseline = {
      providerId: "provider-id", providerType: "openai_compatible", endpointIdentity: "a".repeat(64),
      model: "default-model", contextWindowTokens: 32_768, maxOutputTokens: 4_096,
      temperature: 0.2, requestTimeoutMs: 30_000, configuration: { retryLimit: 2 },
      effectiveContextWindowTokens: 24_000, inputSafetyPolicy: "estimated_20_percent_plus_1024" as const
    };
    const fingerprint = effectiveProviderConfigurationFingerprint(baseline);
    expect(effectiveProviderConfigurationFingerprint({ ...baseline, displayName: "Renamed" })).toBe(fingerprint);
    for (const changed of [
      { providerType: "anthropic" }, { endpointIdentity: "b".repeat(64) }, { model: "override-model" },
      { contextWindowTokens: 16_384 }, { maxOutputTokens: 2_048 }, { temperature: 0.3 },
      { requestTimeoutMs: 60_000 }, { configuration: { retryLimit: 3 } }, { effectiveContextWindowTokens: 16_000 }
    ]) expect(effectiveProviderConfigurationFingerprint({ ...baseline, ...changed })).not.toBe(fingerprint);
  });
});

describe("Story Memory frozen history-coverage readers", () => {
  const providerConfigurationFingerprint = "a".repeat(64);
  const policy = defaultStoryMemoryPolicy("r2");
  const snapshot = (value: Record<string, unknown>) => ({
    policy,
    policyHash: storyMemoryPolicyHash(policy),
    providerConfigurationFingerprint,
    ...value,
  });

  it("recognizes only the frozen v5 history protocol and exposes its fixed policy", () => {
    expect(HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION).toBe("current-continuity-v5");
    expect(HISTORY_COVERAGE_POLICY).toEqual({
      recentWindowTurns: 11,
      ledgerBudgetShare: 0.25,
      protectedFactBudgetShare: 0.15,
      ledgerDirectionCharacters: 480,
      parentTokenMultiplier: 1.5,
      parentCountMultiplier: 4,
      sceneHintCharacters: 1000,
    });
    expect(isHistoryCoverageContextProtocol(HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION)).toBe(true);
    expect(isHistoryCoverageContextProtocol(CAST_STORY_MEMORY_CONTEXT_POLICY_VERSION)).toBe(false);
    expect(isHistoryCoverageContextProtocol(STORY_MEMORY_CONTEXT_POLICY_VERSION)).toBe(false);
    expect(isHistoryCoverageContextProtocol("current-continuity-v6")).toBe(false);
  });

  it("admits v5 only with the captured cast and v17 prompt protocols", () => {
    const v5 = snapshot({
      castContext: true,
      contextProtocol: HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION,
      promptProtocol: CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION,
    });
    expect(storyMemoryPolicySnapshotSchema.parse(v5)).toEqual(v5);
    for (const incompatible of [
      { ...v5, castContext: undefined },
      { ...v5, promptProtocol: STORY_MEMORY_PROMPT_PROTOCOL_VERSION },
      { ...v5, contextProtocol: "current-continuity-v6" },
    ]) expect(storyMemoryPolicySnapshotSchema.safeParse(incompatible).success).toBe(false);
  });

  it("keeps old frozen snapshots free of history-coverage defaults", () => {
    const v3 = snapshot({
      contextProtocol: STORY_MEMORY_CONTEXT_POLICY_VERSION,
      promptProtocol: STORY_MEMORY_PROMPT_PROTOCOL_VERSION,
    });
    const parsed = storyMemoryPolicySnapshotSchema.parse(v3);
    expect(parsed).toEqual(v3);
    expect(parsed).not.toHaveProperty("castContext");
    expect(isHistoryCoverageContextProtocol(parsed.contextProtocol)).toBe(false);
  });
});

describe("Prompt snapshot compatibility", () => {
  it("reads a frozen legacy key set without consulting the mutable catalog", () => {
    const legacy = Object.fromEntries(legacyPromptTemplateKeys.map((key) => {
      const content = key === "turn_intent" ? "Intent" : key;
      return [key, { content, hash: createHash("sha256").update(content).digest("hex"), source: "shipped" }];
    })) as PromptSnapshot;
    const result = readPromptSnapshot(legacy);
    expect(result.kind).toBe("legacy");
    if (result.kind === "legacy") expect(result.template("turn_intent").content).toBe("Intent");
  });

  it("rejects an unrecognized v2 snapshot and a tampered frozen entry", () => {
    expect(() => readPromptSnapshot({ version: 3, templates: {} })).toThrow(/unsupported/i);
    const templates = Object.fromEntries(legacyPromptTemplateKeys.map((key) => [key, {
      content: key, hash: createHash("sha256").update(key).digest("hex"), source: "shipped"
    }])) as Record<string, { content: string; hash: string; source: "shipped" }>;
    templates.story_system = { content: "Story", hash: "b".repeat(64), source: "shipped" };
    expect(() => readPromptSnapshot({
      version: 2,
      templates,
      continuityReview: null
    })).toThrow(/hash/i);
  });
});
