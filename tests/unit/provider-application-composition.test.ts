import { describe, expect, it, vi } from "vitest";
import { createApiProviderApplicationComposition } from "../../services/runtime/src/provider-application-composition.js";
import { createWorkerProviderApplicationComposition } from "../../services/runtime/src/provider-application-composition.js";
import { createQueuedResponsePolicyResolver } from "../../services/runtime/src/generation-api-composition.js";
import { resolveGenerationResponseContracts } from "../../services/runtime/src/generation-response-contract.js";
import { readFrozenResponseContracts, readQueuedResponsePolicy } from "../../packages/contracts/src/generation-response-contract.js";
import { createHash } from "node:crypto";

const ownerUserId = "00000000-0000-4000-8000-000000000001";
const providerProfileId = "00000000-0000-4000-8000-000000000002";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function profile(model: string) {
  return {
    id: providerProfileId, name: "Text", provider_type: "openai_compatible", provider_role: "text",
    base_url: "https://provider.example/v1", default_model: model, context_window_tokens: 16_384,
    max_output_tokens: 2_048, temperature: 0.5, request_timeout_ms: 60_000, configuration: {},
    encrypted_api_key: null, credential_nonce: null, credential_auth_tag: null, credential_key_version: null,
    enabled: true, is_default: true, health_status: "unknown", consecutive_failures: 0,
    last_health_check_at: null, created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z")
  };
}

function controlledPool() {
  const model = "story-model";
  let inventoryVersion = "old";
  const updateStarted = deferred();
  const releaseUpdate = deferred();
  const deleteStarted = deferred();
  const releaseDelete = deferred();
  const commitStarted = deferred();
  const releaseCommit = deferred();
  const read = () => ({ rows: [profile(model)], rowCount: 1 });
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql === "COMMIT") { commitStarted.resolve(); await releaseCommit.promise; return { rows: [], rowCount: 0 }; }
      if (sql.startsWith("DELETE FROM provider_profiles")) {
        deleteStarted.resolve();
        await releaseDelete.promise;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM provider_profiles")) return { rows: [profile(model)], rowCount: 1 };
      if (sql.startsWith("UPDATE provider_profiles SET health_status") || sql.startsWith("UPDATE provider_profiles SET consecutive_failures")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("UPDATE provider_profiles SET name=")) {
        updateStarted.resolve();
        await releaseUpdate.promise;
        return { rows: [profile(model)], rowCount: 1 };
      }
      if (sql.startsWith("SELECT id,name,provider_role FROM provider_profiles")) return { rows: [{ id: providerProfileId, name: "Text", provider_role: "text" }], rowCount: 1 };
      if (sql.startsWith("UPDATE campaigns") || sql.startsWith("DELETE FROM model_chains") || sql.startsWith("DELETE FROM generation_jobs") || sql.startsWith("UPDATE campaign_memory_configs") || sql.startsWith("UPDATE chronicle_")) return { rows: [], rowCount: 1 };
      if (sql.includes("embedding_")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected client query: ${sql}`);
    })
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM provider_profiles")) return read();
      if (sql.startsWith("UPDATE provider_profiles SET")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected pool query: ${sql}`);
    })
  };
  return { pool, updateStarted, releaseUpdate, deleteStarted, releaseDelete, commitStarted, releaseCommit, inventoryVersion: () => inventoryVersion, setInventoryVersion: (version: string) => { inventoryVersion = version; } };
}

function listModels(composition: ReturnType<typeof createApiProviderApplicationComposition>) {
  return composition.application.listModels({ ownerUserId, providerProfileId, providerRole: "text" });
}

describe("provider application composition capability cache transactions", () => {
  it("uses the canonical empty registry digest through API queue and worker frozen-contract parsing", async () => {
    const row = { ...profile("story-model"), configuration: { textResponseFormatPolicy: "auto" } };
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM provider_profiles")) return { rows: [row], rowCount: 1 };
      throw new Error(`Unexpected client query: ${sql}`);
    }) };
    const pool = { connect: vi.fn(), query: vi.fn() };
    const options = { credentialSecret: "test-secret", transport: { fetch: vi.fn(), validateSdkEndpoint: vi.fn(), close: vi.fn() } };
    const api = createApiProviderApplicationComposition(pool as never, options);
    const worker = createWorkerProviderApplicationComposition(pool as never, options);
    const digest = createHash("sha256").update("").digest("hex");
    expect(api.responseFormatCapabilities.registryDigest).toBe(digest);
    expect(worker.responseFormatCapabilities.registryDigest).toBe(digest);
    const queued = await createQueuedResponsePolicyResolver(api.generation)(client as never, {
      ownerUserId, campaignId: "campaign", providerProfileId, requestedModel: "story-model", operationKind: "append",
      generationPolicy: { version: 1, playMode: "legacy", turnControlStyle: "flexible_action" }, storyMemoryPolicy: null
    });
    const policy = readQueuedResponsePolicy(queued);
    expect(policy).toBeDefined();
    const frozen = resolveGenerationResponseContracts({
      queuedPolicy: policy!, profile: { id: policy!.providerProfileId, providerType: "openai_compatible", model: policy!.model,
        endpointIdentity: createHash("sha256").update("https://provider.example/v1").digest("hex"), configurationHash: policy!.providerConfigurationHash },
      registryDigest: worker.responseFormatCapabilities.registryDigest,
      eligible: () => ({ status: "unknown", reason: "discovery_unavailable", verification: null }), selectedAt: "2026-09-18T00:00:00.000Z"
    });
    expect(readFrozenResponseContracts(frozen)).toMatchObject({ queuedPolicy: { verificationRegistryHash: digest } });
  });

  it("keeps an exported application update's global inventory stale until commit then rediscovers", async () => {
    const control = controlledPool();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: control.inventoryVersion(), name: "Model", context_length: 16_384 }] }), { headers: { "content-type": "application/json" } }));
    const composition = createApiProviderApplicationComposition(control.pool as never, {
      credentialSecret: "test-secret", transport: { fetch, validateSdkEndpoint: vi.fn(), close: vi.fn() }
    });

    await listModels(composition);
    control.setInventoryVersion("new");
    const update = composition.application.updateProfile({ ownerUserId, providerProfileId, changes: { name: "Changed" } });
    await control.updateStarted.promise;
    await listModels(composition);
    expect(fetch).toHaveBeenCalledTimes(1);

    control.releaseUpdate.resolve();
    await control.commitStarted.promise;
    await expect(listModels(composition)).resolves.toMatchObject({ models: [{ id: "old" }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    control.releaseCommit.resolve();
    await update;
    await expect(listModels(composition)).resolves.toMatchObject({ models: [{ id: "new" }] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps global inventory stable during a held direct delete and invalidates it after commit", async () => {
    const control = controlledPool();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: control.inventoryVersion(), name: "Model", context_length: 16_384 }] }), { headers: { "content-type": "application/json" } }));
    const composition = createApiProviderApplicationComposition(control.pool as never, {
      credentialSecret: "test-secret", transport: { fetch, validateSdkEndpoint: vi.fn(), close: vi.fn() }
    });

    await listModels(composition);
    control.setInventoryVersion("after-delete");
    const removal = composition.application.deleteProfile({ ownerUserId, providerProfileId });
    await control.deleteStarted.promise;
    await listModels(composition);
    expect(fetch).toHaveBeenCalledTimes(1);

    control.releaseDelete.resolve();
    await control.commitStarted.promise;
    await listModels(composition);
    expect(fetch).toHaveBeenCalledTimes(1);
    control.releaseCommit.resolve();
    await removal;
    await expect(listModels(composition)).resolves.toMatchObject({ models: [{ id: "after-delete" }] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps staged transaction discovery private, invalidates the global cache after commit, and preserves verification eligibility", async () => {
    const control = controlledPool();
    const verification = {
      version: 1 as const, providerType: "openai_compatible" as const, endpointIdentity: "endpoint", model: "model", routeConfigHash: "route",
      adapterProtocol: "text-schema-adapter-v1" as const, operation: "story" as const, schemaHash: "schema", streaming: false,
      verifiedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-10-01T00:00:00.000Z", providerRoutingSlugs: [], nativeOpenTrackerObjects: true
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: control.inventoryVersion(), name: "Model", context_length: 16_384 }] }), { headers: { "content-type": "application/json" } }));
    const composition = createApiProviderApplicationComposition(control.pool as never, {
      credentialSecret: "test-secret", transport: { fetch, validateSdkEndpoint: vi.fn(), close: vi.fn() }, schemaVerifications: [verification], schemaVerificationDigest: "registry-v1"
    });

    expect(composition.responseFormatCapabilities.registryDigest).toBe("registry-v1");
    await listModels(composition);
    control.setInventoryVersion("new");
    const transaction = composition.transaction(async (binding) => {
      await binding.runtime.inventory.listModels({ ownerUserId, providerProfileId, providerRole: "text" });
      return binding.application.updateProfile({ ownerUserId, providerProfileId, changes: { name: "Changed" } });
    });
    await control.updateStarted.promise;
    await listModels(composition);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(composition.responseFormatCapabilities.eligibility({
      providerType: "openai_compatible", endpointIdentity: "endpoint", model: "model", routeConfigHash: "route", adapterProtocol: "text-schema-adapter-v1",
      operation: "story", schemaHash: "schema", streaming: false, advertisement: { supportedParameters: ["response_format"], discoveredAt: "2026-09-18T00:00:00.000Z" }, now: "2026-09-18T00:00:00.000Z", expectedRegistryDigest: "registry-v1"
    })).toMatchObject({ status: "verified", verification });

    control.releaseUpdate.resolve();
    await control.commitStarted.promise;
    await expect(listModels(composition)).resolves.toMatchObject({ models: [{ id: "old" }] });
    expect(fetch).toHaveBeenCalledTimes(2);
    control.releaseCommit.resolve();
    await transaction;
    await expect(listModels(composition)).resolves.toMatchObject({ models: [{ id: "new" }] });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not publish discovery staged by a rolled-back composition transaction", async () => {
    const control = controlledPool();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: control.inventoryVersion(), name: "Model", context_length: 16_384 }] }), { headers: { "content-type": "application/json" } }));
    const composition = createApiProviderApplicationComposition(control.pool as never, {
      credentialSecret: "test-secret", transport: { fetch, validateSdkEndpoint: vi.fn(), close: vi.fn() }
    });

    await listModels(composition);
    control.setInventoryVersion("new");
    await expect(composition.transaction(async (binding) => {
      await binding.runtime.inventory.listModels({ ownerUserId, providerProfileId, providerRole: "text" });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await expect(listModels(composition)).resolves.toMatchObject({ models: [{ id: "old" }] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
