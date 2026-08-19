import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createNexusApiClient,
  createNoopSessionPort
} from "../../../packages/client-web/src/index.js";
import { validatedRequest } from "../../../packages/client-web/src/api-client.js";
import type {
  CampaignApi,
  GenerationApi,
  IllustrationApi,
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
const worldVersionId = "33333333-3333-4333-8333-333333333333";

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
    expect(Object.keys(client).sort()).toEqual(["campaigns", "generation", "illustrations", "meta", "providers", "session", "worlds"]);
    expect(Object.keys(client.worlds).sort()).toEqual(["create", "list", "playableCharacters"]);
    expect(Object.keys(client.campaigns).sort()).toEqual([
      "branch", "classifyTurnInput", "correctTurnNarration", "create", "getTurnCorrection", "inspectState", "list", "readableExport", "rewind", "state", "turns", "updateState"
    ]);
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
    expectTypeOf<NexusApiClient["illustrations"]>().toEqualTypeOf<IllustrationApi>();
  });

  it("downloads readable Story exports through the authenticated Campaign API adapter", async () => {
    const authorization = vi.fn().mockResolvedValue({ authorization: "Bearer replacement-session" });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("# Accepted story", {
      status: 200,
      headers: { "content-type": "text/markdown;charset=utf-8" }
    }));
    const signal = new AbortController().signal;
    const client = createNexusApiClient({
      basePath: "/api/v1",
      session: { authorization, onUnauthorized: vi.fn().mockResolvedValue(false) },
      fetchImpl
    });

    const body = await client.campaigns.readableExport("campaign / id", "markdown", signal);

    expect(await body.text()).toBe("# Accepted story");
    expect(authorization).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/campaigns/campaign%20%2F%20id/readable-export?format=markdown",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        signal,
        headers: expect.any(Headers)
      })
    );
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer replacement-session");
    expect(headers.get("accept")).toBe("text/markdown");
  });

  it("exposes the typed Story Player projection and action surface instead of a generic request escape hatch", () => {
    const queue = invalidResponseFetch();
    const client = createNexusApiClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });
    const campaigns = client.campaigns as unknown as Record<string, unknown>;
    const shell = client as unknown as Record<string, unknown>;

    expect(typeof campaigns.state).toBe("function");
    expect(typeof campaigns.inspectState).toBe("function");
    expect(typeof campaigns.updateState).toBe("function");
    expect(typeof campaigns.getTurnCorrection).toBe("function");
    expect(typeof campaigns.correctTurnNarration).toBe("function");
    expect(typeof campaigns.classifyTurnInput).toBe("function");
    expect(typeof campaigns.rewind).toBe("function");
    expect(typeof campaigns.branch).toBe("function");
    expect(typeof shell.session).toBe("object");
    expect(typeof shell.meta).toBe("object");
    expect("request" in client).toBe(false);
  });

  it("maps every adopted method to its API-relative endpoint and validates successful response schemas", async () => {
    const queue = invalidResponseFetch();
    const client = createNexusApiClient({ basePath: "/api/v1/", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });
    const signal = new AbortController().signal;
    const calls = [
      () => client.worlds.list(signal),
      () => client.worlds.create({ title: "A New World" }, signal),
      () => client.worlds.playableCharacters("version / id", signal),
      () => client.campaigns.list(signal),
      () => client.campaigns.create({
        worldVersionId,
        title: "A New Campaign",
        selectedCharacterId: "observer",
        storyLengthProfile: "standard",
        turnControlStyle: "flexible_auto"
      }, signal),
      () => client.campaigns.turns("campaign / id", signal),
      () => client.campaigns.turns("campaign / id", { before: "older-page", limit: 3 }, signal),
      () => client.campaigns.state("campaign / id", undefined, signal),
      () => client.campaigns.state("campaign / id", 3, signal),
      () => client.campaigns.inspectState("campaign / id", 3, signal),
      () => client.campaigns.updateState(campaignId, {
        expectedTurnNumber: 3,
        expectedRevision: 2,
        continuitySummary: "",
        openThreads: [],
        canonicalFacts: [],
        scratchpad: "",
        trackers: [],
        rpgStats: [],
        eventTriggers: [],
        pendingEventTriggers: []
      }, signal),
      () => client.campaigns.getTurnCorrection(campaignId, worldVersionId, signal),
      () => client.campaigns.correctTurnNarration(campaignId, worldVersionId, {
        narration: "The gate opens beneath the moon.",
        expectedCorrectionRevision: 0,
        expectedActiveTurnNumber: 3,
        source: "user_edit"
      }, signal),
      () => client.campaigns.classifyTurnInput(campaignId, { text: "Open the dome.", preferredFallback: "action" }, signal),
      () => client.campaigns.rewind(campaignId, { targetTurnNumber: 2 }, signal),
      () => client.campaigns.branch(campaignId, { targetTurnNumber: 2 }, signal),
      () => client.generation.syncStatus("campaign / id", signal),
      () => client.generation.syncStatus("campaign / id", { since: "resume-token" }, signal),
      () => client.generation.enqueue(campaignId, generationRequest, signal),
      () => client.generation.enqueueReplacement(campaignId, replacementRequest, signal),
      () => client.generation.get("job / id", signal),
      () => client.generation.result("job / id", signal),
      () => client.generation.retry("job / id", signal),
      () => client.generation.cancel("job / id", signal),
      () => client.generation.discard("job / id", signal),
      () => client.meta.get(signal),
      () => client.session.get(signal),
      () => client.session.updateProfile({ displayName: "Initial Owner" }, signal),
      () => client.providers.list(signal),
      () => client.illustrations.config("campaign / id", signal),
      () => client.illustrations.segments("campaign / id", signal),
      () => client.illustrations.imageJobs("campaign / id", signal),
      () => client.illustrations.retryImageJob("job / id", signal),
      () => client.illustrations.regenerateSegmentImage("segment / id", { prompt: "A quiet road", variantIndex: 0 }, signal),
      () => client.illustrations.generateTurnSegments("turn / id", { mode: "missing", idempotencyKey: jobId }, signal),
      () => client.illustrations.resolution("turn / id", signal),
      () => client.illustrations.rematch("turn / id", signal)
    ];

    for (const call of calls) expectResponseSchemaError(await call().catch((error: unknown) => error));

    expect(queue.urls).toEqual([
      "/api/v1/worlds",
      "/api/v1/worlds",
      "/api/v1/world-versions/version%20%2F%20id/playable-characters",
      "/api/v1/campaigns",
      "/api/v1/campaigns",
      "/api/v1/campaigns/campaign%20%2F%20id/turns",
      "/api/v1/campaigns/campaign%20%2F%20id/turns?before=older-page&limit=3",
      "/api/v1/campaigns/campaign%20%2F%20id/state",
      "/api/v1/campaigns/campaign%20%2F%20id/state?turnNumber=3",
      "/api/v1/campaigns/campaign%20%2F%20id/state/inspection?turnNumber=3",
      `/api/v1/campaigns/${campaignId}/state`,
      `/api/v1/campaigns/${campaignId}/turns/${worldVersionId}/correction`,
      `/api/v1/campaigns/${campaignId}/turns/${worldVersionId}/correction`,
      `/api/v1/campaigns/${campaignId}/turn-input/classify`,
      `/api/v1/campaigns/${campaignId}/rewind`,
      `/api/v1/campaigns/${campaignId}/branch`,
      "/api/v1/campaigns/campaign%20%2F%20id/sync-status",
      "/api/v1/campaigns/campaign%20%2F%20id/sync-status?since=resume-token",
      `/api/v1/campaigns/${campaignId}/generations`,
      `/api/v1/campaigns/${campaignId}/generations/retry-latest`,
      "/api/v1/generation-jobs/job%20%2F%20id",
      "/api/v1/generation-jobs/job%20%2F%20id/result",
      "/api/v1/generation-jobs/job%20%2F%20id/retry",
      "/api/v1/generation-jobs/job%20%2F%20id/cancel",
      "/api/v1/generation-jobs/job%20%2F%20id/discard",
      "/api/v1/meta",
      "/api/v1/session",
      "/api/v1/users/me/profile",
      "/api/v1/providers",
      "/api/v1/campaigns/campaign%20%2F%20id/illustration-config",
      "/api/v1/campaigns/campaign%20%2F%20id/illustration-segments",
      "/api/v1/campaigns/campaign%20%2F%20id/image-jobs",
      "/api/v1/image-jobs/job%20%2F%20id/retry",
      "/api/v1/illustration-segments/segment%20%2F%20id/images",
      "/api/v1/turns/turn%20%2F%20id/illustration-segments",
      "/api/v1/turns/turn%20%2F%20id/illustration-resolution",
      "/api/v1/turns/turn%20%2F%20id/illustration-match"
    ]);
    expect(queue.options.map((option) => option.method)).toEqual([
      "GET", "POST", "GET", "GET", "POST", "GET", "GET", "GET", "GET", "GET", "PATCH", "GET", "PATCH", "POST", "POST", "POST",
      "GET", "GET", "POST", "POST", "GET", "GET", "POST", "POST", "POST", "GET", "GET", "PATCH", "GET",
      "GET", "GET", "GET", "POST", "POST", "POST", "GET", "POST"
    ]);
    expect(queue.options[18]?.body).toBe(JSON.stringify(generationRequest));
    expect(queue.options[19]?.body).toBe(JSON.stringify(replacementRequest));
    expect(queue.options.slice(22, 25).map((option) => option.body)).toEqual([undefined, undefined, undefined]);
    expect(queue.options[33]?.body).toBe(JSON.stringify({ prompt: "A quiet road", variantIndex: 0 }));
    expect(queue.options[34]?.body).toBe(JSON.stringify({ mode: "missing", idempotencyKey: jobId }));
    expect(queue.options.every((option) => option.signal === signal)).toBe(true);
  });

  it("rejects an unscoped turn page projection at the browser boundary", async () => {
    const client = createNexusApiClient({
      basePath: "/api/v1",
      session: createNoopSessionPort(),
      fetchImpl: async () => new Response(JSON.stringify({ turns: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    });

    await expect(client.campaigns.turns(campaignId)).rejects.toMatchObject({
      phase: "response",
      kind: "response_schema_mismatch",
      path: `/campaigns/${campaignId}/turns`
    });
  });

  it("rejects malformed replacement provenance in a sync response", async () => {
    const sync = {
      id: campaignId,
      title: "Campaign",
      activeTurnNumber: 1,
      worldVersionId,
      storyLengthProfile: "standard",
      turnControlStyle: "flexible_auto",
      updatedAt: "2026-08-02T00:00:00.000Z",
      selectedCharacterId: null,
      selectedCharacterName: "",
      characterSnapshot: null,
      characterProfile: null,
      characterProfileRevision: 0,
      status: "active",
      campaign: {
        id: campaignId,
        title: "Campaign",
        activeTurnNumber: 1,
        worldVersionId,
        storyLengthProfile: "standard",
        turnControlStyle: "flexible_auto",
        updatedAt: "2026-08-02T00:00:00.000Z",
        selectedCharacterId: null,
        selectedCharacterName: "",
        characterSnapshot: null,
        characterProfile: null,
        characterProfileRevision: 0,
        status: "active"
      },
      world: { id: "44444444-4444-4444-8444-444444444444", title: "World", versionNumber: 1, genre: "", tone: "", premise: "", backgroundStory: "", character: "", firstAction: "", rules: "", playableCharacters: [] },
      playerConfig: { selectedCharacterId: null, selectedCharacterName: "", characterSnapshot: null, characterProfile: null, characterProfileRevision: 0, rpgStats: [], trackers: [], eventTriggers: [], useRpgStats: false, suppressEventTriggers: false },
      pendingGeneration: null,
      syncToken: "sync-token",
      turnWindowMode: "unchanged",
      turns: null,
      generationRecovery: {
        id: jobId,
        status: "completed",
        operationKind: "replace_latest",
        expectedTurnNumber: 1,
        attempts: 1,
        errorCode: null,
        errorMessage: null,
        resultTurnId: "55555555-5555-4555-8555-555555555555",
        replacementTurnId: null
      }
    };
    const client = createNexusApiClient({
      basePath: "/api/v1",
      session: createNoopSessionPort(),
      fetchImpl: async () => new Response(JSON.stringify(sync), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    });

    await expect(client.generation.syncStatus(campaignId)).rejects.toMatchObject({
      phase: "response",
      kind: "response_schema_mismatch",
      path: `/campaigns/${campaignId}/sync-status`,
      issues: [expect.objectContaining({ path: ["generationRecovery", "replacementTurnId"] })]
    });
  });

  it("strips caller-supplied identity fields and never invents identity headers", async () => {
    const queue = invalidResponseFetch();
    const client = createNexusApiClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });

    await client.worlds.create({ title: "Owned by the server", user_id: "spoofed" } as never).catch(() => undefined);
    await client.campaigns.create({
      worldVersionId,
      title: "Owned by the server",
      selectedCharacterId: "observer",
      storyLengthProfile: "standard",
      turnControlStyle: "flexible_auto",
      user_id: "spoofed"
    } as never).catch(() => undefined);
    await client.session.updateProfile({ displayName: "Initial Owner", user_id: "spoofed" } as never).catch(() => undefined);

    expect(queue.options).toHaveLength(3);
    for (const option of queue.options) {
      const headers = new Headers(option.headers);
      expect(headers.has("x-user-id")).toBe(false);
      expect(headers.has("user_id")).toBe(false);
      expect(JSON.parse(String(option.body))).not.toHaveProperty("user_id");
    }
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

  it("validates bounded page and sync query options before the transport fetches", () => {
    const queue = invalidResponseFetch();
    const client = createNexusApiClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });

    expect(() => client.campaigns.turns(campaignId, { limit: 201 })).toThrow(expect.objectContaining({
      phase: "request",
      path: `/campaigns/${campaignId}/turns`
    }));
    expect(() => client.generation.syncStatus(campaignId, { since: "" })).toThrow(expect.objectContaining({
      phase: "request",
      path: `/campaigns/${campaignId}/sync-status`
    }));
    expect(queue.urls).toEqual([]);
  });

  it("preserves the actual method supplied for request-contract errors", () => {
    let caught: unknown;
    try {
      validatedRequest(generationRequestSchema, { ...generationRequest, action: "" }, "PUT", "/campaigns/example/player-config");
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
        return new Response(JSON.stringify({ id: jobId, status, operationKind: "append", replacementTurnId: null }), { status: 202, headers: { "content-type": "application/json" } });
      }
    };
    const client = createNexusApiClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: queue.fetchImpl });

    await expect(client.generation.retry(jobId)).resolves.toMatchObject({ id: jobId, status: "queued" });
    await expect(client.generation.cancel(jobId)).resolves.toMatchObject({ id: jobId, status: "cancelled" });
    await expect(client.generation.discard(jobId)).resolves.toMatchObject({ id: jobId, status: "discarded" });
  });
});
