import { describe, expect, it, vi } from "vitest";
import { callEmbeddingProvider, callImageProvider, callTextProvider, discoverEmbeddingModels, discoverImageModels, discoverModels, reportedProviderCost, type TextProviderProfile } from "../../packages/story-engine/src/providers.js";

const profile: TextProviderProfile = {
  providerType: "lmstudio",
  baseUrl: "http://lmstudio.test/v1",
  model: "loaded-instance-id",
  contextWindowTokens: 131072,
  maxOutputTokens: 4096,
  temperature: 0.8
};

describe("text provider adapters", () => {
  it("normalizes only explicit valid provider-reported costs", () => {
    expect(reportedProviderCost({ cost: 0.00001234 })).toEqual({ amount: "0.00001234", currency: "USD" });
    expect(reportedProviderCost({ cost: 0, currency: "usd" })).toEqual({ amount: "0", currency: "USD" });
    expect(reportedProviderCost({ prompt_tokens: 10 })).toBeNull();
    expect(reportedProviderCost({ cost: -1 })).toBeNull();
    expect(reportedProviderCost({ cost: "not-a-number" })).toBeNull();
    expect(reportedProviderCost({ cost: 1, currency: "credits" })).toBeNull();
  });

  it("pins LM Studio to the selected loaded instance without a context_length load override", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("loaded-instance-id");
      expect(body.context_length).toBeUndefined();
      expect(body.previous_response_id).toBeUndefined();
      return new Response(JSON.stringify({
        model_instance_id: "loaded-instance-id",
        response_id: "response-1",
        output: [{ type: "message", content: "{}" }],
        stats: { input_tokens: 100, total_output_tokens: 4 }
      }), { status: 200 });
    });
    await callTextProvider(profile, { systemPrompt: "system", input: "input" }, fetcher as typeof fetch);
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://lmstudio.test/api/v1/chat");
  });

  it("uses the advertised loaded context length and instance ID from model inventory", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      models: [{ key: "model-key", display_name: "Model Name", loaded_instances: [{ id: "instance-7", config: { context_length: 196608 } }] }]
    }), { status: 200 }));
    const models = await discoverModels(profile, fetcher as typeof fetch);
    expect(models).toEqual([{ id: "model-key", displayName: "Model Name", loaded: true, instanceId: "instance-7", contextLength: 196608 }]);
  });

  it("returns inactive models alongside loaded instances", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      models: [
        { key: "active-model", display_name: "Active Model", loaded_instances: [{ id: "active-instance", config: { context_length: 65536 } }] },
        { key: "inactive-model", display_name: "Inactive Model", max_context_length: 32768 }
      ]
    }), { status: 200 }));
    const models = await discoverModels(profile, fetcher as typeof fetch);
    expect(models).toEqual([
      { id: "active-model", displayName: "Active Model", loaded: true, instanceId: "active-instance", contextLength: 65536 },
      { id: "inactive-model", displayName: "Inactive Model", loaded: false, instanceId: "inactive-model", contextLength: 32768 }
    ]);
  });

  it("detects LM Studio output exhaustion even when only token usage signals it", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      response_id: "partial",
      output: [{ type: "message", content: "{\"narration\":\"partial" }],
      stats: { input_tokens: 200, total_output_tokens: 4096 }
    }), { status: 200 }));
    const result = await callTextProvider(profile, { systemPrompt: "system", input: "input" }, fetcher as typeof fetch);
    expect(result.outputLimited).toBe(true);
    expect(result.responseId).toBe("partial");
    expect(result.reportedCost).toBeNull();
  });

  it("resends the authoritative snapshot when LM Studio recovery has no response chain", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.previous_response_id).toBeUndefined();
      expect(body.input).toContain("authoritative snapshot");
      expect(body.input).toContain("RECOVERY REQUIREMENT");
      return new Response(JSON.stringify({ output: [{ type: "message", content: "{}" }], stats: {} }), { status: 200 });
    });
    await callTextProvider(profile, {
      systemPrompt: "system",
      input: "authoritative snapshot",
      recoveryInput: "return compact JSON"
    }, fetcher as typeof fetch);
  });

  it("uses the OpenAI-compatible embeddings endpoint and preserves input order", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://lmstudio.test/v1/embeddings");
      expect(JSON.parse(String(init?.body))).toEqual({ model: "loaded-instance-id", input: ["first", "second"] });
      return new Response(JSON.stringify({
        model: "embedding-model",
        data: [
          { index: 1, embedding: [0, 1, 0] },
          { index: 0, embedding: [1, 0, 0] }
        ],
        id: "embedding-response-1",
        usage: { prompt_tokens: 4, total_tokens: 4, cost: 0.000004 }
      }), { status: 200 });
    });
    const result = await callEmbeddingProvider(profile, ["first", "second"], fetcher as typeof fetch);
    expect(result.embeddings).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(result.model).toBe("embedding-model");
    expect(result.responseId).toBe("embedding-response-1");
    expect(result.reportedCost).toEqual({ amount: "0.000004", currency: "USD" });
  });

  it("rejects inconsistent embedding dimensions", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1, 0] }]
    }), { status: 200 }));
    await expect(callEmbeddingProvider(profile, ["first", "second"], fetcher as typeof fetch))
      .rejects.toThrow("inconsistent dimensions");
  });

  it("uses an independent OpenAI-compatible image endpoint and requires persisted base64 output", async () => {
    const imageProfile = { ...profile, providerType: "openai_compatible" as const, baseUrl: "http://images.test" };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://images.test/v1/images/generations");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "loaded-instance-id",
        prompt: "Synthetic fictional panorama.",
        n: 1,
        size: "1024x1024",
        quality: "high",
        output_format: "png",
        response_format: "b64_json"
      });
      return new Response(JSON.stringify({ id: "image-1", data: [{ b64_json: "aW1hZ2U=" }], usage: { cost: 0.04 } }), { status: 200 });
    });
    const result = await callImageProvider(imageProfile, {
      prompt: "Synthetic fictional panorama.",
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "high",
      outputFormat: "png"
    }, fetcher as typeof fetch);
    expect(result).toMatchObject({ base64: "aW1hZ2U=", mimeType: "image/png", responseId: "image-1" });
    expect(result.reportedCost).toEqual({ amount: "0.04", currency: "USD" });
  });

  it("uses OpenRouter's dedicated image-model inventory", async () => {
    const imageProfile = { ...profile, providerType: "openrouter" as const, baseUrl: "https://openrouter.ai/api/v1" };
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/images/models");
      return new Response(JSON.stringify({ data: [{ id: "synthetic/image-model", name: "Synthetic Image Model" }] }), { status: 200 });
    });
    expect(await discoverImageModels(imageProfile, fetcher as typeof fetch)).toEqual([{
      id: "synthetic/image-model",
      displayName: "Synthetic Image Model",
      loaded: true,
      instanceId: "synthetic/image-model",
      contextLength: 0
    }]);
  });

  it("filters LM Studio image inventories using advertised output modalities", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      models: [
        { key: "text-model", display_name: "Text Model", architecture: { output_modalities: ["text"] } },
        { key: "image-model", display_name: "Image Model", architecture: { output_modalities: ["image"] } },
        { key: "embedding-model", display_name: "Embedding Model", capabilities: { outputs: ["embeddings"] } }
      ]
    }), { status: 200 }));
    expect(await discoverImageModels(profile, fetcher as typeof fetch)).toEqual([{
      id: "image-model",
      displayName: "Image Model",
      loaded: false,
      instanceId: "image-model",
      contextLength: 0
    }]);
  });

  it("recognizes image model families when a compatible endpoint omits modality metadata", async () => {
    const imageProfile = { ...profile, providerType: "openai_compatible" as const, baseUrl: "http://images.test" };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "vendor/chat-model" },
        { id: "vendor/flux-image-v2" },
        { id: "vendor/text-embedding-model" }
      ]
    }), { status: 200 }));
    expect(await discoverImageModels(imageProfile, fetcher as typeof fetch)).toEqual([{
      id: "vendor/flux-image-v2",
      displayName: "vendor/flux-image-v2",
      loaded: false,
      instanceId: "vendor/flux-image-v2",
      contextLength: 0
    }]);
  });

  it("preserves opaque compatible inventories when the endpoint exposes no capability signal", async () => {
    const imageProfile = { ...profile, providerType: "openai_compatible" as const, baseUrl: "http://images.test" };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "vendor/custom-renderer" }] }), { status: 200 }));
    expect(await discoverImageModels(imageProfile, fetcher as typeof fetch)).toHaveLength(1);
  });

  it("uses OpenRouter's dedicated embedding-model inventory", async () => {
    const embeddingProfile = { ...profile, providerType: "openrouter" as const, baseUrl: "https://openrouter.ai/api/v1" };
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/embeddings/models");
      return new Response(JSON.stringify({
        data: [{
          id: "openai/text-embedding-3-small",
          name: "Text Embedding 3 Small",
          context_length: 8192,
          architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] }
        }]
      }), { status: 200 });
    });
    expect(await discoverEmbeddingModels(embeddingProfile, fetcher as typeof fetch)).toEqual([{
      id: "openai/text-embedding-3-small",
      displayName: "Text Embedding 3 Small",
      loaded: true,
      instanceId: "openai/text-embedding-3-small",
      contextLength: 8192
    }]);
  });
});
