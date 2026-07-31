import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import { buildServer } from "../../services/api/src/server.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const baseProviderInput = {
  name: "Provider redaction route test",
  providerType: "openai_compatible",
  providerRole: "image",
  baseUrl: "https://8.8.8.8/v1",
  defaultModel: "synthetic-image-model",
  contextWindowTokens: 32_768,
  maxOutputTokens: 4_096,
  temperature: 0.8,
  requestTimeoutMs: 30_000,
  enabled: true,
  isDefault: false
} as const;

integration("provider route configuration redaction", () => {
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 3);
    await migrateDatabase(pool, resolve("database/migrations"));
    const config: RuntimeConfig = {
      role: "all",
      host: "127.0.0.1",
      port: 8080,
      databaseUrl: databaseUrl!,
      databaseMaxConnections: 3,
      migrationDirectory: resolve("database/migrations"),
      migrationWaitSeconds: 10,
      allowMaintenanceMigrations: false,
      workerPollIntervalMs: 1000,
      workerLeaseSeconds: 60,
      webRoot: resolve("apps/web/public"),
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
      credentialEncryptionKey: "provider-route-test-key-32-bytes",
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
      }
    };
    app = await buildServer({ config, pool });
  });

  afterAll(async () => {
    await pool.query("DELETE FROM provider_profiles WHERE name LIKE $1", [`${baseProviderInput.name}%`]);
    await app.close();
    await pool.end();
  });

  it("preserves saved configuration values in POST responses while keeping the primary API key opaque", async () => {
    const configuration = {
      apiKey: "legitimate-secondary-value",
      nested: {
        accessToken: "legitimate-nested-value",
        apiUrl: "https://api.example.test"
      },
      projectId: "project-1"
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/providers",
      payload: {
        ...baseProviderInput,
        name: `${baseProviderInput.name} POST ${crypto.randomUUID()}`,
        apiKey: "primary-secret",
        configuration
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      configuration,
      hasApiKey: true
    });
    expect(response.json()).not.toHaveProperty("apiKey");
  });

  it("preserves saved configuration values in PATCH responses while keeping the primary API key opaque", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/providers",
      payload: {
        ...baseProviderInput,
        name: `${baseProviderInput.name} PATCH ${crypto.randomUUID()}`,
        apiKey: "primary-secret",
        configuration: { projectId: "before-patch" }
      }
    });
    expect(created.statusCode).toBe(201);

    const configuration = {
      apiKey: "updated-secondary-value",
      nested: {
        accessToken: "updated-nested-value",
        apiUrl: "https://updated.example.test"
      },
      projectId: "after-patch"
    };
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/providers/${created.json().id}`,
      payload: { configuration }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configuration,
      hasApiKey: true
    });
    expect(response.json()).not.toHaveProperty("apiKey");
  });

  it("redacts nested secondary secrets from GET list responses", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/providers",
      payload: {
        ...baseProviderInput,
        name: `${baseProviderInput.name} GET ${crypto.randomUUID()}`,
        apiKey: "primary-secret",
        configuration: {
          apiKey: "secondary-secret",
          nested: {
            accessToken: "nested-secret",
            apiUrl: "https://api.example.test"
          },
          projectId: "project-2"
        }
      }
    });
    expect(created.statusCode).toBe(201);

    const response = await app.inject({ method: "GET", url: "/api/v1/providers" });

    expect(response.statusCode).toBe(200);
    const provider = response.json().providers.find((candidate: { id: string }) => candidate.id === created.json().id);
    expect(provider).toMatchObject({
      configuration: {
        nested: { apiUrl: "https://api.example.test" },
        projectId: "project-2"
      },
      hasApiKey: true
    });
    expect(provider.configuration).not.toHaveProperty("apiKey");
    expect(provider.configuration.nested).not.toHaveProperty("accessToken");
    expect(provider).not.toHaveProperty("apiKey");
  });
});
