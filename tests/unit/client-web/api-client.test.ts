import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createNexusApiClient,
  createNoopSessionPort
} from "../../../packages/client-web/src/index.js";
import * as apiClientModule from "../../../packages/client-web/src/api-client.js";
import type { HttpMethod } from "../../../packages/client-web/src/http-client.js";
import type {
  CampaignApi,
  GenerationApi,
  NexusApiClient,
  WorldApi
} from "../../../packages/client-web/src/index.js";
import type {
  CampaignSyncStatus,
  GenerationActionResponse,
  GenerationEnqueueResponse,
  GenerationRequest,
  GenerationResult,
  GenerationRetryLatestRequest,
  GenerationJobSnapshot
} from "../../../packages/contracts/src/index.js";
import { generationRequestSchema } from "../../../packages/contracts/src/index.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

const generationRequest: GenerationRequest = {
  action: "Search the observatory.",
  requestedInputMode: "action",
  resolvedInputMode: "action",
  inputModeSource: "explicit",
  idempotencyKey: "request-key-123",
  context: { budgetTokens: 32000, compression: "auto", recentTurns: 8 }
};

const replacementRequest: GenerationRetryLatestRequest = {
  ...generationRequest,
  expectedCurrentTurnNumber: 4
};

type RequestValidator = (
  schema: typeof generationRequestSchema,
  value: unknown,
  method: HttpMethod,
  path: string
) => GenerationRequest;

function invalidResponseFetch(): { fetchImpl: typeof fetch; urls: string[]; options: RequestInit[] } {
  const urls: string[] = [];
  const options: RequestInit[] = [];
  return {
    fetchImpl: async (input, init) => {
      urls.push(String(input));
      options.push(init ?? {});
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    },
    urls,
    options
  };
}

function expectResponseSchemaError(value: unknown): void {
  expect(value).toMatchObject({
    phase: "response",
    kind: "response_schema_mismatch"
  });
}

interface GenerationApiPort {
  syncStatus(campaignId: string): Promise<CampaignSyncStatus>;
  enqueue(campaignId: string, request: GenerationRequest): Promise<GenerationEnqueueResponse>;
  enqueueReplacement(campaignId: string, request: GenerationRetryLatestRequest): Promise<GenerationEnqueueResponse>;
  result(jobId: string): Promise<GenerationResult>;
  retry(jobId: string): Promise<GenerationActionResponse>;
  cancel(jobId: string): Promise<GenerationActionResponse>;
  discard(jobId: string): Promise<GenerationActionResponse>;
}

describe("createNexusApiClient", () => {
  it("exposes only the deliberate API groups, with a generation API assignable to the Task 5 port", () => {
    const queue = invalidResponseFetch();
    const client = createNexusApiClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });
    const generation: GenerationApiPort = client.generation;

    expect(generation).toBe(client.generation);
    expect(Object.keys(client).sort()).toEqual(["campaigns", "generation", "worlds"]);
    expect(Object.keys(client.worlds).sort()).toEqual(["list"]);
    expect(Object.keys(client.campaigns).sort()).toEqual(["list", "turns"]);
    expect(Object.keys(client.generation).sort()).toEqual([
      "cancel",
      "discard",
      "enqueue",
      "enqueueReplacement",
      "get",
      "result",
      "retry",
      "syncStatus"
    ]);
    expectTypeOf<NexusApiClient["worlds"]>().toEqualTypeOf<WorldApi>();
    expectTypeOf<NexusApiClient["campaigns"]>().toEqualTypeOf<CampaignApi>();
    expectTypeOf<NexusApiClient["generation"]>().toEqualTypeOf<GenerationApi>();
  });

  it("maps every adopted method to its API-relative endpoint and validates successful response schemas", async () => {
    const queue = invalidResponseFetch();
    const client = createNexusApiClient({ basePath: "/api/v1/", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });
    const signal = new AbortController().signal;
    const calls = [
      () => client.worlds.list(signal),
      () => client.campaigns.list(signal),
      () => client.campaigns.turns("campaign / id", signal),
      () => client.generation.syncStatus("campaign / id", signal),
      () => client.generation.enqueue(campaignId, generationRequest, signal),
      () => client.generation.enqueueReplacement(campaignId, replacementRequest, signal),
      () => client.generation.get("job / id", signal),
      () => client.generation.result("job / id", signal),
      () => client.generation.retry("job / id", signal),
      () => client.generation.cancel("job / id", signal),
      () => client.generation.discard("job / id", signal)
    ];

    for (const call of calls) expectResponseSchemaError(await call().catch((error: unknown) => error));

    expect(queue.urls).toEqual([
      "/api/v1/worlds",
      "/api/v1/campaigns",
      "/api/v1/campaigns/campaign%20%2F%20id/turns",
      "/api/v1/campaigns/campaign%20%2F%20id/sync-status",
      `/api/v1/campaigns/${campaignId}/generations`,
      `/api/v1/campaigns/${campaignId}/generations/retry-latest`,
      "/api/v1/generation-jobs/job%20%2F%20id",
      "/api/v1/generation-jobs/job%20%2F%20id/result",
      "/api/v1/generation-jobs/job%20%2F%20id/retry",
      "/api/v1/generation-jobs/job%20%2F%20id/cancel",
      "/api/v1/generation-jobs/job%20%2F%20id/discard"
    ]);
    expect(queue.options.map((option) => option.method)).toEqual([
      "GET", "GET", "GET", "GET", "POST", "POST", "GET", "GET", "POST", "POST", "POST"
    ]);
    expect(queue.options[4]?.body).toBe(JSON.stringify(generationRequest));
    expect(queue.options[5]?.body).toBe(JSON.stringify(replacementRequest));
    expect(queue.options.slice(8).map((option) => option.body)).toEqual([undefined, undefined, undefined]);
    expect(queue.options.every((option) => option.signal === signal)).toBe(true);
  });

  it("rejects invalid shared generation requests before the transport fetches", async () => {
    const queue = invalidResponseFetch();
    const client = createNexusApiClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });

    const enqueueError = await client.generation.enqueue(campaignId, { ...generationRequest, action: "" }, undefined).catch((error: unknown) => error);
    const replaceError = await client.generation.enqueueReplacement(campaignId, { ...replacementRequest, expectedCurrentTurnNumber: 0 }, undefined).catch((error: unknown) => error);

    expect(enqueueError).toMatchObject({
      phase: "request",
      kind: "request_schema_mismatch",
      method: "POST",
      path: `/campaigns/${campaignId}/generations`
    });
    expect(replaceError).toMatchObject({
      phase: "request",
      kind: "request_schema_mismatch",
      method: "POST",
      path: `/campaigns/${campaignId}/generations/retry-latest`
    });
    expect(queue.urls).toEqual([]);
  });

  it("preserves the actual method supplied for request-contract errors", () => {
    const validator = (apiClientModule as unknown as { validatedRequest?: RequestValidator }).validatedRequest;

    expect(validator).toBeTypeOf("function");
    if (!validator) throw new Error("validatedRequest must be available for request-contract validation.");

    let caught: unknown;
    try {
      validator(generationRequestSchema, { ...generationRequest, action: "" }, "PUT", "/campaigns/example/player-config");
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      phase: "request",
      kind: "request_schema_mismatch",
      method: "PUT",
      path: "/campaigns/example/player-config"
    });
  });

  it("returns validated action responses for the bodyless generation actions", async () => {
    const responses = ["queued", "cancelled", "discarded"];
    const queue = {
      urls: [] as string[],
      fetchImpl: async (input: RequestInfo | URL) => {
        queue.urls.push(String(input));
        const status = responses.shift();
        return new Response(JSON.stringify({ id: jobId, status }), { status: 202, headers: { "content-type": "application/json" } });
      }
    };
    const client = createNexusApiClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });

    await expect(client.generation.retry(jobId)).resolves.toMatchObject({ id: jobId, status: "queued" });
    await expect(client.generation.cancel(jobId)).resolves.toMatchObject({ id: jobId, status: "cancelled" });
    await expect(client.generation.discard(jobId)).resolves.toMatchObject({ id: jobId, status: "discarded" });
  });
});
