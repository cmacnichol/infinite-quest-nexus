import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  systemArchiveExportRequestSchema,
  systemArchiveImportCommitRequestSchema,
  systemArchiveJobViewSchema,
  systemArchiveUploadCreateRequestSchema,
  systemImportPreviewViewSchema,
  systemUploadViewSchema,
} from "@infinite-quest/contracts";
import {
  toSystemArchiveJobId,
  toSystemArchivePreviewHandle,
  toSystemArchiveUploadId,
  type SystemArchiveApplication,
} from "../../../packages/application/src/system-archives/index.js";
import type { OwnerScope } from "../../../packages/application/src/generation/types.js";
import type { PrivateStreamTerminalReason } from "../../../packages/application/src/assets/private-secure-storage.js";

const uuidParameterSchema = z.object({ jobId: z.uuid() }).strict();
const uploadParameterSchema = z.object({ uploadId: z.uuid() }).strict();
const chunkParameterSchema = z.object({
  uploadId: z.uuid(),
  index: z.coerce.number().int().min(0).max(2_147_483_647),
}).strict();
const previewRequestSchema = z.object({ uploadId: z.uuid() }).strict();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export type SystemArchiveDownloadMetadata = Readonly<{
  byteLength: number;
  sha256: string;
}>;

export type SystemArchiveDownloadSession = Readonly<{
  contentType: "application/zip";
  byteLength: number;
  totalByteLength: number;
  sha256: string;
  chunks: AsyncIterable<Uint8Array>;
  finalize(reason: PrivateStreamTerminalReason): Promise<void>;
}>;

export interface SystemArchiveDownloadPort {
  metadata(owner: OwnerScope, jobId: string): Promise<SystemArchiveDownloadMetadata>;
  open(input: Readonly<{
    owner: OwnerScope;
    jobId: string;
    start: number;
    end: number;
    expectedSha256: string;
    maximumBytes: number;
    deadlineAt: string;
  }>): Promise<SystemArchiveDownloadSession>;
}

export type SystemArchiveRouteOptions = Readonly<{
  enabled: boolean;
  application: SystemArchiveApplication;
  downloads: SystemArchiveDownloadPort;
  resolveOwner(): Promise<OwnerScope>;
  limits: Readonly<{
    chunkBytes: number;
    maximumUploadBytes: number;
    maximumDownloadBytes: number;
    downloadDeadlineMs: number;
  }>;
}>;

type EventSource = Readonly<{
  once(event: string, listener: () => void): unknown;
}>;

class SystemArchiveRouteError extends Error {
  readonly expose: boolean;

  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "SystemArchiveError";
    this.expose = statusCode < 500;
  }
}

const SANITIZED_SYSTEM_ARCHIVE_SERVER_CODES = new Set([
  "system-archive-operation-failed",
  "system-archive-response-invalid",
]);

export function isSanitizedSystemArchiveServerError(error: unknown): boolean {
  return error instanceof SystemArchiveRouteError
    && error.statusCode >= 500
    && SANITIZED_SYSTEM_ARCHIVE_SERVER_CODES.has(error.code);
}

function httpError(message: string, statusCode: number, code: string): Error {
  return new SystemArchiveRouteError(message, statusCode, code);
}

type BoundaryOperation =
  | "enqueue-export"
  | "get-job"
  | "cancel-job"
  | "download"
  | "create-upload"
  | "get-upload"
  | "cancel-upload"
  | "put-chunk"
  | "complete-upload"
  | "preview-import"
  | "commit-import";

const SAFE_BOUNDARY_ERRORS: Readonly<Record<string, Readonly<{
  statusCode: number;
  message: string;
}>>> = Object.freeze({
  "system-archive-job-not-found": { statusCode: 404, message: "System Archive job was not found." },
  "system-archive-cancellation-boundary": { statusCode: 409, message: "System Archive can no longer be cancelled." },
  "system-archive-download-unavailable": { statusCode: 404, message: "System Archive download is unavailable." },
  "system-archive-download-stale": { statusCode: 409, message: "System Archive download authority changed." },
  "system-archive-range-invalid": { statusCode: 416, message: "System Archive byte range is invalid." },
  "system-archive-upload-not-found": { statusCode: 404, message: "System Archive upload was not found." },
  "system-archive-upload-expired": { statusCode: 410, message: "System Archive upload has expired." },
  "system-archive-upload-conflict": { statusCode: 409, message: "System Archive upload conflicts with durable state." },
  "system-archive-upload-offset-conflict": { statusCode: 409, message: "System Archive chunk does not begin at the durable upload prefix." },
  "system-archive-preview-not-found": { statusCode: 404, message: "System Archive preview was not found." },
  "system-archive-preview-expired": { statusCode: 410, message: "System Archive preview has expired." },
  "system-archive-preview-stale": { statusCode: 409, message: "System Archive preview authority is stale." },
  "system-archive-export-conflict": { statusCode: 409, message: "A conflicting System Archive export is active." },
});

function boundaryStatus(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const value = Number((error as { statusCode?: unknown }).statusCode);
    if (Number.isInteger(value) && value >= 400 && value <= 599) return value;
  }
  return 500;
}

function fallbackBoundaryCode(operation: BoundaryOperation, statusCode: number): string {
  if (statusCode >= 500) return "system-archive-operation-failed";
  if (operation === "get-job" && statusCode === 404) return "system-archive-job-not-found";
  if (operation === "cancel-job") {
    return statusCode === 404 ? "system-archive-job-not-found" : "system-archive-cancellation-boundary";
  }
  if (operation === "download") {
    if (statusCode === 416) return "system-archive-range-invalid";
    return statusCode === 409 ? "system-archive-download-stale" : "system-archive-download-unavailable";
  }
  if (operation === "enqueue-export" && statusCode === 409) return "system-archive-export-conflict";
  if (["create-upload", "get-upload", "cancel-upload", "put-chunk", "complete-upload", "preview-import"]
    .includes(operation)) {
    if (statusCode === 404) return "system-archive-upload-not-found";
    if (statusCode === 410) return "system-archive-upload-expired";
    if (statusCode === 409) return "system-archive-upload-conflict";
  }
  if (operation === "commit-import") {
    if (statusCode === 404) return "system-archive-preview-not-found";
    if (statusCode === 410) return "system-archive-preview-expired";
    if (statusCode === 409) return "system-archive-preview-stale";
  }
  return statusCode === 400
    ? "system-archive-request-invalid"
    : "system-archive-operation-failed";
}

function safeBoundaryError(operation: BoundaryOperation, error: unknown): Error {
  const statusCode = boundaryStatus(error);
  const rawCode = typeof error === "object" && error !== null && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";
  const retained = SAFE_BOUNDARY_ERRORS[rawCode];
  const code = retained?.statusCode === statusCode
    ? rawCode
    : fallbackBoundaryCode(operation, statusCode);
  const known = SAFE_BOUNDARY_ERRORS[code];
  const message = known?.message ?? (statusCode >= 500
    ? "System Archive operation failed."
    : "System Archive request could not be completed.");
  return httpError(message, statusCode >= 500 ? 500 : statusCode, code);
}

async function atBoundary<T>(operation: BoundaryOperation, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw safeBoundaryError(operation, error);
  }
}

function requireHeader(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw httpError(`${name} is required.`, 400, "system-archive-header-invalid");
  }
  return value.trim();
}

function parseContentRange(value: string, bodyLength: number): Readonly<{
  offset: number;
  total: number;
}> {
  const match = /^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/u.exec(value);
  if (!match) throw httpError("Content-Range is invalid.", 400, "system-archive-chunk-range-invalid");
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger)
    || end < start
    || end - start + 1 !== bodyLength
    || total < 1
    || end >= total) {
    throw httpError("Content-Range does not match the chunk body.", 400, "system-archive-chunk-range-invalid");
  }
  return { offset: start, total };
}

type ByteRange = Readonly<{ start: number; end: number }>;

function parseRangeHeader(value: string | undefined, byteLength: number): ByteRange | null {
  if (value === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    throw httpError("Only one byte range is supported.", 416, "system-archive-range-invalid");
  }
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      throw httpError("The requested byte range is unsatisfiable.", 416, "system-archive-range-invalid");
    }
    start = Math.max(0, byteLength - suffix);
    end = byteLength - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? byteLength - 1 : Number(match[2]);
  }
  if (!Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end < start
    || start >= byteLength) {
    throw httpError("The requested byte range is unsatisfiable.", 416, "system-archive-range-invalid");
  }
  return { start, end: Math.min(end, byteLength - 1) };
}

export function bindSystemArchiveDownloadCleanup(
  stream: Readable,
  response: EventSource,
  finalize: (reason: PrivateStreamTerminalReason) => Promise<void>,
): void {
  let finalized: Promise<void> | undefined;
  const settle = (reason: PrivateStreamTerminalReason) => {
    finalized ??= finalize(reason).catch(() => undefined);
    return finalized;
  };
  const abort = () => {
    if (!stream.destroyed) stream.destroy();
    void settle("abort");
  };
  response.once("aborted", abort);
  response.once("close", () => {
    if (!stream.readableEnded) abort();
  });
  stream.once("error", () => { void settle("read_failure"); });
}

function checkedJob(value: unknown, kind: "export" | "import") {
  const job = parseResponse(systemArchiveJobViewSchema, value);
  if (job.kind !== kind) throw httpError("System Archive job was not found.", 404, "system-archive-job-not-found");
  return job;
}

function parseResponse<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
): z.output<TSchema> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw httpError(
        "System Archive response failed validation.",
        500,
        "system-archive-response-invalid",
      );
    }
    throw error;
  }
}

function strongEtag(sha256: string): string {
  return `"${parseResponse(sha256Schema, sha256)}"`;
}

export async function registerSystemArchiveRoutes(
  app: FastifyInstance,
  options: SystemArchiveRouteOptions,
): Promise<void> {
  if (!options.enabled) return;
  if (!Number.isSafeInteger(options.limits.chunkBytes) || options.limits.chunkBytes < 1
    || !Number.isSafeInteger(options.limits.maximumUploadBytes)
    || options.limits.maximumUploadBytes < options.limits.chunkBytes
    || !Number.isSafeInteger(options.limits.maximumDownloadBytes)
    || options.limits.maximumDownloadBytes < 1
    || !Number.isSafeInteger(options.limits.downloadDeadlineMs)
    || options.limits.downloadDeadlineMs < 1) {
    throw new Error("system_archive_route_limits_invalid");
  }

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: options.limits.chunkBytes },
    (_request, body, done) => done(null, body),
  );

  app.post("/api/v1/system-exports", async (request, reply) => {
    const body = systemArchiveExportRequestSchema.parse(request.body);
    const value = await atBoundary("enqueue-export", async () => {
      const owner = await options.resolveOwner();
      return options.application.enqueueExport({ ...owner, ...body });
    });
    const job = checkedJob(value, "export");
    return reply.code(202).send(job);
  });

  const getJob = async (kind: "export" | "import", request: { params: unknown }) => {
    const { jobId } = uuidParameterSchema.parse(request.params);
    const value = await atBoundary("get-job", async () => {
      const owner = await options.resolveOwner();
      return options.application.getJob({
        ...owner,
        jobId: toSystemArchiveJobId(jobId),
      });
    });
    return checkedJob(value, kind);
  };

  app.get("/api/v1/system-exports/:jobId", async (request) => getJob("export", request));
  app.get("/api/v1/system-imports/:jobId", async (request) => getJob("import", request));

  const cancelJob = async (
    kind: "export" | "import",
    request: { params: unknown },
    reply: { code(value: number): { send(value: unknown): unknown } },
  ) => {
    const { jobId } = uuidParameterSchema.parse(request.params);
    const value = await atBoundary("cancel-job", async () => {
      const owner = await options.resolveOwner();
      return options.application.cancelJob({
        ...owner,
        jobId: toSystemArchiveJobId(jobId),
      });
    });
    const job = checkedJob(value, kind);
    return reply.code(202).send(job);
  };

  app.delete("/api/v1/system-exports/:jobId", async (request, reply) => cancelJob("export", request, reply));
  app.delete("/api/v1/system-imports/:jobId", async (request, reply) => cancelJob("import", request, reply));

  app.get("/api/v1/system-exports/:jobId/download", async (request, reply) => {
    const { jobId } = uuidParameterSchema.parse(request.params);
    const { owner, metadata } = await atBoundary("download", async () => {
      const owner = await options.resolveOwner();
      return { owner, metadata: await options.downloads.metadata(owner, jobId) };
    });
    if (!Number.isSafeInteger(metadata.byteLength)
      || metadata.byteLength < 1
      || metadata.byteLength > options.limits.maximumDownloadBytes) {
      throw httpError("System Archive download is unavailable.", 404, "system-archive-download-unavailable");
    }
    const etag = strongEtag(metadata.sha256);
    reply
      .header("Cache-Control", "no-store")
      .header("Accept-Ranges", "bytes")
      .header("ETag", etag);
    const ifRange = request.headers["if-range"];
    let requestedRange: ByteRange | null;
    try {
      requestedRange = typeof ifRange === "string" && ifRange !== etag
        ? null
        : parseRangeHeader(
          typeof request.headers.range === "string" ? request.headers.range : undefined,
          metadata.byteLength,
        );
    } catch (error) {
      if (typeof error === "object" && error !== null && "statusCode" in error
        && Number(error.statusCode) === 416) {
        reply.header("Content-Range", `bytes */${metadata.byteLength}`);
      }
      throw error;
    }
    const range = requestedRange ?? { start: 0, end: metadata.byteLength - 1 };
    const session = await atBoundary("download", () => options.downloads.open({
      owner,
      jobId,
      start: range.start,
      end: range.end,
      expectedSha256: metadata.sha256,
      maximumBytes: options.limits.maximumDownloadBytes,
      deadlineAt: new Date(Date.now() + options.limits.downloadDeadlineMs).toISOString(),
    }));
    if (session.sha256 !== metadata.sha256
      || session.totalByteLength !== metadata.byteLength
      || session.byteLength !== range.end - range.start + 1) {
      await session.finalize("pre_send_failure").catch(() => undefined);
      throw httpError("System Archive download authority changed.", 409, "system-archive-download-stale");
    }
    let finalization: Promise<void> | undefined;
    const finalize = (reason: PrivateStreamTerminalReason) => {
      finalization ??= session.finalize(reason).catch(() => {
        throw httpError("System Archive download finalization failed.", 500, "system-archive-operation-failed");
      });
      return finalization;
    };
    const chunks = (async function* () {
      let reason: PrivateStreamTerminalReason = "read_failure";
      try {
        for await (const chunk of session.chunks) yield chunk;
        reason = "eof";
      } catch {
        throw httpError("System Archive download stream failed.", 500, "system-archive-operation-failed");
      } finally {
        await finalize(reason);
      }
    })();
    const stream = Readable.from(chunks);
    bindSystemArchiveDownloadCleanup(stream, reply.raw, finalize);
    reply
      .header("Content-Type", session.contentType)
      .header("Content-Disposition", `attachment; filename="infinite-quest-system-${jobId}.zip"`)
      .header("Content-Length", String(session.byteLength));
    if (requestedRange) {
      reply.code(206).header("Content-Range", `bytes ${range.start}-${range.end}/${metadata.byteLength}`);
    }
    return reply.send(stream);
  });

  app.post("/api/v1/system-imports/uploads", async (request, reply) => {
    const body = systemArchiveUploadCreateRequestSchema.parse(request.body);
    if (body.byteLength < 1) {
      throw httpError("System Archive upload must not be empty.", 400, "system-archive-upload-length-invalid");
    }
    if (body.byteLength > options.limits.maximumUploadBytes) {
      throw httpError("System Archive upload exceeds the configured limit.", 413, "system-archive-upload-too-large");
    }
    const created = parseResponse(systemUploadViewSchema, await atBoundary("create-upload", async () => {
      const owner = await options.resolveOwner();
      return options.application.createUpload({ ...owner, ...body });
    }));
    return reply.code(201).send(created);
  });

  app.get("/api/v1/system-imports/uploads/:uploadId", async (request) => {
    const { uploadId } = uploadParameterSchema.parse(request.params);
    return parseResponse(systemUploadViewSchema, await atBoundary("get-upload", async () => {
      const owner = await options.resolveOwner();
      return options.application.getUpload({
        ...owner,
        uploadId: toSystemArchiveUploadId(uploadId),
      });
    }));
  });

  app.delete("/api/v1/system-imports/uploads/:uploadId", async (request) => {
    const { uploadId } = uploadParameterSchema.parse(request.params);
    return parseResponse(systemUploadViewSchema, await atBoundary("cancel-upload", async () => {
      const owner = await options.resolveOwner();
      return options.application.cancelUpload({
        ...owner,
        uploadId: toSystemArchiveUploadId(uploadId),
      });
    }));
  });

  app.put("/api/v1/system-imports/uploads/:uploadId/chunks/:index", {
    bodyLimit: options.limits.chunkBytes,
  }, async (request) => {
    const { uploadId, index } = chunkParameterSchema.parse(request.params);
    if (!Buffer.isBuffer(request.body)) {
      throw httpError(
        "System Archive chunks require application/octet-stream.",
        415,
        "system-archive-chunk-media-invalid",
      );
    }
    if (request.body.byteLength < 1) {
      throw httpError("System Archive chunk must not be empty.", 400, "system-archive-chunk-length-invalid");
    }
    if (request.body.byteLength > options.limits.chunkBytes) {
      throw httpError("System Archive chunk exceeds the configured limit.", 413, "system-archive-chunk-too-large");
    }
    const contentLength = Number(requireHeader(request.headers["content-length"], "Content-Length"));
    if (!Number.isSafeInteger(contentLength) || contentLength !== request.body.byteLength) {
      throw httpError("Content-Length does not match the chunk body.", 400, "system-archive-chunk-length-invalid");
    }
    const contentRange = parseContentRange(
      requireHeader(request.headers["content-range"], "Content-Range"),
      request.body.byteLength,
    );
    const sha256 = sha256Schema.parse(requireHeader(request.headers["x-chunk-sha256"], "X-Chunk-SHA256"));
    const { owner, currentValue } = await atBoundary("get-upload", async () => {
      const owner = await options.resolveOwner();
      return {
        owner,
        currentValue: await options.application.getUpload({
          ...owner,
          uploadId: toSystemArchiveUploadId(uploadId),
        }),
      };
    });
    const current = parseResponse(systemUploadViewSchema, currentValue);
    if (contentRange.total !== current.byteLength) {
      throw httpError("Content-Range total does not match upload authority.", 409, "system-archive-upload-stale");
    }
    if (contentRange.offset > current.receivedBytes) {
      throw httpError(
        "System Archive chunk does not begin at the durable upload prefix.",
        409,
        "system-archive-upload-offset-conflict",
      );
    }
    const bytes = new Uint8Array(request.body);
    return parseResponse(systemUploadViewSchema, await atBoundary("put-chunk", () => (
      options.application.putChunk({
        ...owner,
        uploadId: toSystemArchiveUploadId(uploadId),
        index,
        offset: contentRange.offset,
        bytes,
        sha256,
      })
    )));
  });

  app.post("/api/v1/system-imports/uploads/:uploadId/complete", async (request) => {
    const { uploadId } = uploadParameterSchema.parse(request.params);
    return parseResponse(systemUploadViewSchema, await atBoundary("complete-upload", async () => {
      const owner = await options.resolveOwner();
      return options.application.completeUpload({
        ...owner,
        uploadId: toSystemArchiveUploadId(uploadId),
      });
    }));
  });

  app.post("/api/v1/system-imports/preview", async (request) => {
    const { uploadId } = previewRequestSchema.parse(request.body);
    return parseResponse(systemImportPreviewViewSchema, await atBoundary("preview-import", async () => {
      const owner = await options.resolveOwner();
      return options.application.previewImport({
        ...owner,
        uploadId: toSystemArchiveUploadId(uploadId),
      });
    }));
  });

  app.post("/api/v1/system-imports", async (request, reply) => {
    const body = systemArchiveImportCommitRequestSchema.parse(request.body);
    const value = await atBoundary("commit-import", async () => {
      const owner = await options.resolveOwner();
      return options.application.commitImport({
        ...owner,
        previewHandle: toSystemArchivePreviewHandle(body.previewHandle),
        idempotencyKey: body.idempotencyKey,
      });
    });
    const job = checkedJob(value, "import");
    return reply.code(202).send(job);
  });
}
