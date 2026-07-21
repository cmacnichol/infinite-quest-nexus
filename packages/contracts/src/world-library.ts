import { z } from "zod";
import { DEFAULT_STORY_LENGTH_PROFILE, storyLengthProfileSchema } from "./story-settings.js";

const coerceToString = (val: unknown): string => {
  if (val === null || val === undefined) return "";
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

const title = z.preprocess((v) => (typeof v === "string" ? v : coerceToString(v)), z.string().trim().min(1).max(200));
const shortText = z.preprocess(coerceToString, z.string().max(2000).default(""));
const longText = z.preprocess(coerceToString, z.string().max(200_000).default(""));
const characterId = z.string().trim().min(1).max(200);

export const WORLD_CONTENT_SCHEMA_VERSION = 4;

export const playableCharacterSchema = z.object({

  id: characterId,
  name: z.string().trim().min(1).max(200),
  characterText: longText,
  rpgStats: z.array(z.unknown()).max(10_000).default([]),
  defaultTriggers: z.array(z.unknown()).max(10_000).default([]),
  source: z.record(z.string(), z.unknown()).default({})
}).passthrough();

export const worldOverviewSchema = z.object({
  title,
  genre: shortText,
  tone: shortText,
  premise: longText,
  backgroundStory: longText,
  firstAction: longText,
  rules: longText
}).passthrough();

export const worldContentSchema = z.object({
  schemaVersion: z.number().int().positive().default(WORLD_CONTENT_SCHEMA_VERSION),
  world: worldOverviewSchema,
  playableCharacters: z.array(playableCharacterSchema).max(1000).default([]),
  entities: z.array(z.unknown()).max(20_000).default([]),
  relationships: z.array(z.unknown()).max(50_000).default([]),
  rpgStats: z.array(z.unknown()).max(10_000).default([]),
  defaultTriggers: z.array(z.unknown()).max(10_000).default([]),
  eventTriggers: z.array(z.unknown()).max(10_000).default([]),
  assets: z.array(z.unknown()).max(10_000).default([]),
  defaults: z.record(z.string(), z.unknown()).default({})
}).passthrough();

export type WorldContent = z.infer<typeof worldContentSchema>;

/**
 * Produces the canonical stored representation for new and updated world content.
 * Older positive schema versions remain readable through worldContentSchema, while
 * every write path can converge on the current representation without discarding
 * passthrough lore fields that this application does not yet understand.
 */
export function canonicalizeWorldContent(content: unknown): WorldContent {
  const parsed = worldContentSchema.parse(content);
  const world = { ...parsed.world };
  delete world.character;
  return {
    ...parsed,
    schemaVersion: WORLD_CONTENT_SCHEMA_VERSION,
    world
  };
}

export const worldCreateSchema = z.object({
  title,
  content: worldContentSchema.optional()
});

export const worldDraftUpdateSchema = z.object({
  expectedRevision: z.coerce.number().int().positive(),
  title: title.optional(),
  content: worldContentSchema
});

export const worldPublishSchema = z.object({
  expectedRevision: z.coerce.number().int().positive(),
  releaseNotes: z.string().trim().max(10_000).default("")
});

export const worldForkSchema = z.object({
  title,
  sourceWorldVersionId: z.uuid().optional()
});

export const worldStatusUpdateSchema = z.object({
  title: title.optional(),
  status: z.enum(["draft", "active", "archived"]).optional()
}).refine((value) => value.title !== undefined || value.status !== undefined, "At least one field is required.");

export const portableWorldSchema = z.object({
  format: z.literal("infinite-quest-world"),
  formatVersion: z.literal(1),
  title,
  content: worldContentSchema
});

export const worldImportRequestSchema = z.object({
  sourceName: z.string().trim().max(512).default("world.json"),
  worldExport: portableWorldSchema
});

export const campaignCreateSchema = z.object({
  worldVersionId: z.uuid(),
  title,
  selectedCharacterId: characterId.optional(),
  storyLengthProfile: storyLengthProfileSchema.default(DEFAULT_STORY_LENGTH_PROFILE)
});

export const campaignUpdateSchema = z.object({
  title: title.optional(),
  status: z.enum(["active", "archived"]).optional(),
  textProviderProfileId: z.uuid().nullable().optional(),
  imageProviderProfileId: z.uuid().nullable().optional(),
  storyLengthProfile: storyLengthProfileSchema.optional()
}).refine((value) => Object.values(value).some((item) => item !== undefined), "At least one field is required.");

export const campaignWorldMigrationSchema = z.object({
  worldVersionId: z.uuid(),
  note: z.string().trim().max(10_000).default("")
});

export const resourceDeleteSchema = z.object({
  confirmation: z.literal("DELETE"),
  expectedTitle: title
});

export type PlayableCharacter = z.infer<typeof playableCharacterSchema>;
export type WorldCreateRequest = z.infer<typeof worldCreateSchema>;
export type WorldDraftUpdateRequest = z.infer<typeof worldDraftUpdateSchema>;
export type WorldPublishRequest = z.infer<typeof worldPublishSchema>;
export type WorldForkRequest = z.infer<typeof worldForkSchema>;
export type WorldStatusUpdateRequest = z.infer<typeof worldStatusUpdateSchema>;
export type WorldImportRequest = z.infer<typeof worldImportRequestSchema>;
export type CampaignCreateRequest = z.infer<typeof campaignCreateSchema>;
export type CampaignUpdateRequest = z.infer<typeof campaignUpdateSchema>;
export type CampaignWorldMigrationRequest = z.infer<typeof campaignWorldMigrationSchema>;
export type ResourceDeleteRequest = z.infer<typeof resourceDeleteSchema>;
