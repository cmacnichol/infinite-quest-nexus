import {
  systemUploadViewSchema,
  type SystemArchiveUploadView
} from "@infinite-quest/contracts";
import type { OwnerScope } from "../../application/src/generation/types.js";
import type { DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

type SystemArchiveUploadRow = Readonly<{
  id: string;
  owner_user_id: string;
  filesystem_operation_id: string;
  status: "created" | "uploading" | "completed" | "expired" | "failed";
  byte_length: string | number;
  received_bytes: string | number;
  content_hash: string;
  expires_at: Date;
}>;

type SystemArchiveUploadChunkRow = Readonly<{
  chunk_index: number;
  byte_offset: string | number;
  byte_length: string | number;
  content_hash: string;
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

export interface SystemArchiveUploadRepository {
  createUpload(owner: OwnerScope, request: CreateSystemArchiveUploadRequest): Promise<SystemArchiveUploadView>;
  getUpload(owner: OwnerScope, uploadId: string): Promise<SystemArchiveUploadView>;
  recordChunk(
    owner: OwnerScope,
    request: RecordSystemArchiveUploadChunkRequest
  ): Promise<SystemArchiveUploadView>;
}

type SystemArchiveUploadRepositoryOptions = Readonly<{
  uploadTtlSeconds: number;
}>;

const UPLOAD_COLUMNS = `id,owner_user_id,filesystem_operation_id,status,byte_length,
  received_bytes,content_hash,expires_at`;

function repositoryError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
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

function toView(row: SystemArchiveUploadRow): SystemArchiveUploadView {
  return systemUploadViewSchema.parse({
    id: row.id,
    status: row.status,
    byteLength: Number(row.byte_length),
    receivedBytes: Number(row.received_bytes),
    expiresAt: row.expires_at.toISOString()
  });
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
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
        const result = await pool.query<SystemArchiveUploadRow>(
          `INSERT INTO system_archive_uploads (
             owner_user_id,handle_token_hash,filesystem_operation_id,byte_length,content_hash,expires_at
           ) VALUES ($1,$2,$3,$4,$5,clock_timestamp()+($6::text || ' seconds')::interval)
           RETURNING ${UPLOAD_COLUMNS}`,
          [owner.ownerUserId, request.handleTokenHash, request.filesystemOperationId,
            request.byteLength, request.sha256, options.uploadTtlSeconds]
        );
        const row = result.rows[0];
        if (!row) throw new Error("System Archive upload creation did not return a session.");
        return toView(row);
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
      const result = await pool.query<SystemArchiveUploadRow>(
        `SELECT ${UPLOAD_COLUMNS} FROM system_archive_uploads WHERE id=$1 AND owner_user_id=$2`,
        [uploadId, owner.ownerUserId]
      );
      if (!result.rows[0]) throw repositoryError("System Archive upload was not found.", 404);
      return toView(result.rows[0]);
    },

    async recordChunk(owner, request) {
      requireSafeInteger(request.index, "System Archive chunk index", 0);
      requireSafeInteger(request.offset, "System Archive chunk offset", 0);
      requireSafeInteger(request.bytes, "System Archive chunk byte length", 1);
      requireHash(request.sha256, "System Archive chunk hash");
      if (!Number.isSafeInteger(request.offset + request.bytes)) {
        throw repositoryError("System Archive chunk range exceeds safe integer bounds.", 400);
      }

      return withTransaction(pool, async (client) => {
        const locked = await client.query<SystemArchiveUploadRow>(
          `SELECT ${UPLOAD_COLUMNS}
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
        if (upload.expires_at.getTime() <= Date.now()) {
          await client.query(
            "UPDATE system_archive_uploads SET status='expired',updated_at=clock_timestamp() WHERE id=$1",
            [request.uploadId]
          );
          throw repositoryError("System Archive upload has expired.", 410);
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
          return toView(upload);
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
        return toView(row);
      });
    }
  };
}
