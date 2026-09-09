import { z } from "zod";
import {
  campaignTurnControlStyleSchema,
  historicalCampaignTurnControlStyleSchema,
  type CampaignTurnControlStyle,
  type HistoricalCampaignTurnControlStyle
} from "./campaign-generation-policy.js";

export function normalizeHistoricalDefaultTurnControlStyle(
  style: HistoricalCampaignTurnControlStyle | undefined
): CampaignTurnControlStyle {
  return style === "flexible_scene" ? "flexible_scene" : style === "action_only" ? "action_only" : "flexible_action";
}

export const userSettingsSchema = z.object({
  autoSubmitTurnChoices: z.boolean().default(true),
  continuousReading: z.boolean().default(false),
  defaultTurnControlStyle: campaignTurnControlStyleSchema.default("flexible_action")
}).passthrough();

export const historicalUserSettingsSchema = z.object({
  autoSubmitTurnChoices: z.boolean().default(true),
  continuousReading: z.boolean().default(false),
  defaultTurnControlStyle: historicalCampaignTurnControlStyleSchema.optional()
}).passthrough().transform((settings) => ({
  ...settings,
  defaultTurnControlStyle: normalizeHistoricalDefaultTurnControlStyle(settings.defaultTurnControlStyle)
}));

export const userProfileSchema = z.object({
  id: z.uuid(),
  systemKey: z.string().nullable().default(null),
  displayName: z.string(),
  settings: userSettingsSchema.default({ autoSubmitTurnChoices: true, continuousReading: false, defaultTurnControlStyle: "flexible_action" })
});

export const userProfileUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  settings: userSettingsSchema.optional()
}).refine(
  (value) => value.displayName !== undefined || value.settings !== undefined,
  "At least one profile field is required."
);

export type UserSettings = z.infer<typeof userSettingsSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;
export type UserProfileUpdate = z.infer<typeof userProfileUpdateSchema>;
