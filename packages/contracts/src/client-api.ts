import { z } from "zod";
import {
  campaignBranchSchema,
  campaignRewindSchema,
  campaignRuntimeStateSchema,
  campaignRuntimeStateUpdateSchema,
  campaignTrackerSchema,
  generationJobSnapshotSchema,
  generationJobStatusSchema,
  generationStreamSnapshotSchema,
  playerEventTriggerSchema,
  playerRpgStatSchema,
  turnInputClassificationRequestSchema,
  turnInputModeSchema,
  turnInputModeSourceSchema
} from "./generation.js";
import { apiTimestampSchema } from "./http.js";
import { storyLengthProfileSchema } from "./story-settings.js";
import { userProfileSchema, userProfileUpdateSchema } from "./users.js";
import { campaignCreateSchema, playableCharacterSchema, worldCreateSchema } from "./world-library.js";

const turnControlStyleSchema = z.enum(["action_only", "flexible_auto", "flexible_action", "flexible_scene"]);
const operationKindSchema = generationJobStatusSchema.shape.operationKind;
const generationStatusSchema = generationJobStatusSchema.shape.status;
const nullableObjectSchema = z.record(z.string(), z.unknown()).nullable();

const reportedCostSchema = z.object({
  amount: z.string(),
  currency: z.string().trim().min(1),
  byCategory: z.object({
    story: z.string(),
    image: z.string(),
    memory: z.string()
  })
});

const campaignCostInformationSchema = z.object({
  amount: z.string(),
  currency: z.string().trim().min(1),
  textGenerationAmount: z.string(),
  imageGenerationAmount: z.string(),
  memoryAmount: z.string()
});

export const campaignSummarySchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1),
  status: z.enum(["active", "archived"]),
  activeTurnNumber: z.number().int().min(0),
  createdAt: apiTimestampSchema,
  updatedAt: apiTimestampSchema,
  storyLengthProfile: storyLengthProfileSchema,
  turnControlStyle: turnControlStyleSchema,
  selectedCharacterId: z.string().nullable(),
  selectedCharacterName: z.string().nullable(),
  worldId: z.uuid(),
  worldTitle: z.string(),
  worldVersionId: z.uuid(),
  textProviderProfileId: z.uuid().nullable(),
  imageProviderProfileId: z.uuid().nullable(),
  worldVersionNumber: z.number().int().positive(),
  latestWorldVersionNumber: z.number().int().positive(),
  worldUpdateAvailable: z.boolean(),
  costInformation: z.array(campaignCostInformationSchema)
});

export const campaignListResponseSchema = z.object({
  campaigns: z.array(campaignSummarySchema)
});

export const metaResponseSchema = z.object({
  application: z.object({
    name: z.literal("Infinite Quest Nexus"),
    version: z.string().trim().min(1),
    commit: z.string().nullable(),
    builtAt: z.string().nullable()
  })
});

export const sessionResponseSchema = z.object({
  user: userProfileSchema,
  authentication: z.literal("deferred")
});

export const userProfileResponseSchema = z.object({ user: userProfileSchema });

export const providerSummarySchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1),
  providerType: z.string().trim().min(1),
  providerRole: z.string().trim().min(1)
}).passthrough();

export const providerListResponseSchema = z.object({ providers: z.array(providerSummarySchema) });

export const turnInputClassificationResponseSchema = z.object({
  classificationId: z.uuid(),
  classification: z.enum(["action", "scene", "mixed", "uncertain"]),
  resolvedMode: turnInputModeSchema,
  confidenceBand: z.enum(["clear", "probable", "ambiguous"]),
  providerSource: z.enum(["intent_default", "story_text", "campaign_fallback"]),
  expiresAt: apiTimestampSchema
});

export const campaignRuntimeStateResponseSchema = campaignRuntimeStateSchema;
export const campaignRuntimeStateUpdateRequestSchema = campaignRuntimeStateUpdateSchema;

export const campaignRewindResponseSchema = z.object({
  campaignId: z.uuid(),
  activeTurnNumber: z.number().int().min(0),
  discardedTurnCount: z.number().int().min(0),
  stateSnapshot: z.record(z.string(), z.unknown())
});

export const campaignBranchResponseSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1),
  activeTurnNumber: z.number().int().min(0),
  worldVersionId: z.uuid()
}).passthrough();

export const campaignCreateResponseSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1),
  status: z.literal("active"),
  activeTurnNumber: z.literal(0),
  storyLengthProfile: storyLengthProfileSchema,
  worldId: z.uuid(),
  worldVersionId: z.uuid(),
  worldVersionNumber: z.number().int().positive(),
  selectedCharacterId: z.string().trim().min(1),
  selectedCharacterName: z.string().trim().min(1),
  textProviderProfileId: z.uuid().nullable(),
  imageProviderProfileId: z.uuid().nullable()
}).passthrough();

export const worldCreateResponseSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1),
  status: z.literal("draft"),
  imageUrl: z.string(),
  draftRevision: z.number().int().positive(),
  draftContent: z.record(z.string(), z.unknown()),
  draftBasedOnWorldVersionId: z.uuid().nullable(),
  createdAt: apiTimestampSchema,
  updatedAt: apiTimestampSchema
});

export const playableCharacterListResponseSchema = z.object({
  characters: z.array(z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    rpgStatCount: z.number().int().min(0),
    defaultTriggerCount: z.number().int().min(0)
  })),
  readiness: z.object({
    ready: z.boolean(),
    issues: z.array(z.object({ message: z.string() }).passthrough())
  }).passthrough()
});

export { campaignBranchSchema, campaignRewindSchema, turnInputClassificationRequestSchema } from "./generation.js";
export { userProfileUpdateSchema } from "./users.js";
export { campaignCreateSchema, worldCreateSchema } from "./world-library.js";

const campaignSyncCampaignSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1),
  activeTurnNumber: z.number().int().min(0),
  worldVersionId: z.uuid(),
  storyLengthProfile: storyLengthProfileSchema,
  updatedAt: apiTimestampSchema,
  selectedCharacterId: z.string().nullable(),
  selectedCharacterName: z.string(),
  characterSnapshot: nullableObjectSchema,
  characterProfile: nullableObjectSchema,
  characterProfileRevision: z.number().int().min(0),
  status: z.enum(["active", "archived"])
});

const pendingGenerationSchema = z.object({
  id: z.uuid(),
  status: generationStatusSchema,
  action: z.string(),
  operationKind: operationKindSchema,
  expectedTurnNumber: z.number().int().min(1),
  createdAt: apiTimestampSchema,
  updatedAt: apiTimestampSchema
});

export const generationRecoverySchema = z.object({
  id: z.uuid(),
  status: z.enum(["recoverable", "failed", "completed"]),
  operationKind: operationKindSchema,
  expectedTurnNumber: z.number().int().min(1),
  attempts: z.number().int().min(0),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  resultTurnId: z.uuid().nullable()
});

const campaignSyncStatusBaseSchema = campaignSyncCampaignSchema.extend({
  campaign: campaignSyncCampaignSchema,
  world: z.object({
    id: z.uuid(),
    title: z.string(),
    versionNumber: z.number().int().positive(),
    genre: z.string(),
    tone: z.string(),
    premise: z.string(),
    backgroundStory: z.string(),
    character: z.string(),
    firstAction: z.string(),
    rules: z.string(),
    playableCharacters: z.array(playableCharacterSchema)
  }),
  playerConfig: z.object({
    selectedCharacterId: z.string().nullable(),
    selectedCharacterName: z.string(),
    characterSnapshot: nullableObjectSchema,
    characterProfile: nullableObjectSchema,
    characterProfileRevision: z.number().int().min(0),
    rpgStats: z.array(playerRpgStatSchema),
    trackers: z.array(campaignTrackerSchema),
    eventTriggers: z.array(playerEventTriggerSchema),
    useRpgStats: z.boolean(),
    suppressEventTriggers: z.boolean()
  }),
  pendingGeneration: pendingGenerationSchema.nullable(),
  syncToken: z.string().min(1),
  generationRecovery: generationRecoverySchema.nullable()
});

export const turnSummarySchema = z.object({
  id: z.uuid(),
  turnNumber: z.number().int().positive(),
  action: z.string(),
  inputMode: turnInputModeSchema,
  inputModeSource: turnInputModeSourceSchema,
  narration: z.string(),
  choices: z.array(z.string()),
  customActionSuggestion: z.string(),
  imagePrompt: z.string(),
  imageUrl: z.string().nullable(),
  acceptedAt: apiTimestampSchema,
  reportedCost: reportedCostSchema.nullable()
});

export const turnListResponseSchema = z.object({
  turns: z.array(turnSummarySchema),
  nextCursor: z.string().min(1).nullable()
});

export const turnPageRequestSchema = z.object({
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

export const syncStatusRequestSchema = z.object({
  since: z.string().min(1).optional()
});

export const campaignSyncStatusSchema = z.discriminatedUnion("turnWindowMode", [
  campaignSyncStatusBaseSchema.extend({
    turnWindowMode: z.literal("unchanged"),
    turns: z.null()
  }),
  campaignSyncStatusBaseSchema.extend({
    turnWindowMode: z.literal("replace"),
    turns: z.lazy(() => turnListResponseSchema)
  })
]);

export const generationEnqueueResponseSchema = z.object({
  id: z.uuid(),
  status: generationStatusSchema,
  duplicate: z.boolean(),
  resultTurnId: z.uuid().nullable().optional(),
  action: z.string().optional(),
  operationKind: operationKindSchema.optional(),
  expectedTurnNumber: z.number().int().min(1).optional(),
  replacementTurnId: z.uuid().nullable().optional(),
  createdAt: apiTimestampSchema.optional(),
  recoveryMetadata: z.record(z.string(), z.unknown()).optional()
});

export { generationJobSnapshotSchema, generationStreamSnapshotSchema };

export const generationResultSchema = z.object({
  id: z.uuid(),
  status: z.literal("completed"),
  campaignId: z.uuid(),
  expectedTurnNumber: z.number().int().min(1),
  resultTurnId: z.uuid(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  turnNumber: z.number().int().positive(),
  action: z.string(),
  inputMode: turnInputModeSchema,
  inputModeSource: turnInputModeSourceSchema,
  narration: z.string(),
  choices: z.array(z.string()),
  customActionSuggestion: z.string(),
  imagePrompt: z.string(),
  modelMetadata: nullableObjectSchema,
  mechanics: nullableObjectSchema,
  acceptedAt: apiTimestampSchema,
  stateSnapshot: z.record(z.string(), z.unknown()),
  reportedCost: reportedCostSchema.nullable()
});

const generationActionStatusSchema = generationStatusSchema.extract([
  "queued",
  "replacement_queued",
  "cancelled",
  "discarded"
]);

export const generationActionResponseSchema = generationJobStatusSchema.pick({
  id: true,
  campaignId: true,
  operationKind: true
}).partial({ campaignId: true, operationKind: true }).extend({
  status: generationActionStatusSchema
});

export type CampaignSummary = z.infer<typeof campaignSummarySchema>;
export type CampaignListResponse = z.infer<typeof campaignListResponseSchema>;
export type MetaResponse = z.infer<typeof metaResponseSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type UserProfileResponse = z.infer<typeof userProfileResponseSchema>;
export type ProviderListResponse = z.infer<typeof providerListResponseSchema>;
export type TurnInputClassificationResponse = z.infer<typeof turnInputClassificationResponseSchema>;
export type CampaignRuntimeStateResponse = z.infer<typeof campaignRuntimeStateResponseSchema>;
export type CampaignRewindResponse = z.infer<typeof campaignRewindResponseSchema>;
export type CampaignBranchResponse = z.infer<typeof campaignBranchResponseSchema>;
export type CampaignCreateResponse = z.infer<typeof campaignCreateResponseSchema>;
export type WorldCreateResponse = z.infer<typeof worldCreateResponseSchema>;
export type PlayableCharacterListResponse = z.infer<typeof playableCharacterListResponseSchema>;
export type CampaignSyncStatus = z.infer<typeof campaignSyncStatusSchema>;
export type GenerationRecovery = z.infer<typeof generationRecoverySchema>;
export type TurnSummary = z.infer<typeof turnSummarySchema>;
export type TurnListResponse = z.infer<typeof turnListResponseSchema>;
export type TurnPageRequest = z.input<typeof turnPageRequestSchema>;
export type SyncStatusRequest = z.input<typeof syncStatusRequestSchema>;
export type GenerationEnqueueResponse = z.infer<typeof generationEnqueueResponseSchema>;
export type GenerationResult = z.infer<typeof generationResultSchema>;
export type GenerationActionResponse = z.infer<typeof generationActionResponseSchema>;
