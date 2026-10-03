import { afterEach, describe, expect, it, vi } from "vitest";
import { callTextProvider, type TextProviderProfile } from "../../packages/story-engine/src/providers.js";
import { createProviderTransport } from "../../packages/story-engine/src/provider-transport.js";
import { captureProviderFailure } from "../../packages/story-engine/src/provider-failure-diagnostics.js";
import { MAX_PROVIDER_JSON_RESPONSE_BYTES } from "../../packages/story-engine/src/provider-response.js";
import type { Dispatcher } from "undici";
import { providerFailureEvidenceSchema } from "../../packages/contracts/src/provider-failure.js";
import { logger } from "../../packages/logger/src/index.js";
const now = new Date("2026-10-03T12:00:00.000Z");
const profile: TextProviderProfile = { providerType: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "@preset/test", contextWindowTokens: 32768, maxOutputTokens: 1024, temperature: 0.5 };
const contract = { version: 1, mode: "json_object", operation: "story", streaming: false, forbidFormatFallback: true } as const;
const input = { source: "http_error", httpStatus: 429, headers: null, body: {}, bodyStatus: "parsed", observedAt: now, knownProviderNames: ["DeepInfra"], successfulResponseStarted: false, emittedOutput: false } as const;
async function failure(response: Response, streaming = false, baseUrl = profile.baseUrl) {
  const fetcher = vi.fn(async (_url: unknown, _options?: RequestInit) => response);
  const transport = createProviderTransport({ fetcher: fetcher as typeof fetch, dispatcherFactory: () => ({ close: async () => {}, destroy: () => {} }) as unknown as Dispatcher, policy: { async approve(url) { return { url, origin: url.origin, address: "127.0.0.1", family: 4, port: 443, servername: url.hostname }; } } });
  const request = { systemPrompt: "private", input: "private", responseContract: { ...contract, streaming }, knownProviderNames: ["DeepInfra"], ...(streaming ? { onChunk: vi.fn() } : {}) };
  const error = await callTextProvider({ ...profile, baseUrl }, request, transport).catch(e => e);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]?.[1]?.body)).toBe(error.preparedRequest.body);
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ model: "@preset/test", response_format: { type: "json_object" } });
  return error;
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("safe provider failure capture", () => {
  it.each(["0", "2", "Sat, 03 Oct 2026 12:00:02 GMT"])("parses retry %s using observation time", value => {
    expect(captureProviderFailure({ ...input, headers: new Headers({ "retry-after": value }) })).toMatchObject({ retryAfterMs: value === "0" ? 0 : 2000, retryAt: value === "0" ? now.toISOString() : "2026-10-03T12:00:02.000Z" });
  });
  it.each(["-1", "NaN", "Infinity", "86401", "Sat, 03 Oct 2026 11:59:59 GMT"])("rejects retry %s", value => {
    expect(captureProviderFailure({ ...input, headers: new Headers({ "retry-after": value }) }).retryAfterMs).toBeNull();
  });
  it("keeps unsupported reset units unknown and rejects uncorroborated identity", () => {
    expect(captureProviderFailure({ ...input, headers: new Headers({ "x-ratelimit-limit": "10", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791028802" }), body: { error: { code: "rate_limit_exceeded", metadata: { provider_name: "Unknown", raw: "PRIVATE", remedy_hint: "PRIVATE" }, message: "PRIVATE" } } })).toMatchObject({ providerName: null, limitSource: "unknown", rateLimit: { limit: 10, remaining: 0, resetAt: null } });
  });
  it("recognizes documented native provider code only as source corroboration", () => {
    const evidence = captureProviderFailure({ ...input, isOpenRouter: true, body: { error: { metadata: { error_type: "rate_limit_exceeded", provider_code: "rate_limited" } } } });
    expect(evidence).toMatchObject({ upstreamCode: "rate_limit_exceeded", limitSource: "upstream_provider" });
    expect(JSON.stringify(evidence)).not.toContain('"rate_limited"');
  });
  it("reports absent, unknown and malformed metadata without copying unknown fields", () => {
    expect(captureProviderFailure(input).metadataStatus).toBe("absent");
    expect(captureProviderFailure({ ...input, body: { error: { metadata: "PRIVATE" } } }).metadataStatus).toBe("malformed");
    const evidence = captureProviderFailure({ ...input, body: { error: { code: "PRIVATE", metadata: { provider_name: "Unknown", raw: "PRIVATE" } } } });
    expect(evidence).toMatchObject({ metadataStatus: "unrecognized", providerName: null, upstreamCode: null });
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE");
  });
  it.each([["upstream_provider"], { value: "upstream_provider" }])("rejects malformed limit source %j and returns schema-valid evidence", limit_source => {
    const evidence = captureProviderFailure({ ...input, body: { error: { metadata: { limit_source } } } });
    expect(evidence.limitSource).toBe("unknown");
    expect(providerFailureEvidenceSchema.safeParse(evidence).success).toBe(true);
  });
  it("captures HTTP 429 identity, metadata, and retry through prepared wrapping", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const error = await failure(new Response(JSON.stringify({ error: { code: 429, metadata: { provider_name: "DeepInfra", provider_code: "rate_limit_exceeded", limit_source: "upstream_provider" }, message: "PRIVATE" } }), { status: 429, headers: { "x-generation-id": "gen-rejected", "retry-after": "2" } }));
    expect(error.responseId).toBe("gen-rejected");
    expect(error.providerFailure).toMatchObject({ httpStatus: 429, upstreamStatus: 429, reason: "rate_limit", providerName: "DeepInfra", successfulResponseStarted: false, emittedOutput: false, retryAfterMs: 2000, metadataStatus: "recognized" });
    expect(JSON.stringify(error.providerFailure)).not.toContain("PRIVATE");
  });
  it.each([[401,"authentication"],[402,"authentication"],[403,"authentication"],[404,"model_unavailable"],[503,"provider_unavailable"]])("captures HTTP %s", async (status, reason) => {
    expect((await failure(new Response("{}", { status: Number(status) }))).providerFailure).toMatchObject({ httpStatus: status, reason });
  });
  it.each([["", "absent"], ["not JSON", "malformed"], ["x".repeat(MAX_PROVIDER_JSON_RESPONSE_BYTES + 1), "oversized"]])("preserves headers when body is %s", async (body, metadataStatus) => {
    expect((await failure(new Response(body, { status: 429, headers: { "retry-after": "2" } }))).providerFailure).toMatchObject({ httpStatus: 429, retryAfterMs: 2000, metadataStatus });
  });
  it("attributes rate headers only at a verified OpenRouter endpoint", async () => {
    for (const [url, limitSource] of [[profile.baseUrl, "openrouter_platform"], ["https://compatible.test/v1", "unknown"]]) {
      expect((await failure(new Response("{}", { status: 429, headers: { "x-ratelimit-limit": "5" } }), false, url)).providerFailure.limitSource).toBe(limitSource);
    }
  });
  it.each([false, true])("captures SSE error after output=%s with usage and partial content", async output => {
    const content = output ? 'data: {"id":"gen-stream","choices":[{"delta":{"content":"partial"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' : "";
    const error = await failure(new Response(content + 'data: {"error":{"code":429,"metadata":{"provider_code":"rate_limit_exceeded"}}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }), true);
    expect(error.providerFailure).toMatchObject({ source: "sse_error", httpStatus: 200, upstreamStatus: 429, successfulResponseStarted: true, emittedOutput: output });
    expect(error.partialContent).toBe(output ? "partial" : "");
    if (output) expect(error.observedUsage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
  });
  it("preserves stream interruption evidence", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    let reads = 0;
    const stream = new ReadableStream({ pull(controller) { if (reads++ === 0) controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')); else controller.error(new Error("socket terminated")); } });
    const error = await failure(new Response(stream, { headers: { "content-type": "text/event-stream" } }), true);
    expect(error.providerFailure).toMatchObject({ source: "transport_error", httpStatus: 200, successfulResponseStarted: true, emittedOutput: true });
    expect(error.partialContent).toBe("partial");
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ event: "provider_transport_error" }));
  });
});
