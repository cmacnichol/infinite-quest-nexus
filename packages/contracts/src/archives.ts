import { z } from "zod";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;
const requiredCampaignPayloads = ["campaign.json", "world.json", "chronicle.json", "assets/assets.json"] as const;

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedArchivePath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function validatePortableArchivePath(path: string, context: z.RefinementCtx): void {
  if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    context.addIssue({ code: "custom", message: "Archive paths must be portable relative paths." });
    return;
  }

  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    context.addIssue({ code: "custom", message: "Archive paths cannot contain empty, current, or parent segments." });
  }
}

function isExcludedMetadataKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase("en-US");
  return /(?:credential|secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|auth[_-]?header|cookie|private[_-]?key)/.test(normalized)
    || /(?:provider|temporary|temp|signed|presigned|upload|download).*(?:url|uri|endpoint)/.test(normalized)
    || normalized === "artifacturl"
    || /(?:local|cache|storage|file|temp).*(?:path|dir|directory|location)/.test(normalized)
    || /(?:embedding|thumbnail|raw.*provider.*response|provider.*response|private.*reasoning|reasoning.*private)/.test(normalized)
    || /(?:response|chain|lease|job|remote)/.test(normalized);
}

function isPortableMetadataValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPortableMetadataValue);
  return isPlainRecord(value) && Object.values(value).every(isPortableMetadataValue);
}

function canonicalizeArchiveValue(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    const source = parentKey === "tags" || parentKey === "contentCategories"
      ? [...new Set(value)].sort((left, right) => String(left).localeCompare(String(right), "en-US"))
      : value;
    return source.map((item) => canonicalizeArchiveValue(item));
  }

  if (isPlainRecord(value)) {
    const result: PlainRecord = {};
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, "en-US"))) {
      const child = value[key];
      if (child !== undefined) result[key] = canonicalizeArchiveValue(child, key);
    }
    return result;
  }

  return value;
}

const boundedString = (maximum: number) => z.string().max(maximum);
const boundedStringArray = (maximum: number) => z.array(boundedString(maximum)).max(100);
const nonnegativeSafeInteger = z.number().int().min(0).max(MAX_SAFE_INTEGER);
const positiveSafeInteger = z.number().int().min(1).max(MAX_SAFE_INTEGER);

export const archiveTypeSchema = z.enum(["campaign", "system"]);
export const archiveSha256Schema = z.string().regex(SHA_256_PATTERN);
export const archivePathSchema = z.string().superRefine(validatePortableArchivePath);

export const archiveEntrySchema = z.object({
  path: archivePathSchema,
  logicalType: z.string().trim().min(1).max(100),
  mediaType: z.string().trim().min(1).max(200),
  byteLength: nonnegativeSafeInteger,
  sha256: archiveSha256Schema
}).strict();

export const archivePayloadSchema = z.object({
  kind: z.enum(["campaign", "world", "chronicle", "assets", "system", "records"]),
  path: archivePathSchema,
  formatVersion: positiveSafeInteger
}).strict();

export const archiveAssetBindingSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("world_cover"), worldId: z.uuid() }).strict(),
  z.object({ role: z.literal("world_version_asset"), worldId: z.uuid(), worldVersionId: z.uuid() }).strict(),
  z.object({ role: z.literal("campaign_asset"), campaignId: z.uuid() }).strict(),
  z.object({ role: z.literal("turn_illustration"), campaignId: z.uuid(), turnId: z.uuid() }).strict(),
  z.object({
    role: z.literal("illustration_segment_variant"),
    campaignId: z.uuid(),
    turnId: z.uuid(),
    segmentId: z.uuid(),
    variantIndex: nonnegativeSafeInteger
  }).strict(),
  z.object({ role: z.literal("imported_attachment"), campaignId: z.uuid(), turnId: z.uuid().nullable() }).strict(),
  z.object({
    role: z.literal("generation_context"),
    campaignId: z.uuid().nullable(),
    worldId: z.uuid().nullable(),
    worldVersionId: z.uuid().nullable(),
    turnId: z.uuid().nullable(),
    sourceContextId: z.uuid()
  }).strict()
]);

const portableTechnicalMetadataSchema = z.preprocess(
  (value) => {
    const sanitized = sanitizePortableMetadata(value);
    return isPlainRecord(sanitized) ? sanitized : undefined;
  },
  z.record(z.string(), z.unknown()).refine(
    (value) => isPlainRecord(value) && Object.values(value).every(isPortableMetadataValue),
    "Technical metadata must be a plain JSON record."
  )
);

export const archiveAssetRecordSchema = z.object({
  sourceAssetId: z.uuid(),
  contentHash: archiveSha256Schema,
  archivePath: archivePathSchema,
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  byteLength: nonnegativeSafeInteger,
  pixelWidth: positiveSafeInteger,
  pixelHeight: positiveSafeInteger,
  technicalMetadata: portableTechnicalMetadataSchema,
  library: z.object({
    title: boundedString(300),
    caption: boundedString(2_000),
    notes: boundedString(10_000),
    tags: boundedStringArray(100),
    origin: z.enum(["generated", "imported", "uploaded"]),
    reviewStatus: z.enum(["unreviewed", "eligible", "restricted", "blocked"]),
    reuseScope: z.enum(["private", "campaign", "world", "owner_library", "shared"]),
    automaticReuseEnabled: z.boolean(),
    contentCategories: boundedStringArray(100),
    favorite: z.boolean(),
    archivedAt: z.iso.datetime({ offset: true }).nullable()
  }).strict(),
  createdAt: z.iso.datetime({ offset: true }),
  bindings: z.array(archiveAssetBindingSchema)
}).strict();

export const archiveManifestSchema = z.object({
  format: z.literal("infinite-quest-archive"),
  formatVersion: z.literal(1),
  archiveType: archiveTypeSchema,
  createdAt: z.iso.datetime({ offset: true }),
  contentFingerprint: archiveSha256Schema,
  campaignId: z.uuid().optional(),
  worldId: z.uuid().optional(),
  worldVersionId: z.uuid().optional(),
  entries: z.array(archiveEntrySchema),
  payloads: z.array(archivePayloadSchema),
  assets: z.array(archiveAssetRecordSchema)
}).strict().superRefine((manifest, context) => {
  const paths = new Set<string>();
  for (const [index, entry] of manifest.entries.entries()) {
    const normalizedPath = normalizedArchivePath(entry.path);
    if (normalizedPath === "manifest.json") {
      context.addIssue({ code: "custom", path: ["entries", index, "path"], message: "manifest.json is not an archive entry." });
    }
    if (paths.has(normalizedPath)) {
      context.addIssue({ code: "custom", path: ["entries", index, "path"], message: "Archive entry paths must be unique after normalization." });
    }
    paths.add(normalizedPath);
  }

  for (const [index, payload] of manifest.payloads.entries()) {
    if (!paths.has(normalizedArchivePath(payload.path))) {
      context.addIssue({ code: "custom", path: ["payloads", index, "path"], message: "Every payload must be declared in entries." });
    }
  }

  const sourceAssetIds = new Set<string>();
  const assetsByPath = new Map<string, { index: number; asset: ArchiveAssetRecord }>();
  const archivePathsByHash = new Map<string, { index: number; path: string }>();
  for (const [index, asset] of manifest.assets.entries()) {
    const sourceAssetId = asset.sourceAssetId.toLocaleLowerCase("en-US");
    if (sourceAssetIds.has(sourceAssetId)) {
      context.addIssue({ code: "custom", path: ["assets", index, "sourceAssetId"], message: "Archive asset source identifiers must be unique." });
    }
    sourceAssetIds.add(sourceAssetId);

    const normalizedPath = normalizedArchivePath(asset.archivePath);
    const existingAtPath = assetsByPath.get(normalizedPath);
    if (existingAtPath && (
      existingAtPath.asset.archivePath !== asset.archivePath
      || existingAtPath.asset.contentHash !== asset.contentHash
      || existingAtPath.asset.byteLength !== asset.byteLength
      || existingAtPath.asset.mimeType !== asset.mimeType
      || existingAtPath.asset.pixelWidth !== asset.pixelWidth
      || existingAtPath.asset.pixelHeight !== asset.pixelHeight
    )) {
      context.addIssue({ code: "custom", path: ["assets", index, "archivePath"], message: "Archive assets sharing a normalized path must have identical original metadata." });
    } else if (!existingAtPath) {
      assetsByPath.set(normalizedPath, { index, asset });
    }

    const existingPathForHash = archivePathsByHash.get(asset.contentHash);
    if (existingPathForHash && existingPathForHash.path !== asset.archivePath) {
      context.addIssue({ code: "custom", path: ["assets", index, "contentHash"], message: "Each archive asset content hash must map to exactly one archive path." });
    } else if (!existingPathForHash) {
      archivePathsByHash.set(asset.contentHash, { index, path: asset.archivePath });
    }

    if (!paths.has(normalizedArchivePath(asset.archivePath))) {
      context.addIssue({ code: "custom", path: ["assets", index, "archivePath"], message: "Every asset must be declared in entries." });
    }
    if (manifest.archiveType === "system" && asset.bindings.length === 0 && asset.library.reuseScope !== "owner_library") {
      context.addIssue({ code: "custom", path: ["assets", index, "library", "reuseScope"], message: "Unbound System Archive assets must be owner-library assets." });
    }
  }

  if (manifest.archiveType === "campaign") {
    if (!manifest.campaignId || !manifest.worldId || !manifest.worldVersionId) {
      context.addIssue({ code: "custom", message: "Campaign manifests require campaign, world, and world version identifiers." });
    }

    const payloadPaths = manifest.payloads.map((payload) => normalizedArchivePath(payload.path)).sort();
    const expectedPaths = [...requiredCampaignPayloads].sort();
    if (payloadPaths.length !== expectedPaths.length || payloadPaths.some((path, index) => path !== expectedPaths[index])) {
      context.addIssue({ code: "custom", path: ["payloads"], message: "Campaign manifests require exactly the version-one campaign payload set." });
    }

    for (const [assetIndex, asset] of manifest.assets.entries()) {
      if (asset.bindings.length === 0) {
        context.addIssue({ code: "custom", path: ["assets", assetIndex, "bindings"], message: "Campaign archive assets require at least one binding." });
      }
      for (const [bindingIndex, binding] of asset.bindings.entries()) {
        const path = ["assets", assetIndex, "bindings", bindingIndex];
        if ("campaignId" in binding && binding.campaignId !== null && binding.campaignId !== manifest.campaignId) {
          context.addIssue({ code: "custom", path, message: "Asset campaign bindings must remain within the manifest campaign scope." });
        }
        if ("worldId" in binding && binding.worldId !== null && binding.worldId !== manifest.worldId) {
          context.addIssue({ code: "custom", path, message: "Asset world bindings must remain within the manifest world scope." });
        }
        if ("worldVersionId" in binding && binding.worldVersionId !== null && binding.worldVersionId !== manifest.worldVersionId) {
          context.addIssue({ code: "custom", path, message: "Asset world-version bindings must remain within the manifest world-version scope." });
        }
      }
    }
  }
});

export function sanitizePortableMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizePortableMetadata(item));
  if (!isPlainRecord(value)) return value;

  const sanitized: PlainRecord = {};
  for (const [key, child] of Object.entries(value)) {
    if (!isExcludedMetadataKey(key)) sanitized[key] = sanitizePortableMetadata(child);
  }
  return sanitized;
}

export function canonicalArchiveJson(value: unknown): string {
  const json = JSON.stringify(canonicalizeArchiveValue(value));
  if (json === undefined) throw new TypeError("Archive values must be JSON-serializable.");
  return json;
}

export const campaignArchiveDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("embedded") }).strict(),
  z.object({ kind: z.literal("existing_world_version"), worldVersionId: z.uuid() }).strict()
]);

export const campaignArchiveCommitRequestSchema = z.object({
  previewToken: z.string().min(40).max(200),
  destination: campaignArchiveDestinationSchema
}).strict();

const embeddedPreviewDestinationSchema = z.object({
  kind: z.literal("embedded"),
  operation: z.enum(["create_world", "reuse_world_version"]),
  worldId: z.uuid().nullable(),
  worldVersionId: z.uuid().nullable()
}).strict().superRefine((destination, context) => {
  const identifiersAreBothPresent = destination.worldId !== null && destination.worldVersionId !== null;
  const identifiersAreBothAbsent = destination.worldId === null && destination.worldVersionId === null;
  if ((destination.operation === "create_world" && !identifiersAreBothAbsent)
    || (destination.operation === "reuse_world_version" && !identifiersAreBothPresent)) {
    context.addIssue({ code: "custom", message: "Embedded destinations must match their declared operation." });
  }
});

const campaignArchivePreviewDestinationSchema = z.discriminatedUnion("kind", [
  embeddedPreviewDestinationSchema,
  z.object({
    kind: z.literal("existing_world_version"),
    operation: z.literal("attach_existing_world_version"),
    worldId: z.uuid(),
    worldVersionId: z.uuid()
  }).strict()
]);

export const campaignArchivePreviewResponseSchema = z.object({
  valid: z.literal(true),
  archiveType: z.literal("campaign"),
  formatVersion: z.literal(1),
  contentFingerprint: archiveSha256Schema,
  campaign: z.object({
    title: z.string().trim().min(1).max(200),
    sourceCampaignId: z.uuid(),
    acceptedTurnCount: nonnegativeSafeInteger,
    activeTurnNumber: nonnegativeSafeInteger,
    selectedCharacter: z.object({
      id: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1).max(300)
    }).strict().nullable()
  }).strict(),
  world: z.object({
    title: z.string().trim().min(1).max(200),
    sourceWorldId: z.uuid(),
    sourceWorldVersionId: z.uuid(),
    versionNumber: positiveSafeInteger
  }).strict(),
  chronicle: z.object({ memoryCount: nonnegativeSafeInteger, summaryCount: nonnegativeSafeInteger }).strict(),
  assets: z.object({ originalCount: nonnegativeSafeInteger, totalBytes: nonnegativeSafeInteger }).strict(),
  destination: campaignArchivePreviewDestinationSchema,
  providerDataIncluded: z.literal(false),
  warnings: boundedStringArray(1_000),
  previewToken: z.string().min(40).max(200),
  expiresAt: z.iso.datetime({ offset: true })
}).strict().superRefine((preview, context) => {
  if (preview.campaign.activeTurnNumber > preview.campaign.acceptedTurnCount) {
    context.addIssue({ code: "custom", path: ["campaign", "activeTurnNumber"], message: "Active turn number cannot exceed accepted turns." });
  }
});

export const archiveErrorCodeSchema = z.enum([
  "archive-format-unrecognized",
  "archive-version-unsupported",
  "archive-entry-unsafe",
  "archive-entry-duplicate",
  "archive-limit-exceeded",
  "archive-checksum-mismatch",
  "archive-entry-missing",
  "archive-json-invalid",
  "archive-asset-invalid",
  "archive-asset-missing",
  "archive-world-mismatch",
  "archive-owner-count-unsupported",
  "archive-destination-not-empty",
  "archive-preview-stale",
  "archive-storage-insufficient",
  "system-import-in-progress",
  "archive-import-conflict",
  "archive-export-inconsistent"
]);

export type ArchiveAssetBinding = z.infer<typeof archiveAssetBindingSchema>;
export type ArchiveAssetRecord = z.infer<typeof archiveAssetRecordSchema>;
export type ArchiveEntry = z.infer<typeof archiveEntrySchema>;
export type ArchiveErrorCode = z.infer<typeof archiveErrorCodeSchema>;
export type ArchiveManifest = z.infer<typeof archiveManifestSchema>;
export type ArchivePayload = z.infer<typeof archivePayloadSchema>;
export type ArchiveType = z.infer<typeof archiveTypeSchema>;
export type CampaignArchiveCommitRequest = z.infer<typeof campaignArchiveCommitRequestSchema>;
export type CampaignArchiveDestination = z.infer<typeof campaignArchiveDestinationSchema>;
export type CampaignArchivePreviewResponse = z.infer<typeof campaignArchivePreviewResponseSchema>;
