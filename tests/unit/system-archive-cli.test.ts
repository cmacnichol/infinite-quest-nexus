import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  parseSystemArchiveCliArgs,
  runSystemArchiveCli,
} from "../../scripts/system-archive.js";

describe("System Archive CLI", () => {
  it("is an API-only client with no database or private-storage imports", async () => {
    const source = await readFile(new URL("../../scripts/system-archive.ts", import.meta.url), "utf8");
    expect(source).toContain('from "undici"');
    expect(source).not.toMatch(/packages\/database|pg\b|secure-filesystem|archiveStorageRoot|assetStorageRoot/u);
  });

  it("parses the documented export, import, status, and cancel commands", () => {
    expect(parseSystemArchiveCliArgs(["export", "--base-url", "http://127.0.0.1:8080", "--output", "system.zip"]))
      .toMatchObject({ command: "export", output: "system.zip" });
    expect(parseSystemArchiveCliArgs(["import", "--base-url", "http://127.0.0.1:8080", "--file", "system.zip", "--confirm"]))
      .toMatchObject({ command: "import", file: "system.zip", confirm: true });
    expect(parseSystemArchiveCliArgs(["status", "--base-url", "http://127.0.0.1:8080", "--job", "job-id"]))
      .toMatchObject({ command: "status", job: "job-id" });
    expect(parseSystemArchiveCliArgs(["cancel", "--base-url", "http://127.0.0.1:8080", "--job", "job-id", "--kind", "import"]))
      .toMatchObject({ command: "cancel", kind: "import" });
    expect(parseSystemArchiveCliArgs([
      "import", "--base-url", "http://127.0.0.1:8080", "--file", "system.zip",
      "--confirm", "--upload", "upload-id",
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

  it("will not consume import preview authority without explicit confirmation", async () => {
    const request = vi.fn();
    await expect(runSystemArchiveCli(
      ["import", "--base-url", "http://example.test", "--file", "system.zip"],
      {
        request: request as never,
        statFile: vi.fn(async () => ({ byteLength: 4, sha256: "a".repeat(64) })),
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
        isInteractive: false,
      } as never,
    )).rejects.toThrow(/--confirm/u);
    expect(request).not.toHaveBeenCalled();
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
        "--confirm", "--upload", "upload-id", "--chunk-bytes", "4",
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
      ["import", "--base-url", "http://example.test", "--file", "system.zip", "--confirm"],
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
});
