import { describe, expect, it } from "vitest";
import { createCampaignCastApi } from "../../packages/client-web/src/campaign-cast-api.js";
import Fastify from "fastify";
import { registerCampaignCastRoutes } from "../../services/api/src/campaign-cast-routes.js";
import { apiErrorEnvelopeSchema } from "../../packages/contracts/src/http.js";
describe("cast browser adapter", () => {
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
