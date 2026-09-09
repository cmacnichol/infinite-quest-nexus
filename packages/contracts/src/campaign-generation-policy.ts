import { z } from "zod";

export const campaignTurnControlStyleSchema = z.enum([
  "action_only",
  "flexible_action",
  "flexible_scene"
]);

export const historicalCampaignTurnControlStyleSchema = z.enum([
  "action_only",
  "flexible_auto",
  "flexible_action",
  "flexible_scene"
]);

export const storyOnlyPromptSnapshotSchema = z.object({
  systemSupplement: z.string(),
  systemSupplementHash: z.string(),
  choiceRepairSystem: z.string(),
  choiceRepairSystemHash: z.string()
}).strict();

export const generationPolicySnapshotSchema = z.discriminatedUnion("playMode", [
  z.object({
    version: z.literal(1),
    playMode: z.literal("legacy"),
    turnControlStyle: z.enum(["action_only", "flexible_action"])
  }).strict(),
  z.object({
    version: z.literal(1),
    playMode: z.literal("story_only"),
    turnControlStyle: z.literal("flexible_scene"),
    protocolVersion: z.literal("story-only-v1"),
    prompts: storyOnlyPromptSnapshotSchema
  }).strict()
]);

export type CampaignPlayMode = "legacy" | "story_only";
export type CampaignTurnControlStyle = z.infer<typeof campaignTurnControlStyleSchema>;
export type HistoricalCampaignTurnControlStyle = z.infer<typeof historicalCampaignTurnControlStyleSchema>;
export type StoryOnlyPromptSnapshot = Readonly<z.infer<typeof storyOnlyPromptSnapshotSchema>>;
export type GenerationPolicySnapshot = Readonly<z.infer<typeof generationPolicySnapshotSchema>>;
