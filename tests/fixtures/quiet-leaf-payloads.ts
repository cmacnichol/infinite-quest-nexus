import {
  campaignListResponseSchema,
  campaignRuntimeStateResponseSchema,
  campaignSyncStatusSchema,
  apiErrorEnvelopeSchema,
  illustrationConfigResponseSchema,
  illustrationSegmentsResponseSchema,
  sessionResponseSchema,
  turnInputClassificationResponseSchema,
  turnListResponseSchema,
  worldListResponseSchema,
  type CampaignSyncStatus,
  type CampaignSummary,
  type UserProfile
} from "../../packages/contracts/src/index.js";

export const quietLeafCampaignId = "11111111-1111-4111-8111-111111111111";

const worldId = "22222222-2222-4222-8222-222222222222";
const worldVersionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const generationId = "55555555-5555-4555-8555-555555555555";
const userId = "66666666-6666-4666-8666-666666666666";
const timestamp = "2026-08-30T12:00:00.000Z";

export interface QuietLeafFixtureOptions {
  readonly pendingGeneration?: boolean;
  readonly illustration?: "disabled" | "enabled" | "error";
  readonly turnControlStyle?: CampaignSummary["turnControlStyle"];
  readonly returningUser?: boolean;
  readonly expectedProfileUpdates?: number;
  readonly expectedClassificationCalls?: number;
}

export interface QuietLeafApiPayloads {
  readonly campaignId: string;
  readonly campaigns: ReturnType<typeof campaignListResponseSchema.parse>;
  readonly session: ReturnType<typeof sessionResponseSchema.parse>;
  readonly syncStatus: CampaignSyncStatus;
  readonly turns: ReturnType<typeof turnListResponseSchema.parse>;
  readonly worlds: ReturnType<typeof worldListResponseSchema.parse>;
  readonly runtimeState: ReturnType<typeof campaignRuntimeStateResponseSchema.parse>;
  readonly classification: ReturnType<typeof turnInputClassificationResponseSchema.parse>;
  readonly illustrationConfig: ReturnType<typeof illustrationConfigResponseSchema.parse>;
  readonly illustrationSegments: ReturnType<typeof illustrationSegmentsResponseSchema.parse>;
  readonly illustrationError: ReturnType<typeof apiErrorEnvelopeSchema.parse>;
}

export function quietLeafApiPayloads(options: QuietLeafFixtureOptions = {}): QuietLeafApiPayloads {
  const campaign = {
    id: quietLeafCampaignId,
    title: "Fixture Story",
    status: "active",
    activeTurnNumber: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    storyLengthProfile: "standard",
    storyContextBudgetTokens: 32_000,
    turnControlStyle: options.turnControlStyle ?? "action_only",
    selectedCharacterId: null,
    selectedCharacterName: null,
    worldId,
    worldTitle: "Fixture World",
    worldVersionId,
    textProviderProfileId: null,
    imageProviderProfileId: null,
    worldVersionNumber: 1,
    latestWorldVersionNumber: 1,
    worldUpdateAvailable: false,
    costInformation: []
  };
  const user = {
    id: userId,
    systemKey: null,
    displayName: options.returningUser ? "Returning Fixture Reader" : "Fixture Reader",
    settings: {
      autoSubmitTurnChoices: false,
      continuousReading: options.returningUser === true,
      defaultTurnControlStyle: "action_only"
    }
  } satisfies UserProfile;
  const pendingGeneration = options.pendingGeneration ? {
    id: generationId,
    status: "generating" as const,
    action: "Generate a fixture turn.",
    expectedTurnNumber: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
    operationKind: "append" as const,
    replacementTurnId: null
  } : null;
  const syncCampaign = {
    id: campaign.id,
    title: campaign.title,
    activeTurnNumber: campaign.activeTurnNumber,
    worldVersionId,
    storyLengthProfile: campaign.storyLengthProfile,
    storyContextBudgetTokens: campaign.storyContextBudgetTokens,
    turnControlStyle: campaign.turnControlStyle,
    updatedAt: campaign.updatedAt,
    selectedCharacterId: null,
    selectedCharacterName: "",
    characterSnapshot: null,
    characterProfile: null,
    characterProfileRevision: 0,
    status: "active"
  };
  const turn = {
    id: turnId,
    turnNumber: 1,
    action: "Survey the empty platform.",
    inputMode: "action",
    inputModeSource: "explicit",
    narration: [
      "The platform is quiet, with three marked paths ahead.",
      "A weathered door waits beneath a painted number that has faded to a pale crescent. Three chalk marks point toward it, each laid down by a different hand.",
      "The air carries rain and old iron. Nothing moves on the tracks, but the station clock has begun to tick backward."
    ].join("\n\n"),
    choices: ["Cross the threshold", "Cross the threshold", "Wait for a signal"],
    customActionSuggestion: "",
    imagePrompt: "",
    imageUrl: null,
    acceptedAt: timestamp,
    chronicleRetrieval: null,
    reportedCost: null
  };
  const illustrationMode = options.illustration ?? "disabled";
  const illustrationSegments = illustrationMode === "enabled" ? [{
    setId: "88888888-8888-4888-8888-888888888888",
    turnId,
    setStatus: "completed",
    segmentWordCount: 120,
    imagesPerSegment: 1,
    promptMode: "direct",
    id: "99999999-9999-4999-8999-999999999999",
    ordinal: 0,
    startOffset: 0,
    endOffset: turn.narration.length,
    startWord: 0,
    endWord: turn.narration.split(/\s+/u).length,
    text: turn.narration,
    status: "completed",
    promptSource: null,
    directPrompt: "A weathered door at the end of a quiet platform.",
    resolvedPrompt: "A weathered door at the end of a quiet platform.",
    variants: [{
      assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      url: "/ui-test/quiet-leaf-door.png",
      variantIndex: 0,
      prompt: "A weathered door at the end of a quiet platform.",
      providerType: null,
      model: "fixture-library",
      createdAt: timestamp,
      selectionReason: "fixture-library",
      matchScore: 1,
      matchThreshold: 0.8,
      matchingAlgorithm: "fixture-exact"
    }],
    imageJobId: null,
    imageJobStatus: null,
    providerStatus: "library_match",
    providerProgress: null,
    errorMessage: null,
    promptJobStatus: null
  }] : [];

  return {
    campaignId: quietLeafCampaignId,
    campaigns: campaignListResponseSchema.parse({ campaigns: [campaign] }),
    session: sessionResponseSchema.parse({ user, authentication: "deferred" }),
    syncStatus: campaignSyncStatusSchema.parse({
      ...syncCampaign,
      campaign: syncCampaign,
      world: {
        id: worldId,
        title: "Fixture World",
        versionNumber: 1,
        genre: "",
        tone: "",
        premise: "A sanitized test setting.",
        backgroundStory: "A sanitized test background.",
        character: "",
        firstAction: "Survey the empty platform.",
        rules: "",
        playableCharacters: []
      },
      playerConfig: {
        selectedCharacterId: null,
        selectedCharacterName: "",
        characterSnapshot: null,
        characterProfile: null,
        characterProfileRevision: 0,
        rpgStats: [],
        trackers: [],
        eventTriggers: [],
        useRpgStats: false,
        suppressEventTriggers: false
      },
      pendingGeneration,
      generationRecovery: null,
      syncToken: "quiet-leaf-fixture-sync",
      turnWindowMode: "replace",
      turns: {
        campaignId: quietLeafCampaignId,
        nextCursor: null,
        turns: [turn]
      }
    }),
    turns: turnListResponseSchema.parse({ campaignId: quietLeafCampaignId, turns: [turn], nextCursor: null }),
    worlds: worldListResponseSchema.parse({
      worlds: [{
        id: worldId,
        title: "Fixture World",
        status: "active",
        imageUrl: "/ui-test/quiet-leaf-door.png",
        forkedFromWorldId: null,
        forkedFromWorldVersionId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        draftRevision: null,
        draftUpdatedAt: null,
        draftPreview: null,
        latestVersionId: worldVersionId,
        latestVersionNumber: 1,
        latestPublishedAt: timestamp,
        latestPreview: {
          title: "Fixture World",
          genre: "",
          tone: "",
          premise: "A sanitized test setting.",
          backgroundStory: "A sanitized test background.",
          firstAction: "Survey the empty platform."
        },
        campaignCount: 1
      }]
    }),
    runtimeState: campaignRuntimeStateResponseSchema.parse({
      campaignId: quietLeafCampaignId,
      activeTurnNumber: 1,
      viewedTurnNumber: 1,
      isCurrent: true,
      revision: 1,
      updatedAt: timestamp,
      continuitySummary: "A sanitized fixture state.",
      openThreads: [],
      canonicalFacts: [],
      scratchpad: "",
      trackers: [],
      rpgStats: [],
      eventTriggers: [],
      pendingEventTriggers: [],
      recordedResolution: null
    }),
    classification: turnInputClassificationResponseSchema.parse({
      classificationId: "77777777-7777-4777-8777-777777777777",
      classification: "action",
      resolvedMode: "action",
      confidenceBand: "clear",
      providerSource: "intent_default",
      expiresAt: timestamp
    }),
    illustrationConfig: illustrationConfigResponseSchema.parse({
      enabled: illustrationMode === "enabled",
      sourcePolicy: illustrationMode === "enabled" ? "library_only" : "off",
      matchingScope: "campaign",
      confidenceProfile: "balanced",
      repetitionWindow: 0,
      providerProfileId: null,
      model: illustrationMode === "enabled" ? "fixture-library" : "disabled",
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "standard",
      outputFormat: "png",
      maxAttempts: 1,
      segmentWordCount: 120,
      imagesPerSegment: 1,
      segmentPromptMode: "direct",
      refinementPrompt: "No image generation is configured for this fixture.",
      defaultRefinementPrompt: "No image generation is configured for this fixture.",
      updatedAt: timestamp
    }),
    illustrationSegments: illustrationSegmentsResponseSchema.parse({ segments: illustrationSegments }),
    illustrationError: apiErrorEnvelopeSchema.parse({
      error: "Service Unavailable",
      message: "Illustrations are unavailable for this fixture.",
      correlationId: "quiet-leaf-fixture",
      details: { code: "image_unavailable" }
    })
  };
}
