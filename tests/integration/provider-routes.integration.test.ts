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
import { getProviderOutputSchemaV2 } from "../../packages/contracts/src/provider-output-schema.js";
import { createApiProviderApplicationComposition } from "../../services/runtime/src/provider-application-composition.js";
import { createProviderApplicationAdapter } from "../../services/api/src/provider-application-adapter.js";
import { prepareAuthoringResponseContractExecution, serializePreparedAuthoringRequest } from "../../services/runtime/src/authoring-text-execution-preparation.js";

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
  let routeConfig: RuntimeConfig;
  let routeProviders: ReturnType<typeof createProviderApplicationAdapter>;

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
    routeConfig = config;
    routeProviders = providers;
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

  it("lists a valid unconfigured text profile without invalid capability metadata", async () => {
    const name = `${baseProviderInput.name} EMPTY MODEL ${crypto.randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
      ...baseProviderInput, name, providerType: "openai_compatible", providerRole: "text", defaultModel: "", configuration: {}
    } });
    expect(created.statusCode).toBe(201);
    const response = await app.inject({ method: "GET", url: "/api/v1/providers" });
    expect(response.statusCode, response.body).toBe(200);
    const profile = response.json().providers.find((candidate: { name: string }) => candidate.name === name);
    expect(profile).toMatchObject({ defaultModel: "", textSelection: { kind: "model", modelId: "" } });
    expect(profile).not.toHaveProperty("responseFormatCapability");
  });

  it("projects unsupported remote preset fields as finite safe API diagnostics", async () => {
    const originalFetch = transport.fetch;
    transport.fetch = async () => new Response(JSON.stringify({ data: { slug: "night-shift", name: "Night Shift", status: "active", designated_version: { id: "version-2", version: 2, system_prompt: "private preset prompt", config: { "api_key-private-canary": "secret-canary" } } } }), { status: 200 });
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/providers/resolve-preset?slug=night-shift", payload: {
        ...baseProviderInput, name: `${baseProviderInput.name} DIAGNOSTIC ${crypto.randomUUID()}`,
        providerType: "openrouter", providerRole: "text", defaultModel: "@preset/night-shift", configuration: {}
      } });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "preset_config_unsupported", details: { code: "preset_config_unsupported", field: "config" } });
      expect(response.body).not.toContain("api_key-private-canary");
      expect(response.body).not.toContain("secret-canary");
    } finally {
      transport.fetch = originalFetch;
    }
  });

  it("projects stop as an exact safe remote preset field without exposing remote text", async () => {
    const originalFetch = transport.fetch;
    transport.fetch = async () => new Response(JSON.stringify({ data: { slug: "night-shift", name: "Night Shift", status: "active", designated_version: { id: "version-2", version: 2, system_prompt: "PRIVATE_REMOTE_CANARY", config: { stop: ["PRIVATE_STOP_CANARY"] } } } }), { status: 200 });
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/providers/resolve-preset?slug=night-shift", payload: {
        ...baseProviderInput, name: `${baseProviderInput.name} STOP ${crypto.randomUUID()}`,
        providerType: "openrouter", providerRole: "text", defaultModel: "@preset/night-shift", configuration: {}
      } });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual(expect.objectContaining({ code: "preset_config_unsupported", details: { code: "preset_config_unsupported", field: "stop" } }));
      expect(response.body).not.toContain("PRIVATE_REMOTE_CANARY");
      expect(response.body).not.toContain("PRIVATE_STOP_CANARY");
    } finally {
      transport.fetch = originalFetch;
    }
  });

  it("keeps generic text generation operationless with native admission off and on", async () => {
    const preset = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
      ...baseProviderInput, name: `${baseProviderInput.name} GENERIC PRESET ${crypto.randomUUID()}`,
      providerType: "openrouter", providerRole: "text", defaultModel: "@preset/night-shift",
      textSelection: { kind: "openrouter_preset", slug: "night-shift" }, configuration: {}
    } });
    expect(preset.statusCode).toBe(201);
    const required = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
      ...baseProviderInput, name: `${baseProviderInput.name} GENERIC REQUIRED ${crypto.randomUUID()}`,
      providerRole: "text", defaultModel: "historical-model", configuration: { textResponseFormatPolicy: "required" }
    } });
    expect(required.statusCode).toBe(201);
    const historical = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
      ...baseProviderInput, name: `${baseProviderInput.name} GENERIC LEGACY ${crypto.randomUUID()}`,
      providerRole: "text", defaultModel: "historical-model", configuration: { textResponseFormatPolicy: "legacy" }
    } });
    expect(historical.statusCode).toBe(201);
    const originalFetch = transport.fetch;
    let dispatches = 0;
    transport.fetch = async () => {
      dispatches += 1;
      return new Response(JSON.stringify({ id: "historical-response", model: "historical-model",
        choices: [{ message: { content: "Historical concrete response." }, finish_reason: "stop" }] }), { status: 200 });
    };
    const enabled = await buildServer(serverOptions({ config: { ...routeConfig, nativeTextExecutionPlanAdmission: true }, pool, providers: routeProviders }));
    try {
      for (const server of [app, enabled]) {
        const before = dispatches;
        for (const profileId of [preset.json().id, required.json().id]) {
          const rejected = await server.inject({ method: "POST", url: "/api/v1/provider-text/generate",
            payload: { providerProfileId: profileId, messages: [{ role: "user", content: "Hello" }] } });
          expect(rejected.statusCode).toBe(409);
          expect(rejected.json()).toMatchObject({ code: "unsupported_operation" });
        }
        expect(dispatches).toBe(before);
        const allowed = await server.inject({ method: "POST", url: "/api/v1/provider-text/generate",
          payload: { providerProfileId: historical.json().id, messages: [{ role: "user", content: "Hello" }] } });
        expect(allowed.statusCode, allowed.body).toBe(200);
      }
      expect(dispatches).toBe(2);
    } finally {
      transport.fetch = originalFetch;
      await enabled.close();
    }
  });

  it("rejects an inactive preset on provider creation before writing the profile", async () => {
    const name = `${baseProviderInput.name} INACTIVE ${crypto.randomUUID()}`;
    const originalFetch = transport.fetch;
    transport.fetch = async () => new Response(JSON.stringify({ data: { slug: "night-shift", name: "Night Shift", status: "inactive", designated_version: { id: "version-2", version: 2, system_prompt: "private", config: {} } } }), { status: 200 });
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
        ...baseProviderInput, name, providerType: "openrouter", providerRole: "text",
        defaultModel: "@preset/night-shift", textSelection: { kind: "openrouter_preset", slug: "night-shift" }, configuration: {}
      } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "preset_inactive" });
      const profiles = await app.inject({ method: "GET", url: "/api/v1/providers" });
      expect(profiles.json().providers.some((profile: { name: string }) => profile.name === name)).toBe(false);
    } finally {
      transport.fetch = originalFetch;
    }
  });

  it.each([
    ["missing", 404, "preset_missing"],
    ["auth", 401, "authentication"],
    ["unsupported", 422, "preset_config_unsupported"]
  ] as const)("rejects %s preset detail on provider creation without writing", async (condition, status, code) => {
    const name = `${baseProviderInput.name} ${condition} ${crypto.randomUUID()}`;
    const originalFetch = transport.fetch;
    transport.fetch = async () => condition === "missing" ? new Response("{}", { status: 404 })
      : condition === "auth" ? new Response("{}", { status: 401 })
      : new Response(JSON.stringify({ data: { slug: "night-shift", name: "Night Shift", status: "active", designated_version: { id: "v", version: 1, system_prompt: "private", config: { tools: [{ type: "function" }] } } } }), { status: 200 });
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
        ...baseProviderInput, name, providerType: "openrouter", providerRole: "text", defaultModel: "@preset/night-shift",
        textSelection: { kind: "openrouter_preset", slug: "night-shift" }, configuration: {}
      } });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
      const profiles = await app.inject({ method: "GET", url: "/api/v1/providers" });
      expect(profiles.json().providers.some((profile: { name: string }) => profile.name === name)).toBe(false);
    } finally { transport.fetch = originalFetch; }
  });

  it.each([
    ["inactive", 409, "preset_inactive"],
    ["missing", 404, "preset_missing"],
    ["auth", 401, "authentication"],
    ["unsupported", 422, "preset_config_unsupported"]
  ] as const)("rejects %s preset detail on PATCH without changing selection", async (condition, status, code) => {
    const created = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
      ...baseProviderInput, name: `${baseProviderInput.name} PATCH ${condition} ${crypto.randomUUID()}`,
      providerType: "openrouter", providerRole: "text", defaultModel: "concrete-model", configuration: {}
    } });
    expect(created.statusCode).toBe(201);
    const originalFetch = transport.fetch;
    transport.fetch = async () => condition === "missing" ? new Response("{}", { status: 404 })
      : condition === "auth" ? new Response("{}", { status: 401 })
        : new Response(JSON.stringify({ data: { slug: "night-shift", name: "Night Shift",
          status: condition === "inactive" ? "inactive" : "active",
          designated_version: { id: "v", version: 1, system_prompt: "private",
            config: condition === "unsupported" ? { tools: [{ type: "function" }] } : { model: "vendor/model" } } } }), { status: 200 });
    try {
      const rejected = await app.inject({ method: "PATCH", url: `/api/v1/providers/${created.json().id}`, payload: {
        defaultModel: "@preset/night-shift", textSelection: { kind: "openrouter_preset", slug: "night-shift" }
      } });
      expect(rejected.statusCode).toBe(status);
      expect(rejected.json()).toMatchObject({ code });
      const current = (await app.inject({ method: "GET", url: "/api/v1/providers" })).json().providers
        .find((profile: { id: string }) => profile.id === created.json().id);
      expect(current.textSelection).toEqual({ kind: "model", modelId: "concrete-model" });
    } finally { transport.fetch = originalFetch; }
  });

  it("rejects stale preset PATCH evidence after concurrent authority change and preserves a historical unavailable selection on rename or switch-away", async () => {
    const name = `${baseProviderInput.name} PATCH-PRESET ${crypto.randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
      ...baseProviderInput, name, providerType: "openrouter", providerRole: "text", baseUrl: "https://openrouter.test/api/v1",
      defaultModel: "concrete-model", apiKey: "saved-secret", configuration: {}
    } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const originalFetch = transport.fetch;
    let observed: { url: string; credential: string | undefined } | null = null;
    transport.fetch = async (profile, _operation, url) => {
      observed = { url, credential: profile.apiKey };
      await pool.query("UPDATE provider_profiles SET base_url=$2,updated_at=now() WHERE id=$1", [id, "https://changed.test/api/v1"]);
      return new Response(JSON.stringify({ data: { slug: "night-shift", name: "Night Shift", status: "active", designated_version: { id: "v", version: 1, system_prompt: "private", config: { model: "vendor/model" } } } }), { status: 200 });
    };
    try {
      const stale = await app.inject({ method: "PATCH", url: `/api/v1/providers/${id}`, payload: {
        defaultModel: "@preset/night-shift", textSelection: { kind: "openrouter_preset", slug: "night-shift" }
      } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "preset_save_stale" });
      expect(observed).toEqual({ url: "https://openrouter.test/api/v1/presets/night-shift", credential: "saved-secret" });
      const afterStale = (await app.inject({ method: "GET", url: "/api/v1/providers" })).json().providers.find((profile: { id: string }) => profile.id === id);
      expect(afterStale.textSelection).toEqual({ kind: "model", modelId: "concrete-model" });

      transport.fetch = originalFetch;
      const selected = await app.inject({ method: "PATCH", url: `/api/v1/providers/${id}`, payload: {
        defaultModel: "@preset/night-shift", textSelection: { kind: "openrouter_preset", slug: "night-shift" }
      } });
      expect(selected.statusCode).toBe(200);
      transport.fetch = async () => new Response("{}", { status: 404 });
      const renamed = await app.inject({ method: "PATCH", url: `/api/v1/providers/${id}`, payload: { name: `${name} renamed` } });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().textSelection).toEqual({ kind: "openrouter_preset", slug: "night-shift" });
      const switched = await app.inject({ method: "PATCH", url: `/api/v1/providers/${id}`, payload: {
        defaultModel: "concrete-model", textSelection: { kind: "model", modelId: "concrete-model" }
      } });
      expect(switched.statusCode).toBe(200);
      expect(switched.json().textSelection).toEqual({ kind: "model", modelId: "concrete-model" });
    } finally { transport.fetch = originalFetch; }
  });

  it("validates a preset PATCH against the endpoint and credential captured after its stale profile read", async () => {
    const name = `${baseProviderInput.name} SNAPSHOT-PRESET ${crypto.randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
      ...baseProviderInput, name, providerType: "openrouter", providerRole: "text", baseUrl: "https://endpoint-a.test/api/v1",
      defaultModel: "concrete-model", apiKey: "initial-secret", configuration: {}
    } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const owner = (await pool.query<{ owner_user_id: string }>("SELECT owner_user_id FROM provider_profiles WHERE id=$1", [id])).rows[0]!.owner_user_id;
    const graph = createApiProviderApplicationComposition(pool, { credentialSecret: routeConfig.credentialEncryptionKey, transport });
    let authorityChanged = false;
    const changeAuthority = async () => {
      if (!authorityChanged) {
        authorityChanged = true;
        await pool.query("UPDATE provider_profiles SET base_url=$2,updated_at=now() WHERE id=$1", [id, "https://endpoint-b.test/api/v1"]);
        await graph.runtime.storeCredential(owner, id, "rotated-secret");
      }
    };
    const originalSnapshot = graph.runtime.presetSaveAuthoritySnapshot.bind(graph.runtime);
    const racedRuntime = Object.freeze({
      ...graph.runtime,
      presetSaveAuthoritySnapshot: async (ownerUserId: string, providerProfileId: string, lock: boolean) => {
        const snapshot = await originalSnapshot(ownerUserId, providerProfileId, lock);
        if (!lock) await changeAuthority();
        return snapshot;
      }
    });
    const racedProviders = createProviderApplicationAdapter({ ...graph, runtime: racedRuntime } as never);
    const racedApp = await buildServer(serverOptions({ config: routeConfig, pool, providers: racedProviders }));
    const originalFetch = transport.fetch;
    let observed: { url: string; credential: string | undefined } | null = null;
    transport.fetch = async (profile, _operation, url) => {
      observed = { url, credential: profile.apiKey };
      return new Response(JSON.stringify({ data: { slug: "night-shift", name: "Night Shift", status: "active", designated_version: { id: "v", version: 1, system_prompt: "private", config: { model: "vendor/model" } } } }), { status: 200 });
    };
    try {
      const saved = await racedApp.inject({ method: "PATCH", url: `/api/v1/providers/${id}`, payload: {
        defaultModel: "@preset/night-shift", textSelection: { kind: "openrouter_preset", slug: "night-shift" }
      } });
      expect(saved.statusCode).toBe(409);
      expect(saved.json()).toMatchObject({ code: "preset_save_stale" });
      expect(observed).toEqual({ url: "https://endpoint-a.test/api/v1/presets/night-shift", credential: "initial-secret" });
      const current = (await app.inject({ method: "GET", url: "/api/v1/providers" })).json().providers.find((profile: { id: string }) => profile.id === id);
      expect(current).toMatchObject({ baseUrl: "https://endpoint-b.test/api/v1", textSelection: { kind: "model", modelId: "concrete-model" } });
    } finally {
      transport.fetch = originalFetch;
      await racedApp.close();
    }
  });

  it("does not decrypt a stale saved key after authority switches to a concrete model", async () => {
    const name = `${baseProviderInput.name} STALE-SWITCHAWAY ${crypto.randomUUID()}`;
    const originalFetch = transport.fetch;
    let remoteAttempts = 0;
    try {
      const created = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
        ...baseProviderInput, name, providerType: "openrouter", providerRole: "text", baseUrl: "https://before-switch.test/api/v1",
        defaultModel: "@preset/night-shift", textSelection: { kind: "openrouter_preset", slug: "night-shift" }, apiKey: "initial-secret", configuration: {}
      } });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      const owner = (await pool.query<{ owner_user_id: string }>("SELECT owner_user_id FROM provider_profiles WHERE id=$1", [id])).rows[0]!.owner_user_id;
      const graph = createApiProviderApplicationComposition(pool, { credentialSecret: routeConfig.credentialEncryptionKey, transport });
      const originalSnapshot = graph.runtime.presetSaveAuthoritySnapshot.bind(graph.runtime);
      let authorityChanged = false;
      const racedRuntime = Object.freeze({
        ...graph.runtime,
        presetSaveAuthoritySnapshot: async (ownerUserId: string, providerProfileId: string, lock: boolean) => {
          if (!lock && !authorityChanged) {
            authorityChanged = true;
            await pool.query(
              "UPDATE provider_profiles SET default_model=$2,text_selection=$3::jsonb,encrypted_api_key='corrupt',credential_nonce='corrupt',credential_auth_tag='corrupt',credential_key_version=1,updated_at=now() WHERE id=$1",
              [id, "concrete-model", JSON.stringify({ kind: "model", modelId: "concrete-model" })]
            );
          }
          return originalSnapshot(ownerUserId, providerProfileId, lock);
        }
      });
      const racedProviders = createProviderApplicationAdapter({ ...graph, runtime: racedRuntime } as never);
      const racedApp = await buildServer(serverOptions({ config: routeConfig, pool, providers: racedProviders }));
      transport.fetch = async () => {
        remoteAttempts += 1;
        throw new Error("concrete authority selection must not validate a preset");
      };
      try {
        const saved = await racedApp.inject({ method: "PATCH", url: `/api/v1/providers/${id}`, payload: { baseUrl: "https://after-switch.test/api/v1" } });
        expect(saved.statusCode).toBe(200);
        expect(saved.json()).toMatchObject({ baseUrl: "https://after-switch.test/api/v1", textSelection: { kind: "model", modelId: "concrete-model" } });
        expect(remoteAttempts).toBe(0);
      } finally {
        await racedApp.close();
      }
    } finally {
      transport.fetch = originalFetch;
    }
  });
  it("allows an explicit replacement key to validate a preset without decrypting a corrupt saved key", async () => {
    const name = `${baseProviderInput.name} REPLACEMENT-KEY ${crypto.randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
      ...baseProviderInput, name, providerType: "openrouter", providerRole: "text", baseUrl: "https://replacement-key.test/api/v1",
      defaultModel: "concrete-model", apiKey: "initial-secret", configuration: {}
    } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    await pool.query(
      "UPDATE provider_profiles SET encrypted_api_key='corrupt',credential_nonce='corrupt',credential_auth_tag='corrupt',credential_key_version=1 WHERE id=$1",
      [id]
    );
    const originalFetch = transport.fetch;
    let observedCredential: string | undefined;
    transport.fetch = async (profile, _operation, url) => {
      observedCredential = profile.apiKey;
      expect(url).toBe("https://replacement-key.test/api/v1/presets/night-shift");
      return new Response(JSON.stringify({ data: { slug: "night-shift", name: "Night Shift", status: "active", designated_version: { id: "v", version: 1, system_prompt: "private", config: { model: "vendor/model" } } } }), { status: 200 });
    };
    try {
      const saved = await app.inject({ method: "PATCH", url: `/api/v1/providers/${id}`, payload: {
        defaultModel: "@preset/night-shift", textSelection: { kind: "openrouter_preset", slug: "night-shift" }, apiKey: "replacement-secret"
      } });
      expect(saved.statusCode).toBe(200);
      expect(observedCredential).toBe("replacement-secret");
      expect(saved.json()).toMatchObject({ hasApiKey: true, textSelection: { kind: "openrouter_preset", slug: "night-shift" } });
    } finally { transport.fetch = originalFetch; }
  });

  it("switches away from a historical preset without decrypting a corrupt saved key", async () => {
    const name = `${baseProviderInput.name} SWITCH-AWAY ${crypto.randomUUID()}`;
    const originalFetch = transport.fetch;
    transport.fetch = async () => new Response(JSON.stringify({ data: { slug: "night-shift", name: "Night Shift", status: "active", designated_version: { id: "v", version: 1, system_prompt: "private", config: { model: "vendor/model" } } } }), { status: 200 });
    try {
      const created = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
        ...baseProviderInput, name, providerType: "openrouter", providerRole: "text", baseUrl: "https://switch-away.test/api/v1",
        defaultModel: "@preset/night-shift", textSelection: { kind: "openrouter_preset", slug: "night-shift" }, apiKey: "initial-secret", configuration: {}
      } });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      await pool.query(
        "UPDATE provider_profiles SET encrypted_api_key='corrupt',credential_nonce='corrupt',credential_auth_tag='corrupt',credential_key_version=1 WHERE id=$1",
        [id]
      );
      transport.fetch = async () => { throw new Error("switching away must not validate the unavailable historical preset"); };
      const switched = await app.inject({ method: "PATCH", url: `/api/v1/providers/${id}`, payload: {
        defaultModel: "concrete-model", textSelection: { kind: "model", modelId: "concrete-model" }
      } });
      expect(switched.statusCode).toBe(200);
      expect(switched.json()).toMatchObject({ textSelection: { kind: "model", modelId: "concrete-model" } });
    } finally { transport.fetch = originalFetch; }
  });

  it("round-trips strict text overrides with PATCH preserve and explicit clear semantics", async () => {
    const overrides = {
      parameters: { temperature: 0.31, max_tokens: 654 },
      conservativeContextWindowTokens: 9_999
    };
    const created = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
      ...baseProviderInput,
      name: `${baseProviderInput.name} OVERRIDES ${crypto.randomUUID()}`,
      providerType: "openrouter", providerRole: "text", defaultModel: "@preset/night-shift",
      textSelection: { kind: "openrouter_preset", slug: "night-shift" },
      configuration: {}
    } });
    expect(created.statusCode).toBe(201);
    expect(created.json().configuration).toEqual({ textResponseFormatPolicy: "required" });

    const renamed = await app.inject({ method: "PATCH", url: `/api/v1/providers/${created.json().id}`, payload: {
      name: `${baseProviderInput.name} OVERRIDES renamed ${crypto.randomUUID()}`,
      configuration: { textExecutionOverrides: overrides }
    } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().configuration.textExecutionOverrides).toEqual(overrides);

    const saved = renamed.json();
    const execution = {
      id: saved.id, name: saved.name, providerRole: "text" as const, providerType: "openrouter" as const,
      model: saved.defaultModel, contextWindowTokens: Number(saved.contextWindowTokens), maxOutputTokens: Number(saved.maxOutputTokens),
      temperature: Number(saved.temperature), requestTimeoutMs: Number(saved.requestTimeoutMs), configuration: saved.configuration,
      textSelection: saved.textSelection, executionRevision: "api-round-trip", authorityRevision: "api-authority",
      endpointIdentity: "api-endpoint", execute: async () => { throw new Error("prepared-body test must not call a provider"); }
    };
    const prepared = await prepareAuthoringResponseContractExecution({
      ownerUserId: "00000000-0000-4000-8000-000000000001", execution,
      operationPrompts: { worldOutline: "Create a compact world." },
      ports: {
        resolvePreset: async () => ({ slug: "night-shift", name: "Night Shift", versionId: "version-2", version: 2, configHash: "a".repeat(64), config: { model: "openai/gpt-4o", temperature: 0.8, max_tokens: 900 }, systemPrompt: "private preset prompt" }),
        discoverModels: async () => [{ id: "openai/gpt-4o" }]
      }
    });
    const preparedRequest = serializePreparedAuthoringRequest({
      execution, prepared, operation: "worldOutline",
      request: { systemPrompt: "ignored", input: "small input" }
    });
    expect(JSON.parse(preparedRequest.body)).toMatchObject({ model: "openai/gpt-4o", temperature: 0.31, max_tokens: 654 });
    expect(JSON.parse(preparedRequest.body).response_format).toEqual({ type: "json_schema", json_schema: {
      name: getProviderOutputSchemaV2("world_outline").name, strict: true, schema: getProviderOutputSchemaV2("world_outline").schema
    } });
    expect(preparedRequest.budgetAudit).toMatchObject({ inputLimit: 9_345, outputReserveTokens: 654 });

    const cleared = await app.inject({ method: "PATCH", url: `/api/v1/providers/${created.json().id}`, payload: {
      configuration: { textExecutionOverrides: null }
    } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().configuration).not.toHaveProperty("textExecutionOverrides");
    expect(cleared.json().configuration.textResponseFormatPolicy).toBe("required");
    const clearedExecution = { ...execution, configuration: cleared.json().configuration };
    const inherited = await prepareAuthoringResponseContractExecution({
      ownerUserId: "00000000-0000-4000-8000-000000000001", execution: clearedExecution,
      operationPrompts: { worldOutline: "Create a compact world." },
      ports: {
        resolvePreset: async () => ({ slug: "night-shift", name: "Night Shift", versionId: "version-2", version: 2, configHash: "a".repeat(64), config: { model: "openai/gpt-4o", temperature: 0.8, max_tokens: 900 }, systemPrompt: "private preset prompt" }),
        discoverModels: async () => [{ id: "openai/gpt-4o", contextWindowTokens: 8_192, maxOutputTokens: 1_000 }]
      }
    });
    const inheritedRequest = serializePreparedAuthoringRequest({
      execution: clearedExecution, prepared: inherited, operation: "worldOutline",
      request: { systemPrompt: "ignored", input: "small input" }
    });
    expect(JSON.parse(inheritedRequest.body)).toMatchObject({ model: "openai/gpt-4o", temperature: 0.8, max_tokens: 900 });
    expect(JSON.parse(inheritedRequest.body).response_format).toEqual({ type: "json_schema", json_schema: {
      name: getProviderOutputSchemaV2("world_outline").name, strict: true, schema: getProviderOutputSchemaV2("world_outline").schema
    } });
    expect(inheritedRequest.budgetAudit).toMatchObject({ inputLimit: 7_292, outputReserveTokens: 900 });

    const invalid = await app.inject({ method: "PATCH", url: `/api/v1/providers/${created.json().id}`, payload: {
      configuration: { textExecutionOverrides: { parameters: { top_p: 2 } } }
    } });
    expect(invalid.statusCode).toBe(400);

    const image = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
      ...baseProviderInput,
      name: `${baseProviderInput.name} IMAGE OVERRIDES ${crypto.randomUUID()}`,
      configuration: { textExecutionOverrides: overrides }
    } });
    expect(image.statusCode).toBe(400);

    const savedImage = await app.inject({ method: "POST", url: "/api/v1/providers", payload: {
      ...baseProviderInput,
      name: `${baseProviderInput.name} IMAGE PATCH ${crypto.randomUUID()}`,
      configuration: {}
    } });
    expect(savedImage.statusCode).toBe(201);
    const imagePatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/providers/${savedImage.json().id}`,
      payload: { configuration: { textExecutionOverrides: overrides } }
    });
    expect(imagePatch.statusCode).toBe(400);
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
    expect(detail.json()).toEqual({
      slug: "night-shift", name: "Night Shift", versionId: "version-2", version: 2,
      standardPrompt: "private preset prompt", candidateModelIds: ["openai/gpt-4o"], providerPolicy: {}, excludedProviderSlugs: [], parameters: {},
      limits: { configuredMaxTokens: null, configuredMaxCompletionTokens: null, effectiveMaxOutputTokens: null, contextWindowTokens: { status: "unknown", value: null } },
      responseFormat: { mode: "json_schema", assurance: "trusted_preset" }
    });
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
    expect(resolved.json()).toMatchObject({ slug: "night-shift", standardPrompt: "private preset prompt", responseFormat: { mode: "json_schema", assurance: "trusted_preset" } });
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
