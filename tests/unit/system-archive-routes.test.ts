import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  bindSystemArchiveDownloadCleanup,
  registerSystemArchiveRoutes,
} from "../../services/api/src/system-archive-routes.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const uploadId = "33333333-3333-4333-8333-333333333333";
const now = "2026-08-25T12:00:00.000Z";

const exportJob = Object.freeze({
  id: jobId,
  kind: "export" as const,
  status: "queued" as const,
  createdAt: now,
  updatedAt: now,
  report: null,
});

const importJob = Object.freeze({
  id: jobId,
  kind: "import" as const,
  status: "queued" as const,
  createdAt: now,
  updatedAt: now,
  report: null,
});

const upload = Object.freeze({
  id: uploadId,
  status: "created" as const,
  byteLength: 4,
  receivedBytes: 0,
  expiresAt: "2026-08-26T12:00:00.000Z",
});

function application() {
  return {
    enqueueExport: vi.fn(async () => exportJob),
    getJob: vi.fn(async () => exportJob),
    cancelJob: vi.fn(async () => ({ ...exportJob, status: "cancelling" as const })),
    createUpload: vi.fn(async () => upload),
    getUpload: vi.fn(async () => upload),
    cancelUpload: vi.fn(async () => ({ ...upload, status: "expired" as const })),
    putChunk: vi.fn(async () => ({ ...upload, status: "uploading" as const, receivedBytes: 4 })),
    completeUpload: vi.fn(async () => ({ ...upload, status: "completed" as const, receivedBytes: 4 })),
    previewImport: vi.fn(),
    commitImport: vi.fn(async () => importJob),
  };
}

function downloads(bytes = Buffer.from("abcdefgh", "utf8")) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const finalize = vi.fn(async () => undefined);
  return {
    sha256,
    finalize,
    metadata: vi.fn(async () => ({ byteLength: bytes.byteLength, sha256 })),
    open: vi.fn(async (input: { start: number; end: number }) => ({
      contentType: "application/zip" as const,
      byteLength: input.end - input.start + 1,
      totalByteLength: bytes.byteLength,
      sha256,
      chunks: (async function* () {
        yield bytes.subarray(input.start, input.end + 1);
      })(),
      finalize,
    })),
  };
}

async function appFor(input: Readonly<{
  enabled?: boolean;
  application?: ReturnType<typeof application>;
  downloads?: ReturnType<typeof downloads>;
  owner?: string;
  chunkBytes?: number;
  capturedErrors?: unknown[];
}> = {}) {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    input.capturedErrors?.push(error);
    return reply.code(
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number(error.statusCode)
        : typeof error === "object" && error !== null && "issues" in error
          ? 400
          : 500,
    ).send({
      code: typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
  });
  const api = input.application ?? application();
  const transfer = input.downloads ?? downloads();
  await app.register(registerSystemArchiveRoutes, {
    enabled: input.enabled ?? true,
    application: api,
    downloads: transfer,
    resolveOwner: async () => ({ ownerUserId: input.owner ?? ownerUserId }),
    limits: {
      chunkBytes: input.chunkBytes ?? 4,
      maximumUploadBytes: 64,
      maximumDownloadBytes: 64,
      downloadDeadlineMs: 60_000,
    },
  });
  return { app, api, transfer };
}

describe("System Archive routes", () => {
  it("does not register any System Archive endpoint while the capability is disabled", async () => {
    const { app } = await appFor({ enabled: false });
    try {
      expect((await app.inject({ method: "POST", url: "/api/v1/system-exports", payload: { idempotencyKey: "key" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: "/api/v1/system-imports/uploads", payload: { byteLength: 1, sha256: "a".repeat(64) } })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("enqueues an idempotent export for only the server-resolved Current Owner", async () => {
    const { app, api } = await appFor();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/system-exports",
        payload: { idempotencyKey: "export-once" },
      });
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json()).toEqual(exportJob);
      expect(api.enqueueExport).toHaveBeenCalledWith({ ownerUserId, idempotencyKey: "export-once" });

      const replay = await app.inject({
        method: "POST",
        url: "/api/v1/system-exports",
        payload: { idempotencyKey: "export-once" },
      });
      expect(replay.statusCode, replay.body).toBe(202);
      expect(replay.json()).toEqual(exportJob);

      const spoof = await app.inject({
        method: "POST",
        url: "/api/v1/system-exports",
        payload: { idempotencyKey: "export-once", ownerUserId: "99999999-9999-4999-8999-999999999999" },
      });
      expect(spoof.statusCode).toBe(400);
      expect(api.enqueueExport).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("treats malformed application projections as server failures, not client errors", async () => {
    const api = application();
    api.enqueueExport.mockResolvedValueOnce({
      id: "not-a-uuid",
      kind: "export",
      status: "queued",
    } as never);
    const { app } = await appFor({ application: api });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/system-exports",
        payload: { idempotencyKey: "projection-failure" },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        code: "system-archive-response-invalid",
        message: "System Archive response failed validation.",
      });
      expect(response.body).not.toContain("not-a-uuid");
    } finally {
      await app.close();
    }
  });

  it("uses Current Owner scope for status and cancellation and preserves cancellation boundaries", async () => {
    const api = application();
    api.cancelJob.mockRejectedValueOnce(Object.assign(new Error("Import can no longer be cancelled."), {
      code: "system-archive-cancellation-boundary",
      statusCode: 409,
    }));
    const { app } = await appFor({ application: api });
    try {
      const status = await app.inject({ method: "GET", url: `/api/v1/system-exports/${jobId}` });
      expect(status.statusCode).toBe(200);
      expect(api.getJob).toHaveBeenCalledWith({ ownerUserId, jobId });

      const cancelled = await app.inject({ method: "DELETE", url: `/api/v1/system-imports/${jobId}` });
      expect(cancelled.statusCode).toBe(409);
      expect(cancelled.json()).toMatchObject({ code: "system-archive-cancellation-boundary" });
      expect(api.cancelJob).toHaveBeenCalledWith({ ownerUserId, jobId });
    } finally {
      await app.close();
    }
  });

  it("maps production repository failures to stable typed API codes without logging raw authority", async () => {
    const marker = "C:\\private\\story-secret-token.txt";
    const api = application();
    api.getJob.mockRejectedValueOnce(Object.assign(new Error(marker), { statusCode: 404 }));
    api.cancelJob.mockRejectedValueOnce(Object.assign(new Error(marker), { statusCode: 409 }));
    api.getUpload.mockRejectedValueOnce(Object.assign(new Error(marker), { statusCode: 410 }));
    api.commitImport.mockRejectedValueOnce(Object.assign(new Error(marker), { statusCode: 409 }));
    api.enqueueExport.mockRejectedValueOnce(new Error(marker));
    const capturedErrors: unknown[] = [];
    const { app } = await appFor({ application: api, capturedErrors });
    try {
      const notFound = await app.inject({ method: "GET", url: `/api/v1/system-exports/${jobId}` });
      expect(notFound.statusCode).toBe(404);
      expect(notFound.json()).toMatchObject({ code: "system-archive-job-not-found" });

      const cancelConflict = await app.inject({ method: "DELETE", url: `/api/v1/system-imports/${jobId}` });
      expect(cancelConflict.statusCode).toBe(409);
      expect(cancelConflict.json()).toMatchObject({ code: "system-archive-cancellation-boundary" });

      const expired = await app.inject({ method: "GET", url: `/api/v1/system-imports/uploads/${uploadId}` });
      expect(expired.statusCode).toBe(410);
      expect(expired.json()).toMatchObject({ code: "system-archive-upload-expired" });

      const stale = await app.inject({
        method: "POST",
        url: "/api/v1/system-imports",
        payload: {
          previewHandle: "opaque-stale-preview",
          idempotencyKey: "stale-import",
          acknowledgeSensitiveArchive: true,
          acknowledgeEmptyDestination: true,
          acknowledgeInvalidatedAccess: true,
          acknowledgeProviderReentry: true,
          acknowledgeNonCancellableBoundary: true,
        },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "system-archive-preview-stale" });

      const failed = await app.inject({
        method: "POST",
        url: "/api/v1/system-exports",
        payload: { idempotencyKey: "fail-safely" },
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toMatchObject({ code: "system-archive-operation-failed" });

      const fullErrorLogProjection = capturedErrors.map((error) => error instanceof Error
        ? `${error.name}\n${error.message}\n${error.stack ?? ""}`
        : JSON.stringify(error)).join("\n");
      expect(fullErrorLogProjection).not.toContain(marker);
      expect([notFound.body, cancelConflict.body, expired.body, stale.body, failed.body].join("\n"))
        .not.toContain(marker);
    } finally {
      await app.close();
    }
  });

  it("bounds raw chunks, verifies range metadata, and passes only opaque upload authority", async () => {
    const { app, api } = await appFor({ chunkBytes: 4 });
    const bytes = Buffer.from([1, 2, 3, 4]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/system-imports/uploads/${uploadId}/chunks/0`,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "4",
          "content-range": "bytes 0-3/4",
          "x-chunk-sha256": sha256,
        },
        payload: bytes,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(api.putChunk).toHaveBeenCalledWith({
        ownerUserId,
        uploadId,
        index: 0,
        offset: 0,
        bytes: expect.any(Uint8Array),
        sha256,
      });

      const oversized = await app.inject({
        method: "PUT",
        url: `/api/v1/system-imports/uploads/${uploadId}/chunks/1`,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "5",
          "content-range": "bytes 0-4/5",
          "x-chunk-sha256": "a".repeat(64),
        },
        payload: Buffer.alloc(5),
      });
      expect(oversized.statusCode).toBe(413);
      expect(api.putChunk).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("rejects a chunk gap before publishing bytes while retaining the replay path behind persisted authority", async () => {
    const api = application();
    api.getUpload.mockResolvedValueOnce({ ...upload, status: "uploading", receivedBytes: 2 } as never);
    const { app } = await appFor({ application: api, chunkBytes: 4 });
    const bytes = Buffer.from([4]);
    try {
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/system-imports/uploads/${uploadId}/chunks/1`,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "1",
          "content-range": "bytes 3-3/4",
          "x-chunk-sha256": createHash("sha256").update(bytes).digest("hex"),
        },
        payload: bytes,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "system-archive-upload-offset-conflict" });
      expect(api.putChunk).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("distinguishes invalid upload length, configured limits, and unsupported chunk media", async () => {
    const { app, api } = await appFor();
    try {
      const empty = await app.inject({
        method: "POST",
        url: "/api/v1/system-imports/uploads",
        payload: { byteLength: 0, sha256: "a".repeat(64) },
      });
      expect(empty.statusCode).toBe(400);

      const oversized = await app.inject({
        method: "POST",
        url: "/api/v1/system-imports/uploads",
        payload: { byteLength: 65, sha256: "a".repeat(64) },
      });
      expect(oversized.statusCode).toBe(413);
      expect(api.createUpload).not.toHaveBeenCalled();

      const wrongMedia = await app.inject({
        method: "PUT",
        url: `/api/v1/system-imports/uploads/${uploadId}/chunks/0`,
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(wrongMedia.statusCode).toBe(415);
      expect(api.putChunk).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("requires all destructive-import acknowledgements before consuming preview authority", async () => {
    const { app, api } = await appFor();
    const base = { previewHandle: "preview-handle", idempotencyKey: "import-once" };
    try {
      const missing = await app.inject({ method: "POST", url: "/api/v1/system-imports", payload: base });
      expect(missing.statusCode).toBe(400);
      expect(api.commitImport).not.toHaveBeenCalled();

      const accepted = await app.inject({
        method: "POST",
        url: "/api/v1/system-imports",
        payload: {
          ...base,
          acknowledgeSensitiveArchive: true,
          acknowledgeEmptyDestination: true,
          acknowledgeInvalidatedAccess: true,
          acknowledgeProviderReentry: true,
          acknowledgeNonCancellableBoundary: true,
        },
      });
      expect(accepted.statusCode, accepted.body).toBe(202);
      expect(api.commitImport).toHaveBeenCalledWith({
        ownerUserId,
        previewHandle: "preview-handle",
        idempotencyKey: "import-once",
      });
    } finally {
      await app.close();
    }
  });

  it("returns a typed conflict without exposing or inspecting stale preview authority", async () => {
    const api = application();
    api.commitImport.mockRejectedValueOnce(Object.assign(new Error("System Archive preview authority is stale."), {
      code: "system-archive-preview-stale",
      statusCode: 409,
    }));
    const { app } = await appFor({ application: api });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/system-imports",
        payload: {
          previewHandle: "opaque-stale-preview",
          idempotencyKey: "stale-import",
          acknowledgeSensitiveArchive: true,
          acknowledgeEmptyDestination: true,
          acknowledgeInvalidatedAccess: true,
          acknowledgeProviderReentry: true,
          acknowledgeNonCancellableBoundary: true,
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "system-archive-preview-stale" });
      expect(api.commitImport).toHaveBeenCalledWith({
        ownerUserId,
        previewHandle: "opaque-stale-preview",
        idempotencyKey: "stale-import",
      });
    } finally {
      await app.close();
    }
  });

  it("serves strong ETag range downloads with If-Range and no-store semantics", async () => {
    const transfer = downloads();
    const { app } = await appFor({ downloads: transfer });
    try {
      const partial = await app.inject({
        method: "GET",
        url: `/api/v1/system-exports/${jobId}/download`,
        headers: { range: "bytes=2-5", "if-range": `"${transfer.sha256}"` },
      });
      expect(partial.statusCode, partial.body).toBe(206);
      expect(partial.rawPayload).toEqual(Buffer.from("cdef"));
      expect(partial.headers).toMatchObject({
        "accept-ranges": "bytes",
        "cache-control": "no-store",
        "content-range": "bytes 2-5/8",
        "content-length": "4",
        etag: `"${transfer.sha256}"`,
      });
      expect(transfer.open).toHaveBeenCalledWith(expect.objectContaining({
        owner: { ownerUserId },
        jobId,
        start: 2,
        end: 5,
        expectedSha256: transfer.sha256,
      }));
      expect(transfer.finalize).toHaveBeenCalledWith("eof");

      const changed = await app.inject({
        method: "GET",
        url: `/api/v1/system-exports/${jobId}/download`,
        headers: { range: "bytes=2-5", "if-range": '"stale"' },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.rawPayload).toEqual(Buffer.from("abcdefgh"));

      const unsatisfied = await app.inject({
        method: "GET",
        url: `/api/v1/system-exports/${jobId}/download`,
        headers: { range: "bytes=99-100" },
      });
      expect(unsatisfied.statusCode).toBe(416);
      expect(unsatisfied.headers).toMatchObject({
        "accept-ranges": "bytes",
        "cache-control": "no-store",
        "content-range": "bytes */8",
        etag: `"${transfer.sha256}"`,
      });
    } finally {
      await app.close();
    }
  });

  it("finalizes the private stream exactly once after a response disconnect", async () => {
    const response = new EventEmitter();
    const stream = new Readable({ read() {}, emitClose: false });
    const finalize = vi.fn(async () => undefined);
    bindSystemArchiveDownloadCleanup(stream, response, finalize);

    response.emit("close");
    stream.emit("close");
    response.emit("aborted");
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce());
    expect(finalize).toHaveBeenCalledWith("abort");
  });

  it("finalizes before sending when download metadata changes behind an opaque job handle", async () => {
    const transfer = downloads();
    const finalize = vi.fn(async () => undefined);
    transfer.open.mockResolvedValueOnce({
      contentType: "application/zip",
      byteLength: 8,
      totalByteLength: 8,
      sha256: "f".repeat(64),
      chunks: (async function* () { yield Buffer.from("abcdefgh"); })(),
      finalize,
    });
    const { app } = await appFor({ downloads: transfer });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/system-exports/${jobId}/download`,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "system-archive-download-stale" });
      expect(finalize).toHaveBeenCalledOnce();
      expect(finalize).toHaveBeenCalledWith("pre_send_failure");
    } finally {
      await app.close();
    }
  });
});
