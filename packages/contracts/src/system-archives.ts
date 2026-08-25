import { z } from "zod";
import { archiveAssetRecordSchema, archiveErrorCodeSchema, archiveManifestSchema } from "./archives.js";

const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const boundedStringSchema = (maximum: number) => z.string().trim().min(1).max(maximum);
const forbiddenPortableRecordKey = /(?:credential|secret|password|api[_-]?key|encryption|nonce|auth(?:entication|orization)?|access[_-]?token|refresh[_-]?token|capability|grant|cookie|private[_-]?key|embedding|vector|chunk|cache|thumbnail|filesystem|storage|(?:file|temp)[_-]?(?:path|dir|directory|location)|(?:^|[_-])(path|directory|location)(?:$|[_-])|job|lease|model[_-]?chain|previous[_-]?response[_-]?id)/i;

function rejectForbiddenPortableRecordKeys(value: unknown, context: z.RefinementCtx, path: PropertyKey[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbiddenPortableRecordKeys(item, context, [...path, index]));
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (forbiddenPortableRecordKey.test(key)) {
      context.addIssue({ code: "custom", path: [...path, key], message: `System Archive records cannot contain ${key}.` });
    } else {
      rejectForbiddenPortableRecordKeys(child, context, [...path, key]);
    }
  }
}

const portableJsonValueSchema = z.json().superRefine(rejectForbiddenPortableRecordKeys);

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
  occurredAt: z.iso.datetime({ offset: true }),
  metadata: z.record(z.string(), portableJsonValueSchema)
}).strict();

const systemPortableAuthorityRecordSchema = z.object({
  sourceId: z.string().uuid(),
  payload: portableJsonValueSchema
}).strict();

const systemRecordEnvelopeBase = {
  formatVersion: z.literal(1),
  sourceId: z.string().uuid()
};

/**
 * The archive stream is deliberately closed by domain. Logical authority may
 * carry JSON payload data, but never operational, capability, secret, vector,
 * chunk, cache, filesystem, job, or model-chain fields.
 */
export const systemRecordEnvelopeSchema = z.discriminatedUnion("domain", [
  z.object({ domain: z.literal("providers"), ...systemRecordEnvelopeBase, record: systemPortableProviderSchema }).strict(),
  z.object({ domain: z.literal("prompts"), ...systemRecordEnvelopeBase, record: systemPortableAuthorityRecordSchema }).strict(),
  z.object({ domain: z.literal("worlds"), ...systemRecordEnvelopeBase, record: systemPortableAuthorityRecordSchema }).strict(),
  z.object({ domain: z.literal("world-versions"), ...systemRecordEnvelopeBase, record: systemPortableAuthorityRecordSchema }).strict(),
  z.object({ domain: z.literal("world-drafts"), ...systemRecordEnvelopeBase, record: systemPortableAuthorityRecordSchema }).strict(),
  z.object({ domain: z.literal("campaigns"), ...systemRecordEnvelopeBase, record: systemPortableAuthorityRecordSchema }).strict(),
  z.object({ domain: z.literal("turns"), ...systemRecordEnvelopeBase, record: systemPortableAuthorityRecordSchema }).strict(),
  z.object({ domain: z.literal("turn-corrections"), ...systemRecordEnvelopeBase, record: systemPortableAuthorityRecordSchema }).strict(),
  z.object({ domain: z.literal("campaign-state"), ...systemRecordEnvelopeBase, record: systemPortableAuthorityRecordSchema }).strict(),
  z.object({ domain: z.literal("campaign-history"), ...systemRecordEnvelopeBase, record: systemPortableAuthorityRecordSchema }).strict(),
  z.object({ domain: z.literal("canonical-facts"), ...systemRecordEnvelopeBase, record: systemPortableAuthorityRecordSchema }).strict(),
  z.object({ domain: z.literal("chronicle"), ...systemRecordEnvelopeBase, record: systemChronicleRecordSchema }).strict(),
  z.object({ domain: z.literal("illustrations"), ...systemRecordEnvelopeBase, record: systemPortableAuthorityRecordSchema }).strict(),
  z.object({ domain: z.literal("imports"), ...systemRecordEnvelopeBase, record: systemPortableAuthorityRecordSchema }).strict(),
  z.object({ domain: z.literal("cost-events"), ...systemRecordEnvelopeBase, record: systemPortableAuthorityRecordSchema }).strict(),
  z.object({ domain: z.literal("activity-events"), ...systemRecordEnvelopeBase, record: systemPortableAuthorityRecordSchema }).strict()
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
