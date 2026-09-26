import { describe, expect, it } from "vitest";
import { composePresetPrompt } from "../../packages/story-engine/src/preset-prompt.js";
import {
  deriveTextExecutionPlan,
  presetPromptInjectedRemotely,
  STORY_PRESET_ROUTE_PROTOCOL_V2,
  textExecutionRouteBasisHash,
  type TextExecutionRouteBasis,
  type TextRouteCandidate
} from "../../packages/contracts/src/text-execution-plan.js";

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

function presetCandidate(modelId: string): TextRouteCandidate {
  return { modelId, providerPolicy: {}, contextWindowTokens: 16_000, maxOutputTokens: 1_000 };
}

function routeBasisFixture(overrides: Partial<Omit<TextExecutionRouteBasis, "routeBasisHash">>): TextExecutionRouteBasis {
  const basis = {
    version: 2 as const,
    selection: { kind: "openrouter_preset" as const, slug: "nexus-nsfw" },
    preset: { slug: "nexus-nsfw", versionId: "preset-v1", configHash: "a".repeat(64) },
    candidates: [presetCandidate("@preset/nexus-nsfw")],
    presetSystemPrompt: "",
    parameters: {},
    endpointReference: "endpoint",
    credentialReference: "credential",
    profileRevision: "profile-revision",
    requestTimeoutMs: 300_000,
    protocolVersion: STORY_PRESET_ROUTE_PROTOCOL_V2,
    ...overrides
  };
  return { ...basis, routeBasisHash: textExecutionRouteBasisHash({ ...basis, routeBasisHash: "0".repeat(64) }) };
}

describe("remote preset prompt injection", () => {
  it("omits the local preset prefix only for v2 single @preset routes", () => {
    const v2 = routeBasisFixture({ protocolVersion: STORY_PRESET_ROUTE_PROTOCOL_V2, candidates: [presetCandidate("@preset/nexus-nsfw")], presetSystemPrompt: "PRESET" });
    expect(presetPromptInjectedRemotely(v2)).toBe(true);
    expect(deriveTextExecutionPlan(v2, "OPERATION").prompt).toBe("OPERATION");
    const v1 = routeBasisFixture({ protocolVersion: "story-openrouter-preset-v1", candidates: [presetCandidate("@preset/nexus-nsfw")], presetSystemPrompt: "PRESET" });
    expect(deriveTextExecutionPlan(v1, "OPERATION").prompt).toBe("PRESET\n\nOPERATION");
    const concrete = routeBasisFixture({ protocolVersion: STORY_PRESET_ROUTE_PROTOCOL_V2, candidates: [presetCandidate("z-ai/glm-5.2")], presetSystemPrompt: "PRESET" });
    expect(deriveTextExecutionPlan(concrete, "OPERATION").prompt).toBe("PRESET\n\nOPERATION");
  });
});
