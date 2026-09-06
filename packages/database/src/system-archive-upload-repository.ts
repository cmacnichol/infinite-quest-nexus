import {
  systemUploadViewSchema,
  type SystemArchiveUploadView
} from "@infinite-quest/contracts";
import type { OwnerScope } from "../../application/src/generation/types.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

type SystemArchiveUploadRow = Readonly<{
  id: string;
  owner_user_id: string;
  filesystem_operation_id: string;
  status: "created" | "uploading" | "completed" | "expired" | "failed";
  byte_length: string | number;
  received_bytes: string | number;
  content_hash: string;
  staged_input_id: string | null;
  expires_at: Date;
}>;

type SystemArchiveUploadChunkRow = Readonly<{
  chunk_index: number;
  byte_offset: string | number;
  byte_length: string | number;
  content_hash: string;
}>;

type LockedSystemArchiveUploadRow = SystemArchiveUploadRow & Readonly<{
  is_expired: boolean;
}>;

export type CreateSystemArchiveUploadRequest = Readonly<{
  handleTokenHash: string;
  filesystemOperationId: string;
  byteLength: number;
  sha256: string;
}>;

export type RecordSystemArchiveUploadChunkRequest = Readonly<{
  uploadId: string;
  index: number;
  offset: number;
  bytes: number;
  sha256: string;
}>;

export type SystemArchiveUploadAssembly = Readonly<{
  uploadId: string;
  filesystemOperationId: string;
  byteLength: number;
  sha256: string;
  expiresAt: string;
  chunks: readonly Readonly<{
    index: number;
    offset: number;
    bytes: number;
    sha256: string;
  }>[];
}>;

export type SystemArchiveUploadSession = Readonly<{
  uploadId: string;
  filesystemOperationId: string;
  status: "created" | "uploading" | "completed" | "expired" | "failed";
  byteLength: number;
  sha256: string;
}>;

export type CompleteSystemArchiveUploadRequest = Readonly<{
  uploadId: string;
  stagedInputId: string;
}>;

export interface SystemArchiveUploadRepository {
  createUpload(owner: OwnerScope, request: CreateSystemArchiveUploadRequest): Promise<SystemArchiveUploadView>;
  getUpload(owner: OwnerScope, uploadId: string): Promise<SystemArchiveUploadView>;
  cancelUpload(owner: OwnerScope, uploadId: string): Promise<SystemArchiveUploadView>;
  getUploadSession(owner: OwnerScope, uploadId: string): Promise<SystemArchiveUploadSession>;
  recordChunk(
    owner: OwnerScope,
    request: RecordSystemArchiveUploadChunkRequest
  ): Promise<SystemArchiveUploadView>;
  reconcileChunk(
    owner: OwnerScope,
    request: RecordSystemArchiveUploadChunkRequest
  ): Promise<SystemArchiveUploadView | null>;
  getAssembly(owner: OwnerScope, uploadId: string): Promise<SystemArchiveUploadAssembly>;
  completeUpload(
    owner: OwnerScope,
    request: CompleteSystemArchiveUploadRequest
  ): Promise<SystemArchiveUploadView>;
  reconcileCompletion(
    owner: OwnerScope,
    request: CompleteSystemArchiveUploadRequest
  ): Promise<SystemArchiveUploadView | null>;
}

type SystemArchiveUploadRepositoryOptions = Readonly<{
  uploadTtlSeconds: number;
}>;

const UPLOAD_COLUMNS = `id,owner_user_id,filesystem_operation_id,status,byte_length,
  received_bytes,content_hash,staged_input_id,expires_at`;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

function repositoryError(
  message: string,
  statusCode: number,
  code?: string
): Error & { statusCode: number; code?: string } {
  return Object.assign(new Error(message), {
    statusCode,
    ...(code === undefined ? {} : { code })
  });
}

function requireHash(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw repositoryError(`${name} must be a lowercase SHA-256 hash.`, 400);
  }
}

function requireSafeInteger(value: number, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw repositoryError(`${name} must be a safe integer of at least ${minimum}.`, 400);
  }
}

function requireChunkIndex(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > POSTGRES_INTEGER_MAX) {
    throw repositoryError(
      `System Archive chunk index must be a PostgreSQL integer between 0 and ${POSTGRES_INTEGER_MAX}.`,
      400
    );
  }
}

function toView(row: SystemArchiveUploadRow): SystemArchiveUploadView {
  return systemUploadViewSchema.parse({
    id: row.id,
    status: row.status,
    byteLength: Number(row.byte_length),
    receivedBytes: Number(row.received_bytes),
    expiresAt: row.expires_at.toISOString()
  });
}

function toSession(row: SystemArchiveUploadRow): SystemArchiveUploadSession {
  return Object.freeze({
    uploadId: row.id,
    filesystemOperationId: row.filesystem_operation_id,
    status: row.status,
    byteLength: Number(row.byte_length),
    sha256: row.content_hash
  });
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function assemblyFromRows(
  upload: SystemArchiveUploadRow,
  chunks: readonly SystemArchiveUploadChunkRow[],
  expired: boolean
): SystemArchiveUploadAssembly {
  if (upload.status !== "created" && upload.status !== "uploading") {
    throw repositoryError(`System Archive upload cannot be assembled from ${upload.status}.`, 409);
  }
  if (expired) {
    throw repositoryError("System Archive upload has expired.", 410);
  }
  const byteLength = Number(upload.byte_length);
  let expectedOffset = 0;
  const ordered = chunks.map((chunk) => {
    const offset = Number(chunk.byte_offset);
    const bytes = Number(chunk.byte_length);
    if (offset !== expectedOffset) {
      throw repositoryError("System Archive upload is missing a contiguous chunk range.", 409);
    }
    expectedOffset += bytes;
    return Object.freeze({
      index: chunk.chunk_index,
      offset,
      bytes,
      sha256: chunk.content_hash
    });
  });
  if (expectedOffset !== byteLength || Number(upload.received_bytes) !== byteLength) {
    throw repositoryError("System Archive upload is missing a contiguous chunk range.", 409);
  }
  return Object.freeze({
    uploadId: upload.id,
    filesystemOperationId: upload.filesystem_operation_id,
    byteLength,
    sha256: upload.content_hash,
    expiresAt: upload.expires_at.toISOString(),
    chunks: Object.freeze(ordered)
  });
}

async function renewUploadAuthority(
  client: DatabaseClient,
  owner: OwnerScope,
  uploadId: string,
  filesystemOperationId: string,
  uploadTtlSeconds: number
): Promise<SystemArchiveUploadRow> {
  const updated = await client.query<SystemArchiveUploadRow>(
    `UPDATE system_archive_uploads
        SET expires_at=clock_timestamp()+($4::text || ' seconds')::interval,
            updated_at=clock_timestamp()
      WHERE id=$1 AND owner_user_id=$2 AND filesystem_operation_id=$3
     RETURNING ${UPLOAD_COLUMNS}`,
    [uploadId, owner.ownerUserId, filesystemOperationId, uploadTtlSeconds]
  );
  const row = updated.rows[0];
  if (!row) throw new Error("System Archive upload authority renewal lost its session.");
  const operation = await client.query(
    `UPDATE durable_filesystem_operations
        SET expires_at=$3,updated_at=clock_timestamp()
      WHERE id=$1 AND owner_user_id=$2 AND purpose='portable_staging'
        AND resource_kind='portable' AND lifecycle IN ('reserved','attached','finalized')`,
    [filesystemOperationId, owner.ownerUserId, row.expires_at]
  );
  if (operation.rowCount !== 1) {
    throw new Error("System Archive upload authority renewal lost its filesystem operation.");
  }
  return row;
}

async function lockedAssembly(
  client: DatabaseClient,
  owner: OwnerScope,
  uploadId: string,
  uploadTtlSeconds: number
): Promise<Readonly<{
  upload: SystemArchiveUploadRow;
  assembly: SystemArchiveUploadAssembly;
}>> {
  const selected = await client.query<LockedSystemArchiveUploadRow>(
    `SELECT ${UPLOAD_COLUMNS},expires_at<=clock_timestamp() AS is_expired
       FROM system_archive_uploads
      WHERE id=$1 AND owner_user_id=$2
      FOR UPDATE`,
    [uploadId, owner.ownerUserId]
  );
  const upload = selected.rows[0];
  if (!upload) throw repositoryError("System Archive upload was not found.", 404);
  const chunks = await client.query<SystemArchiveUploadChunkRow>(
    `SELECT chunk_index,byte_offset,byte_length,content_hash
       FROM system_archive_upload_chunks
      WHERE upload_id=$1 AND owner_user_id=$2
      ORDER BY byte_offset,chunk_index`,
    [uploadId, owner.ownerUserId]
  );
  const assembly = assemblyFromRows(upload, chunks.rows, upload.is_expired);
  const renewed = await renewUploadAuthority(
    client,
    owner,
    uploadId,
    upload.filesystem_operation_id,
    uploadTtlSeconds
  );
  return Object.freeze({
    upload: renewed,
    assembly: Object.freeze({ ...assembly, expiresAt: renewed.expires_at.toISOString() })
  });
}

export function createPostgresSystemArchiveUploadRepository(
  pool: DatabasePool,
  options: SystemArchiveUploadRepositoryOptions
): SystemArchiveUploadRepository {
  requireSafeInteger(options.uploadTtlSeconds, "System Archive upload TTL", 1);

  return {
    async createUpload(owner, request) {
      requireHash(request.handleTokenHash, "System Archive upload handle hash");
      requireHash(request.sha256, "System Archive upload content hash");
      requireSafeInteger(request.byteLength, "System Archive upload byte length", 0);
      try {
        return await withTransaction(pool, async (client) => {
          const result = await client.query<SystemArchiveUploadRow>(
            `INSERT INTO system_archive_uploads (
               owner_user_id,handle_token_hash,filesystem_operation_id,byte_length,content_hash,expires_at
             ) VALUES ($1,$2,$3,$4,$5,clock_timestamp()+($6::text || ' seconds')::interval)
             RETURNING ${UPLOAD_COLUMNS}`,
            [owner.ownerUserId, request.handleTokenHash, request.filesystemOperationId,
              request.byteLength, request.sha256, options.uploadTtlSeconds]
          );
          const row = result.rows[0];
          if (!row) throw new Error("System Archive upload creation did not return a session.");
          const operation = await client.query(
            `UPDATE durable_filesystem_operations
                SET expires_at=$3,updated_at=clock_timestamp()
              WHERE id=$1 AND owner_user_id=$2 AND purpose='portable_staging'
                AND resource_kind='portable' AND lifecycle='reserved'`,
            [request.filesystemOperationId, owner.ownerUserId, row.expires_at]
          );
          if (operation.rowCount !== 1) {
            throw repositoryError(
              "System Archive upload filesystem authority was not found for this owner.",
              404
            );
          }
          return toView(row);
        });
      } catch (error) {
        if (postgresCode(error) === "23505") {
          throw repositoryError("System Archive upload authority is already in use.", 409);
        }
        if (postgresCode(error) === "23503") {
          throw repositoryError("System Archive upload filesystem authority was not found for this owner.", 404);
        }
        throw error;
      }
    },

    async getUpload(owner, uploadId) {
      await pool.query(
        `UPDATE system_archive_uploads
            SET status='expired',updated_at=clock_timestamp()
          WHERE id=$1 AND owner_user_id=$2
            AND status IN ('created','uploading','completed')
            AND expires_at<=clock_timestamp()`,
        [uploadId, owner.ownerUserId]
      );
      const result = await pool.query<SystemArchiveUploadRow>(
        `SELECT ${UPLOAD_COLUMNS} FROM system_archive_uploads WHERE id=$1 AND owner_user_id=$2`,
        [uploadId, owner.ownerUserId]
      );
      if (!result.rows[0]) throw repositoryError("System Archive upload was not found.", 404);
      return toView(result.rows[0]);
    },

    async cancelUpload(owner, uploadId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<SystemArchiveUploadRow>(
          `UPDATE system_archive_uploads upload
              SET status='expired',expires_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE upload.id=$1 AND upload.owner_user_id=$2
              AND upload.status IN ('created','uploading','completed')
              AND NOT EXISTS (
                SELECT 1 FROM system_archive_jobs job
                 WHERE job.owner_user_id=upload.owner_user_id
                   AND job.staged_input_id=upload.staged_input_id
                   AND job.kind='import'
                   AND job.status IN (
                     'queued','previewed','revalidating','waiting_for_gate','importing',
                     'authoritative_committed','rebuilding','cancelling'
                   )
              )
          RETURNING ${UPLOAD_COLUMNS}`,
          [uploadId, owner.ownerUserId]
        );
        const row = result.rows[0];
        if (!row) {
          const visible = await client.query<{ status: SystemArchiveUploadView["status"] }>(
            "SELECT status FROM system_archive_uploads WHERE id=$1 AND owner_user_id=$2",
            [uploadId, owner.ownerUserId]
          );
          if (!visible.rows[0]) throw repositoryError("System Archive upload was not found.", 404);
          throw repositoryError("System Archive upload can no longer be cancelled.", 409);
        }
        await client.query(
          `UPDATE durable_filesystem_operations operation
              SET expires_at=clock_timestamp(),updated_at=clock_timestamp()
             FROM system_archive_uploads upload
            WHERE upload.id=$1 AND upload.owner_user_id=$2
              AND operation.id=upload.filesystem_operation_id
              AND operation.owner_user_id=upload.owner_user_id
              AND operation.purpose='portable_staging'`,
          [uploadId, owner.ownerUserId]
        );
        await client.query("COMMIT");
        return toView(row);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async getUploadSession(owner, uploadId) {
      const result = await pool.query<SystemArchiveUploadRow>(
        `SELECT ${UPLOAD_COLUMNS} FROM system_archive_uploads WHERE id=$1 AND owner_user_id=$2`,
        [uploadId, owner.ownerUserId]
      );
      if (!result.rows[0]) throw repositoryError("System Archive upload was not found.", 404);
      return toSession(result.rows[0]);
    },

    async recordChunk(owner, request) {
      requireChunkIndex(request.index);
      requireSafeInteger(request.offset, "System Archive chunk offset", 0);
      requireSafeInteger(request.bytes, "System Archive chunk byte length", 1);
      requireHash(request.sha256, "System Archive chunk hash");
      if (!Number.isSafeInteger(request.offset + request.bytes)) {
        throw repositoryError("System Archive chunk range exceeds safe integer bounds.", 400);
      }

      const outcome = await withTransaction(pool, async (client) => {
        const locked = await client.query<LockedSystemArchiveUploadRow>(
          `SELECT ${UPLOAD_COLUMNS},expires_at<=clock_timestamp() AS is_expired
             FROM system_archive_uploads
            WHERE id=$1 AND owner_user_id=$2
            FOR UPDATE`,
          [request.uploadId, owner.ownerUserId]
        );
        const upload = locked.rows[0];
        if (!upload) throw repositoryError("System Archive upload was not found.", 404);
        if (upload.status !== "created" && upload.status !== "uploading") {
          throw repositoryError(`System Archive upload cannot accept chunks from ${upload.status}.`, 409);
        }
        if (upload.is_expired) {
          await client.query(
            "UPDATE system_archive_uploads SET status='expired',updated_at=clock_timestamp() WHERE id=$1",
            [request.uploadId]
          );
          return null;
        }
        if (request.offset + request.bytes > Number(upload.byte_length)) {
          throw repositoryError("System Archive chunk exceeds the declared upload length.", 400);
        }

        const existing = await client.query<SystemArchiveUploadChunkRow>(
          `SELECT chunk_index,byte_offset,byte_length,content_hash
             FROM system_archive_upload_chunks
            WHERE upload_id=$1 AND chunk_index=$2`,
          [request.uploadId, request.index]
        );
        const chunk = existing.rows[0];
        if (chunk) {
          if (Number(chunk.byte_offset) !== request.offset
            || Number(chunk.byte_length) !== request.bytes
            || chunk.content_hash !== request.sha256) {
            throw repositoryError("System Archive chunk replay conflicts with persisted metadata.", 409);
          }
          const renewed = await renewUploadAuthority(
            client,
            owner,
            request.uploadId,
            upload.filesystem_operation_id,
            options.uploadTtlSeconds
          );
          return toView(renewed);
        }

        if (request.offset !== Number(upload.received_bytes)) {
          throw repositoryError(
            "System Archive chunk does not begin at the durable upload prefix.",
            409,
            "system-archive-upload-offset-conflict"
          );
        }

        try {
          await client.query(
            `INSERT INTO system_archive_upload_chunks (
               upload_id,owner_user_id,filesystem_operation_id,chunk_index,byte_offset,byte_length,content_hash
             ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [request.uploadId, owner.ownerUserId, upload.filesystem_operation_id,
              request.index, request.offset, request.bytes, request.sha256]
          );
        } catch (error) {
          if (postgresCode(error) === "23505") {
            throw repositoryError("System Archive chunk range conflicts with persisted metadata.", 409);
          }
          throw error;
        }

        const updated = await client.query<SystemArchiveUploadRow>(
          `UPDATE system_archive_uploads
              SET status='uploading',received_bytes=received_bytes+$2,
                  expires_at=clock_timestamp()+($3::text || ' seconds')::interval,
                  updated_at=clock_timestamp()
            WHERE id=$1
           RETURNING ${UPLOAD_COLUMNS}`,
          [request.uploadId, request.bytes, options.uploadTtlSeconds]
        );
        const row = updated.rows[0];
        if (!row) throw new Error("System Archive chunk persistence lost its upload session.");
        const operation = await client.query(
          `UPDATE durable_filesystem_operations
              SET expires_at=$3,updated_at=clock_timestamp()
            WHERE id=$1 AND owner_user_id=$2 AND purpose='portable_staging'
              AND resource_kind='portable' AND lifecycle IN ('reserved','attached','finalized')`,
          [upload.filesystem_operation_id, owner.ownerUserId, row.expires_at]
        );
        if (operation.rowCount !== 1) {
          throw new Error("System Archive chunk persistence lost its filesystem authority.");
        }
        return toView(row);
      });
      if (!outcome) throw repositoryError("System Archive upload has expired.", 410);
      return outcome;
    },

    async reconcileChunk(owner, request) {
      requireChunkIndex(request.index);
      requireSafeInteger(request.offset, "System Archive chunk offset", 0);
      requireSafeInteger(request.bytes, "System Archive chunk byte length", 1);
      requireHash(request.sha256, "System Archive chunk hash");
      const reconciled = await pool.query<SystemArchiveUploadRow>(
        `SELECT upload.id,upload.owner_user_id,upload.filesystem_operation_id,upload.status,
                upload.byte_length,upload.received_bytes,upload.content_hash,
                upload.staged_input_id,upload.expires_at
           FROM system_archive_uploads upload
           JOIN system_archive_upload_chunks chunk
             ON chunk.upload_id=upload.id
            AND chunk.owner_user_id=upload.owner_user_id
            AND chunk.filesystem_operation_id=upload.filesystem_operation_id
          WHERE upload.id=$1 AND upload.owner_user_id=$2
            AND chunk.chunk_index=$3 AND chunk.byte_offset=$4
            AND chunk.byte_length=$5 AND chunk.content_hash=$6`,
        [request.uploadId, owner.ownerUserId, request.index,
          request.offset, request.bytes, request.sha256]
      );
      const row = reconciled.rows[0];
      return row ? toView(row) : null;
    },

    async getAssembly(owner, uploadId) {
      return withTransaction(pool, async (client) => (
        await lockedAssembly(client, owner, uploadId, options.uploadTtlSeconds)
      ).assembly);
    },

    async completeUpload(owner, request) {
      return withTransaction(pool, async (client) => {
        const { upload, assembly } = await lockedAssembly(
          client,
          owner,
          request.uploadId,
          options.uploadTtlSeconds
        );
        const staged = await client.query<{
          id: string;
          filesystem_operation_id: string;
          content_hash: string;
          byte_length: string | number;
        }>(
          `SELECT id,filesystem_operation_id,content_hash,byte_length
             FROM portable_staged_inputs
            WHERE id=$1 AND owner_user_id=$2 AND status='staged'
              AND expires_at > clock_timestamp()
            FOR NO KEY UPDATE`,
          [request.stagedInputId, owner.ownerUserId]
        );
        const input = staged.rows[0];
        if (!input
          || input.filesystem_operation_id !== assembly.filesystemOperationId
          || input.content_hash !== assembly.sha256
          || Number(input.byte_length) !== assembly.byteLength) {
          throw repositoryError(
            "System Archive assembled input does not match the declared upload identity.",
            409
          );
        }
        const updated = await client.query<SystemArchiveUploadRow>(
          `UPDATE system_archive_uploads
              SET status='completed',staged_input_id=$3,updated_at=clock_timestamp()
            WHERE id=$1 AND owner_user_id=$2
              AND status IN ('created','uploading')
              AND received_bytes=byte_length
              AND staged_input_id IS NULL
           RETURNING ${UPLOAD_COLUMNS}`,
          [request.uploadId, owner.ownerUserId, request.stagedInputId]
        );
        const row = updated.rows[0];
        if (!row || upload.id !== row.id) {
          throw repositoryError("System Archive upload completion conflicted with another request.", 409);
        }
        const operation = await client.query(
          `UPDATE durable_filesystem_operations
              SET expires_at=$3,updated_at=clock_timestamp()
            WHERE id=$1 AND owner_user_id=$2 AND purpose='portable_staging'
              AND resource_kind='portable' AND lifecycle IN ('reserved','attached','finalized')`,
          [assembly.filesystemOperationId, owner.ownerUserId, row.expires_at]
        );
        const stagedRenewal = await client.query(
          `UPDATE portable_staged_inputs
              SET expires_at=GREATEST(expires_at,$3),updated_at=clock_timestamp()
            WHERE id=$1 AND owner_user_id=$2 AND status='staged'`,
          [request.stagedInputId, owner.ownerUserId, row.expires_at]
        );
        if (operation.rowCount !== 1 || stagedRenewal.rowCount !== 1) {
          throw new Error("System Archive upload completion lost its private authority.");
        }
        return toView(row);
      });
    },

    async reconcileCompletion(owner, request) {
      const reconciled = await pool.query<SystemArchiveUploadRow>(
        `SELECT upload.id,upload.owner_user_id,upload.filesystem_operation_id,upload.status,
                upload.byte_length,upload.received_bytes,upload.content_hash,
                upload.staged_input_id,upload.expires_at
           FROM system_archive_uploads upload
           JOIN portable_staged_inputs staged
             ON staged.id=upload.staged_input_id
            AND staged.owner_user_id=upload.owner_user_id
            AND staged.filesystem_operation_id=upload.filesystem_operation_id
            AND staged.content_hash=upload.content_hash
            AND staged.byte_length=upload.byte_length
          WHERE upload.id=$1 AND upload.owner_user_id=$2
            AND upload.status='completed' AND upload.staged_input_id=$3`,
        [request.uploadId, owner.ownerUserId, request.stagedInputId]
      );
      const row = reconciled.rows[0];
      return row ? toView(row) : null;
    }
  };
}
