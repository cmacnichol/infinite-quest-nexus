import { describe, expect, it, vi } from "vitest";
import type { SystemArchiveUploadView } from "@infinite-quest/contracts";
import {
  createSystemArchiveUploadService,
  type SystemArchiveUploadStoragePort,
} from "../../services/runtime/src/system-archive-composition.js";
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
