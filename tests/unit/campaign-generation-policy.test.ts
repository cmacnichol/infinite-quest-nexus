import { describe, expect, it } from "vitest";
import {
  campaignTurnControlStyleSchema,
  generationPolicySnapshotSchema,
  historicalCampaignTurnControlStyleSchema
} from "../../packages/contracts/src/campaign-generation-policy.js";
import { generationJobStatusSchema } from "../../packages/contracts/src/generation.js";
import { campaignUpdateSchema } from "../../packages/contracts/src/world-library.js";
import { historicalUserSettingsSchema } from "../../packages/contracts/src/users.js";
import {
  campaignPlayModeForControlStyle,
  generationStagePolicy,
  normalizeHistoricalTurnControlStyle
} from "../../packages/domain/src/campaign-generation-policy.js";

describe("campaign generation policy", () => {
  it("accepts only active campaign turn-control styles", () => {
    expect(campaignTurnControlStyleSchema.safeParse("action_only").success).toBe(true);
    expect(campaignTurnControlStyleSchema.safeParse("flexible_action").success).toBe(true);
    expect(campaignTurnControlStyleSchema.safeParse("flexible_scene").success).toBe(true);
    expect(campaignTurnControlStyleSchema.safeParse("flexible_auto").success).toBe(false);
  });

  it("keeps Auto readable only for historical normalization", () => {
    expect(historicalCampaignTurnControlStyleSchema.parse("flexible_auto")).toBe("flexible_auto");
    expect(normalizeHistoricalTurnControlStyle("flexible_auto")).toBe("flexible_action");
  });

  it("normalizes an absent or Auto historical profile preference to Action", () => {
    expect(historicalUserSettingsSchema.parse({ defaultTurnControlStyle: "flexible_auto" }).defaultTurnControlStyle)
      .toBe("flexible_action");
    expect(historicalUserSettingsSchema.parse({}).defaultTurnControlStyle).toBe("flexible_action");
  });

  it("derives the execution mode from each supported campaign setting", () => {
    expect(campaignPlayModeForControlStyle("action_only")).toBe("legacy");
    expect(campaignPlayModeForControlStyle("flexible_action")).toBe("legacy");
    expect(campaignPlayModeForControlStyle("flexible_scene")).toBe("story_only");
  });

  it("requires a well-formed policy whose style agrees with its mode", () => {
    expect(generationPolicySnapshotSchema.safeParse({
      version: 1,
      playMode: "legacy",
      turnControlStyle: "flexible_scene"
    }).success).toBe(false);
    expect(generationPolicySnapshotSchema.safeParse({ version: 2, playMode: "story_only" }).success).toBe(false);
    expect(generationPolicySnapshotSchema.safeParse({
      version: 1,
      playMode: "story_only",
      turnControlStyle: "flexible_scene",
      protocolVersion: "story-only-v1",
      prompts: {
        systemSupplement: "story-only instructions",
        systemSupplementHash: "hash-one",
        choiceRepairSystem: "repair choices",
        choiceRepairSystemHash: "hash-two"
      }
    }).success).toBe(true);
  });

  it("keeps historical jobs without a policy readable without inventing one", () => {
    const job = generationJobStatusSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      campaignId: "22222222-2222-4222-8222-222222222222",
      expectedTurnNumber: 1,
      action: "Continue the story.",
      requestedInputMode: "auto",
      resolvedInputMode: "scene",
      inputModeSource: "auto",
      operationKind: "append",
      status: "recoverable",
      attempts: 1,
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z"
    });

    expect(job.generationPolicy).toBeUndefined();
    expect(job.resolvedInputMode).toBe("scene");
  });

  it("disables mechanics, event evaluation, and scene coverage for Story Direction", () => {
    expect(generationStagePolicy("story_only")).toEqual({
      allowRpgAssessment: false,
      allowEventEvaluation: false,
      allowSceneCoverage: false
    });
  });

  it("accepts an optional transition fence without turning it into a second campaign setting", () => {
    expect(campaignUpdateSchema.parse({
      turnControlStyle: "flexible_scene",
      expectedTurnControlStyle: "flexible_action",
      expectedActiveTurnNumber: 8,
      expectedStateRevision: 13
    })).toMatchObject({ turnControlStyle: "flexible_scene" });
    expect(campaignUpdateSchema.safeParse({ expectedStateRevision: 13 }).success).toBe(false);
  });
});
