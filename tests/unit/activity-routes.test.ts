import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerActivityRoutes } from "../../services/api/src/activity-routes.js";
import { ActivityRepositoryError } from "../../packages/database/src/activity-repository.js";
const campaignId = "11111111-1111-4111-8111-111111111111";
const ownerUserId = "22222222-2222-4222-8222-222222222222";
const page: import("../../packages/contracts/src/activity.js").ActivityPage = { version: 1, events: [], nextBefore: null, nextAfter: null, hasMore: false, coverage: { capturedSince: null, retentionDays: 30, oldestAvailableSequence: null, latestPublishedSequence: "0", pendingPublication: false, incomplete: false, resetRequired: false } };
describe("activity routes", () => {
  it("validates campaign IDs and exposes only GET", async () => {
    const app = Fastify(); const list = vi.fn().mockResolvedValue(page);
    await app.register(registerActivityRoutes, { resolveOwner: async () => ({ ownerUserId }), activityReader: { list } });
    expect((await app.inject("/api/v1/campaigns/invalid/activity")).statusCode).toBe(400);
    for (const method of ["POST", "DELETE"] as const) expect((await app.inject({ method, url: `/api/v1/campaigns/${campaignId}/activity` })).statusCode).toBe(404);
    expect(list).not.toHaveBeenCalled(); await app.close();
  });
  it.each(["", "?before=opaque&limit=2", "?after=opaque&limit=200"])("passes scoped reads %s", async query => {
    const app = Fastify(); const list = vi.fn().mockResolvedValue(page);
    await app.register(registerActivityRoutes, { resolveOwner: async () => ({ ownerUserId }), activityReader: { list } });
    const response = await app.inject({ url: `/api/v1/campaigns/${campaignId}/activity${query}`, headers: { "x-owner-user-id": "spoof" } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual(page);
    expect(list.mock.calls[0]?.[0]).toEqual({ campaignId, ownerUserId }); await app.close();
  });
  it.each(["?limit=201", "?limit=0", "?before=a&after=b", "?ownerUserId=spoof", `?before=${"a".repeat(513)}`, "?limit=1&limit=2"])("rejects invalid query %s", async query => {
    const app = Fastify(); const list = vi.fn();
    await app.register(registerActivityRoutes, { resolveOwner: async () => ({ ownerUserId }), activityReader: { list } });
    const response = await app.inject(`/api/v1/campaigns/${campaignId}/activity${query}`);
    expect(response.statusCode).toBe(400); expect(list).not.toHaveBeenCalled(); expect(response.json().issues).toBeUndefined(); await app.close();
  });
  it.each([["not_found",404],["invalid_cursor",400],["invalid_snapshot",500]] as const)("maps %s safely", async (code,status) => {
    const app = Fastify();
    await app.register(registerActivityRoutes, { resolveOwner: async () => ({ ownerUserId }), activityReader: { list: async () => { throw new ActivityRepositoryError(code); } } });
    const response = await app.inject(`/api/v1/campaigns/${campaignId}/activity`);
    expect(response.statusCode).toBe(status); expect(response.json().correlationId).toBeTruthy(); expect(response.json().details).toEqual({}); await app.close();
  });
  it("sanitizes corrupt output and unexpected failures", async () => {
    for (const value of [{ ...page, private: "CANARY" }, { ...page, events: Array.from({ length: 201 }, () => ({})) }, new Error("CANARY SQL details")]) {
      const app = Fastify();
      await app.register(registerActivityRoutes, { resolveOwner: async () => ({ ownerUserId }), activityReader: { list: async () => { if (value instanceof Error) throw value; return value as typeof page; } } });
      const response = await app.inject(`/api/v1/campaigns/${campaignId}/activity`);
      expect(response.statusCode).toBe(500); expect(response.body).not.toContain("CANARY"); expect(response.body).not.toContain("issues"); await app.close();
    }
  });
});
