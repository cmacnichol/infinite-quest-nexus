import { afterEach, describe, expect, it, vi } from "vitest";
import { providerProfileInputSchema } from "../../packages/contracts/src/generation.js";
import {
  callEmbeddingProvider,
  callImageProvider,
  callTextProvider,
  cancelImageProvider,
  discoverEmbeddingModels,
  discoverImageModels,
  discoverModels,
  pollImageProvider,
  providerTransportErrorDetails,
  reportedProviderCost,
  submitImageProvider,
  type TextProviderProfile
} from "../../packages/story-engine/src/providers.js";
import { logger } from "../../packages/logger/src/index.js";

const profile: TextProviderProfile = {
  providerType: "lmstudio",
  baseUrl: "http://lmstudio.test/v1",
  model: "loaded-instance-id",
  contextWindowTokens: 131072,
  maxOutputTokens: 4096,
  temperature: 0.8
};

afterEach(() => vi.restoreAllMocks());

describe("text provider adapters", () => {
  it("defaults provider request deadlines to five minutes", () => {
    const parsed = providerProfileInputSchema.parse({
      name: "Synthetic provider",
      providerType: "lmstudio",
      providerRole: "text",
      baseUrl: "http://lmstudio.test",
      defaultModel: "synthetic-model"
    });
    expect(parsed.requestTimeoutMs).toBe(300_000);
  });

  it("normalizes header timeouts into explicit safe transport diagnostics", async () => {
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const timeoutProfile = { ...profile, requestTimeoutMs: 420_000, apiKey: "synthetic-secret-token" };
    const fetcher = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("Headers Timeout Error Bearer synthetic-secret-token"), { code: "UND_ERR_HEADERS_TIMEOUT" }) });
    });
    let thrown: unknown;
    try {
      await callTextProvider(timeoutProfile, { systemPrompt: "secret prompt", input: "private action" }, fetcher as typeof fetch);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("timed out after 7 minutes");
    expect(providerTransportErrorDetails(thrown)).toMatchObject({
      timedOut: true,
      timeoutMs: 420_000,
      transportCode: "UND_ERR_HEADERS_TIMEOUT",
      endpoint: "http://lmstudio.test/api/v1/chat"
    });
    const logged = JSON.stringify(loggerError.mock.calls);
    expect(logged).toContain('"event":"provider_transport_error"');
    expect(logged).not.toContain("secret prompt");
    expect(logged).not.toContain("private action");
    expect(logged).not.toContain("synthetic-secret-token");
    loggerError.mockRestore();
  });

  it("attaches an abort deadline and configurable dispatcher to outbound requests", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect((init as RequestInit & { dispatcher?: unknown })?.dispatcher).toBeDefined();
      return new Response(JSON.stringify({ output: [{ type: "message", content: "{}" }], stats: {} }), { status: 200 });
    });
    await callTextProvider({ ...profile, requestTimeoutMs: 600_000 }, { systemPrompt: "system", input: "input" }, fetcher as typeof fetch);
  });

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
      const urlString = String(_url);
      if (urlString.endsWith("/api/v1/models")) {
        return new Response(JSON.stringify({
          models: [{ key: "loaded-instance-id", loaded_instances: [{ id: "loaded-instance-id" }] }]
        }), { status: 200 });
      }
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
    expect(fetcher.mock.calls.find((call) => String(call[0]).endsWith("/api/v1/chat"))?.[0]).toBe("http://lmstudio.test/api/v1/chat");
  });

  it("attempts to load the LM Studio campaign provider if it is available from the model list but not currently loaded", async () => {
    const unloadedProfile: TextProviderProfile = {
      ...profile,
      model: "qwen2.5-7b-instruct"
    };
    const calls: string[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const urlString = String(_url);
      calls.push(`${init?.method || "GET"} ${urlString}`);
      if (urlString.endsWith("/api/v1/models") && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({
          models: [{
            key: "qwen2.5-7b-instruct",
            display_name: "Qwen 2.5 7B",
            loaded_instances: []
          }]
        }), { status: 200 });
      }
      if (urlString.endsWith("/api/v1/models/load") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body.model).toBe("qwen2.5-7b-instruct");
        return new Response(JSON.stringify({
          instance_id: "qwen2.5-7b-instruct",
          config: { context_length: 32768 }
        }), { status: 200 });
      }
      if (urlString.endsWith("/api/v1/chat") && init?.method === "POST") {
        return new Response(JSON.stringify({
          model_instance_id: "qwen2.5-7b-instruct",
          response_id: "resp-load-1",
          output: [{ type: "message", content: '{"narration":"Successfully loaded and generated."}' }],
          stats: { input_tokens: 50, total_output_tokens: 20 }
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${init?.method || "GET"} ${urlString}`);
    });
    const result = await callTextProvider(unloadedProfile, { systemPrompt: "system", input: "input" }, fetcher as typeof fetch);
    expect(result.content).toBe('{"narration":"Successfully loaded and generated."}');
    expect(calls).toEqual([
      "GET http://lmstudio.test/api/v1/models",
      "POST http://lmstudio.test/api/v1/models/load",
      "POST http://lmstudio.test/api/v1/chat"
    ]);
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

  it("includes the rejected response in stateless OpenRouter recovery", async () => {
    const openRouterProfile: TextProviderProfile = {
      ...profile,
      providerType: "openrouter",
      baseUrl: "https://openrouter.test/api/v1"
    };
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages).toEqual([
        { role: "system", content: "system" },
        { role: "user", content: "authoritative snapshot" },
        { role: "assistant", content: '{"narration":"She rolls a 17."}' },
        { role: "user", content: "rewrite the rejected response" }
      ]);
      return new Response(JSON.stringify({
        id: "recovery-response",
        choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        usage: {}
      }), { status: 200 });
    });
    await callTextProvider(openRouterProfile, {
      systemPrompt: "system",
      input: "authoritative snapshot",
      recoveryInput: "rewrite the rejected response",
      rejectedResponse: '{"narration":"She rolls a 17."}'
    }, fetcher as typeof fetch);
  });

  it("uses the OpenAI-compatible embeddings endpoint and preserves input order", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlString = String(url);
      if (urlString.endsWith("/api/v1/models")) {
        return new Response(JSON.stringify({
          models: [{ key: "loaded-instance-id", loaded_instances: [{ id: "loaded-instance-id" }] }]
        }), { status: 200 });
      }
      expect(urlString).toBe("http://lmstudio.test/v1/embeddings");
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
      if (String(url) === "https://openrouter.ai/api/v1/images/models") {
        return new Response(JSON.stringify({ data: [
          {
            id: "synthetic/image-model",
            name: "Synthetic Image Model",
            architecture: { output_modalities: ["image"] },
            endpoints: "/api/v1/images/models/synthetic/image-model/endpoints"
          },
          { id: "synthetic/text-model", name: "Synthetic Text Model", architecture: { output_modalities: ["text"] } }
        ] }), { status: 200 });
      }
      expect(String(url)).toBe("https://openrouter.ai/api/v1/images/models/synthetic/image-model/endpoints");
      return new Response(JSON.stringify({ endpoints: [{
        provider_name: "Synthetic Images",
        pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }]
      }] }), { status: 200 });
    });
    expect(await discoverImageModels(imageProfile, fetcher as typeof fetch)).toEqual([{
      id: "synthetic/image-model",
      displayName: "Synthetic Image Model",
      loaded: true,
      instanceId: "synthetic/image-model",
      contextLength: 0,
      pricing: {
        category: "image",
        entries: [{ billable: "output_image", unit: "image", costUsd: 0.04, provider: "Synthetic Images" }]
      }
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

  it("handles unparseable JSON in a failed provider response", async () => {
    const fetcher = vi.fn(async () => {
      return new Response("Internal Server Error - Invalid JSON [", {
        status: 500,
        statusText: "Internal Server Error"
      });
    });

    let thrownError: unknown;
    try {
      await callTextProvider(profile, { systemPrompt: "system", input: "input" }, fetcher as typeof fetch);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toContain("Internal Server Error - Invalid JSON [");
    expect((thrownError as any).statusCode).toBe(500);
  });

  it("sets stream: true when onChunk callback is supplied to callTextProvider", async () => {
    const streamChunks: string[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(true);
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n'));
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });
    const openAiProfile: TextProviderProfile = {
      ...profile,
      providerType: "openai_compatible",
      baseUrl: "https://api.openai.com/v1"
    };
    const result = await callTextProvider(openAiProfile, {
      systemPrompt: "system",
      input: "input",
      onChunk: (_delta, accumulated) => { streamChunks.push(accumulated); }
    }, fetcher as typeof fetch);
    expect(streamChunks).toEqual(["Hello", "Hello world"]);
    expect(result.content).toBe("Hello world");
  });

  it("submits a durable Sogni workflow with bearer auth and an idempotency key", async () => {
    const sogniProfile: TextProviderProfile = {
      ...profile,
      providerType: "sogni",
      baseUrl: "https://api.sogni.ai/v1",
      model: "flux2",
      apiKey: "sogni-secret",
      configuration: { tokenType: "auto", pollIntervalMs: 3_000 }
    };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.sogni.ai/v1/creative-agent/workflows");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sogni-secret");
      expect(new Headers(init?.headers).get("idempotency-key")).toBe("illustration-job-1:revision-1");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        token_type: "auto",
        app_source: "infinite-quest-nexus",
        confirm_cost: true,
        input: {
          steps: [
            { id: "image1", toolName: "generate_image", arguments: { prompt: "A fictional moonlit citadel.", model: "flux2" } },
            { id: "image2", toolName: "generate_image", arguments: { prompt: "A fictional moonlit citadel.", model: "flux2" } }
          ]
        }
      });
      return new Response(JSON.stringify({ status: "success", data: { workflow: { workflowId: "wf_test-1", status: "queued" } } }), { status: 201 });
    });
    await expect(submitImageProvider(sogniProfile, {
      prompt: "A fictional moonlit citadel.",
      size: "1280x720",
      aspectRatio: "16:9",
      quality: "high",
      outputFormat: "png",
      imageCount: 2,
      idempotencyKey: "illustration-job-1:revision-1"
    }, fetcher as typeof fetch)).resolves.toEqual({
      mode: "pending",
      remoteJobId: "wf_test-1",
      pollAfterMs: 3_000,
      providerMetadata: { status: "queued" }
    });
  });

  it("polls and cancels Sogni workflows without forwarding credentials to artifact URLs", async () => {
    const sogniProfile: TextProviderProfile = {
      ...profile,
      providerType: "sogni",
      baseUrl: "https://api.sogni.ai",
      model: "flux2",
      apiKey: "sogni-secret"
    };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/cancel")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ status: "success" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: "success",
        data: {
          workflow: {
            workflowId: "wf_test-1",
            status: "completed",
            steps: [{ artifacts: [{ url: "https://artifacts.sogni.ai/signed/image.png", mimeType: "image/png" }] }],
            usage: { cost: 0.25, currency: "USD" }
          }
        }
      }), { status: 200 });
    });
    await expect(pollImageProvider(sogniProfile, { remoteJobId: "wf_test-1" }, fetcher as typeof fetch)).resolves.toMatchObject({
      status: "completed",
      artifacts: [{ source: "url", url: "https://artifacts.sogni.ai/signed/image.png", mimeType: "image/png" }],
      reportedCost: { amount: "0.25", currency: "USD" }
    });
    await expect(cancelImageProvider(sogniProfile, { remoteJobId: "wf_test-1" }, fetcher as typeof fetch)).resolves.toBeUndefined();
  });

  it("normalizes Sogni rate limits and honors Retry-After", async () => {
    const sogniProfile: TextProviderProfile = {
      ...profile,
      providerType: "sogni",
      baseUrl: "https://api.sogni.ai",
      model: "flux2",
      apiKey: "sogni-secret"
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: "error", errorCode: 209, message: "Slow down" }), {
      status: 429,
      headers: { "retry-after": "4" }
    }));
    await expect(submitImageProvider(sogniProfile, {
      prompt: "A fictional vista.",
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "auto",
      outputFormat: "png",
      idempotencyKey: "illustration-job-2:revision-1"
    }, fetcher as typeof fetch)).rejects.toMatchObject({
      normalized: { code: "rate_limited:209", retryable: true, statusCode: 429, retryAfterMs: 4_000 }
    });
  });

  it("filters Sogni inventories when image capability signals are available", async () => {
    const sogniProfile: TextProviderProfile = {
      ...profile,
      providerType: "sogni",
      baseUrl: "https://api.sogni.ai",
      model: "flux2",
      apiKey: "sogni-secret"
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: "qwen-chat", capabilities: { output_modalities: ["text"] } },
      { id: "flux2", capabilities: { output_modalities: ["image"] } },
      { id: "vendor/custom-image-renderer" }
    ] }), { status: 200 }));
    expect(await discoverImageModels(sogniProfile, fetcher as typeof fetch)).toEqual([
      { id: "flux2", displayName: "flux2", loaded: false, instanceId: "flux2", contextLength: 0 },
      { id: "vendor/custom-image-renderer", displayName: "vendor/custom-image-renderer", loaded: false, instanceId: "vendor/custom-image-renderer", contextLength: 0 }
    ]);
  });

  it("preserves Sogni's documented opaque model inventory", async () => {
    const sogniProfile: TextProviderProfile = {
      ...profile,
      providerType: "sogni",
      baseUrl: "https://api.sogni.ai/v1",
      model: "flux2",
      apiKey: "sogni-secret"
    };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.sogni.ai/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sogni-secret");
      return new Response(JSON.stringify({
        object: "list",
        data: [
          {
            id: "qwen3.6-35b-a3b-gguf-iq4xs",
            object: "model",
            created: 1_776_384_000,
            owned_by: "qwen",
            capabilities: { reasoning: true }
          }
        ]
      }), { status: 200 });
    });
    expect(await discoverImageModels(sogniProfile, fetcher as typeof fetch)).toEqual([{
      id: "qwen3.6-35b-a3b-gguf-iq4xs",
      displayName: "qwen3.6-35b-a3b-gguf-iq4xs",
      loaded: false,
      instanceId: "qwen3.6-35b-a3b-gguf-iq4xs",
      contextLength: 0
    }]);
  });
});
