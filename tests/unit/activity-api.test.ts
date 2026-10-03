import { describe, expect, it, vi } from "vitest";
import { createActivityApi } from "../../packages/client-web/src/activity-api.js";
import { createNexusHttpClient } from "../../packages/client-web/src/http-client.js";
import { ApiContractError, NexusApiError } from "../../packages/client-core/src/errors.js";
const id = "11111111-1111-4111-8111-111111111111";
const page = { version: 1, events: [], nextBefore: null, nextAfter: null, hasMore: false, coverage: { capturedSince: null, retentionDays: 30, oldestAvailableSequence: null, latestPublishedSequence: "0", pendingPublication: false, incomplete: false, resetRequired: false } };
function fixture(response: Response) {
  const fetchImpl = vi.fn().mockResolvedValue(response);
  const http = createNexusHttpClient({ basePath: "/api/v1", session: { authorization: async () => ({}), onUnauthorized: async () => false }, fetchImpl });
  return { api: createActivityApi({ http }), fetchImpl };
}
describe("activity transport", () => {
  it.each([{ limit: 100 }, { limit: 2, before: "opaque+/=" }, { limit: 200, after: "opaque" }])("uses GET, encoded query and abort signal %s", async query => {
    const { api, fetchImpl } = fixture(Response.json(page)); const controller = new AbortController();
    expect(await api.list(id, query, controller.signal)).toEqual(page);
    const [path, init] = fetchImpl.mock.calls[0]!;
    const url = new URL(path, "http://local"); expect(url.pathname).toBe(`/api/v1/campaigns/${id}/activity`);
    expect(url.searchParams.get("limit")).toBe(String(query.limit)); expect(init.method).toBe("GET"); expect(init.signal).toBe(controller.signal); expect(init.body).toBeUndefined();
  });
  it.each([404,401,403,500])("retains status and correlation for %s without fallback", async status => {
    const { api } = fixture(Response.json({ error: "ActivityError", message: "Unavailable", code: "activity_unavailable", correlationId: "safe-correlation", details: {} }, { status }));
    await expect(api.list(id, { limit: 100 })).rejects.toMatchObject({ statusCode: status, correlationId: "safe-correlation", domainCode: "activity_unavailable" });
  });
  it("distinguishes unsupported-route HTTP errors from malformed successes", async () => {
    await expect(fixture(new Response("Not found", { status:404 })).api.list(id, { limit:100 })).rejects.toBeInstanceOf(NexusApiError);
    await expect(fixture(Response.json({ ...page, private:"CANARY" })).api.list(id, { limit:100 })).rejects.toBeInstanceOf(ApiContractError);
    await expect(fixture(new Response("invalid", { status:200 })).api.list(id, { limit:100 })).rejects.toMatchObject({ kind:"malformed_json" });
  });
  it("validates IDs and strict query before sending", async () => {
    const { api, fetchImpl } = fixture(Response.json(page));
    await expect(api.list("bad", { limit:100 })).rejects.toMatchObject({ phase:"request" });
    await expect(api.list(id, { limit:201 })).rejects.toMatchObject({ phase:"request" });
    await expect(api.list(id, { limit:100, before:"a", after:"b" })).rejects.toMatchObject({ phase:"request" }); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects an aborted request even when a transport resolves late", async () => {
    const controller = new AbortController();
    const api = createActivityApi({ http: { request: vi.fn(async () => { controller.abort(); return page; }) } as never });
    await expect(api.list(id, { limit:100 }, controller.signal)).rejects.toMatchObject({ name:"AbortError" });
  });
});
