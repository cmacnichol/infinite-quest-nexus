import { describe, expect, it, vi } from "vitest";
import { callEmbeddingProvider, callTextProvider, discoverModels, type TextProviderProfile } from "../../packages/story-engine/src/providers.js";

const profile: TextProviderProfile = {
  providerType: "lmstudio",
  baseUrl: "http://lmstudio.test/v1",
  model: "loaded-instance-id",
  contextWindowTokens: 131072,
  maxOutputTokens: 4096,
  temperature: 0.8
};

describe("text provider adapters", () => {
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

  it("detects LM Studio output exhaustion even when only token usage signals it", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      response_id: "partial",
      output: [{ type: "message", content: "{\"narration\":\"partial" }],
      stats: { input_tokens: 200, total_output_tokens: 4096 }
    }), { status: 200 }));
    const result = await callTextProvider(profile, { systemPrompt: "system", input: "input" }, fetcher as typeof fetch);
    expect(result.outputLimited).toBe(true);
    expect(result.responseId).toBe("partial");
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
        usage: { prompt_tokens: 4, total_tokens: 4 }
      }), { status: 200 });
    });
    const result = await callEmbeddingProvider(profile, ["first", "second"], fetcher as typeof fetch);
    expect(result.embeddings).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(result.model).toBe("embedding-model");
  });

  it("rejects inconsistent embedding dimensions", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1, 0] }]
    }), { status: 200 }));
    await expect(callEmbeddingProvider(profile, ["first", "second"], fetcher as typeof fetch))
      .rejects.toThrow("inconsistent dimensions");
  });
});
