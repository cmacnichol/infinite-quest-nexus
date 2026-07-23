import { z } from "zod";

export const assetOriginSchema = z.enum(["generated", "imported", "uploaded"]);
export const assetReuseScopeSchema = z.enum(["private", "campaign", "world", "owner_library", "shared"]);
export const assetReviewStatusSchema = z.enum(["unreviewed", "eligible", "restricted", "blocked"]);
export const assetSortSchema = z.enum(["newest", "oldest", "title", "most_used"]);
export const assetAspectSchema = z.enum(["portrait", "square", "landscape", "unknown"]);

const optionalBoolean = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return value;
}, z.boolean().optional());

const stringArray = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return [];
  const values = Array.isArray(value) ? value : String(value).split(",");
  return values.map((item) => String(item).trim()).filter(Boolean);
}, z.array(z.string().trim().min(1).max(500)).max(100).default([]));

export const assetListQuerySchema = z.object({
  q: z.string().trim().max(500).default(""),
  scope: z.enum(["all", "campaign", "world", "owner_library", "shared"]).default("all"),
  creator: z.enum(["me"]).optional(),
  worldId: z.uuid().optional(),
  worldVersionId: z.uuid().optional(),
  campaignId: z.uuid().optional(),
  origin: stringArray.pipe(z.array(assetOriginSchema).max(3)),
  tags: stringArray,
  allTags: optionalBoolean.default(false),
  entityIds: stringArray,
  locationIds: stringArray,
  provider: stringArray,
  model: stringArray,
  reviewStatus: stringArray.pipe(z.array(assetReviewStatusSchema).max(4)),
  reuseScope: stringArray.pipe(z.array(assetReuseScopeSchema).max(5)),
  eligible: optionalBoolean,
  favorite: optionalBoolean,
  archived: optionalBoolean.default(false),
  mimeType: stringArray.pipe(z.array(z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"])).max(4)),
  aspect: stringArray.pipe(z.array(assetAspectSchema).max(4)),
  createdFrom: z.iso.datetime({ offset: true }).optional(),
  createdTo: z.iso.datetime({ offset: true }).optional(),
  sort: assetSortSchema.default("newest"),
  cursor: z.string().trim().max(4000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40)
}).strict().superRefine((value, context) => {
  if (value.createdFrom && value.createdTo && value.createdFrom > value.createdTo) {
    context.addIssue({ code: "custom", path: ["createdTo"], message: "createdTo must not be before createdFrom." });
  }
});

export const assetMetadataUpdateSchema = z.object({
  expectedRevision: z.coerce.number().int().min(1),
  title: z.string().trim().max(300).optional(),
  caption: z.string().trim().max(2000).optional(),
  notes: z.string().trim().max(10000).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  reuseScope: assetReuseScopeSchema.optional(),
  automaticReuseEnabled: z.boolean().optional(),
  reviewStatus: assetReviewStatusSchema.optional(),
  contentCategories: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  favorite: z.boolean().optional(),
  archived: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedRevision"), {
  message: "At least one metadata field must be provided."
});

export type AssetListQuery = z.infer<typeof assetListQuerySchema>;
export type AssetMetadataUpdate = z.infer<typeof assetMetadataUpdateSchema>;
export type AssetOrigin = z.infer<typeof assetOriginSchema>;
export type AssetReuseScope = z.infer<typeof assetReuseScopeSchema>;
export type AssetReviewStatus = z.infer<typeof assetReviewStatusSchema>;
