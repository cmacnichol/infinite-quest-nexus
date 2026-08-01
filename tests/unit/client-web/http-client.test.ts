import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  NexusApiError,
  createNoopSessionPort
} from "../../../packages/client-web/src/index.js";
import { createNexusHttpClient } from "../../../packages/client-web/src/http-client.js";
import type { SessionPort } from "../../../packages/client-core/src/index.js";

const responseSchema = z.object({ value: z.string() });

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function fetchQueue(...responses: Array<Response | Error>): {
  fetchImpl: typeof fetch;
  urls: string[];
  options: RequestInit[];
} {
  const urls: string[] = [];
  const options: RequestInit[] = [];
  return {
    fetchImpl: async (input, init) => {
      urls.push(String(input));
      options.push(init ?? {});
      const next = responses.shift();
      if (!next) throw new Error("Unexpected fetch call.");
      if (next instanceof Error) throw next;
      return next;
    },
    urls,
    options
  };
}

function session(overrides: Partial<SessionPort> = {}): SessionPort {
  return {
    authorization: async () => ({}),
    onUnauthorized: async () => false,
    ...overrides
  };
}

describe("createNexusHttpClient", () => {
  it("normalizes the base path and parses every 2xx JSON response exactly once", async () => {
    const queue = fetchQueue(
      jsonResponse({ value: "first" }, 200),
      jsonResponse({ value: "second" }, 201),
      jsonResponse({ value: "third" }, 202)
    );
    const client = createNexusHttpClient({
      basePath: "/api/v1///",
      session: createNoopSessionPort(),
      fetchImpl: queue.fetchImpl
    });

    await expect(client.request({ method: "GET", path: "/first", responseSchema })).resolves.toEqual({ value: "first" });
    await expect(client.request({ method: "GET", path: "/second", responseSchema })).resolves.toEqual({ value: "second" });
    await expect(client.request({ method: "GET", path: "/third", responseSchema })).resolves.toEqual({ value: "third" });

    expect(queue.urls).toEqual(["/api/v1/first", "/api/v1/second", "/api/v1/third"]);
  });

  it("rejects non-relative, protocol-relative, and slashless request paths before fetching", async () => {
    const queue = fetchQueue(jsonResponse({ value: "unused" }));
    const client = createNexusHttpClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });

    await expect(client.request({ method: "GET", path: "campaigns", responseSchema })).rejects.toThrow("must begin with '/'");
    await expect(client.request({ method: "GET", path: "https://evil.test/campaigns", responseSchema })).rejects.toThrow("must be API-relative");
    await expect(client.request({ method: "GET", path: "//evil.test/campaigns", responseSchema })).rejects.toThrow("must be API-relative");
    expect(queue.urls).toEqual([]);
  });

  it("owns JSON and FormData transport headers while preserving caller-provided multipart boundaries", async () => {
    const queue = fetchQueue(jsonResponse({ value: "json" }), jsonResponse({ value: "form" }));
    const client = createNexusHttpClient({
      basePath: "/api/v1",
      session: session({ authorization: async () => ({ accept: "text/plain", "content-type": "text/plain", authorization: "Bearer fresh" }) }),
      fetchImpl: queue.fetchImpl
    });
    const form = new FormData();
    form.set("file", new Blob(["payload"], { type: "text/plain" }), "payload.txt");

    await client.request({ method: "POST", path: "/json", body: { kind: "json", value: { action: "continue" } }, responseSchema });
    await client.request({ method: "POST", path: "/form", body: { kind: "form-data", value: form }, responseSchema });

    const jsonHeaders = new Headers(queue.options[0]?.headers);
    expect(queue.options[0]).toMatchObject({ method: "POST", cache: "no-store", body: '{"action":"continue"}' });
    expect(jsonHeaders.get("accept")).toBe("application/json");
    expect(jsonHeaders.get("content-type")).toBe("application/json");
    expect(jsonHeaders.get("authorization")).toBe("Bearer fresh");

    const formHeaders = new Headers(queue.options[1]?.headers);
    expect(queue.options[1]).toMatchObject({ method: "POST", cache: "no-store", body: form });
    expect(formHeaders.get("accept")).toBe("application/json");
    expect(formHeaders.get("content-type")).toBeNull();
  });

  it("returns undefined for explicit successful empty responses", async () => {
    const queue = fetchQueue(new Response(null, { status: 204 }), new Response(null, { status: 205 }));
    const client = createNexusHttpClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });

    await expect(client.request({ method: "DELETE", path: "/first", responseKind: "empty" })).resolves.toBeUndefined();
    await expect(client.request({ method: "DELETE", path: "/second", responseKind: "empty" })).resolves.toBeUndefined();
  });

  it("guards JSON and blob contracts against an unexpected empty success response", async () => {
    const queue = fetchQueue(new Response(null, { status: 204 }), new Response(null, { status: 205 }));
    const client = createNexusHttpClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });

    const jsonError = await client.request({ method: "GET", path: "/json", responseSchema }).catch((error: unknown) => error);
    const blobError = await client.request({ method: "GET", path: "/blob", responseKind: "blob" }).catch((error: unknown) => error);

    expect(jsonError).toMatchObject({ kind: "unexpected_empty_response", method: "GET", path: "/json", statusCode: 204 });
    expect(blobError).toMatchObject({ kind: "unexpected_empty_response", method: "GET", path: "/blob", statusCode: 205 });
  });

  it("returns blob responses and applies their explicit accept header", async () => {
    const queue = fetchQueue(new Response(new Blob(["archive"]), { status: 200 }));
    const client = createNexusHttpClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });

    const output = await client.request({
      method: "GET",
      path: "/exports/campaign",
      responseKind: "blob",
      accept: "application/json, application/zip"
    });

    expect(await output.text()).toBe("archive");
    expect(new Headers(queue.options[0]?.headers).get("accept")).toBe("application/json, application/zip");
  });

  it("reports malformed JSON and response schema drift without retaining raw response bodies", async () => {
    const queue = fetchQueue(
      new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }),
      jsonResponse({ value: 4 }, 200, { "x-correlation-id": "corr-schema" })
    );
    const client = createNexusHttpClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });

    const malformed = await client.request({ method: "GET", path: "/malformed", responseSchema }).catch((error: unknown) => error);
    const mismatch = await client.request({ method: "GET", path: "/mismatch", responseSchema }).catch((error: unknown) => error);

    expect(malformed).toMatchObject({ kind: "malformed_json", phase: "response", path: "/malformed", statusCode: 200, correlationId: null });
    expect(mismatch).toMatchObject({ kind: "response_schema_mismatch", phase: "response", path: "/mismatch", statusCode: 200, correlationId: "corr-schema" });
    expect((malformed as Error).message).not.toContain("gateway");
  });

  it("maps structured HTTP errors, preserves envelope correlation priority, and falls back safely", async () => {
    const queue = fetchQueue(
      jsonResponse({
        error: "RateLimitError",
        message: "Too many generation requests.",
        correlationId: "envelope-correlation",
        code: "top-level-code",
        details: { code: "detail-code", limit: 12 },
        issues: [{ path: ["action"] }]
      }, 429, { "x-correlation-id": "header-correlation", "retry-after": " 120 " }),
      new Response("upstream unavailable", { status: 502, headers: { "x-correlation-id": "proxy-correlation" } }),
      new Response(null, { status: 404 })
    );
    const client = createNexusHttpClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });

    const structured = await client.request({ method: "GET", path: "/limited", responseSchema }).catch((error: unknown) => error);
    const proxy = await client.request({ method: "GET", path: "/proxy", responseSchema }).catch((error: unknown) => error);
    const empty = await client.request({ method: "GET", path: "/missing", responseSchema }).catch((error: unknown) => error);

    expect(structured).toMatchObject({
      name: "NexusApiError",
      errorName: "RateLimitError",
      statusCode: 429,
      correlationId: "envelope-correlation",
      domainCode: "detail-code",
      details: { code: "detail-code", limit: 12 },
      issues: [{ path: ["action"] }],
      retryAfter: "120"
    });
    expect(proxy).toMatchObject({
      message: "Request failed with HTTP 502.",
      correlationId: "proxy-correlation",
      errorName: "NexusApiError",
      domainCode: null
    });
    expect(empty).toMatchObject({
      message: "Request failed with HTTP 404.",
      correlationId: null,
      retryAfter: null
    });
  });

  it.each([408, 409, 425, 429, 500])("does not retry HTTP %i outside the authorization refresh path", async (status) => {
    const queue = fetchQueue(new Response(null, { status }));
    const client = createNexusHttpClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });

    await expect(client.request({ method: "GET", path: "/status", responseSchema })).rejects.toBeInstanceOf(NexusApiError);
    expect(queue.urls).toHaveLength(1);
  });

  it("preserves abort identity before and during fetch without manufacturing an HTTP error", async () => {
    const beforeFetch = new AbortController();
    const beforeFetchReason = new DOMException("Cancelled before fetch.", "AbortError");
    beforeFetch.abort(beforeFetchReason);
    const queue = fetchQueue();
    const client = createNexusHttpClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });

    await expect(client.request({ method: "GET", path: "/before", responseSchema, signal: beforeFetch.signal })).rejects.toBe(beforeFetchReason);
    expect(queue.urls).toEqual([]);

    const duringFetch = new DOMException("Cancelled during fetch.", "AbortError");
    const rejectedQueue = fetchQueue(duringFetch);
    const secondClient = createNexusHttpClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: rejectedQueue.fetchImpl });
    await expect(secondClient.request({ method: "GET", path: "/during", responseSchema })).rejects.toBe(duringFetch);
  });

  it("refreshes authorization at most once with fresh headers and the original POST payload", async () => {
    const queue = fetchQueue(
      jsonResponse({ error: "Unauthorized", message: "Refresh required.", correlationId: "first" }, 401),
      jsonResponse({ value: "accepted" }, 202)
    );
    let authorizationCalls = 0;
    let unauthorizedCalls = 0;
    const client = createNexusHttpClient({
      basePath: "/api/v1",
      session: session({
        authorization: async () => ({ authorization: `Bearer token-${++authorizationCalls}` }),
        onUnauthorized: async ({ statusCode }) => {
          unauthorizedCalls += 1;
          expect(statusCode).toBe(401);
          return true;
        }
      }),
      fetchImpl: queue.fetchImpl
    });

    await expect(client.request({ method: "POST", path: "/campaigns/campaign-1/generations", body: { kind: "json", value: { action: "continue" } }, responseSchema })).resolves.toEqual({ value: "accepted" });

    expect(authorizationCalls).toBe(2);
    expect(unauthorizedCalls).toBe(1);
    expect(queue.urls).toHaveLength(2);
    expect(new Headers(queue.options[0]?.headers).get("authorization")).toBe("Bearer token-1");
    expect(new Headers(queue.options[1]?.headers).get("authorization")).toBe("Bearer token-2");
    expect(queue.options.map((item) => item.body)).toEqual(['{"action":"continue"}', '{"action":"continue"}']);
  });

  it("does not replay when the session declines either unauthorized status", async () => {
    const queue = fetchQueue(
      jsonResponse({ error: "Unauthorized", message: "Authentication required.", correlationId: "first", details: {} }, 401),
      jsonResponse({ error: "Forbidden", message: "Access denied.", correlationId: "second", details: {} }, 403)
    );
    let callbackCalls = 0;
    const client = createNexusHttpClient({
      basePath: "/api/v1",
      session: session({ onUnauthorized: async () => {
        callbackCalls += 1;
        return false;
      } }),
      fetchImpl: queue.fetchImpl
    });

    await expect(client.request({ method: "GET", path: "/unauthorized", responseSchema })).rejects.toMatchObject({ statusCode: 401 });
    await expect(client.request({ method: "GET", path: "/forbidden", responseSchema })).rejects.toMatchObject({ statusCode: 403 });
    expect(callbackCalls).toBe(2);
    expect(queue.urls).toHaveLength(2);
  });

  it("does not refresh twice, and propagates session callback failures without another fetch", async () => {
    const queue = fetchQueue(
      jsonResponse({ error: "Unauthorized", message: "Refresh required.", correlationId: "first", details: {} }, 403),
      jsonResponse({ error: "Unauthorized", message: "Still unauthorized.", correlationId: "second", details: {} }, 401)
    );
    let callbackCalls = 0;
    const client = createNexusHttpClient({
      basePath: "/api/v1",
      session: session({ onUnauthorized: async () => (++callbackCalls === 1) }),
      fetchImpl: queue.fetchImpl
    });

    const error = await client.request({ method: "GET", path: "/protected", responseSchema }).catch((value: unknown) => value);
    expect(error).toMatchObject({ statusCode: 401, correlationId: "second" });
    expect(callbackCalls).toBe(1);
    expect(queue.urls).toHaveLength(2);

    const sessionFailure = new Error("Session refresh failed.");
    const failingQueue = fetchQueue(jsonResponse({ error: "Unauthorized", message: "Refresh required.", correlationId: "third", details: {} }, 401));
    const failingClient = createNexusHttpClient({
      basePath: "/api/v1",
      session: session({ onUnauthorized: async () => { throw sessionFailure; } }),
      fetchImpl: failingQueue.fetchImpl
    });
    await expect(failingClient.request({ method: "GET", path: "/callback-failure", responseSchema })).rejects.toBe(sessionFailure);
    expect(failingQueue.urls).toHaveLength(1);
  });

  it("checks abort state before the one allowed authorization replay", async () => {
    const queue = fetchQueue(jsonResponse({ error: "Unauthorized", message: "Refresh required.", correlationId: "first" }, 401));
    const controller = new AbortController();
    const abortReason = new DOMException("Cancelled while refreshing.", "AbortError");
    const client = createNexusHttpClient({
      basePath: "/api/v1",
      session: session({ onUnauthorized: async () => {
        controller.abort(abortReason);
        return true;
      } }),
      fetchImpl: queue.fetchImpl
    });

    await expect(client.request({ method: "GET", path: "/abort-replay", responseSchema, signal: controller.signal })).rejects.toBe(abortReason);
    expect(queue.urls).toHaveLength(1);
  });
});
