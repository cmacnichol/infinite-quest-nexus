import { describe, expect, test, vi } from "vitest";
import { toSafeProviderConfiguration } from "../../packages/application/src/providers/index.js";
import {
  createProviderCostRepository,
  createProviderCostTransactionContext
} from "../../packages/database/src/cost-repository.js";
import { PROMPT_TEMPLATE_CATALOG } from "../../packages/contracts/src/prompt-library.js";
import {
  createPostgresProviderRepositories,
  validateProviderConfiguration
} from "../../packages/database/src/provider-repository.js";
import { createPromptRepository } from "../../packages/database/src/prompt-repository.js";
import { encryptCredential } from "../../packages/story-engine/src/credentials.js";
import { buildRpgAssessmentPrompt } from "../../packages/story-engine/src/mechanics.js";
import { reportedProviderCost } from "../../packages/story-engine/src/providers.js";
import { createRuntimeProviderAdapter } from "../../services/runtime/src/provider-credential-transport-adapter.js";

describe("provider PostgreSQL adapter boundaries", () => {
  test("validates provider-specific configuration before projecting its safe fields", () => {
    expect(() => validateProviderConfiguration("sogni", {
      pollIntervalMs: 4_000,
      maximumPollIntervalMs: 2_000,
      apiKey: "must-never-be-projected"
    })).toThrow(/maximum poll interval/i);

    const configuration = validateProviderConfiguration("sogni_sdk", {
      defaultWidth: 1_024,
      defaultHeight: 1_024,
      contentFilter: "enabled",
      apiKey: "must-never-be-projected",
      encryptionKey: "must-never-be-projected"
    });

    expect(configuration).toMatchObject({
      defaultWidth: 1_024,
      defaultHeight: 1_024,
      contentFilter: "enabled"
    });
    expect(configuration).not.toHaveProperty("apiKey");
    expect(configuration).not.toHaveProperty("encryptionKey");
  });

  test("accepts only transaction contexts created from a caller-owned database client", async () => {
    const writer = { query: vi.fn().mockResolvedValue({ rows: [{ id: "cost-id" }] }) };
    const reader = { query: vi.fn() };
    const repository = createProviderCostRepository(reader as never);
    const command = {
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      campaignId: "00000000-0000-4000-8000-000000000002",
      providerProfileId: "00000000-0000-4000-8000-000000000003",
      providerType: "openai_compatible" as const,
      requestedModel: "story-model",
      category: "story" as const,
      operation: "story.generate",
      usage: { inputTokens: 10, outputTokens: 5 },
      reportedCost: { amount: "0.125", currency: "USD" },
      localCallId: "00000000-0000-4000-8000-000000000004"
    };

    await expect(repository.recordCost({}, command)).rejects.toThrow(/transaction context/i);
    await expect(repository.recordCost(
      createProviderCostTransactionContext(writer as never),
      command
    )).resolves.toBe("cost-id");

    expect(writer.query).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(writer.query.mock.calls)).not.toContain("must-never");
  });

  test("records tiny provider costs in the database decimal contract", async () => {
    const writer = { query: vi.fn().mockResolvedValue({ rows: [{ id: "cost-id" }] }) };
    const repository = createProviderCostRepository({ query: vi.fn() } as never);
    const reportedCost = reportedProviderCost({ cost: 1.2e-7, currency: "USD" });
    expect(reportedCost).toEqual({ amount: "0.00000012", currency: "USD" });
    if (!reportedCost) throw new Error("Expected a normalized provider cost.");

    await expect(repository.recordCost(
      createProviderCostTransactionContext(writer as never),
      {
        ownerUserId: "00000000-0000-4000-8000-000000000001",
        campaignId: "00000000-0000-4000-8000-000000000002",
        providerProfileId: "00000000-0000-4000-8000-000000000003",
        providerType: "openrouter",
        requestedModel: "qwen/qwen3-embedding-8b",
        category: "memory",
        operation: "memory_embedding",
        usage: { inputTokens: 10, totalTokens: 10 },
        reportedCost,
        localCallId: "00000000-0000-4000-8000-000000000004"
      }
    )).resolves.toBe("cost-id");

    expect(writer.query.mock.calls[0]?.[1]).toContain("0.00000012");
    expect(JSON.stringify(writer.query.mock.calls)).not.toContain("1.2e-7");
  });

  test("keeps credentials runtime-private while reusing the injected pinned transport", async () => {
    const plaintext = "test-secret-never-public";
    const encrypted = encryptCredential(plaintext, "credential-encryption-secret");
    const row = {
      id: "00000000-0000-4000-8000-000000000011",
      name: "Pinned provider",
      provider_type: "openai_compatible",
      provider_role: "text",
      base_url: "https://provider.test/v1",
      default_model: "story-model",
      context_window_tokens: 16_384,
      max_output_tokens: 2_048,
      temperature: 0.5,
      request_timeout_ms: 60_000,
      configuration: { streaming: true, apiKey: "stored-config-secret" },
      encrypted_api_key: encrypted.ciphertext,
      credential_nonce: encrypted.nonce,
      credential_auth_tag: encrypted.authTag,
      credential_key_version: encrypted.keyVersion,
      enabled: true,
      is_default: true,
      health_status: "unknown",
      consecutive_failures: 0,
      last_health_check_at: null,
      created_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-01-01T00:00:00Z")
    };
    const database = {
      query: vi.fn(async (statement: string) => statement.startsWith("SELECT")
        ? { rows: [row], rowCount: 1 }
        : { rows: [], rowCount: 1 })
    };
    const fetch = vi.fn(async (profile: { apiKey?: string }) => {
      expect(profile.apiKey).toBe(plaintext);
      return new Response(JSON.stringify({ data: [{ id: "story-model", name: "Story Model", context_length: 16_384 }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const transport = {
      fetch,
      validateSdkEndpoint: vi.fn(),
      close: vi.fn()
    };
    const health = { recordHealth: vi.fn() };
    const adapter = createRuntimeProviderAdapter({
      database: database as never,
      credentialSecret: "credential-encryption-secret",
      transport,
      health
    });

    const lease = await adapter.leases.leaseResolved(
      { ownerUserId: "00000000-0000-4000-8000-000000000012" },
      row.id,
      "text",
      "story-model"
    );
    const inventory = await adapter.inventory.listModels({
      ownerUserId: "00000000-0000-4000-8000-000000000012",
      providerProfileId: row.id,
      providerRole: "text"
    });
    const execution = await adapter.execution.text(
      { ownerUserId: "00000000-0000-4000-8000-000000000012" },
      row.id,
      "text",
      "alternate-model"
    );
    await adapter.storeCredential("00000000-0000-4000-8000-000000000012", row.id, plaintext);

    expect(inventory.models).toEqual([{ id: "story-model", name: "Story Model", contextWindowTokens: 16_384 }]);
    expect(execution).toMatchObject({
      id: row.id,
      name: row.name,
      model: "alternate-model"
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(health.recordHealth).toHaveBeenCalledWith(expect.objectContaining({ outcome: "healthy" }));
    const publicValues = JSON.stringify({ lease, inventory, execution });
    expect(publicValues).not.toContain(plaintext);
    expect(publicValues).not.toContain(encrypted.ciphertext);
    expect(publicValues).not.toContain("stored-config-secret");
    expect(JSON.stringify(database.query.mock.calls)).not.toContain(plaintext);
  });

  test("uses an owner-scoped management credential load for a disabled saved OpenRouter preset", async () => {
    const plaintext = "disabled-preset-secret";
    const encrypted = encryptCredential(plaintext, "credential-encryption-secret");
    const ownerUserId = "00000000-0000-4000-8000-000000000014";
    const row = {
      id: "00000000-0000-4000-8000-000000000015",
      name: "Disabled OpenRouter",
      provider_type: "openrouter",
      provider_role: "intent",
      base_url: "https://openrouter.ai/api/v1",
      default_model: "",
      context_window_tokens: 32_768,
      max_output_tokens: 4_096,
      temperature: 0.8,
      request_timeout_ms: 5_000,
      configuration: {},
      encrypted_api_key: encrypted.ciphertext,
      credential_nonce: encrypted.nonce,
      credential_auth_tag: encrypted.authTag,
      credential_key_version: encrypted.keyVersion,
      enabled: false,
      is_default: false,
      health_status: "unknown",
      consecutive_failures: 0,
      last_health_check_at: null,
      created_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-01-01T00:00:00Z")
    };
    const database = {
      query: vi.fn(async (statement: string) => statement.includes("AND enabled=true")
        ? { rows: [], rowCount: 0 }
        : { rows: [row], rowCount: 1 })
    };
    const fetch = vi.fn(async (transportProfile: { apiKey?: string }, operation: string, url: string) => {
      expect(transportProfile.apiKey).toBe(plaintext);
      expect(operation).toBe("OpenRouter preset discovery");
      expect(url).toBe("https://openrouter.ai/api/v1/presets/story-router");
      return new Response(JSON.stringify({
        data: {
          slug: "story-router",
          status: "active",
          designated_version_id: "version-id",
          designated_version: { id: "version-id", version: 1, system_prompt: "", config: { model: "openai/gpt-4o-mini" } }
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const adapter = createRuntimeProviderAdapter({
      database: database as never,
      credentialSecret: "credential-encryption-secret",
      transport: { fetch, validateSdkEndpoint: vi.fn(), close: vi.fn() },
      health: { recordHealth: vi.fn() }
    });

    await expect(adapter.getPreset({ ownerUserId }, row.id, "story-router")).resolves.toMatchObject({
      slug: "story-router",
      models: ["openai/gpt-4o-mini"]
    });
    expect(database.query).toHaveBeenCalledWith(expect.not.stringContaining("AND enabled=true"), [row.id, ownerUserId]);
    expect(JSON.stringify(await adapter.getPreset({ ownerUserId }, row.id, "story-router"))).not.toContain(plaintext);
  });

  test("uses the saved owner-scoped credential with a patched candidate profile for preset validation", async () => {
    const plaintext = "patched-candidate-secret";
    const encrypted = encryptCredential(plaintext, "credential-encryption-secret");
    const ownerUserId = "00000000-0000-4000-8000-000000000041";
    const row = {
      id: "00000000-0000-4000-8000-000000000042",
      name: "Saved OpenRouter",
      provider_type: "openrouter",
      provider_role: "text",
      base_url: "https://old-openrouter.example/v1",
      default_model: "old-model",
      context_window_tokens: 32_768,
      max_output_tokens: 4_096,
      temperature: 0.8,
      request_timeout_ms: 5_000,
      configuration: {},
      encrypted_api_key: encrypted.ciphertext,
      credential_nonce: encrypted.nonce,
      credential_auth_tag: encrypted.authTag,
      credential_key_version: encrypted.keyVersion,
      enabled: true,
      is_default: false,
      health_status: "unknown",
      consecutive_failures: 0,
      last_health_check_at: null,
      created_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-01-01T00:00:00Z")
    };
    const database = { query: vi.fn(async () => ({ rows: [row], rowCount: 1 })) };
    const fetch = vi.fn(async (profile: { apiKey?: string }, _operation: string, url: string) => {
      expect(profile.apiKey).toBe(plaintext);
      expect(url).toBe("https://patched-openrouter.example/v1/presets/story-router");
      return new Response(JSON.stringify({
        data: {
          slug: "story-router",
          status: "active",
          designated_version_id: "version-id",
          designated_version: { id: "version-id", version: 1, system_prompt: "", config: { model: "openai/gpt-4o-mini" } }
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const adapter = createRuntimeProviderAdapter({
      database: database as never,
      credentialSecret: "credential-encryption-secret",
      transport: { fetch, validateSdkEndpoint: vi.fn(), close: vi.fn() },
      health: { recordHealth: vi.fn() }
    });

    const snapshot = await adapter.getPresetForCandidate({ ownerUserId }, row.id, {
      ownerUserId,
      name: row.name,
      providerType: "openrouter",
      providerRole: "text",
      baseUrl: "https://patched-openrouter.example/v1",
      defaultModel: "",
      contextWindowTokens: row.context_window_tokens,
      maxOutputTokens: row.max_output_tokens,
      temperature: row.temperature,
      requestTimeoutMs: row.request_timeout_ms,
      configuration: toSafeProviderConfiguration({}),
      enabled: row.enabled,
      isDefault: row.is_default
    }, "story-router");

    expect(snapshot).toMatchObject({ slug: "story-router", models: ["openai/gpt-4o-mini"] });
    expect(JSON.stringify(snapshot)).not.toContain(plaintext);
    expect(JSON.stringify({ snapshot, calls: database.query.mock.calls })).not.toContain(plaintext);
  });

  test("forwards a candidate detail credential only to the OpenRouter transport profile", async () => {
    const credential = "candidate-detail-secret";
    const fetch = vi.fn(async (transportProfile: { apiKey?: string }, operation: string) => {
      expect(transportProfile.apiKey).toBe(credential);
      expect(operation).toBe("OpenRouter preset discovery");
      return new Response(JSON.stringify({
        data: {
          slug: "story-router",
          status: "active",
          designated_version_id: "version-id",
          designated_version: { id: "version-id", version: 1, system_prompt: "", config: { model: "openai/gpt-4o-mini" } }
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const adapter = createRuntimeProviderAdapter({
      database: { query: vi.fn() } as never,
      credentialSecret: "credential-encryption-secret",
      transport: { fetch, validateSdkEndpoint: vi.fn(), close: vi.fn() },
      health: { recordHealth: vi.fn() }
    });
    const candidate = {
      ownerUserId: "00000000-0000-4000-8000-000000000016",
      name: "Candidate OpenRouter",
      providerType: "openrouter" as const,
      providerRole: "text" as const,
      baseUrl: "https://openrouter.ai/api/v1",
      defaultModel: "",
      contextWindowTokens: 32_768,
      maxOutputTokens: 4_096,
      temperature: 0.8,
      requestTimeoutMs: 5_000,
      configuration: toSafeProviderConfiguration({}),
      enabled: false,
      isDefault: false
    };

    const snapshot = await adapter.discoverCandidatePresetWithCredential(candidate, credential, "story-router");
    expect(snapshot).toMatchObject({ slug: "story-router", models: ["openai/gpt-4o-mini"] });
    expect(JSON.stringify(snapshot)).not.toContain(credential);
  });

  test("discovers embedding models through an OpenRouter text fallback profile", async () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000013",
      name: "OpenRouter text fallback",
      provider_type: "openrouter",
      provider_role: "text",
      base_url: "https://openrouter.ai/api/v1",
      default_model: "openai/gpt-4o-mini",
      context_window_tokens: 128_000,
      max_output_tokens: 4_096,
      temperature: 0.5,
      request_timeout_ms: 60_000,
      configuration: {},
      encrypted_api_key: null,
      credential_nonce: null,
      credential_auth_tag: null,
      credential_key_version: null,
      enabled: true,
      is_default: true,
      health_status: "unknown",
      consecutive_failures: 0,
      last_health_check_at: null,
      created_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-01-01T00:00:00Z")
    };
    const database = {
      query: vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 })
    };
    const fetch = vi.fn(async (_profile, operation: string, url: string) => {
      expect(operation).toBe("embedding model discovery");
      expect(url).toBe("https://openrouter.ai/api/v1/embeddings/models");
      return new Response(JSON.stringify({
        data: [{
          id: "openai/text-embedding-3-small",
          name: "Text Embedding 3 Small",
          context_length: 8_192
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const health = { recordHealth: vi.fn() };
    const adapter = createRuntimeProviderAdapter({
      database: database as never,
      credentialSecret: "credential-encryption-secret",
      transport: { fetch, validateSdkEndpoint: vi.fn(), close: vi.fn() },
      health
    });

    const inventory = await adapter.inventory.listModels({
      ownerUserId: "00000000-0000-4000-8000-000000000012",
      providerProfileId: row.id,
      providerRole: "embedding"
    });

    expect(inventory).toEqual({
      providerProfileId: row.id,
      providerRole: "embedding",
      models: [{
        id: "openai/text-embedding-3-small",
        name: "Text Embedding 3 Small",
        contextWindowTokens: 8_192
      }]
    });
    expect(health.recordHealth).toHaveBeenCalledWith(expect.objectContaining({ outcome: "healthy" }));
  });

  test("normalizes candidate inventory failures without exposing provider details", async () => {
    const transport = {
      fetch: vi.fn(async () => {
        throw new Error("upstream secret: bearer-token at https://private-provider.test/models");
      }),
      validateSdkEndpoint: vi.fn(),
      close: vi.fn()
    };
    const adapter = createRuntimeProviderAdapter({
      database: { query: vi.fn() } as never,
      credentialSecret: "credential-encryption-secret",
      transport,
      health: { recordHealth: vi.fn() }
    });
    const candidate = {
      ownerUserId: "00000000-0000-4000-8000-000000000021",
      name: "Candidate",
      providerType: "openai_compatible" as const,
      providerRole: "text" as const,
      baseUrl: "https://private-provider.test/v1",
      defaultModel: "story-model",
      contextWindowTokens: 16_384,
      maxOutputTokens: 2_048,
      temperature: 0.5,
      requestTimeoutMs: 60_000,
      configuration: toSafeProviderConfiguration({}),
      enabled: true,
      isDefault: false
    };

    for (const inventoryCall of [
      () => adapter.inventory.discoverCandidateModels(candidate),
      () => adapter.discoverCandidateModelsWithCredential(candidate, "bearer-token")
    ]) {
      await expect(inventoryCall()).rejects.toMatchObject({
        message: "Provider model inventory is unavailable.",
        statusCode: 502
      });
    }
  });

  test("resolves stored text plans and reduces explicit overrides to one model", async () => {
    const ownerUserId = "00000000-0000-4000-8000-000000000024";
    const row = {
      id: "00000000-0000-4000-8000-000000000025",
      name: "Preset routing profile",
      provider_type: "openrouter" as const,
      provider_role: "text" as const,
      base_url: "https://openrouter.ai/api/v1",
      default_model: "primary/model",
      fallback_models: ["fallback/a", "fallback/b"],
      routing_source: "openrouter_preset" as const,
      preset_slug: "story-router",
      preset_designated_version_id: "version-3",
      preset_version: 3,
      preset_config_hash: "c".repeat(64),
      preset_provider_policy: { allow_fallbacks: true },
      context_window_tokens: 32_768,
      max_output_tokens: 4_096,
      temperature: 0.8,
      request_timeout_ms: 60_000,
      configuration: {},
      encrypted_api_key: null,
      credential_nonce: null,
      credential_auth_tag: null,
      credential_key_version: null,
      enabled: true,
      is_default: true,
      health_status: "unknown" as const,
      consecutive_failures: 0,
      last_health_check_at: null,
      created_at: new Date("2026-08-22T00:00:00Z"),
      updated_at: new Date("2026-08-22T00:00:00Z")
    };
    const database = {
      query: vi.fn(async () => ({ rows: [row], rowCount: 1 }))
    };
    const resolution = createPostgresProviderRepositories(database as never).resolution;

    await expect(resolution.resolveDirect({ ownerUserId, providerRole: "text", selectedProviderProfileId: row.id }))
      .resolves.toMatchObject({
        status: "resolved",
        routingSource: "openrouter_preset",
        model: "primary/model",
        fallbackModels: ["fallback/a", "fallback/b"],
        preset: {
          slug: "story-router",
          designatedVersionId: "version-3",
          version: 3,
          configHash: "c".repeat(64)
        },
        providerPolicy: { allow_fallbacks: true }
      });
    await expect(resolution.resolveDirect({
      ownerUserId,
      providerRole: "text",
      selectedProviderProfileId: row.id,
      model: "explicit/model"
    })).resolves.toMatchObject({
      routingSource: "models",
      model: "explicit/model",
      fallbackModels: [],
      preset: null,
      providerPolicy: {}
    });
  });

  test("merges a legacy primary-only PATCH from the row locked at write time", async () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000026",
      name: "Concurrent models plan",
      provider_type: "openai_compatible" as const,
      provider_role: "text" as const,
      base_url: "https://provider.example/v1",
      default_model: "old-primary",
      fallback_models: ["concurrent-fallback"],
      routing_source: "models" as const,
      preset_slug: null,
      preset_designated_version_id: null,
      preset_version: null,
      preset_config_hash: null,
      preset_provider_policy: {},
      context_window_tokens: 32_768,
      max_output_tokens: 4_096,
      temperature: 0.8,
      request_timeout_ms: 60_000,
      configuration: {},
      encrypted_api_key: null,
      credential_nonce: null,
      credential_auth_tag: null,
      credential_key_version: null,
      enabled: true,
      is_default: false,
      health_status: "unknown" as const,
      consecutive_failures: 0,
      last_health_check_at: null,
      created_at: new Date("2026-08-22T00:00:00Z"),
      updated_at: new Date("2026-08-22T00:00:00Z")
    };
    const updates: unknown[][] = [];
    const database = {
      query: vi.fn(async (statement: string, parameters: unknown[] = []) => {
        if (statement.includes("FOR UPDATE")) return { rows: [row], rowCount: 1 };
        if (statement.includes("UPDATE provider_profiles SET name=$3")) {
          updates.push(parameters);
          return {
            rows: [{ ...row, default_model: parameters[4], fallback_models: parameters[5] }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      })
    };

    await createPostgresProviderRepositories(database as never).profiles.updateProfile({
      ownerUserId: "00000000-0000-4000-8000-000000000027",
      providerProfileId: row.id,
      changes: { defaultModel: "new-primary" }
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.[4]).toBe("new-primary");
    expect(updates[0]?.[5]).toEqual(["concurrent-fallback"]);
  });

  test("rejects a stale preset candidate revision before writing a locked newer profile", async () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000028",
      name: "Newer saved profile",
      provider_type: "openrouter" as const,
      provider_role: "text" as const,
      base_url: "https://newer-endpoint.example/v1",
      default_model: "newer-primary",
      fallback_models: [],
      routing_source: "models" as const,
      preset_slug: null,
      preset_designated_version_id: null,
      preset_version: null,
      preset_config_hash: null,
      preset_provider_policy: {},
      context_window_tokens: 32_768,
      max_output_tokens: 4_096,
      temperature: 0.8,
      request_timeout_ms: 60_000,
      configuration: {},
      encrypted_api_key: null,
      credential_nonce: null,
      credential_auth_tag: null,
      credential_key_version: null,
      enabled: true,
      is_default: false,
      health_status: "unknown" as const,
      consecutive_failures: 0,
      last_health_check_at: null,
      created_at: new Date("2026-08-22T00:00:00Z"),
      updated_at: new Date("2026-08-22T00:00:00Z"),
      row_revision: "newer-revision"
    };
    const updates: unknown[][] = [];
    const database = {
      query: vi.fn(async (statement: string, parameters: unknown[] = []) => {
        if (statement.includes("FOR UPDATE")) return { rows: [row], rowCount: 1 };
        if (statement.includes("UPDATE provider_profiles SET name=$3")) {
          updates.push(parameters);
          return { rows: [{ ...row, default_model: parameters[4] }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      })
    };

    await expect(createPostgresProviderRepositories(database as never).profiles.updateProfile({
      ownerUserId: "00000000-0000-4000-8000-000000000029",
      providerProfileId: row.id,
      changes: {
        expectedRevision: "revision-before-validation",
        routingSource: "openrouter_preset",
        defaultModel: "validated-against-stale-endpoint",
        fallbackModels: [],
        preset: {
          slug: "story-router",
          designatedVersionId: "version-5",
          version: 5,
          configHash: "f".repeat(64)
        },
        providerPolicy: { allow_fallbacks: true }
      } as never
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(updates).toEqual([]);
  });

  test("acquires the role advisory lock before row locks when an update selects a default", async () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000031",
      name: "Default candidate",
      provider_type: "openai_compatible",
      provider_role: "text",
      base_url: "https://provider.test/v1",
      default_model: "story-model",
      context_window_tokens: 16_384,
      max_output_tokens: 2_048,
      temperature: 0.5,
      request_timeout_ms: 60_000,
      configuration: {},
      encrypted_api_key: null,
      credential_nonce: null,
      credential_auth_tag: null,
      credential_key_version: null,
      enabled: true,
      is_default: false,
      health_status: "unknown",
      consecutive_failures: 0,
      last_health_check_at: null,
      created_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-01-01T00:00:00Z")
    };
    const statements: string[] = [];
    const database = {
      query: vi.fn(async (statement: string) => {
        statements.push(statement.replace(/\s+/g, " ").trim());
        if (/^SELECT provider_role /.test(statements.at(-1)!)) return { rows: [{ provider_role: "text" }] };
        if (/^SELECT id, xmin::text AS row_revision, name, provider_type/.test(statements.at(-1)!)) return { rows: [row] };
        if (/RETURNING id, xmin::text AS row_revision, name, provider_type/.test(statements.at(-1)!)) return { rows: [{ ...row, is_default: true }] };
        return { rows: [] };
      })
    };

    await createPostgresProviderRepositories(database as never).profiles.updateProfile({
      ownerUserId: "00000000-0000-4000-8000-000000000032",
      providerProfileId: row.id,
      changes: { isDefault: true }
    });

    expect(statements[0]).toMatch(/^SELECT provider_role .*WHERE id=\$1 AND owner_user_id=\$2$/);
    expect(statements[0]).not.toContain("FOR UPDATE");
    expect(statements[1]).toContain("pg_advisory_xact_lock");
    expect(statements[2]).toContain("FOR UPDATE");
  });

  test("preserves structured prompt examples and recalculates their token estimate", async () => {
    const prompts = createPromptRepository({ query: vi.fn() } as never);
    const preview = await prompts.previewPrompt({
      ownerUserId: "00000000-0000-4000-8000-000000000041",
      key: "rpg_assessment",
      content: PROMPT_TEMPLATE_CATALOG.rpg_assessment.defaultContent
    });
    const expectedInput = buildRpgAssessmentPrompt(
      {
        authoritativeRules: ["Moonlit gates open only for a spoken promise."],
        campaignState: { location: "Rainbridge", openThreads: ["Who sealed the eastern gate?"] }
      },
      "Mira attempts to open the sealed gate.",
      [{ id: "resolve", name: "Resolve", value: 63, note: "Courage under pressure." }]
    );

    expect(preview.sections.find((section) => section.role === "input")?.content).toBe(expectedInput);
    expect(preview.estimatedTokens).toBe(Math.max(
      1,
      Math.ceil(preview.sections.reduce((total, section) => total + section.content.length, 0) / 4)
    ));
  });
});
