import { describe, expect, it } from "vitest";
import {
  portableAcceptedGenerationPolicyProvenance,
  portableAcceptedTurnModelMetadata,
  type GenerationPolicySnapshot,
  type PortableAcceptedGenerationPolicyProvenance
} from "../../packages/contracts/src/campaign-generation-policy.js";

const sourcePromptText = "Narrate the lantern bearer crossing the flooded bridge without exposing game mechanics.";
const sourceRepairPromptText = "Return four grounded continuations for the lantern bearer after the bridge crossing.";

const storyRuntimePolicy = {
  version: 1,
  playMode: "story_only",
  turnControlStyle: "flexible_scene",
  protocolVersion: "story-only-v1",
  prompts: {
    systemSupplement: sourcePromptText,
    systemSupplementHash: "a".repeat(64),
    choiceRepairSystem: sourceRepairPromptText,
    choiceRepairSystemHash: "b".repeat(64)
  }
} satisfies GenerationPolicySnapshot;

const legacyRuntimePolicy = {
  version: 1,
  playMode: "legacy",
  turnControlStyle: "flexible_action"
} satisfies GenerationPolicySnapshot;

const retainedStoryProvenance = {
  version: 1,
  playMode: "story_only",
  turnControlStyle: "flexible_scene",
  protocolVersion: "story-only-v1"
} satisfies PortableAcceptedGenerationPolicyProvenance;

describe("portable accepted-turn model metadata", () => {
  it("redacts runtime prompt snapshots while retaining a strict portable record and leaving sources unchanged", () => {
    const metadata: Record<string, unknown> = {
      provider: "lm-studio",
      responseId: "response-42",
      generationPolicy: storyRuntimePolicy,
      portableAcceptedGenerationPolicyProvenance: retainedStoryProvenance,
      providerDiagnostics: { requestId: "request-42", cacheHit: false }
    };
    const originalMetadata = structuredClone(metadata);
    const originalRuntimePolicy = structuredClone(storyRuntimePolicy);

    const result = portableAcceptedTurnModelMetadata(metadata, storyRuntimePolicy);

    expect(result).toEqual({
      provider: "lm-studio",
      responseId: "response-42",
      portableAcceptedGenerationPolicyProvenance: retainedStoryProvenance,
      providerDiagnostics: { requestId: "request-42", cacheHit: false }
    });
    expect(result).not.toHaveProperty("generationPolicy");
    expect(result.portableAcceptedGenerationPolicyProvenance).not.toHaveProperty("prompts");
    expect(JSON.stringify(result)).not.toContain(sourcePromptText);
    expect(JSON.stringify(result)).not.toContain(sourceRepairPromptText);
    expect(metadata).toEqual(originalMetadata);
    expect(storyRuntimePolicy).toEqual(originalRuntimePolicy);
  });

  it("projects a valid legacy runtime policy with a null protocol version", () => {
    expect(portableAcceptedGenerationPolicyProvenance(legacyRuntimePolicy)).toEqual({
      version: 1,
      playMode: "legacy",
      turnControlStyle: "flexible_action",
      protocolVersion: null
    });
  });

  it("retains valid imported provenance when the runtime policy is absent", () => {
    expect(portableAcceptedTurnModelMetadata({
      provider: "imported-archive",
      portableAcceptedGenerationPolicyProvenance: retainedStoryProvenance
    }, null)).toEqual({
      provider: "imported-archive",
      portableAcceptedGenerationPolicyProvenance: retainedStoryProvenance
    });
  });

  it("keeps a historical absent policy as null", () => {
    expect(portableAcceptedTurnModelMetadata({ provider: "legacy-import" }, null)).toEqual({
      provider: "legacy-import",
      portableAcceptedGenerationPolicyProvenance: null
    });
  });

  it("rejects malformed runtime or retained provenance instead of falling back", () => {
    const malformedRuntimePolicy = {
      version: 1,
      playMode: "story_only",
      turnControlStyle: "flexible_scene",
      protocolVersion: "story-only-v2"
    };
    const malformedRetainedProvenance = {
      version: 1,
      playMode: "legacy",
      turnControlStyle: "flexible_scene",
      protocolVersion: null
    };

    expect(() => portableAcceptedGenerationPolicyProvenance(
      malformedRuntimePolicy,
      retainedStoryProvenance
    )).toThrow();
    expect(() => portableAcceptedGenerationPolicyProvenance(
      null,
      malformedRetainedProvenance
    )).toThrow();
  });

  it("uses a valid runtime snapshot over conflicting retained provenance", () => {
    const conflictingMetadata: Record<string, unknown> = {
      provider: "local-worker",
      portableAcceptedGenerationPolicyProvenance: retainedStoryProvenance
    };

    expect(portableAcceptedTurnModelMetadata(conflictingMetadata, legacyRuntimePolicy))
      .toMatchObject({
        provider: "local-worker",
        portableAcceptedGenerationPolicyProvenance: {
          version: 1,
          playMode: "legacy",
          turnControlStyle: "flexible_action",
          protocolVersion: null
        }
      });
  });
});
