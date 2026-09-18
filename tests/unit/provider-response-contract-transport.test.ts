import { describe, expect, it, vi } from "vitest";
import {
  callTextProvider,
  createProviderTransport,
  providerTransportErrorDetails,
  type ProviderTransport,
  type TextProviderProfile
} from "../../packages/story-engine/src/providers.js";
import { getProviderOutputSchema } from "../../packages/story-engine/src/provider-output-schema.js";

const profile: TextProviderProfile = {
  providerType: "openrouter", baseUrl: "https://openrouter.example/api/v1", model: "requested/model",
  contextWindowTokens: 131_072, maxOutputTokens: 4_096, temperature: 0.8
};

function transport(fetcher: typeof fetch): ProviderTransport {
  return createProviderTransport({
    fetcher,
    policy: { async approve(url) { return { url, origin: url.origin, address: "127.0.0.1", family: 4, port: 443, servername: url.hostname }; } }
  });
}

function contract(mode: "json_object" | "json_schema", streaming = false): any {
  if (mode === "json_object") return { version: 1, mode, operation: "story", streaming, forbidFormatFallback: true };
  const schema = getProviderOutputSchema("story");
  return {
    version: 1, mode, operation: "story", streaming, forbidFormatFallback: true,
    schemaVersion: schema.version, schemaHash: schema.schemaHash, schemaName: schema.name, schema: schema.schema,
    providerRoutingSlugs: ["provider/region"], routeConfigHash: "b".repeat(64), adapterProtocol: "text-schema-adapter-v1"
  };
}

async function failure(mode: "json_object" | "json_schema", response: Response, request: Record<string, unknown> = {}) {
  const fetcher = vi.fn(async () => response);
  let error: any;
  try {
    await callTextProvider(profile, { systemPrompt: "private prompt", input: "private input", responseContract: contract(mode), ...request } as never, transport(fetcher as typeof fetch));
  } catch (caught) { error = caught; }
  return { error, fetcher };
}

function sse(chunks: string[], terminalError?: Error): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (terminalError) setTimeout(() => controller.error(terminalError), 0); else controller.close();
    }
  });
}

describe("prepared response-contract transport", () => {
  it.each([
    ["json_object", "unsupported_response_format", "provider_schema_unsupported"],
    ["json_schema", "invalid_schema", "provider_schema_invalid"],
    ["json_object", "no_endpoint", "provider_route_unavailable"],
    ["json_schema", "content_filter", "provider_refusal"]
  ] as const)("classifies %s HTTP failures as %s without a redispatch", async (mode, code, diagnosticCode) => {
    const { error, fetcher } = await failure(mode, new Response(JSON.stringify({ id: "body-id", model: "body-model", provider: "body-route", error: { code, message: "private upstream detail" } }), { status: 400, headers: { "x-generation-id": "header-id" } }));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ diagnosticCode, responseId: "header-id", returnedModel: "body-model", returnedProviderRoute: "body-route", preparedRequest: { body: expect.any(String), payloadHash: expect.any(String) } });
    expect(error.message).not.toContain("private upstream detail");
  });

  it.each(["json_object", "json_schema"] as const)("treats a non-stream refusal as a recoverable structured failure for %s", async (mode) => {
    const { error, fetcher } = await failure(mode, new Response(JSON.stringify({ id: "refusal-id", model: "actual-model", provider: "actual-route", choices: [{ message: { refusal: "private refusal", content: null }, finish_reason: "content_filter" }] }), { status: 200 }));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ diagnosticCode: "provider_refusal", responseId: "refusal-id", returnedModel: "actual-model", returnedProviderRoute: "actual-route", partialContent: "" });
    expect(error.message).not.toContain("private refusal");
  });

  it.each(["json_object", "json_schema"] as const)("preserves response evidence for malformed successful JSON in %s mode", async (mode) => {
    const { error, fetcher } = await failure(mode, new Response("{ private malformed", { status: 200, headers: { "x-generation-id": "malformed-header" } }));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ responseId: "malformed-header", preparedRequest: { body: expect.any(String), payloadHash: expect.any(String) }, returnedModel: null, returnedProviderRoute: null, partialContent: "" });
    expect(error.message).not.toContain("private malformed");
  });

  it.each(["json_object", "json_schema"] as const)("captures stream refusal and early event metadata for %s", async (mode) => {
    const response = new Response(sse([`data: ${JSON.stringify({ id: "stream-id", model: "stream-model", provider: "stream-route", type: "response.refusal.delta", choices: [{ delta: { refusal: "private stream refusal" } }] })}\n\n`]), { status: 200, headers: { "content-type": "text/event-stream" } });
    const { error, fetcher } = await failure(mode, response, { onChunk: () => undefined, responseContract: contract(mode, true) });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ diagnosticCode: "provider_refusal", responseId: "stream-id", returnedModel: "stream-model", returnedProviderRoute: "stream-route", partialContent: "" });
    expect(error.message).not.toContain("private stream refusal");
  });

  it.each(["json_object", "json_schema"] as const)("classifies a structured SSE error event as refusal for %s", async (mode) => {
    const response = new Response(sse([`data: ${JSON.stringify({ id: "error-id", model: "error-model", provider: "error-route", type: "error", error: { code: "content_filter", message: "private error detail" } })}\n\n`]), { status: 200, headers: { "content-type": "text/event-stream" } });
    const { error, fetcher } = await failure(mode, response, { onChunk: () => undefined, responseContract: contract(mode, true) });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ diagnosticCode: "provider_refusal", responseId: "error-id", returnedModel: "error-model", returnedProviderRoute: "error-route" });
    expect(error.message).not.toContain("private error detail");
  });

  it.each(["json_object", "json_schema"] as const)("retains partial text and earlier stream metadata after truncation for %s", async (mode) => {
    const response = new Response(sse([`data: ${JSON.stringify({ id: "partial-id", model: "partial-model", provider: "partial-route", choices: [{ delta: { content: "partial" } }] })}\n\n`], new Error("body timeout private")), { status: 200, headers: { "content-type": "text/event-stream" } });
    const { error, fetcher } = await failure(mode, response, { onChunk: () => undefined, responseContract: contract(mode, true) });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ responseId: "partial-id", returnedModel: "partial-model", returnedProviderRoute: "partial-route", partialContent: "partial", preparedRequest: { body: expect.any(String) } });
    expect(error.message).not.toContain("private");
  });

  it.each(["json_object", "json_schema"] as const)("wraps post-header response limits for %s", async (mode) => {
    const { error, fetcher } = await failure(mode, new Response("{}", { status: 200, headers: { "content-length": String(5 * 1024 * 1024), "x-generation-id": "limit-id" } }));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ responseId: "limit-id", preparedRequest: { body: expect.any(String) }, partialContent: "" });
    expect(error.message).not.toContain("private");
  });

  it.each(["json_object", "json_schema"] as const)("retains prepared evidence after an initial send timeout for %s", async (mode) => {
    const fetcher = vi.fn(async () => { throw new Error("connect timeout private detail"); });
    let error: any;
    try {
      await callTextProvider(profile, { systemPrompt: "private", input: "private", responseContract: contract(mode) } as never, transport(fetcher as typeof fetch));
    } catch (caught) { error = caught; }
    expect(fetcher).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ responseId: null, returnedModel: null, returnedProviderRoute: null, partialContent: "", preparedRequest: { body: expect.any(String), payloadHash: expect.any(String) } });
    expect(providerTransportErrorDetails(error)).toMatchObject({ timedOut: true, operation: "story generation" });
    expect(error.message).not.toContain("private detail");
  });

  it.each(["json_object", "json_schema"] as const)("retains complete length-finished output and null observed identities for %s", async (mode) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "complete-id", choices: [{ message: { content: "{}" }, finish_reason: "length" }], usage: {} }), { status: 200 }));
    const result = await callTextProvider(profile, { systemPrompt: "complete", input: "complete", responseContract: contract(mode) } as never, transport(fetcher as typeof fetch));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ content: "{}", finishReason: "length", outputLimited: true, responseId: "complete-id", returnedModel: null, returnedProviderRoute: null });
  });

  it.each(["json_object", "json_schema"] as const)("uses earlier SSE model and route observations for successful %s streams", async (mode) => {
    const response = new Response(sse([
      `data: ${JSON.stringify({ id: "stream-success", model: "early-model", provider: "early-route", choices: [{ delta: { content: "{}" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`
    ]), { status: 200, headers: { "content-type": "text/event-stream" } });
    const result = await callTextProvider(profile, { systemPrompt: "stream", input: "stream", onChunk: () => undefined, responseContract: contract(mode, true) } as never, transport(vi.fn(async () => response) as typeof fetch));
    expect(result).toMatchObject({ content: "{}", responseId: "stream-success", returnedModel: "early-model", returnedProviderRoute: "early-route" });
  });

  it.each(["json_object", "json_schema"] as const)("preserves provider transport details when a response body fails for %s", async (mode) => {
    const response = new Response(sse([], new Error("body timeout private detail")), { status: 200, headers: { "x-generation-id": "body-id" } });
    const { error, fetcher } = await failure(mode, response);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ responseId: "body-id", preparedRequest: { body: expect.any(String), payloadHash: expect.any(String) } });
    expect(providerTransportErrorDetails(error)).toMatchObject({ timedOut: true, operation: "story generation" });
    expect(error.message).not.toContain("private detail");
  });

  it("leaves historical response-format fallback behavior unchanged", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "response_format unsupported" } }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "legacy", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: {} }), { status: 200 }));
    await expect(callTextProvider(profile, { systemPrompt: "legacy", input: "legacy", canonicalBudgeting: true }, transport(fetcher as typeof fetch))).resolves.toMatchObject({ content: "{}" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
