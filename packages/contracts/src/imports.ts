import { z } from "zod";

const coerceToString = (val: unknown): string | undefined => {
  if (val === null || val === undefined) return undefined;
  if (typeof val === "string") return val;
  if (Array.isArray(val)) {
    return val
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
};

const flexibleOptionalString = z.preprocess(coerceToString, z.string().optional());

const legacyWorldSchema = z.object({
  title: flexibleOptionalString,
  genre: flexibleOptionalString,
  tone: flexibleOptionalString,
  backgroundStory: flexibleOptionalString,
  character: flexibleOptionalString,
  premise: flexibleOptionalString,
  firstAction: flexibleOptionalString,
  rules: flexibleOptionalString,
  suppressTriggers: z.boolean().optional()
}).passthrough();

const legacyTurnSchema = z.object({
  id: z.string().optional(),
  turnNumber: z.number().int().positive().optional(),
  action: flexibleOptionalString,
  inputMode: z.enum(["action", "scene"]).optional(),
  inputModeSource: z.enum(["explicit", "auto", "generated_choice", "opening_action", "fallback"]).optional(),
  narration: flexibleOptionalString,
  story: flexibleOptionalString,
  text: flexibleOptionalString,
  choices: z.array(z.unknown()).optional(),
  customActionSuggestion: flexibleOptionalString,
  custom_action_suggestion: flexibleOptionalString,
  imagePrompt: flexibleOptionalString,
  imageUrl: flexibleOptionalString,

  roll: z.unknown().optional(),
  scratchpadSnapshot: z.string().optional(),
  trackersSnapshot: z.array(z.unknown()).optional(),
  worldStateSnapshot: z.unknown().optional(),
  llmModelInfo: z.unknown().optional(),
  importedFrom: z.unknown().optional(),
  createdAt: z.string().optional()
}).passthrough();

const portableCampaignMetadataSchema = z.object({
  title: z.string().trim().min(1).max(200),
  sourceCampaignId: z.uuid().optional(),
  sourceWorldVersionId: z.uuid().optional(),
  sourceWorldVersionNumber: z.number().int().positive().optional(),
  selectedCharacterId: z.string().trim().min(1).max(200).nullable().optional(),
  characterSnapshot: z.record(z.string(), z.unknown()).nullable().optional(),
  stateRevision: z.number().int().nonnegative().default(0)
}).passthrough();

export const legacyStorySchema = z.object({
  format: z.literal("infinite-quest-campaign").optional(),
  formatVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  campaign: portableCampaignMetadataSchema.optional(),
  world: legacyWorldSchema,
  turns: z.array(legacyTurnSchema),
  settings: z.record(z.string(), z.unknown()).optional(),
  rpgStats: z.array(z.unknown()).optional(),
  defaultTriggers: z.array(z.unknown()).optional(),
  eventTriggers: z.array(z.unknown()).optional(),
  pendingEventTriggers: z.array(z.unknown()).optional(),
  baseTrackersAtStart: z.array(z.unknown()).optional(),
  trackers: z.array(z.unknown()).optional(),
  scratchpad: z.string().optional(),
  fullHistory: z.unknown().optional(),
  fullHistoryCompressedThroughTurn: z.number().int().nonnegative().optional(),
  worldImportProvenance: z.unknown().optional(),
  storyImportProvenance: z.unknown().optional()
}).passthrough();

export const storyImportRequestSchema = z.object({
  sourceName: z.string().max(512).default("legacy-story.story"),
  story: legacyStorySchema,
  targetWorldVersionId: z.uuid().optional(),
  selectedCharacterId: z.string().trim().min(1).max(200).optional(),
  characterStrategy: z.enum(["preserve_source", "map_to_target"]).optional()
});

export const storyImportPreviewRequestSchema = storyImportRequestSchema;

export type LegacyStory = z.infer<typeof legacyStorySchema>;
export type LegacyTurn = z.infer<typeof legacyTurnSchema>;
export type StoryImportRequest = z.infer<typeof storyImportRequestSchema>;
export type StoryImportPreviewRequest = z.infer<typeof storyImportPreviewRequestSchema>;

export const infiniteWorldsImportRequestSchema = z.object({
  sourceName: z.string().trim().max(512).default("infinite-worlds-export.txt"),
  sourceText: z.string().min(1).max(50_000_000),
  sourceKind: z.enum(["auto", "world_json", "world_text", "story_text", "cyoa_json"]).default("auto"),
  selectedCharacterIndex: z.coerce.number().int().nonnegative().max(1000).default(0),
  selectedCharacterId: z.string().trim().min(1).max(200).optional(),
  targetWorldVersionId: z.uuid().optional(),
  providerProfileId: z.uuid().optional(),
  model: z.string().trim().max(500).optional(),
  enrichFinalTurn: z.boolean().default(false)
});

export type InfiniteWorldsImportRequest = z.infer<typeof infiniteWorldsImportRequestSchema>;

export type StoryImportResult = {
  importId: string;
  worldId: string;
  worldVersionId: string;
  campaignId: string;
  duplicate: boolean;
  stats: {
    turnCount: number;
    memoryCount: number;
    completeHistoryCharacters: number;
    estimatedHistoryTokens: number;
    importedSummary: boolean;
    sanitizedMemoryCount: number;
  };
};

export const cyoaChapterSchema = z.object({
  id: z.coerce.string().optional(),
  title: z.string().optional(),
  author_id: z.coerce.string().optional(),
  author_name: z.string().optional(),
  content: z.string().optional(),
  choices: z.array(z.string()).default([]),
  created: z.number().optional()
}).passthrough();

export const cyoaInfoSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  pretty_title: z.string().optional(),
  brief_description: z.string().optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).default([]),
  author_name: z.string().optional(),
  image_url: z.string().nullable().optional(),
  rating: z.string().optional()
}).passthrough();

export const cyoaExportSchema = z.object({
  chapters: z.record(z.string(), cyoaChapterSchema).default({}),
  info: cyoaInfoSchema.optional(),
  complete: z.boolean().optional()
}).passthrough();

export type CyoaChapter = z.infer<typeof cyoaChapterSchema>;
export type CyoaInfo = z.infer<typeof cyoaInfoSchema>;
export type CyoaExport = z.infer<typeof cyoaExportSchema>;

export type CyoaImportPreviewResult = {
  kind: "cyoa_json";
  valid: boolean;
  requiresProvider: boolean;
  warnings: string[];
  counts: {
    topLevelTitle: string;
    layer1ChaptersCount: number;
    characterTarget: string;
  };
};

export type ImportProgressReport = {
  importId: string;
  status: "processing" | "completed" | "failed";
  phase: string;
  progressPercent: number;
  message: string;
  worldId?: string;
  worldVersionId?: string;
  duplicate?: boolean;
  errorMessage?: string;
};
