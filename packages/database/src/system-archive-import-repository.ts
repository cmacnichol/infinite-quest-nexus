import { createHash, randomBytes } from "node:crypto";
import {
  SYSTEM_ARCHIVE_DOMAINS,
  canonicalArchiveJson,
  systemArchiveImportReportSchema,
  systemRecordEnvelopeSchema,
  systemImportPreviewViewSchema,
  type ArchiveAssetRecord,
  type SystemArchiveDomain,
  type SystemArchiveImportReport,
  type SystemImportPreviewView,
  type SystemRecordEnvelope
} from "@infinite-quest/contracts";
import type { OwnerScope } from "../../application/src/generation/types.js";
import type {
  PrivateAssetPublicationCommand,
  PrivateAssetPublicationIdentity
} from "../../application/src/assets/private-asset-publication.js";
import { SYSTEM_ARCHIVE_TABLE_CLASSIFICATIONS } from "../../application/src/system-archives/portability-registry.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";

export type SystemImportDestinationFingerprint = Readonly<{
  initialOwnerId: string;
  latestMigration: string;
  authoritativeCountsHash: string;
  activeJobsHash: string;
  checkedAt: string;
  destinationEmpty: boolean;
}>;

export type SystemArchiveDestinationFingerprintRequest = Readonly<{
  ignoreUploadId?: string;
  ignoreJobId?: string;
}>;

export type SystemArchivePreviewAuthority = Readonly<{
  jobId: string;
  previewHandle: string;
  expiresAt: string;
}>;

export type CreateSystemArchivePreviewRequest = Readonly<{
  uploadId: string;
  archiveFingerprint: string;
  destination: SystemImportDestinationFingerprint;
  projection: Readonly<Record<string, unknown>>;
}>;

export const SYSTEM_IMPORT_LOCK_KEY = "infinitequest:system-import:v1";

export type SystemArchiveAtomicImportRequest = Readonly<{
  destination: SystemImportDestinationFingerprint;
  ignore: SystemArchiveDestinationFingerprintRequest;
  jobId?: string;
  leaseOwner?: string;
}>;

export type SystemArchiveImportJobAuthority = Readonly<{
  jobId: string;
  stagedInputId: string;
  uploadId: string;
  archiveFingerprint: string;
  destination: SystemImportDestinationFingerprint;
  status: "revalidating" | "importing" | "authoritative_committed" | "rebuilding";
  report: Readonly<Record<string, unknown>> | null;
  rebuildCampaignIds: readonly string[];
  rebuildAssetIds: readonly string[];
}>;

export type SystemArchiveImportResult = Readonly<{
  recordsByDomain: Readonly<Record<SystemArchiveDomain, number>>;
  campaignIds: readonly string[];
  assetIds: readonly string[];
}>;

export interface SystemArchiveAtomicImportTransaction {
  /** The caller-owned transaction is also the only valid asset attachment context. */
  readonly database: DatabaseClient;
  insertLogicalDomains(
    records: Iterable<SystemRecordEnvelope> | AsyncIterable<SystemRecordEnvelope>
  ): Promise<SystemArchiveImportResult>;
  insertOriginalAsset(
    asset: ArchiveAssetRecord,
    persistence: Readonly<{
      filesystemOperationId: string;
      storagePath: string;
    }>
  ): Promise<void>;
  insertAssetBindings(asset: ArchiveAssetRecord): Promise<void>;
  recordImportReport(report: SystemArchiveImportReport): Promise<void>;
}

export interface SystemArchiveImportRepository {
  destinationFingerprint(
    owner: OwnerScope,
    request: SystemArchiveDestinationFingerprintRequest
  ): Promise<SystemImportDestinationFingerprint>;
  createPreview(
    owner: OwnerScope,
    request: CreateSystemArchivePreviewRequest
  ): Promise<SystemArchivePreviewAuthority>;
  consumePreviewAuthority(
    owner: OwnerScope,
    previewHandle: string,
    idempotencyKey: string
  ): Promise<Readonly<{
    jobId: string;
    stagedInputId: string;
    uploadId: string;
    archiveFingerprint: string;
    destination: SystemImportDestinationFingerprint;
  }>>;
  loadImportJobAuthority(
    owner: OwnerScope,
    jobId: string,
    stagedInputId: string
  ): Promise<SystemArchiveImportJobAuthority>;
  withAtomicImport<Result>(
    owner: OwnerScope,
    request: SystemArchiveAtomicImportRequest,
    work: (transaction: SystemArchiveAtomicImportTransaction) => Promise<Result>
  ): Promise<Result>;
  enqueueDerivedRebuilds(
    owner: OwnerScope,
    request: Readonly<{ campaignIds: readonly string[]; assetIds: readonly string[] }>
  ): Promise<void>;
  reserveOriginalAssetIdentity(
    owner: OwnerScope,
    assetId: string,
    command: PrivateAssetPublicationCommand
  ): Promise<PrivateAssetPublicationIdentity>;
  markImportedJobRebuilding(owner: OwnerScope, jobId: string, leaseOwner: string): Promise<void>;
  completeImportedJob(owner: OwnerScope, jobId: string, leaseOwner: string): Promise<void>;
}

type SystemArchiveImportRepositoryOptions = Readonly<{
  previewTtlSeconds: number;
}>;

const AUTHORITY_TABLES = Object.entries(SYSTEM_ARCHIVE_TABLE_CLASSIFICATIONS)
  .filter(([, classification]) => classification === "portable_authority"
    || classification === "portable_normalized"
    || classification === "security_authority")
  .map(([table]) => table)
  .filter((table) => table !== "users")
  .sort();

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalArchiveJson(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(",")}}`;
}

function publicationFingerprint(command: PrivateAssetPublicationCommand): string {
  return createHash("sha256").update(stableStringify({
    ownerUserId: command.owner.ownerUserId,
    original: {
      mimeType: command.original.mimeType,
      byteLength: command.original.byteLength,
      contentHash: command.original.contentHash
    },
    derivatives: command.derivatives.map((derivative) => ({
      derivativeKind: derivative.derivativeKind,
      transformVersion: derivative.transformVersion,
      pixelWidth: derivative.pixelWidth,
      pixelHeight: derivative.pixelHeight,
      mimeType: derivative.mimeType,
      byteLength: derivative.byteLength,
      contentHash: derivative.contentHash
    })),
    provenance: {
      campaignId: command.provenance.campaignId ?? null,
      origin: command.provenance.origin,
      targetType: command.provenance.targetType ?? "other",
      turnId: command.provenance.turnId ?? null,
      worldId: command.provenance.worldId ?? null,
      worldVersionId: command.provenance.worldVersionId ?? null
    }
  })).digest("hex");
}

function repositoryError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function requireHash(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw repositoryError(`${name} is invalid.`, 400);
}

type SystemImportPreviewProjection = Omit<
  SystemImportPreviewView,
  "valid" | "previewHandle" | "expiresAt"
>;

function validatePreviewProjection(
  owner: OwnerScope,
  request: CreateSystemArchivePreviewRequest
): SystemImportPreviewProjection {
  const parsed = systemImportPreviewViewSchema.safeParse({
    ...request.projection,
    valid: true,
    previewHandle: "preview-validation-placeholder",
    expiresAt: "1970-01-01T00:00:00.000Z"
  });
  if (!parsed.success) throw repositoryError("System Archive preview projection is invalid.", 400);
  const {
    valid: _valid,
    previewHandle: _previewHandle,
    expiresAt: _expiresAt,
    ...projection
  } = parsed.data;
  if (projection.archiveFingerprint !== request.archiveFingerprint
    || projection.destinationEmpty !== request.destination.destinationEmpty
    || projection.ownerMapping.destinationOwnerId !== owner.ownerUserId
    || projection.ownerMapping.destinationOwnerId !== request.destination.initialOwnerId
    || projection.versions.destinationMigration !== request.destination.latestMigration) {
    throw repositoryError("System Archive preview projection does not match its authority binding.", 400);
  }
  return Object.freeze(projection);
}

function parsePersistedPreviewProjection(value: unknown): SystemImportPreviewProjection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("System Archive preview projection is malformed.");
  }
  const parsed = systemImportPreviewViewSchema.safeParse({
    ...value,
    valid: true,
    previewHandle: "persisted-preview-projection",
    expiresAt: "2099-01-01T00:00:00.000Z"
  });
  if (!parsed.success) throw new Error("System Archive preview projection is malformed.");
  const {
    valid: _valid,
    previewHandle: _previewHandle,
    expiresAt: _expiresAt,
    ...projection
  } = parsed.data;
  return Object.freeze(projection);
}

function requireTtl(value: number): void {
  if (value !== 1_800) {
    throw new Error("system_archive_preview_ttl_invalid");
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error("system_archive_table_identifier_invalid");
  return `"${value}"`;
}

type Queryable = Pick<DatabasePool | DatabaseClient, "query">;

async function authorityCounts(database: Queryable): Promise<Record<string, number>> {
  const clauses = AUTHORITY_TABLES.map((table) =>
    `(SELECT count(*)::bigint FROM ${quoteIdentifier(table)}) AS ${quoteIdentifier(table)}`
  );
  const selected = await database.query<Record<string, string | number>>(`SELECT ${clauses.join(",")}`);
  const row = selected.rows[0] ?? {};
  return Object.fromEntries(AUTHORITY_TABLES.map((table) => [table, Number(row[table] ?? 0)]));
}

async function activeWorkCounts(
  database: Queryable,
  request: SystemArchiveDestinationFingerprintRequest
): Promise<Record<string, number>> {
  const selected = await database.query<Record<string, string | number>>(
    `SELECT
       (SELECT count(*) FROM generation_jobs WHERE status IN (
         'queued','replacement_queued','assessing','generating','validating','committing','recoverable'
       )) AS generation_jobs,
       (SELECT count(*) FROM image_jobs WHERE status IN (
         'queued','generating','provider_pending','downloading','recoverable'
       )) AS image_jobs,
       (SELECT count(*) FROM illustration_prompt_jobs WHERE status IN (
         'provisional','queued','refining','recoverable'
       )) AS illustration_prompt_jobs,
       (SELECT count(*) FROM illustration_resolution_jobs WHERE status IN (
         'queued','matching','generation_queued','recoverable'
       )) AS illustration_resolution_jobs,
       (SELECT count(*) FROM illustration_backfill_jobs WHERE status IN ('queued','running'))
         AS illustration_backfill_jobs,
       (SELECT count(*) FROM chronicle_jobs WHERE status IN ('queued','running')) AS chronicle_jobs,
       (SELECT count(*) FROM chronicle_chunk_jobs WHERE status IN ('queued','running')) AS chronicle_chunk_jobs,
       (SELECT count(*) FROM world_generation_progress
         WHERE status='processing' AND expires_at > clock_timestamp()) AS world_generation_progress,
       (SELECT count(*) FROM asset_metadata_backfill_jobs WHERE status IN ('queued','running','recoverable'))
         AS asset_metadata_backfill_jobs,
       (SELECT count(*) FROM asset_mutation_idempotency WHERE status='pending')
         AS asset_mutation_idempotency,
       (SELECT count(*) FROM asset_publication_requests
         WHERE lifecycle IN ('prepared','attached','cleanup_pending')) AS asset_publication_requests,
       (SELECT count(*) FROM portable_import_operations
         WHERE status IN ('consuming','cleanup_pending')
            OR (status='previewed' AND expires_at > clock_timestamp())) AS portable_import_operations,
       (SELECT count(*) FROM portable_import_work
         WHERE status IN ('running','recoverable') AND expires_at > clock_timestamp()) AS portable_import_work,
       (SELECT count(*) FROM archive_previews
         WHERE status='previewed' AND expires_at > clock_timestamp()) AS archive_previews,
       (SELECT count(*) FROM system_archive_uploads
         WHERE status IN ('created','uploading','completed') AND expires_at > clock_timestamp()
           AND ($1::uuid IS NULL OR id <> $1::uuid)) AS system_archive_uploads,
       (SELECT count(*) FROM system_archive_jobs
         WHERE (
           status IN (
             'queued','capturing','writing','verifying','uploading','validating',
             'revalidating','waiting_for_gate','importing','authoritative_committed','rebuilding','cancelling'
           ) OR (
             status='previewed'
             AND (progress->>'expiresAt' IS NULL
               OR (progress->>'expiresAt')::timestamptz > clock_timestamp())
           )
         ) AND ($2::uuid IS NULL OR id <> $2::uuid)) AS system_archive_jobs`,
    [request.ignoreUploadId ?? null, request.ignoreJobId ?? null]
  );
  const row = selected.rows[0] ?? {};
  return Object.freeze(Object.fromEntries(Object.entries(row).map(([name, count]) => [name, Number(count)])));
}

async function fingerprint(
  database: Queryable,
  owner: OwnerScope,
  request: SystemArchiveDestinationFingerprintRequest
): Promise<SystemImportDestinationFingerprint> {
  // Keep these sequential: DatabaseClient represents one PostgreSQL protocol
  // stream, and concurrent client.query calls are deprecated by node-postgres.
  const clock = await database.query<{ checked_at: Date }>("SELECT clock_timestamp() AS checked_at");
  const migration = await database.query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY run_on DESC,name DESC LIMIT 1"
  );
  const initialOwner = await database.query<{ id: string }>(
    "SELECT id FROM users WHERE system_key='initial-owner' AND status='active'"
  );
  const users = await database.query<{ count: string }>("SELECT count(*)::bigint AS count FROM users");
  const counts = await authorityCounts(database);
  const activeWork = await activeWorkCounts(database, request);
  const initialOwnerId = initialOwner.rows[0]?.id;
  if (!initialOwnerId) throw repositoryError("Destination initial owner is unavailable.", 409);
  const userCount = Number(users.rows[0]?.count ?? 0);
  const authorityPayload = Object.freeze({ users: userCount, ...counts });
  const authoritativeRows = Object.values(counts).reduce((total, count) => total + count, 0);
  const activeRows = Object.values(activeWork).reduce((total, count) => total + count, 0);
  return Object.freeze({
    initialOwnerId,
    latestMigration: migration.rows[0]?.name ?? "unmigrated",
    authoritativeCountsHash: hash(authorityPayload),
    activeJobsHash: hash(activeWork),
    checkedAt: clock.rows[0]!.checked_at.toISOString(),
    destinationEmpty: owner.ownerUserId === initialOwnerId
      && userCount === 1
      && authoritativeRows === 0
      && activeRows === 0
  });
}

function sameFingerprint(
  expected: SystemImportDestinationFingerprint,
  actual: SystemImportDestinationFingerprint
): boolean {
  return expected.initialOwnerId === actual.initialOwnerId
    && expected.latestMigration === actual.latestMigration
    && expected.authoritativeCountsHash === actual.authoritativeCountsHash
    && expected.activeJobsHash === actual.activeJobsHash
    && expected.destinationEmpty === actual.destinationEmpty;
}

function parsePersistedDestinationFingerprint(value: unknown): SystemImportDestinationFingerprint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("System Archive import authority is malformed.");
  }
  const candidate = value as Partial<Record<keyof SystemImportDestinationFingerprint, unknown>>;
  if (typeof candidate.initialOwnerId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate.initialOwnerId)
    || typeof candidate.latestMigration !== "string"
    || !(/^[0-9]{4}_[a-z0-9_]+$/u.test(candidate.latestMigration)
      || candidate.latestMigration === "unmigrated")
    || typeof candidate.authoritativeCountsHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(candidate.authoritativeCountsHash)
    || typeof candidate.activeJobsHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(candidate.activeJobsHash)
    || typeof candidate.checkedAt !== "string"
    || !Number.isFinite(Date.parse(candidate.checkedAt))
    || typeof candidate.destinationEmpty !== "boolean") {
    throw new Error("System Archive import authority is malformed.");
  }
  return Object.freeze({
    initialOwnerId: candidate.initialOwnerId,
    latestMigration: candidate.latestMigration,
    authoritativeCountsHash: candidate.authoritativeCountsHash,
    activeJobsHash: candidate.activeJobsHash,
    checkedAt: candidate.checkedAt,
    destinationEmpty: candidate.destinationEmpty
  });
}

function parsePersistedUuidList(value: unknown, required: boolean): readonly string[] {
  if (value === undefined && !required) return Object.freeze([]);
  if (!Array.isArray(value)
    || value.some((entry) => typeof entry !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(entry))
    || new Set(value).size !== value.length) {
    throw new Error("System Archive import authority is malformed.");
  }
  return Object.freeze([...value]) as readonly string[];
}

function parseImportJobAuthority(row: Readonly<{
  id: string;
  staged_input_id: string;
  upload_id: string;
  status: SystemArchiveImportJobAuthority["status"];
  progress: unknown;
  report: unknown;
}>): SystemArchiveImportJobAuthority {
  const progress = row.progress as Partial<{
    archiveFingerprint: unknown;
    destinationFingerprint: unknown;
    rebuildCampaignIds: unknown;
    rebuildAssetIds: unknown;
  }>;
  if (typeof progress?.archiveFingerprint !== "string"
    || !/^[0-9a-f]{64}$/u.test(progress.archiveFingerprint)) {
    throw new Error("System Archive import authority is malformed.");
  }
  const committed = row.status === "authoritative_committed" || row.status === "rebuilding";
  const parsedReport = row.report === null ? null : systemArchiveImportReportSchema.safeParse(row.report);
  if ((parsedReport !== null && !parsedReport.success)
    || (committed && parsedReport === null)
    || (!committed && parsedReport !== null)) {
    throw new Error("System Archive import authority is malformed.");
  }
  return Object.freeze({
    jobId: row.id,
    stagedInputId: row.staged_input_id,
    uploadId: row.upload_id,
    archiveFingerprint: progress.archiveFingerprint,
    destination: parsePersistedDestinationFingerprint(progress.destinationFingerprint),
    status: row.status,
    report: parsedReport?.success ? parsedReport.data : null,
    rebuildCampaignIds: parsePersistedUuidList(progress.rebuildCampaignIds, committed),
    rebuildAssetIds: parsePersistedUuidList(progress.rebuildAssetIds, committed)
  });
}

function emptyDomainCounts(): Record<SystemArchiveDomain, number> {
  return Object.fromEntries(SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0])) as Record<
    SystemArchiveDomain,
    number
  >;
}

function turnControlStyle(value: "Auto" | "Action" | "Scene Direction"): string {
  if (value === "Auto") return "flexible_auto";
  if (value === "Scene Direction") return "flexible_scene";
  return "flexible_action";
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

type HistoryContent = Readonly<Record<string, unknown>>;

function invalidHistory(eventType: string, field?: string): never {
  throw repositoryError(
    `System Archive campaign history ${eventType}${field ? ` field ${field}` : ""} is invalid.`,
    400
  );
}

function historyContent(eventType: string, content: string): HistoryContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    invalidHistory(eventType);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    invalidHistory(eventType);
  }
  return parsed as HistoryContent;
}

function historyString(
  eventType: string,
  content: HistoryContent,
  field: string
): string {
  const value = content[field];
  if (typeof value !== "string") invalidHistory(eventType, field);
  return value;
}

function historyOptionalString(
  eventType: string,
  content: HistoryContent,
  field: string
): string | null {
  const value = content[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") invalidHistory(eventType, field);
  return value;
}

function historyUuid(
  eventType: string,
  content: HistoryContent,
  field: string
): string {
  const value = historyString(eventType, content, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    invalidHistory(eventType, field);
  }
  return value;
}

function historyOptionalUuid(
  eventType: string,
  content: HistoryContent,
  field: string
): string | null {
  const value = historyOptionalString(eventType, content, field);
  if (value !== null
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    invalidHistory(eventType, field);
  }
  return value;
}

function historyInteger(
  eventType: string,
  content: HistoryContent,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  const value = content[field];
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalidHistory(eventType, field);
  }
  return value as number;
}

function historyBoolean(
  eventType: string,
  content: HistoryContent,
  field: string
): boolean {
  const value = content[field];
  if (typeof value !== "boolean") invalidHistory(eventType, field);
  return value;
}

function historyObject(
  eventType: string,
  content: HistoryContent,
  field: string,
  nullable = false
): Readonly<Record<string, unknown>> | null {
  const value = content[field];
  if (nullable && (value === undefined || value === null)) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidHistory(eventType, field);
  }
  return value as Readonly<Record<string, unknown>>;
}

function historyArray(
  eventType: string,
  content: HistoryContent,
  field: string
): readonly unknown[] {
  const value = content[field];
  if (!Array.isArray(value)) invalidHistory(eventType, field);
  return value;
}

function historyEnum<const Value extends string>(
  eventType: string,
  content: HistoryContent,
  field: string,
  values: readonly Value[]
): Value {
  const value = historyString(eventType, content, field);
  if (!(values as readonly string[]).includes(value)) invalidHistory(eventType, field);
  return value as Value;
}

async function requireHistoryMutation(
  operation: Promise<Readonly<{ rowCount: number | null }>>,
  eventType: string
): Promise<void> {
  const result = await operation;
  if (result.rowCount !== 1) invalidHistory(eventType);
}

async function requireLogicalMutation(
  operation: Promise<Readonly<{ rowCount: number | null }>>,
  domain: SystemArchiveDomain
): Promise<void> {
  const result = await operation;
  if (result.rowCount !== 1) {
    throw repositoryError(`System Archive ${domain} record did not restore exactly once.`, 400);
  }
}

type SystemPromptEnvelope = Extract<SystemRecordEnvelope, { domain: "prompts" }>;
type SystemIllustrationEnvelope = Extract<SystemRecordEnvelope, { domain: "illustrations" }>;

function activityEventIdentity(sourceId: string): number {
  const matched = /^00000000-0000-4000-8000-([0-9a-f]{12})$/iu.exec(sourceId);
  if (!matched) throw repositoryError("System Archive activity identity is invalid.", 400);
  const value = Number.parseInt(matched[1]!, 16);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw repositoryError("System Archive activity identity is invalid.", 400);
  }
  return value;
}

async function insertLogicalRecord(
  database: DatabaseClient,
  ownerUserId: string,
  envelope: SystemRecordEnvelope,
  pendingPrompts: SystemPromptEnvelope[],
  pendingIllustrations: SystemIllustrationEnvelope[]
): Promise<boolean> {
  if (envelope.sourceId !== envelope.record.sourceId) {
    throw repositoryError("System Archive record identity is inconsistent.", 400);
  }
  switch (envelope.domain) {
    case "providers": {
      const { record } = envelope;
      await requireLogicalMutation(database.query(
        `INSERT INTO provider_profiles (
           id,owner_user_id,name,provider_type,provider_role,base_url,default_model,
           context_window_tokens,max_output_tokens,temperature,configuration,enabled,
           health_status,consecutive_failures,last_health_check_at,last_health_error,
           request_timeout_ms,is_default
         ) VALUES (
           $1,$2,$3,'openai_compatible',$4,$5,$6,$7,4096,0.8,$8::jsonb,false,
           'unknown',0,NULL,NULL,$9,false
         )`,
        [
          record.sourceId,
          ownerUserId,
          record.displayName,
          record.kind,
          record.baseUrl ?? "http://disabled.invalid",
          record.selectedModel ?? "",
          Math.max(1_024, Math.min(record.contextWindow ?? 32_768, 4_000_000)),
          json(record.retryLimit === null ? {} : { retryLimit: record.retryLimit }),
          Math.max(5_000, Math.min(record.timeoutMs ?? 300_000, 3_600_000))
        ]
      ), envelope.domain);
      return true;
    }
    case "prompts": {
      const { record } = envelope;
      if (record.campaignId !== null) {
        pendingPrompts.push(envelope);
        return false;
      }
      await requireLogicalMutation(database.query(
        `INSERT INTO prompt_template_overrides
           (id,owner_user_id,campaign_id,prompt_key,content,created_at,updated_at)
         VALUES ($1,$2,NULL,$3,$4,$5,$5)`,
        [record.sourceId, ownerUserId, record.templateKey, record.overrideText, record.updatedAt]
      ), envelope.domain);
      return true;
    }
    case "worlds": {
      const { record } = envelope;
      await requireLogicalMutation(database.query(
        `INSERT INTO worlds (id,owner_user_id,title,status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [record.sourceId, ownerUserId, record.title, record.status, record.createdAt, record.updatedAt]
      ), envelope.domain);
      return true;
    }
    case "world-versions": {
      const { record } = envelope;
      await requireLogicalMutation(database.query(
        `INSERT INTO world_versions (
           id,world_id,owner_user_id,version_number,content,source_hash,published_at,
           created_at,release_notes,created_from_revision
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$7,$8,$9)`,
        [
          record.sourceId,
          record.worldId,
          ownerUserId,
          record.versionNumber,
          json(record.content),
          record.contentFingerprint,
          record.publishedAt,
          record.releaseNotes,
          record.createdFromRevision
        ]
      ), envelope.domain);
      return true;
    }
    case "world-drafts": {
      const { record } = envelope;
      await requireLogicalMutation(database.query(
        `INSERT INTO world_drafts (
           world_id,owner_user_id,based_on_world_version_id,revision,content,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [
          record.worldId,
          ownerUserId,
          record.basedOnWorldVersionId,
          Math.max(1, record.revision),
          json(record.content),
          record.createdAt,
          record.updatedAt
        ]
      ), envelope.domain);
      return true;
    }
    case "campaigns": {
      const { record } = envelope;
      await requireLogicalMutation(database.query(
        `INSERT INTO campaigns (
           id,owner_user_id,world_version_id,title,status,active_turn_number,
           legacy_settings,turn_control_style,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
        [
          record.sourceId,
          ownerUserId,
          record.worldVersionId,
          record.title,
          record.status,
          record.activeTurnNumber,
          json(record.settings),
          turnControlStyle(record.settings.turnControlStyle),
          record.createdAt,
          record.updatedAt
        ]
      ), envelope.domain);
      return true;
    }
    case "turns": {
      const { record } = envelope;
      await requireLogicalMutation(database.query(
        `INSERT INTO turns (
           id,owner_user_id,campaign_id,turn_number,action,narration,choices,image_prompt,
           mechanics_private,state_snapshot_private,model_metadata,import_metadata,
           accepted_at,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,NULL,'{}'::jsonb,'{}'::jsonb,
                   $9::jsonb,$10,$10)`,
        [
          record.sourceId,
          ownerUserId,
          record.campaignId,
          record.turnNumber,
          record.action,
          record.narration,
          json(record.choices),
          record.imagePrompt,
          json({ source: "system_archive" }),
          record.acceptedAt
        ]
      ), envelope.domain);
      return true;
    }
    case "turn-corrections": {
      const { record } = envelope;
      await requireLogicalMutation(database.query(
        `INSERT INTO turn_narration_corrections (
           id,owner_user_id,campaign_id,turn_id,revision,narration,
           previous_effective_narration_hash,reason,source,created_by_user_id,created_at
         )
         SELECT $1,$2,turn_row.campaign_id,turn_row.id,$3,$4,$5,$6,$7,$2,$8
           FROM turns turn_row
          WHERE turn_row.id=$9 AND turn_row.owner_user_id=$2`,
        [
          record.sourceId,
          ownerUserId,
          record.revision,
          record.narration,
          record.previousEffectiveNarrationHash,
          record.reason,
          record.source,
          record.correctedAt,
          record.turnId
        ]
      ), envelope.domain);
      return true;
    }
    case "campaign-state": {
      const { record } = envelope;
      const state = record.state;
      await requireLogicalMutation(database.query(
        `INSERT INTO campaign_state (
           campaign_id,owner_user_id,scratchpad_private,trackers,default_triggers,
           event_triggers,pending_event_triggers,rpg_stats,import_provenance,
           initial_state_snapshot,revision,updated_at
         ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,
                   $9::jsonb,$10::jsonb,$11,$12)`,
        [
          record.campaignId,
          ownerUserId,
          state.scratchpad,
          json(state.trackers),
          json(state.defaultTriggers),
          json(state.eventTriggers),
          json(state.pendingEventTriggers),
          json(state.rpgStats),
          json({ source: "system_archive" }),
          json(state),
          record.revision,
          record.updatedAt
        ]
      ), envelope.domain);
      return true;
    }
    case "campaign-history": {
      const { record } = envelope;
      const content = historyContent(record.eventType, record.content);
      switch (record.eventType) {
        case "character-profile-edit": {
          const revision = historyInteger(record.eventType, content, "revision", 1);
          const previousProfile = historyObject(record.eventType, content, "previousProfile", true);
          const nextProfile = historyObject(record.eventType, content, "nextProfile");
          const editSource = historyEnum(record.eventType, content, "editSource", [
            "world_version_seed", "manual", "ai_organized", "imported", "branch", "transfer"
          ] as const);
          await requireHistoryMutation(database.query(
            `INSERT INTO campaign_character_profile_edits (
               id,owner_user_id,campaign_id,revision,previous_profile,next_profile,edit_source,created_at
             ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
            [
              record.sourceId,
              ownerUserId,
              record.campaignId,
              revision,
              previousProfile === null ? null : json(previousProfile),
              json(nextProfile),
              editSource,
              record.occurredAt
            ]
          ), record.eventType);
          await database.query(
            `UPDATE campaigns
                SET character_profile=$3::jsonb,character_profile_revision=$4
              WHERE id=$1 AND owner_user_id=$2 AND character_profile_revision<$4`,
            [record.campaignId, ownerUserId, json(nextProfile), revision]
          );
          return true;
        }
        case "campaign-state-edit": {
          const stateSnapshot = historyObject(record.eventType, content, "stateSnapshot");
          const changedFields = historyArray(record.eventType, content, "changedFields");
          await requireHistoryMutation(database.query(
            `INSERT INTO campaign_state_edits (
               id,owner_user_id,campaign_id,effective_turn_number,revision,
               state_snapshot_private,changed_fields,created_at
             ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
            [
              record.sourceId,
              ownerUserId,
              record.campaignId,
              historyInteger(record.eventType, content, "effectiveTurnNumber", 0),
              historyInteger(record.eventType, content, "revision", 1),
              json(stateSnapshot),
              json(changedFields),
              record.occurredAt
            ]
          ), record.eventType);
          return true;
        }
        case "world-migration": {
          await requireHistoryMutation(database.query(
            `INSERT INTO campaign_world_migrations (
               id,owner_user_id,campaign_id,from_world_version_id,to_world_version_id,note,created_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              record.sourceId,
              ownerUserId,
              record.campaignId,
              historyUuid(record.eventType, content, "fromWorldVersionId"),
              historyUuid(record.eventType, content, "toWorldVersionId"),
              historyString(record.eventType, content, "note"),
              record.occurredAt
            ]
          ), record.eventType);
          return true;
        }
        case "world-transfer": {
          const sourceFingerprint = historyString(record.eventType, content, "sourceFingerprint");
          requireHash(sourceFingerprint, "System Archive world-transfer source fingerprint");
          await requireHistoryMutation(database.query(
            `INSERT INTO campaign_world_transfers (
               id,owner_user_id,idempotency_key,source_campaign_id,target_campaign_id,
               from_world_version_id,to_world_version_id,character_strategy,state_strategy,
               target_defaults_policy,source_fingerprint,warnings,note,created_at
             ) VALUES ($1,$2,$1,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
            [
              record.sourceId,
              ownerUserId,
              historyOptionalUuid(record.eventType, content, "sourceCampaignId"),
              historyOptionalUuid(record.eventType, content, "targetCampaignId"),
              historyUuid(record.eventType, content, "fromWorldVersionId"),
              historyUuid(record.eventType, content, "toWorldVersionId"),
              historyEnum(record.eventType, content, "characterStrategy", ["preserve_source"] as const),
              historyEnum(record.eventType, content, "stateStrategy", ["preserve"] as const),
              historyEnum(record.eventType, content, "targetDefaultsPolicy", ["retain_source"] as const),
              sourceFingerprint,
              json(historyArray(record.eventType, content, "warnings")),
              historyString(record.eventType, content, "note"),
              record.occurredAt
            ]
          ), record.eventType);
          return true;
        }
        case "memory-config": {
          const embeddingEnabled = historyBoolean(record.eventType, content, "embeddingEnabled");
          const providerProfileId = historyOptionalUuid(
            record.eventType,
            content,
            "embeddingProviderProfileId"
          );
          const embeddingModel = historyString(record.eventType, content, "embeddingModel");
          if (embeddingEnabled && (providerProfileId === null || embeddingModel.length === 0)) {
            invalidHistory(record.eventType);
          }
          await requireHistoryMutation(database.query(
            `INSERT INTO campaign_memory_configs (
               campaign_id,owner_user_id,embedding_enabled,embedding_provider_profile_id,
               embedding_model,embedding_batch_size,created_at,updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
            [
              record.campaignId,
              ownerUserId,
              embeddingEnabled,
              providerProfileId,
              embeddingModel,
              historyInteger(record.eventType, content, "embeddingBatchSize", 1, 128),
              record.occurredAt
            ]
          ), record.eventType);
          return true;
        }
        case "illustration-config": {
          const enabled = historyBoolean(record.eventType, content, "enabled");
          const providerProfileId = historyOptionalUuid(record.eventType, content, "providerProfileId");
          const model = historyString(record.eventType, content, "model");
          if (enabled && (providerProfileId === null || model.length === 0)) {
            invalidHistory(record.eventType);
          }
          await requireHistoryMutation(database.query(
            `INSERT INTO campaign_illustration_configs (
               campaign_id,owner_user_id,enabled,provider_profile_id,model,size,aspect_ratio,
               quality,output_format,max_attempts,source_policy,segment_word_count,
               images_per_segment,segment_prompt_mode,refinement_prompt,created_at,updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)`,
            [
              record.campaignId,
              ownerUserId,
              enabled,
              providerProfileId,
              model,
              historyString(record.eventType, content, "size"),
              historyString(record.eventType, content, "aspectRatio"),
              historyEnum(record.eventType, content, "quality", ["auto", "low", "medium", "high"] as const),
              historyEnum(record.eventType, content, "outputFormat", ["png", "jpeg", "webp"] as const),
              historyInteger(record.eventType, content, "maxAttempts", 1, 10),
              enabled ? "generate_only" : "off",
              historyInteger(record.eventType, content, "segmentWordCount", 100, 5_000),
              historyInteger(record.eventType, content, "imagesPerSegment", 1, 2),
              historyEnum(record.eventType, content, "segmentPromptMode", ["direct", "ai_refined"] as const),
              historyString(record.eventType, content, "refinementPrompt"),
              record.occurredAt
            ]
          ), record.eventType);
          return true;
        }
        case "accepted-turn-mode": {
          const turnId = historyUuid(record.eventType, content, "turnId");
          const turnNumber = historyInteger(record.eventType, content, "turnNumber", 1);
          await requireHistoryMutation(database.query(
            `UPDATE turns
                SET input_mode=$4,input_mode_source=$5
              WHERE id=$1 AND owner_user_id=$2 AND campaign_id=$3 AND turn_number=$6`,
            [
              turnId,
              ownerUserId,
              record.campaignId,
              historyEnum(record.eventType, content, "inputMode", ["action", "scene"] as const),
              historyEnum(record.eventType, content, "inputModeSource", [
                "explicit", "auto", "generated_choice", "opening_action", "fallback"
              ] as const),
              turnNumber
            ]
          ), record.eventType);
          return true;
        }
        case "illustration-set": {
          const turnId = historyUuid(record.eventType, content, "turnId");
          await requireHistoryMutation(database.query(
            `INSERT INTO turn_illustration_sets (
               id,owner_user_id,campaign_id,turn_id,source_text_hash,segment_word_count,
               images_per_segment,prompt_mode,status,is_active,character_visual_reference,
               created_at,completed_at
             )
             SELECT $1,$2,$3,turn_row.id,
                    encode(digest(convert_to(turn_row.narration,'UTF8'),'sha256'),'hex'),
                    $5,$6,$7,$8,$9,$10,$11,$12
               FROM turns turn_row
              WHERE turn_row.id=$4 AND turn_row.owner_user_id=$2 AND turn_row.campaign_id=$3`,
            [
              record.sourceId,
              ownerUserId,
              record.campaignId,
              turnId,
              historyInteger(record.eventType, content, "segmentWordCount", 100, 5_000),
              historyInteger(record.eventType, content, "imagesPerSegment", 1, 2),
              historyEnum(record.eventType, content, "promptMode", ["direct", "ai_refined", "legacy"] as const),
              historyEnum(record.eventType, content, "status", [
                "queued", "refining", "generating", "completed", "partial", "failed", "superseded"
              ] as const),
              historyBoolean(record.eventType, content, "isActive"),
              historyOptionalString(record.eventType, content, "characterVisualReference") ?? "",
              record.occurredAt,
              historyOptionalString(record.eventType, content, "completedAt")
            ]
          ), record.eventType);
          return true;
        }
        case "illustration-segment": {
          const turnId = historyUuid(record.eventType, content, "turnId");
          await requireHistoryMutation(database.query(
            `INSERT INTO turn_illustration_segments (
               id,owner_user_id,illustration_set_id,campaign_id,turn_id,ordinal,
               start_offset,end_offset,start_word,end_word,source_text,source_text_hash,
               direct_prompt,resolved_prompt,prompt_source,status,created_at,updated_at
             )
             SELECT $1,$2,$3,$4,turn_row.id,$6,$7,$8,$9,$10,turn_row.narration,
                    encode(digest(convert_to(turn_row.narration,'UTF8'),'sha256'),'hex'),
                    $11,$12,$13,$14,$15,$15
               FROM turns turn_row
               JOIN turn_illustration_sets illustration_set
                 ON illustration_set.id=$3 AND illustration_set.owner_user_id=$2
                AND illustration_set.campaign_id=$4 AND illustration_set.turn_id=turn_row.id
              WHERE turn_row.id=$5 AND turn_row.owner_user_id=$2 AND turn_row.campaign_id=$4`,
            [
              record.sourceId,
              ownerUserId,
              historyUuid(record.eventType, content, "illustrationSetId"),
              record.campaignId,
              turnId,
              historyInteger(record.eventType, content, "ordinal", 0),
              historyInteger(record.eventType, content, "startOffset", 0),
              historyInteger(record.eventType, content, "endOffset", 0),
              historyInteger(record.eventType, content, "startWord", 0),
              historyInteger(record.eventType, content, "endWord", 0),
              historyString(record.eventType, content, "directPrompt"),
              historyString(record.eventType, content, "resolvedPrompt"),
              historyEnum(record.eventType, content, "promptSource", [
                "direct", "ai_refined", "ai_fallback", "legacy"
              ] as const),
              historyEnum(record.eventType, content, "status", [
                "queued", "refining", "generating", "completed", "recoverable", "failed"
              ] as const),
              record.occurredAt
            ]
          ), record.eventType);
          return true;
        }
      }
      await requireLogicalMutation(database.query(
        `INSERT INTO activity_events
           (owner_user_id,campaign_id,event_type,correlation_id,details,created_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [
          ownerUserId,
          record.campaignId,
          `system-archive-history:${record.eventType}`,
          record.sourceId,
          json({ sourceId: record.sourceId, content: record.content }),
          record.occurredAt
        ]
      ), envelope.domain);
      return true;
    }
    case "canonical-facts": {
      const { record } = envelope;
      await requireLogicalMutation(database.query(
        `INSERT INTO campaign_canonical_facts (
           id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,
           source_fact_index,content,normalized_content,entities,valid_from_turn,metadata,
           created_at,updated_at
         )
         SELECT $1,$2,campaign.id,campaign.world_version_id,turn_row.id,turn_row.turn_number,
                COALESCE((SELECT max(existing.source_fact_index)+1
                            FROM campaign_canonical_facts existing
                           WHERE existing.campaign_id=campaign.id
                             AND existing.source_turn_id=turn_row.id),0),
                $3,lower($3),ARRAY[]::text[],turn_row.turn_number,$4::jsonb,$5,$5
           FROM campaigns campaign
           JOIN LATERAL (
             SELECT candidate.id,candidate.turn_number
               FROM turns candidate
              WHERE candidate.campaign_id=campaign.id AND candidate.owner_user_id=$2
              ORDER BY candidate.turn_number DESC LIMIT 1
           ) turn_row ON true
          WHERE campaign.id=$6 AND campaign.owner_user_id=$2`,
        [
          record.sourceId,
          ownerUserId,
          record.object,
          json({ subject: record.subject, predicate: record.predicate }),
          record.updatedAt,
          record.campaignId
        ]
      ), envelope.domain);
      return true;
    }
    case "chronicle": {
      const { record } = envelope;
      if (record.kind === "summary-checkpoint") {
        await requireLogicalMutation(database.query(
          `INSERT INTO summary_checkpoints (
             id,owner_user_id,campaign_id,through_turn,summary_kind,content,token_estimate,created_at
           ) SELECT $1,$2,campaign.id,campaign.active_turn_number,'system_archive',
                    to_jsonb($3::text),0,$4
               FROM campaigns campaign
              WHERE campaign.id=$5 AND campaign.owner_user_id=$2`,
          [record.sourceId, ownerUserId, record.content, record.occurredAt, record.campaignId]
        ), envelope.domain);
      } else {
        await requireLogicalMutation(database.query(
          `INSERT INTO chronicle_memories (
             id,owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,ordinal,
             content,token_estimate,entities,metadata,embedding,created_at,updated_at
           ) SELECT $1,$2,campaign.id,campaign.world_version_id,$7::uuid,$8,
                    COALESCE((SELECT max(memory.ordinal)+1 FROM chronicle_memories memory
                               WHERE memory.campaign_id=campaign.id),0),
                    $3,0,$4::text[],$5::jsonb,NULL,$6,$6
               FROM campaigns campaign
              WHERE campaign.id=$9 AND campaign.owner_user_id=$2
                AND ($7::uuid IS NULL OR EXISTS (
                  SELECT 1 FROM turns turn_row
                   WHERE turn_row.id=$7 AND turn_row.owner_user_id=$2
                     AND turn_row.campaign_id=campaign.id
                ))`,
          [
            record.sourceId,
            ownerUserId,
            record.content,
            record.metadata.entityNames,
            json({ openThreadIds: record.metadata.openThreadIds }),
            record.occurredAt,
            record.turnId,
            record.memoryKind,
            record.campaignId
          ]
        ), envelope.domain);
      }
      return true;
    }
    case "illustrations":
      pendingIllustrations.push(envelope);
      return false;
    case "imports": {
      const { record } = envelope;
      await requireLogicalMutation(database.query(
        `INSERT INTO imports (
           id,owner_user_id,source_type,source_name,source_hash,status,stats,error_message,
           created_at,completed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,COALESCE($9,clock_timestamp()),$9)`,
        [
          record.sourceId,
          ownerUserId,
          record.sourceType,
          record.sourceName,
          record.sourceHash,
          record.completedAt === null ? "failed" : "completed",
          json({ restoredBy: "system_archive" }),
          record.completedAt === null ? "Imported historical failure" : null,
          record.completedAt
        ]
      ), envelope.domain);
      return true;
    }
    case "cost-events": {
      const { record } = envelope;
      if (record.campaignId === null) {
        await requireLogicalMutation(database.query(
          `INSERT INTO activity_events
             (owner_user_id,campaign_id,event_type,correlation_id,details,created_at)
           VALUES ($1,NULL,'system-archive-cost',$2,$3::jsonb,$4)`,
          [ownerUserId, record.sourceId, json(record), record.occurredAt]
        ), envelope.domain);
        return true;
      }
      await requireLogicalMutation(database.query(
        `INSERT INTO provider_cost_events (
           id,owner_user_id,campaign_id,local_call_id,provider_type,category,operation,
           amount,currency,usage_metadata,occurred_at,created_at
         ) VALUES ($1,$2,$3,$1,'system_archive',$4,'restored',$5,'USD',$6::jsonb,$7,$7)`,
        [
          record.sourceId,
          ownerUserId,
          record.campaignId,
          record.providerKind === "image" ? "image" : record.providerKind === "embedding" ? "memory" : "story",
          record.amountMicros / 1_000_000,
          json({ providerKind: record.providerKind }),
          record.occurredAt
        ]
      ), envelope.domain);
      return true;
    }
    case "activity-events": {
      const { record } = envelope;
      const activityId = activityEventIdentity(record.sourceId);
      await requireLogicalMutation(database.query(
        `INSERT INTO activity_events
           (id,owner_user_id,campaign_id,event_type,correlation_id,details,created_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [
          activityId,
          ownerUserId,
          record.campaignId,
          record.eventType,
          record.sourceId,
          json({ summary: record.summary, sourceId: record.sourceId }),
          record.occurredAt
        ]
      ), envelope.domain);
      await database.query(
        `SELECT setval(
           pg_get_serial_sequence('activity_events','id'),
           GREATEST((SELECT max(id) FROM activity_events),1),
           true
         )`
      );
      return true;
    }
  }
}

function asyncRecords(
  records: Iterable<SystemRecordEnvelope> | AsyncIterable<SystemRecordEnvelope>
): AsyncIterable<SystemRecordEnvelope> {
  if (Symbol.asyncIterator in records) return records as AsyncIterable<SystemRecordEnvelope>;
  return (async function* () {
    yield* records as Iterable<SystemRecordEnvelope>;
  })();
}

async function restorePendingPrompts(
  database: DatabaseClient,
  ownerUserId: string,
  pendingPrompts: readonly SystemPromptEnvelope[],
  restoredIds: Set<string>
): Promise<number> {
  let restored = 0;
  for (const envelope of pendingPrompts) {
    if (restoredIds.has(envelope.sourceId)) continue;
    const { record } = envelope;
    await requireLogicalMutation(database.query(
      `INSERT INTO prompt_template_overrides
         (id,owner_user_id,campaign_id,prompt_key,content,created_at,updated_at)
       SELECT $1,$2,campaign.id,$4,$5,$6,$6
         FROM campaigns campaign
        WHERE campaign.id=$3 AND campaign.owner_user_id=$2`,
      [
        record.sourceId,
        ownerUserId,
        record.campaignId,
        record.templateKey,
        record.overrideText,
        record.updatedAt
      ]
    ), envelope.domain);
    restoredIds.add(envelope.sourceId);
    restored += 1;
  }
  return restored;
}

async function insertAssetBindings(
  database: DatabaseClient,
  ownerUserId: string,
  asset: ArchiveAssetRecord,
  pendingIllustrations: readonly SystemIllustrationEnvelope[],
  restoredIllustrationIds: Set<string>
): Promise<number> {
  const updatedAsset = await database.query(
    `UPDATE assets
        SET pixel_width=$3,pixel_height=$4,technical_metadata=$5::jsonb,created_at=$6
      WHERE id=$1 AND owner_user_id=$2`,
    [
      asset.sourceAssetId,
      ownerUserId,
      asset.pixelWidth,
      asset.pixelHeight,
      json(asset.technicalMetadata),
      asset.createdAt
    ]
  );
  if (updatedAsset.rowCount !== 1) {
    throw repositoryError("System Archive Original Asset authority was not attached exactly once.", 400);
  }
  await database.query(
    `INSERT INTO asset_library_entries (asset_id,owner_user_id,created_by_user_id)
     VALUES ($1,$2,$2) ON CONFLICT (asset_id) DO NOTHING`,
    [asset.sourceAssetId, ownerUserId]
  );
  await database.query(
    `UPDATE asset_library_entries
        SET created_by_user_id=$2,title=$3,caption=$4,notes=$5,tags=$6::text[],origin=$7,
            reuse_scope=$8,automatic_reuse_enabled=$9,review_status=$10,
            content_categories=$11::text[],favorite=$12,archived_at=$13,updated_at=clock_timestamp()
      WHERE asset_id=$1 AND owner_user_id=$2`,
    [
      asset.sourceAssetId,
      ownerUserId,
      asset.library.title,
      asset.library.caption,
      asset.library.notes,
      asset.library.tags,
      asset.library.origin,
      asset.library.reuseScope,
      asset.library.automaticReuseEnabled,
      asset.library.reviewStatus,
      asset.library.contentCategories,
      asset.library.favorite,
      asset.library.archivedAt
    ]
  );
  // The generic publication seam creates conservative defaults. The archive
  // inventory is the complete logical binding authority, so replace them.
  await database.query(
    "DELETE FROM asset_references WHERE asset_id=$1 AND owner_user_id=$2",
    [asset.sourceAssetId, ownerUserId]
  );
  await database.query(
    "DELETE FROM asset_generation_contexts WHERE asset_id=$1 AND owner_user_id=$2",
    [asset.sourceAssetId, ownerUserId]
  );
  for (const binding of asset.bindings) {
    switch (binding.role) {
      case "world_cover":
        await database.query(
          "UPDATE worlds SET cover_asset_id=$1 WHERE id=$2 AND owner_user_id=$3",
          [asset.sourceAssetId, binding.worldId, ownerUserId]
        );
        break;
      case "world_version_asset":
        // World-version asset identity is already represented in immutable content.assets.
        break;
      case "campaign_asset":
      case "turn_illustration":
      case "imported_attachment":
        await database.query(
          `INSERT INTO asset_references
             (owner_user_id,asset_id,campaign_id,turn_id,asset_role)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (asset_id,campaign_id,turn_id,asset_role) DO NOTHING`,
          [
            ownerUserId,
            asset.sourceAssetId,
            binding.campaignId,
            "turnId" in binding ? binding.turnId : null,
            binding.role === "turn_illustration"
              ? "turn_illustration"
              : binding.role === "campaign_asset" ? "world_asset" : "import_attachment"
          ]
        );
        break;
      case "generation_context":
        await database.query(
          `INSERT INTO asset_generation_contexts (
             id,owner_user_id,asset_id,created_by_user_id,world_id,world_version_id,
             campaign_id,turn_id,target_type,created_at
           ) VALUES ($1,$2,$3,$2,$4,$5,$6,$7,'other',$8)`,
          [
            binding.sourceContextId,
            ownerUserId,
            asset.sourceAssetId,
            binding.worldId,
            binding.worldVersionId,
            binding.campaignId,
            binding.turnId,
            asset.createdAt
          ]
        );
        break;
      case "illustration_segment_variant":
        await database.query(
          `INSERT INTO turn_illustration_segment_assets
             (segment_id,owner_user_id,asset_id,image_job_id,variant_index,created_at)
           VALUES ($1,$2,$3,NULL,$4,$5)`,
          [binding.segmentId, ownerUserId, asset.sourceAssetId, binding.variantIndex, asset.createdAt]
        );
        break;
    }
  }
  let restoredIllustrations = 0;
  for (const illustration of pendingIllustrations) {
    if (illustration.record.assetId !== asset.sourceAssetId
      || restoredIllustrationIds.has(illustration.sourceId)) continue;
    const matched = await database.query<{ count: string }>(
      `SELECT count(*)::bigint AS count
         FROM turn_illustration_segment_assets segment_asset
         JOIN turn_illustration_segments segment
           ON segment.id=segment_asset.segment_id
          AND segment.owner_user_id=segment_asset.owner_user_id
        WHERE segment_asset.owner_user_id=$1 AND segment_asset.asset_id=$2
          AND segment.campaign_id=$3 AND segment.turn_id IS NOT DISTINCT FROM $4::uuid
          AND (segment_asset.variant_index=0)=$5
          AND overlay(overlay(md5('illustration:' || segment.id::text || ':'
                || segment_asset.variant_index::text) placing '5' from 13) placing '8' from 17)::uuid=$6`,
      [
        ownerUserId,
        asset.sourceAssetId,
        illustration.record.campaignId,
        illustration.record.turnId,
        illustration.record.selected,
        illustration.sourceId
      ]
    );
    if (Number(matched.rows[0]?.count ?? 0) !== 1) {
      throw repositoryError("System Archive illustrations record did not restore exactly once.", 400);
    }
    await database.query(
      `UPDATE asset_generation_contexts
          SET fiction_prompt=$3,target_type='turn_illustration'
        WHERE owner_user_id=$1 AND asset_id=$2`,
      [ownerUserId, asset.sourceAssetId, illustration.record.fictionPrompt]
    );
    restoredIllustrationIds.add(illustration.sourceId);
    restoredIllustrations += 1;
  }
  return restoredIllustrations;
}

async function normalizeImportedIllustrations(
  database: DatabaseClient,
  ownerUserId: string
): Promise<void> {
  await database.query(
    `UPDATE turn_illustration_segments segment
        SET status=CASE WHEN EXISTS (
              SELECT 1
                FROM turn_illustration_segment_assets segment_asset
               WHERE segment_asset.segment_id=segment.id
                 AND segment_asset.owner_user_id=segment.owner_user_id
            ) THEN 'completed' ELSE 'failed' END,
            updated_at=GREATEST(segment.updated_at,segment.created_at)
      WHERE segment.owner_user_id=$1`,
    [ownerUserId]
  );
  await database.query(
    `WITH normalized AS (
       SELECT illustration_set.id,
              CASE
                WHEN illustration_set.status='superseded' THEN 'superseded'
                WHEN NOT EXISTS (
                  SELECT 1 FROM turn_illustration_segments segment
                   WHERE segment.illustration_set_id=illustration_set.id
                     AND segment.owner_user_id=illustration_set.owner_user_id
                ) THEN 'failed'
                WHEN NOT EXISTS (
                  SELECT 1 FROM turn_illustration_segments segment
                   WHERE segment.illustration_set_id=illustration_set.id
                     AND segment.owner_user_id=illustration_set.owner_user_id
                     AND segment.status<>'completed'
                ) THEN 'completed'
                WHEN EXISTS (
                  SELECT 1 FROM turn_illustration_segments segment
                   WHERE segment.illustration_set_id=illustration_set.id
                     AND segment.owner_user_id=illustration_set.owner_user_id
                     AND segment.status='completed'
                ) THEN 'partial'
                ELSE 'failed'
              END AS status
         FROM turn_illustration_sets illustration_set
        WHERE illustration_set.owner_user_id=$1
     )
     UPDATE turn_illustration_sets illustration_set
        SET status=normalized.status,
            is_active=CASE WHEN normalized.status='superseded' THEN false ELSE illustration_set.is_active END,
            completed_at=COALESCE(illustration_set.completed_at,illustration_set.created_at)
       FROM normalized
      WHERE illustration_set.id=normalized.id AND illustration_set.owner_user_id=$1`,
    [ownerUserId]
  );
}

export function createPostgresSystemArchiveImportRepository(
  pool: DatabasePool,
  options: SystemArchiveImportRepositoryOptions
): SystemArchiveImportRepository {
  requireTtl(options.previewTtlSeconds);

  const repository: SystemArchiveImportRepository = {
    async destinationFingerprint(owner, request) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const result = await fingerprint(client, owner, request);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async createPreview(owner, request) {
      requireHash(request.archiveFingerprint, "System Archive fingerprint");
      if (!request.destination.destinationEmpty
        || request.destination.initialOwnerId !== owner.ownerUserId) {
        throw repositoryError("System Archive destination is not empty.", 409);
      }
      const projection = validatePreviewProjection(owner, request);
      const token = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await client.query(
          `UPDATE system_archive_jobs
              SET status='expired',updated_at=clock_timestamp()
            WHERE kind='import' AND status='previewed'
              AND progress->>'expiresAt' IS NOT NULL
              AND (progress->>'expiresAt')::timestamptz <= clock_timestamp()`
        );
        const current = await fingerprint(client, owner, { ignoreUploadId: request.uploadId });
        if (!current.destinationEmpty || !sameFingerprint(request.destination, current)) {
          throw repositoryError("System Archive destination changed after validation.", 409);
        }
        const expiry = await client.query<{ expires_at: Date }>(
          "SELECT clock_timestamp()+($1::text || ' seconds')::interval AS expires_at",
          [options.previewTtlSeconds]
        );
        const expiresAt = expiry.rows[0]!.expires_at.toISOString();
        const authority = await client.query<{
          filesystem_operation_id: string;
          staged_input_id: string;
        }>(
          `SELECT upload.filesystem_operation_id,upload.staged_input_id
             FROM system_archive_uploads upload
             JOIN portable_staged_inputs staged
               ON staged.id=upload.staged_input_id
              AND staged.owner_user_id=upload.owner_user_id
              AND staged.filesystem_operation_id=upload.filesystem_operation_id
            WHERE upload.id=$1 AND upload.owner_user_id=$2
              AND upload.status='completed' AND upload.staged_input_id IS NOT NULL
              AND upload.expires_at > clock_timestamp()
              AND staged.status='staged' AND staged.expires_at > clock_timestamp()
            FOR UPDATE OF upload,staged`,
          [request.uploadId, owner.ownerUserId]
        );
        const privateAuthority = authority.rows[0];
        if (!privateAuthority) {
          throw repositoryError("Completed System Archive upload was not found.", 404);
        }
        const renewedUpload = await client.query(
          `UPDATE system_archive_uploads
              SET expires_at=GREATEST(expires_at,$3),updated_at=clock_timestamp()
            WHERE id=$1 AND owner_user_id=$2 AND status='completed'`,
          [request.uploadId, owner.ownerUserId, expiresAt]
        );
        const renewedOperation = await client.query(
          `UPDATE durable_filesystem_operations
              SET expires_at=GREATEST(expires_at,$3),updated_at=clock_timestamp()
            WHERE id=$1 AND owner_user_id=$2 AND purpose='portable_staging'
              AND resource_kind='portable' AND lifecycle <> 'cleaned'`,
          [privateAuthority.filesystem_operation_id, owner.ownerUserId, expiresAt]
        );
        const renewedStaged = await client.query(
          `UPDATE portable_staged_inputs
              SET expires_at=GREATEST(expires_at,$3),updated_at=clock_timestamp()
            WHERE id=$1 AND owner_user_id=$2 AND status='staged'`,
          [privateAuthority.staged_input_id, owner.ownerUserId, expiresAt]
        );
        if (renewedUpload.rowCount !== 1
          || renewedOperation.rowCount !== 1
          || renewedStaged.rowCount !== 1) {
          throw new Error("System Archive preview lost its private staging authority.");
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO system_archive_jobs (
             owner_user_id,kind,status,idempotency_key_hash,staged_input_id,progress,report
           )
           SELECT upload.owner_user_id,'import','previewed',$3,upload.staged_input_id,$4::jsonb,$5::jsonb
             FROM system_archive_uploads upload
             JOIN portable_staged_inputs staged
               ON staged.id=upload.staged_input_id
              AND staged.owner_user_id=upload.owner_user_id
              AND staged.filesystem_operation_id=upload.filesystem_operation_id
            WHERE upload.id=$1 AND upload.owner_user_id=$2
              AND upload.status='completed' AND upload.staged_input_id IS NOT NULL
              AND upload.expires_at > clock_timestamp()
              AND staged.status='staged' AND staged.expires_at > clock_timestamp()
           RETURNING id`,
          [
            request.uploadId,
            owner.ownerUserId,
            tokenHash,
            JSON.stringify({
              archiveFingerprint: request.archiveFingerprint,
              destinationFingerprint: current,
              expiresAt
            }),
            JSON.stringify(projection)
          ]
        );
        const row = inserted.rows[0];
        if (!row) throw repositoryError("Completed System Archive upload was not found.", 404);
        await client.query("COMMIT");
        return Object.freeze({ jobId: row.id, previewHandle: token, expiresAt });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (typeof error === "object" && error !== null && "code" in error
          && String((error as { code?: unknown }).code) === "23505") {
          throw repositoryError("Another System Archive import preview is active.", 409);
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async consumePreviewAuthority(owner, previewHandle, idempotencyKey) {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(previewHandle)) {
        throw repositoryError("System Archive preview authority is invalid.", 400);
      }
      if (!idempotencyKey.trim() || idempotencyKey.length > 200) {
        throw repositoryError("System Archive import idempotency key is invalid.", 400);
      }
      const previewHash = createHash("sha256").update(previewHandle).digest("hex");
      const commitKeyHash = createHash("sha256").update(idempotencyKey).digest("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const selected = await client.query<{
          id: string;
          staged_input_id: string;
          upload_id: string;
          status: string;
          upload_status: string;
          upload_expires_at: Date;
          progress: unknown;
          report: unknown;
        }>(
          `SELECT job.id,job.staged_input_id,upload.id AS upload_id,job.status,
                  upload.status AS upload_status,upload.expires_at AS upload_expires_at,
                  job.progress,job.report
             FROM system_archive_jobs job
             JOIN system_archive_uploads upload
               ON upload.owner_user_id=job.owner_user_id
              AND upload.staged_input_id=job.staged_input_id
            WHERE job.owner_user_id=$1 AND job.kind='import' AND job.idempotency_key_hash=$2
            FOR UPDATE OF job,upload`,
          [owner.ownerUserId, previewHash]
        );
        const row = selected.rows[0];
        if (!row) throw repositoryError("System Archive preview authority is unavailable or expired.", 409);
        const progress = row.progress as Partial<{
          archiveFingerprint: unknown;
          destinationFingerprint: unknown;
          expiresAt: unknown;
          commitIdempotencyKeyHash: unknown;
        }>;
        if (typeof progress?.archiveFingerprint !== "string"
          || !/^[0-9a-f]{64}$/u.test(progress.archiveFingerprint)
          || typeof progress.destinationFingerprint !== "object"
          || progress.destinationFingerprint === null) {
          throw new Error("System Archive preview authority is malformed.");
        }
        if (row.status === "previewed") {
          if (typeof progress.expiresAt !== "string"
            || Date.parse(progress.expiresAt) <= Date.now()
            || row.upload_status !== "completed"
            || row.upload_expires_at.getTime() <= Date.now()) {
            throw repositoryError("System Archive preview authority is unavailable or expired.", 409);
          }
          const queued = await client.query(
            `UPDATE system_archive_jobs
                SET status='queued',report=NULL,
                    progress=progress || $3::jsonb,updated_at=clock_timestamp()
              WHERE id=$1 AND owner_user_id=$2 AND status='previewed'`,
            [
              row.id,
              owner.ownerUserId,
              json({
                commitIdempotencyKeyHash: commitKeyHash,
                previewProjection: parsePersistedPreviewProjection(row.report)
              })
            ]
          );
          if (queued.rowCount !== 1) {
            throw repositoryError("System Archive preview authority changed while it was consumed.", 409);
          }
        } else if (progress.commitIdempotencyKeyHash !== commitKeyHash
          || ![
            "queued", "revalidating", "waiting_for_gate", "importing",
            "authoritative_committed", "rebuilding", "completed"
          ].includes(row.status)) {
          throw repositoryError("System Archive preview authority was consumed by another request.", 409);
        }
        const destination = parsePersistedDestinationFingerprint(progress.destinationFingerprint);
        await client.query("COMMIT");
        return Object.freeze({
          jobId: row.id,
          stagedInputId: row.staged_input_id,
          uploadId: row.upload_id,
          archiveFingerprint: progress.archiveFingerprint,
          destination
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async loadImportJobAuthority(owner, jobId, stagedInputId) {
      const selected = await pool.query<{
        id: string;
        staged_input_id: string;
        upload_id: string;
        status: SystemArchiveImportJobAuthority["status"];
        progress: unknown;
        report: unknown;
      }>(
        `SELECT job.id,job.staged_input_id,upload.id AS upload_id,job.status,job.progress,job.report
           FROM system_archive_jobs job
           JOIN system_archive_uploads upload
             ON upload.owner_user_id=job.owner_user_id
            AND upload.staged_input_id=job.staged_input_id
          WHERE job.id=$1 AND job.owner_user_id=$2 AND job.staged_input_id=$3
            AND job.kind='import'
            AND job.status IN ('revalidating','importing','authoritative_committed','rebuilding')
            AND (
              job.status IN ('authoritative_committed','rebuilding')
              OR (upload.status='completed' AND upload.expires_at>clock_timestamp())
            )`,
        [jobId, owner.ownerUserId, stagedInputId]
      );
      const row = selected.rows[0];
      if (!row) throw repositoryError("System Archive import staging authority is unavailable.", 409);
      return parseImportJobAuthority(row);
    },

    async withAtomicImport(owner, request, work) {
      if (!request.destination.destinationEmpty
        || request.destination.initialOwnerId !== owner.ownerUserId) {
        throw repositoryError("System Archive destination is not empty.", 409);
      }
      const client = await pool.connect();
      const pendingPrompts: SystemPromptEnvelope[] = [];
      const pendingIllustrations: SystemIllustrationEnvelope[] = [];
      const restoredPromptIds = new Set<string>();
      const restoredIllustrationIds = new Set<string>();
      const expectedCounts = emptyDomainCounts();
      const persistedCounts = emptyDomainCounts();
      const campaignIds = new Set<string>();
      const assetIds = new Set<string>();
      let persistedAssetBytes = 0;
      let reportRecorded = false;
      let previewProjection: SystemImportPreviewProjection | null = null;
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [SYSTEM_IMPORT_LOCK_KEY]
        );
        if (request.jobId) {
          if (!request.leaseOwner?.trim()) {
            throw repositoryError("System Archive import lease is required.", 409);
          }
          const started = await client.query<{ progress: unknown }>(
            `UPDATE system_archive_jobs
                SET status='importing',updated_at=clock_timestamp()
              WHERE id=$1 AND owner_user_id=$2 AND kind='import'
                AND status IN ('revalidating','importing')
                AND lease_owner=$3 AND lease_expires_at>clock_timestamp()
            RETURNING progress`,
            [request.jobId, owner.ownerUserId, request.leaseOwner]
          );
          if (started.rowCount !== 1) {
            throw repositoryError("System Archive import lease or state was lost.", 409);
          }
          const progress = started.rows[0]?.progress as Partial<{
            archiveFingerprint: unknown;
            commitIdempotencyKeyHash: unknown;
            previewProjection: unknown;
          }> | undefined;
          if (progress?.previewProjection !== undefined) {
            previewProjection = parsePersistedPreviewProjection(progress.previewProjection);
            if (progress.archiveFingerprint !== previewProjection.archiveFingerprint) {
              throw repositoryError("System Archive preview fingerprint binding was lost.", 409);
            }
          } else if (progress?.commitIdempotencyKeyHash !== undefined) {
            throw repositoryError("System Archive persisted preview reconciliation was lost.", 409);
          }
        }
        const current = await fingerprint(client, owner, request.ignore);
        if (!current.destinationEmpty || !sameFingerprint(request.destination, current)) {
          throw repositoryError("System Archive destination changed after preview.", 409);
        }
        const restoreDeferredRecords = async () => {
          persistedCounts.prompts += await restorePendingPrompts(
            client,
            owner.ownerUserId,
            pendingPrompts,
            restoredPromptIds
          );
        };
        const reconcileLogicalCounts = () => {
          for (const domain of SYSTEM_ARCHIVE_DOMAINS) {
            if (expectedCounts[domain] !== persistedCounts[domain]) {
              throw repositoryError(
                `System Archive ${domain} inventory did not match rows actually persisted.`,
                409
              );
            }
          }
        };
        let lastDomainIndex = -1;
        const transaction: SystemArchiveAtomicImportTransaction = {
          database: client,
          async insertLogicalDomains(records) {
            if (reportRecorded) {
              throw repositoryError("System Archive authority cannot change after its Import Report.", 409);
            }
            for await (const candidate of asyncRecords(records)) {
              const envelope = systemRecordEnvelopeSchema.parse(candidate);
              const domainIndex = SYSTEM_ARCHIVE_DOMAINS.indexOf(envelope.domain);
              if (domainIndex < lastDomainIndex) {
                throw repositoryError("System Archive logical domains are not dependency ordered.", 400);
              }
              lastDomainIndex = domainIndex;
              expectedCounts[envelope.domain] += 1;
              const persisted = await insertLogicalRecord(
                client,
                owner.ownerUserId,
                envelope,
                pendingPrompts,
                pendingIllustrations
              );
              if (persisted) persistedCounts[envelope.domain] += 1;
              if ("campaignId" in envelope.record && envelope.record.campaignId) {
                campaignIds.add(envelope.record.campaignId);
              }
              if (envelope.domain === "campaigns") campaignIds.add(envelope.record.sourceId);
            }
            return Object.freeze({
              recordsByDomain: Object.freeze({ ...persistedCounts }),
              campaignIds: Object.freeze([...campaignIds].sort()),
              assetIds: Object.freeze([...assetIds].sort())
            });
          },
          async insertOriginalAsset(asset, persistence) {
            if (reportRecorded) {
              throw repositoryError("System Archive authority cannot change after its Import Report.", 409);
            }
            const inserted = await client.query(
              `INSERT INTO assets (
                 id,owner_user_id,campaign_id,turn_id,content_hash,storage_driver,storage_path,
                 mime_type,byte_length,pixel_width,pixel_height,technical_metadata,
                 filesystem_operation_id,created_at
               ) VALUES ($1,$2,NULL,NULL,$3,'filesystem',$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
              [
                asset.sourceAssetId,
                owner.ownerUserId,
                asset.contentHash,
                persistence.storagePath,
                asset.mimeType,
                asset.byteLength,
                asset.pixelWidth,
                asset.pixelHeight,
                json(asset.technicalMetadata),
                persistence.filesystemOperationId,
                asset.createdAt
              ]
            );
            if (inserted.rowCount !== 1) throw new Error("System Archive asset insert failed.");
            if (!assetIds.has(asset.sourceAssetId)) {
              assetIds.add(asset.sourceAssetId);
              persistedAssetBytes += asset.byteLength;
            }
          },
          async insertAssetBindings(asset) {
            if (reportRecorded) {
              throw repositoryError("System Archive authority cannot change after its Import Report.", 409);
            }
            persistedCounts.illustrations += await insertAssetBindings(
              client,
              owner.ownerUserId,
              asset,
              pendingIllustrations,
              restoredIllustrationIds
            );
            if (!assetIds.has(asset.sourceAssetId)) {
              assetIds.add(asset.sourceAssetId);
              persistedAssetBytes += asset.byteLength;
            }
          },
          async recordImportReport(report) {
            if (reportRecorded) {
              throw repositoryError("System Archive Import Report was already recorded.", 409);
            }
            const parsedReport = systemArchiveImportReportSchema.parse(report);
            await restoreDeferredRecords();
            reconcileLogicalCounts();
            for (const domain of SYSTEM_ARCHIVE_DOMAINS) {
              if (parsedReport.recordsByDomain[domain] !== persistedCounts[domain]) {
                throw repositoryError(
                  `System Archive ${domain} report did not match rows actually persisted.`,
                  409
                );
              }
            }
            if (parsedReport.assetCount !== assetIds.size
              || parsedReport.assetBytes !== persistedAssetBytes) {
              throw repositoryError("System Archive asset report did not match bytes actually persisted.", 409);
            }
            if (parsedReport.ownerMapping.destinationOwnerId !== owner.ownerUserId
              || parsedReport.disabledProviders !== persistedCounts.providers
              || parsedReport.rebuildState.chronicleCampaigns !== campaignIds.size
              || parsedReport.rebuildState.assets !== assetIds.size
              || parsedReport.errors.length !== 0) {
              throw repositoryError("System Archive Import Report did not match restored authority.", 409);
            }
            if (previewProjection !== null) {
              for (const domain of SYSTEM_ARCHIVE_DOMAINS) {
                if (previewProjection.recordsByDomain[domain] !== persistedCounts[domain]) {
                  throw repositoryError(
                    `System Archive ${domain} preview did not match rows actually persisted.`,
                    409
                  );
                }
              }
              if (previewProjection.assets.originalCount !== assetIds.size
                || previewProjection.assets.totalBytes !== persistedAssetBytes
                || previewProjection.ownerMapping.sourceOwnerId !== parsedReport.ownerMapping.sourceOwnerId
                || previewProjection.ownerMapping.destinationOwnerId !== parsedReport.ownerMapping.destinationOwnerId
                || previewProjection.disabledProviders !== parsedReport.disabledProviders
                || stableStringify(previewProjection.normalization) !== stableStringify(parsedReport.normalization)
                || stableStringify(previewProjection.invalidatedAccess) !== stableStringify(parsedReport.invalidatedAccess)
                || previewProjection.archiveFingerprint !== parsedReport.archiveFingerprint) {
                throw repositoryError("System Archive preview did not reconcile with imported authority.", 409);
              }
            }
            await normalizeImportedIllustrations(client, owner.ownerUserId);
            const durableReport = systemArchiveImportReportSchema.parse({
              ...parsedReport,
              recordsByDomain: { ...persistedCounts },
              assetCount: assetIds.size,
              assetBytes: persistedAssetBytes,
              disabledProviders: persistedCounts.providers,
              rebuildState: {
                status: "pending",
                chronicleCampaigns: campaignIds.size,
                assets: assetIds.size
              }
            });
            reportRecorded = true;
            if (!request.jobId) return;
            const updated = await client.query(
              `UPDATE system_archive_jobs
                  SET status='authoritative_committed',report=$3::jsonb,
                      progress=progress || $4::jsonb,updated_at=clock_timestamp()
                WHERE id=$1 AND owner_user_id=$2 AND kind='import' AND status='importing'
                  AND lease_owner=$5 AND lease_expires_at>clock_timestamp()`,
              [
                request.jobId,
                owner.ownerUserId,
                json(durableReport),
                json({
                  rebuildCampaignIds: [...campaignIds].sort(),
                  rebuildAssetIds: [...assetIds].sort()
                }),
                request.leaseOwner
              ]
            );
            if (updated.rowCount !== 1) {
              throw repositoryError("System Archive import lease or state was lost.", 409);
            }
          }
        };
        const result = await work(Object.freeze(transaction));
        await restoreDeferredRecords();
        reconcileLogicalCounts();
        if (request.jobId && !reportRecorded) {
          throw repositoryError("System Archive import completed without a durable Import Report.", 409);
        }
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async enqueueDerivedRebuilds(owner, request) {
      const campaignIds = [...new Set(request.campaignIds)].sort();
      const assetIds = [...new Set(request.assetIds)].sort();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (campaignIds.length > 0) {
          const inserted = await client.query(
            `INSERT INTO chronicle_jobs (owner_user_id,campaign_id,job_type,status)
             SELECT $1,campaign.id,'reindex_campaign','queued'
               FROM campaigns campaign
              WHERE campaign.owner_user_id=$1 AND campaign.id=ANY($2::uuid[])
             ON CONFLICT (campaign_id,job_type) WHERE status IN ('queued','running')
             DO NOTHING`,
            [owner.ownerUserId, campaignIds]
          );
          const visible = await client.query<{ count: string }>(
            `SELECT count(DISTINCT campaign_id)::bigint AS count
               FROM chronicle_jobs
              WHERE owner_user_id=$1 AND campaign_id=ANY($2::uuid[])
                AND job_type='reindex_campaign' AND status IN ('queued','running')`,
            [owner.ownerUserId, campaignIds]
          );
          if (Number(visible.rows[0]?.count ?? 0) !== campaignIds.length) {
            throw new Error(`System Archive Chronicle rebuild enqueue was incomplete (${inserted.rowCount}).`);
          }
        }
        if (assetIds.length > 0) {
          await client.query(
            `INSERT INTO asset_metadata_backfill_jobs (owner_user_id,asset_id,status)
             SELECT $1,asset.id,'queued'
               FROM assets asset
              WHERE asset.owner_user_id=$1 AND asset.id=ANY($2::uuid[])
             ON CONFLICT (asset_id,owner_user_id) DO NOTHING`,
            [owner.ownerUserId, assetIds]
          );
          const visible = await client.query<{ count: string }>(
            `SELECT count(*)::bigint AS count
               FROM asset_metadata_backfill_jobs
              WHERE owner_user_id=$1 AND asset_id=ANY($2::uuid[])
                AND status IN ('queued','running','recoverable','completed')`,
            [owner.ownerUserId, assetIds]
          );
          if (Number(visible.rows[0]?.count ?? 0) !== assetIds.length) {
            throw new Error("System Archive thumbnail rebuild enqueue was incomplete.");
          }
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async reserveOriginalAssetIdentity(owner, assetId, command) {
      if (command.owner.ownerUserId !== owner.ownerUserId
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(assetId)
        || !command.idempotencyKey.trim()) {
        throw repositoryError("System Archive asset publication identity is invalid.", 400);
      }
      const keyHash = createHash("sha256").update(command.idempotencyKey).digest("hex");
      const requestFingerprint = publicationFingerprint(command);
      const result = await pool.query<{
        asset_id: string;
        owner_user_id: string;
        lifecycle: string;
        request_fingerprint: string | null;
      }>(
        `INSERT INTO asset_publication_identities (
           asset_id,owner_user_id,idempotency_key_hash,request_fingerprint,lifecycle
         ) VALUES ($1,$2,$3,$4,'prepared')
         ON CONFLICT (asset_id) DO UPDATE
           SET updated_at=asset_publication_identities.updated_at
         RETURNING asset_id,owner_user_id,lifecycle,request_fingerprint`,
        [assetId, owner.ownerUserId, keyHash, requestFingerprint]
      );
      const row = result.rows[0];
      if (!row
        || row.owner_user_id !== owner.ownerUserId
        || row.request_fingerprint !== requestFingerprint
        || !["prepared", "attached", "published"].includes(row.lifecycle)) {
        throw repositoryError("System Archive asset publication identity conflicts with existing authority.", 409);
      }
      return Object.freeze({
        assetId: row.asset_id,
        ownerUserId: row.owner_user_id,
        lifecycle: row.lifecycle
      }) as unknown as PrivateAssetPublicationIdentity;
    },

    async markImportedJobRebuilding(owner, jobId, leaseOwner) {
      const updated = await pool.query(
        `UPDATE system_archive_jobs
            SET status='rebuilding',
                report=jsonb_set(report,'{rebuildState,status}','"queueing"'::jsonb),
                updated_at=clock_timestamp()
          WHERE id=$1 AND owner_user_id=$2 AND kind='import'
            AND status IN ('authoritative_committed','rebuilding')
            AND lease_owner=$3 AND lease_expires_at>clock_timestamp()`,
        [jobId, owner.ownerUserId, leaseOwner]
      );
      if (updated.rowCount !== 1) {
        throw repositoryError("System Archive import rebuild lease is unavailable.", 409);
      }
    },

    async completeImportedJob(owner, jobId, leaseOwner) {
      const updated = await pool.query(
        `UPDATE system_archive_jobs
            SET status='completed',
                report=jsonb_set(report,'{rebuildState,status}','"queued"'::jsonb),
                lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE id=$1 AND owner_user_id=$2 AND kind='import'
            AND status IN ('authoritative_committed','rebuilding')
            AND lease_owner=$3 AND lease_expires_at>clock_timestamp()`,
        [jobId, owner.ownerUserId, leaseOwner]
      );
      if (updated.rowCount !== 1) {
        throw repositoryError("System Archive import completion lease is unavailable.", 409);
      }
    }
  };
  return Object.freeze(repository);
}
