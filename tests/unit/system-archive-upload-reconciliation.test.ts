import { describe, expect, it, vi } from "vitest";
import type { SystemArchiveUploadView } from "@infinite-quest/contracts";
import {
  createSystemArchiveUploadService,
  type SystemArchiveUploadStoragePort,
} from "../../services/runtime/src/system-archive-composition.js";
import { createPostgresSystemArchiveUploadRepository } from "../../packages/database/src/system-archive-upload-repository.js";
import { persistSystemArchiveChunkWithReconciliation } from "../../services/runtime/src/secure-filesystem-adapter.js";

const owner = { ownerUserId: "11111111-1111-4111-8111-111111111111" };
const uploadId = "22222222-2222-4222-8222-222222222222";
const stagedInputId = "33333333-3333-4333-8333-333333333333";
const completed: SystemArchiveUploadView = {
  id: uploadId,
  status: "completed",
  byteLength: 4,
  receivedBytes: 4,
  expiresAt: "2026-08-26T12:00:00.000Z",
};

describe("System Archive ambiguous persistence reconciliation", () => {
  it("projects an elapsed upload authority as expired for public status", async () => {
    const expiredRow = {
      id: uploadId,
      owner_user_id: owner.ownerUserId,
      filesystem_operation_id: "44444444-4444-4444-8444-444444444444",
      status: "expired" as const,
      byte_length: 4,
      received_bytes: 2,
      content_hash: "a".repeat(64),
      staged_input_id: null,
      expires_at: new Date("2026-08-25T12:00:00.000Z"),
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [expiredRow], rowCount: 1 });
    const uploads = createPostgresSystemArchiveUploadRepository({ query } as never, {
      uploadTtlSeconds: 300,
    });

    await expect(uploads.getUpload(owner, uploadId)).resolves.toMatchObject({
      id: uploadId,
      status: "expired",
    });

    expect(query.mock.calls[0]?.[0]).toContain("expires_at<=clock_timestamp()");
    expect(query.mock.calls.every((call) => call[1][1] === owner.ownerUserId)).toBe(true);
  });

  it("preserves chunk bytes when metadata committed before the caller observed an error", async () => {
    let committed = false;
    const compensate = vi.fn(async () => undefined);

    await expect(persistSystemArchiveChunkWithReconciliation(
      async () => {
        committed = true;
        throw new Error("connection dropped after COMMIT");
      },
      async () => committed ? completed : null,
      compensate,
    )).resolves.toBe(completed);
    expect(compensate).not.toHaveBeenCalled();
  });

  it("rejects a new chunk beyond the durable sequential prefix before advancing received bytes", async () => {
    const uploadRow = {
      id: uploadId,
      owner_user_id: owner.ownerUserId,
      filesystem_operation_id: "44444444-4444-4444-8444-444444444444",
      status: "uploading" as const,
      byte_length: 12,
      received_bytes: 4,
      content_hash: "a".repeat(64),
      staged_input_id: null,
      expires_at: new Date("2026-08-26T12:00:00.000Z"),
      is_expired: false,
    };
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("FROM system_archive_uploads") && sql.includes("FOR UPDATE")) {
        return { rows: [uploadRow], rowCount: 1 };
      }
      if (sql.includes("FROM system_archive_upload_chunks") && sql.includes("chunk_index=$2")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO system_archive_upload_chunks")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE system_archive_uploads") && sql.includes("received_bytes=received_bytes")) {
        return { rows: [{ ...uploadRow, received_bytes: 8 }], rowCount: 1 };
      }
      if (sql.includes("UPDATE durable_filesystem_operations")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const client = { query, release: vi.fn() };
    const uploads = createPostgresSystemArchiveUploadRepository({
      connect: vi.fn(async () => client),
    } as never, { uploadTtlSeconds: 300 });

    await expect(uploads.recordChunk(owner, {
      uploadId,
      index: 1,
      offset: 8,
      bytes: 4,
      sha256: "b".repeat(64),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "system-archive-upload-offset-conflict",
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO system_archive_upload_chunks")))
      .toBe(false);
  });

  it("preserves finalized staged authority when completion committed before an error", async () => {
    let committed = false;
    const rollback = vi.fn(async () => undefined);
    const uploads = {
      async getAssembly() {
        return {
          uploadId,
          filesystemOperationId: "44444444-4444-4444-8444-444444444444",
          byteLength: 4,
          sha256: "a".repeat(64),
          expiresAt: "2026-08-26T12:00:00.000Z",
          chunks: [{ index: 0, offset: 0, bytes: 4, sha256: "b".repeat(64) }],
        };
      },
      async completeUpload() {
        committed = true;
        throw new Error("connection dropped after COMMIT");
      },
      async reconcileCompletion() {
        return committed ? completed : null;
      },
    };
    const storage: SystemArchiveUploadStoragePort = {
      async prepare() {
        throw new Error("not used");
      },
      async publishChunk() {
        throw new Error("not used");
      },
      async assemble() {
        return { stagedInputId, byteLength: 4, sha256: "a".repeat(64), rollback };
      },
    };
    const service = createSystemArchiveUploadService({
      uploads: uploads as never,
      storage,
      chunkBytes: 4,
      maximumBytes: 4,
    });

    await expect(service.completeUpload(owner, uploadId)).resolves.toBe(completed);
    expect(rollback).not.toHaveBeenCalled();
  });
});
