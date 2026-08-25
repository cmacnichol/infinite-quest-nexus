import { z } from "zod";
import { archiveAssetRecordSchema, archiveErrorCodeSchema, archiveManifestSchema } from "./archives.js";

const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const boundedStringSchema = (maximum: number) => z.string().trim().min(1).max(maximum);
const archiveTimestampSchema = z.iso.datetime({ offset: true });
const identifierSchema = z.string().trim().min(1).max(300);
const shortTextSchema = z.string().trim().max(10_000);
const longTextSchema = z.string().trim().max(1_000_000);

export const SYSTEM_ARCHIVE_DOMAINS = [
  "providers", "prompts", "worlds", "world-versions", "world-drafts",
  "campaigns", "turns", "turn-corrections", "campaign-state",
  "campaign-history", "canonical-facts", "chronicle", "illustrations",
  "imports", "cost-events", "activity-events"
] as const;

export const systemArchiveDomainSchema = z.enum(SYSTEM_ARCHIVE_DOMAINS);
export const systemArchiveJobKindSchema = z.enum(["export", "import"]);
export const systemArchiveJobStatusSchema = z.enum([
  "queued", "capturing", "writing", "verifying", "published",
  "uploading", "validating", "previewed", "revalidating",
  "waiting_for_gate", "importing", "authoritative_committed",
  "rebuilding", "completed", "cancelling", "cancelled",
  "rolled_back", "failed", "expired"
]);

/** Provider imports retain only configuration that can be safely re-entered without a credential. */
export const systemPortableProviderSchema = z.object({
  sourceId: z.string().uuid(),
  kind: z.enum(["text", "image", "embedding"]),
  displayName: boundedStringSchema(200),
  baseUrl: z.url().max(2_000).nullable(),
  selectedModel: boundedStringSchema(300).nullable(),
  contextWindow: nonnegativeSafeIntegerSchema.nullable(),
  timeoutMs: nonnegativeSafeIntegerSchema.nullable(),
  retryLimit: nonnegativeSafeIntegerSchema.nullable(),
  enabled: z.literal(false),
  health: z.literal("unknown")
}).strict();

/** Chronicle records are logical text/state only; vectors and chunk data are rebuilt locally. */
export const systemChronicleRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  kind: z.enum(["memory", "summary-checkpoint"]),
  content: boundedStringSchema(1_000_000),
  occurredAt: archiveTimestampSchema,
  metadata: z.object({
    entityNames: z.array(identifierSchema).max(1_000),
    openThreadIds: z.array(z.string().uuid()).max(1_000).default([])
  }).strict()
}).strict();

const systemPromptRecordSchema = z.object({
  sourceId: z.string().uuid(),
  templateKey: identifierSchema,
  overrideText: longTextSchema,
  updatedAt: archiveTimestampSchema
}).strict();

const systemWorldRecordSchema = z.object({
  sourceId: z.string().uuid(),
  title: identifierSchema,
  status: z.enum(["draft", "active", "archived"]),
  createdAt: archiveTimestampSchema,
  updatedAt: archiveTimestampSchema
}).strict();

const systemWorldVersionRecordSchema = z.object({
  sourceId: z.string().uuid(),
  worldId: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  title: identifierSchema,
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  publishedAt: archiveTimestampSchema
}).strict();

const systemWorldDraftRecordSchema = z.object({
  sourceId: z.string().uuid(),
  worldId: z.string().uuid(),
  title: identifierSchema,
  revision: nonnegativeSafeIntegerSchema,
  updatedAt: archiveTimestampSchema
}).strict();

const systemCampaignRecordSchema = z.object({
  sourceId: z.string().uuid(),
  worldVersionId: z.string().uuid(),
  title: identifierSchema,
  status: z.enum(["active", "archived"]),
  activeTurnNumber: nonnegativeSafeIntegerSchema,
  settings: z.object({
    turnControlStyle: z.enum(["Auto", "Action", "Scene Direction"])
  }).strict(),
  createdAt: archiveTimestampSchema,
  updatedAt: archiveTimestampSchema
}).strict();

const systemTurnRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  turnNumber: z.number().int().positive(),
  action: longTextSchema,
  narration: longTextSchema,
  choices: z.array(shortTextSchema).max(100),
  imagePrompt: longTextSchema,
  acceptedAt: archiveTimestampSchema
}).strict();

const systemTurnCorrectionRecordSchema = z.object({
  sourceId: z.string().uuid(),
  turnId: z.string().uuid(),
  narration: longTextSchema,
  correctedAt: archiveTimestampSchema
}).strict();

const systemCampaignStateRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  trackerLabels: z.array(identifierSchema).max(10_000),
  updatedAt: archiveTimestampSchema
}).strict();

const systemCampaignHistoryRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  eventType: identifierSchema,
  content: longTextSchema,
  occurredAt: archiveTimestampSchema
}).strict();

const systemCanonicalFactRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  subject: shortTextSchema,
  predicate: shortTextSchema,
  object: longTextSchema,
  updatedAt: archiveTimestampSchema
}).strict();

const systemIllustrationRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  turnId: z.string().uuid().nullable(),
  assetId: z.string().uuid(),
  fictionPrompt: longTextSchema,
  selected: z.boolean(),
  createdAt: archiveTimestampSchema
}).strict();

const systemImportRecordSchema = z.object({
  sourceId: z.string().uuid(),
  sourceType: identifierSchema,
  sourceName: shortTextSchema,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  completedAt: archiveTimestampSchema.nullable()
}).strict();

const systemCostEventRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid().nullable(),
  providerKind: z.enum(["text", "image", "embedding"]),
  amountMicros: nonnegativeSafeIntegerSchema,
  occurredAt: archiveTimestampSchema
}).strict();

const systemActivityEventRecordSchema = z.object({
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid().nullable(),
  eventType: identifierSchema,
  summary: shortTextSchema,
  occurredAt: archiveTimestampSchema
}).strict();

const systemRecordEnvelopeBase = {
  formatVersion: z.literal(1),
  sourceId: z.string().uuid()
};

/**
 * The archive stream is deliberately closed by domain. Each projection carries
 * only explicitly portable logical fields; operational and secret-bearing
 * source structures have no representation in this contract.
 */
export const systemRecordEnvelopeSchema = z.discriminatedUnion("domain", [
  z.object({ domain: z.literal("providers"), ...systemRecordEnvelopeBase, record: systemPortableProviderSchema }).strict(),
  z.object({ domain: z.literal("prompts"), ...systemRecordEnvelopeBase, record: systemPromptRecordSchema }).strict(),
  z.object({ domain: z.literal("worlds"), ...systemRecordEnvelopeBase, record: systemWorldRecordSchema }).strict(),
  z.object({ domain: z.literal("world-versions"), ...systemRecordEnvelopeBase, record: systemWorldVersionRecordSchema }).strict(),
  z.object({ domain: z.literal("world-drafts"), ...systemRecordEnvelopeBase, record: systemWorldDraftRecordSchema }).strict(),
  z.object({ domain: z.literal("campaigns"), ...systemRecordEnvelopeBase, record: systemCampaignRecordSchema }).strict(),
  z.object({ domain: z.literal("turns"), ...systemRecordEnvelopeBase, record: systemTurnRecordSchema }).strict(),
  z.object({ domain: z.literal("turn-corrections"), ...systemRecordEnvelopeBase, record: systemTurnCorrectionRecordSchema }).strict(),
  z.object({ domain: z.literal("campaign-state"), ...systemRecordEnvelopeBase, record: systemCampaignStateRecordSchema }).strict(),
  z.object({ domain: z.literal("campaign-history"), ...systemRecordEnvelopeBase, record: systemCampaignHistoryRecordSchema }).strict(),
  z.object({ domain: z.literal("canonical-facts"), ...systemRecordEnvelopeBase, record: systemCanonicalFactRecordSchema }).strict(),
  z.object({ domain: z.literal("chronicle"), ...systemRecordEnvelopeBase, record: systemChronicleRecordSchema }).strict(),
  z.object({ domain: z.literal("illustrations"), ...systemRecordEnvelopeBase, record: systemIllustrationRecordSchema }).strict(),
  z.object({ domain: z.literal("imports"), ...systemRecordEnvelopeBase, record: systemImportRecordSchema }).strict(),
  z.object({ domain: z.literal("cost-events"), ...systemRecordEnvelopeBase, record: systemCostEventRecordSchema }).strict(),
  z.object({ domain: z.literal("activity-events"), ...systemRecordEnvelopeBase, record: systemActivityEventRecordSchema }).strict()
]);

export const systemArchivePayloadSchema = z.object({
  formatVersion: z.literal(1),
  sourceInstallationId: z.string().uuid(),
  sourceOwnerCount: z.literal(1),
  sourceOwner: z.object({
    sourceId: z.string().uuid(),
    displayName: boundedStringSchema(300)
  }).strict(),
  records: z.array(systemRecordEnvelopeSchema)
}).strict();

export const systemArchiveReportSchema = z.object({
  completedAt: z.iso.datetime({ offset: true }),
  archiveFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  recordsByDomain: z.record(systemArchiveDomainSchema, nonnegativeSafeIntegerSchema),
  assetCount: nonnegativeSafeIntegerSchema,
  assetBytes: nonnegativeSafeIntegerSchema,
  omittedOperationalRows: nonnegativeSafeIntegerSchema,
  errors: z.array(archiveErrorCodeSchema)
}).strict();

export const systemArchiveJobViewSchema = z.object({
  id: z.string().uuid(),
  kind: systemArchiveJobKindSchema,
  status: systemArchiveJobStatusSchema,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  report: systemArchiveReportSchema.nullable()
}).strict();

export const systemUploadViewSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["created", "uploading", "completed", "expired", "failed"]),
  byteLength: nonnegativeSafeIntegerSchema,
  receivedBytes: nonnegativeSafeIntegerSchema,
  expiresAt: z.iso.datetime({ offset: true })
}).strict().superRefine((upload, context) => {
  if (upload.receivedBytes > upload.byteLength) {
    context.addIssue({ code: "custom", message: "Upload received bytes cannot exceed its declared byte length." });
  }
});

export const systemImportPreviewViewSchema = z.object({
  valid: z.boolean(),
  sourceOwnerCount: z.literal(1),
  archiveFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  destinationEmpty: z.boolean(),
  warnings: z.array(boundedStringSchema(1_000)),
  errors: z.array(archiveErrorCodeSchema),
  expiresAt: z.iso.datetime({ offset: true })
}).strict();

export const systemArchiveExportRequestSchema = z.object({
  idempotencyKey: boundedStringSchema(200)
}).strict();

export const systemArchiveUploadCreateRequestSchema = z.object({
  byteLength: nonnegativeSafeIntegerSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const systemArchiveImportCommitRequestSchema = z.object({
  previewHandle: boundedStringSchema(200),
  idempotencyKey: boundedStringSchema(200)
}).strict();

export const systemArchiveManifestSchema = archiveManifestSchema.safeExtend({
  archiveType: z.literal("system"),
  sourceOwnerCount: z.literal(1)
}).strict();

export const systemArchiveAssetsPayloadSchema = z.object({
  formatVersion: z.literal(1),
  assets: z.array(archiveAssetRecordSchema)
}).strict();

export type SystemArchiveDomain = z.infer<typeof systemArchiveDomainSchema>;
export type SystemArchiveJobKind = z.infer<typeof systemArchiveJobKindSchema>;
export type SystemArchiveJobStatus = z.infer<typeof systemArchiveJobStatusSchema>;
export type SystemArchiveJobView = z.infer<typeof systemArchiveJobViewSchema>;
export type SystemArchivePayload = z.infer<typeof systemArchivePayloadSchema>;
export type SystemArchiveReport = z.infer<typeof systemArchiveReportSchema>;
export type SystemArchiveUploadView = z.infer<typeof systemUploadViewSchema>;
export type SystemImportPreviewView = z.infer<typeof systemImportPreviewViewSchema>;
export type SystemRecordEnvelope = z.infer<typeof systemRecordEnvelopeSchema>;
