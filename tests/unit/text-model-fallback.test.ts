import { describe, expect, it, vi } from "vitest";
import {
  callTextProvider,
  createProviderTransport,
  ProviderModelFallbackExhaustedError,
  ProviderSseTerminalError,
  ProviderStreamInterruptedError,
  normalizeModelFailure,
  normalizeSseFailure,
  shouldAdvanceModel,
  type ProviderTransport,
  type TextProviderProfile
} from "../../packages/story-engine/src/index.js";

const profile: TextProviderProfile = {
  providerType: "openai_compatible",
  baseUrl: "https://provider.test/v1",
  model: "primary",
  contextWindowTokens: 32_768,
  maxOutputTokens: 4_096,
  temperature: 0.8,
  routingSource: "models",
  fallbackModels: []
};

function transport(fetcher: typeof fetch): ProviderTransport {
  return createProviderTransport({
    fetcher,
    dispatcherFactory: () => ({ dispatch: vi.fn(), close: vi.fn(), destroy: vi.fn() }) as never,
    policy: {
      async approve(url) {
        return { url, origin: url.origin, address: "127.0.0.1", family: 4, port: 443, servername: url.hostname };
      }
    }
  });
}

function completion(model = "served-model") {
  return new Response(JSON.stringify({
    id: "response-1",
    model,
    choices: [{ message: { content: "{\"narration\":\"Ready\"}" }, finish_reason: "stop" }],
    usage: {}
  }), { status: 200 });
}

describe("text model fallback", () => {
  it.each([
    ["rate_limit", false, true], ["provider_unavailable", false, true],
    ["content_policy_violation", false, true], ["refusal", false, true],
    ["authentication", false, false], ["invalid_request", false, false],
    ["cancelled", false, false], ["rate_limit", true, false]
  ] as const)("classifies %s", (reason, emittedOutput, expected) => {
    expect(shouldAdvanceModel({ reason, emittedOutput })).toBe(expected);
  });

  it.each([
    [Object.assign(new Error("private rate-limit wording"), { statusCode: 400 }), "invalid_request"],
    [Object.assign(new Error("private unavailable wording"), { statusCode: 401 }), "authentication"],
    [Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }), "cancelled"]
  ] as const)("keeps terminal failure classification ahead of provider wording", (error, expected) => {
    expect(normalizeModelFailure(error).reason).toBe(expected);
  });

  it.each([
    ["rate_limit", "rate_limit", true],
    ["provider_overloaded", "provider_unavailable", true],
    ["provider_unavailable", "provider_unavailable", true],
    ["service_unavailable", "provider_unavailable", true],
    ["authentication", "authentication", false],
    ["invalid_request", "invalid_request", false],
    ["cancelled", "cancelled", false],
    ["model_unavailable", "model_unavailable", false],
    ["context_length_exceeded", "context_length", false],
    ["request_timeout", "request_timeout", false],
    ["transport_failure", "transport_failure", false],
    ["content_policy_violation", "content_policy_violation", false],
    ["refusal", "refusal", false],
    ["empty_response", "empty_response", false],
    ["unrecognized_upstream_type", "unknown_failure", false],
    [400, "invalid_request", false],
    [401, "authentication", false]
  ] as const)("classifies SSE machine type %s conservatively", (machineType, expectedReason, advance) => {
    const failure = normalizeSseFailure(machineType, "2");
    const terminal = new ProviderSseTerminalError(failure);
    expect(normalizeModelFailure(terminal).reason).toBe(expectedReason);
    expect(shouldAdvanceModel({ ...failure, emittedOutput: false })).toBe(advance);
    if (advance) expect(failure.retryAfterMs).toBe(2_000);
  });

  it("gives a numeric SSE error code precedence over an eligible metadata type", () => {
    const failure = normalizeSseFailure("rate_limit", "2", { code: 401 });
    expect(failure).toMatchObject({ reason: "authentication", advanceEligible: false });
    expect(shouldAdvanceModel({ ...failure, emittedOutput: false })).toBe(false);
  });

  it("sends an ordered OpenRouter models request without model and records the served model", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.models).toEqual(["primary", "fallback"]);
      expect(body.model).toBeUndefined();
      expect(new Headers(init?.headers).get("x-openrouter-metadata")).toBe("enabled");
      return completion("openrouter/served");
    });

    const result = await callTextProvider({
      ...profile,
      providerType: "openrouter",
      baseUrl: "https://openrouter.test/api/v1",
      fallbackModels: ["fallback"]
    }, { systemPrompt: "system", input: "input" }, transport(fetcher as typeof fetch));

    expect(fetcher).toHaveBeenCalledOnce();
    expect(result.modelRouting).toEqual(expect.objectContaining({
      strategy: "openrouter_native",
      configuredModels: ["primary", "fallback"],
      resolvedModel: "openrouter/served",
      fallbackUsed: true
    }));
  });

  it("keeps the model field for a one-model OpenRouter plan", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("primary");
      expect(body.models).toBeUndefined();
      return completion("primary");
    });

    const result = await callTextProvider({
      ...profile,
      providerType: "openrouter",
      baseUrl: "https://openrouter.test/api/v1"
    }, { systemPrompt: "system", input: "input" }, transport(fetcher as typeof fetch));

    expect(result.modelRouting).toMatchObject({ strategy: "single", configuredModels: ["primary"], fallbackUsed: false });
  });

  it("sends only its stored preset snapshot models and provider policy", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ models: ["primary", "fallback"], provider: { allow_fallbacks: true } });
      expect(body.model).toBeUndefined();
      expect(body.preset).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("@preset/");
      expect(JSON.stringify(body)).not.toContain("system_prompt");
      expect(JSON.stringify(body)).not.toContain("tools");
      expect(JSON.stringify(body)).not.toContain("plugins");
      return completion("preset/served");
    });

    const result = await callTextProvider({
      ...profile,
      providerType: "openrouter",
      baseUrl: "https://openrouter.test/api/v1",
      routingSource: "openrouter_preset",
      fallbackModels: ["fallback"],
      presetProvenance: { slug: "saved-router", designatedVersionId: "v1", version: 1, configHash: "a".repeat(64) },
      providerPolicy: { allow_fallbacks: true, sort: { partition: "model" } }
    }, { systemPrompt: "system", input: "input" }, transport(fetcher as typeof fetch));

    expect(result.modelRouting.strategy).toBe("openrouter_preset_snapshot");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("advances generic providers only after an eligible pre-output failure", async () => {
    const requestedModels: string[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requestedModels.push(body.model);
      return requestedModels.length === 1
        ? new Response(JSON.stringify({ error: { message: "busy" } }), { status: 429, headers: { "retry-after": "3" } })
        : completion("fallback");
    });

    const result = await callTextProvider({ ...profile, fallbackModels: ["fallback"] }, { systemPrompt: "system", input: "input" }, transport(fetcher as typeof fetch));

    expect(requestedModels).toEqual(["primary", "fallback"]);
    expect(result.modelRouting).toMatchObject({ strategy: "sequential", resolvedModel: "fallback", fallbackUsed: true });
    expect(result.modelRouting.attempts).toEqual([
      { model: "primary", outcome: "failed", reason: "rate_limit", emittedOutput: false, retryAfterMs: 3_000 },
      { model: "fallback", outcome: "succeeded", reason: null, emittedOutput: false }
    ]);
  });

  it("preserves an HTTP-date Retry-After hint in milliseconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T16:00:00.000Z"));
    const requestedModels: string[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestedModels.push(JSON.parse(String(init?.body)).model);
      return requestedModels.length === 1
        ? new Response(JSON.stringify({ error: { message: "busy" } }), { status: 429, headers: { "retry-after": "Fri, 22 Aug 2026 16:00:11 GMT" } })
        : completion("fallback");
    });
    try {
      const result = await callTextProvider({ ...profile, fallbackModels: ["fallback"] }, { systemPrompt: "system", input: "input" }, transport(fetcher as typeof fetch));
      expect(result.modelRouting.attempts[0]).toMatchObject({ reason: "rate_limit", retryAfterMs: 11_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps OpenRouter HTTP error metadata when classifying a native model plan", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "private body", metadata: { error_type: "context_length_exceeded" } }
    }), { status: 400 }));

    const failure = callTextProvider({
      ...profile,
      providerType: "openrouter",
      baseUrl: "https://openrouter.test/api/v1",
      fallbackModels: ["fallback"]
    }, { systemPrompt: "system", input: "input" }, transport(fetcher as typeof fetch));

    await expect(failure).rejects.toMatchObject({
      code: "provider_model_fallback_exhausted",
      attempts: [expect.objectContaining({ reason: "context_length" })]
    });
    await expect(failure).rejects.not.toThrow("private body");
  });

  it("exhausts a multi-model transport plan with a safe normalized trace", async () => {
    const fetcher = vi.fn(async () => {
      throw Object.assign(new Error("socket reset with private endpoint"), { code: "ECONNRESET" });
    });
    const failure = callTextProvider({ ...profile, fallbackModels: ["fallback"] }, { systemPrompt: "system", input: "input" }, transport(fetcher as typeof fetch));

    await expect(failure).rejects.toMatchObject({
      code: "provider_model_fallback_exhausted",
      attempts: [
        expect.objectContaining({ model: "primary", reason: "transport_failure" }),
        expect.objectContaining({ model: "fallback", reason: "transport_failure" })
      ]
    });
    await expect(failure).rejects.not.toThrow("private endpoint");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("treats an AbortError cancellation as terminal and does not advance", async () => {
    const fetcher = vi.fn(async () => {
      throw Object.assign(new Error("request cancelled"), { name: "AbortError", code: "ABORT_ERR" });
    });
    const failure = callTextProvider({ ...profile, fallbackModels: ["fallback"] }, { systemPrompt: "system", input: "input" }, transport(fetcher as typeof fetch));

    await expect(failure).rejects.toMatchObject({ code: "provider_request_cancelled" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("joins multiline SSE data and ignores comments", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(": keepalive\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\ndata: \n\n"));
        controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n\n"));
        controller.close();
      }
    });
    const chunks: string[] = [];
    const fetcher = vi.fn(async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));

    const result = await callTextProvider(profile, {
      systemPrompt: "system",
      input: "input",
      onChunk: (_delta, accumulated) => { chunks.push(accumulated); }
    }, transport(fetcher as typeof fetch));

    expect(chunks).toEqual(["Hel", "Hello"]);
    expect(result.content).toBe("Hello");
  });

  it("advances after a typed SSE error before output and exposes no raw provider body", async () => {
    const requestedModels: string[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestedModels.push(JSON.parse(String(init?.body)).model);
      if (requestedModels.length === 1) {
        return new Response("data: {\"error\":{\"metadata\":{\"error_type\":\"rate_limit\"},\"message\":\"private upstream secret\"}}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream", "retry-after": "2" }
        });
      }
      return completion("fallback");
    });

    const result = await callTextProvider({ ...profile, fallbackModels: ["fallback"] }, {
      systemPrompt: "system", input: "input", onChunk: vi.fn()
    }, transport(fetcher as typeof fetch));
    expect(result.modelRouting).toMatchObject({ resolvedModel: "fallback" });
    expect(result.modelRouting.attempts[0]).toMatchObject({ reason: "rate_limit", retryAfterMs: 2_000 });
    expect(requestedModels).toEqual(["primary", "fallback"]);
  });

  it("never advances after an SSE error once output was emitted", async () => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"Visible\"}}]}\n\n"));
        controller.enqueue(encoder.encode("data: {\"error\":{\"metadata\":{\"error_type\":\"rate_limit\"},\"message\":\"private upstream secret\"}}\n\n"));
        controller.close();
      }
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));

    const failure = callTextProvider({ ...profile, fallbackModels: ["fallback"] }, {
      systemPrompt: "system", input: "input", onChunk: vi.fn()
    }, transport(fetcher as typeof fetch));

    await expect(failure).rejects.toBeInstanceOf(ProviderStreamInterruptedError);
    await expect(failure).rejects.not.toThrow("private upstream secret");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reports an all-failed plan with normalized attempts only", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { message: "private provider message" } }), { status: 503 }));
    const failure = callTextProvider({ ...profile, fallbackModels: ["fallback"] }, { systemPrompt: "system", input: "input" }, transport(fetcher as typeof fetch));
    await expect(failure).rejects.toBeInstanceOf(ProviderModelFallbackExhaustedError);
    await expect(failure).rejects.not.toThrow("private provider message");
  });
});
