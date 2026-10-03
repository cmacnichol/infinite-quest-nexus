import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReaderHistoryApplication } from "../../packages/application/src/reader-history/index.js";
import { readerHistoryRequestSchema, readerTurnNumberSchema } from "../../packages/contracts/src/reader-history.js";
import type { TurnSummary } from "../../packages/contracts/src/client-api.js";
import { createReaderHistoryApi } from "../../packages/client-web/src/reader-history-api.js";
import type { NexusHttpClient } from "../../packages/client-web/src/http-client.js";
import { registerReaderHistoryRoutes } from "../../services/api/src/reader-history-routes.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const ownerUserId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";

function turnSummary(overrides: Partial<TurnSummary> = {}): TurnSummary {
  return {
    id: turnId,
    turnNumber: 2,
    action: "Open the gate.",
    inputMode: "action",
    inputModeSource: "explicit",
    narration: "The gate opens.",
    choices: [],
    customActionSuggestion: "",
    imagePrompt: "",
    imageUrl: null,
    acceptedAt: "2026-10-01T12:00:00.000Z",
    chronicleRetrieval: null,
    reportedCost: null,
    ...overrides
  };
}

describe("exact reader turn route", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function buildApp(application: ReaderHistoryApplication): Promise<FastifyInstance> {
    const app = Fastify();
    await app.register(registerReaderHistoryRoutes, {
      application,
      resolveOwner: async () => ({ ownerUserId })
    });
    apps.push(app);
    return app;
  }

  it("accepts only positive integer turn numbers", () => {
    expect(readerTurnNumberSchema.parse(1)).toBe(1);
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(readerTurnNumberSchema.safeParse(value).success).toBe(false);
    }
  });

  it("looks up the exact effective turn using only the server-resolved owner scope", async () => {
    const getEffectiveTurn = vi.fn().mockResolvedValue(turnSummary({ narration: "The corrected gate opens." }));
    const app = await buildApp({ getEffectiveTurn } as unknown as ReaderHistoryApplication);

    const response = await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/reader/turns/2` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      campaignId,
      turn: expect.objectContaining({ id: turnId, turnNumber: 2, narration: "The corrected gate opens." })
    });
    expect(getEffectiveTurn).toHaveBeenCalledWith({ ownerUserId, campaignId }, 2);
  });

  it("rejects a non-positive or non-integer number before the repository is called", async () => {
    const getEffectiveTurn = vi.fn();
    const app = await buildApp({ getEffectiveTurn } as unknown as ReaderHistoryApplication);

    for (const turnNumber of ["0", "-1", "1.5", "nope"]) {
      const response = await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/reader/turns/${turnNumber}` });
      expect(response.statusCode).toBe(400);
    }
    expect(getEffectiveTurn).not.toHaveBeenCalled();
  });

  it("uses the same not-found response for unavailable campaigns and turns", async () => {
    const getEffectiveTurn = vi.fn().mockResolvedValue(null);
    const app = await buildApp({ getEffectiveTurn } as unknown as ReaderHistoryApplication);

    const response = await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/reader/turns/2` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Turn not found." });
    expect(JSON.stringify(response.json())).not.toContain(ownerUserId);
    expect(JSON.stringify(response.json())).not.toContain(turnId);
  });
});

describe("reader history browser API", () => {
  it("requests one exact turn and forwards the abort signal", async () => {
    const expected = { campaignId, turn: turnSummary() };
    const request = vi.fn().mockResolvedValue(expected);
    const api = createReaderHistoryApi({ request } as unknown as NexusHttpClient);
    const signal = new AbortController().signal;

    await expect(api.getTurn(campaignId, 2, signal)).resolves.toBe(expected);

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      path: `/campaigns/${campaignId}/reader/turns/2`,
      signal
    }));
  });

  it("rejects an invalid requested turn number before sending HTTP", () => {
    const request = vi.fn();
    const api = createReaderHistoryApi({ request } as unknown as NexusHttpClient);

    expect(() => api.getTurn(campaignId, 0)).toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("campaign reader history contract", () => {
  it("trims search text and applies the bounded default page size", () => {
    expect(readerHistoryRequestSchema.parse({ q: "  gate  " })).toEqual({ q: "gate", limit: 50 });
  });

  it("rejects search text over 200 characters and limits outside 1 through 50", () => {
    for (const request of [
      { q: "x".repeat(201) },
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 }
    ]) {
      expect(readerHistoryRequestSchema.safeParse(request).success).toBe(false);
    }
  });

  it("requests campaign-wide summaries with the cursor and abort signal", async () => {
    const request = vi.fn().mockResolvedValue({ campaignId, items: [], nextCursor: null });
    const api = createReaderHistoryApi({ request } as unknown as NexusHttpClient);
    const signal = new AbortController().signal;

    await api.searchHistory(campaignId, { q: " gate ", before: "opaque", limit: 7 }, signal);

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      path: `/campaigns/${campaignId}/reader/history?q=gate&before=opaque&limit=7`,
      signal
    }));
  });
});
