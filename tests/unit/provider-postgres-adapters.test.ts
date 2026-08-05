import { describe, expect, test, vi } from "vitest";
import {
  createProviderCostRepository,
  createProviderCostTransactionContext
} from "../../packages/database/src/cost-repository.js";
import { validateProviderConfiguration } from "../../packages/database/src/provider-repository.js";
import { encryptCredential } from "../../packages/story-engine/src/credentials.js";
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
    await adapter.storeCredential("00000000-0000-4000-8000-000000000012", row.id, plaintext);

    expect(inventory.models).toEqual([{ id: "story-model", name: "Story Model", contextWindowTokens: 16_384 }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(health.recordHealth).toHaveBeenCalledWith(expect.objectContaining({ outcome: "healthy" }));
    const publicValues = JSON.stringify({ lease, inventory });
    expect(publicValues).not.toContain(plaintext);
    expect(publicValues).not.toContain(encrypted.ciphertext);
    expect(publicValues).not.toContain("stored-config-secret");
    expect(JSON.stringify(database.query.mock.calls)).not.toContain(plaintext);
  });
});
