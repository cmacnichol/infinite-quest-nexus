import { z } from "zod";
import {
  campaignTrackerSchema,
  generationJobStatusSchema,
  generationStreamSnapshotSchema,
  playerEventTriggerSchema,
  playerRpgStatSchema,
  turnInputModeSchema,
  turnInputModeSourceSchema
} from "./generation.js";
import { apiTimestampSchema } from "./http.js";
import { storyLengthProfileSchema } from "./story-settings.js";
import { playableCharacterSchema } from "./world-library.js";

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

export const campaignSyncStatusSchema = campaignSyncCampaignSchema.extend({
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
  pendingGeneration: pendingGenerationSchema.nullable()
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
  turns: z.array(turnSummarySchema)
});

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

export { generationStreamSnapshotSchema };

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
export type CampaignSyncStatus = z.infer<typeof campaignSyncStatusSchema>;
export type TurnSummary = z.infer<typeof turnSummarySchema>;
export type TurnListResponse = z.infer<typeof turnListResponseSchema>;
export type GenerationEnqueueResponse = z.infer<typeof generationEnqueueResponseSchema>;
export type GenerationResult = z.infer<typeof generationResultSchema>;
export type GenerationActionResponse = z.infer<typeof generationActionResponseSchema>;
