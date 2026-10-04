import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { buildServer } from "../../services/api/src/server.js";
import { inertStorageServerOptions } from "../helpers/build-server-options.js";
import { expect, it } from "vitest";
import type { GenerationApplication } from "../../packages/application/src/generation/ports.js";
import type { GenerationEventSource } from "../../packages/application/src/generation/events.js";
import type { BuildServerOptions } from "../../services/api/src/server.js";
import type { SystemArchiveDownloadPort } from "../../services/api/src/system-archive-routes.js";

const TEST_ORIGIN = "https://nexus.example.test";
const fixtureTime = new Date("2026-10-01T12:00:00.000Z");

function makeConfig(
  legacyWebRoot: string,
  nextWebRoot: string,
  assetStorageRoot: string,
  archiveStorageRoot: string
): RuntimeConfig {
  return {
    role: "all",
    host: "127.0.0.1",
    port: 8080,
    databaseUrl: "postgresql://mock@localhost:5432/mock",
    databaseMaxConnections: 2,
    migrationDirectory: resolve("database/migrations"),
    migrationWaitSeconds: 10,
    allowMaintenanceMigrations: false,
    workerPollIntervalMs: 1000,
    workerLeaseSeconds: 60,
    workerGenerationConcurrency: 1,
    legacyWebRoot,
    nextWebRoot,
    assetStorageDriver: "filesystem",
    assetStorageRoot,
    archiveStorageRoot,
    archivePreviewTtlSeconds: 1800,
    systemArchiveArtifactTtlSeconds: 86400,
    systemArchiveUploadTtlSeconds: 86400,
    systemArchiveChunkBytes: 16_777_216,
    campaignArchiveLimits: {
      maxCompressedBytes: 2_147_483_648,
      maxUncompressedBytes: 21_474_836_480,
      maxEntries: 100_000,
      maxExpansionRatio: 100,
      maxManifestBytes: 5_242_880,
      maxJsonEntryBytes: 1_073_741_824,
      maxOriginalImageBytes: 26_214_400
    },
    systemArchiveLimits: {
      maxCompressedBytes: 53_687_091_200,
      maxUncompressedBytes: 214_748_364_800,
      maxEntries: 1_000_000,
      maxExpansionRatio: 100,
      maxManifestBytes: 5_242_880,
      maxJsonEntryBytes: 1_073_741_824,
      maxOriginalImageBytes: 26_214_400
    },
    credentialEncryptionKey: "",
    security: {
      corsAllowedOrigins: [TEST_ORIGIN],
      providerNetworkAllowlist: ["localhost", "127.0.0.0/8", "::1/128"],
      cspImageAllowedOrigins: [],
      apiDefaultBodyLimitBytes: 1_048_576,
      apiImportBodyLimitBytes: 16_777_216,
      apiAssetBodyLimitBytes: 33_554_432,
      apiRateLimitWindowSeconds: 60,
      apiRateLimitProviderRequests: 10,
      apiRateLimitGenerationRequests: 12,
      apiRateLimitImportRequests: 4,
      apiConcurrencyProviderRequests: 2,
      apiConcurrencyImportRequests: 1,
      trustProxyHops: 0
    }
  };
}

async function makeStaticFixture(options: Readonly<{
  generation?: GenerationApplication;
  generationEvents?: GenerationEventSource;
  systemArchiveEnabled?: boolean;
  createApiSystemArchive?: BuildServerOptions["createApiSystemArchive"];
}> = {}) {
  const root = await mkdtemp(join(tmpdir(), "infinitequest-legacy-static-"));
  const legacyWebRoot = join(root, "legacy");
  const nextWebRoot = join(root, "next");
  await mkdir(join(nextWebRoot, "assets"), { recursive: true });
  await mkdir(legacyWebRoot, { recursive: true });
  await writeFile(join(legacyWebRoot, "index.html"), "<!doctype html><title>Nexus</title>");
  await writeFile(join(legacyWebRoot, "story.html"), "<!doctype html><title>Legacy Story</title>");
  await writeFile(join(legacyWebRoot, "nexus.js"), "window.nexusReady = true;\n");
  await writeFile(join(nextWebRoot, "index.html"), "<!doctype html><title>New App</title>");
  await writeFile(join(nextWebRoot, "assets/app-AbCd1234.js"), "window.appReady = true;\n");

  const pool = {
    query: async (query: string) => query.includes("SELECT id FROM users")
      ? ({ rows: [{ id: "00000000-0000-0000-0000-000000000001" }] })
      : ({ rows: [] }),
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined })
  } as unknown as DatabasePool;
  const config: RuntimeConfig = {
    ...makeConfig(legacyWebRoot, nextWebRoot, join(root, "asset-storage"), join(root, "archive-storage")),
    ...(options.systemArchiveEnabled === true ? { systemArchiveEnabled: true } : {})
  };
  const baseOptions = inertStorageServerOptions({
    config,
    pool,
    ...(options.generation === undefined ? {} : { generation: options.generation }),
    ...(options.generationEvents === undefined ? {} : { generationEvents: options.generationEvents })
  });
  const app = await buildServer({
    ...baseOptions,
    ...(options.createApiSystemArchive === undefined ? {} : { createApiSystemArchive: options.createApiSystemArchive })
  });
  return {
    app,
    legacyWebRoot,
    nextWebRoot,
    cleanup: async () => {
      try {
        await app.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  };
}

async function writeSidecars(path: string, identity: Buffer): Promise<void> {
  await Promise.all([
    writeFile(`${path}.br`, brotliCompressSync(identity)),
    writeFile(`${path}.gz`, gzipSync(identity))
  ]);
}

function varyTokens(value: string | undefined): string[] {
  return (value ?? "").split(",").map((token) => token.trim().toLowerCase()).filter(Boolean);
}

async function readBeforeDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("Timed out waiting for the first SSE event.");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for the first SSE event.")), remainingMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function resolveBeforeDeadline<T>(operation: Promise<T>, deadline: number, description: string): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error(`Timed out waiting for ${description}.`);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), remainingMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

it("negotiates compressed static bytes with security headers, cache policy, and logical MIME", async () => {
  const fixture = await makeStaticFixture();
  try {
    const identity = Buffer.from("window.nexusReady = true;\n");
    await writeSidecars(join(fixture.legacyWebRoot, "nexus.js"), identity);

    for (const [encoding, decode] of [
      ["gzip", gunzipSync],
      ["br", brotliDecompressSync]
    ] as const) {
      const response = await fixture.app.inject({
        url: "/nexus/nexus.js",
        headers: { "accept-encoding": encoding, origin: TEST_ORIGIN }
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-encoding"]).toBe(encoding);
      expect(decode(response.rawPayload)).toEqual(identity);
      expect(response.headers["content-type"]).toContain("javascript");
      expect(varyTokens(response.headers.vary)).toEqual(expect.arrayContaining(["origin", "accept-encoding"]));
      expect(response.headers["cache-control"]).toContain("no-cache");
      expect(response.headers["content-security-policy"]).toBeDefined();
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["access-control-allow-origin"]).toBe(TEST_ORIGIN);
    }

    const identityResponse = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "identity", origin: TEST_ORIGIN }
    });
    expect(identityResponse.statusCode).toBe(200);
    expect(identityResponse.rawPayload).toEqual(identity);
    expect(identityResponse.headers["content-encoding"]).toBeUndefined();
    expect(identityResponse.headers["cache-control"]).toContain("no-cache");
    expect(varyTokens(identityResponse.headers.vary)).toEqual(expect.arrayContaining(["origin", "accept-encoding"]));
    expect(identityResponse.headers["content-security-policy"]).toBeDefined();
    expect(identityResponse.headers["x-content-type-options"]).toBe("nosniff");
  } finally {
    await fixture.cleanup();
  }
});

it("serves custom Story and SPA HTML through negotiation, including HEAD and safe-route guards", async () => {
  const fixture = await makeStaticFixture();
  try {
    await writeSidecars(join(fixture.legacyWebRoot, "story.html"), Buffer.from("<!doctype html><title>Legacy Story</title>"));
    await writeSidecars(join(fixture.legacyWebRoot, "index.html"), Buffer.from("<!doctype html><title>Nexus</title>"));
    await writeSidecars(join(fixture.nextWebRoot, "index.html"), Buffer.from("<!doctype html><title>New App</title>"));

    for (const path of ["/story", "/story/campaign-123", "/app/", "/app/worlds/example"]) {
      const response = await fixture.app.inject({ url: path, headers: { "accept-encoding": "gzip", origin: TEST_ORIGIN } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-encoding"]).toBe("gzip");
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.headers["cache-control"]).toContain("no-cache");
      expect(varyTokens(response.headers.vary)).toEqual(expect.arrayContaining(["origin", "accept-encoding"]));
      expect(response.headers["content-security-policy"]).toBeDefined();
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    }

    for (const path of ["/nexus/", "/story", "/story/campaign-123", "/app/", "/app/worlds/example"]) {
      const get = await fixture.app.inject({ url: path, headers: { "accept-encoding": "gzip", origin: TEST_ORIGIN } });
      const head = await fixture.app.inject({ method: "HEAD", url: path, headers: { "accept-encoding": "gzip", origin: TEST_ORIGIN } });
      expect(head.statusCode).toBe(200);
      expect(head.rawPayload.byteLength).toBe(0);
      expect(head.headers["content-encoding"]).toBe(get.headers["content-encoding"]);
      expect(head.headers["content-type"]).toContain("text/html");
      expect(head.headers.etag).toBe(get.headers.etag);
      expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
      expect(head.headers["cache-control"]).toContain("no-cache");
      expect(varyTokens(head.headers.vary)).toEqual(varyTokens(get.headers.vary));
      expect(varyTokens(head.headers.vary)).toEqual(expect.arrayContaining(["origin", "accept-encoding"]));
      expect(head.headers["content-security-policy"]).toBe(get.headers["content-security-policy"]);
      expect(head.headers["x-content-type-options"]).toBe("nosniff");
    }

    for (const path of ["/app/assets/missing.js", "/app/%2e%2e/secret", "/app/foo.bar"]) {
      expect((await fixture.app.inject({ url: path })).statusCode).toBe(404);
    }
  } finally {
    await fixture.cleanup();
  }
});

it("flushes the first generation SSE event over a real socket while terminal delivery is gated", async () => {
  const jobId = "11111111-1111-4111-8111-111111111111";
  const campaignId = "22222222-2222-4222-8222-222222222222";
  let jobReads = 0;
  const job = (status: "generating" | "completed") => ({
    id: jobId,
    campaignId,
    expectedTurnNumber: 2,
    action: "Open the door.",
    requestedInputMode: "action" as const,
    resolvedInputMode: "action" as const,
    inputModeSource: "explicit" as const,
    operationKind: "append" as const,
    replacementTurnId: null,
    status,
    attempts: 1,
    resultTurnId: status === "completed" ? "33333333-3333-4333-8333-333333333333" : null,
    errorCode: null,
    errorMessage: null,
    recoveryMetadata: {},
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    completedAt: status === "completed" ? "2026-10-01T12:00:01.000Z" : null,
    partialNarration: "The latch begins to turn."
  });
  const generation = {
    getJob: async () => {
      jobReads += 1;
      if (jobReads > 2) await terminalGate;
      return job(jobReads <= 2 ? "generating" : "completed");
    }
  } as unknown as GenerationApplication;
  let releaseTerminal!: () => void;
  let finishHint!: (value: IteratorResult<{ jobId: string; version: string }>) => void;
  let released = false;
  const terminalGate = new Promise<void>((resolveGate) => { releaseTerminal = resolveGate; });
  const hintResult = new Promise<IteratorResult<{ jobId: string; version: string }>>((resolveHint) => { finishHint = resolveHint; });
  const generationEvents: GenerationEventSource = {
    async subscribe() {
      return {
        [Symbol.asyncIterator]() {
          return { next: () => hintResult };
        },
        async close() {
          if (!released) finishHint({ done: true, value: undefined });
        }
      };
    }
  };
  const fixture = await makeStaticFixture({ generation, generationEvents });
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let actionFailed = false;
  let actionError: unknown;
  try {
    const origin = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const response = await resolveBeforeDeadline(
      fetch(`${origin}/api/v1/generation-jobs/${jobId}/stream`, { signal: controller.signal }),
      Date.now() + 2_000,
      "SSE response headers"
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.body).not.toBeNull();

    reader = response.body!.getReader();
    const firstEventDeadline = Date.now() + 2_000;
    let firstEventText = "";
    while (!firstEventText.includes('"status":"generating"')) {
      const firstEvent = await readBeforeDeadline(reader, firstEventDeadline);
      expect(firstEvent.done).toBe(false);
      firstEventText += new TextDecoder().decode(firstEvent.value);
    }
    expect(jobReads).toBe(2);

    released = true;
    releaseTerminal();
    finishHint({ done: false, value: { jobId, version: "terminal" } });
    let streamText = "";
    const terminalDeadline = Date.now() + 2_000;
    while (!streamText.includes('"status":"completed"')) {
      const chunk = await readBeforeDeadline(reader, terminalDeadline);
      if (chunk.done) break;
      streamText += new TextDecoder().decode(chunk.value);
    }
    expect(streamText).toContain('"status":"completed"');
    expect(response.headers.get("content-encoding")).toBeNull();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  } finally {
    releaseTerminal();
    if (!released) finishHint({ done: true, value: undefined });
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      if (reader !== undefined) {
        await resolveBeforeDeadline(reader.cancel(), Date.now() + 1_000, "SSE reader cancellation");
      }
    } catch (error) {
      const isExpectedAbort = controller.signal.aborted && error instanceof Error && error.name === "AbortError";
      if (!isExpectedAbort) {
        cleanupFailed = true;
        cleanupError = error;
      }
    } finally {
      controller.abort();
      try {
        await resolveBeforeDeadline(fixture.cleanup(), Date.now() + 2_000, "SSE server cleanup");
      } catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true;
          cleanupError = error;
        }
      }
    }
    if (actionFailed) {
      throw actionError;
    }
    if (cleanupFailed) {
      throw cleanupError;
    }
  }
});

it("preserves System Archive byte ranges and transport headers with Accept-Encoding on a real socket", async () => {
  const jobId = "44444444-4444-4444-8444-444444444444";
  const archiveBytes = Buffer.from("system-archive-fixture");
  const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
  let openedRange: Readonly<{ start: number; end: number }> | undefined;
  let finalized = false;
  const downloads: SystemArchiveDownloadPort = {
    async metadata() {
      return { byteLength: archiveBytes.byteLength, sha256 };
    },
    async open(input) {
      openedRange = { start: input.start, end: input.end };
      const selected = archiveBytes.subarray(input.start, input.end + 1);
      return {
        contentType: "application/zip",
        byteLength: selected.byteLength,
        totalByteLength: archiveBytes.byteLength,
        sha256,
        chunks: (async function* () { yield selected; })(),
        async finalize(_reason) { finalized = true; }
      };
    }
  };
  const createApiSystemArchive: NonNullable<BuildServerOptions["createApiSystemArchive"]> = () => ({
    application: {} as never,
    downloads
  });
  const fixture = await makeStaticFixture({ systemArchiveEnabled: true, createApiSystemArchive });
  try {
    const origin = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${origin}/api/v1/system-exports/${jobId}/download`, {
      headers: { range: "bytes=4-11", "accept-encoding": "gzip, br" }
    });
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(archiveBytes.subarray(4, 12));
    expect(openedRange).toEqual({ start: 4, end: 11 });
    expect(response.headers.get("content-type")).toContain("application/zip");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe(`bytes 4-11/${archiveBytes.byteLength}`);
    expect(response.headers.get("content-length")).toBe("8");
    expect(response.headers.get("etag")).toBe(`"${sha256}"`);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(finalized).toBe(true);
  } finally {
    await fixture.cleanup();
  }
});

it("keeps direct sidecar URLs private and ranges identity bytes even with compression accepted", async () => {
  const fixture = await makeStaticFixture();
  try {
    const identity = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
    const asset = join(fixture.nextWebRoot, "assets/app-AbCd1234.js");
    await writeFile(asset, identity);
    await writeSidecars(asset, identity);
    await writeSidecars(join(fixture.legacyWebRoot, "nexus.js"), Buffer.from("window.nexusReady = true;\n"));

    expect((await fixture.app.inject({ url: "/app/assets/app-AbCd1234.js.gz" })).statusCode).toBe(404);
    expect((await fixture.app.inject({ url: "/app/assets/app-AbCd1234.js.br" })).statusCode).toBe(404);
    expect((await fixture.app.inject({ url: "/app/assets/app-AbCd1234.js%2Egz" })).statusCode).toBe(404);
    expect((await fixture.app.inject({ url: "/app/assets/app-AbCd1234.js%2Ebr" })).statusCode).toBe(404);
    expect((await fixture.app.inject({ url: "/app/assets/app-AbCd1234.js%2egz" })).statusCode).toBe(404);
    expect((await fixture.app.inject({ url: "/app/assets/app-AbCd1234.js%2ebr" })).statusCode).toBe(404);
    expect((await fixture.app.inject({ url: "/nexus/nexus.js.gz" })).statusCode).toBe(404);
    expect((await fixture.app.inject({ url: "/nexus/nexus.js.br" })).statusCode).toBe(404);
    expect((await fixture.app.inject({ url: "/nexus/nexus.js%2Egz" })).statusCode).toBe(404);
    expect((await fixture.app.inject({ url: "/nexus/nexus.js%2Ebr" })).statusCode).toBe(404);
    expect((await fixture.app.inject({ url: "/nexus/nexus.js%2egz" })).statusCode).toBe(404);
    expect((await fixture.app.inject({ url: "/nexus/nexus.js%2ebr" })).statusCode).toBe(404);

    const range = await fixture.app.inject({
      url: "/app/assets/app-AbCd1234.js",
      headers: { range: "bytes=4-11", "accept-encoding": "gzip, br" }
    });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload).toEqual(identity.subarray(4, 12));
    expect(range.headers["content-range"]).toBe("bytes 4-11/36");
    expect(range.headers["content-length"]).toBe("8");
    expect(range.headers["content-encoding"]).toBeUndefined();

    const ifRange = await fixture.app.inject({
      url: "/app/assets/app-AbCd1234.js",
      headers: { range: "bytes=4-11", "if-range": "\"stale-validator\"", "accept-encoding": "gzip" }
    });
    expect(ifRange.statusCode).toBe(200);
    expect(ifRange.rawPayload).toEqual(identity);
    expect(ifRange.headers["content-encoding"]).toBeUndefined();

    const identityResponse = await fixture.app.inject({
      url: "/app/assets/app-AbCd1234.js",
      headers: { "accept-encoding": "identity" }
    });
    const matchingIfRange = await fixture.app.inject({
      url: "/app/assets/app-AbCd1234.js",
      headers: {
        range: "bytes=4-11",
        "if-range": identityResponse.headers.etag,
        "accept-encoding": "gzip, br"
      }
    });
    expect(matchingIfRange.statusCode).toBe(206);
    expect(matchingIfRange.rawPayload).toEqual(identity.subarray(4, 12));
    expect(matchingIfRange.headers["content-range"]).toBe("bytes 4-11/36");
    expect(matchingIfRange.headers["content-length"]).toBe("8");
    expect(matchingIfRange.headers["content-encoding"]).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
});

it("applies HTTP validators to the selected identity or encoded representation", async () => {
  const fixture = await makeStaticFixture();
  try {
    const identity = Buffer.from("Representation-specific validator fixture. ".repeat(12));
    const assetPath = join(fixture.legacyWebRoot, "nexus.js");
    await writeFile(assetPath, identity);
    await writeSidecars(assetPath, identity);
    await utimes(assetPath, fixtureTime, fixtureTime);
    await utimes(`${assetPath}.gz`, fixtureTime, fixtureTime);
    await utimes(`${assetPath}.br`, fixtureTime, fixtureTime);

    const identityGet = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "identity" }
    });
    const gzipGet = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "gzip" }
    });
    expect(identityGet.statusCode).toBe(200);
    expect(gzipGet.statusCode).toBe(200);
    expect(identityGet.rawPayload).toEqual(identity);
    expect(gzipGet.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gzipGet.rawPayload)).toEqual(identity);
    expect(identityGet.headers.etag).not.toBe(gzipGet.headers.etag);

    const sameVariantGet = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "gzip", "if-none-match": gzipGet.headers.etag, origin: TEST_ORIGIN }
    });
    expect(sameVariantGet.statusCode).toBe(304);
    expect(sameVariantGet.rawPayload.byteLength).toBe(0);
    expect(sameVariantGet.headers.etag).toBe(gzipGet.headers.etag);
    expect(sameVariantGet.headers["content-encoding"]).toBe("gzip");
    expect(varyTokens(sameVariantGet.headers.vary)).toEqual(expect.arrayContaining(["origin", "accept-encoding"]));
    const sameVariantHead = await fixture.app.inject({
      method: "HEAD",
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "gzip", "if-none-match": gzipGet.headers.etag }
    });
    expect(sameVariantHead.statusCode).toBe(304);
    expect(sameVariantHead.rawPayload.byteLength).toBe(0);
    expect(sameVariantHead.headers.etag).toBe(gzipGet.headers.etag);
    expect(sameVariantHead.headers["content-encoding"]).toBe("gzip");

    const weakList = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "gzip", "if-none-match": `W/${gzipGet.headers.etag}, "other-tag"` }
    });
    expect(weakList.statusCode).toBe(304);
    const wildcard = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "gzip", "if-none-match": "*" }
    });
    expect(wildcard.statusCode).toBe(304);

    const matchingTagPrecedesDate = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: {
        "accept-encoding": "gzip",
        "if-none-match": gzipGet.headers.etag,
        "if-modified-since": new Date(fixtureTime.valueOf() - 60_000).toUTCString()
      }
    });
    expect(matchingTagPrecedesDate.statusCode).toBe(304);
    const nonmatchingTagSuppressesDate = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: {
        "accept-encoding": "gzip",
        "if-none-match": '"nonmatching-tag"',
        "if-modified-since": new Date(fixtureTime.valueOf() + 60_000).toUTCString()
      }
    });
    expect(nonmatchingTagSuppressesDate.statusCode).toBe(200);
    expect(nonmatchingTagSuppressesDate.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(nonmatchingTagSuppressesDate.rawPayload)).toEqual(identity);

    const modifiedAfter = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "identity", "if-modified-since": new Date(fixtureTime.valueOf() + 60_000).toUTCString() }
    });
    expect(modifiedAfter.statusCode).toBe(304);
    const modifiedBefore = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "identity", "if-modified-since": new Date(fixtureTime.valueOf() - 60_000).toUTCString() }
    });
    expect(modifiedBefore.statusCode).toBe(200);

    const ifMatch = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "gzip", "if-match": gzipGet.headers.etag }
    });
    expect(ifMatch.statusCode).toBe(200);
    const ifMatchWrong = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "gzip", "if-match": '"different-tag"' }
    });
    expect(ifMatchWrong.statusCode).toBe(412);
    const ifMatchWeak = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "gzip", "if-match": `W/${gzipGet.headers.etag}` }
    });
    expect(ifMatchWeak.statusCode).toBe(412);

    const notModifiedSince = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "identity", "if-unmodified-since": new Date(fixtureTime.valueOf() - 60_000).toUTCString() }
    });
    expect(notModifiedSince.statusCode).toBe(412);
    const unmodifiedSince = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "identity", "if-unmodified-since": new Date(fixtureTime.valueOf() + 60_000).toUTCString() }
    });
    expect(unmodifiedSince.statusCode).toBe(200);
  } finally {
    await fixture.cleanup();
  }
});

it("revalidates one representation, keeps hashed assets immutable, and leaves API JSON uncompressed", async () => {
  const fixture = await makeStaticFixture();
  try {
    const hashedPath = "/app/assets/app-AbCd1234.js";
    await writeSidecars(join(fixture.nextWebRoot, "assets/app-AbCd1234.js"), Buffer.from("window.appReady = true;\n"));
    const first = await fixture.app.inject({ url: hashedPath, headers: { "accept-encoding": "gzip", origin: TEST_ORIGIN } });
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-encoding"]).toBe("gzip");
    expect(first.headers["cache-control"]).toContain("immutable");
    const sameVariant = await fixture.app.inject({
      url: hashedPath,
      headers: { "accept-encoding": "gzip", "if-none-match": first.headers.etag, origin: TEST_ORIGIN }
    });
    expect(sameVariant.statusCode).toBe(304);
    expect(sameVariant.rawPayload.byteLength).toBe(0);
    expect(sameVariant.headers.etag).toBe(first.headers.etag);
    expect(sameVariant.headers["content-encoding"]).toBe("gzip");
    expect(sameVariant.headers["cache-control"]).toContain("immutable");
    expect(varyTokens(sameVariant.headers.vary)).toEqual(expect.arrayContaining(["origin", "accept-encoding"]));
    expect(sameVariant.headers["content-security-policy"]).toBeDefined();
    expect(sameVariant.headers["x-content-type-options"]).toBe("nosniff");

    const head = await fixture.app.inject({ method: "HEAD", url: hashedPath, headers: { "accept-encoding": "gzip" } });
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload.byteLength).toBe(0);
    expect(head.headers.etag).toBe(first.headers.etag);
    expect(head.headers["content-encoding"]).toBe("gzip");
    expect(head.headers["content-type"]).toContain("javascript");
    expect(head.headers["cache-control"]).toContain("immutable");

    const api = await fixture.app.inject({ url: "/api/v1/meta", headers: { "accept-encoding": "gzip, br" } });
    expect(api.statusCode).toBe(200);
    expect(api.headers["content-type"]).toContain("application/json");
    expect(api.headers["content-encoding"]).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
});

it("does not let a stat-colliding representation validator produce a cross-variant 304", async () => {
  const fixture = await makeStaticFixture();
  try {
    const identity = Buffer.from("A".repeat(23));
    const gzip = gzipSync(identity);
    expect(gzip).toHaveLength(identity.byteLength);
    const path = join(fixture.legacyWebRoot, "nexus.js");
    await writeFile(path, identity);
    await writeFile(`${path}.gz`, gzip);
    await utimes(path, fixtureTime, fixtureTime);
    await utimes(`${path}.gz`, fixtureTime, fixtureTime);

    const encoded = await fixture.app.inject({ url: "/nexus/nexus.js", headers: { "accept-encoding": "gzip" } });
    const wrongVariant = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "identity", "if-none-match": encoded.headers.etag }
    });
    expect(encoded.statusCode).toBe(200);
    expect(encoded.headers["content-encoding"]).toBe("gzip");
    expect(encoded.rawPayload).toEqual(gzip);
    expect(gunzipSync(encoded.rawPayload)).toEqual(identity);
    expect(wrongVariant.statusCode).toBe(200);
    expect(wrongVariant.rawPayload).toEqual(identity);
    expect(wrongVariant.headers["content-encoding"]).toBeUndefined();
    const reverseVariant = await fixture.app.inject({
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "gzip", "if-none-match": wrongVariant.headers.etag }
    });
    expect(reverseVariant.statusCode).toBe(200);
    expect(reverseVariant.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(reverseVariant.rawPayload)).toEqual(identity);

    const head = await fixture.app.inject({
      method: "HEAD",
      url: "/nexus/nexus.js",
      headers: { "accept-encoding": "gzip", origin: TEST_ORIGIN }
    });
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload.byteLength).toBe(0);
    expect(head.headers.etag).toBe(encoded.headers.etag);
    expect(head.headers["content-encoding"]).toBe("gzip");
    expect(head.headers["content-type"]).toContain("javascript");
    expect(head.headers["cache-control"]).toContain("no-cache");
    expect(varyTokens(head.headers.vary)).toEqual(expect.arrayContaining(["origin", "accept-encoding"]));
    expect(head.headers["content-security-policy"]).toBeDefined();
    expect(head.headers["x-content-type-options"]).toBe("nosniff");
  } finally {
    await fixture.cleanup();
  }
});

it("precompresses only the two synthetic public roots and validates decoded output", async () => {
  const root = await mkdtemp(join(tmpdir(), "infinitequest-precompress-"));
  const legacy = join(root, "apps", "web", "dist");
  const next = join(root, "apps", "web-next", "dist");
  await mkdir(legacy, { recursive: true });
  await mkdir(next, { recursive: true });
  await writeFile(join(legacy, "index.html"), "<!doctype html><title>Legacy</title>");
  await writeFile(join(legacy, "story.html"), "<!doctype html><title>Story</title>");
  const entryBytes = Buffer.from("window.entry = true;\n".repeat(64));
  await writeFile(join(legacy, "entry.js"), entryBytes);
  await writeFile(join(next, "index.html"), "<!doctype html><title>Next</title>");
  await writeFile(join(next, "bundle.css"), "body { color: #123; }".repeat(64));
  await writeFile(join(next, "pixel.png"), Buffer.from([0, 1, 2, 3, 4, 255]));
  const outsideRoot = join(root, "outside-public-root");
  await mkdir(outsideRoot, { recursive: true });
  const outsideFile = join(outsideRoot, "outside.js");
  const outsideContents = "window.outside = true;".repeat(64);
  await writeFile(outsideFile, outsideContents);

  try {
    const result = spawnSync(process.execPath, [resolve("scripts/precompress-web-assets.mjs"), "--project-root", root], {
      encoding: "utf8",
      timeout: 30_000
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);

    for (const [file, bytes] of [
      [join(legacy, "index.html"), Buffer.from("<!doctype html><title>Legacy</title>")],
      [join(legacy, "story.html"), Buffer.from("<!doctype html><title>Story</title>")],
      [join(legacy, "entry.js"), entryBytes],
      [join(next, "index.html"), Buffer.from("<!doctype html><title>Next</title>")],
      [join(next, "bundle.css"), Buffer.from("body { color: #123; }".repeat(64))]
    ] as const) {
      expect(gunzipSync(await readFile(`${file}.gz`))).toEqual(bytes);
      expect(brotliDecompressSync(await readFile(`${file}.br`))).toEqual(bytes);
    }
    await expect(access(`${join(next, "pixel.png")}.gz`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${join(next, "pixel.png")}.br`)).rejects.toMatchObject({ code: "ENOENT" });

    const symlinkProject = join(root, "symlink-project");
    const symlinkLegacy = join(symlinkProject, "apps", "web", "dist");
    const symlinkNext = join(symlinkProject, "apps", "web-next", "dist");
    await mkdir(symlinkLegacy, { recursive: true });
    await mkdir(symlinkNext, { recursive: true });
    await writeFile(join(symlinkLegacy, "index.html"), "<!doctype html><title>Legacy</title>");
    await writeFile(join(symlinkLegacy, "story.html"), "<!doctype html><title>Story</title>");
    await writeFile(join(symlinkNext, "index.html"), "<!doctype html><title>Next</title>");
    const externalLink = join(symlinkLegacy, "linked-public-assets");
    try {
      await symlink(outsideRoot, externalLink, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      throw new Error("Cannot create the required symlink escape fixture; producer containment remains unverified on this host.", { cause: error });
    }
    const symlinkResult = spawnSync(process.execPath, [resolve("scripts/precompress-web-assets.mjs"), "--project-root", symlinkProject], {
      encoding: "utf8",
      timeout: 30_000
    });
    expect(symlinkResult.error).toBeUndefined();
    expect(symlinkResult.status, "the producer must reject symlink traversal with its documented refusal exit").toBe(1);
    expect(symlinkResult.stderr).toContain("PRECOMPRESS_SYMLINK_REJECTED");
    expect(await readFile(outsideFile, "utf8")).toBe(outsideContents);
    await expect(access(`${outsideFile}.gz`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${outsideFile}.br`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(externalLink, "outside.js.gz"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(externalLink, "outside.js.br"))).rejects.toMatchObject({ code: "ENOENT" });

    const incompleteRoot = join(root, "incomplete-project");
    await mkdir(join(incompleteRoot, "apps", "web", "dist"), { recursive: true });
    await mkdir(join(incompleteRoot, "apps", "web-next", "dist"), { recursive: true });
    await writeFile(join(incompleteRoot, "apps", "web", "dist", "index.html"), "<!doctype html><title>Legacy</title>");
    await writeFile(join(incompleteRoot, "apps", "web-next", "dist", "index.html"), "<!doctype html><title>Next</title>");
    const incomplete = spawnSync(process.execPath, [resolve("scripts/precompress-web-assets.mjs"), "--project-root", incompleteRoot], {
      encoding: "utf8",
      timeout: 30_000
    });
    expect(incomplete.error).toBeUndefined();
    expect(incomplete.status, "the producer must fail when the required legacy story entry is missing").not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["GET", "HEAD"] as const)("evaluates static preconditions before unsatisfiable Range for %s", async (method) => {
  const fixture = await makeStaticFixture();
  try {
    const identity = Buffer.from("Conditional range ordering fixture.");
    for (const [root, url] of [
      [fixture.legacyWebRoot, "/nexus/conditional-range.js"],
      [fixture.nextWebRoot, "/app/conditional-range.js"]
    ] as const) {
      const assetPath = join(root, "conditional-range.js");
      await writeFile(assetPath, identity);
      await writeSidecars(assetPath, identity);
      const current = await fixture.app.inject({ url, headers: { "accept-encoding": "identity" } });
      expect(current.statusCode).toBe(200);
      const cases = [
        { conditional: { "if-none-match": current.headers.etag }, status: 304 },
        { conditional: { "if-match": '"nonmatching-tag"' }, status: 412 },
        { conditional: {}, status: 416 }
      ] as const;
      for (const candidate of cases) {
        const response = await fixture.app.inject({
          method,
          url,
          headers: { range: "bytes=999-", "accept-encoding": "gzip, br", origin: TEST_ORIGIN, ...candidate.conditional }
        });
        expect(response.statusCode).toBe(candidate.status);
        expect(response.headers["content-encoding"]).toBeUndefined();
        if (candidate.status !== 416) {
          expect(response.rawPayload.byteLength).toBe(0);
          expect(response.headers.etag).toBe(current.headers.etag);
          expect(response.headers["cache-control"]).toBe("no-cache");
          expect(response.headers["content-range"]).toBeUndefined();
          expect(response.headers["content-security-policy"]).toBeTruthy();
          expect(response.headers["x-content-type-options"]).toBe("nosniff");
          expect(response.headers["access-control-allow-origin"]).toBe(TEST_ORIGIN);
        }
      }
    }
  } finally {
    await fixture.cleanup();
  }
});