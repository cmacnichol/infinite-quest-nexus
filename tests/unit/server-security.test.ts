import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { buildServer } from "../../services/api/src/server.js";
import { inertStorageServerOptions as serverOptions, testWorldCampaignApplication } from "../helpers/build-server-options.js";
import { createProviderApplicationAdapter } from "../../services/api/src/provider-application-adapter.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { logger } from "../../packages/logger/src/index.js";
import { parseCompleteGeneratedWorld } from "../../packages/domain/src/generated-world.js";
import { ProviderDestinationNotAllowedError } from "../../packages/security/src/provider-network-policy.js";
import { ProviderResponseTooLargeError } from "../../packages/story-engine/src/provider-response.js";
import { ProviderTransportError } from "../../packages/story-engine/src/providers.js";
import { generationStreamSnapshotSchema } from "../../packages/contracts/src/generation.js";
import {
  generatedWorldProviderError,
  incompleteGeneratedWorldError
} from "../../services/runtime/src/provider-world-generation-adapter.js";

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
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
    legacyWebRoot: resolve("apps/web/public"),
    nextWebRoot: resolve("apps/web-next"),
    assetStorageDriver: "filesystem",
    assetStorageRoot: resolve("local-data/assets"),
    archiveStorageRoot: resolve("local-data/archives"),
    archivePreviewTtlSeconds: 1_800,
    systemArchiveArtifactTtlSeconds: 86_400,
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
      corsAllowedOrigins: [],
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
    },
    ...overrides
  };
}

async function staticRootFixture() {
  const root = await mkdtemp(join(tmpdir(), "infinitequest-static-"));
  const legacyWebRoot = join(root, "legacy");
  const nextWebRoot = join(root, "next");
  await mkdir(join(nextWebRoot, "assets"), { recursive: true });
  await mkdir(legacyWebRoot, { recursive: true });
  await writeFile(join(legacyWebRoot, "index.html"), "<!doctype html><p>legacy nexus shell</p>");
  await writeFile(join(legacyWebRoot, "story.html"), "<!doctype html><p>legacy story shell</p>");
  await writeFile(join(legacyWebRoot, "story-generation-cancellation.js"), "export const stable = true;");
  await writeFile(join(legacyWebRoot, "image-library-browser.js"), "export const stable = true;");
  await writeFile(join(nextWebRoot, "index.html"), "<!doctype html><p>replacement app shell</p>");
  await writeFile(join(nextWebRoot, "assets/app-AbCd1234.js"), "export const built = true;");
  await writeFile(join(nextWebRoot, "assets/shell-AbCd1234.html"), "<!doctype html><title>asset</title>");
  await writeFile(join(nextWebRoot, "bootstrap.js"), "export const preview = true;");
  await writeFile(join(root, "secret.txt"), "must not be served");
  return {
    config: makeConfig({ legacyWebRoot, nextWebRoot }),
    cleanup: () => rm(root, { force: true, recursive: true })
  };
}

function multipartArchiveUpload(file: Buffer, destination: Record<string, unknown>) {
  const boundary = "----infinitequest-archive-error";
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="broken.zip"\r\nContent-Type: application/zip\r\n\r\n`, "utf8"),
      file,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="destination"\r\n\r\n${JSON.stringify(destination)}\r\n--${boundary}--\r\n`, "utf8")
    ])
  };
}

function multipartFieldUpload(fieldName: string, value: string) {
  const boundary = "----infinitequest-archive-field-limit";
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"\r\n\r\n${value}\r\n--${boundary}--\r\n`,
      "utf8"
    )
  };
}

describe("API server security and CORS headers", () => {
  const mockPool = {
    query: async (sql: string) => ({
      rows: sql.includes("system_key = 'initial-owner'")
        ? [{ id: "11111111-1111-4111-8111-111111111111" }]
        : [],
    }),
  } as unknown as DatabasePool;

  it("exposes public application metadata without querying the database", async () => {
    const config = makeConfig();
    const mockPool = { query: async () => { throw new Error("Metadata must not query the database."); } } as unknown as DatabasePool;
    const app = await buildServer(serverOptions({ config, pool: mockPool }));

    const response = await app.inject({ method: "GET", url: "/api/v1/meta" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      application: { name: "Infinite Quest Nexus", version: expect.any(String) }
    });
    expect(response.headers["cache-control"]).toBe("no-store");

    await app.close();
  });

  it("requests embedding inventory when a text provider is used as the embedding fallback", async () => {
    const ownerUserId = "11111111-1111-4111-8111-111111111111";
    const providerProfileId = "66666666-6666-4666-8666-666666666666";
    const listModels = vi.fn().mockResolvedValue({
      providerProfileId,
      providerRole: "embedding",
      models: []
    });
    const providers = createProviderApplicationAdapter({
      application: {
        listProfiles: vi.fn().mockResolvedValue([{ id: providerProfileId, providerRole: "text" }]),
        listModels
      },
      runtime: {},
      transaction: vi.fn()
    } as never);
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool, providers }));

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/providers/${providerProfileId}/models?providerRole=embedding`
    });

    expect(response.statusCode).toBe(200);
    expect(listModels).toHaveBeenCalledWith({
      ownerUserId,
      providerProfileId,
      providerRole: "embedding"
    });
    await app.close();
  });

  it("uses the server-owned initial user for read-only saved and candidate preset discovery", async () => {
    const ownerUserId = "11111111-1111-4111-8111-111111111111";
    const providerProfileId = "66666666-6666-4666-8666-666666666666";
    const presets = vi.fn().mockResolvedValue({ presets: [], totalCount: 0 });
    const preset = vi.fn().mockResolvedValue({ slug: "story-router", models: [], providerPolicy: {} });
    const discoverPresets = vi.fn().mockResolvedValue({ presets: [], totalCount: 0 });
    const discoverPreset = vi.fn().mockResolvedValue({ slug: "story-router", models: [], providerPolicy: {} });
    const providers = {
      presets,
      preset,
      discoverPresets,
      discoverPreset,
      application: { listProfiles: vi.fn().mockResolvedValue([{ id: providerProfileId, providerType: "openrouter", providerRole: "text" }]) }
    };
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool, providers: providers as never }));

    const saved = await app.inject({ method: "GET", url: `/api/v1/providers/${providerProfileId}/presets?offset=0&limit=10` });
    const savedDetail = await app.inject({ method: "GET", url: `/api/v1/providers/${providerProfileId}/presets/story-router` });
    const candidateList = await app.inject({
      method: "POST",
      url: "/api/v1/providers/discover-presets?offset=0&limit=10",
      headers: { "content-type": "application/json" },
      payload: { name: "OpenRouter", providerType: "openrouter", providerRole: "text", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "", apiKey: "must-not-echo" }
    });
    const candidate = await app.inject({
      method: "POST",
      url: "/api/v1/providers/discover-presets/story-router",
      headers: { "content-type": "application/json" },
      payload: { name: "OpenRouter", providerType: "openrouter", providerRole: "text", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "", apiKey: "must-not-echo" }
    });

    expect(saved.statusCode).toBe(200);
    expect(savedDetail.statusCode).toBe(200);
    expect(candidateList.statusCode).toBe(200);
    expect(candidate.statusCode).toBe(200);
    expect(presets).toHaveBeenCalledWith(ownerUserId, providerProfileId, { offset: 0, limit: 10 });
    expect(preset).toHaveBeenCalledWith(ownerUserId, providerProfileId, "story-router");
    expect(discoverPresets).toHaveBeenCalledWith(ownerUserId, expect.objectContaining({ providerType: "openrouter", providerRole: "text" }), { offset: 0, limit: 10 });
    expect(discoverPreset).toHaveBeenCalledWith(ownerUserId, expect.objectContaining({ providerType: "openrouter", providerRole: "text" }), "story-router");
    expect(candidate.payload).not.toContain("must-not-echo");
    await app.close();
  });

  it("echoes a correlation ID on adopted API routes", async () => {
    const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const pool = {
      query: async (text: string) => text.includes("system_key = 'initial-owner'")
        ? { rows: [{ id: ownerId }] }
        : { rows: [] }
    } as unknown as DatabasePool;
    const app = await buildServer(serverOptions({ config: makeConfig(), pool }));

    const generated = await app.inject({ method: "GET", url: "/api/v1/worlds" });
    const echoed = await app.inject({
      method: "GET",
      url: "/api/v1/worlds",
      headers: { "x-correlation-id": "support-correlation-123" }
    });

    expect(generated.statusCode).toBe(200);
    expect(generated.headers["x-correlation-id"]).toEqual(expect.any(String));
    expect(generated.headers["x-correlation-id"]).not.toBe("");
    expect(echoed.statusCode).toBe(200);
    expect(echoed.headers["x-correlation-id"]).toBe("support-correlation-123");
    await app.close();
  });

  it.each(["/", "/index.html"])("redirects %s to the active Nexus client without serving legacy HTML", async (url) => {
    const config = makeConfig();
    const mockPool = { query: async () => ({ rows: [] }) } as unknown as DatabasePool;
    const app = await buildServer(serverOptions({ config, pool: mockPool }));

    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(308);
    expect(response.headers.location).toBe("/nexus/");
    expect(response.headers["content-type"] ?? "").not.toContain("text/html");
    expect(response.payload).not.toContain("<!DOCTYPE html>");

    await app.close();
  });

  it("serves the replacement app root and extensionless deep links with HTML no-cache", async () => {
    const fixture = await staticRootFixture();
    const app = await buildServer(serverOptions({ config: fixture.config, pool: mockPool }));

    try {
      const redirect = await app.inject({ method: "GET", url: "/app" });
      expect(redirect.statusCode).toBe(308);
      expect(redirect.headers.location).toBe("/app/");

      for (const url of ["/app/", "/app/campaigns/example/play"]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(200);
        expect(response.payload).toContain("replacement app shell");
        expect(response.headers["cache-control"]).toBe("no-cache");
        expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
        expect(response.headers["content-security-policy"]).toContain("style-src 'self'");
        expect(response.headers["content-security-policy"]).toContain("connect-src 'self'");
        expect(response.headers["content-security-policy"]).not.toContain("unsafe-inline");
      }
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  it("caches only generated content-hashed replacement assets as immutable", async () => {
    const fixture = await staticRootFixture();
    const app = await buildServer(serverOptions({ config: fixture.config, pool: mockPool }));

    try {
      const hashed = await app.inject({ method: "GET", url: "/app/assets/app-AbCd1234.js" });
      const hashShapedHtml = await app.inject({
        method: "GET",
        url: "/app/assets/shell-AbCd1234.html"
      });
      const stable = await app.inject({ method: "GET", url: "/app/bootstrap.js" });
      const legacyStableAssets = await Promise.all([
        app.inject({ method: "GET", url: "/nexus/story-generation-cancellation.js" }),
        app.inject({ method: "GET", url: "/nexus/image-library-browser.js" })
      ]);

      expect(hashed.statusCode).toBe(200);
      expect(hashed.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(hashShapedHtml.statusCode).toBe(200);
      expect(hashShapedHtml.headers["cache-control"]).toBe("no-cache");
      expect(stable.statusCode).toBe(200);
      expect(stable.headers["cache-control"]).toBe("no-cache");
      for (const response of legacyStableAssets) {
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-cache");
      }
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  it("keeps missing assets, reserved routes, and traversal attempts out of app fallback", async () => {
    const fixture = await staticRootFixture();
    const app = await buildServer(serverOptions({ config: fixture.config, pool: mockPool }));

    try {
      for (const url of [
        "/app/assets/missing.js",
        "/app/assets/missing",
        "/app/assets/missing/",
        "/app/missing.svg",
        "/app/%2e%2e/secret.txt",
        "/app/..%2fsecret.txt",
        "/api/v1/not-real",
        "/health/not-real",
        "/nexus/not-real.js",
        "/vendor/not-real.js"
      ]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode, url).toBe(404);
        expect(response.payload, url).not.toContain("replacement app shell");
        expect(response.payload, url).not.toContain("must not be served");
      }

      for (const url of [
        "/api/v1/not-real",
        "/health/not-real",
        "/nexus/not-real.js",
        "/vendor/not-real.js"
      ]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.json()).toEqual({
          message: `Route GET:${url} not found`,
          error: "Not Found",
          statusCode: 404
        });
      }

      const story = await app.inject({ method: "GET", url: "/story/not-real" });
      expect(story.statusCode).toBe(200);
      expect(story.payload).toContain("legacy story shell");
      expect(story.payload).not.toContain("replacement app shell");

      const api = await app.inject({ method: "GET", url: "/api/v1/not-real" });
      expect(api.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  it("keeps legacy Nexus and Story routes on the explicit legacy root", async () => {
    const fixture = await staticRootFixture();
    const app = await buildServer(serverOptions({ config: fixture.config, pool: mockPool }));

    try {
      const nexus = await app.inject({ method: "GET", url: "/nexus/" });
      const story = await app.inject({ method: "GET", url: "/story" });

      expect(nexus.statusCode).toBe(200);
      expect(nexus.payload).toContain("legacy nexus shell");
      expect(nexus.headers["cache-control"]).toBe("no-cache");
      expect(story.statusCode).toBe(200);
      expect(story.payload).toContain("legacy story shell");
      expect(story.headers["cache-control"]).toBe("no-cache");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  it("allows origin-less and exact same-origin requests", async () => {
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool }));
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    const sameOrigin = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "localhost:8080", origin: "http://localhost:8080" }
    });
    expect(sameOrigin.statusCode).toBe(200);
    expect(sameOrigin.headers["access-control-allow-origin"]).toBe("http://localhost:8080");
    expect(sameOrigin.headers["access-control-allow-credentials"]).toBeUndefined();
    await app.close();
  });

  it("rejects hostile origins and hostile preflights", async () => {
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool }));
    for (const method of ["GET", "OPTIONS"] as const) {
      const response = await app.inject({
        method,
        url: "/health/live",
        headers: { host: "nexus.test", origin: "https://evil.test" }
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: "ORIGIN_NOT_ALLOWED"
      });
    }
    await app.close();
  });

  it("rejects DNS-rebinding requests whose hostile Origin matches a hostile Host", async () => {
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool }));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/providers/discover-models",
      headers: { host: "evil.test", origin: "http://evil.test", "content-type": "application/json" },
      payload: {}
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "ORIGIN_NOT_ALLOWED" });
    await app.close();
  });

  it("rejects malformed Host headers with the typed origin error", async () => {
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool }));
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "localhost:not-a-port" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "ORIGIN_NOT_ALLOWED"
    });
    await app.close();
  });

  it("sends the enforced CSP without unsafe-inline", async () => {
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool }));
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );
    expect(response.headers["strict-transport-security"]).toBeUndefined();
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    await app.close();
  });

  it("sends HSTS only for direct or explicitly trusted HTTPS", async () => {
    const directHttp = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool }));
    expect((await directHttp.inject({ method: "GET", url: "/health/live" })).headers["strict-transport-security"]).toBeUndefined();
    await directHttp.close();

    const proxied = await buildServer(serverOptions({
      config: makeConfig({ security: { ...makeConfig().security, trustProxyHops: 1 } }),
      pool: mockPool
    }));
    const response = await proxied.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-forwarded-proto": "https", host: "localhost:8080" }
    });
    expect(response.headers["strict-transport-security"]).toContain("max-age=31536000");
    await proxied.close();
  });

  it("returns 400 InvalidUuidError when PostgreSQL throws 22P02 invalid uuid syntax", async () => {
    const config = makeConfig();
    const mockPool = {
      query: async () => {
        const error = Object.assign(new Error('invalid input syntax for type uuid: "not-a-uuid"'), { code: "22P02" });
        throw error;
      }
    } as unknown as DatabasePool;
    const app = await buildServer(serverOptions({ config, pool: mockPool }));

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/session"
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("InvalidUuidError");
    expect(body.message).toContain("The provided ID is not a valid UUID.");

    await app.close();
  });

  it("exposes typed safe archive errors without filesystem paths or raw payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "infinitequest-archive-error-"));
    const upload = multipartArchiveUpload(Buffer.from("not a zip archive", "utf8"), { kind: "embedded" });
    const app = await buildServer(serverOptions({
      config: makeConfig({ assetStorageRoot: join(root, "assets"), archiveStorageRoot: join(root, "archives") }),
      pool: mockPool
    }));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/imports/campaign-archive/preview",
        headers: { "content-type": upload.contentType },
        payload: upload.payload
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "archive-format-unrecognized", details: {} });
      expect(response.payload).not.toContain(root);
      expect(response.payload).not.toContain("not a zip archive");
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caps Campaign Archive multipart uploads at the API import body limit", async () => {
    const baseConfig = makeConfig();
    const root = await mkdtemp(join(tmpdir(), "infinitequest-archive-limit-"));
    const config = makeConfig({
      assetStorageRoot: join(root, "assets"),
      archiveStorageRoot: join(root, "archives"),
      campaignArchiveLimits: {
        ...baseConfig.campaignArchiveLimits,
        maxCompressedBytes: 4_096,
        maxJsonEntryBytes: 4_096
      },
      security: {
        ...baseConfig.security,
        apiDefaultBodyLimitBytes: 4_096,
        apiImportBodyLimitBytes: 256
      }
    });
    const upload = multipartArchiveUpload(Buffer.alloc(512, 0x61), { kind: "embedded" });
    const app = await buildServer(serverOptions({ config, pool: mockPool }));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/imports/campaign-archive/preview",
        headers: { "content-type": upload.contentType },
        payload: upload.payload
      });

      expect(response.statusCode).toBe(413);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caps legacy import override fields at the API import body limit", async () => {
    const baseConfig = makeConfig();
    const root = await mkdtemp(join(tmpdir(), "infinitequest-legacy-import-limit-"));
    const config = makeConfig({
      assetStorageRoot: join(root, "assets"),
      archiveStorageRoot: join(root, "archives"),
      campaignArchiveLimits: {
        ...baseConfig.campaignArchiveLimits,
        maxCompressedBytes: 4_096,
        maxJsonEntryBytes: 4_096
      },
      security: {
        ...baseConfig.security,
        apiDefaultBodyLimitBytes: 4_096,
        apiImportBodyLimitBytes: 256
      }
    });
    const upload = multipartFieldUpload(
      "requestOverrides",
      JSON.stringify({ sourceName: "oversized", padding: "x".repeat(512) })
    );
    const app = await buildServer(serverOptions({ config, pool: mockPool }));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/imports/legacy-story",
        headers: { "content-type": upload.contentType },
        payload: upload.payload
      });

      expect(response.statusCode).toBe(413);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes only safe structured generated-world validation details", async () => {
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool }));
    app.get("/test/generated-world-error", async () => {
      try {
        parseCompleteGeneratedWorld({
          world: { title: "PRIVATE_PROVIDER_WORLD" },
          playableCharacters: []
        });
      } catch (error) {
        throw incompleteGeneratedWorldError(error);
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/test/generated-world-error",
      headers: { "x-correlation-id": "generated-world-test" }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      message: expect.stringContaining("Correlation ID: generated-world-test."),
      correlationId: "generated-world-test",
      details: {
        code: "incomplete_generated_world",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "world.genre" })
        ])
      }
    });
    expect(response.payload).not.toContain("PRIVATE_PROVIDER_WORLD");

    await app.close();
  });

  it("exposes an actionable malformed-JSON issue without the parser body", async () => {
    const marker = "PRIVATE_MALFORMED_PROVIDER_BODY";
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool }));
    app.get("/test/generated-world-json-error", async () => {
      throw incompleteGeneratedWorldError(
        new SyntaxError(`Unexpected token in ${marker}`)
      );
    });

    const response = await app.inject({
      method: "GET",
      url: "/test/generated-world-json-error"
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      details: {
        code: "incomplete_generated_world",
        issues: [{
          path: "generatedWorld",
          code: "invalid_json",
          message: "Generated world JSON is malformed."
        }]
      }
    });
    expect(response.payload).not.toContain(marker);

    await app.close();
  });

  it("bounds generated-world issue fields before exposing the API envelope", async () => {
    const marker = "PRIVATE_OVERSIZED_API_ISSUE";
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool }));
    app.get("/test/generated-world-oversized-error", async () => {
      throw incompleteGeneratedWorldError(new z.ZodError([{
        path: [`world.${"p".repeat(500)}${marker}`],
        code: `${"c".repeat(100)}${marker}` as "custom",
        message: `${"m".repeat(500)}${marker}`
      }]));
    });

    const response = await app.inject({
      method: "GET",
      url: "/test/generated-world-oversized-error"
    });
    const issue = response.json().details.issues[0] as {
      path: string;
      code: string;
      message: string;
    };

    expect(response.statusCode).toBe(502);
    expect(issue.path.length).toBeLessThanOrEqual(500);
    expect(issue.code.length).toBeLessThanOrEqual(100);
    expect(issue.message.length).toBeLessThanOrEqual(500);
    expect(response.payload).not.toContain(marker);

    await app.close();
  });

  it("exposes and logs only controlled generated-world provider 429 details", async () => {
    const marker = "SECRET_AT_START_OF_PROVIDER_429_BODY";
    const rawProviderError = Object.assign(
      new Error(`Provider request failed (429): ${marker}`),
      {
        statusCode: 429,
        providerMessage: `${marker}${"x".repeat(2_000)}`
      }
    );
    const safeProviderError = generatedWorldProviderError(rawProviderError);
    const errorLogs: unknown[] = [];
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool }));
    app.get("/test/generated-world-provider-error", async (request) => {
      (request.log as unknown as { error: (...args: unknown[]) => void }).error = (...args) => {
        errorLogs.push(args);
      };
      throw safeProviderError;
    });

    const response = await app.inject({
      method: "GET",
      url: "/test/generated-world-provider-error",
      headers: { "x-correlation-id": "provider-429-test" }
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      error: "WorldGenerationProviderError",
      message: "The text provider request failed with HTTP 429. Correlation ID: provider-429-test.",
      correlationId: "provider-429-test",
      code: "provider_http_error",
      details: {
        code: "provider_http_error",
        category: "http",
        providerStatus: 429
      }
    });
    expect(response.payload).not.toContain(marker);
    expect(JSON.stringify(errorLogs)).not.toContain(marker);

    await app.close();
  });

  it("exposes and logs only safe provider transport diagnostics with correlation", async () => {
    const internalMarkers = [
      "private-provider-host.test",
      "private-provider-model",
      "UND_ERR_HEADERS_TIMEOUT",
      "420000",
      "OpenAI-compatible provider",
      "7 minutes"
    ];
    const providerError = new ProviderTransportError(
      "OpenAI-compatible provider timed out after 7 minutes at private-provider-host.test.",
      {
        providerType: "openai_compatible",
        operation: "private provider operation",
        endpoint: "https://private-provider-host.test/v1/models",
        model: "private-provider-model",
        timeoutMs: 420_000,
        durationMs: 19,
        timedOut: true,
        transportCode: "UND_ERR_HEADERS_TIMEOUT",
        causeCategory: "timeout",
        causeMessage: "The provider request timed out."
      }
    );
    const errorLogs: unknown[] = [];
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool }));
    app.get("/test/provider-transport-error", async (request) => {
      (request.log as unknown as { error: (...args: unknown[]) => void }).error = (...args) => {
        errorLogs.push(args);
      };
      throw providerError;
    });

    const response = await app.inject({
      method: "GET",
      url: "/test/provider-transport-error",
      headers: { "x-correlation-id": "provider-transport-test" }
    });

    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({
      error: "ProviderTimeoutError",
      correlationId: "provider-transport-test",
      code: "provider_request_timeout",
      details: {
        code: "provider_request_timeout",
        category: "timeout",
        retryable: true
      }
    });
    expect(errorLogs).toEqual([[
      expect.objectContaining({
        correlationId: "provider-transport-test",
        errorName: "ProviderTimeoutError",
        errorCode: "provider_request_timeout",
        providerCategory: "timeout",
        durationMs: 19
      }),
      "request_failed"
    ]]);
    const exposed = `${response.payload}\n${JSON.stringify(errorLogs)}`;
    for (const marker of internalMarkers) expect(exposed).not.toContain(marker);

    await app.close();
  });

  it.each([
    {
      label: "destination policy",
      rawError: () => new ProviderDestinationNotAllowedError("dns"),
      expectedStatus: 422,
      expectedName: "ProviderDestinationNotAllowedError",
      expectedCode: "PROVIDER_DESTINATION_NOT_ALLOWED",
      expectedCategory: "destination",
      expectedMessage: "The provider destination is not allowed by the server network policy."
    },
    {
      label: "response size",
      rawError: () => new ProviderResponseTooLargeError(4 * 1024 * 1024),
      expectedStatus: 502,
      expectedName: "ProviderResponseTooLargeError",
      expectedCode: "provider_response_too_large",
      expectedCategory: "response_limit",
      expectedMessage: "The provider response exceeded the server's safe size limit."
    }
  ])("exposes and logs only controlled generated-world $label details", async ({
    rawError,
    expectedStatus,
    expectedName,
    expectedCode,
    expectedCategory,
    expectedMessage
  }) => {
    const marker = "SECRET_AT_START_OF_TYPED_PROVIDER_API_FAILURE";
    const safeProviderError = generatedWorldProviderError(Object.assign(rawError(), {
      cause: new Error(`${marker}: private cause`),
      providerMessage: `${marker}: private provider body`,
      prompt: `${marker}: private lore`,
      credentials: `${marker}: private credentials`
    }));
    const errorLogs: unknown[] = [];
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool }));
    app.get("/test/generated-world-typed-provider-error", async (request) => {
      (request.log as unknown as { error: (...args: unknown[]) => void }).error = (...args) => {
        errorLogs.push(args);
      };
      throw safeProviderError;
    });

    const response = await app.inject({
      method: "GET",
      url: "/test/generated-world-typed-provider-error",
      headers: { "x-correlation-id": "typed-provider-test" }
    });

    expect(response.statusCode).toBe(expectedStatus);
    expect(response.json()).toMatchObject({
      error: expectedName,
      message: `${expectedMessage} Correlation ID: typed-provider-test.`,
      correlationId: "typed-provider-test",
      code: expectedCode,
      details: {
        code: expectedCode,
        category: expectedCategory,
        permanent: true,
        retryable: false
      }
    });
    expect(response.payload).not.toContain(marker);
    expect(JSON.stringify(errorLogs)).not.toContain(marker);

    await app.close();
  });

  it("respects the import body limit for large request payloads", async () => {
    const baseConfig = makeConfig();
    const config = makeConfig({
      security: { ...baseConfig.security, apiImportBodyLimitBytes: 10 * 1024 * 1024 }
    });
    const mockPool = {} as unknown as DatabasePool;
    const app = await buildServer(serverOptions({ config, pool: mockPool }));

    // Payload larger than 10MB limit (11MB string)
    const oversizedPayload = "a".repeat(11 * 1024 * 1024);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/imports/world",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ sourceName: "test", worldExport: { title: oversizedPayload } })
    });

    expect(response.statusCode).toBe(413);
    const body = JSON.parse(response.payload);
    expect(body.correlationId).toBeDefined();
    expect(body.message).toContain("Correlation ID");

    await app.close();
  });

  it("reads world-generation progress through the owner-scoped application", async () => {
    const ownerUserId = "00000000-0000-0000-0000-000000000001";
    const progressKey = "world-gen-test";
    const mockPool = {
      query: async (query: string) => {
        if (query.startsWith("SELECT id FROM users")) return { rows: [{ id: ownerUserId }] };
        if (query.startsWith("DELETE FROM world_generation_progress")) return { rowCount: 0, rows: [] };
        if (query.startsWith("SELECT status, phase, progress_percent")) {
          return {
            rows: [{
              status: "processing",
              phase: "generating_world",
              progress_percent: 30,
              message: "Synthesizing world overview and characters via LLM…",
              error_message: null
            }]
          };
        }
        throw new Error(`Unexpected query: ${query}`);
      }
    } as unknown as DatabasePool;
    const app = await buildServer(serverOptions({
      config: makeConfig(),
      pool: mockPool,
      worldCampaign: testWorldCampaignApplication({
        getWorldGenerationProgress: async () => ({
          status: "processing",
          phase: "generating_world",
          progressPercent: 30,
          message: "Synthesizing world overview and characters via LLM…"
        })
      })
    }));

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/worlds/generate-progress?key=${progressKey}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "processing",
      phase: "generating_world",
      progressPercent: 30
    });

    await app.close();
  });

  it("cancels an active generation", async () => {
    const ownerUserId = "00000000-0000-0000-0000-000000000001";
    const jobId = "99999999-9999-4999-8999-999999999999";
    const cancelledJob = {
      id: jobId,
      status: "cancelled" as const,
      campaignId: "88888888-8888-4888-8888-888888888888",
      operationKind: "append" as const,
      replacementTurnId: null
    };
    const transactionControls: string[] = [];
    const mockClient = {
      query: async (query: string) => {
        if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") {
          transactionControls.push(query);
          return { rows: [] };
        }
        if (query.includes("UPDATE generation_jobs")) return { rows: [cancelledJob] };
        if (query.includes("UPDATE image_jobs")) return { rows: [] };
        if (query.includes("DELETE FROM asset_references")) return { rows: [] };
        if (query.includes("DELETE FROM turn_illustration_segment_assets")) return { rows: [] };
        if (query.includes("UPDATE turn_illustration_segments")) return { rows: [] };
        if (query.includes("UPDATE illustration_prompt_jobs")) return { rows: [] };
        if (query.includes("UPDATE illustration_resolution_jobs")) return { rows: [] };
        if (query.includes("UPDATE turn_illustration_sets")) return { rows: [] };
        throw new Error(`Unexpected transaction query: ${query}`);
      },
      release: () => undefined
    };
    const mockPool = {
      query: async (query: string) => {
        if (query.startsWith("SELECT id FROM users")) return { rows: [{ id: ownerUserId }] };
        if (query.startsWith("SELECT id AS \"generationJobId\", campaign_id AS \"campaignId\"")) return { rows: [{
          generationJobId: jobId,
          campaignId: cancelledJob.campaignId,
          providerProfileId: "77777777-7777-4777-8777-777777777777",
          expectedTurnNumber: 3,
          operationKind: "append",
          jobAttempt: 1
        }] };
        throw new Error(`Unexpected query: ${query}`);
      },
      connect: async () => mockClient
    } as unknown as DatabasePool;
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool }));

    try {
      const response = await app.inject({ method: "POST", url: `/api/v1/generation-jobs/${jobId}/cancel` });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        id: jobId,
        status: "cancelled",
        operationKind: "append",
        replacementTurnId: null
      });
      expect(transactionControls).toEqual(["BEGIN", "COMMIT"]);
    } finally {
      await app.close();
    }
  });

  it("closes a generation stream after cancelled status", async () => {
    const ownerUserId = "00000000-0000-0000-0000-000000000001";
    const jobId = "11111111-1111-4111-8111-111111111111";
    const fixtureAction = "fixture action that must not appear in lifecycle logs";
    const fixturePartialNarration = "fixture partial narration that must not appear in lifecycle logs";
    const fixturePartialOutput = `{"narration":"${fixturePartialNarration}","choices":[]}`;
    const rawFailure = "MODEL_SECRET=distinctive-raw-provider-detail";
    const mockPool = {
      query: async (query: string) => {
        if (query.startsWith("SELECT id FROM users")) return { rows: [{ id: ownerUserId }] };
        if (query.startsWith("SELECT id, campaign_id AS \"campaignId\"")) {
          return {
            rows: [{
              id: jobId,
              campaignId: "22222222-2222-4222-8222-222222222222",
              providerProfileId: null,
              expectedTurnNumber: 1,
              action: fixtureAction,
              status: "cancelled",
              attempts: 1,
              requestedInputMode: "action",
              resolvedInputMode: "action",
              inputModeSource: "explicit",
              operationKind: "append",
              replacementTurnId: null,
              baseTurnNumber: null,
              requestedModel: "fixture-model",
              providerResponseId: null,
              providerFinishReason: null,
              resultTurnId: null,
              errorCode: "provider_transport_error",
              errorMessage: rawFailure,
              recoveryMetadata: {},
              createdAt: new Date(),
              updatedAt: new Date(),
              completedAt: new Date(),
              partialOutput: fixturePartialOutput
            }]
          };
        }
        throw new Error(`Unexpected query: ${query}`);
      }
    } as unknown as DatabasePool;
    const loggerInfo = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool }));

    try {
      const response = await app.inject({ method: "GET", url: `/api/v1/generation-jobs/${jobId}/stream` });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.headers["cache-control"]).toBe("no-cache");
      expect(response.body.match(/^data: /gm)).toHaveLength(1);
      expect(response.body).toContain('"status":"cancelled"');
      const snapshotPayload = JSON.parse(response.body.trim().replace(/^data: /, ""));
      expect(generationStreamSnapshotSchema.parse(snapshotPayload)).toMatchObject({
        id: jobId,
        status: "cancelled",
        partialNarration: fixturePartialNarration,
        errorCode: "generation_failed",
        errorMessage: "Generation could not be completed."
      });
      expect(snapshotPayload).not.toHaveProperty("partialOutput");
      expect(response.body).not.toContain(rawFailure);

      const lifecycleLogs = loggerInfo.mock.calls
        .map(([fields]) => fields as Record<string, unknown>)
        .filter((fields) => String(fields.event || "").startsWith("turn_generation_stream_"));

      expect(lifecycleLogs).toEqual([
        expect.objectContaining({
          event: "turn_generation_stream_connected",
          generationJobId: jobId,
          correlationId: expect.any(String)
        }),
        expect.objectContaining({
          event: "turn_generation_stream_closed",
          generationJobId: jobId,
          correlationId: lifecycleLogs[0]?.correlationId,
          finalStatus: "cancelled",
          snapshotsSent: 1
        })
      ]);

      const serializedLogs = JSON.stringify(loggerInfo.mock.calls);
      expect(serializedLogs).not.toContain(fixtureAction);
      expect(serializedLogs).not.toContain(fixturePartialOutput);
      expect(serializedLogs).not.toContain(fixturePartialNarration);
    } finally {
      loggerInfo.mockRestore();
      await app.close();
    }
  });

  it("logs one safe lifecycle when generation stream polling fails", async () => {
    const ownerUserId = "00000000-0000-0000-0000-000000000001";
    const jobId = "33333333-3333-4333-8333-333333333333";
    const unsafeCode = "REMOTE FAILURE: sensitive detail";
    const sensitiveMessage = "sensitive polling error must not appear in logs";
    const mockPool = {
      query: async (query: string) => {
        if (query.startsWith("SELECT id FROM users")) return { rows: [{ id: ownerUserId }] };
        if (query.startsWith("SELECT id, campaign_id AS \"campaignId\"")) {
          throw Object.assign(new Error(sensitiveMessage), { code: unsafeCode });
        }
        throw new Error(`Unexpected query: ${query}`);
      }
    } as unknown as DatabasePool;
    const loggerInfo = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const loggerWarn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool }));

    try {
      const response = await app.inject({ method: "GET", url: `/api/v1/generation-jobs/${jobId}/stream` });
      const lifecycleLogs = loggerInfo.mock.calls
        .map(([fields]) => fields as Record<string, unknown>)
        .filter((fields) => String(fields.event || "").startsWith("turn_generation_stream_"));
      const warningLogs = loggerWarn.mock.calls.map(([fields]) => fields as Record<string, unknown>);

      expect(response.statusCode).toBe(500);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json()).toMatchObject({
        error: "Internal server error",
        correlationId: expect.any(String),
        details: {}
      });
      expect(lifecycleLogs).toEqual([]);
      expect(warningLogs).toEqual([]);
      const serializedLogs = JSON.stringify([...loggerInfo.mock.calls, ...loggerWarn.mock.calls]);
      expect(serializedLogs).not.toContain(sensitiveMessage);
      expect(serializedLogs).not.toContain(unsafeCode);
    } finally {
      loggerInfo.mockRestore();
      loggerWarn.mockRestore();
      await app.close();
    }
  });

  it("closes a generation stream once without writing after client disconnect", async () => {
    const ownerUserId = "00000000-0000-0000-0000-000000000001";
    const jobId = "44444444-4444-4444-8444-444444444444";
    let closeStream: (() => void) | undefined;
    let endStream: (() => void) | undefined;
    const writes: string[] = [];
    const mockPool = {
      query: async (query: string) => {
        if (query.startsWith("SELECT id FROM users")) return { rows: [{ id: ownerUserId }] };
        if (query.startsWith("SELECT id, campaign_id AS \"campaignId\"")) {
          closeStream?.();
          return {
            rows: [{
              id: jobId,
              campaignId: "55555555-5555-4555-8555-555555555555",
              providerProfileId: null,
              expectedTurnNumber: 1,
              action: "action after close",
              status: "completed",
              attempts: 1,
              requestedInputMode: "action",
              resolvedInputMode: "action",
              inputModeSource: "explicit",
              operationKind: "append",
              replacementTurnId: null,
              baseTurnNumber: null,
              requestedModel: "fixture-model",
              providerResponseId: null,
              providerFinishReason: null,
              resultTurnId: null,
              errorCode: null,
              errorMessage: null,
              recoveryMetadata: {},
              createdAt: new Date(),
              updatedAt: new Date(),
              completedAt: new Date(),
              partialOutput: null
            }]
          };
        }
        throw new Error(`Unexpected query: ${query}`);
      }
    } as unknown as DatabasePool;
    const loggerInfo = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool }));
    app.addHook("onRequest", async (request, reply) => {
      if (request.url.endsWith(`/generation-jobs/${jobId}/stream`)) {
        closeStream = () => { request.raw.emit("close"); };
        endStream = () => { reply.raw.end(); };
        const originalWrite = reply.raw.write.bind(reply.raw);
        reply.raw.write = ((chunk: string) => {
          writes.push(chunk);
          return originalWrite(chunk);
        }) as typeof reply.raw.write;
      }
    });

    try {
      const responsePromise = app.inject({ method: "GET", url: `/api/v1/generation-jobs/${jobId}/stream` });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const lifecycleLogs = loggerInfo.mock.calls
        .map(([fields]) => fields as Record<string, unknown>)
        .filter((fields) => String(fields.event || "").startsWith("turn_generation_stream_"));

      expect(writes).toEqual([]);
      expect(lifecycleLogs).toEqual([
        expect.objectContaining({ event: "turn_generation_stream_connected", generationJobId: jobId, correlationId: expect.any(String) }),
        expect.objectContaining({
          event: "turn_generation_stream_closed",
          generationJobId: jobId,
          correlationId: lifecycleLogs[0]?.correlationId,
          finalStatus: "client_closed",
          snapshotsSent: 0
        })
      ]);
      endStream?.();
      await responsePromise;
    } finally {
      endStream?.();
      loggerInfo.mockRestore();
      await app.close();
    }
  });
});
