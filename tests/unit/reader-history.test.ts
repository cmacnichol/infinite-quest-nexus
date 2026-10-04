import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReaderHistoryApplication, type ReaderHistoryApplication } from "../../packages/application/src/reader-history/index.js";
import {
  readerHistoryRequestSchema,
  readerSceneWindowRequestSchema,
  readerSceneWindowResponseSchema,
  readerTurnNumberSchema
} from "../../packages/contracts/src/reader-history.js";
import type { TurnSummary } from "../../packages/contracts/src/client-api.js";
import { createReaderHistoryApi } from "../../packages/client-web/src/reader-history-api.js";
import type { NexusHttpClient } from "../../packages/client-web/src/http-client.js";
import { registerReaderHistoryRoutes } from "../../services/api/src/reader-history-routes.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const ownerUserId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";
const historyToken = "opaque-scene-token";

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

  it("loads one bounded scene window with the exact anchor and optional history token", async () => {
    const expected = {
      campaignId,
      anchor: { turnNumber: 2, id: turnId },
      direction: "newer",
      turns: [turnSummary()],
      hasMore: false,
      historyToken: "opaque-scene-token"
    };
    const request = vi.fn().mockResolvedValue(expected);
    const api = createReaderHistoryApi({ request } as unknown as NexusHttpClient);
    const signal = new AbortController().signal;

    await expect(api.getSceneWindow(campaignId, {
      anchorTurnNumber: 2,
      anchorTurnId: turnId,
      direction: "newer",
      neighborLimit: 4,
      historyToken: "opaque-scene-token"
    }, signal)).resolves.toBe(expected);

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      path: `/campaigns/${campaignId}/reader/scene-window?anchorTurnNumber=2&anchorTurnId=${turnId}&direction=newer&neighborLimit=4&historyToken=opaque-scene-token`,
      signal
    }));
    expect(request.mock.calls[0]?.[0]).toHaveProperty("responseSchema", readerSceneWindowResponseSchema);
  });

  it("validates scene-window parameters before sending HTTP", () => {
    const request = vi.fn();
    const api = createReaderHistoryApi({ request } as unknown as NexusHttpClient);

    expect(() => api.getSceneWindow(campaignId, {
      anchorTurnNumber: 2,
      anchorTurnId: turnId,
      direction: "older",
      neighborLimit: 10
    })).toThrow();
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

  it("defaults bounded scene windows to nine neighbors and validates direction and limits", () => {
    expect(readerSceneWindowRequestSchema.parse({
      anchorTurnNumber: "12",
      anchorTurnId: turnId,
      direction: "older"
    })).toEqual({ anchorTurnNumber: 12, anchorTurnId: turnId, direction: "older", neighborLimit: 9 });
    for (const value of [0, 10, 1.5]) {
      expect(readerSceneWindowRequestSchema.safeParse({
        anchorTurnNumber: 12,
        anchorTurnId: turnId,
        direction: "older",
        neighborLimit: value
      }).success).toBe(false);
    }
    expect(readerSceneWindowRequestSchema.safeParse({
      anchorTurnNumber: 12,
      anchorTurnId: turnId,
      direction: "sideways"
    }).success).toBe(false);
  });

  it("requires a bounded ordered window with the requested anchor on the direction edge", () => {
    const response = {
      campaignId,
      anchor: { turnNumber: 2, id: turnId },
      direction: "older",
      turns: [turnSummary({ turnNumber: 1, id: "44444444-4444-4444-8444-444444444444" }), turnSummary()],
      hasMore: false,
      historyToken: "opaque-scene-token"
    };
    expect(readerSceneWindowResponseSchema.safeParse(response).success).toBe(true);
    expect(readerSceneWindowResponseSchema.safeParse({
      ...response,
      turns: [...response.turns].reverse()
    }).success).toBe(false);
    expect(readerSceneWindowResponseSchema.safeParse({
      ...response,
      turns: [turnSummary({ turnNumber: 1, id: "44444444-4444-4444-8444-444444444444" })]
    }).success).toBe(false);
  });
});

describe("reader scene window route", () => {
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

  it("uses server owner scope and returns the validated bounded scene window", async () => {
    const expected = {
      anchor: { turnNumber: 2, id: turnId },
      direction: "newer",
      turns: [turnSummary()],
      hasMore: false,
      historyToken: "opaque-scene-token"
    };
    const getSceneWindow = vi.fn().mockResolvedValue(expected);
    const app = await buildApp({ getSceneWindow } as unknown as ReaderHistoryApplication);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/reader/scene-window?anchorTurnNumber=2&anchorTurnId=${turnId}&direction=newer&neighborLimit=3`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ campaignId, ...expected });
    expect(getSceneWindow).toHaveBeenCalledWith({ ownerUserId, campaignId }, {
      anchorTurnNumber: 2,
      anchorTurnId: turnId,
      direction: "newer",
      neighborLimit: 3
    });
  });

  it("rejects malformed scene-window parameters before repository access", async () => {
    const getSceneWindow = vi.fn();
    const app = await buildApp({ getSceneWindow } as unknown as ReaderHistoryApplication);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/reader/scene-window?anchorTurnNumber=2&anchorTurnId=${turnId}&direction=older&neighborLimit=10`
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).not.toContain(ownerUserId);
    expect(getSceneWindow).not.toHaveBeenCalled();
  });

  it.each([
    [404, null],
    [409, "reader_anchor_changed"],
    [409, "reader_history_changed"],
    [400, "invalid_history_token"]
  ] as const)("maps %i %s to a safe scene-window error", async (statusCode, code) => {
    const getSceneWindow = vi.fn().mockRejectedValue(Object.assign(new Error("private detail"), {
      statusCode,
      details: { code }
    }));
    const app = await buildApp({ getSceneWindow } as unknown as ReaderHistoryApplication);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/reader/scene-window?anchorTurnNumber=2&anchorTurnId=${turnId}&direction=older`
    });

    expect(response.statusCode).toBe(statusCode);
    if (code) expect(response.json().code).toBe(code);
    expect(JSON.stringify(response.json())).not.toContain("private detail");
  });
});

describe("reader scene window application", () => {
  it("validates bounded options and supplies only the caller's scoped identity to the repository", async () => {
    const getSceneWindow = vi.fn().mockResolvedValue(null);
    const application = createReaderHistoryApplication({
      turns: {
        getEffectiveTurn: vi.fn(),
        searchHistory: vi.fn(),
        getSceneWindow
      }
    });
    const request = {
      anchorTurnNumber: 2,
      anchorTurnId: turnId,
      direction: "older" as const,
      neighborLimit: 4,
      historyToken
    };

    await expect(application.getSceneWindow({ ownerUserId, campaignId }, request)).resolves.toBeNull();
    expect(getSceneWindow).toHaveBeenCalledWith({ ownerUserId, campaignId }, request);
    await expect(application.getSceneWindow({ ownerUserId, campaignId: " " }, request)).rejects.toMatchObject({ statusCode: 400 });
    await expect(application.getSceneWindow({ ownerUserId, campaignId }, { ...request, neighborLimit: 10 })).rejects.toThrow();
    expect(getSceneWindow).toHaveBeenCalledTimes(1);
  });
});
