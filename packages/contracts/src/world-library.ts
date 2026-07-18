import { z } from "zod";

const title = z.string().trim().min(1).max(200);
const shortText = z.string().max(2000).default("");
const longText = z.string().max(200_000).default("");

export const worldOverviewSchema = z.object({
  title,
  genre: shortText,
  tone: shortText,
  premise: longText,
  backgroundStory: longText,
  character: longText,
  firstAction: longText,
  rules: longText
}).passthrough();

export const worldContentSchema = z.object({
  schemaVersion: z.number().int().positive().default(2),
  world: worldOverviewSchema,
  entities: z.array(z.unknown()).max(20_000).default([]),
  relationships: z.array(z.unknown()).max(50_000).default([]),
  rpgStats: z.array(z.unknown()).max(10_000).default([]),
  defaultTriggers: z.array(z.unknown()).max(10_000).default([]),
  eventTriggers: z.array(z.unknown()).max(10_000).default([]),
  assets: z.array(z.unknown()).max(10_000).default([]),
  defaults: z.record(z.string(), z.unknown()).default({})
}).passthrough();

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
  title
});

export const campaignUpdateSchema = z.object({
  title: title.optional(),
  status: z.enum(["active", "archived"]).optional()
}).refine((value) => value.title !== undefined || value.status !== undefined, "At least one field is required.");

export const campaignWorldMigrationSchema = z.object({
  worldVersionId: z.uuid(),
  note: z.string().trim().max(10_000).default("")
});

export type WorldContent = z.infer<typeof worldContentSchema>;
export type WorldCreateRequest = z.infer<typeof worldCreateSchema>;
export type WorldDraftUpdateRequest = z.infer<typeof worldDraftUpdateSchema>;
export type WorldPublishRequest = z.infer<typeof worldPublishSchema>;
export type WorldForkRequest = z.infer<typeof worldForkSchema>;
export type WorldStatusUpdateRequest = z.infer<typeof worldStatusUpdateSchema>;
export type WorldImportRequest = z.infer<typeof worldImportRequestSchema>;
export type CampaignCreateRequest = z.infer<typeof campaignCreateSchema>;
export type CampaignUpdateRequest = z.infer<typeof campaignUpdateSchema>;
export type CampaignWorldMigrationRequest = z.infer<typeof campaignWorldMigrationSchema>;
