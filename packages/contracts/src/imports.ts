import { z } from "zod";

const legacyWorldSchema = z.object({
  title: z.string().optional(),
  genre: z.string().optional(),
  tone: z.string().optional(),
  backgroundStory: z.string().optional(),
  character: z.string().optional(),
  premise: z.string().optional(),
  firstAction: z.string().optional(),
  rules: z.string().optional(),
  suppressTriggers: z.boolean().optional()
}).passthrough();

const legacyTurnSchema = z.object({
  id: z.string().optional(),
  turnNumber: z.number().int().positive().optional(),
  action: z.string().optional(),
  narration: z.string().optional(),
  story: z.string().optional(),
  text: z.string().optional(),
  choices: z.array(z.unknown()).optional(),
  customActionSuggestion: z.string().optional(),
  custom_action_suggestion: z.string().optional(),
  imagePrompt: z.string().optional(),
  imageUrl: z.string().optional(),
  roll: z.unknown().optional(),
  scratchpadSnapshot: z.string().optional(),
  trackersSnapshot: z.array(z.unknown()).optional(),
  worldStateSnapshot: z.unknown().optional(),
  llmModelInfo: z.unknown().optional(),
  importedFrom: z.unknown().optional(),
  createdAt: z.string().optional()
}).passthrough();

export const legacyStorySchema = z.object({
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
  story: legacyStorySchema
});

export const storyImportPreviewRequestSchema = storyImportRequestSchema;

export type LegacyStory = z.infer<typeof legacyStorySchema>;
export type LegacyTurn = z.infer<typeof legacyTurnSchema>;
export type StoryImportRequest = z.infer<typeof storyImportRequestSchema>;
export type StoryImportPreviewRequest = z.infer<typeof storyImportPreviewRequestSchema>;

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
