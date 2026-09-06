import { describe, expect, it } from "vitest";
import {
  apiErrorEnvelopeSchema,
  campaignBranchResponseSchema,
  campaignBranchSchema,
  campaignCreateResponseSchema,
  campaignCreateSchema,
  campaignListResponseSchema,
  campaignRewindResponseSchema,
  campaignRewindSchema,
  campaignRuntimeStateResponseSchema,
  campaignRuntimeStateUpdateRequestSchema,
  campaignSyncStatusSchema,
  generationActionResponseSchema,
  generationEnqueueResponseSchema,
  generationRecoverySchema,
  generationJobSnapshotSchema,
  generationResultSchema,
  generationStreamSnapshotSchema,
  metaResponseSchema,
  playableCharacterListResponseSchema,
  providerListResponseSchema,
  sessionResponseSchema,
  turnInputClassificationRequestSchema,
  turnInputClassificationResponseSchema,
  turnListResponseSchema,
  turnPageRequestSchema,
  syncStatusRequestSchema,
  userProfileResponseSchema,
  userProfileUpdateSchema,
  worldCreateResponseSchema,
  worldCreateSchema,
  worldListResponseSchema,
  type GenerationActionResponse
} from "../../packages/contracts/src/index.js";
import { DEDICATED_CHUNKED_AUDIT } from "../fixtures/chronicle-retrieval-audits.js";

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const WORLD_ID = "22222222-2222-4222-8222-222222222222";
const WORLD_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const TURN_ID = "55555555-5555-4555-8555-555555555555";
const TIMESTAMP = "2026-08-01T12:00:00.000Z";

// @ts-expect-error completed jobs are results, never generation action responses
const invalidCompletedActionStatus: GenerationActionResponse["status"] = "completed";
void invalidCompletedActionStatus;

describe("client API response contracts", () => {
  it.each([
    ["meta response", metaResponseSchema],
    ["session response", sessionResponseSchema],
    ["profile response", userProfileResponseSchema],
    ["provider list response", providerListResponseSchema],
    ["runtime state response", campaignRuntimeStateResponseSchema],
    ["classification response", turnInputClassificationResponseSchema],
    ["rewind response", campaignRewindResponseSchema],
    ["branch response", campaignBranchResponseSchema],
    ["world creation response", worldCreateResponseSchema],
    ["campaign creation response", campaignCreateResponseSchema],
    ["playable-character response", playableCharacterListResponseSchema]
  ])("rejects a malformed %s", (_name, schema) => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it.each([
    ["profile update", userProfileUpdateSchema],
    ["runtime state update", campaignRuntimeStateUpdateRequestSchema],
    ["turn classification", turnInputClassificationRequestSchema],
    ["rewind", campaignRewindSchema],
    ["branch", campaignBranchSchema],
    ["world creation", worldCreateSchema],
    ["campaign creation", campaignCreateSchema]
  ])("rejects a malformed %s request", (_name, schema) => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("rejects an unapproved Story context budget in a campaign creation response", () => {
    const response = {
      id: CAMPAIGN_ID,
      title: "The Observatory",
      status: "active" as const,
      activeTurnNumber: 0,
      storyLengthProfile: "standard",
      storyContextBudgetTokens: 48_000,
      worldId: WORLD_ID,
      worldVersionId: WORLD_VERSION_ID,
      worldVersionNumber: 1,
      selectedCharacterId: "observer",
      selectedCharacterName: "The Observer",
      textProviderProfileId: null,
      imageProviderProfileId: null
    };

    expect(campaignCreateResponseSchema.safeParse(response).success).toBe(false);
  });

  it("keeps the transport error name separate from the domain detail code", () => {
    const parsed = apiErrorEnvelopeSchema.parse({
      error: "GenerationConflictError",
      message: "A generation is already active.",
      correlationId: "request-123",
      details: {
        code: "active_generation_exists",
        pendingGeneration: { id: JOB_ID }
      }
    });

    expect(parsed.error).toBe("GenerationConflictError");
    expect(parsed.details).toMatchObject({ code: "active_generation_exists" });
  });

  it("validates bounded read requests and makes sync windows internally consistent", () => {
    expect(turnPageRequestSchema.parse({ before: "cursor", limit: 50 })).toEqual({ before: "cursor", limit: 50 });
    expect(turnPageRequestSchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(syncStatusRequestSchema.parse({ since: "sync-token" })).toEqual({ since: "sync-token" });
    expect(syncStatusRequestSchema.safeParse({ since: "" }).success).toBe(false);

    const sync = campaignSyncStatusSchema.parse({
      id: CAMPAIGN_ID,
      title: "Campaign",
      activeTurnNumber: 0,
      worldVersionId: WORLD_VERSION_ID,
      storyLengthProfile: "standard",
      storyContextBudgetTokens: 64_000,
      turnControlStyle: "flexible_auto",
      updatedAt: TIMESTAMP,
      selectedCharacterId: null,
      selectedCharacterName: "",
      characterSnapshot: null,
      characterProfile: null,
      characterProfileRevision: 0,
      status: "active",
      campaign: {
        id: CAMPAIGN_ID,
        title: "Campaign",
        activeTurnNumber: 0,
        worldVersionId: WORLD_VERSION_ID,
        storyLengthProfile: "standard",
        storyContextBudgetTokens: 64_000,
        turnControlStyle: "flexible_auto",
        updatedAt: TIMESTAMP,
        selectedCharacterId: null,
        selectedCharacterName: "",
        characterSnapshot: null,
        characterProfile: null,
        characterProfileRevision: 0,
        status: "active"
      },
      world: { id: WORLD_ID, title: "World", versionNumber: 1, genre: "", tone: "", premise: "", backgroundStory: "", character: "", firstAction: "", rules: "", playableCharacters: [] },
      playerConfig: { selectedCharacterId: null, selectedCharacterName: "", characterSnapshot: null, characterProfile: null, characterProfileRevision: 0, rpgStats: [], trackers: [], eventTriggers: [], useRpgStats: false, suppressEventTriggers: false },
      pendingGeneration: null,
      syncToken: "sync-token",
      turnWindowMode: "unchanged",
      turns: null,
      generationRecovery: null
    });
    expect(sync.turnWindowMode).toBe("unchanged");
    expect(sync.storyContextBudgetTokens).toBe(64_000);
    expect(sync.campaign.storyContextBudgetTokens).toBe(64_000);
    const page = { campaignId: CAMPAIGN_ID, turns: [], nextCursor: null };
    expect(turnListResponseSchema.parse(page)).toEqual(page);
    expect(turnListResponseSchema.safeParse({ turns: [], nextCursor: null }).success).toBe(false);
    expect(campaignSyncStatusSchema.parse({ ...sync, turnWindowMode: "replace", turns: page }).turns).toEqual(page);
    expect(campaignSyncStatusSchema.safeParse({ ...sync, turnWindowMode: "unchanged", turns: page }).success).toBe(false);
    expect(campaignSyncStatusSchema.safeParse({ ...sync, turnWindowMode: "replace", turns: null }).success).toBe(false);

    const activeGeneration = {
      id: JOB_ID,
      status: "generating" as const,
      action: "Open the gate",
      expectedTurnNumber: 2,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP
    };
    expect(campaignSyncStatusSchema.parse({
      ...sync,
      pendingGeneration: { ...activeGeneration, operationKind: "append", replacementTurnId: null }
    }).pendingGeneration).toMatchObject({ operationKind: "append", replacementTurnId: null });
    expect(campaignSyncStatusSchema.parse({
      ...sync,
      pendingGeneration: { ...activeGeneration, operationKind: "replace_latest", replacementTurnId: TURN_ID }
    }).pendingGeneration).toMatchObject({ operationKind: "replace_latest", replacementTurnId: TURN_ID });
    expect(campaignSyncStatusSchema.safeParse({
      ...sync,
      pendingGeneration: { ...activeGeneration, operationKind: "append", replacementTurnId: TURN_ID }
    }).success).toBe(false);
    expect(campaignSyncStatusSchema.safeParse({
      ...sync,
      pendingGeneration: { ...activeGeneration, operationKind: "replace_latest", replacementTurnId: null }
    }).success).toBe(false);
    expect(campaignSyncStatusSchema.safeParse({
      ...sync,
      pendingGeneration: { ...activeGeneration, status: "completed", operationKind: "append", replacementTurnId: null }
    }).success).toBe(false);
  });

  it("requires recovery replacement targets to match the operation kind", () => {
    const common = {
      id: JOB_ID,
      status: "completed" as const,
      expectedTurnNumber: 2,
      attempts: 1,
      errorCode: null,
      errorMessage: null,
      resultTurnId: TURN_ID
    };

    expect(generationRecoverySchema.parse({ ...common, operationKind: "append", replacementTurnId: null })).toMatchObject({
      operationKind: "append",
      replacementTurnId: null
    });
    expect(generationRecoverySchema.parse({ ...common, operationKind: "replace_latest", replacementTurnId: TURN_ID })).toMatchObject({
      operationKind: "replace_latest",
      replacementTurnId: TURN_ID
    });
    expect(generationRecoverySchema.safeParse({ ...common, operationKind: "append", replacementTurnId: TURN_ID }).success).toBe(false);
    expect(generationRecoverySchema.safeParse({ ...common, operationKind: "replace_latest", replacementTurnId: null }).success).toBe(false);
    expect(generationRecoverySchema.safeParse({ ...common, operationKind: "replace_latest", replacementTurnId: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects campaign list field drift", () => {
    const validCampaign = {
      id: CAMPAIGN_ID,
      title: "The Observatory",
      status: "active",
      activeTurnNumber: 2,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      storyLengthProfile: "standard",
      storyContextBudgetTokens: 128_000,
      turnControlStyle: "flexible_auto",
      selectedCharacterId: "observer",
      selectedCharacterName: "The Observer",
      worldId: WORLD_ID,
      worldTitle: "Emerald Skies",
      worldVersionId: WORLD_VERSION_ID,
      textProviderProfileId: null,
      imageProviderProfileId: null,
      worldVersionNumber: 1,
      latestWorldVersionNumber: 1,
      worldUpdateAvailable: false,
      costInformation: []
    };

    const parsedCampaign = campaignListResponseSchema.parse({ campaigns: [validCampaign] }).campaigns[0];
    expect(parsedCampaign?.storyContextBudgetTokens).toBe(128_000);
    const { activeTurnNumber: _removed, ...renamedCampaign } = validCampaign;
    expect(() => campaignListResponseSchema.parse({
      campaigns: [{ ...renamedCampaign, activeTurn: 2 }]
    })).toThrow();
  });

  it("rejects world list field drift", () => {
    const validWorld = {
      id: WORLD_ID,
      title: "Emerald Skies",
      status: "active",
      imageUrl: "",
      forkedFromWorldId: null,
      forkedFromWorldVersionId: null,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      draftRevision: 1,
      draftUpdatedAt: TIMESTAMP,
      draftPreview: {
        title: "Emerald Skies",
        genre: "Fantasy",
        tone: "Mysterious",
        premise: "An observatory wakes.",
        backgroundStory: "The stars went dark.",
        firstAction: "Open the dome."
      },
      latestVersionId: WORLD_VERSION_ID,
      latestVersionNumber: 1,
      latestPublishedAt: TIMESTAMP,
      latestPreview: {
        title: "Emerald Skies",
        genre: "Fantasy",
        tone: "Mysterious",
        premise: "An observatory wakes.",
        backgroundStory: "The stars went dark.",
        firstAction: "Open the dome.",
        rules: "Keep the stars strange."
      },
      campaignCount: 1
    };

    expect(worldListResponseSchema.parse({ worlds: [validWorld] }).worlds).toHaveLength(1);
    const { latestVersionNumber: _removed, ...renamedWorld } = validWorld;
    expect(() => worldListResponseSchema.parse({
      worlds: [{ ...renamedWorld, latestVersion: 1 }]
    })).toThrow();
  });

  it("validates the campaign sync projection and pending replacement status", () => {
    const campaign = {
      id: CAMPAIGN_ID,
      title: "The Observatory",
      activeTurnNumber: 2,
      worldVersionId: WORLD_VERSION_ID,
      storyLengthProfile: "standard",
      storyContextBudgetTokens: 32_000,
      turnControlStyle: "flexible_auto",
      updatedAt: TIMESTAMP,
      selectedCharacterId: "observer",
      selectedCharacterName: "The Observer",
      characterSnapshot: { name: "The Observer" },
      characterProfile: null,
      characterProfileRevision: 0,
      status: "active"
    };
    const parsed = campaignSyncStatusSchema.parse({
      ...campaign,
      campaign,
      world: {
        id: WORLD_ID,
        title: "Emerald Skies",
        versionNumber: 1,
        genre: "Fantasy",
        tone: "Mysterious",
        premise: "An observatory wakes.",
        backgroundStory: "The stars went dark.",
        character: "The Observer",
        firstAction: "Open the dome.",
        rules: "Keep the stars strange.",
        playableCharacters: []
      },
      playerConfig: {
        selectedCharacterId: "observer",
        selectedCharacterName: "The Observer",
        characterSnapshot: { name: "The Observer" },
        characterProfile: null,
        characterProfileRevision: 0,
        rpgStats: [],
        trackers: [],
        eventTriggers: [],
        useRpgStats: false,
        suppressEventTriggers: false
      },
      pendingGeneration: {
        id: JOB_ID,
        status: "replacement_queued",
        action: "Take another path.",
        operationKind: "replace_latest",
        replacementTurnId: TURN_ID,
        expectedTurnNumber: 2,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP
      },
      syncToken: "sync-token",
      turnWindowMode: "replace",
      turns: { campaignId: CAMPAIGN_ID, turns: [], nextCursor: null },
      generationRecovery: null
    });

    expect(parsed.pendingGeneration?.status).toBe("replacement_queued");
    expect(() => campaignSyncStatusSchema.parse({ ...parsed, campaign: { ...campaign, activeTurnNumber: undefined } })).toThrow();
  });

  it("validates accepted turns and completed generation results", () => {
    const turn = {
      id: TURN_ID,
      turnNumber: 2,
      action: "Open the dome.",
      inputMode: "action",
      inputModeSource: "explicit",
      narration: "Emerald light spills across the floor.",
      choices: ["Look up.", "Step back.", "Call out.", "Close the dome."],
      customActionSuggestion: "Study the constellations.",
      imagePrompt: "An ancient observatory under emerald stars.",
      imageUrl: null,
      acceptedAt: TIMESTAMP,
      chronicleRetrieval: null,
      reportedCost: null
    };
    expect(turnListResponseSchema.parse({ campaignId: CAMPAIGN_ID, turns: [turn], nextCursor: null }).turns).toHaveLength(1);
    expect(() => turnListResponseSchema.parse({ campaignId: CAMPAIGN_ID, turns: [turn] })).toThrow();
    const { chronicleRetrieval: _missingTurnAudit, ...turnWithoutAuditField } = turn;
    expect(() => turnListResponseSchema.parse({ campaignId: CAMPAIGN_ID, turns: [turnWithoutAuditField], nextCursor: null })).toThrow();
    expect(turnListResponseSchema.parse({ campaignId: CAMPAIGN_ID, turns: [{ ...turnWithoutAuditField, chronicleRetrieval: null }], nextCursor: null }).turns[0]?.chronicleRetrieval).toBeNull();

    const result = generationResultSchema.parse({
      id: JOB_ID,
      status: "completed",
      campaignId: CAMPAIGN_ID,
      expectedTurnNumber: 2,
      resultTurnId: TURN_ID,
      errorCode: null,
      errorMessage: null,
      turnNumber: 2,
      action: turn.action,
      inputMode: turn.inputMode,
      inputModeSource: turn.inputModeSource,
      narration: turn.narration,
      choices: turn.choices,
      customActionSuggestion: turn.customActionSuggestion,
      imagePrompt: turn.imagePrompt,
      chronicleRetrieval: DEDICATED_CHUNKED_AUDIT,
      modelMetadata: {},
      mechanics: {},
      acceptedAt: TIMESTAMP,
      stateSnapshot: {},
      reportedCost: null
    });
    expect(result.resultTurnId).toBe(TURN_ID);
    expect(result.chronicleRetrieval).toEqual(DEDICATED_CHUNKED_AUDIT);
    const { chronicleRetrieval: _missingResultAudit, ...resultWithoutAuditField } = result;
    expect(() => generationResultSchema.parse(resultWithoutAuditField)).toThrow();
    expect(generationResultSchema.parse({ ...resultWithoutAuditField, chronicleRetrieval: null }).chronicleRetrieval).toBeNull();
    expect(() => generationResultSchema.parse({ ...result, status: "recoverable" })).toThrow();
  });

  it("accepts every enqueue and action status used by the play loop", () => {
    expect(generationEnqueueResponseSchema.parse({
      id: JOB_ID,
      status: "queued",
      operationKind: "append",
      replacementTurnId: null,
      expectedTurnNumber: 3,
      createdAt: TIMESTAMP,
      duplicate: false
    }).status).toBe("queued");
    expect(generationEnqueueResponseSchema.parse({
      id: JOB_ID,
      status: "replacement_queued",
      operationKind: "replace_latest",
      replacementTurnId: TURN_ID,
      expectedTurnNumber: 2,
      createdAt: TIMESTAMP,
      duplicate: false
    }).status).toBe("replacement_queued");
    expect(generationActionResponseSchema.parse({ id: JOB_ID, status: "cancelled", operationKind: "append", replacementTurnId: null }))
      .toMatchObject({ operationKind: "append", replacementTurnId: null });
    expect(generationActionResponseSchema.parse({ id: JOB_ID, status: "discarded", operationKind: "replace_latest", replacementTurnId: TURN_ID }))
      .toMatchObject({ operationKind: "replace_latest", replacementTurnId: TURN_ID });
    expect(generationActionResponseSchema.safeParse({ id: JOB_ID, status: "cancelled", operationKind: "append", replacementTurnId: TURN_ID }).success).toBe(false);
    expect(() => generationActionResponseSchema.parse({ id: JOB_ID, status: "completed" })).toThrow();
  });

  it("projects SSE snapshots through an explicit lease-stable allowlist", () => {
    const snapshot = {
      id: JOB_ID,
      campaignId: CAMPAIGN_ID,
      expectedTurnNumber: 3,
      action: "Open the dome.",
      requestedInputMode: "action",
      resolvedInputMode: "action",
      inputModeSource: "explicit",
      operationKind: "append",
      replacementTurnId: null,
      status: "cancelled",
      attempts: 1,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      partialOutput: "raw provider response",
      partialNarration: "Sanitized narration",
      errorCode: null,
      errorMessage: null
    };
    const parsed = generationStreamSnapshotSchema.parse(snapshot);

    expect(parsed).toEqual({
      id: JOB_ID,
      campaignId: CAMPAIGN_ID,
      expectedTurnNumber: 3,
      action: "Open the dome.",
      operationKind: "append",
      replacementTurnId: null,
      status: "cancelled",
      attempts: 1,
      partialNarration: "Sanitized narration",
      errorCode: null,
      errorMessage: null
    });
    expect(generationStreamSnapshotSchema.safeParse({ ...snapshot, expectedTurnNumber: "3" }).success).toBe(false);
    expect(generationStreamSnapshotSchema.safeParse({ ...snapshot, status: "mystery" }).success).toBe(false);
  });

  it("exports the full polling snapshot while excluding raw partial output", () => {
    const parsed = generationJobSnapshotSchema.parse({
      id: JOB_ID,
      campaignId: CAMPAIGN_ID,
      expectedTurnNumber: 3,
      action: "Open the dome.",
      requestedInputMode: "action",
      resolvedInputMode: "action",
      inputModeSource: "explicit",
      operationKind: "append",
      replacementTurnId: null,
      status: "cancelled",
      attempts: 1,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      partialOutput: "raw provider response",
      partialNarration: "Sanitized narration",
      errorCode: null,
      errorMessage: null
    });

    expect(parsed).toMatchObject({ id: JOB_ID, createdAt: TIMESTAMP, updatedAt: TIMESTAMP });
    expect(parsed).not.toHaveProperty("partialOutput");
  });
});
