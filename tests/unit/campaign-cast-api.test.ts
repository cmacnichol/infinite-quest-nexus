import { describe, expect, it } from "vitest";
import { createCampaignCastApi } from "../../packages/client-web/src/campaign-cast-api.js";
import Fastify from "fastify";
import { registerCampaignCastRoutes } from "../../services/api/src/campaign-cast-routes.js";
import { dismissedReviewPageSchema, reviewDecisionResultSchema } from "../../packages/contracts/src/campaign-cast-review-decisions.js";
import { apiErrorEnvelopeSchema } from "../../packages/contracts/src/http.js";
describe("cast browser adapter", () => {
  it("reports unknown new capabilities when connected to an older server", async () => {
    const boundary = { turnNumber: 0, timelineRevision: 0 };
    let discoveryAvailable = true;
    const api = createCampaignCastApi({ basePath: "/api/v1", session: { authorization: async () => ({}), onUnauthorized: async () => false },
      fetchImpl: async url => {
        const path = String(url);
        if (path.endsWith("/workspace-status") || !discoveryAvailable && path.endsWith("/discovery")) return new Response("{}", { status: 404 });
        const body = path.endsWith("/discovery")
          ? { enabled: false, activeTurnNumber: 0, coverageStartTurn: null, trackedThroughTurn: null, state: "disabled", unresolvedCount: 0, firstGap: null }
          : { revision: 0, boundary, characters: [], nextCursor: null, capabilities: { castEditing: true } };
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      } });
    expect(await api.workspaceStatus("campaign")).toMatchObject({ legacyServer: true, capabilities: { editing: true, discovery: null, autoMatch: null, backfill: null, context: null }, counts: { identities: null, details: null, conflicts: null } });
    discoveryAvailable = false;
    expect(await api.workspaceStatus("campaign")).toMatchObject({ tracking: null, capabilities: { editing: true, discovery: null } });
  });
  it("uses validated review decision endpoints and rejects malformed results", async () => {
    const requests: string[] = [];
    let malformed = false;
    const id = "11111111-1111-4111-8111-111111111111";
    const boundary = { turnNumber: 0, timelineRevision: 0 };
    const result = { decisionId: id, candidateId: id, reviewRevision: 1, revision: 0, boundary, disposition: "dismiss_identity" };
    const api = createCampaignCastApi({ basePath: "/api/v1", session: { authorization: async () => ({}), onUnauthorized: async () => false },
      fetchImpl: async url => { requests.push(String(url)); return new Response(JSON.stringify(String(url).includes("view=dismissed")
        ? { reviewRevision: 1, revision: 0, boundary, decisions: [], nextCursor: null, ...(malformed ? { extra: true } : {}) }
        : { ...result, ...(malformed ? { boundary: { ...boundary, turnNumber: -1 } } : {}) }), { headers: { "content-type": "application/json" } }); } });
    const request = { action: "dismiss_identity" as const, expectedCastRevision: 0, expectedBoundary: boundary, expectedReviewRevision: 0, sourceHash: "a".repeat(64), idempotencyKey: "key" };
    expect(await api.reviewDecision(id, id, request)).toEqual(result);
    expect((await api.dismissedReview(id, { limit: 1 })).decisions).toEqual([]);
    expect(requests[0]).toContain(`/candidates/${id}/review-decisions`);
    expect(requests[1]).toContain("view=dismissed");
    malformed = true;
    await expect(api.reviewDecision(id, id, request)).rejects.toMatchObject({ phase: "response" });
    await expect(api.dismissedReview(id, {})).rejects.toMatchObject({ phase: "response" });
    await expect(api.dismissedReview(id, { limit: 51 })).rejects.toMatchObject({ phase: "request" });
  });
  it("rejects invalid nested fields and extra keys in review response contracts", () => {
    const id = "11111111-1111-4111-8111-111111111111", boundary = { turnNumber: 0, timelineRevision: 0 };
    const result = { decisionId: id, candidateId: id, reviewRevision: 1, revision: 0, boundary, disposition: "dismiss_identity" };
    expect(reviewDecisionResultSchema.safeParse({ ...result, extra: true }).success).toBe(false);
    expect(reviewDecisionResultSchema.safeParse({ ...result, boundary: { ...boundary, timelineRevision: -1 } }).success).toBe(false);
    expect(dismissedReviewPageSchema.safeParse({ revision: 0, reviewRevision: 1, boundary, nextCursor: null,
      decisions: [{ decisionId: id, candidateId: id, source: {}, target: { kind: "detail", observationIndex: -1, observation: {} }, canRestore: true }] }).success).toBe(false);
  });
  it("exposes review capabilities and gates new writes with editing", async () => {
    const app = Fastify();
    const boundary = { turnNumber: 0, timelineRevision: 0 };
    await app.register(registerCampaignCastRoutes, { application: { list: async () => ({ revision: 0, boundary, characters: [], nextCursor: null }) } as never,
      enabled: false, resolveOwner: async () => ({ ownerUserId: "22222222-2222-4222-8222-222222222222" }) });
    try {
      const base = "/api/v1/campaigns/11111111-1111-4111-8111-111111111111/cast";
      expect((await app.inject({ url: base })).json().capabilities).toMatchObject({ castReviewDecisions: false, castObservationDecisions: false, castReviewDecisionReadVersion: 1 });
      expect((await app.inject({ method: "POST", url: base + "/candidates/11111111-1111-4111-8111-111111111111/review-decisions", payload: {} })).statusCode).toBe(503);
    } finally { await app.close(); }
  });
  it("gates observation preview and apply routes when editing is disabled", async () => {
    const app = Fastify();
    await app.register(registerCampaignCastRoutes, { application: {} as never, enabled: false,
      resolveOwner: async () => ({ ownerUserId: "22222222-2222-4222-8222-222222222222" }) });
    try {
      const base = "/api/v1/campaigns/11111111-1111-4111-8111-111111111111/cast/11111111-1111-4111-8111-111111111111/observations/11111111-1111-4111-8111-111111111111";
      for (const suffix of ["/decision-preview", "/decision"]) {
        expect((await app.inject({ method: "POST", url: base + suffix, payload: {} })).statusCode).toBe(503);
      }
    } finally { await app.close(); }
  });
  it("validates observation decision requests before dispatch", async () => {
    let called = false;
    const api = createCampaignCastApi({ basePath: "/api/v1", session: { authorization: async () => ({}), onUnauthorized: async () => false },
      fetchImpl: async () => { called = true; return new Response("{}", { headers: { "content-type": "application/json" } }); } });
    await expect(api.previewObservationDecision("campaign", "character", "observation", { action: "restore" } as never)).rejects.toMatchObject({ phase: "request" });
    expect(called).toBe(false);
  });
  it("requests the filtered matches view", async () => {
    let requested = "";
    const api = createCampaignCastApi({ basePath: "/api/v1", session: { authorization: async () => ({}), onUnauthorized: async () => false },
      fetchImpl: async url => {
        requested = String(url);
        return new Response(JSON.stringify({ revision: 0, boundary: { turnNumber: 0, timelineRevision: 0 }, candidates: [], nextCursor: null }),
          { headers: { "content-type": "application/json" } });
      } });
    await api.candidates("campaign", { view: "matches", limit: 1 });
    expect(requested).toContain("view=matches");
    expect(requested).toContain("limit=1");
  });
  it("validates scan ranges before dispatch and preserves explicit Start keys", async () => {
    const sent: unknown[] = [];
    const progress = { id: "11111111-1111-4111-8111-111111111111", fromTurn: 1, throughTurn: 3,
      completeTurns: 0, failedTurns: 0, pendingReviewCount: 0, status: "queued" };
    const api = createCampaignCastApi({ basePath: "/api/v1", session: { authorization: async () => ({}), onUnauthorized: async () => false },
      fetchImpl: async (url, init) => { expect(String(url)).toContain("/cast/scans"); sent.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(progress), { headers: { "content-type": "application/json" } }); } });
    const request = { fromTurn: 1, throughTurn: 3, expectedBoundary: { turnNumber: 3, timelineRevision: 0 }, idempotencyKey: "scan-key" };
    await expect(api.scans.start("campaign", { ...request, fromTurn: 4 })).rejects.toMatchObject({ phase: "request" });
    expect(sent).toEqual([]);
    expect(await api.scans.start("campaign", request)).toEqual(progress);
    expect(sent).toEqual([request]);
  });
  it("reads and validates discovery status independently of story generation", async () => {
    const status = { enabled: true, state: "catching_up", activeTurnNumber: 3, coverageStartTurn: 3, trackedThroughTurn: 2,
      unresolvedCount: 0, firstGap: { turnNumber: 3, jobId: null, status: "missing", diagnosticCode: null } };
    let invalid = false;
    const api = createCampaignCastApi({ basePath: "/api/v1", session: { authorization: async () => ({}), onUnauthorized: async () => false },
      fetchImpl: async (url) => {
        expect(String(url)).toContain("/campaigns/campaign/cast/discovery");
        return new Response(JSON.stringify(invalid ? { ...status, state: "invented" } : status), { headers: { "content-type": "application/json" } });
      } });
    expect(await api.discoveryStatus("campaign")).toEqual(status);
    invalid = true;
    await expect(api.discoveryStatus("campaign")).rejects.toMatchObject({ name: "ApiContractError", phase: "response" });
  });
  it("rejects oversized list and forged write input before dispatch", async () => {
    const api = createCampaignCastApi({ basePath: "/api/v1", session: { authorization: async () => ({}), onUnauthorized: async () => false },
      fetchImpl: async () => { throw new Error("Unexpected network request"); } });
    await expect(api.list("campaign", { limit: 51 })).rejects.toMatchObject({ name: "ApiContractError", phase: "request" });
    await expect(api.create("campaign", { name: "Mara", ownerUserId: "forged" } as never)).rejects.toMatchObject({ name: "ApiContractError", phase: "request" });
  });
  it("exposes disabled editing as a typed browser-readable API error", async () => {
    const app = Fastify();
    await app.register(registerCampaignCastRoutes, { application: {} as never, enabled: false,
      resolveOwner: async () => ({ ownerUserId: "22222222-2222-4222-8222-222222222222" }) });
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/campaigns/11111111-1111-4111-8111-111111111111/cast", payload: {} });
      expect(response.statusCode).toBe(503);
      expect(apiErrorEnvelopeSchema.parse(response.json()).code).toBe("cast_editing_disabled");
    } finally { await app.close(); }
  });
});
