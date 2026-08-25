import { createHash, randomBytes } from "node:crypto";
import {
  canonicalArchiveJson,
  systemImportPreviewViewSchema,
  type SystemImportPreviewView
} from "@infinite-quest/contracts";
import type { OwnerScope } from "../../application/src/generation/types.js";
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

export interface SystemArchiveImportRepository {
  destinationFingerprint(
    owner: OwnerScope,
    request: SystemArchiveDestinationFingerprintRequest
  ): Promise<SystemImportDestinationFingerprint>;
  createPreview(
    owner: OwnerScope,
    request: CreateSystemArchivePreviewRequest
  ): Promise<SystemArchivePreviewAuthority>;
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
         WHERE status IN ('created','uploading') AND expires_at > clock_timestamp()
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
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO system_archive_jobs (
             owner_user_id,kind,status,idempotency_key_hash,staged_input_id,progress,report
           )
           SELECT upload.owner_user_id,'import','previewed',$3,upload.staged_input_id,$4::jsonb,$5::jsonb
             FROM system_archive_uploads upload
            WHERE upload.id=$1 AND upload.owner_user_id=$2
              AND upload.status='completed' AND upload.staged_input_id IS NOT NULL
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
    }
  };
  return Object.freeze(repository);
}
