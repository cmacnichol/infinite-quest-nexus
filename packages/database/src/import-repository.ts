import { createHash, randomBytes } from "node:crypto";
import {
  toPortableArchiveExportRetrieval,
  toPortableImportedRecordId,
  toPortableImportResultRetrieval,
  toPortablePreviewHandle,
  toPortableSourceInstallationId,
  toPortableStagedInput,
  type ImportOwnerScope,
  type PortableArchiveDiagnosticCode,
  type PortableArchiveExportRetrieval,
  type PortableArchiveExportView,
  type PortableImportCommitView,
  type PortableImportedRecordId,
  type PortableImportKind,
  type PortableImportPreviewCommand,
  type PortableImportPreviewProjectionFor,
  type PortableImportPreviewView,
  type PortableImportResultProjectionFor,
  type PortableImportResultRetrieval,
  type PortableImportResultView,
  type PortablePreviewDestination,
  type PortablePreviewHandle,
  type PortableSourceInstallationId,
  type PortableStagedInput
} from "../../application/src/imports/index.js";
import type {
  AttachedFilesystemOperation,
  DurableFilesystemCleanupCompletionResult,
  DurableFilesystemRecoveryClaim,
  DurableFilesystemRecoveryRecord,
  DurableFilesystemOperationId,
  DurableFilesystemTransactionContext,
  PrivateStorageDescriptor
} from "../../application/src/assets/private-storage-lifecycle.js";
import {
  bindPrivatePortableExportCleanupPreparation,
  bindPrivatePortableExportRehydration,
  bindPrivatePortableStagedCleanupPreparation,
  bindPrivatePortableStagedRehydration,
  type PrivatePortableCleanupUnavailable,
  type PrivatePortableExportCleanupPreparation,
  type PrivatePortableExportRehydration,
  type PrivatePortableRepositoryPort,
  type PrivatePortableStagedCleanupPreparation,
  type PrivatePortableStagedRehydration
} from "../../application/src/imports/private-portable-repository.js";
import type { PortableExportScope as PrivatePortableExportScope } from "../../application/src/imports/private-portable-authority.js";
import { stableStringify } from "../../domain/src/text.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

export type PortableImportRepositoryErrorCode =
  | "archive_expired"
  | "archive_unavailable"
  | "import_conflict"
  | "import_idempotency_mismatch"
  | "import_invalid"
  | "transaction_unavailable";

/** Stable, allowlisted repository failure. It never carries SQL, paths, or caught error text. */
export class PortableImportRepositoryError extends Error {
  constructor(readonly code: PortableImportRepositoryErrorCode, readonly statusCode: number) {
    super(code);
    this.name = "PortableImportRepositoryError";
  }
}

const DIAGNOSTIC_CODES = new Set<PortableArchiveDiagnosticCode>([
  "archive_cleanup_required",
  "archive_containment_denied",
  "archive_entry_limit_exceeded",
  "archive_expired",
  "archive_format_invalid",
  "archive_link_denied",
  "archive_path_invalid",
  "archive_size_limit_exceeded",
  "archive_truncated",
  "archive_unavailable",
  "import_conflict",
  "import_idempotency_mismatch",
  "import_invalid",
  "transaction_unavailable"
]);

type DatabaseDestination = Readonly<{
  destinationKind: "embedded_create_world" | "existing_world_version" | "create_world";
  destinationWorldId: string | null;
  destinationWorldVersionId: string | null;
  fingerprint: string;
}>;

type DescriptorRow = Readonly<{
  relative_path: string;
  device_id: string;
  file_id: string;
  change_token: string;
  content_hash: string;
  byte_length: string;
}>;

type PortableDescriptorRow = DescriptorRow & Readonly<{
  descriptor_role: "delivery" | "cleanup";
  ordinal: number;
}>;

type PortableFilesystemLifecycle = "attached" | "finalized" | "cleanup_pending" | "cleaned";

type PortableFilesystemAuthorityRow = Readonly<{
  id: string;
  owner_user_id: string;
  operation_scope_hash: string;
  purpose: "portable_staging" | "portable_export";
  lifecycle: PortableFilesystemLifecycle;
  candidate_token_hash: string | null;
  lease_id: string;
  lease_owner: string;
  work_version: number;
  lease_expires_at: Date;
  expires_at: Date;
}>;

type PortableStagedAuthorityRow = Readonly<{
  staged_input_id: string;
  staged_owner_user_id: string;
  handle_token_hash: string;
  filesystem_operation_id: string;
  status: "staged" | "consumed" | "expired" | "failed" | "cleanup_pending" | "cleaned";
  staged_content_hash: string;
  staged_byte_length: string;
  staged_expires_at: Date;
}>;

type PortableExportAuthorityRow = Readonly<{
  artifact_id: string;
  artifact_owner_user_id: string;
  retrieval_token_hash: string;
  filesystem_operation_id: string;
  export_kind: "campaign_zip" | "world_json";
  campaign_id: string | null;
  world_id: string;
  world_version_id: string;
  content_type: "application/zip" | "application/json";
  status: "ready" | "consumed" | "expired" | "failed" | "cleanup_pending" | "cleaned";
  artifact_content_hash: string;
  artifact_byte_length: string;
  artifact_expires_at: Date;
}>;

type PreviewRow = Readonly<{
  id: string;
  staged_input_id: string;
  import_kind: PortableImportKind;
  status: string;
  content_fingerprint: string;
  destination_fingerprint: string;
  source_installation_id: string | null;
  source_record_id: string | null;
  preview_projection: unknown;
  diagnostic_codes: string[];
  idempotency_key_hash: string | null;
  commit_request_fingerprint: string | null;
  import_id: string | null;
  result_projection: unknown;
  expires_at: Date;
}>;

type StoredCommitProjection = Readonly<{
  importedRecordId: string;
  duplicate: boolean;
  result: unknown;
}>;

type ImportScopeRow = Readonly<{
  id: string;
  world_id: string | null;
  world_version_id: string | null;
  campaign_id: string | null;
}>;

type StagedStateRow = Readonly<{
  status: string;
  expires_at: Date;
}>;

declare const portableImportCommitClaimBrand: unique symbol;
const portableImportTransactionIdentity: unique symbol = Symbol("portableImportTransactionIdentity");
type PostgreSqlTransactionIdentity = Readonly<{
  backendId: string;
  transactionId: string;
}>;
export type PortableImportCommitClaim<Kind extends PortableImportKind = PortableImportKind> = Readonly<{
  operationId: string;
  ownerUserId: string;
  kind: Kind;
  requestFingerprint: string;
  resultRetrieval: PortableImportResultRetrieval<Kind>;
  [portableImportTransactionIdentity]: PostgreSqlTransactionIdentity;
  [portableImportCommitClaimBrand]: true;
}>;

export type PortableImportBeginResult<Kind extends PortableImportKind> =
  | Readonly<{
    outcome: "ready";
    claim: PortableImportCommitClaim<Kind>;
    preview: Readonly<{
      projection: PortableImportPreviewProjectionFor<Kind>;
      diagnostics: readonly PortableArchiveDiagnosticCode[];
      contentFingerprint: string;
      sourceInstallationId?: PortableSourceInstallationId;
      importedRecordId?: PortableImportedRecordId;
    }>;
  }>
  | Readonly<{ outcome: "replay"; view: PortableImportCommitView<Kind> }>;

export type PortablePreviewPayload<Kind extends PortableImportKind> = Readonly<{
  stagedInputId: string;
  kind: Kind;
  destination: PortablePreviewDestination;
  contentFingerprint: string;
  projection: PortableImportPreviewProjectionFor<Kind>;
  diagnostics: readonly PortableArchiveDiagnosticCode[];
  expiresAt: string;
  sourceInstallationId?: PortableSourceInstallationId;
  importedRecordId?: PortableImportedRecordId;
}>;

export type PortableStagedPayload = Readonly<{
  stagedInputId: string;
  filesystemOperationId: DurableFilesystemOperationId;
  contentHash: string;
  byteLength: number;
  expiresAt: string;
  descriptor: PrivateStorageDescriptor;
}>;

export type PortableExportScope = PrivatePortableExportScope;

export type PortableExportPayload = Readonly<{
  artifactId: string;
  contentType: PortableArchiveExportView["contentType"];
  contentHash: string;
  byteLength: number;
  expiresAt: string;
  descriptor: PrivateStorageDescriptor;
}>;

export type RegisterStagedInputRequest = ImportOwnerScope & Readonly<{
  filesystemOperationId: string;
  operationScopeId: string;
  contentHash: string;
  byteLength: number;
  expiresAt: string;
}>;

export type CreatePortablePreviewRequest<Command extends PortableImportPreviewCommand> = Readonly<{
  command: Command;
  contentFingerprint: string;
  projection: PortableImportPreviewProjectionFor<Command["kind"]>;
  diagnostics: readonly PortableArchiveDiagnosticCode[];
  expiresAt: string;
}>;

export type CompletePortableImportRequest<Kind extends PortableImportKind> = Readonly<{
  importId: string;
  importedRecordId: PortableImportedRecordId;
  duplicate: boolean;
  diagnostics: readonly PortableArchiveDiagnosticCode[];
  result: PortableImportResultProjectionFor<Kind>;
  resultExpiresAt: string;
}>;

export type PortableImportCommitRepositoryCommand<
  Kind extends PortableImportKind = PortableImportKind,
  Destination extends PortablePreviewDestination = PortablePreviewDestination,
> = ImportOwnerScope & Readonly<{
  kind: Kind;
  destination: Destination;
  previewHandle: PortablePreviewHandle<Destination>;
  idempotencyKey: string;
}>;

export type RegisterPortableExportRequest = PortableExportScope & Readonly<{
  filesystemOperationId: string;
  operationScopeId: string;
  contentType: PortableArchiveExportView["contentType"];
  contentHash: string;
  byteLength: number;
  expiresAt: string;
}>;

export interface PostgresPortableImportRepository extends PrivatePortableRepositoryPort {
  registerStagedInput(request: RegisterStagedInputRequest): Promise<PortableStagedInput>;
  retrieveStagedPayload(owner: ImportOwnerScope, stagedInput: PortableStagedInput): Promise<PortableStagedPayload | null>;
  createPreview<Command extends PortableImportPreviewCommand>(
    request: CreatePortablePreviewRequest<Command>,
  ): Promise<PortableImportPreviewView<Command>>;
  retrievePreviewPayload<Kind extends PortableImportKind, Destination extends PortablePreviewDestination>(
    owner: ImportOwnerScope,
    kind: Kind,
    previewHandle: PortablePreviewHandle<Destination>,
  ): Promise<PortablePreviewPayload<Kind> | null>;
  beginImport<Kind extends PortableImportKind, Destination extends PortablePreviewDestination>(
    client: DatabaseClient,
    command: PortableImportCommitRepositoryCommand<Kind, Destination>,
  ): Promise<PortableImportBeginResult<Kind>>;
  completeImport<Kind extends PortableImportKind>(
    client: DatabaseClient,
    claim: PortableImportCommitClaim<Kind>,
    completion: CompletePortableImportRequest<Kind>,
  ): Promise<PortableImportCommitView<Kind>>;
  retrieveImportResult<Kind extends PortableImportKind>(
    owner: ImportOwnerScope,
    kind: Kind,
    retrieval: PortableImportResultRetrieval<Kind>,
  ): Promise<PortableImportResultView<Kind> | null>;
  registerExportArtifact(request: RegisterPortableExportRequest): Promise<PortableArchiveExportView>;
  retrieveExportArtifact(
    scope: PortableExportScope,
    retrieval: PortableArchiveExportRetrieval,
  ): Promise<PortableExportPayload | null>;
}

function repositoryError(
  code: PortableImportRepositoryErrorCode,
  statusCode: number,
): PortableImportRepositoryError {
  return new PortableImportRepositoryError(code, statusCode);
}

function postgresErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

async function requireCallerTransaction(client: DatabaseClient): Promise<DatabaseClient> {
  try {
    await client.query("SAVEPOINT portable_import_repository_context");
    await client.query("RELEASE SAVEPOINT portable_import_repository_context");
  } catch {
    throw repositoryError("transaction_unavailable", 503);
  }
  return client;
}

async function currentTransactionIdentity(client: DatabaseClient): Promise<PostgreSqlTransactionIdentity> {
  const selected = await client.query<Readonly<{ backend_id: string; transaction_id: string }>>(
    `SELECT pg_backend_pid()::text AS backend_id,
            pg_current_xact_id()::text AS transaction_id`
  );
  const row = selected.rows[0];
  if (!row) throw repositoryError("transaction_unavailable", 503);
  return { backendId: row.backend_id, transactionId: row.transaction_id };
}

async function requireClaimTransaction<Kind extends PortableImportKind>(
  client: DatabaseClient,
  claim: PortableImportCommitClaim<Kind>,
): Promise<void> {
  const expected = claim[portableImportTransactionIdentity];
  const current = await currentTransactionIdentity(client);
  if (!expected
    || expected.backendId !== current.backendId
    || expected.transactionId !== current.transactionId) {
    throw repositoryError("transaction_unavailable", 503);
  }
}

async function safeRepositoryCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PortableImportRepositoryError) throw error;
    throw repositoryError("archive_unavailable", 503);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function portableImportLockKey(
  ownerUserId: string,
  kind: PortableImportKind,
  contentFingerprint: string,
  destinationFingerprint: string,
): string {
  return `infinite-quest-nexus:portable-import:${ownerUserId}:${kind}:${contentFingerprint}:${destinationFingerprint}`;
}

function portableImportIdempotencyLockKey(
  ownerUserId: string,
  kind: PortableImportKind,
  idempotencyKeyHash: string,
): string {
  return `infinite-quest-nexus:portable-import-idempotency:${ownerUserId}:${kind}:${idempotencyKeyHash}`;
}

async function lockPortableImportKeys(client: DatabaseClient, keys: readonly string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
  }
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function randomPreviewToken(): string {
  return `${randomToken()}.${randomToken()}`;
}

function finiteFutureTimestamp(value: string, code: PortableImportRepositoryErrorCode): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) throw repositoryError(code, 400);
  return new Date(timestamp).toISOString();
}

function contentHash(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw repositoryError("import_invalid", 400);
  return value;
}

function byteLength(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw repositoryError("import_invalid", 400);
  return value;
}

function diagnostics(values: readonly PortableArchiveDiagnosticCode[]): PortableArchiveDiagnosticCode[] {
  if (!values.every((value) => DIAGNOSTIC_CODES.has(value))) {
    throw repositoryError("import_invalid", 400);
  }
  return [...values];
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw repositoryError("import_invalid", 400);
  }
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    throw repositoryError("import_invalid", 400);
  }
}

function databaseDestination(destination: PortablePreviewDestination): DatabaseDestination {
  if (destination.kind === "embedded") {
    return {
      destinationKind: "embedded_create_world",
      destinationWorldId: null,
      destinationWorldVersionId: null,
      fingerprint: sha256(stableStringify(destination))
    };
  }
  if (destination.kind === "existing_world_version") {
    return {
      destinationKind: "existing_world_version",
      destinationWorldId: destination.worldId,
      destinationWorldVersionId: destination.worldVersionId,
      fingerprint: sha256(stableStringify(destination))
    };
  }
  return {
    destinationKind: "create_world",
    destinationWorldId: null,
    destinationWorldVersionId: null,
    fingerprint: sha256(stableStringify(destination))
  };
}

function databaseByteLength(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw repositoryError("archive_unavailable", 503);
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw repositoryError("archive_unavailable", 503);
  }
  return Number(parsed);
}

function databaseContentHash(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw repositoryError("archive_unavailable", 503);
  }
  return value;
}

function privateDescriptor(
  row: DescriptorRow,
  expectedContentHash: string,
  expectedByteLength: string,
): PrivateStorageDescriptor {
  const descriptorHash = databaseContentHash(row.content_hash);
  const descriptorLength = databaseByteLength(row.byte_length);
  const storedHash = databaseContentHash(expectedContentHash);
  const storedLength = databaseByteLength(expectedByteLength);
  if (storedHash !== descriptorHash || storedLength !== descriptorLength) {
    throw repositoryError("archive_unavailable", 503);
  }
  return {
    relativePath: row.relative_path,
    identity: {
      deviceId: row.device_id,
      fileId: row.file_id,
      changeToken: row.change_token
    },
    contentHash: descriptorHash,
    byteLength: descriptorLength
  };
}

function portableDiagnostics(values: string[]): PortableArchiveDiagnosticCode[] {
  if (!values.every((value) => DIAGNOSTIC_CODES.has(value as PortableArchiveDiagnosticCode))) {
    throw repositoryError("archive_unavailable", 503);
  }
  return values as PortableArchiveDiagnosticCode[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonnegativeInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isCharacterArray(value: unknown, idKey: "id" | "index"): boolean {
  return Array.isArray(value) && value.every((character) => isRecord(character)
    && (idKey === "id" ? isString(character.id) : isNonnegativeInteger(character.index))
    && isString(character.name));
}

function hasHistoryCounts(value: unknown): boolean {
  return isRecord(value)
    && isNonnegativeInteger(value.turns)
    && isNonnegativeInteger(value.completeHistoryCharacters)
    && isNonnegativeInteger(value.estimatedHistoryTokens);
}

function hasWorldCounts(value: unknown): boolean {
  return isRecord(value)
    && isNonnegativeInteger(value.entities)
    && isNonnegativeInteger(value.relationships)
    && isNonnegativeInteger(value.triggers);
}

function validCampaignDestination(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.kind) || !isString(value.operation)) return false;
  if (value.kind === "embedded") {
    return value.operation === "create_world" && value.worldId === null && value.worldVersionId === null;
  }
  return value.kind === "existing_world_version"
    && value.operation === "attach_existing_world_version"
    && isString(value.worldId)
    && isString(value.worldVersionId);
}

function campaignDestinationMatches(
  projection: unknown,
  destination: PortablePreviewDestination,
): boolean {
  if (!isRecord(projection) || !isRecord(projection.destination)) return false;
  const projected = projection.destination;
  if (destination.kind === "embedded") {
    return projected.kind === "embedded"
      && projected.operation === "create_world"
      && projected.worldId === null
      && projected.worldVersionId === null;
  }
  return destination.kind === "existing_world_version"
    && projected.kind === "existing_world_version"
    && projected.operation === "attach_existing_world_version"
    && projected.worldId === destination.worldId
    && projected.worldVersionId === destination.worldVersionId;
}

function validCampaignPreview(value: JsonRecord): boolean {
  if (value.valid !== true
    || value.archiveType !== "campaign"
    || value.formatVersion !== 1
    || !isString(value.contentFingerprint)
    || !/^[0-9a-f]{64}$/.test(value.contentFingerprint)
    || !isRecord(value.campaign)
    || !isRecord(value.world)
    || !isRecord(value.chronicle)
    || !isRecord(value.assets)) return false;
  const selectedCharacter = value.campaign.selectedCharacter;
  return isString(value.campaign.title)
    && isString(value.campaign.sourceCampaignId)
    && isNonnegativeInteger(value.campaign.acceptedTurnCount)
    && isNonnegativeInteger(value.campaign.activeTurnNumber)
    && value.campaign.activeTurnNumber <= value.campaign.acceptedTurnCount
    && (selectedCharacter === null
      || (isRecord(selectedCharacter) && isString(selectedCharacter.id) && isString(selectedCharacter.name)))
    && isString(value.world.title)
    && isString(value.world.sourceWorldId)
    && isString(value.world.sourceWorldVersionId)
    && isPositiveInteger(value.world.versionNumber)
    && isNonnegativeInteger(value.chronicle.memoryCount)
    && isNonnegativeInteger(value.chronicle.summaryCount)
    && isNonnegativeInteger(value.assets.originalCount)
    && isNonnegativeInteger(value.assets.totalBytes)
    && validCampaignDestination(value.destination)
    && value.providerDataIncluded === false
    && isStringArray(value.warnings);
}

function validLegacyStoryPreview(value: JsonRecord): boolean {
  return value.kind === "campaign"
    && typeof value.valid === "boolean"
    && isString(value.title)
    && typeof value.duplicate === "boolean"
    && isNullableString(value.existingCampaignId)
    && hasHistoryCounts(value.counts)
    && isStringArray(value.warnings);
}

function validWorldJsonPreview(value: JsonRecord): boolean {
  return value.kind === "world_json"
    && typeof value.valid === "boolean"
    && (value.valid === true
      ? isString(value.title)
      : value.duplicate === false && value.existingWorldId === null)
    && typeof value.duplicate === "boolean"
    && isNullableString(value.existingWorldId)
    && isCharacterArray(value.characters, "index")
    && hasWorldCounts(value.counts)
    && isStringArray(value.warnings);
}

function validCyoaPreview(value: JsonRecord): boolean {
  return value.kind === "cyoa_json"
    && typeof value.valid === "boolean"
    && typeof value.requiresProvider === "boolean"
    && isStringArray(value.warnings)
    && isRecord(value.counts)
    && isString(value.counts.topLevelTitle)
    && isNonnegativeInteger(value.counts.layer1ChaptersCount)
    && isString(value.counts.characterTarget);
}

function validWorldTextPreview(value: JsonRecord): boolean {
  return value.kind === "world_text"
    && typeof value.valid === "boolean"
    && value.requiresProvider === true
    && isStringArray(value.warnings)
    && isRecord(value.counts)
    && isNonnegativeInteger(value.counts.sourceCharacters)
    && isNonnegativeInteger(value.counts.sourceWords);
}

function validStoryTextPreview(value: JsonRecord): boolean {
  if (value.kind !== "story_text"
    || typeof value.valid !== "boolean"
    || !isStringArray(value.warnings)
    || !isRecord(value.counts)
    || !isNonnegativeInteger(value.counts.turns)) return false;
  const hasTarget = "targetWorldId" in value;
  if (!hasTarget) return value.valid === false;
  if (!isString(value.targetWorldId)
    || !isStringArray(value.diagnostics)
    || !isCharacterArray(value.characters, "id")
    || value.selectedCharacterId !== null && !isString(value.selectedCharacterId)) return false;
  if (!("title" in value)) return value.valid === false && value.selectedCharacterId === null;
  return isString(value.title)
    && typeof value.duplicate === "boolean"
    && isNullableString(value.existingCampaignId)
    && hasHistoryCounts(value.counts);
}

function isPreviewProjection(kind: PortableImportKind, value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (kind) {
    case "campaign_zip": return validCampaignPreview(value);
    case "legacy_story": return validLegacyStoryPreview(value);
    case "infinite_worlds":
    case "world_json": return validWorldJsonPreview(value);
    case "cyoa": return validCyoaPreview(value);
    case "world_text": return validWorldTextPreview(value);
    case "story_text": return validStoryTextPreview(value);
  }
}

function hasBaseImportResult(value: JsonRecord): boolean {
  return isString(value.importId)
    && isString(value.worldId)
    && isString(value.worldVersionId)
    && typeof value.duplicate === "boolean";
}

function validCampaignResult(value: JsonRecord): boolean {
  return hasBaseImportResult(value)
    && isString(value.campaignId)
    && isRecord(value.stats)
    && isNonnegativeInteger(value.stats.turnCount)
    && isNonnegativeInteger(value.stats.memoryCount)
    && isNonnegativeInteger(value.stats.summaryCount)
    && isNonnegativeInteger(value.stats.assetCount)
    && isNonnegativeInteger(value.stats.assetBytes);
}

function validStoryResult(value: JsonRecord, requireKind: boolean): boolean {
  return (!requireKind || value.kind === "campaign")
    && hasBaseImportResult(value)
    && isString(value.campaignId)
    && isRecord(value.stats)
    && isNonnegativeInteger(value.stats.turnCount)
    && isNonnegativeInteger(value.stats.memoryCount)
    && isNonnegativeInteger(value.stats.completeHistoryCharacters)
    && isNonnegativeInteger(value.stats.estimatedHistoryTokens)
    && typeof value.stats.importedSummary === "boolean"
    && isNonnegativeInteger(value.stats.sanitizedMemoryCount);
}

function isResultProjection(kind: PortableImportKind, value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (kind === "campaign_zip") return validCampaignResult(value);
  if (kind === "legacy_story") return validStoryResult(value, false);
  if (kind === "story_text") return validStoryResult(value, true);
  return value.kind === "world" && hasBaseImportResult(value);
}

function resultMatchesImport(
  kind: PortableImportKind,
  value: unknown,
  imported: ImportScopeRow,
  duplicate: boolean,
): boolean {
  if (!isRecord(value)) return false;
  const baseMatches = value.importId === imported.id
    && value.worldId === imported.world_id
    && value.worldVersionId === imported.world_version_id
    && value.duplicate === duplicate;
  if (!baseMatches) return false;
  return ["infinite_worlds", "cyoa", "world_json", "world_text"].includes(kind)
    || value.campaignId === imported.campaign_id;
}

function projectionFor<Kind extends PortableImportKind>(kind: Kind, value: unknown): PortableImportPreviewProjectionFor<Kind> {
  if (!isRecord(value) || !isPreviewProjection(kind, value)) {
    throw repositoryError("archive_unavailable", 503);
  }
  let projection: unknown;
  switch (kind) {
    case "campaign_zip": {
      const campaign = value.campaign as JsonRecord;
      const world = value.world as JsonRecord;
      const chronicle = value.chronicle as JsonRecord;
      const assets = value.assets as JsonRecord;
      const destination = value.destination as JsonRecord;
      const selectedCharacter = campaign.selectedCharacter as JsonRecord | null;
      projection = {
        valid: true,
        archiveType: "campaign",
        formatVersion: 1,
        contentFingerprint: value.contentFingerprint,
        campaign: {
          title: campaign.title,
          sourceCampaignId: campaign.sourceCampaignId,
          acceptedTurnCount: campaign.acceptedTurnCount,
          activeTurnNumber: campaign.activeTurnNumber,
          selectedCharacter: selectedCharacter === null ? null : {
            id: selectedCharacter.id,
            name: selectedCharacter.name
          }
        },
        world: {
          title: world.title,
          sourceWorldId: world.sourceWorldId,
          sourceWorldVersionId: world.sourceWorldVersionId,
          versionNumber: world.versionNumber
        },
        chronicle: {
          memoryCount: chronicle.memoryCount,
          summaryCount: chronicle.summaryCount
        },
        assets: {
          originalCount: assets.originalCount,
          totalBytes: assets.totalBytes
        },
        destination: destination.kind === "embedded" ? {
          kind: "embedded",
          operation: "create_world",
          worldId: null,
          worldVersionId: null
        } : {
          kind: "existing_world_version",
          operation: "attach_existing_world_version",
          worldId: destination.worldId,
          worldVersionId: destination.worldVersionId
        },
        providerDataIncluded: false,
        warnings: [...value.warnings as string[]]
      };
      break;
    }
    case "legacy_story": {
      const counts = value.counts as JsonRecord;
      projection = {
        kind: "campaign",
        valid: value.valid,
        title: value.title,
        duplicate: value.duplicate,
        existingCampaignId: value.existingCampaignId,
        counts: {
          turns: counts.turns,
          completeHistoryCharacters: counts.completeHistoryCharacters,
          estimatedHistoryTokens: counts.estimatedHistoryTokens
        },
        warnings: [...value.warnings as string[]]
      };
      break;
    }
    case "infinite_worlds":
    case "world_json": {
      const counts = value.counts as JsonRecord;
      projection = {
        kind: "world_json",
        valid: value.valid,
        ...(value.valid === true ? { title: value.title } : {}),
        duplicate: value.duplicate,
        existingWorldId: value.existingWorldId,
        characters: (value.characters as JsonRecord[]).map((character) => ({
          index: character.index,
          name: character.name
        })),
        counts: {
          entities: counts.entities,
          relationships: counts.relationships,
          triggers: counts.triggers
        },
        warnings: [...value.warnings as string[]]
      };
      break;
    }
    case "cyoa": {
      const counts = value.counts as JsonRecord;
      projection = {
        kind: "cyoa_json",
        valid: value.valid,
        requiresProvider: value.requiresProvider,
        warnings: [...value.warnings as string[]],
        counts: {
          topLevelTitle: counts.topLevelTitle,
          layer1ChaptersCount: counts.layer1ChaptersCount,
          characterTarget: counts.characterTarget
        }
      };
      break;
    }
    case "world_text": {
      const counts = value.counts as JsonRecord;
      projection = {
        kind: "world_text",
        valid: value.valid,
        requiresProvider: true,
        warnings: [...value.warnings as string[]],
        counts: {
          sourceCharacters: counts.sourceCharacters,
          sourceWords: counts.sourceWords
        }
      };
      break;
    }
    case "story_text": {
      const counts = value.counts as JsonRecord;
      if (!("targetWorldId" in value)) {
        projection = {
          kind: "story_text",
          valid: false,
          warnings: [...value.warnings as string[]],
          counts: { turns: counts.turns }
        };
        break;
      }
      const common = {
        kind: "story_text" as const,
        targetWorldId: value.targetWorldId,
        diagnostics: [...value.diagnostics as string[]],
        characters: (value.characters as JsonRecord[]).map((character) => ({
          id: character.id,
          name: character.name
        })),
        selectedCharacterId: value.selectedCharacterId,
        valid: value.valid,
        warnings: [...value.warnings as string[]]
      };
      projection = !("title" in value) ? {
        ...common,
        selectedCharacterId: null,
        valid: false,
        counts: { turns: counts.turns }
      } : {
        ...common,
        title: value.title,
        duplicate: value.duplicate,
        existingCampaignId: value.existingCampaignId,
        counts: {
          turns: counts.turns,
          completeHistoryCharacters: counts.completeHistoryCharacters,
          estimatedHistoryTokens: counts.estimatedHistoryTokens
        }
      };
      break;
    }
  }
  return projection as PortableImportPreviewProjectionFor<Kind>;
}

function boundProjectionFor<Kind extends PortableImportKind>(
  kind: Kind,
  value: unknown,
  destination: PortablePreviewDestination,
): PortableImportPreviewProjectionFor<Kind> {
  const projection = projectionFor(kind, value);
  if (kind === "campaign_zip" && !campaignDestinationMatches(projection, destination)) {
    throw repositoryError("archive_unavailable", 503);
  }
  if (kind === "story_text"
    && isRecord(projection)
    && "targetWorldId" in projection
    && (destination.kind !== "existing_world_version"
      || projection.targetWorldId !== destination.worldId)) {
    throw repositoryError("archive_unavailable", 503);
  }
  return projection;
}

function resultFor<Kind extends PortableImportKind>(kind: Kind, value: unknown): PortableImportResultProjectionFor<Kind> {
  if (!isRecord(value) || !isResultProjection(kind, value)) {
    throw repositoryError("archive_unavailable", 503);
  }
  let result: unknown;
  if (kind === "campaign_zip") {
    const stats = value.stats as JsonRecord;
    result = {
      importId: value.importId,
      worldId: value.worldId,
      worldVersionId: value.worldVersionId,
      campaignId: value.campaignId,
      duplicate: value.duplicate,
      stats: {
        turnCount: stats.turnCount,
        memoryCount: stats.memoryCount,
        summaryCount: stats.summaryCount,
        assetCount: stats.assetCount,
        assetBytes: stats.assetBytes
      }
    };
  } else if (kind === "legacy_story" || kind === "story_text") {
    const stats = value.stats as JsonRecord;
    result = {
      ...(kind === "story_text" ? { kind: "campaign" as const } : {}),
      importId: value.importId,
      worldId: value.worldId,
      worldVersionId: value.worldVersionId,
      campaignId: value.campaignId,
      duplicate: value.duplicate,
      stats: {
        turnCount: stats.turnCount,
        memoryCount: stats.memoryCount,
        completeHistoryCharacters: stats.completeHistoryCharacters,
        estimatedHistoryTokens: stats.estimatedHistoryTokens,
        importedSummary: stats.importedSummary,
        sanitizedMemoryCount: stats.sanitizedMemoryCount
      }
    };
  } else {
    result = {
      kind: "world",
      importId: value.importId,
      worldId: value.worldId,
      worldVersionId: value.worldVersionId,
      duplicate: value.duplicate
    };
  }
  return result as PortableImportResultProjectionFor<Kind>;
}

function commitRequestFingerprint(
  ownerUserId: string,
  kind: PortableImportKind,
  operationId: string,
  contentFingerprint: string,
  destinationFingerprint: string,
): string {
  return sha256(stableStringify({
    ownerUserId,
    kind,
    operationId,
    contentFingerprint,
    destinationFingerprint
  }));
}

function resultRetrievalToken<Kind extends PortableImportKind>(
  previewToken: string,
): PortableImportResultRetrieval<Kind> {
  const tokens = previewToken.split(".");
  const resultToken = tokens.length === 2 ? tokens[1] : undefined;
  if (!resultToken || resultToken.length < 40) throw repositoryError("import_invalid", 404);
  return toPortableImportResultRetrieval<Kind>(resultToken);
}

function storedCommit(value: unknown): StoredCommitProjection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw repositoryError("archive_unavailable", 503);
  }
  const record = value as Partial<StoredCommitProjection>;
  if (typeof record.importedRecordId !== "string"
    || typeof record.duplicate !== "boolean"
    || typeof record.result !== "object"
    || record.result === null
    || Array.isArray(record.result)) {
    throw repositoryError("archive_unavailable", 503);
  }
  return {
    importedRecordId: record.importedRecordId,
    duplicate: record.duplicate,
    result: record.result
  };
}

function commitView<Kind extends PortableImportKind>(
  kind: Kind,
  row: PreviewRow,
  retrieval: PortableImportResultRetrieval<Kind>,
  imported: ImportScopeRow,
): PortableImportCommitView<Kind> {
  const stored = storedCommit(row.result_projection);
  const result = resultFor(kind, stored.result);
  if (stored.importedRecordId !== imported.id
    || !resultMatchesImport(kind, result, imported, stored.duplicate)) {
    throw repositoryError("archive_unavailable", 503);
  }
  return {
    importedRecordId: toPortableImportedRecordId(stored.importedRecordId),
    retrieval,
    kind,
    duplicate: stored.duplicate,
    diagnostics: portableDiagnostics(row.diagnostic_codes),
    result
  };
}

function requirePortableClaimRequest(request: Readonly<{ leaseOwner: string; leaseSeconds: number }>): void {
  if (request.leaseOwner.trim().length === 0
    || !Number.isSafeInteger(request.leaseSeconds)
    || request.leaseSeconds <= 0) {
    throw repositoryError("import_invalid", 400);
  }
}

function portableOperation(row: PortableFilesystemAuthorityRow): AttachedFilesystemOperation {
  return {
    resourceKind: "portable",
    ownerUserId: row.owner_user_id,
    operationScopeId: row.operation_scope_hash,
    operationId: row.id as DurableFilesystemOperationId,
    purpose: row.purpose
  } as AttachedFilesystemOperation;
}

function portableClaim(row: PortableFilesystemAuthorityRow): DurableFilesystemRecoveryClaim {
  return {
    operationId: row.id as DurableFilesystemOperationId,
    leaseId: row.lease_id,
    leaseOwner: row.lease_owner,
    workVersion: row.work_version,
    leaseExpiresAt: row.lease_expires_at.toISOString()
  } as DurableFilesystemRecoveryClaim;
}

function portableOperationMatches(
  row: PortableFilesystemAuthorityRow,
  operation: AttachedFilesystemOperation,
): boolean {
  return operation.resourceKind === "portable"
    && row.id === operation.operationId
    && row.owner_user_id === operation.ownerUserId
    && row.purpose === operation.purpose
    && (row.operation_scope_hash === operation.operationScopeId
      || row.operation_scope_hash === sha256(operation.operationScopeId));
}

function portableRecoveryOperationMatches(
  row: PortableFilesystemAuthorityRow,
  operation: AttachedFilesystemOperation,
): boolean {
  return operation.resourceKind === "portable"
    && row.id === operation.operationId
    && row.owner_user_id === operation.ownerUserId
    && row.purpose === operation.purpose
    && row.operation_scope_hash === operation.operationScopeId;
}

function portableClaimIdentity(
  row: PortableFilesystemAuthorityRow,
  claim: DurableFilesystemRecoveryClaim,
): "valid" | "stale" | "lease_lost" {
  if (row.id !== claim.operationId || row.work_version !== claim.workVersion) return "stale";
  if (row.lease_id !== claim.leaseId
    || row.lease_owner !== claim.leaseOwner
    || row.lease_expires_at.toISOString() !== claim.leaseExpiresAt) return "lease_lost";
  return "valid";
}

async function databaseClock(client: DatabaseClient): Promise<Date> {
  const selected = await client.query<{ database_time: Date }>(
    "SELECT clock_timestamp() AS database_time"
  );
  const value = selected.rows[0]?.database_time;
  if (!value) throw repositoryError("archive_unavailable", 503);
  return value;
}

async function lockPortablePhysicalPaths(
  client: DatabaseClient,
  paths: readonly string[],
): Promise<Date> {
  let currentTime = await databaseClock(client);
  for (const relativePath of [...new Set(paths)].sort()) {
    const selected = await client.query<{ database_time: Date }>(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0)),
              clock_timestamp() AS database_time`,
      [`infinite-quest-nexus:asset-path:${relativePath}`]
    );
    currentTime = selected.rows[0]?.database_time ?? await databaseClock(client);
  }
  return currentTime;
}

async function lockedPortableOperation(
  client: DatabaseClient,
  operationId: string,
): Promise<PortableFilesystemAuthorityRow | null> {
  const selected = await client.query<PortableFilesystemAuthorityRow>(
    `SELECT id,owner_user_id,operation_scope_hash,purpose,lifecycle,candidate_token_hash,
            lease_id,lease_owner,work_version,lease_expires_at,expires_at
       FROM durable_filesystem_operations
      WHERE id=$1 AND resource_kind='portable'
        AND purpose IN ('portable_staging','portable_export')
      FOR UPDATE`,
    [operationId]
  );
  await databaseClock(client);
  return selected.rows[0] ?? null;
}

async function portableDescriptorRows(
  client: DatabaseClient,
  operationId: string,
): Promise<PortableDescriptorRow[]> {
  const selected = await client.query<PortableDescriptorRow>(
    `SELECT descriptor_role,ordinal,relative_path,device_id,file_id,change_token,
            content_hash,byte_length::text
       FROM durable_filesystem_descriptors
      WHERE operation_id=$1
      ORDER BY CASE descriptor_role WHEN 'cleanup' THEN 0 ELSE 1 END,ordinal`,
    [operationId]
  );
  return selected.rows;
}

function portableCleanupDescriptors(
  rows: readonly PortableDescriptorRow[],
  expectedContentHash: string,
  expectedByteLength: string,
): readonly [PrivateStorageDescriptor, ...PrivateStorageDescriptor[]] {
  const delivery = rows.filter((row) => row.descriptor_role === "delivery");
  if (delivery.length !== 1) throw repositoryError("archive_unavailable", 503);
  privateDescriptor(delivery[0]!, expectedContentHash, expectedByteLength);
  if (rows.length === 0) throw repositoryError("archive_unavailable", 503);
  return rows.map((row) => privateDescriptor(row, row.content_hash, row.byte_length)) as [
    PrivateStorageDescriptor,
    ...PrivateStorageDescriptor[]
  ];
}

function descriptorsMatch(
  actual: readonly PrivateStorageDescriptor[],
  expected: readonly PrivateStorageDescriptor[],
): boolean {
  return actual.length === expected.length && actual.every((descriptor, index) => {
    const value = expected[index];
    return value !== undefined
      && descriptor.relativePath === value.relativePath
      && descriptor.identity.deviceId === value.identity.deviceId
      && descriptor.identity.fileId === value.identity.fileId
      && descriptor.identity.changeToken === value.identity.changeToken
      && descriptor.contentHash === value.contentHash
      && descriptor.byteLength === value.byteLength;
  });
}

async function issuePortableClaim(
  client: DatabaseClient,
  row: PortableFilesystemAuthorityRow,
  portableExpiresAt: Date,
  request: Readonly<{ leaseOwner: string; leaseSeconds: number }>,
): Promise<PortableFilesystemAuthorityRow | null> {
  const updated = await client.query<PortableFilesystemAuthorityRow>(
    `UPDATE durable_filesystem_operations
        SET lease_id=gen_random_uuid(),lease_owner=$2,work_version=work_version+1,
            lease_expires_at=LEAST(expires_at,$3::timestamptz,
              clock_timestamp()+($4::text || ' seconds')::interval),
            updated_at=clock_timestamp()
      WHERE id=$1 AND owner_user_id=$5 AND resource_kind='portable' AND purpose=$6
        AND lifecycle IN ('attached','finalized')
        AND clock_timestamp() < expires_at
        AND clock_timestamp() < $3::timestamptz
      RETURNING id,owner_user_id,operation_scope_hash,purpose,lifecycle,candidate_token_hash,
                lease_id,lease_owner,work_version,lease_expires_at,expires_at`,
    [row.id, request.leaseOwner, portableExpiresAt, request.leaseSeconds, row.owner_user_id, row.purpose]
  );
  return updated.rows[0] ?? null;
}

async function lockedStagedAuthority(
  client: DatabaseClient,
  stagedInputId: string,
  ownerUserId: string,
  operationId: string,
  bearerHash?: string,
): Promise<PortableStagedAuthorityRow | null> {
  const selected = await client.query<PortableStagedAuthorityRow>(
    `SELECT id AS staged_input_id,owner_user_id AS staged_owner_user_id,
            handle_token_hash,filesystem_operation_id,status,
            content_hash AS staged_content_hash,byte_length::text AS staged_byte_length,
            expires_at AS staged_expires_at
       FROM portable_staged_inputs
      WHERE id=$1 AND owner_user_id=$2 AND filesystem_operation_id=$3
        AND ($4::text IS NULL OR handle_token_hash=$4)
      FOR UPDATE`,
    [stagedInputId, ownerUserId, operationId, bearerHash ?? null]
  );
  await databaseClock(client);
  return selected.rows[0] ?? null;
}

async function lockedExportAuthority(
  client: DatabaseClient,
  artifactId: string,
  scope: PortableExportScope,
  operationId: string,
  bearerHash?: string,
): Promise<PortableExportAuthorityRow | null> {
  const selected = await client.query<PortableExportAuthorityRow>(
    `SELECT id AS artifact_id,owner_user_id AS artifact_owner_user_id,
            retrieval_token_hash,filesystem_operation_id,export_kind,campaign_id,
            world_id,world_version_id,content_type,status,content_hash AS artifact_content_hash,
            byte_length::text AS artifact_byte_length,expires_at AS artifact_expires_at
       FROM portable_export_artifacts
      WHERE id=$1 AND owner_user_id=$2 AND filesystem_operation_id=$3
        AND export_kind=$4 AND campaign_id IS NOT DISTINCT FROM $5::uuid
        AND world_id=$6 AND world_version_id=$7
        AND ($8::text IS NULL OR retrieval_token_hash=$8)
      FOR UPDATE`,
    [
      artifactId,
      scope.ownerUserId,
      operationId,
      scope.exportKind,
      scope.campaignId,
      scope.worldId,
      scope.worldVersionId,
      bearerHash ?? null
    ]
  );
  await databaseClock(client);
  const row = selected.rows[0] ?? null;
  if (!row) return null;
  const expectedContentType = row.export_kind === "campaign_zip"
    ? "application/zip"
    : "application/json";
  return row.content_type === expectedContentType ? row : null;
}

async function rehydrateStagedInput(
  pool: DatabasePool,
  owner: ImportOwnerScope,
  stagedInput: PortableStagedInput,
  request: Readonly<{ leaseOwner: string; leaseSeconds: number }>,
): Promise<PrivatePortableStagedRehydration | null> {
  requirePortableClaimRequest(request);
  return withTransaction(pool, async (client) => {
    const bearerHash = sha256(stagedInput);
    const candidate = await client.query<{ staged_input_id: string; filesystem_operation_id: string }>(
      `SELECT id AS staged_input_id,filesystem_operation_id
         FROM portable_staged_inputs
        WHERE owner_user_id=$1 AND handle_token_hash=$2
        LIMIT 1`,
      [owner.ownerUserId, bearerHash]
    );
    const identity = candidate.rows[0];
    if (!identity) return null;
    const operation = await lockedPortableOperation(client, identity.filesystem_operation_id);
    if (!operation
      || operation.owner_user_id !== owner.ownerUserId
      || operation.purpose !== "portable_staging"
      || !operation.operation_scope_hash
      || !(["attached", "finalized"] as PortableFilesystemLifecycle[]).includes(operation.lifecycle)) return null;
    const staged = await lockedStagedAuthority(
      client,
      identity.staged_input_id,
      owner.ownerUserId,
      operation.id,
      bearerHash,
    );
    if (!staged || staged.status !== "staged") return null;
    const rows = await portableDescriptorRows(client, operation.id);
    const descriptors = portableCleanupDescriptors(rows, staged.staged_content_hash, staged.staged_byte_length);
    const currentTime = await lockPortablePhysicalPaths(client, descriptors.map((value) => value.relativePath));
    if (currentTime >= operation.expires_at || currentTime >= staged.staged_expires_at) return null;
    const claimed = await issuePortableClaim(client, operation, staged.staged_expires_at, request);
    if (!claimed) return null;
    const delivery = descriptors[descriptors.length - 1]!;
    return bindPrivatePortableStagedRehydration(
      { ownerUserId: owner.ownerUserId, stagedInput },
      portableOperation(claimed),
      portableClaim(claimed),
      delivery,
    );
  });
}

async function rehydrateExportArtifact(
  pool: DatabasePool,
  scope: PortableExportScope,
  retrieval: PortableArchiveExportRetrieval,
  request: Readonly<{ leaseOwner: string; leaseSeconds: number }>,
): Promise<PrivatePortableExportRehydration | null> {
  requirePortableClaimRequest(request);
  return withTransaction(pool, async (client) => {
    const bearerHash = sha256(retrieval);
    const candidate = await client.query<{ artifact_id: string; filesystem_operation_id: string }>(
      `SELECT id AS artifact_id,filesystem_operation_id
         FROM portable_export_artifacts
        WHERE owner_user_id=$1 AND retrieval_token_hash=$2
          AND export_kind=$3 AND campaign_id IS NOT DISTINCT FROM $4::uuid
          AND world_id=$5 AND world_version_id=$6
        LIMIT 1`,
      [scope.ownerUserId, bearerHash, scope.exportKind, scope.campaignId, scope.worldId, scope.worldVersionId]
    );
    const identity = candidate.rows[0];
    if (!identity) return null;
    const operation = await lockedPortableOperation(client, identity.filesystem_operation_id);
    if (!operation
      || operation.owner_user_id !== scope.ownerUserId
      || operation.purpose !== "portable_export"
      || !operation.operation_scope_hash
      || !(["attached", "finalized"] as PortableFilesystemLifecycle[]).includes(operation.lifecycle)) return null;
    const artifact = await lockedExportAuthority(client, identity.artifact_id, scope, operation.id, bearerHash);
    if (!artifact || artifact.status !== "ready") return null;
    const rows = await portableDescriptorRows(client, operation.id);
    const descriptors = portableCleanupDescriptors(rows, artifact.artifact_content_hash, artifact.artifact_byte_length);
    const currentTime = await lockPortablePhysicalPaths(client, descriptors.map((value) => value.relativePath));
    if (currentTime >= operation.expires_at || currentTime >= artifact.artifact_expires_at) return null;
    const claimed = await issuePortableClaim(client, operation, artifact.artifact_expires_at, request);
    if (!claimed) return null;
    const delivery = descriptors[descriptors.length - 1]!;
    return bindPrivatePortableExportRehydration(
      { exportScope: scope, retrieval, contentType: artifact.content_type },
      portableOperation(claimed),
      portableClaim(claimed),
      delivery,
    );
  });
}

function unavailable(outcome: PrivatePortableCleanupUnavailable["outcome"]): PrivatePortableCleanupUnavailable {
  return { outcome };
}

function cleanupClaimOutcome(
  row: PortableFilesystemAuthorityRow,
  claim: DurableFilesystemRecoveryClaim,
  currentTime: Date,
): "valid" | "stale" | "lease_lost" {
  const identity = portableClaimIdentity(row, claim);
  if (identity !== "valid") return identity;
  if (currentTime >= row.lease_expires_at) return "lease_lost";
  return "valid";
}

function activeClaimOutcome(
  row: PortableFilesystemAuthorityRow,
  claim: DurableFilesystemRecoveryClaim,
  currentTime: Date,
): "valid" | "stale" | "lease_lost" {
  const outcome = cleanupClaimOutcome(row, claim, currentTime);
  if (outcome !== "valid") return outcome;
  return currentTime >= row.expires_at ? "lease_lost" : "valid";
}

async function prepareStagedCleanup(
  database: DurableFilesystemTransactionContext,
  rehydration: PrivatePortableStagedRehydration,
): Promise<PrivatePortableStagedCleanupPreparation | PrivatePortableCleanupUnavailable> {
  const client = await requireCallerTransaction(database as DatabaseClient);
  const operation = await lockedPortableOperation(client, rehydration.operation.operationId);
  if (!operation || !portableOperationMatches(operation, rehydration.operation)) return unavailable("stale");
  const initialClaim = portableClaimIdentity(operation, rehydration.claim);
  if (initialClaim !== "valid") return unavailable(initialClaim);

  const candidate = await client.query<{ staged_input_id: string }>(
    `SELECT id AS staged_input_id
       FROM portable_staged_inputs
      WHERE owner_user_id=$1 AND handle_token_hash=$2 AND filesystem_operation_id=$3
      LIMIT 1`,
    [rehydration.identity.ownerUserId, sha256(rehydration.identity.stagedInput), operation.id]
  );
  const stagedInputId = candidate.rows[0]?.staged_input_id;
  if (!stagedInputId) return unavailable("stale");
  const staged = await lockedStagedAuthority(
    client,
    stagedInputId,
    rehydration.identity.ownerUserId,
    operation.id,
    sha256(rehydration.identity.stagedInput),
  );
  if (!staged) return unavailable("stale");
  const rows = await portableDescriptorRows(client, operation.id);
  const descriptors = portableCleanupDescriptors(rows, staged.staged_content_hash, staged.staged_byte_length);
  const delivery = descriptors[descriptors.length - 1]!;
  if (!descriptorsMatch([delivery], [rehydration.descriptor])) return unavailable("stale");
  const currentTime = await lockPortablePhysicalPaths(client, descriptors.map((value) => value.relativePath));
  const classification = activeClaimOutcome(operation, rehydration.claim, currentTime);
  if (classification !== "valid") return unavailable(classification);
  if (operation.lifecycle === "cleaned" && staged.status === "cleaned") return unavailable("already_cleaned");
  if (operation.lifecycle === "cleanup_pending" || staged.status === "cleanup_pending") return unavailable("stale");
  if (!(["attached", "finalized"] as PortableFilesystemLifecycle[]).includes(operation.lifecycle)
    || staged.status !== "staged"
    || currentTime >= staged.staged_expires_at) return unavailable("stale");

  const operationUpdate = await client.query(
    `UPDATE durable_filesystem_operations
        SET lifecycle='cleanup_pending',cleanup_requested_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND owner_user_id=$2 AND purpose='portable_staging'
        AND lifecycle IN ('attached','finalized') AND work_version=$3
        AND lease_id=$4 AND lease_owner=$5
        AND date_trunc('milliseconds',lease_expires_at)=$6::timestamptz
        AND lease_expires_at > clock_timestamp() AND expires_at > clock_timestamp()`,
    [
      operation.id,
      operation.owner_user_id,
      rehydration.claim.workVersion,
      rehydration.claim.leaseId,
      rehydration.claim.leaseOwner,
      rehydration.claim.leaseExpiresAt
    ]
  );
  const stagedUpdate = await client.query(
    `UPDATE portable_staged_inputs
        SET status='cleanup_pending',updated_at=clock_timestamp()
      WHERE id=$1 AND owner_user_id=$2 AND filesystem_operation_id=$3
        AND handle_token_hash=$4 AND status='staged'
        AND expires_at > clock_timestamp()`,
    [staged.staged_input_id, operation.owner_user_id, operation.id, staged.handle_token_hash]
  );
  if (operationUpdate.rowCount !== 1 || stagedUpdate.rowCount !== 1) {
    throw repositoryError("archive_unavailable", 503);
  }
  return bindPrivatePortableStagedCleanupPreparation(
    {
      portableKind: "staged_input",
      stagedInputId: staged.staged_input_id,
      ownerUserId: operation.owner_user_id,
      filesystemOperationId: operation.id as DurableFilesystemOperationId
    },
    portableOperation(operation),
    rehydration.claim,
    descriptors,
  );
}

async function prepareExportCleanup(
  database: DurableFilesystemTransactionContext,
  rehydration: PrivatePortableExportRehydration,
): Promise<PrivatePortableExportCleanupPreparation | PrivatePortableCleanupUnavailable> {
  const client = await requireCallerTransaction(database as DatabaseClient);
  const operation = await lockedPortableOperation(client, rehydration.operation.operationId);
  if (!operation || !portableOperationMatches(operation, rehydration.operation)) return unavailable("stale");
  const initialClaim = portableClaimIdentity(operation, rehydration.claim);
  if (initialClaim !== "valid") return unavailable(initialClaim);
  const scope = rehydration.identity.exportScope;
  const candidate = await client.query<{ artifact_id: string }>(
    `SELECT id AS artifact_id
       FROM portable_export_artifacts
      WHERE owner_user_id=$1 AND retrieval_token_hash=$2 AND filesystem_operation_id=$3
        AND export_kind=$4 AND campaign_id IS NOT DISTINCT FROM $5::uuid
        AND world_id=$6 AND world_version_id=$7
      LIMIT 1`,
    [
      scope.ownerUserId,
      sha256(rehydration.identity.retrieval),
      operation.id,
      scope.exportKind,
      scope.campaignId,
      scope.worldId,
      scope.worldVersionId
    ]
  );
  const artifactId = candidate.rows[0]?.artifact_id;
  if (!artifactId) return unavailable("stale");
  const artifact = await lockedExportAuthority(
    client,
    artifactId,
    scope,
    operation.id,
    sha256(rehydration.identity.retrieval),
  );
  if (!artifact) return unavailable("stale");
  const rows = await portableDescriptorRows(client, operation.id);
  const descriptors = portableCleanupDescriptors(rows, artifact.artifact_content_hash, artifact.artifact_byte_length);
  const delivery = descriptors[descriptors.length - 1]!;
  if (!descriptorsMatch([delivery], [rehydration.descriptor])) return unavailable("stale");
  const currentTime = await lockPortablePhysicalPaths(client, descriptors.map((value) => value.relativePath));
  const classification = activeClaimOutcome(operation, rehydration.claim, currentTime);
  if (classification !== "valid") return unavailable(classification);
  if (operation.lifecycle === "cleaned" && artifact.status === "cleaned") return unavailable("already_cleaned");
  if (operation.lifecycle === "cleanup_pending" || artifact.status === "cleanup_pending") return unavailable("stale");
  if (!(["attached", "finalized"] as PortableFilesystemLifecycle[]).includes(operation.lifecycle)
    || artifact.status !== "ready"
    || currentTime >= artifact.artifact_expires_at) return unavailable("stale");

  const operationUpdate = await client.query(
    `UPDATE durable_filesystem_operations
        SET lifecycle='cleanup_pending',cleanup_requested_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND owner_user_id=$2 AND purpose='portable_export'
        AND lifecycle IN ('attached','finalized') AND work_version=$3
        AND lease_id=$4 AND lease_owner=$5
        AND date_trunc('milliseconds',lease_expires_at)=$6::timestamptz
        AND lease_expires_at > clock_timestamp() AND expires_at > clock_timestamp()`,
    [
      operation.id,
      operation.owner_user_id,
      rehydration.claim.workVersion,
      rehydration.claim.leaseId,
      rehydration.claim.leaseOwner,
      rehydration.claim.leaseExpiresAt
    ]
  );
  const artifactUpdate = await client.query(
    `UPDATE portable_export_artifacts
        SET status='cleanup_pending',updated_at=clock_timestamp()
      WHERE id=$1 AND owner_user_id=$2 AND filesystem_operation_id=$3
        AND retrieval_token_hash=$4 AND status='ready'
        AND expires_at > clock_timestamp()`,
    [artifact.artifact_id, operation.owner_user_id, operation.id, artifact.retrieval_token_hash]
  );
  if (operationUpdate.rowCount !== 1 || artifactUpdate.rowCount !== 1) {
    throw repositoryError("archive_unavailable", 503);
  }
  return bindPrivatePortableExportCleanupPreparation(
    {
      portableKind: "export_artifact",
      artifactId: artifact.artifact_id,
      ownerUserId: operation.owner_user_id,
      filesystemOperationId: operation.id as DurableFilesystemOperationId,
      exportScope: scope
    },
    portableOperation(operation),
    rehydration.claim,
    descriptors,
  );
}

async function prepareRecoveryCleanup(
  database: DurableFilesystemTransactionContext,
  recovery: DurableFilesystemRecoveryRecord,
): Promise<
  PrivatePortableStagedCleanupPreparation
  | PrivatePortableExportCleanupPreparation
  | PrivatePortableCleanupUnavailable
> {
  const client = await requireCallerTransaction(database as DatabaseClient);
  if (recovery.action !== "cleanup"
    || recovery.operation.resourceKind !== "portable"
    || Object.hasOwn(recovery.operation, "expiresAt")) {
    return unavailable("stale");
  }
  const operation = await lockedPortableOperation(client, recovery.operation.operationId);
  if (!operation
    || operation.candidate_token_hash === null
    || !portableRecoveryOperationMatches(operation, recovery.operation as AttachedFilesystemOperation)) {
    return unavailable("stale");
  }
  const initialClaim = portableClaimIdentity(operation, recovery.claim);
  if (initialClaim !== "valid") return unavailable(initialClaim);

  if (operation.purpose === "portable_staging") {
    const selected = await client.query<{ staged_input_id: string }>(
      `SELECT id AS staged_input_id FROM portable_staged_inputs
        WHERE filesystem_operation_id=$1 AND owner_user_id=$2 LIMIT 1`,
      [operation.id, operation.owner_user_id]
    );
    const stagedInputId = selected.rows[0]?.staged_input_id;
    if (!stagedInputId) return unavailable("stale");
    const staged = await lockedStagedAuthority(client, stagedInputId, operation.owner_user_id, operation.id);
    if (!staged) return unavailable("stale");
    const rows = await portableDescriptorRows(client, operation.id);
    const descriptors = portableCleanupDescriptors(rows, staged.staged_content_hash, staged.staged_byte_length);
    const currentTime = await lockPortablePhysicalPaths(client, descriptors.map((value) => value.relativePath));
    const classification = cleanupClaimOutcome(operation, recovery.claim, currentTime);
    if (classification !== "valid") return unavailable(classification);
    if (operation.lifecycle === "cleaned" && staged.status === "cleaned") return unavailable("already_cleaned");
    if (operation.lifecycle !== "cleanup_pending" || staged.status !== "cleanup_pending") return unavailable("stale");
    return bindPrivatePortableStagedCleanupPreparation(
      {
        portableKind: "staged_input",
        stagedInputId: staged.staged_input_id,
        ownerUserId: operation.owner_user_id,
        filesystemOperationId: operation.id as DurableFilesystemOperationId
      },
      portableOperation(operation),
      recovery.claim,
      descriptors,
    );
  }

  const selected = await client.query<PortableExportAuthorityRow>(
    `SELECT id AS artifact_id,owner_user_id AS artifact_owner_user_id,
            retrieval_token_hash,filesystem_operation_id,export_kind,campaign_id,
            world_id,world_version_id,status,content_hash AS artifact_content_hash,
            byte_length::text AS artifact_byte_length,expires_at AS artifact_expires_at
       FROM portable_export_artifacts
      WHERE filesystem_operation_id=$1 AND owner_user_id=$2
      LIMIT 1`,
    [operation.id, operation.owner_user_id]
  );
  const exportRow = selected.rows[0];
  if (!exportRow) return unavailable("stale");
  const scope: PortableExportScope = {
    ownerUserId: exportRow.artifact_owner_user_id,
    exportKind: exportRow.export_kind,
    campaignId: exportRow.campaign_id,
    worldId: exportRow.world_id,
    worldVersionId: exportRow.world_version_id
  };
  const artifact = await lockedExportAuthority(client, exportRow.artifact_id, scope, operation.id);
  if (!artifact) return unavailable("stale");
  const rows = await portableDescriptorRows(client, operation.id);
  const descriptors = portableCleanupDescriptors(rows, artifact.artifact_content_hash, artifact.artifact_byte_length);
  const currentTime = await lockPortablePhysicalPaths(client, descriptors.map((value) => value.relativePath));
  const classification = cleanupClaimOutcome(operation, recovery.claim, currentTime);
  if (classification !== "valid") return unavailable(classification);
  if (operation.lifecycle === "cleaned" && artifact.status === "cleaned") return unavailable("already_cleaned");
  if (operation.lifecycle !== "cleanup_pending" || artifact.status !== "cleanup_pending") return unavailable("stale");
  return bindPrivatePortableExportCleanupPreparation(
    {
      portableKind: "export_artifact",
      artifactId: artifact.artifact_id,
      ownerUserId: operation.owner_user_id,
      filesystemOperationId: operation.id as DurableFilesystemOperationId,
      exportScope: scope
    },
    portableOperation(operation),
    recovery.claim,
    descriptors,
  );
}

async function acknowledgeStagedCleanup(
  database: DurableFilesystemTransactionContext,
  preparation: PrivatePortableStagedCleanupPreparation,
): Promise<DurableFilesystemCleanupCompletionResult> {
  const client = await requireCallerTransaction(database as DatabaseClient);
  const operation = await lockedPortableOperation(client, preparation.operation.operationId);
  if (!operation
    || preparation.outcome !== "cleanup_required"
    || preparation.identity.portableKind !== "staged_input"
    || preparation.identity.filesystemOperationId !== preparation.operation.operationId
    || preparation.identity.ownerUserId !== preparation.operation.ownerUserId
    || !portableRecoveryOperationMatches(operation, preparation.operation)) return { outcome: "stale" };
  const initialClaim = portableClaimIdentity(operation, preparation.claim);
  if (initialClaim !== "valid") return { outcome: initialClaim };
  const staged = await lockedStagedAuthority(
    client,
    preparation.identity.stagedInputId,
    preparation.identity.ownerUserId,
    preparation.identity.filesystemOperationId,
  );
  if (!staged) return { outcome: "stale" };
  const rows = await portableDescriptorRows(client, operation.id);
  const descriptors = portableCleanupDescriptors(rows, staged.staged_content_hash, staged.staged_byte_length);
  if (!descriptorsMatch(descriptors, preparation.descriptors)) return { outcome: "stale" };
  const currentTime = await lockPortablePhysicalPaths(client, descriptors.map((value) => value.relativePath));
  const classification = cleanupClaimOutcome(operation, preparation.claim, currentTime);
  if (classification !== "valid") return { outcome: classification };
  if (operation.lifecycle === "cleaned" && staged.status === "cleaned") return { outcome: "already_cleaned" };
  if (operation.lifecycle !== "cleanup_pending" || staged.status !== "cleanup_pending") return { outcome: "stale" };

  const operationUpdate = await client.query(
    `UPDATE durable_filesystem_operations
        SET lifecycle='cleaned',cleaned_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND owner_user_id=$2 AND purpose='portable_staging'
        AND lifecycle='cleanup_pending' AND work_version=$3
        AND lease_id=$4 AND lease_owner=$5
        AND date_trunc('milliseconds',lease_expires_at)=$6::timestamptz
        AND lease_expires_at > clock_timestamp()`,
    [
      operation.id,
      operation.owner_user_id,
      preparation.claim.workVersion,
      preparation.claim.leaseId,
      preparation.claim.leaseOwner,
      preparation.claim.leaseExpiresAt
    ]
  );
  const stagedUpdate = await client.query(
    `UPDATE portable_staged_inputs
        SET status='cleaned',updated_at=clock_timestamp()
      WHERE id=$1 AND owner_user_id=$2 AND filesystem_operation_id=$3
        AND status='cleanup_pending'`,
    [staged.staged_input_id, operation.owner_user_id, operation.id]
  );
  if (operationUpdate.rowCount !== 1 || stagedUpdate.rowCount !== 1) {
    throw repositoryError("archive_unavailable", 503);
  }
  return { outcome: "cleaned" };
}

async function acknowledgeExportCleanup(
  database: DurableFilesystemTransactionContext,
  preparation: PrivatePortableExportCleanupPreparation,
): Promise<DurableFilesystemCleanupCompletionResult> {
  const client = await requireCallerTransaction(database as DatabaseClient);
  const operation = await lockedPortableOperation(client, preparation.operation.operationId);
  if (!operation
    || preparation.outcome !== "cleanup_required"
    || preparation.identity.portableKind !== "export_artifact"
    || preparation.identity.filesystemOperationId !== preparation.operation.operationId
    || preparation.identity.ownerUserId !== preparation.operation.ownerUserId
    || preparation.identity.exportScope.ownerUserId !== preparation.identity.ownerUserId
    || !portableRecoveryOperationMatches(operation, preparation.operation)) return { outcome: "stale" };
  const initialClaim = portableClaimIdentity(operation, preparation.claim);
  if (initialClaim !== "valid") return { outcome: initialClaim };
  const artifact = await lockedExportAuthority(
    client,
    preparation.identity.artifactId,
    preparation.identity.exportScope,
    preparation.identity.filesystemOperationId,
  );
  if (!artifact) return { outcome: "stale" };
  const rows = await portableDescriptorRows(client, operation.id);
  const descriptors = portableCleanupDescriptors(rows, artifact.artifact_content_hash, artifact.artifact_byte_length);
  if (!descriptorsMatch(descriptors, preparation.descriptors)) return { outcome: "stale" };
  const currentTime = await lockPortablePhysicalPaths(client, descriptors.map((value) => value.relativePath));
  const classification = cleanupClaimOutcome(operation, preparation.claim, currentTime);
  if (classification !== "valid") return { outcome: classification };
  if (operation.lifecycle === "cleaned" && artifact.status === "cleaned") return { outcome: "already_cleaned" };
  if (operation.lifecycle !== "cleanup_pending" || artifact.status !== "cleanup_pending") return { outcome: "stale" };

  const operationUpdate = await client.query(
    `UPDATE durable_filesystem_operations
        SET lifecycle='cleaned',cleaned_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND owner_user_id=$2 AND purpose='portable_export'
        AND lifecycle='cleanup_pending' AND work_version=$3
        AND lease_id=$4 AND lease_owner=$5
        AND date_trunc('milliseconds',lease_expires_at)=$6::timestamptz
        AND lease_expires_at > clock_timestamp()`,
    [
      operation.id,
      operation.owner_user_id,
      preparation.claim.workVersion,
      preparation.claim.leaseId,
      preparation.claim.leaseOwner,
      preparation.claim.leaseExpiresAt
    ]
  );
  const artifactUpdate = await client.query(
    `UPDATE portable_export_artifacts
        SET status='cleaned',updated_at=clock_timestamp()
      WHERE id=$1 AND owner_user_id=$2 AND filesystem_operation_id=$3
        AND status='cleanup_pending'`,
    [artifact.artifact_id, operation.owner_user_id, operation.id]
  );
  if (operationUpdate.rowCount !== 1 || artifactUpdate.rowCount !== 1) {
    throw repositoryError("archive_unavailable", 503);
  }
  return { outcome: "cleaned" };
}

async function completedImportScope(
  client: DatabaseClient,
  ownerUserId: string,
  importId: string | null,
): Promise<ImportScopeRow> {
  if (importId === null) throw repositoryError("archive_unavailable", 503);
  const selected = await client.query<ImportScopeRow>(
    `SELECT id,world_id,world_version_id,campaign_id
       FROM imports
      WHERE id=$1 AND owner_user_id=$2 AND status='completed'
      FOR KEY SHARE`,
    [importId, ownerUserId]
  );
  const imported = selected.rows[0];
  if (!imported) throw repositoryError("archive_unavailable", 503);
  return imported;
}

function destinationMatches(row: PreviewRow, destination: DatabaseDestination): boolean {
  return row.destination_fingerprint === destination.fingerprint;
}

async function registerStagedInput(
  pool: DatabasePool,
  request: RegisterStagedInputRequest,
): Promise<PortableStagedInput> {
  const token = randomToken();
  const expiresAt = finiteFutureTimestamp(request.expiresAt, "archive_expired");
  const expectedHash = contentHash(request.contentHash);
  const expectedLength = byteLength(request.byteLength);
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO portable_staged_inputs (
       owner_user_id,handle_token_hash,filesystem_operation_id,status,
       content_hash,byte_length,expires_at
     )
     SELECT operation.owner_user_id,$3,operation.id,'staged',$4,$5,$6
       FROM durable_filesystem_operations operation
       JOIN durable_filesystem_descriptors descriptor
         ON descriptor.operation_id=operation.id
        AND descriptor.owner_user_id=operation.owner_user_id
        AND descriptor.descriptor_role='delivery'
      WHERE operation.id=$1 AND operation.owner_user_id=$2
        AND operation.purpose='portable_staging'
        AND operation.resource_kind='portable'
        AND operation.operation_scope_hash=$7
        AND operation.lifecycle IN ('attached','finalized')
        AND descriptor.content_hash=$4 AND descriptor.byte_length=$5
     RETURNING id`,
    [
      request.filesystemOperationId,
      request.ownerUserId,
      sha256(token),
      expectedHash,
      expectedLength,
      expiresAt,
      sha256(request.operationScopeId)
    ]
  );
  if (!inserted.rowCount) throw repositoryError("archive_unavailable", 404);
  return toPortableStagedInput(token);
}

async function retrieveStagedPayload(
  pool: DatabasePool,
  owner: ImportOwnerScope,
  stagedInput: PortableStagedInput,
): Promise<PortableStagedPayload | null> {
  return withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE portable_staged_inputs
          SET status='expired',updated_at=now()
        WHERE owner_user_id=$1 AND handle_token_hash=$2
          AND status='staged' AND expires_at <= now()`,
      [owner.ownerUserId, sha256(stagedInput)]
    );
    const selected = await client.query<DescriptorRow & Readonly<{
      staged_input_id: string;
      filesystem_operation_id: string;
      staged_content_hash: string;
      staged_byte_length: string;
      expires_at: Date;
    }>>(
      `SELECT staged.id AS staged_input_id,staged.filesystem_operation_id,
              staged.content_hash AS staged_content_hash,staged.byte_length::text AS staged_byte_length,
              staged.expires_at,descriptor.relative_path,descriptor.device_id,descriptor.file_id,
              descriptor.change_token,descriptor.content_hash,descriptor.byte_length::text
         FROM portable_staged_inputs staged
         JOIN durable_filesystem_operations operation
           ON operation.id=staged.filesystem_operation_id
          AND operation.owner_user_id=staged.owner_user_id
          AND operation.purpose='portable_staging'
         JOIN durable_filesystem_descriptors descriptor
           ON descriptor.operation_id=operation.id
          AND descriptor.owner_user_id=operation.owner_user_id
          AND descriptor.descriptor_role='delivery'
        WHERE staged.owner_user_id=$1 AND staged.handle_token_hash=$2
          AND staged.status='staged' AND staged.expires_at > now()
          AND operation.lifecycle IN ('attached','finalized')
        LIMIT 1`,
      [owner.ownerUserId, sha256(stagedInput)]
    );
    const row = selected.rows[0];
    if (!row) return null;
    const descriptor = privateDescriptor(row, row.staged_content_hash, row.staged_byte_length);
    return {
      stagedInputId: row.staged_input_id,
      filesystemOperationId: row.filesystem_operation_id as DurableFilesystemOperationId,
      contentHash: descriptor.contentHash,
      byteLength: descriptor.byteLength,
      expiresAt: row.expires_at.toISOString(),
      descriptor
    };
  });
}

async function createPreview<Command extends PortableImportPreviewCommand>(
  pool: DatabasePool,
  request: CreatePortablePreviewRequest<Command>,
): Promise<PortableImportPreviewView<Command>> {
  const token = randomPreviewToken();
  const destination = databaseDestination(request.command.destination);
  const fingerprint = contentHash(request.contentFingerprint);
  const expiresAt = finiteFutureTimestamp(request.expiresAt, "archive_expired");
  const diagnosticCodes = diagnostics(request.diagnostics);
  const rawProjection = jsonValue(request.projection);
  if (!isPreviewProjection(request.command.kind, rawProjection)
    || (request.command.kind === "campaign_zip"
      && !campaignDestinationMatches(rawProjection, request.command.destination))
    || (request.command.kind === "story_text"
      && isRecord(rawProjection)
      && "targetWorldId" in rawProjection
      && rawProjection.targetWorldId !== request.command.destination.worldId)) {
    throw repositoryError("import_invalid", 400);
  }
  const projection = projectionFor<Command["kind"]>(request.command.kind, rawProjection);
  const inserted = await withTransaction(pool, async (client) => {
    await lockPortableImportKeys(client, [portableImportLockKey(
      request.command.ownerUserId,
      request.command.kind,
      fingerprint,
      destination.fingerprint,
    )]);
    await client.query(
      `UPDATE portable_import_operations
          SET status='expired',updated_at=now()
        WHERE owner_user_id=$1 AND import_kind=$2 AND content_fingerprint=$3
          AND destination_fingerprint=$4 AND status='previewed' AND expires_at <= now()`,
      [request.command.ownerUserId, request.command.kind, fingerprint, destination.fingerprint]
    );
    await client.query(
      `UPDATE portable_import_operations
          SET status='superseded',updated_at=now()
        WHERE owner_user_id=$1 AND import_kind=$2 AND content_fingerprint=$3
          AND destination_fingerprint=$4 AND status='previewed' AND expires_at > now()`,
      [request.command.ownerUserId, request.command.kind, fingerprint, destination.fingerprint]
    );
    return client.query<{ expires_at: Date }>(
      `INSERT INTO portable_import_operations (
         owner_user_id,staged_input_id,import_kind,preview_token_hash,
         content_fingerprint,destination_fingerprint,destination_kind,
         destination_world_id,destination_world_version_id,
         source_installation_id,source_record_id,status,preview_projection,
         diagnostic_codes,expires_at
       )
       SELECT staged.owner_user_id,staged.id,$3,$4,$5,$6,$7,$8,$9,$10,$11,
              'previewed',$12::jsonb,$13::text[],$14
         FROM portable_staged_inputs staged
        WHERE staged.owner_user_id=$1 AND staged.handle_token_hash=$2
          AND staged.status='staged' AND staged.expires_at > now()
       RETURNING expires_at`,
      [
        request.command.ownerUserId,
        sha256(request.command.stagedInput),
        request.command.kind,
        sha256(token),
        fingerprint,
        destination.fingerprint,
        destination.destinationKind,
        destination.destinationWorldId,
        destination.destinationWorldVersionId,
        request.command.sourceInstallationId ?? null,
        request.command.importedRecordId ?? null,
        JSON.stringify(projection),
        diagnosticCodes,
        expiresAt
      ]
    );
  });
  const row = inserted.rows[0];
  if (!row) throw repositoryError("archive_unavailable", 404);
  return {
    previewHandle: toPortablePreviewHandle(token, request.command.destination),
    kind: request.command.kind,
    destination: request.command.destination,
    expiresAt: row.expires_at.toISOString(),
    cleanupOwner: "application",
    diagnostics: diagnosticCodes,
    projection
  };
}

async function retrievePreviewPayload<Kind extends PortableImportKind, Destination extends PortablePreviewDestination>(
  pool: DatabasePool,
  owner: ImportOwnerScope,
  kind: Kind,
  previewHandle: PortablePreviewHandle<Destination>,
): Promise<PortablePreviewPayload<Kind> | null> {
  const destination = databaseDestination(previewHandle.destination);
  return withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE portable_import_operations
          SET status='expired',updated_at=now()
        WHERE owner_user_id=$1 AND import_kind=$2 AND preview_token_hash=$3
          AND destination_fingerprint=$4 AND status='previewed' AND expires_at <= now()`,
      [owner.ownerUserId, kind, sha256(previewHandle.token), destination.fingerprint]
    );
    const selected = await client.query<PreviewRow>(
      `SELECT id,staged_input_id,import_kind,status,content_fingerprint,destination_fingerprint,
              source_installation_id,source_record_id,preview_projection,diagnostic_codes,
              idempotency_key_hash,commit_request_fingerprint,import_id,result_projection,expires_at
         FROM portable_import_operations
        WHERE owner_user_id=$1 AND import_kind=$2 AND preview_token_hash=$3
          AND destination_fingerprint=$4 AND status='previewed' AND expires_at > now()
        LIMIT 1`,
      [owner.ownerUserId, kind, sha256(previewHandle.token), destination.fingerprint]
    );
    const row = selected.rows[0];
    return row ? {
      stagedInputId: row.staged_input_id,
      kind,
      destination: previewHandle.destination,
      contentFingerprint: row.content_fingerprint,
      projection: boundProjectionFor(kind, row.preview_projection, previewHandle.destination),
      diagnostics: portableDiagnostics(row.diagnostic_codes),
      expiresAt: row.expires_at.toISOString(),
      ...(row.source_installation_id === null
        ? {}
        : { sourceInstallationId: toPortableSourceInstallationId(row.source_installation_id) }),
      ...(row.source_record_id === null
        ? {}
        : { importedRecordId: toPortableImportedRecordId(row.source_record_id) })
    } : null;
  });
}

async function lockedPreview<Kind extends PortableImportKind, Destination extends PortablePreviewDestination>(
  client: DatabaseClient,
  command: PortableImportCommitRepositoryCommand<Kind, Destination>,
): Promise<PreviewRow> {
  const selected = await client.query<PreviewRow>(
    `SELECT id,staged_input_id,import_kind,status,content_fingerprint,destination_fingerprint,
            source_installation_id,source_record_id,preview_projection,diagnostic_codes,
            idempotency_key_hash,commit_request_fingerprint,import_id,result_projection,expires_at
       FROM portable_import_operations
      WHERE owner_user_id=$1 AND import_kind=$2 AND preview_token_hash=$3
      FOR UPDATE`,
    [command.ownerUserId, command.kind, sha256(command.previewHandle.token)]
  );
  const row = selected.rows[0];
  const destination = databaseDestination(command.destination);
  if (!row || !destinationMatches(row, destination)) throw repositoryError("import_invalid", 404);
  return row;
}

async function beginImport<Kind extends PortableImportKind, Destination extends PortablePreviewDestination>(
  client: DatabaseClient,
  command: PortableImportCommitRepositoryCommand<Kind, Destination>,
): Promise<PortableImportBeginResult<Kind>> {
  await requireCallerTransaction(client);
  const transactionIdentity = await currentTransactionIdentity(client);
  if (command.idempotencyKey.trim().length === 0) {
    throw repositoryError("import_invalid", 400);
  }
  const advisoryPreview = await client.query<Pick<PreviewRow, "content_fingerprint" | "destination_fingerprint">>(
    `SELECT content_fingerprint,destination_fingerprint
       FROM portable_import_operations
      WHERE owner_user_id=$1 AND import_kind=$2 AND preview_token_hash=$3`,
    [command.ownerUserId, command.kind, sha256(command.previewHandle.token)]
  );
  const advisoryRow = advisoryPreview.rows[0];
  if (!advisoryRow) throw repositoryError("import_invalid", 404);
  await lockPortableImportKeys(client, [
    portableImportIdempotencyLockKey(command.ownerUserId, command.kind, sha256(command.idempotencyKey)),
    portableImportLockKey(
      command.ownerUserId,
      command.kind,
      advisoryRow.content_fingerprint,
      advisoryRow.destination_fingerprint,
    )
  ]);
  const row = await lockedPreview(client, command);
  const destination = databaseDestination(command.destination);
  const idempotencyKeyHash = sha256(command.idempotencyKey);
  const requestFingerprint = commitRequestFingerprint(
    command.ownerUserId,
    command.kind,
    row.id,
    row.content_fingerprint,
    destination.fingerprint,
  );
  const retrieval = resultRetrievalToken<Kind>(
    command.previewHandle.token,
  );

  if (row.status === "committed") {
    if (row.idempotency_key_hash !== idempotencyKeyHash
      || row.commit_request_fingerprint !== requestFingerprint
      || !row.result_projection) {
      throw repositoryError("import_idempotency_mismatch", 409);
    }
    const imported = await completedImportScope(client, command.ownerUserId, row.import_id);
    return { outcome: "replay", view: commitView<Kind>(command.kind, row, retrieval, imported) };
  }
  if (row.status !== "previewed") throw repositoryError("import_conflict", 409);
  if (row.expires_at.getTime() <= Date.now()) {
    await client.query(
      "UPDATE portable_import_operations SET status='expired',updated_at=now() WHERE id=$1 AND status='previewed'",
      [row.id]
    );
    throw repositoryError("archive_expired", 410);
  }
  const previewProjection = boundProjectionFor<Kind>(
    command.kind,
    row.preview_projection,
    command.destination,
  );
  const previewDiagnostics = portableDiagnostics(row.diagnostic_codes);
  const sourceInstallationId = row.source_installation_id === null
    ? undefined
    : toPortableSourceInstallationId(row.source_installation_id);
  const importedRecordId = row.source_record_id === null
    ? undefined
    : toPortableImportedRecordId(row.source_record_id);
  const stagedState = await client.query<StagedStateRow>(
    `SELECT status,expires_at
       FROM portable_staged_inputs
      WHERE id=$1 AND owner_user_id=$2
      FOR UPDATE`,
    [row.staged_input_id, command.ownerUserId]
  );
  const staged = stagedState.rows[0];
  if (!staged || staged.status !== "staged") {
    throw repositoryError("import_conflict", 409);
  }
  if (staged.expires_at.getTime() <= Date.now()) {
    await client.query(
      "UPDATE portable_staged_inputs SET status='expired',updated_at=now() WHERE id=$1 AND status='staged'",
      [row.staged_input_id]
    );
    throw repositoryError("archive_expired", 410);
  }

  const existing = await client.query<Pick<PreviewRow, "id" | "commit_request_fingerprint">>(
    `SELECT id,commit_request_fingerprint
       FROM portable_import_operations
      WHERE owner_user_id=$1 AND import_kind=$2 AND idempotency_key_hash=$3
      FOR UPDATE`,
    [command.ownerUserId, command.kind, idempotencyKeyHash]
  );
  if (existing.rows[0] && (existing.rows[0].id !== row.id
    || existing.rows[0].commit_request_fingerprint !== requestFingerprint)) {
    throw repositoryError("import_idempotency_mismatch", 409);
  }

  await client.query("SAVEPOINT portable_import_idempotency");
  let consumingRowCount = 0;
  try {
    const consuming = await client.query(
      `UPDATE portable_import_operations
          SET status='consuming',idempotency_key_hash=$2,commit_request_fingerprint=$3,
              consumed_at=now(),updated_at=now()
        WHERE id=$1 AND status='previewed'`,
      [row.id, idempotencyKeyHash, requestFingerprint]
    );
    consumingRowCount = consuming.rowCount ?? 0;
    await client.query("RELEASE SAVEPOINT portable_import_idempotency");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT portable_import_idempotency");
    await client.query("RELEASE SAVEPOINT portable_import_idempotency");
    if (postgresErrorCode(error) === "23505") {
      const conflicting = await client.query<{ id: string; commit_request_fingerprint: string | null }>(
        `SELECT id,commit_request_fingerprint
           FROM portable_import_operations
          WHERE owner_user_id=$1 AND import_kind=$2 AND idempotency_key_hash=$3
          FOR UPDATE`,
        [command.ownerUserId, command.kind, idempotencyKeyHash]
      );
      if (conflicting.rows[0]) throw repositoryError("import_idempotency_mismatch", 409);
    }
    throw error;
  }
  if (!consumingRowCount) throw repositoryError("import_conflict", 409);
  const consumed = await client.query(
    `UPDATE portable_staged_inputs
        SET status='consumed',consumed_at=now(),updated_at=now()
      WHERE id=$1 AND owner_user_id=$2 AND status='staged'`,
    [row.staged_input_id, command.ownerUserId]
  );
  if (!consumed.rowCount) throw repositoryError("archive_expired", 410);

  return {
    outcome: "ready",
    claim: {
      operationId: row.id,
      ownerUserId: command.ownerUserId,
      kind: command.kind,
      requestFingerprint,
      resultRetrieval: retrieval,
      [portableImportTransactionIdentity]: transactionIdentity
    } as PortableImportCommitClaim<Kind>,
    preview: {
      projection: previewProjection,
      diagnostics: previewDiagnostics,
      contentFingerprint: row.content_fingerprint,
      ...(sourceInstallationId === undefined ? {} : { sourceInstallationId }),
      ...(importedRecordId === undefined ? {} : { importedRecordId })
    }
  };
}

async function completeImport<Kind extends PortableImportKind>(
  client: DatabaseClient,
  claim: PortableImportCommitClaim<Kind>,
  completion: CompletePortableImportRequest<Kind>,
): Promise<PortableImportCommitView<Kind>> {
  await requireCallerTransaction(client);
  await requireClaimTransaction(client, claim);
  const expiresAt = finiteFutureTimestamp(completion.resultExpiresAt, "archive_expired");
  const diagnosticCodes = diagnostics(completion.diagnostics);
  const rawResult = jsonValue(completion.result);
  if (!isResultProjection(claim.kind, rawResult)) {
    throw repositoryError("import_invalid", 400);
  }
  const result = resultFor(claim.kind, rawResult);
  const selectedImport = await client.query<ImportScopeRow>(
    `SELECT id,world_id,world_version_id,campaign_id
       FROM imports
      WHERE id=$1 AND owner_user_id=$2 AND status='completed'
      FOR KEY SHARE`,
    [completion.importId, claim.ownerUserId]
  );
  const imported = selectedImport.rows[0];
  if (!imported
    || completion.importedRecordId !== imported.id
    || !resultMatchesImport(claim.kind, result, imported, completion.duplicate)) {
    throw repositoryError("import_invalid", 409);
  }
  const stored: StoredCommitProjection = {
    importedRecordId: completion.importedRecordId,
    duplicate: completion.duplicate,
    result
  };
  const completed = await client.query<PreviewRow>(
    `UPDATE portable_import_operations operation
        SET status='committed',result_retrieval_token_hash=$6,import_id=$5,
            result_projection=$7::jsonb,diagnostic_codes=$8::text[],expires_at=$9,
            completed_at=now(),updated_at=now()
      WHERE operation.id=$1 AND operation.owner_user_id=$2 AND operation.import_kind=$3
        AND operation.status='consuming' AND operation.commit_request_fingerprint=$4
        AND EXISTS (
          SELECT 1 FROM imports
           WHERE id=$5 AND owner_user_id=$2 AND status='completed'
        )
      RETURNING operation.id,operation.staged_input_id,operation.import_kind,operation.status,
                operation.content_fingerprint,operation.destination_fingerprint,
                operation.source_installation_id,operation.source_record_id,
                operation.preview_projection,operation.diagnostic_codes,
                operation.idempotency_key_hash,operation.commit_request_fingerprint,
                operation.import_id,operation.result_projection,operation.expires_at`,
    [
      claim.operationId,
      claim.ownerUserId,
      claim.kind,
      claim.requestFingerprint,
      completion.importId,
      sha256(claim.resultRetrieval),
      JSON.stringify(stored),
      diagnosticCodes,
      expiresAt
    ]
  );
  const row = completed.rows[0];
  if (!row) throw repositoryError("import_invalid", 409);
  return commitView(claim.kind, row, claim.resultRetrieval, imported);
}

async function retrieveImportResult<Kind extends PortableImportKind>(
  pool: DatabasePool,
  owner: ImportOwnerScope,
  kind: Kind,
  retrieval: PortableImportResultRetrieval<Kind>,
): Promise<PortableImportResultView<Kind> | null> {
  const selected = await pool.query<Pick<PreviewRow, "result_projection" | "diagnostic_codes"> & ImportScopeRow>(
    `SELECT operation.result_projection,operation.diagnostic_codes,
            imported.id,imported.world_id,imported.world_version_id,imported.campaign_id
       FROM portable_import_operations operation
       JOIN imports imported
         ON imported.id=operation.import_id
        AND imported.owner_user_id=operation.owner_user_id
        AND imported.status='completed'
      WHERE operation.owner_user_id=$1 AND operation.import_kind=$2
        AND operation.result_retrieval_token_hash=$3
        AND operation.status='committed' AND operation.expires_at > now()
      LIMIT 1`,
    [owner.ownerUserId, kind, sha256(retrieval)]
  );
  const row = selected.rows[0];
  if (!row) return null;
  const stored = storedCommit(row.result_projection);
  const result = resultFor(kind, stored.result);
  if (stored.importedRecordId !== row.id
    || !resultMatchesImport(kind, result, row, stored.duplicate)) {
    throw repositoryError("archive_unavailable", 503);
  }
  return {
    kind,
    result,
    diagnostics: portableDiagnostics(row.diagnostic_codes)
  };
}

async function registerExportArtifact(
  pool: DatabasePool,
  request: RegisterPortableExportRequest,
): Promise<PortableArchiveExportView> {
  const token = randomToken();
  const expectedHash = contentHash(request.contentHash);
  const expectedLength = byteLength(request.byteLength);
  const expiresAt = finiteFutureTimestamp(request.expiresAt, "archive_expired");
  const inserted = await pool.query<{ byte_length: string }>(
    `INSERT INTO portable_export_artifacts (
       owner_user_id,retrieval_token_hash,filesystem_operation_id,export_kind,
       campaign_id,world_id,world_version_id,content_type,content_hash,byte_length,status,expires_at
     )
     SELECT operation.owner_user_id,$3,operation.id,$4,$5,$6,$7,$8,$9,$10,'ready',$11
       FROM durable_filesystem_operations operation
       JOIN durable_filesystem_descriptors descriptor
         ON descriptor.operation_id=operation.id
        AND descriptor.owner_user_id=operation.owner_user_id
        AND descriptor.descriptor_role='delivery'
      WHERE operation.id=$1 AND operation.owner_user_id=$2
        AND operation.purpose='portable_export' AND operation.resource_kind='portable'
        AND operation.operation_scope_hash=$12
        AND operation.lifecycle IN ('attached','finalized')
        AND descriptor.content_hash=$9 AND descriptor.byte_length=$10
     RETURNING byte_length::text`,
    [
      request.filesystemOperationId,
      request.ownerUserId,
      sha256(token),
      request.exportKind,
      request.campaignId,
      request.worldId,
      request.worldVersionId,
      request.contentType,
      expectedHash,
      expectedLength,
      expiresAt,
      sha256(request.operationScopeId)
    ]
  );
  const row = inserted.rows[0];
  if (!row) throw repositoryError("archive_unavailable", 404);
  return {
    retrieval: toPortableArchiveExportRetrieval(token),
    contentType: request.contentType,
    byteLength: databaseByteLength(row.byte_length)
  };
}

async function retrieveExportArtifact(
  pool: DatabasePool,
  scope: PortableExportScope,
  retrieval: PortableArchiveExportRetrieval,
): Promise<PortableExportPayload | null> {
  return withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE portable_export_artifacts
          SET status='expired',updated_at=now()
        WHERE owner_user_id=$1 AND retrieval_token_hash=$2
          AND status='ready' AND expires_at <= now()`,
      [scope.ownerUserId, sha256(retrieval)]
    );
    const selected = await client.query<DescriptorRow & Readonly<{
      artifact_id: string;
      content_type: PortableArchiveExportView["contentType"];
      artifact_content_hash: string;
      artifact_byte_length: string;
      expires_at: Date;
    }>>(
      `SELECT artifact.id AS artifact_id,artifact.content_type,
              artifact.content_hash AS artifact_content_hash,
              artifact.byte_length::text AS artifact_byte_length,artifact.expires_at,
              descriptor.relative_path,descriptor.device_id,descriptor.file_id,
              descriptor.change_token,descriptor.content_hash,descriptor.byte_length::text
         FROM portable_export_artifacts artifact
         JOIN durable_filesystem_operations operation
           ON operation.id=artifact.filesystem_operation_id
          AND operation.owner_user_id=artifact.owner_user_id
          AND operation.purpose='portable_export'
         JOIN durable_filesystem_descriptors descriptor
           ON descriptor.operation_id=operation.id
          AND descriptor.owner_user_id=operation.owner_user_id
          AND descriptor.descriptor_role='delivery'
        WHERE artifact.owner_user_id=$1 AND artifact.retrieval_token_hash=$2
          AND artifact.export_kind=$3 AND artifact.campaign_id IS NOT DISTINCT FROM $4::uuid
          AND artifact.world_id=$5 AND artifact.world_version_id=$6
          AND artifact.status='ready' AND artifact.expires_at > now()
          AND operation.lifecycle IN ('attached','finalized')
        LIMIT 1`,
      [
        scope.ownerUserId,
        sha256(retrieval),
        scope.exportKind,
        scope.campaignId,
        scope.worldId,
        scope.worldVersionId
      ]
    );
    const row = selected.rows[0];
    if (!row) return null;
    const descriptor = privateDescriptor(row, row.artifact_content_hash, row.artifact_byte_length);
    return {
      artifactId: row.artifact_id,
      contentType: row.content_type,
      contentHash: descriptor.contentHash,
      byteLength: descriptor.byteLength,
      expiresAt: row.expires_at.toISOString(),
      descriptor
    };
  });
}

/**
 * Additive owner-scoped persistence for portable staged inputs, previews,
 * imports, and exports. Durable filesystem lifecycle/reaping is deliberately
 * supplied by the later 14e2b4 composition through pre-existing operation IDs.
 */
export function createPostgresImportRepository(pool: DatabasePool): PostgresPortableImportRepository {
  return {
    registerStagedInput(request) {
      return safeRepositoryCall(() => registerStagedInput(pool, request));
    },
    retrieveStagedPayload(owner, stagedInput) {
      return safeRepositoryCall(() => retrieveStagedPayload(pool, owner, stagedInput));
    },
    createPreview(request) {
      return safeRepositoryCall(() => createPreview(pool, request));
    },
    retrievePreviewPayload(owner, kind, previewHandle) {
      return safeRepositoryCall(() => retrievePreviewPayload(pool, owner, kind, previewHandle));
    },
    beginImport(client, command) {
      return safeRepositoryCall(() => beginImport(client, command));
    },
    completeImport(client, claim, completion) {
      return safeRepositoryCall(() => completeImport(client, claim, completion));
    },
    retrieveImportResult(owner, kind, retrieval) {
      return safeRepositoryCall(() => retrieveImportResult(pool, owner, kind, retrieval));
    },
    registerExportArtifact(request) {
      return safeRepositoryCall(() => registerExportArtifact(pool, request));
    },
    retrieveExportArtifact(scope, retrieval) {
      return safeRepositoryCall(() => retrieveExportArtifact(pool, scope, retrieval));
    },
    rehydrateStagedInput(owner, stagedInput, request) {
      return safeRepositoryCall(() => rehydrateStagedInput(pool, owner, stagedInput, request));
    },
    prepareStagedCleanup(database, rehydration) {
      return safeRepositoryCall(() => prepareStagedCleanup(database, rehydration));
    },
    acknowledgeStagedCleanup(database, preparation) {
      return safeRepositoryCall(() => acknowledgeStagedCleanup(database, preparation));
    },
    rehydrateExportArtifact(scope, retrieval, request) {
      return safeRepositoryCall(() => rehydrateExportArtifact(pool, scope, retrieval, request));
    },
    prepareExportCleanup(database, rehydration) {
      return safeRepositoryCall(() => prepareExportCleanup(database, rehydration));
    },
    acknowledgeExportCleanup(database, preparation) {
      return safeRepositoryCall(() => acknowledgeExportCleanup(database, preparation));
    },
    prepareRecoveryCleanup(database, recovery) {
      return safeRepositoryCall(() => prepareRecoveryCleanup(database, recovery));
    }
  };
}
