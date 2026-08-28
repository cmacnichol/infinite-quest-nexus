import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createSystemArchiveHttpRequest,
  parseSystemArchiveCliArgs,
  runSystemArchiveCli,
  SYSTEM_ARCHIVE_HEADERS_TIMEOUT_MS,
} from "../../scripts/system-archive.js";

describe("System Archive CLI", () => {
  it("is an API-only client with no database or private-storage imports", async () => {
    const source = await readFile(new URL("../../scripts/system-archive.ts", import.meta.url), "utf8");
    expect(source).toContain('from "undici"');
    expect(source).not.toMatch(/packages\/database|pg\b|secure-filesystem|archiveStorageRoot|assetStorageRoot/u);
  });

  it("keeps archive API requests open long enough for a large preview", async () => {
    const request = vi.fn(async () => ({ statusCode: 200, body: {} }));
    const archiveRequest = createSystemArchiveHttpRequest(request as never);

    await archiveRequest("http://example.test/api/v1/system-imports/uploads/upload/preview", {
      method: "POST",
      body: "{}",
    });

    expect(request).toHaveBeenCalledWith(
      "http://example.test/api/v1/system-imports/uploads/upload/preview",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headersTimeout: SYSTEM_ARCHIVE_HEADERS_TIMEOUT_MS,
      }),
    );
  });

  it("parses the documented export, import, status, and cancel commands", () => {
    expect(parseSystemArchiveCliArgs(["export", "--base-url", "http://127.0.0.1:8080", "--output", "system.zip"]))
      .toMatchObject({ command: "export", output: "system.zip" });
    expect(parseSystemArchiveCliArgs(["import", "--base-url", "http://127.0.0.1:8080", "--file", "system.zip"]))
      .toMatchObject({ command: "import", file: "system.zip" });
    expect(parseSystemArchiveCliArgs(["status", "--base-url", "http://127.0.0.1:8080", "--job", "job-id"]))
      .toMatchObject({ command: "status", job: "job-id" });
    expect(parseSystemArchiveCliArgs(["cancel", "--base-url", "http://127.0.0.1:8080", "--job", "job-id", "--kind", "import"]))
      .toMatchObject({ command: "cancel", kind: "import" });
    expect(parseSystemArchiveCliArgs([
      "import", "--base-url", "http://127.0.0.1:8080", "--file", "system.zip",
      "--upload", "upload-id",
    ])).toMatchObject({ command: "import", upload: "upload-id" });
  });

  it("uses only public JSON routes for status and falls back across job kinds", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ statusCode: 404, body: { json: async () => ({}) } })
      .mockResolvedValueOnce({ statusCode: 200, body: { json: async () => ({ id: "job", kind: "import", status: "completed" }) } });
    const writes: string[] = [];

    await runSystemArchiveCli(
      ["status", "--base-url", "http://example.test", "--job", "job"],
      {
        request: request as never,
        stdout: { write: (value: string) => { writes.push(value); } },
      } as never,
    );

    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "http://example.test/api/v1/system-exports/job",
      "http://example.test/api/v1/system-imports/job",
    ]);
    expect(writes.join("")).toContain('"status": "completed"');
  });

  it("prints the exact preview before obtaining interactive confirmation for all five boundaries", async () => {
    const fingerprint = "f".repeat(64);
    const preview = {
      valid: true,
      previewHandle: "opaque-preview-authority",
      archiveFingerprint: fingerprint,
      destinationEmpty: true,
      warnings: ["review-this-exact-preview"],
    };
    const request = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 201,
        body: { json: async () => ({
          id: "upload-id",
          status: "created",
          byteLength: 4,
          receivedBytes: 0,
          expiresAt: "2026-08-25T12:00:00.000Z",
        }) },
      })
      .mockResolvedValueOnce({ statusCode: 200, body: { json: async () => ({ status: "uploading" }) } })
      .mockResolvedValueOnce({ statusCode: 200, body: { json: async () => ({ status: "completed" }) } })
      .mockResolvedValueOnce({ statusCode: 200, body: { json: async () => preview } })
      .mockResolvedValueOnce({
        statusCode: 202,
        body: { json: async () => ({ id: "11111111-1111-4111-8111-111111111111" }) },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({
          id: "11111111-1111-4111-8111-111111111111",
          kind: "import",
          status: "completed",
        }) },
      });
    const writes: string[] = [];
    const confirmImport = vi.fn(async () => {
      expect(writes.join("")).toContain(JSON.stringify(preview, null, 2));
      return {
        archiveFingerprint: fingerprint,
        acknowledgeSensitiveArchive: true,
        acknowledgeEmptyDestination: true,
        acknowledgeInvalidatedAccess: true,
        acknowledgeProviderReentry: true,
        acknowledgeNonCancellableBoundary: true,
      };
    });

    await runSystemArchiveCli(
      ["import", "--base-url", "http://example.test", "--file", "system.zip"],
      {
        request: request as never,
        statFile: vi.fn(async () => ({ byteLength: 4, sha256: "a".repeat(64) })),
        readChunks: async function* () { yield new Uint8Array([1, 2, 3, 4]); },
        stdout: { write: (value: string) => { writes.push(value); } },
        stderr: { write: vi.fn() },
        isInteractive: true,
        confirmImport,
        sleep: vi.fn(),
      } as never,
    );

    expect(confirmImport).toHaveBeenCalledOnce();
    expect(JSON.parse(String(request.mock.calls[4]?.[1]?.body))).toEqual({
      previewHandle: "opaque-preview-authority",
      idempotencyKey: expect.any(String),
      acknowledgeSensitiveArchive: true,
      acknowledgeEmptyDestination: true,
      acknowledgeInvalidatedAccess: true,
      acknowledgeProviderReentry: true,
      acknowledgeNonCancellableBoundary: true,
    });
  });

  it("previews before refusing a noninteractive import without bound acknowledgements", async () => {
    const preview = {
      valid: true,
      previewHandle: "opaque-preview-authority",
      archiveFingerprint: "f".repeat(64),
    };
    const request = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({
          id: "upload-id",
          status: "completed",
          byteLength: 4,
          receivedBytes: 4,
          expiresAt: "2026-08-25T12:00:00.000Z",
        }) },
      })
      .mockResolvedValueOnce({ statusCode: 200, body: { json: async () => preview } });
    const writes: string[] = [];

    await expect(runSystemArchiveCli(
      [
        "import", "--base-url", "http://example.test", "--file", "system.zip",
        "--upload", "upload-id",
      ],
      {
        request: request as never,
        statFile: vi.fn(async () => ({ byteLength: 4, sha256: "a".repeat(64) })),
        readChunks: async function* () {},
        stdout: { write: (value: string) => { writes.push(value); } },
        stderr: { write: vi.fn() },
        isInteractive: false,
      } as never,
    )).rejects.toThrow(/acknowledge-sensitive-archive/u);
    expect(writes.join("")).toContain(JSON.stringify(preview, null, 2));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    "--acknowledge-sensitive-archive",
    "--acknowledge-empty-destination",
    "--acknowledge-invalidated-access",
    "--acknowledge-provider-reentry",
    "--acknowledge-non-cancellable-boundary",
  ])("requires noninteractive acknowledgement %s for the exact preview fingerprint", async (missingFlag) => {
    const fingerprint = "f".repeat(64);
    const allFlags = [
      "--acknowledge-sensitive-archive",
      "--acknowledge-empty-destination",
      "--acknowledge-invalidated-access",
      "--acknowledge-provider-reentry",
      "--acknowledge-non-cancellable-boundary",
    ];
    const request = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({
          id: "upload-id",
          status: "completed",
          byteLength: 4,
          receivedBytes: 4,
          expiresAt: "2026-08-25T12:00:00.000Z",
        }) },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({ valid: true, previewHandle: "preview", archiveFingerprint: fingerprint }) },
      });

    await expect(runSystemArchiveCli([
      "import", "--base-url", "http://example.test", "--file", "system.zip",
      "--upload", "upload-id", "--confirm-fingerprint", fingerprint,
      ...allFlags.filter((flag) => flag !== missingFlag),
    ], {
      request: request as never,
      statFile: vi.fn(async () => ({ byteLength: 4, sha256: "a".repeat(64) })),
      readChunks: async function* () {},
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      isInteractive: false,
    } as never)).rejects.toThrow(missingFlag.slice(2));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects noninteractive confirmation bound to a different preview fingerprint", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({
          id: "upload-id",
          status: "completed",
          byteLength: 4,
          receivedBytes: 4,
          expiresAt: "2026-08-25T12:00:00.000Z",
        }) },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({ valid: true, previewHandle: "preview", archiveFingerprint: "f".repeat(64) }) },
      });

    await expect(runSystemArchiveCli([
      "import", "--base-url", "http://example.test", "--file", "system.zip",
      "--upload", "upload-id", "--confirm-fingerprint", "e".repeat(64),
      "--acknowledge-sensitive-archive", "--acknowledge-empty-destination",
      "--acknowledge-invalidated-access", "--acknowledge-provider-reentry",
      "--acknowledge-non-cancellable-boundary",
    ], {
      request: request as never,
      statFile: vi.fn(async () => ({ byteLength: 4, sha256: "a".repeat(64) })),
      readChunks: async function* () {},
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      isInteractive: false,
    } as never)).rejects.toThrow(/fingerprint/u);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("resumes a sequential upload through only the public upload status route", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({
          id: "upload-id",
          status: "uploading",
          byteLength: 8,
          receivedBytes: 4,
          expiresAt: "2026-08-25T12:00:00.000Z",
        }) },
      })
      .mockResolvedValueOnce({ statusCode: 200, body: { json: async () => ({ status: "uploading" }) } })
      .mockResolvedValueOnce({ statusCode: 200, body: { json: async () => ({ status: "completed" }) } })
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({ valid: false, previewHandle: null }) },
      });
    const readChunks = vi.fn(async function* (_path: string, _chunkBytes: number, start: number) {
      expect(start).toBe(4);
      yield new Uint8Array([5, 6, 7, 8]);
    });

    await expect(runSystemArchiveCli(
      [
        "import", "--base-url", "http://example.test", "--file", "system.zip",
        "--upload", "upload-id", "--chunk-bytes", "4",
      ],
      {
        request: request as never,
        statFile: vi.fn(async () => ({ byteLength: 8, sha256: "a".repeat(64) })),
        readChunks,
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
      } as never,
    )).rejects.toThrow("did not authorize commit");

    expect(readChunks).toHaveBeenCalledWith("system.zip", 4, 4);
    expect(request.mock.calls[0]?.[0]).toBe(
      "http://example.test/api/v1/system-imports/uploads/upload-id",
    );
    expect(request.mock.calls.some(([url, options]) => options?.method === "POST"
      && String(url).endsWith("/uploads"))).toBe(false);
  });

  it("prints the opaque upload session before transferring resumable chunks", async () => {
    const request = vi.fn().mockResolvedValueOnce({
      statusCode: 201,
      body: { json: async () => ({
        id: "upload-to-resume",
        status: "created",
        byteLength: 4,
        receivedBytes: 0,
        expiresAt: "2026-08-25T12:00:00.000Z",
      }) },
    });
    const writes: string[] = [];

    await expect(runSystemArchiveCli(
      ["import", "--base-url", "http://example.test", "--file", "system.zip"],
      {
        request: request as never,
        statFile: vi.fn(async () => ({ byteLength: 4, sha256: "a".repeat(64) })),
        readChunks: async function* () {
          throw new Error("simulated disconnect");
        },
        stdout: { write: (value: string) => { writes.push(value); } },
        stderr: { write: vi.fn() },
      } as never,
    )).rejects.toThrow("simulated disconnect");

    expect(writes.join("\n")).toContain("upload-to-resume");
  });

  it("restarts a mismatched range resume and verifies the complete ETag", async () => {
    const expectedHash = "b".repeat(64);
    const bytes = (value: string) => ({
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(value);
      },
    });
    const request = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 202,
        body: { json: async () => ({ id: "11111111-1111-4111-8111-111111111111" }) },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({
          id: "11111111-1111-4111-8111-111111111111",
          kind: "export",
          status: "published",
        }) },
      })
      .mockResolvedValueOnce({
        statusCode: 206,
        headers: {
          etag: `"${expectedHash}"`,
          "content-range": "bytes 3-5/6",
        },
        body: bytes("new"),
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { etag: `"${expectedHash}"` },
        body: bytes("allnew"),
      });
    const writeDownload = vi.fn(async (
      _path: string,
      _chunks: AsyncIterable<Uint8Array>,
      _append: boolean,
    ) => undefined);
    const statFile = vi.fn()
      .mockResolvedValueOnce({ byteLength: 6, sha256: "c".repeat(64) })
      .mockResolvedValueOnce({ byteLength: 6, sha256: expectedHash });

    await runSystemArchiveCli(
      ["export", "--base-url", "http://example.test", "--output", "system.zip"],
      {
        request: request as never,
        existingBytes: vi.fn(async () => 3),
        writeDownload,
        statFile,
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
        sleep: vi.fn(),
      } as never,
    );

    expect(writeDownload.mock.calls.map((call) => call[2])).toEqual([true, false]);
    expect(request.mock.calls[3]?.[1]).toMatchObject({ method: "GET" });
    expect(request.mock.calls[3]?.[1]?.headers).toBeUndefined();
  });

  it("accepts a 416 resume response only when the complete local file matches its ETag and total", async () => {
    const expectedHash = "b".repeat(64);
    const request = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 202,
        body: { json: async () => ({ id: "11111111-1111-4111-8111-111111111111" }) },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({
          id: "11111111-1111-4111-8111-111111111111",
          kind: "export",
          status: "published",
        }) },
      })
      .mockResolvedValueOnce({
        statusCode: 416,
        headers: { etag: `"${expectedHash}"`, "content-range": "bytes */6" },
        body: { json: async () => ({ code: "system-archive-range-invalid" }) },
      });
    const writeDownload = vi.fn();

    await runSystemArchiveCli(
      ["export", "--base-url", "http://example.test", "--output", "system.zip"],
      {
        request: request as never,
        existingBytes: vi.fn(async () => 6),
        writeDownload,
        statFile: vi.fn(async () => ({ byteLength: 6, sha256: expectedHash })),
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
        sleep: vi.fn(),
      } as never,
    );

    expect(request).toHaveBeenCalledTimes(3);
    expect(writeDownload).not.toHaveBeenCalled();
  });

  it("performs one clean full restart when a 416 response finds an equal or larger mismatched local file", async () => {
    const expectedHash = "b".repeat(64);
    const bytes = {
      async *[Symbol.asyncIterator]() { yield Buffer.from("fresh!"); },
    };
    const request = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 202,
        body: { json: async () => ({ id: "11111111-1111-4111-8111-111111111111" }) },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({
          id: "11111111-1111-4111-8111-111111111111",
          kind: "export",
          status: "published",
        }) },
      })
      .mockResolvedValueOnce({
        statusCode: 416,
        headers: { etag: `"${expectedHash}"`, "content-range": "bytes */6" },
        body: { json: async () => ({ code: "system-archive-range-invalid" }) },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { etag: `"${expectedHash}"`, "content-length": "6" },
        body: bytes,
      });
    const writeDownload = vi.fn(async (
      _path: string,
      _chunks: AsyncIterable<Uint8Array>,
      _append: boolean,
    ) => undefined);
    const statFile = vi.fn()
      .mockResolvedValueOnce({ byteLength: 6, sha256: "c".repeat(64) })
      .mockResolvedValueOnce({ byteLength: 6, sha256: expectedHash });

    await runSystemArchiveCli(
      ["export", "--base-url", "http://example.test", "--output", "system.zip"],
      {
        request: request as never,
        existingBytes: vi.fn(async () => 8),
        writeDownload,
        statFile,
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
        sleep: vi.fn(),
      } as never,
    );

    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls[3]?.[1]).toEqual({ method: "GET" });
    expect(writeDownload).toHaveBeenCalledOnce();
    expect(writeDownload.mock.calls[0]?.[2]).toBe(false);
  });
});
