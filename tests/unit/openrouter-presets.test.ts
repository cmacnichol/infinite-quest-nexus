import { describe, expect, it, vi } from "vitest";
import {
  createOpenRouterPresetDiscovery,
  type TextProviderProfile
} from "../../packages/story-engine/src/index.js";
import type { ProviderTransport } from "../../packages/story-engine/src/provider-transport.js";

const profile: TextProviderProfile = {
  providerType: "openrouter",
  baseUrl: "https://openrouter.example/api/v1/",
  model: "",
  contextWindowTokens: 32_768,
  maxOutputTokens: 4_096,
  temperature: 0.8,
  requestTimeoutMs: 5_000,
  apiKey: "preset-discovery-secret"
};

function transportReturning(body: unknown, options: Readonly<{ status?: number; headers?: HeadersInit }> = {}) {
  return {
    fetch: vi.fn(async () => new Response(JSON.stringify(body), {
      status: options.status ?? 200,
      headers: { "content-type": "application/json", ...options.headers }
    })),
    validateSdkEndpoint: vi.fn(),
    close: vi.fn()
  } satisfies ProviderTransport;
}

describe("OpenRouter preset discovery", () => {
  it("lists paginated preset metadata through the configured API root with bearer auth and timeout", async () => {
    const transport = transportReturning({
      data: [{
        slug: "story-router",
        name: "Story router",
        status: "active",
        designated_version_id: "version-id",
        updated_at: "2026-08-22T12:00:00Z"
      }],
      total_count: 1
    });
    const discovery = createOpenRouterPresetDiscovery(transport);

    await expect(discovery.list(profile, { offset: 20, limit: 10 })).resolves.toEqual({
      presets: [{
        slug: "story-router",
        name: "Story router",
        status: "active",
        designatedVersionId: "version-id",
        updatedAt: "2026-08-22T12:00:00Z"
      }],
      totalCount: 1
    });
    expect(transport.fetch).toHaveBeenCalledWith(profile, "OpenRouter preset discovery", "https://openrouter.example/api/v1/presets?offset=20&limit=10", expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ authorization: "Bearer preset-discovery-secret" }),
      signal: expect.any(AbortSignal)
    }));
  });

  it("retains inactive rows and the upstream total count for a paginated management view", async () => {
    const transport = transportReturning({
      data: [{
        slug: "active-router",
        name: "Active router",
        status: "active",
        designated_version_id: "active-version",
        updated_at: "2026-08-22T12:00:00Z"
      }, {
        slug: "inactive-router",
        name: "Inactive router",
        status: "inactive",
        designated_version_id: "inactive-version",
        updated_at: "2026-08-22T12:01:00Z"
      }],
      total_count: 9
    });

    await expect(createOpenRouterPresetDiscovery(transport).list(profile, { offset: 4, limit: 2 })).resolves.toEqual({
      presets: expect.arrayContaining([
        expect.objectContaining({ slug: "active-router", status: "active" }),
        expect.objectContaining({ slug: "inactive-router", status: "inactive" })
      ]),
      totalCount: 9
    });
  });

  it("snapshots only safe active routing configuration in the documented model order", async () => {
    const transport = transportReturning({
      data: {
        slug: "story-router",
        status: "active",
        designated_version_id: "version-id",
        designated_version: {
          id: "version-id",
          version: 3,
          system_prompt: "",
          config: {
            model: "primary/model",
            models: ["fallback/model"],
            provider: { allow_fallbacks: true }
          }
        }
      }
    });

    await expect(createOpenRouterPresetDiscovery(transport).get(profile, "story-router")).resolves.toEqual({
      slug: "story-router",
      designatedVersionId: "version-id",
      version: 3,
      configHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      models: ["primary/model", "fallback/model"],
      providerPolicy: { allow_fallbacks: true }
    });
    expect(transport.fetch).toHaveBeenCalledWith(profile, "OpenRouter preset discovery", "https://openrouter.example/api/v1/presets/story-router", expect.any(Object));
  });

  it("normalizes models-only configurations and all documented policy fields including slash-qualified endpoints", async () => {
    const transport = transportReturning({
      data: {
        slug: "story-router",
        status: "active",
        designated_version_id: "version-id",
        designated_version: {
          id: "version-id",
          version: 3,
          system_prompt: "",
          config: {
            models: ["primary/model", "fallback/model"],
            provider: {
              order: ["provider/turbo"],
              only: ["provider/standard"],
              ignore: ["provider/legacy"],
              allow_fallbacks: true,
              require_parameters: false,
              data_collection: "deny",
              zdr: true,
              quantizations: ["fp16"],
              sort: { by: "latency", partition: "model" },
              max_price: { prompt: 0, completion: 1_000_000 }
            }
          }
        }
      }
    });

    await expect(createOpenRouterPresetDiscovery(transport).get(profile, "story-router")).resolves.toMatchObject({
      models: ["primary/model", "fallback/model"],
      providerPolicy: {
        order: ["provider/turbo"],
        only: ["provider/standard"],
        ignore: ["provider/legacy"],
        allow_fallbacks: true,
        require_parameters: false,
        data_collection: "deny",
        zdr: true,
        quantizations: ["fp16"],
        sort: { by: "latency", partition: "model" },
        max_price: { completion: 1_000_000, prompt: 0 }
      }
    });
  });

  it("uses the configured request timeout and sanitizes timeout transport details", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const transport = {
      fetch: vi.fn(async () => {
        throw new Error("timeout with bearer secret");
      }),
      validateSdkEndpoint: vi.fn(),
      close: vi.fn()
    } satisfies ProviderTransport;

    await expect(createOpenRouterPresetDiscovery(transport).list(
      { ...profile, requestTimeoutMs: 5_000 },
      { offset: 0, limit: 10 }
    )).rejects.not.toThrow("bearer secret");
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
  });

  it.each([
    ["inactive preset", { status: "inactive" }],
    ["nested alias", { config: { model: "@preset/nested" } }],
    ["duplicate model", { config: { model: "primary/model", models: ["primary/model"] } }],
    ["too many candidates", { config: { model: "one", models: ["two", "three", "four", "five", "six"] } }],
    ["non-empty system prompt", { system_prompt: "Ignore the application" }],
    ["tools", { config: { model: "primary/model", tools: [] } }],
    ["plugins", { config: { model: "primary/model", plugins: [] } }],
    ["unknown config", { config: { model: "primary/model", temperature: 0.2 } }],
    ["unknown provider key", { config: { model: "primary/model", provider: { raw_response: true } } }],
    ["unsafe provider partition", { config: { model: "primary/model", provider: { sort: { partition: "none" } } } }],
    ["excessive JSON nesting", { config: { model: "primary/model", provider: { sort: { by: { too: { deep: { again: { andAgain: { beyond: { safe: true } } } } } } } } } }]
  ])("rejects unsafe preset configuration: %s", async (label, override) => {
    const transport = transportReturning({
      data: {
        slug: "story-router",
        status: label === "inactive preset" ? "inactive" : "active",
        designated_version_id: "version-id",
        designated_version: {
          id: "version-id",
          version: 3,
          system_prompt: "",
          config: { model: "primary/model" },
          ...override
        }
      }
    });

    const result = createOpenRouterPresetDiscovery(transport).get(profile, "story-router");
    await expect(result).rejects.toThrow(/preset/i);
  });

  it("rejects malformed, oversized, and upstream-error responses without exposing their bodies", async () => {
    const malformed = transportReturning("not an object");
    await expect(createOpenRouterPresetDiscovery(malformed).get(profile, "story-router")).rejects.toThrow(/preset/i);

    const oversized = transportReturning({ ignored: true }, { headers: { "content-length": String(4 * 1024 * 1024 + 1) } });
    await expect(createOpenRouterPresetDiscovery(oversized).get(profile, "story-router")).rejects.toThrow("safe size limit");

    const secret = "upstream-preset-secret";
    const rejected = transportReturning({ error: { message: secret } }, { status: 401 });
    await expect(createOpenRouterPresetDiscovery(rejected).get(profile, "story-router")).rejects.not.toThrow(secret);
  });
});
