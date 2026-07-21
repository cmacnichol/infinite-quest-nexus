import { z } from "zod";

export const userSettingsSchema = z.object({
  autoSubmitTurnChoices: z.boolean().default(true),
  continuousReading: z.boolean().default(false)
}).passthrough();

export const userProfileSchema = z.object({
  id: z.uuid(),
  systemKey: z.string().nullable().default(null),
  displayName: z.string(),
  settings: userSettingsSchema.default({ autoSubmitTurnChoices: true, continuousReading: false })
});

export const userProfileUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  settings: userSettingsSchema.optional()
});

export type UserSettings = z.infer<typeof userSettingsSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;
export type UserProfileUpdate = z.infer<typeof userProfileUpdateSchema>;
