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

export const readerWidthChSchema = z.union([z.literal(60), z.literal(72), z.literal(84)]);
export const readerFontSizePxSchema = z.union([z.literal(16), z.literal(18), z.literal(20), z.literal(22)]);
export const readerLineHeightSchema = z.union([z.literal(1.5), z.literal(1.7), z.literal(1.9)]);
export const readerThemeSchema = z.enum(["dark", "light", "sepia"]);

export const readerPreferencesSchema = z.object({
  widthCh: readerWidthChSchema,
  fontSizePx: readerFontSizePxSchema,
  lineHeight: readerLineHeightSchema,
  theme: readerThemeSchema
}).strict();

export type ReaderPreferences = z.infer<typeof readerPreferencesSchema>;

export const DEFAULT_READER_PREFERENCES: Readonly<ReaderPreferences> = Object.freeze({
  widthCh: 72,
  fontSizePx: 18,
  lineHeight: 1.7,
  theme: "dark"
});

export function normalizeHistoricalReaderPreferences(value: unknown): ReaderPreferences {
  const preferences = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    widthCh: readerWidthChSchema.catch(DEFAULT_READER_PREFERENCES.widthCh).parse(preferences.widthCh),
    fontSizePx: readerFontSizePxSchema.catch(DEFAULT_READER_PREFERENCES.fontSizePx).parse(preferences.fontSizePx),
    lineHeight: readerLineHeightSchema.catch(DEFAULT_READER_PREFERENCES.lineHeight).parse(preferences.lineHeight),
    theme: readerThemeSchema.catch(DEFAULT_READER_PREFERENCES.theme).parse(preferences.theme)
  };
}

export const userSettingsSchema = z.object({
  autoSubmitTurnChoices: z.boolean().default(true),
  continuousReading: z.boolean().default(false),
  defaultTurnControlStyle: campaignTurnControlStyleSchema.default("flexible_action"),
  readerPreferences: readerPreferencesSchema.default(DEFAULT_READER_PREFERENCES)
}).passthrough();

export const historicalUserSettingsSchema = z.object({
  autoSubmitTurnChoices: z.boolean().default(true),
  continuousReading: z.boolean().default(false),
  defaultTurnControlStyle: historicalCampaignTurnControlStyleSchema.optional(),
  readerPreferences: z.unknown().optional()
}).passthrough().transform((settings) => ({
  ...settings,
  defaultTurnControlStyle: normalizeHistoricalDefaultTurnControlStyle(settings.defaultTurnControlStyle),
  readerPreferences: normalizeHistoricalReaderPreferences(settings.readerPreferences)
}));

export const userProfileSchema = z.object({
  id: z.uuid(),
  systemKey: z.string().nullable().default(null),
  displayName: z.string(),
  settings: userSettingsSchema.default({
    autoSubmitTurnChoices: true,
    continuousReading: false,
    defaultTurnControlStyle: "flexible_action",
    readerPreferences: DEFAULT_READER_PREFERENCES
  })
});

const userSettingsUpdateSchema = userSettingsSchema.extend({
  readerPreferences: readerPreferencesSchema.optional()
});

export const userProfileUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  settings: userSettingsUpdateSchema.optional()
}).refine(
  (value) => value.displayName !== undefined || value.settings !== undefined,
  "At least one profile field is required."
);

export type UserSettings = z.infer<typeof userSettingsSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;
export type UserProfileUpdate = z.infer<typeof userProfileUpdateSchema>;
