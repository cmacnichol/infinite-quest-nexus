import { resolve } from "node:path";
import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import { buildServer } from "../../services/api/src/server.js";
import { inertStorageServerOptions as serverOptions } from "../helpers/build-server-options.js";
import { createProviderNetworkPolicy } from "../../packages/security/src/provider-network-policy.js";
import { createProviderTransport, type ProviderTransport } from "../../packages/story-engine/src/provider-transport.js";
import { createApiProviderApplicationComposition } from "../../services/runtime/src/provider-application-composition.js";
import { createProviderApplicationAdapter } from "../../services/api/src/provider-application-adapter.js";

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
  let transport: ProviderTransport;

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
    transport = {
      fetch: async (_profile, _operation, url) => {
        if (url.includes("/presets/night-shift")) return new Response(JSON.stringify({ data: { slug: "night-shift", name: "Night Shift", status: "active", designated_version: { id: "version-2", version: 2, system_prompt: "private preset prompt", config: { models: ["openai/gpt-4o"] } } } }), { status: 200 });
        return new Response(JSON.stringify({ data: [{ slug: "night-shift", name: "Night Shift", status: "active", designated_version_id: "version-2", updated_at: "2026-09-19T00:00:00Z" }], total_count: 1 }), { status: 200 });
      }, validateSdkEndpoint: async () => undefined, close: async () => undefined
    };
    const providers = createProviderApplicationAdapter(createApiProviderApplicationComposition(pool, {
      credentialSecret: config.credentialEncryptionKey,
      transport
    }));
    app = await buildServer(serverOptions({ config, pool, providers }));
  });

  afterAll(async () => {
    await pool.query("DELETE FROM provider_profiles WHERE name LIKE $1", [`${baseProviderInput.name}%`]);
    await app.close();
    await transport.close();
    await pool.end();
  });

  it("preserves saved configuration values in POST responses while keeping the primary API key opaque", async () => {
    const configuration = {
      apiKey: "legitimate-secondary-value",
      nested: {
        accessToken: "legitimate-nested-value",
        apiUrl: "https://api.example.test"
      },
      projectId: "project-1",
      defaultWidth: 768,
      httpReferer: "https://nexus.example.test"
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
      configuration: { defaultWidth: 768, httpReferer: "https://nexus.example.test" },
      hasApiKey: true
    });
    expect(response.json()).not.toHaveProperty("apiKey");
  });

  it("discovers saved OpenRouter preset summaries and owner-only detail without returning credentials", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
      ...baseProviderInput, name: `${baseProviderInput.name} PRESET ${crypto.randomUUID()}`,
      providerType: "openrouter", providerRole: "text", baseUrl: "https://openrouter.test/api/v1", defaultModel: "model", apiKey: "preset-secret", configuration: {}
    } });
    expect(created.statusCode).toBe(201);
    const list = await app.inject({ method: "GET", url: `/api/v1/providers/${created.json().id}/presets?offset=0&limit=50` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ presets: [{ slug: "night-shift", name: "Night Shift" }], nextOffset: null });
    expect(JSON.stringify(list.json())).not.toContain("preset-secret");
    const detail = await app.inject({ method: "GET", url: `/api/v1/providers/${created.json().id}/presets/night-shift` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ slug: "night-shift", systemPrompt: "private preset prompt" });
    expect(JSON.stringify(detail.json())).not.toContain("preset-secret");
  });

  it("aborts a disconnected saved-preset request through the route, adapter, runtime, and transport reader without aborting a completed request", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
      ...baseProviderInput, name: `${baseProviderInput.name} PRESET-CANCEL ${crypto.randomUUID()}`,
      providerType: "openrouter", providerRole: "text", baseUrl: "https://openrouter.test/api/v1", defaultModel: "model", apiKey: "preset-cancel-secret", configuration: {}
    } });
    expect(created.statusCode).toBe(201);
    const originalFetch = transport.fetch;
    let completedSignal: AbortSignal | undefined;
    transport.fetch = async (_profile, _operation, _url, init) => {
      completedSignal = init.signal ?? undefined;
      return new Response(JSON.stringify({ data: [{ slug: "completed", name: "Completed", status: "active", designated_version_id: "v", updated_at: "2026-09-19T00:00:00Z" }], total_count: 1 }), { status: 200 });
    };
    try {
      const completed = await app.inject({ method: "GET", url: `/api/v1/providers/${created.json().id}/presets?offset=0&limit=50` });
      expect(completed.statusCode).toBe(200);
      expect(completedSignal?.aborted).toBe(false);

      let started!: () => void;
      const startedReading = new Promise<void>((resolveStarted) => { started = resolveStarted; });
      let observedAbort!: () => void;
      const aborted = new Promise<void>((resolveAbort) => { observedAbort = resolveAbort; });
      transport.fetch = async (_profile, _operation, _url, init) => new Promise<Response>((_resolve, reject) => {
        started();
        init.signal?.addEventListener("abort", () => { observedAbort(); reject(new DOMException("disconnected", "AbortError")); }, { once: true });
      });
      const address = await app.listen({ port: 0, host: "127.0.0.1" });
      const request = http.get(`${address}/api/v1/providers/${created.json().id}/presets?offset=0&limit=50&refresh=true`);
      request.on("error", () => undefined);
      await startedReading;
      request.destroy();
      await aborted;
    } finally {
      transport.fetch = originalFetch;
    }
  });

  it("discovers and resolves an unsaved candidate without creating a provider profile", async () => {
    const name = `${baseProviderInput.name} CANDIDATE ${crypto.randomUUID()}`;
    const candidate = { ...baseProviderInput, name, providerType: "openrouter", providerRole: "text", baseUrl: "https://openrouter.test/api/v1", defaultModel: "model", apiKey: "candidate-secret", configuration: {} };
    const discovered = await app.inject({ method: "POST", url: "/api/v1/providers/discover-presets?offset=0&limit=50", payload: candidate });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json()).toMatchObject({ presets: [{ slug: "night-shift" }] });
    expect(JSON.stringify(discovered.json())).not.toContain("candidate-secret");
    const resolved = await app.inject({ method: "POST", url: "/api/v1/providers/resolve-preset?slug=night-shift", payload: candidate });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ slug: "night-shift", systemPrompt: "private preset prompt" });
    const profiles = await app.inject({ method: "GET", url: "/api/v1/providers" });
    expect(profiles.json().providers.some((profile: { name: string }) => profile.name === name)).toBe(false);
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
      projectId: "after-patch",
      defaultWidth: 1024
    };
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/providers/${created.json().id}`,
      payload: { configuration }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configuration: { defaultWidth: 1024 },
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
          projectId: "project-2",
          defaultWidth: 640
        }
      }
    });
    expect(created.statusCode).toBe(201);

    const response = await app.inject({ method: "GET", url: "/api/v1/providers" });

    expect(response.statusCode).toBe(200);
    const provider = response.json().providers.find((candidate: { id: string }) => candidate.id === created.json().id);
    expect(provider).toMatchObject({
      configuration: {
        defaultWidth: 640
      },
      hasApiKey: true
    });
    expect(provider.configuration).not.toHaveProperty("apiKey");
    expect(provider.configuration).not.toHaveProperty("nested");
    expect(provider).not.toHaveProperty("apiKey");
  });

  it("redacts the previously-stored configuration from PATCH responses that don't submit configuration", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/providers",
      payload: {
        ...baseProviderInput,
        name: `${baseProviderInput.name} PATCH-NO-CONFIG ${crypto.randomUUID()}`,
        apiKey: "primary-secret",
        configuration: {
          apiKey: "stored-secondary-secret",
          nested: { accessToken: "stored-nested-secret" },
          projectId: "project-3",
          defaultWidth: 512
        }
      }
    });
    expect(created.statusCode).toBe(201);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/providers/${created.json().id}`,
      payload: { name: `${baseProviderInput.name} PATCH-NO-CONFIG renamed ${crypto.randomUUID()}` }
    });

    expect(response.statusCode).toBe(200);
    const provider = response.json();
    expect(provider.configuration).toMatchObject({ defaultWidth: 512 });
    expect(provider.configuration).not.toHaveProperty("apiKey");
    expect(provider.configuration).not.toHaveProperty("nested");
  });

  it("redacts stored configuration from PUT .../default responses", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/providers",
      payload: {
        ...baseProviderInput,
        name: `${baseProviderInput.name} DEFAULT ${crypto.randomUUID()}`,
        apiKey: "primary-secret",
        configuration: {
          apiKey: "stored-secondary-secret",
          nested: { accessToken: "stored-nested-secret" },
          projectId: "project-4",
          defaultWidth: 896
        }
      }
    });
    expect(created.statusCode).toBe(201);

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/providers/${created.json().id}/default`
    });

    expect(response.statusCode).toBe(200);
    const provider = response.json();
    expect(provider.configuration).toMatchObject({ defaultWidth: 896 });
    expect(provider.configuration).not.toHaveProperty("apiKey");
    expect(provider.configuration).not.toHaveProperty("nested");
  });
});
