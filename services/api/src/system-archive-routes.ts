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

function httpError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code, expose: true });
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
      throw Object.assign(new Error("System Archive response failed validation."), {
        statusCode: 500,
        code: "system-archive-response-invalid",
      });
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
    const owner = await options.resolveOwner();
    const job = checkedJob(await options.application.enqueueExport({ ...owner, ...body }), "export");
    return reply.code(202).send(job);
  });

  const getJob = async (kind: "export" | "import", request: { params: unknown }) => {
    const { jobId } = uuidParameterSchema.parse(request.params);
    const owner = await options.resolveOwner();
    return checkedJob(await options.application.getJob({
      ...owner,
      jobId: toSystemArchiveJobId(jobId),
    }), kind);
  };

  app.get("/api/v1/system-exports/:jobId", async (request) => getJob("export", request));
  app.get("/api/v1/system-imports/:jobId", async (request) => getJob("import", request));

  const cancelJob = async (
    kind: "export" | "import",
    request: { params: unknown },
    reply: { code(value: number): { send(value: unknown): unknown } },
  ) => {
    const { jobId } = uuidParameterSchema.parse(request.params);
    const owner = await options.resolveOwner();
    const job = checkedJob(await options.application.cancelJob({
      ...owner,
      jobId: toSystemArchiveJobId(jobId),
    }), kind);
    return reply.code(202).send(job);
  };

  app.delete("/api/v1/system-exports/:jobId", async (request, reply) => cancelJob("export", request, reply));
  app.delete("/api/v1/system-imports/:jobId", async (request, reply) => cancelJob("import", request, reply));

  app.get("/api/v1/system-exports/:jobId/download", async (request, reply) => {
    const { jobId } = uuidParameterSchema.parse(request.params);
    const owner = await options.resolveOwner();
    const metadata = await options.downloads.metadata(owner, jobId);
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
    const session = await options.downloads.open({
      owner,
      jobId,
      start: range.start,
      end: range.end,
      expectedSha256: metadata.sha256,
      maximumBytes: options.limits.maximumDownloadBytes,
      deadlineAt: new Date(Date.now() + options.limits.downloadDeadlineMs).toISOString(),
    });
    if (session.sha256 !== metadata.sha256
      || session.totalByteLength !== metadata.byteLength
      || session.byteLength !== range.end - range.start + 1) {
      await session.finalize("pre_send_failure").catch(() => undefined);
      throw httpError("System Archive download authority changed.", 409, "system-archive-download-stale");
    }
    let finalization: Promise<void> | undefined;
    const finalize = (reason: PrivateStreamTerminalReason) => {
      finalization ??= session.finalize(reason);
      return finalization;
    };
    const chunks = (async function* () {
      let reason: PrivateStreamTerminalReason = "read_failure";
      try {
        for await (const chunk of session.chunks) yield chunk;
        reason = "eof";
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
    const owner = await options.resolveOwner();
    const created = parseResponse(systemUploadViewSchema, await options.application.createUpload({ ...owner, ...body }));
    return reply.code(201).send(created);
  });

  app.get("/api/v1/system-imports/uploads/:uploadId", async (request) => {
    const { uploadId } = uploadParameterSchema.parse(request.params);
    const owner = await options.resolveOwner();
    return parseResponse(systemUploadViewSchema, await options.application.getUpload({
      ...owner,
      uploadId: toSystemArchiveUploadId(uploadId),
    }));
  });

  app.delete("/api/v1/system-imports/uploads/:uploadId", async (request) => {
    const { uploadId } = uploadParameterSchema.parse(request.params);
    const owner = await options.resolveOwner();
    return parseResponse(systemUploadViewSchema, await options.application.cancelUpload({
      ...owner,
      uploadId: toSystemArchiveUploadId(uploadId),
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
    const owner = await options.resolveOwner();
    const current = parseResponse(systemUploadViewSchema, await options.application.getUpload({
      ...owner,
      uploadId: toSystemArchiveUploadId(uploadId),
    }));
    if (contentRange.total !== current.byteLength) {
      throw httpError("Content-Range total does not match upload authority.", 409, "system-archive-upload-stale");
    }
    return parseResponse(systemUploadViewSchema, await options.application.putChunk({
      ...owner,
      uploadId: toSystemArchiveUploadId(uploadId),
      index,
      offset: contentRange.offset,
      bytes: new Uint8Array(request.body),
      sha256,
    }));
  });

  app.post("/api/v1/system-imports/uploads/:uploadId/complete", async (request) => {
    const { uploadId } = uploadParameterSchema.parse(request.params);
    const owner = await options.resolveOwner();
    return parseResponse(systemUploadViewSchema, await options.application.completeUpload({
      ...owner,
      uploadId: toSystemArchiveUploadId(uploadId),
    }));
  });

  app.post("/api/v1/system-imports/preview", async (request) => {
    const { uploadId } = previewRequestSchema.parse(request.body);
    const owner = await options.resolveOwner();
    return parseResponse(systemImportPreviewViewSchema, await options.application.previewImport({
      ...owner,
      uploadId: toSystemArchiveUploadId(uploadId),
    }));
  });

  app.post("/api/v1/system-imports", async (request, reply) => {
    const body = systemArchiveImportCommitRequestSchema.parse(request.body);
    const owner = await options.resolveOwner();
    const job = checkedJob(await options.application.commitImport({
      ...owner,
      previewHandle: toSystemArchivePreviewHandle(body.previewHandle),
      idempotencyKey: body.idempotencyKey,
    }), "import");
    return reply.code(202).send(job);
  });
}
