import { describe, expect, it, vi } from "vitest";
import { providerProfileInputSchema } from "../../packages/contracts/src/generation.js";
import type { ProviderResolutionRequest } from "../../packages/application/src/providers/index.js";
import { createProviderTransport } from "../../packages/story-engine/src/index.js";
import { createTurnIntentClassificationAdapter } from "../../services/runtime/src/provider-turn-intent-adapter.js";
import { createRuntimeProviderAdapter } from "../../services/runtime/src/provider-credential-transport-adapter.js";

describe("turn intent provider role", () => {
  it("accepts an independently configured intent profile", () => {
    const profile = providerProfileInputSchema.parse({
      name: "Small classifier",
      providerType: "lmstudio",
      providerRole: "intent",
      baseUrl: "http://classifier.test",
      defaultModel: "small-model",
      contextWindowTokens: 8192,
      maxOutputTokens: 256,
      temperature: 0
    });
    expect(profile.providerRole).toBe("intent");
  });

  it("requires intent resolution to name the intent role explicitly", () => {
    const request: ProviderResolutionRequest<"intent"> = {
      ownerUserId: "owner-1",
      providerRole: "intent",
    };
    expect(request).toEqual({ ownerUserId: "owner-1", providerRole: "intent" });
  });

  it("passes the complete intent model plan to shared text execution before deterministic fallback", async () => {
    const resolution = {
      status: "resolved" as const,
      requestedRole: "intent" as const,
      resolvedRole: "intent" as const,
      providerProfileId: "intent-profile",
      providerType: "openai_compatible" as const,
      routingSource: "models" as const,
      model: "intent-primary",
      fallbackModels: ["intent-fallback"],
      preset: null,
      providerPolicy: {}
    };
    const databaseQuery = vi.fn(async (statement: string) => {
      if (statement.startsWith("DELETE")) return { rows: [], rowCount: 0 };
      if (statement.startsWith("SELECT turn_control_style")) {
        return { rows: [{ turn_control_style: "flexible_auto" }], rowCount: 1 };
      }
      if (statement.startsWith("INSERT INTO turn_input_classifications")) {
        return { rows: [{ id: "classification-id", expires_at: "2026-08-22T16:00:00.000Z" }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    const transactionQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const execution = { text: vi.fn(async () => ({
      id: "intent-profile",
      providerType: "openai_compatible" as const,
      model: "intent-primary",
      maxOutputTokens: 256,
      execute: vi.fn(async () => ({
        content: JSON.stringify({ classification: "scene", confidence: 0.9 }),
        outputLimited: false,
        responseId: "intent-response",
        usage: {},
        reportedCost: null
      }))
    })) };
    const adapter = createTurnIntentClassificationAdapter({
      pool: {
        query: databaseQuery,
        connect: vi.fn(async () => ({ query: transactionQuery, release: vi.fn() }))
      } as never,
      resolution: { resolveDirect: vi.fn(async () => resolution) } as never,
      runtime: { execution } as never,
      prompts: { loadPromptSnapshot: vi.fn(async () => ({
        snapshot: { turn_intent: { content: "Classify the turn." } }
      })) } as never,
      costs: { recordCost: vi.fn(async () => "cost-id") } as never,
      health: { recordHealth: vi.fn(async () => undefined) } as never
    });

    await expect(adapter.classifyTurnIntent({
      ownerUserId: "owner-1",
      campaignId: "campaign-1",
      text: "The tower is already burning."
    })).resolves.toMatchObject({ providerSource: "intent_default", resolvedMode: "scene" });

    expect(execution.text).toHaveBeenCalledWith({ ownerUserId: "owner-1" }, resolution);
  });

  it("exhausts the shared sequential intent plan before using the deterministic campaign fallback", async () => {
    const resolution = {
      status: "resolved" as const,
      requestedRole: "intent" as const,
      resolvedRole: "intent" as const,
      providerProfileId: "intent-profile",
      providerType: "openai_compatible" as const,
      routingSource: "models" as const,
      model: "intent-primary",
      fallbackModels: ["intent-fallback"],
      preset: null,
      providerPolicy: {}
    };
    const providerRow = {
      id: "intent-profile",
      name: "Intent provider",
      provider_type: "openai_compatible",
      provider_role: "intent",
      base_url: "https://intent.test/v1",
      default_model: "intent-primary",
      fallback_models: ["intent-fallback"],
      routing_source: "models",
      preset_slug: null,
      preset_designated_version_id: null,
      preset_version: null,
      preset_config_hash: null,
      preset_provider_policy: {},
      context_window_tokens: 8_192,
      max_output_tokens: 256,
      temperature: 0,
      request_timeout_ms: 5_000,
      configuration: {},
      encrypted_api_key: null,
      credential_nonce: null,
      credential_auth_tag: null,
      credential_key_version: null,
      enabled: true,
      is_default: true,
      health_status: "healthy",
      consecutive_failures: 0,
      last_health_check_at: null,
      created_at: new Date("2026-08-22T16:00:00.000Z"),
      updated_at: new Date("2026-08-22T16:00:00.000Z")
    };
    const databaseQuery = vi.fn(async (statement: string) => {
      if (statement.startsWith("DELETE")) return { rows: [], rowCount: 0 };
      if (statement.startsWith("SELECT turn_control_style")) {
        return { rows: [{ turn_control_style: "flexible_action" }], rowCount: 1 };
      }
      if (statement.includes("FROM provider_profiles")) return { rows: [providerRow], rowCount: 1 };
      if (statement.startsWith("INSERT INTO turn_input_classifications")) {
        return { rows: [{ id: "classification-id", expires_at: "2026-08-22T16:00:00.000Z" }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    const requestedModels: string[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestedModels.push(JSON.parse(String(init?.body)).model);
      return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 });
    });
    const transport = createProviderTransport({
      fetcher,
      dispatcherFactory: () => ({ dispatch: vi.fn(), close: vi.fn(), destroy: vi.fn() }) as never,
      policy: { approve: async (url) => ({ url, origin: url.origin, address: "127.0.0.1", family: 4, port: 443, servername: url.hostname }) }
    });
    const health = { recordHealth: vi.fn(async () => undefined) };
    const runtime = createRuntimeProviderAdapter({
      database: { query: databaseQuery } as never,
      credentialSecret: "credential-encryption-secret",
      transport,
      health
    });
    const adapter = createTurnIntentClassificationAdapter({
      pool: { query: databaseQuery } as never,
      resolution: { resolveDirect: vi.fn(async () => resolution) } as never,
      runtime,
      prompts: { loadPromptSnapshot: vi.fn(async () => ({
        snapshot: { turn_intent: { content: "Classify the turn." } }
      })) } as never,
      costs: { recordCost: vi.fn(async () => "cost-id") } as never,
      health
    });

    await expect(adapter.classifyTurnIntent({
      ownerUserId: "owner-1",
      campaignId: "campaign-1",
      text: "The tower is already burning."
    })).resolves.toMatchObject({ providerSource: "campaign_fallback", resolvedMode: "action" });

    expect(requestedModels).toEqual(["intent-primary", "intent-fallback"]);
    expect(health.recordHealth).toHaveBeenCalledWith(expect.objectContaining({
      providerProfileId: "intent-profile",
      outcome: "failed"
    }));
  });
});
