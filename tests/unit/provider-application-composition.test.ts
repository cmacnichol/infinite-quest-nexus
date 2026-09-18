import { describe, expect, it, vi } from "vitest";
import { createApiProviderApplicationComposition } from "../../services/runtime/src/provider-application-composition.js";

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
  let committedModel = "old-model";
  let transactionModel = "new-model";
  const updateStarted = deferred();
  const releaseUpdate = deferred();
  const read = () => ({ rows: [profile(committedModel)], rowCount: 1 });
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql === "COMMIT") { committedModel = transactionModel; return { rows: [], rowCount: 0 }; }
      if (sql.includes("FROM provider_profiles")) return { rows: [profile(transactionModel)], rowCount: 1 };
      if (sql.startsWith("UPDATE provider_profiles SET health_status") || sql.startsWith("UPDATE provider_profiles SET consecutive_failures")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("UPDATE provider_profiles SET name=")) {
        updateStarted.resolve();
        await releaseUpdate.promise;
        return { rows: [profile(transactionModel)], rowCount: 1 };
      }
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
  return { pool, updateStarted, releaseUpdate, setTransactionModel: (model: string) => { transactionModel = model; } };
}

function listModels(composition: ReturnType<typeof createApiProviderApplicationComposition>) {
  return composition.application.listModels({ ownerUserId, providerProfileId, providerRole: "text" });
}

describe("provider application composition capability cache transactions", () => {
  it("keeps an exported application update's global inventory stale until commit then rediscovers", async () => {
    const control = controlledPool();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "model", name: "Model", context_length: 16_384 }] }), { headers: { "content-type": "application/json" } }));
    const composition = createApiProviderApplicationComposition(control.pool as never, {
      credentialSecret: "test-secret", transport: { fetch, validateSdkEndpoint: vi.fn(), close: vi.fn() }
    });

    await listModels(composition);
    const update = composition.application.updateProfile({ ownerUserId, providerProfileId, changes: { defaultModel: "new-model" } });
    await control.updateStarted.promise;
    await listModels(composition);
    expect(fetch).toHaveBeenCalledTimes(1);

    control.releaseUpdate.resolve();
    await update;
    await listModels(composition);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps staged transaction discovery private, invalidates the global cache after commit, and preserves verification eligibility", async () => {
    const control = controlledPool();
    const verification = {
      version: 1 as const, providerType: "openai_compatible" as const, endpointIdentity: "endpoint", model: "model", routeConfigHash: "route",
      adapterProtocol: "text-schema-adapter-v1" as const, operation: "story" as const, schemaHash: "schema", streaming: false,
      verifiedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-10-01T00:00:00.000Z", providerRoutingSlugs: [], nativeOpenTrackerObjects: true
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "model", name: "Model", context_length: 16_384 }] }), { headers: { "content-type": "application/json" } }));
    const composition = createApiProviderApplicationComposition(control.pool as never, {
      credentialSecret: "test-secret", transport: { fetch, validateSdkEndpoint: vi.fn(), close: vi.fn() }, schemaVerifications: [verification], schemaVerificationDigest: "registry-v1"
    });

    await listModels(composition);
    const transaction = composition.transaction(async (binding) => {
      await binding.runtime.inventory.listModels({ ownerUserId, providerProfileId, providerRole: "text" });
      return binding.application.updateProfile({ ownerUserId, providerProfileId, changes: { defaultModel: "new-model" } });
    });
    await control.updateStarted.promise;
    await listModels(composition);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(composition.responseFormatCapabilities.eligibility({
      providerType: "openai_compatible", endpointIdentity: "endpoint", model: "model", routeConfigHash: "route", adapterProtocol: "text-schema-adapter-v1",
      operation: "story", schemaHash: "schema", streaming: false, advertisement: { supportedParameters: ["response_format"], discoveredAt: "2026-09-18T00:00:00.000Z" }, now: "2026-09-18T00:00:00.000Z", expectedRegistryDigest: "registry-v1"
    })).toMatchObject({ status: "verified", verification });

    control.releaseUpdate.resolve();
    await transaction;
    await listModels(composition);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not publish discovery staged by a rolled-back composition transaction", async () => {
    const control = controlledPool();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "model", name: "Model", context_length: 16_384 }] }), { headers: { "content-type": "application/json" } }));
    const composition = createApiProviderApplicationComposition(control.pool as never, {
      credentialSecret: "test-secret", transport: { fetch, validateSdkEndpoint: vi.fn(), close: vi.fn() }
    });

    await listModels(composition);
    await expect(composition.transaction(async (binding) => {
      await binding.runtime.inventory.listModels({ ownerUserId, providerProfileId, providerRole: "text" });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await listModels(composition);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
