import type { Dispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerProfileInputSchema } from "../../packages/contracts/src/generation.js";
import { ProviderDestinationNotAllowedError } from "../../packages/security/src/provider-network-policy.js";
import { ProviderResponseTooLargeError } from "../../packages/story-engine/src/provider-response.js";
import {
  MAX_IMAGE_PROVIDER_RESPONSE_BYTES,
  MAX_PROVIDER_JSON_RESPONSE_BYTES,
  MAX_PROVIDER_SSE_RESPONSE_BYTES,
  MAX_SOGNI_RESPONSE_BYTES
} from "../../packages/story-engine/src/provider-response.js";
import {
  callEmbeddingProvider,
  callImageProvider,
  callTextProvider,
  cancelImageProvider,
  createProviderTransport,
  discoverEmbeddingModels,
  discoverImageModels,
  discoverModels,
  logProviderExecutionError,
  logProviderTransportError,
  pollImageProvider,
  providerTransportErrorDetails,
  reportedProviderCost,
  submitImageProvider,
  type ProviderTransport,
  type TextProviderProfile
} from "../../packages/story-engine/src/providers.js";
import { logger } from "../../packages/logger/src/index.js";
import { setSogniSdkClientFactoryForTests } from "../../packages/story-engine/src/providers/illustration/sogni-sdk/index.js";

const profile: TextProviderProfile = {
  providerType: "lmstudio",
  baseUrl: "http://lmstudio.test/v1",
  model: "loaded-instance-id",
  contextWindowTokens: 131072,
  maxOutputTokens: 4096,
  temperature: 0.8
};

function createTestProviderTransport(fetcher: typeof fetch): ProviderTransport {
  const dispatcher = {
    dispatch: vi.fn(),
    close: vi.fn(async () => undefined),
    destroy: vi.fn()
  } as unknown as Dispatcher;
  return createProviderTransport({
    fetcher,
    dispatcherFactory: () => dispatcher,
    policy: {
      async approve(url) {
        return {
          url,
          origin: url.origin,
          address: "127.0.0.1",
          family: 4,
          port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
          servername: url.hostname
        };
      }
    }
  });
}

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
    const timeoutProfile = {
      ...profile,
      baseUrl: "http://provider-internal-host.test/private/v1",
      model: "provider-internal-model",
      requestTimeoutMs: 420_000,
      apiKey: "synthetic-secret-token"
    };
    const fetcher = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("Headers Timeout Error Bearer synthetic-secret-token"), { code: "UND_ERR_HEADERS_TIMEOUT" }) });
    });
    let thrown: unknown;
    try {
      await callTextProvider(timeoutProfile, { systemPrompt: "secret prompt", input: "private action" }, createTestProviderTransport(fetcher as typeof fetch));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("timed out after 7 minutes");
    expect(providerTransportErrorDetails(thrown)).toMatchObject({
      timedOut: true,
      timeoutMs: 420_000,
      transportCode: "UND_ERR_HEADERS_TIMEOUT",
      causeCategory: "timeout",
      causeMessage: "The provider request timed out.",
      endpoint: "http://provider-internal-host.test/private/api/v1/chat"
    });
    const logged = JSON.stringify(loggerError.mock.calls);
    expect(logged).toContain('"event":"provider_transport_error"');
    expect(logged).toContain('"diagnosticCode":"provider_request_timeout"');
    expect(logged).not.toContain("Headers Timeout Error");
    expect(logged).not.toContain("secret prompt");
    expect(logged).not.toContain("private action");
    expect(logged).not.toContain("synthetic-secret-token");
    expect(logged).not.toContain("provider-internal-host");
    expect(logged).not.toContain("provider-internal-model");
    expect(logged).not.toContain("UND_ERR_HEADERS_TIMEOUT");
    expect(logged).not.toContain("420000");

    loggerError.mockClear();
    logProviderTransportError(thrown, {
      generationJobId: "job-correlation-id",
      campaignId: "campaign-correlation-id"
    });
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({
      event: "provider_transport_error_correlated",
      diagnosticCode: "provider_request_timeout",
      generationJobId: "job-correlation-id",
      campaignId: "campaign-correlation-id"
    }));
    const correlatedLog = JSON.stringify(loggerError.mock.calls);
    expect(correlatedLog).not.toContain("provider-internal-host");
    expect(correlatedLog).not.toContain("provider-internal-model");
    expect(correlatedLog).not.toContain("UND_ERR_HEADERS_TIMEOUT");
    expect(correlatedLog).not.toContain("420000");
    loggerError.mockRestore();
  });

  it("logs correlated provider HTTP failures without provider response content", () => {
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const failure = Object.assign(
      new Error("Provider request failed (429): private upstream response"),
      {
        statusCode: 429,
        providerMessage: "private upstream response"
      }
    );

    logProviderExecutionError(failure, {
      chronicleJobId: "chronicle-job-correlation-id",
      campaignId: "campaign-correlation-id"
    });

    expect(loggerError).toHaveBeenCalledWith({
      event: "provider_execution_error_correlated",
      chronicleJobId: "chronicle-job-correlation-id",
      campaignId: "campaign-correlation-id",
      diagnosticCode: "provider_http_error",
      errorType: "Error",
      errorCauseDepth: 1,
      errorCauseTypes: ["Error"],
      failureReason: "provider_rate_limited",
      providerStatusCode: 429
    });
    const logged = JSON.stringify(loggerError.mock.calls);
    expect(logged).not.toContain("private upstream response");
    expect(logged).not.toContain("providerMessage");
  });

  it("classifies invalid embedding responses without logging the error message", () => {
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const failure = new Error("Embedding provider returned 1 vectors for 2 inputs.");

    logProviderExecutionError(failure, {
      chronicleJobId: "chronicle-job-correlation-id",
      campaignId: "campaign-correlation-id"
    });

    expect(loggerError).toHaveBeenCalledWith({
      event: "provider_execution_error_correlated",
      chronicleJobId: "chronicle-job-correlation-id",
      campaignId: "campaign-correlation-id",
      diagnosticCode: "provider_response_invalid",
      errorType: "Error",
      errorCauseDepth: 1,
      errorCauseTypes: ["Error"],
      failureReason: "embedding_vector_count_mismatch"
    });
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(failure.message);
  });

  it.each([
    [
      "Chronicle chunk embedding provider capability is unavailable.",
      "embedding_capability_unavailable"
    ],
    [
      "Chronicle job lease heartbeat was lost.",
      "chronicle_heartbeat_lease_lost"
    ]
  ])("logs a safe reason for known Chronicle execution failure: %s", (message, failureReason) => {
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    logProviderExecutionError(
      new Error(message),
      { chronicleJobId: "chronicle-job-correlation-id" },
    );

    expect(loggerError).toHaveBeenCalledWith({
      event: "provider_execution_error_correlated",
      chronicleJobId: "chronicle-job-correlation-id",
      diagnosticCode: "provider_execution_failed",
      errorType: "Error",
      errorCauseDepth: 1,
      errorCauseTypes: ["Error"],
      failureReason
    });
  });

  it("does not expose arbitrary error details when the execution failure is unclassified", () => {
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const failure = new TypeError("private provider detail synthetic-secret-token");

    logProviderExecutionError(failure, { chronicleJobId: "chronicle-job-correlation-id" });

    expect(loggerError).toHaveBeenCalledWith({
      event: "provider_execution_error_correlated",
      chronicleJobId: "chronicle-job-correlation-id",
      diagnosticCode: "provider_execution_failed",
      errorType: "TypeError",
      errorCauseDepth: 1,
      errorCauseTypes: ["TypeError"],
      failureReason: "unclassified"
    });
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain("synthetic-secret-token");
  });

  it("logs bounded response-size and nested cause details without response content", () => {
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const failure = new Error("private wrapper", {
      cause: new ProviderResponseTooLargeError(4 * 1024 * 1024)
    });

    logProviderExecutionError(failure, { chronicleJobId: "chronicle-job-correlation-id" });

    expect(loggerError).toHaveBeenCalledWith({
      event: "provider_execution_error_correlated",
      chronicleJobId: "chronicle-job-correlation-id",
      diagnosticCode: "provider_response_too_large",
      errorType: "Error",
      errorCauseDepth: 2,
      errorCauseTypes: ["Error", "ProviderResponseTooLargeError"],
      errorCodes: ["provider_response_too_large"],
      failureReason: "provider_response_size_limit_exceeded",
      permanent: true,
      providerResponseLimitBytes: 4 * 1024 * 1024,
      providerStatusCode: 502,
      retryable: false
    });
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain("private wrapper");
  });

  it("logs the controlled provider network-policy stage", () => {
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    logProviderExecutionError(
      new ProviderDestinationNotAllowedError("redirect"),
      { chronicleJobId: "chronicle-job-correlation-id" },
    );

    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({
      diagnosticCode: "provider_destination_not_allowed",
      errorCodes: ["PROVIDER_DESTINATION_NOT_ALLOWED"],
      failureReason: "provider_network_policy_rejected",
      providerDestinationStage: "redirect",
      providerStatusCode: 422
    }));
  });

  it("logs safe PostgreSQL and vector-dimension details without arbitrary database text", () => {
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const failure = Object.assign(
      new Error("expected 4096 dimensions, not 3584; token=synthetic-secret-token"),
      {
        name: "error",
        code: "22000",
        schema: "public",
        table: "chronicle_memory_chunks",
        constraint: "chronicle_memory_chunks_embedding_check",
        routine: "CheckExpectedDim",
        detail: "synthetic-secret-token"
      },
    );

    logProviderExecutionError(failure, { chronicleJobId: "chronicle-job-correlation-id" });

    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({
      diagnosticCode: "provider_execution_failed",
      failureReason: "embedding_vector_dimension_mismatch_on_persist",
      errorType: "error",
      errorCodes: ["22000"],
      databaseErrorCode: "22000",
      databaseSchema: "public",
      databaseTable: "chronicle_memory_chunks",
      databaseConstraint: "chronicle_memory_chunks_embedding_check",
      databaseRoutine: "CheckExpectedDim",
      expectedEmbeddingDimensions: 4096,
      actualEmbeddingDimensions: 3584
    }));
    const logged = JSON.stringify(loggerError.mock.calls);
    expect(logged).not.toContain("synthetic-secret-token");
    expect(logged).not.toContain("detail");
  });

  it("logs only controlled Chronicle chunk execution-stage context", () => {
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const failure = Object.assign(new Error("private commit failure synthetic-secret-token"), {
      providerExecutionContext: {
        executionStage: "parent_commit",
        parentOrdinal: 7,
        parentMemoryId: "66666666-6666-4666-8666-666666666666",
        attemptedBatchSize: 2,
        chunkCount: 3,
        embeddedChunkCount: 2,
        processedParents: 1,
        commitStage: "cost_recording",
        reportedCostPresent: true,
        reportedCostCount: 1,
        reportedCostNotation: "scientific",
        reportedCostCurrencyValid: true,
        privateDetail: "synthetic-secret-token"
      }
    });

    logProviderExecutionError(failure, { chronicleJobId: "chronicle-job-correlation-id" });

    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({
      failureReason: "chunk_cost_recording_failed",
      executionStage: "parent_commit",
      parentOrdinal: 7,
      parentMemoryId: "66666666-6666-4666-8666-666666666666",
      attemptedBatchSize: 2,
      chunkCount: 3,
      embeddedChunkCount: 2,
      processedParents: 1,
      commitStage: "cost_recording",
      reportedCostPresent: true,
      reportedCostCount: 1,
      reportedCostNotation: "scientific",
      reportedCostCurrencyValid: true
    }));
    const logged = JSON.stringify(loggerError.mock.calls);
    expect(logged).not.toContain("privateDetail");
    expect(logged).not.toContain("synthetic-secret-token");
  });

  it("keeps arbitrary transport causes out of provider logs and error surfaces", async () => {
    const privateMarker = "SECRET_AT_START_OF_TRANSPORT_CAUSE";
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const fetcher = vi.fn(async () => {
      throw Object.assign(new TypeError(`${privateMarker}: upstream socket closed`), {
        code: "ECONNRESET"
      });
    });
    let thrown: unknown;
    try {
      await callTextProvider(
        profile,
        { systemPrompt: "private world prompt", input: "private lore" },
        createTestProviderTransport(fetcher as typeof fetch)
      );
    } catch (error) {
      thrown = error;
    }

    const details = providerTransportErrorDetails(thrown);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("provider connection failed (ECONNRESET)");
    expect(thrown).not.toHaveProperty("cause");
    expect(details).toMatchObject({
      timedOut: false,
      transportCode: "ECONNRESET",
      causeCategory: "network",
      causeMessage: "The provider connection failed."
    });
    const exposed = JSON.stringify({
      error: {
        name: (thrown as Error).name,
        message: (thrown as Error).message,
        cause: (thrown as Error & { cause?: unknown }).cause
      },
      details,
      loggerCalls: loggerError.mock.calls
    });
    expect(exposed).not.toContain(privateMarker);
    expect(exposed).not.toContain("private world prompt");
    expect(exposed).not.toContain("private lore");
    loggerError.mockRestore();
  });

  it("attaches an abort deadline and configurable dispatcher to outbound requests", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect((init as RequestInit & { dispatcher?: unknown })?.dispatcher).toBeDefined();
      return new Response(JSON.stringify({ output: [{ type: "message", content: "{}" }], stats: {} }), { status: 200 });
    });
    await callTextProvider({ ...profile, requestTimeoutMs: 600_000 }, { systemPrompt: "system", input: "input" }, createTestProviderTransport(fetcher as typeof fetch));
  });

  it("normalizes only explicit valid provider-reported costs", () => {
    expect(reportedProviderCost({ cost: 0.00001234 })).toEqual({ amount: "0.00001234", currency: "USD" });
    expect(reportedProviderCost({ cost: 1.2e-7, currency: "USD" })).toEqual({ amount: "0.00000012", currency: "USD" });
    expect(reportedProviderCost({ cost: "1.2e-7", currency: "usd" })).toEqual({ amount: "0.00000012", currency: "USD" });
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
    await callTextProvider(profile, { systemPrompt: "system", input: "input" }, createTestProviderTransport(fetcher as typeof fetch));
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
    const result = await callTextProvider(unloadedProfile, { systemPrompt: "system", input: "input" }, createTestProviderTransport(fetcher as typeof fetch));
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
    const models = await discoverModels(profile, createTestProviderTransport(fetcher as typeof fetch));
    expect(models).toEqual([{ id: "model-key", displayName: "Model Name", loaded: true, instanceId: "instance-7", contextLength: 196608 }]);
  });

  it("returns inactive models alongside loaded instances", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      models: [
        { key: "active-model", display_name: "Active Model", loaded_instances: [{ id: "active-instance", config: { context_length: 65536 } }] },
        { key: "inactive-model", display_name: "Inactive Model", max_context_length: 32768 }
      ]
    }), { status: 200 }));
    const models = await discoverModels(profile, createTestProviderTransport(fetcher as typeof fetch));
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
    const result = await callTextProvider(profile, { systemPrompt: "system", input: "input" }, createTestProviderTransport(fetcher as typeof fetch));
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
    }, createTestProviderTransport(fetcher as typeof fetch));
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
    }, createTestProviderTransport(fetcher as typeof fetch));
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
    const result = await callEmbeddingProvider(profile, ["first", "second"], createTestProviderTransport(fetcher as typeof fetch));
    expect(result.embeddings).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(result.model).toBe("embedding-model");
    expect(result.responseId).toBe("embedding-response-1");
    expect(result.reportedCost).toEqual({ amount: "0.000004", currency: "USD" });
  });

  it("rejects inconsistent embedding dimensions", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1, 0] }]
    }), { status: 200 }));
    await expect(callEmbeddingProvider(profile, ["first", "second"], createTestProviderTransport(fetcher as typeof fetch)))
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
    }, createTestProviderTransport(fetcher as typeof fetch));
    expect(result).toMatchObject({ base64: "aW1hZ2U=", mimeType: "image/png", responseId: "image-1" });
    expect(result.reportedCost).toEqual({ amount: "0.04", currency: "USD" });
  });

  it("returns both requested OpenAI-compatible image variants", async () => {
    const imageProfile = { ...profile, providerType: "openai_compatible" as const, baseUrl: "http://images.test" };
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).n).toBe(2);
      return new Response(JSON.stringify({
        id: "image-pair",
        data: [{ b64_json: "Zmlyc3Q=" }, { b64_json: "c2Vjb25k" }]
      }), { status: 200 });
    });
    const result = await callImageProvider(imageProfile, {
      prompt: "Two fictional panorama variants.",
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "high",
      outputFormat: "png",
      imageCount: 2
    }, createTestProviderTransport(fetcher as typeof fetch));
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.map((artifact) => artifact.source === "base64" ? artifact.base64 : "")).toEqual(["Zmlyc3Q=", "c2Vjb25k"]);
  });

  it("accepts an image response whose decoded artifact exceeds the generic JSON ceiling", async () => {
    const imageProfile = { ...profile, providerType: "openai_compatible" as const, baseUrl: "http://images.test" };
    const base64 = Buffer.alloc(MAX_PROVIDER_JSON_RESPONSE_BYTES + 1).toString("base64");
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      id: "large-image",
      data: [{ b64_json: base64 }]
    }), { status: 200 }));

    const result = await callImageProvider(imageProfile, {
      prompt: "A large fictional panorama.",
      size: "2048x2048",
      aspectRatio: "1:1",
      quality: "high",
      outputFormat: "png"
    }, createTestProviderTransport(fetcher as typeof fetch));

    expect(result.base64).toHaveLength(base64.length);
  });

  it("rejects image provider responses beyond the image-specific ceiling", async () => {
    const imageProfile = { ...profile, providerType: "openai_compatible" as const, baseUrl: "http://images.test" };
    const fetcher = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(MAX_IMAGE_PROVIDER_RESPONSE_BYTES + 1) }
    }));

    await expect(callImageProvider(imageProfile, {
      prompt: "An oversized fictional panorama.",
      size: "2048x2048",
      aspectRatio: "1:1",
      quality: "high",
      outputFormat: "png"
    }, createTestProviderTransport(fetcher as typeof fetch))).rejects.toMatchObject({
      code: "provider_response_too_large",
      limitBytes: MAX_IMAGE_PROVIDER_RESPONSE_BYTES
    });
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
    expect(await discoverImageModels(imageProfile, createTestProviderTransport(fetcher as typeof fetch))).toEqual([{
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
    expect(await discoverImageModels(profile, createTestProviderTransport(fetcher as typeof fetch))).toEqual([{
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
    expect(await discoverImageModels(imageProfile, createTestProviderTransport(fetcher as typeof fetch))).toEqual([{
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
    expect(await discoverImageModels(imageProfile, createTestProviderTransport(fetcher as typeof fetch))).toHaveLength(1);
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
    expect(await discoverEmbeddingModels(embeddingProfile, createTestProviderTransport(fetcher as typeof fetch))).toEqual([{
      id: "openai/text-embedding-3-small",
      displayName: "Text Embedding 3 Small",
      loaded: true,
      instanceId: "openai/text-embedding-3-small",
      contextLength: 8192
    }]);
  });

  it("does not expose unparseable failed provider response bodies", async () => {
    const fetcher = vi.fn(async () => {
      return new Response("Internal Server Error - Invalid JSON [", {
        status: 500,
        statusText: "Internal Server Error"
      });
    });

    let thrownError: unknown;
    try {
      await callTextProvider(profile, { systemPrompt: "system", input: "input" }, createTestProviderTransport(fetcher as typeof fetch));
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toMatchObject({
      code: "provider_model_fallback_exhausted",
      statusCode: 502
    });
    expect((thrownError as Error).message).not.toContain("Internal Server Error - Invalid JSON [");
  });

  it("rejects oversized generic JSON responses with a safe permanent error", async () => {
    let cancellations = 0;
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        cancellations += 1;
      }
    }), {
      status: 200,
      headers: { "content-length": String(MAX_PROVIDER_JSON_RESPONSE_BYTES + 1) }
    }));

    await expect(callTextProvider(
      profile,
      { systemPrompt: "system", input: "input" },
      createTestProviderTransport(fetcher as typeof fetch)
    )).rejects.toMatchObject({
      code: "provider_response_too_large",
      permanent: true,
      statusCode: 502
    });
    expect(cancellations).toBe(2);
  });

  it("bounds response-format fallback inspection and does not retry an oversized error response", async () => {
    let cancelled = false;
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":"response_format is unsupported"}'));
      },
      cancel() {
        cancelled = true;
      }
    }), {
      status: 400,
      headers: { "content-length": String(MAX_PROVIDER_JSON_RESPONSE_BYTES + 1) }
    }));
    const openAiProfile: TextProviderProfile = {
      ...profile,
      providerType: "openai_compatible",
      baseUrl: "https://api.openai.com/v1"
    };

    await expect(callTextProvider(openAiProfile, {
      systemPrompt: "system",
      input: "input"
    }, createTestProviderTransport(fetcher as typeof fetch))).rejects.toMatchObject({
      code: "provider_response_too_large",
      limitBytes: MAX_PROVIDER_JSON_RESPONSE_BYTES
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
  });

  it("preserves provider destination denials through the public text adapter", async () => {
    const transport = createProviderTransport({
      policy: {
        async approve() {
          throw new ProviderDestinationNotAllowedError("address");
        }
      }
    });

    await expect(callTextProvider(
      profile,
      { systemPrompt: "system", input: "input" },
      transport
    )).rejects.toMatchObject({
      code: "PROVIDER_DESTINATION_NOT_ALLOWED",
      stage: "address",
      permanent: true,
      retryable: false
    });
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
    }, createTestProviderTransport(fetcher as typeof fetch));
    expect(streamChunks).toEqual(["Hello", "Hello world"]);
    expect(result.content).toBe("Hello world");
  });

  it("does not treat a malformed terminal SSE event as a completed provider response", async () => {
    const openAiProfile: TextProviderProfile = {
      ...profile,
      providerType: "openai_compatible",
      baseUrl: "https://api.openai.com/v1"
    };
    const fetcher = vi.fn(async () => new Response("data: {not json}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }));

    await expect(callTextProvider(openAiProfile, {
      systemPrompt: "system",
      input: "input",
      onChunk: vi.fn()
    }, createTestProviderTransport(fetcher as typeof fetch))).rejects.toMatchObject({
      code: "provider_model_fallback_exhausted"
    });
  });

  it("cancels oversized SSE responses and returns a safe typed failure", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PROVIDER_SSE_RESPONSE_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetcher = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }));
    const openAiProfile: TextProviderProfile = {
      ...profile,
      providerType: "openai_compatible",
      baseUrl: "https://api.openai.com/v1"
    };

    await expect(callTextProvider(openAiProfile, {
      systemPrompt: "system",
      input: "input",
      onChunk: vi.fn()
    }, createTestProviderTransport(fetcher as typeof fetch))).rejects.toMatchObject({
      code: "provider_response_too_large",
      permanent: true
    });
    expect(cancelled).toBe(true);
  });

  it("normalizes a post-header SSE body timeout as a provider transport failure", async () => {
    const bodyTimeout = Object.assign(new Error("Body Timeout Error"), {
      name: "AbortError",
      code: "UND_ERR_BODY_TIMEOUT"
    });
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull() {
        throw bodyTimeout;
      }
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }));
    const openAiProfile: TextProviderProfile = {
      ...profile,
      providerType: "openai_compatible",
      baseUrl: "https://api.openai.com/v1"
    };

    let thrownError: unknown;
    try {
      await callTextProvider(openAiProfile, {
        systemPrompt: "system",
        input: "input",
        onChunk: vi.fn()
      }, createTestProviderTransport(fetcher as typeof fetch));
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toMatchObject({
      code: "provider_request_timeout",
      statusCode: 504
    });
    expect(providerTransportErrorDetails(thrownError)).toMatchObject({
      timedOut: true,
      transportCode: "UND_ERR_BODY_TIMEOUT",
      causeCategory: "timeout",
      causeMessage: "The provider request timed out.",
      operation: "story generation"
    });
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
    }, createTestProviderTransport(fetcher as typeof fetch))).resolves.toEqual({
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
    await expect(pollImageProvider(sogniProfile, { remoteJobId: "wf_test-1" }, createTestProviderTransport(fetcher as typeof fetch))).resolves.toMatchObject({
      status: "completed",
      artifacts: [{ source: "url", url: "https://artifacts.sogni.ai/signed/image.png", mimeType: "image/png" }],
      reportedCost: { amount: "0.25", currency: "USD" }
    });
    await expect(cancelImageProvider(sogniProfile, { remoteJobId: "wf_test-1" }, createTestProviderTransport(fetcher as typeof fetch))).resolves.toBeUndefined();
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
    }, createTestProviderTransport(fetcher as typeof fetch))).rejects.toMatchObject({
      normalized: { code: "rate_limited:209", retryable: true, statusCode: 429, retryAfterMs: 4_000 }
    });
  });

  it("rejects oversized Sogni REST responses with a permanent safe failure", async () => {
    const sogniProfile: TextProviderProfile = {
      ...profile,
      providerType: "sogni",
      baseUrl: "https://api.sogni.ai",
      model: "flux2",
      apiKey: "sogni-secret"
    };
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetcher = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-length": String(MAX_SOGNI_RESPONSE_BYTES + 1) }
    }));

    await expect(submitImageProvider(sogniProfile, {
      prompt: "A fictional vista.",
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "auto",
      outputFormat: "png",
      idempotencyKey: "illustration-job-3:revision-1"
    }, createTestProviderTransport(fetcher as typeof fetch))).rejects.toMatchObject({
      code: "provider_response_too_large",
      permanent: true,
      normalized: { retryable: false }
    });
    expect(cancelled).toBe(true);
  });

  it("normalizes a post-header Sogni body abort as a retryable timeout", async () => {
    const sogniProfile: TextProviderProfile = {
      ...profile,
      providerType: "sogni",
      baseUrl: "https://api.sogni.ai",
      model: "flux2",
      apiKey: "sogni-secret"
    };
    const bodyTimeout = Object.assign(new Error("Body Timeout Error"), {
      name: "AbortError",
      code: "UND_ERR_BODY_TIMEOUT"
    });
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull() {
        throw bodyTimeout;
      }
    }), { status: 201 }));

    await expect(submitImageProvider(sogniProfile, {
      prompt: "A fictional vista.",
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "auto",
      outputFormat: "png",
      idempotencyKey: "illustration-job-4:revision-1"
    }, createTestProviderTransport(fetcher as typeof fetch))).rejects.toMatchObject({
      code: "provider_request_timeout",
      permanent: false,
      normalized: {
        code: "provider_request_timeout",
        retryable: true
      }
    });
  });

  it("preserves provider destination denials through Sogni submission as permanent", async () => {
    const sogniProfile: TextProviderProfile = {
      ...profile,
      providerType: "sogni",
      baseUrl: "https://api.sogni.ai",
      model: "flux2",
      apiKey: "sogni-secret"
    };
    const transport = createProviderTransport({
      policy: {
        async approve() {
          throw new ProviderDestinationNotAllowedError("address");
        }
      }
    });

    await expect(submitImageProvider(sogniProfile, {
      prompt: "A fictional vista.",
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "auto",
      outputFormat: "png",
      idempotencyKey: "illustration-job-4:revision-1"
    }, transport)).rejects.toMatchObject({
      code: "PROVIDER_DESTINATION_NOT_ALLOWED",
      stage: "address",
      permanent: true,
      retryable: false
    });
  });

  it("uses Sogni's media catalog and keeps image models only", async () => {
    const sogniProfile: TextProviderProfile = {
      ...profile,
      providerType: "sogni",
      baseUrl: "https://api.sogni.ai",
      model: "flux2",
      apiKey: "sogni-secret"
    };
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://socket.sogni.ai/api/v1/models/list");
      return new Response(JSON.stringify([
        { id: "qwen-chat", name: "Qwen chat", SID: 1, media: "text" },
        { id: "flux2", name: "Flux 2", SID: 2, media: "image" },
        { id: "wan22", name: "Wan 2.2", SID: 3, media: "video" },
        { id: "unclassified", name: "Unclassified", SID: 4 }
      ]), { status: 200 });
    });
    expect(await discoverImageModels(sogniProfile, createTestProviderTransport(fetcher as typeof fetch))).toEqual([
      { id: "flux2", displayName: "Flux 2", loaded: false, instanceId: "flux2", contextLength: 0 }
    ]);
  });

  it("uses Sogni's Supernet media catalog instead of the LLM-only REST catalog", async () => {
    const sogniProfile: TextProviderProfile = {
      ...profile,
      providerType: "sogni",
      baseUrl: "https://api.sogni.ai/v1",
      model: "flux2",
      apiKey: "sogni-secret"
    };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://socket.sogni.ai/api/v1/models/list");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return new Response(JSON.stringify([
        { id: "z_image_turbo_bf16", name: "Z-Image Turbo", SID: 10, media: "image" },
        { id: "ace_step_1.5", name: "ACE-Step", SID: 11, media: "audio" }
      ]), { status: 200 });
    });
    expect(await discoverImageModels(sogniProfile, createTestProviderTransport(fetcher as typeof fetch))).toEqual([{
      id: "z_image_turbo_bf16",
      displayName: "Z-Image Turbo",
      loaded: false,
      instanceId: "z_image_turbo_bf16",
      contextLength: 0
    }]);
  });

  it("discovers Sogni SDK models only through the injected pinned transport", async () => {
    const sogniProfile: TextProviderProfile = {
      ...profile,
      providerType: "sogni_sdk",
      baseUrl: "https://api.sogni.ai/v1",
      model: "flux2",
      apiKey: "sogni-secret"
    };
    const fetch = vi.fn(async (_profile, _operation, url) => {
      const responses: Record<string, unknown> = {
        "https://socket.sogni.ai/api/v1/models/list": [
          { id: "qwen-chat", name: "Qwen chat", SID: 1, media: "text", tier: "text-tier" },
          { id: "flux2", name: "Flux 2", SID: 2, media: "image", tier: "image-tier" }
        ],
        "https://socket.sogni.ai/api/v1/status/network/fast/models": { "2": 7 },
        "https://socket.sogni.ai/api/v1/status/network/relaxed/models": { "2": 3 },
        "https://socket.sogni.ai/api/v2/models/tiers": {
          "image-tier": {
            steps: { min: 1, max: 20, step: 1, default: 8 },
            guidance: { min: 0, max: 10, decimals: 1, default: 3.5 },
            sampler: { allowed: ["Euler a"], default: "Euler a" },
            scheduler: { allowed: ["Normal"], default: "Normal" }
          }
        },
        "https://socket.sogni.ai/api/v1/size-presets/network/fast/model/flux2": [
          { id: "small", label: "Small", width: 512, height: 512, ratio: "1:1" }
        ]
      };
      expect(responses).toHaveProperty(url);
      return new Response(JSON.stringify(responses[url]), { status: 200 });
    });
    const transport: ProviderTransport = {
      fetch,
      validateSdkEndpoint: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    };
    const secondClient = vi.fn(async () => {
      throw new Error("Sogni inventory created a second network client");
    });
    setSogniSdkClientFactoryForTests(secondClient as never);
    try {
      await expect(discoverImageModels(sogniProfile, transport)).resolves.toEqual([{
        id: "flux2",
        displayName: "Flux 2",
      loaded: true,
      instanceId: "flux2",
      contextLength: 0,
      workerCount: 7,
      workerAvailability: [
        expect.objectContaining({ type: "fast", workerCount: 7 }),
        expect.objectContaining({ type: "relaxed", workerCount: 3 })
      ],
      media: "image",
      imageOptions: expect.objectContaining({
        samplers: ["euler_a"],
        defaultSampler: "euler_a",
        schedulers: ["normal"],
        defaultScheduler: "normal",
        sizePresets: [expect.objectContaining({ id: "small" })]
      })
    }]);
    expect(transport.validateSdkEndpoint).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledTimes(5);
      expect(secondClient).not.toHaveBeenCalled();
    } finally {
      setSogniSdkClientFactoryForTests();
    }
  });
});
