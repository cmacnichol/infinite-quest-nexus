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

export const WORLD_CONTENT_SCHEMA_VERSION = 5;

const profileText = z.preprocess(coerceToString, z.string().trim().max(20_000).default(""));
const profileShortText = z.preprocess(coerceToString, z.string().trim().max(2_000).default(""));

export const characterProfileSchema = z.object({
  identity: z.object({
    aliases: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    pronouns: profileShortText
  }).passthrough().default({ aliases: [], pronouns: "" }),
  story: z.object({
    role: profileText,
    background: profileText,
    personality: profileText,
    motivations: profileText,
    goals: profileText,
    fearsAndConflicts: profileText,
    keyRelationships: profileText,
    narrativeHooks: profileText,
    voiceAndMannerisms: profileText,
    otherGuidance: profileText
  }).passthrough().default({
    role: "", background: "", personality: "", motivations: "", goals: "",
    fearsAndConflicts: "", keyRelationships: "", narrativeHooks: "",
    voiceAndMannerisms: "", otherGuidance: ""
  }),
  appearance: z.object({
    ancestryOrSpecies: profileShortText,
    apparentAge: profileShortText,
    genderPresentation: profileShortText,
    build: profileShortText,
    skinOrComplexion: profileShortText,
    face: profileText,
    eyes: profileShortText,
    hair: profileText,
    distinguishingFeatures: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
    clothing: profileText,
    equipmentAndAccessories: profileText,
    otherVisualDetails: profileText
  }).passthrough().default({
    ancestryOrSpecies: "", apparentAge: "", genderPresentation: "", build: "",
    skinOrComplexion: "", face: "", eyes: "", hair: "", distinguishingFeatures: [],
    clothing: "", equipmentAndAccessories: "", otherVisualDetails: ""
  }),
  unclassifiedNotes: longText
}).passthrough();

export const playableCharacterSchema = z.object({
  id: characterId,
  name: z.string().trim().min(1).max(200),
  characterText: longText,
  profile: characterProfileSchema.optional(),
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

export const worldGenerationPreviewRequestSchema = z.object({
  title: z.string().trim().max(200).default(""),
  prompt: z.string().trim().min(1).max(20_000)
}).strict();

export const worldDraftUpdateSchema = z.object({
  expectedRevision: z.coerce.number().int().positive(),
  title: title.optional(),
  content: worldContentSchema
});

export const worldPublishSchema = z.object({
  expectedRevision: z.coerce.number().int().positive(),
  releaseNotes: z.string().trim().max(10_000).default("")
});

export const playableCharacterGenerationRequestSchema = z.object({
  expectedRevision: z.coerce.number().int().positive(),
  prompt: z.string().trim().min(1).max(20_000),
  characterId: characterId.optional()
}).strict();

export const characterProfileEditSourceSchema = z.enum(["manual", "ai_organized", "imported"]);

export const campaignCharacterProfileSchema = z.object({
  name: z.string().trim().min(1).max(200),
  profile: characterProfileSchema
}).strict();

export const campaignCharacterProfileUpdateSchema = campaignCharacterProfileSchema.extend({
  expectedRevision: z.coerce.number().int().min(0),
  editSource: characterProfileEditSourceSchema.default("manual")
}).strict();

export const characterProfileOrganizationRequestSchema = z.object({
  expectedRevision: z.coerce.number().int().min(0),
  character: playableCharacterSchema
}).strict();

export const characterProfileEvidenceSchema = z.object({
  path: z.string().trim().min(1).max(300),
  source: z.string().trim().min(1).max(100),
  quote: z.string().trim().min(1).max(4_000)
}).strict();

export const characterProfileOrganizationResultSchema = z.object({
  candidate: characterProfileSchema,
  evidence: z.array(characterProfileEvidenceSchema).max(500),
  unassignedText: z.array(z.string().max(20_000)).max(100),
  conflicts: z.array(z.string().max(4_000)).max(100),
  warnings: z.array(z.string().max(4_000)).max(100),
  protocolVersion: z.string().trim().min(1).max(100)
}).strict();

export const playableCharacterGenerationPreviewRequestSchema = z.object({
  content: worldContentSchema,
  prompt: z.string().trim().min(1).max(20_000),
  characterId: characterId.optional()
}).strict();

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
  storyLengthProfile: storyLengthProfileSchema.default(DEFAULT_STORY_LENGTH_PROFILE),
  turnControlStyle: z.enum(["action_only", "flexible_auto", "flexible_action", "flexible_scene"]).default("flexible_auto")
});

export const campaignUpdateSchema = z.object({
  title: title.optional(),
  status: z.enum(["active", "archived"]).optional(),
  textProviderProfileId: z.uuid().nullable().optional(),
  imageProviderProfileId: z.uuid().nullable().optional(),
  storyLengthProfile: storyLengthProfileSchema.optional(),
  turnControlStyle: z.enum(["action_only", "flexible_auto", "flexible_action", "flexible_scene"]).optional()
}).refine((value) => Object.values(value).some((item) => item !== undefined), "At least one field is required.");

export const campaignWorldMigrationSchema = z.object({
  worldVersionId: z.uuid(),
  note: z.string().trim().max(10_000).default("")
});

export const resourceDeleteSchema = z.object({
  confirmation: z.literal("DELETE"),
  expectedTitle: title
});

export const worldVersionDeleteSchema = z.object({
  confirmation: z.literal("DELETE"),
  expectedVersionNumber: z.coerce.number().int().positive()
});

export type PlayableCharacter = z.infer<typeof playableCharacterSchema>;
export type CharacterProfile = z.infer<typeof characterProfileSchema>;
export type CampaignCharacterProfile = z.infer<typeof campaignCharacterProfileSchema>;
export type CampaignCharacterProfileUpdate = z.infer<typeof campaignCharacterProfileUpdateSchema>;
export type CharacterProfileOrganizationRequest = z.infer<typeof characterProfileOrganizationRequestSchema>;
export type CharacterProfileOrganizationResult = z.infer<typeof characterProfileOrganizationResultSchema>;
export type WorldCreateRequest = z.infer<typeof worldCreateSchema>;
export type WorldGenerationPreviewRequest = z.infer<typeof worldGenerationPreviewRequestSchema>;
export type WorldDraftUpdateRequest = z.infer<typeof worldDraftUpdateSchema>;
export type WorldPublishRequest = z.infer<typeof worldPublishSchema>;
export type PlayableCharacterGenerationRequest = z.infer<typeof playableCharacterGenerationRequestSchema>;
export type PlayableCharacterGenerationPreviewRequest = z.infer<typeof playableCharacterGenerationPreviewRequestSchema>;
export type WorldForkRequest = z.infer<typeof worldForkSchema>;
export type WorldStatusUpdateRequest = z.infer<typeof worldStatusUpdateSchema>;
export type WorldImportRequest = z.infer<typeof worldImportRequestSchema>;
export type CampaignCreateRequest = z.infer<typeof campaignCreateSchema>;
export type CampaignUpdateRequest = z.infer<typeof campaignUpdateSchema>;
export type CampaignWorldMigrationRequest = z.infer<typeof campaignWorldMigrationSchema>;
export type ResourceDeleteRequest = z.infer<typeof resourceDeleteSchema>;
export type WorldVersionDeleteRequest = z.infer<typeof worldVersionDeleteSchema>;
