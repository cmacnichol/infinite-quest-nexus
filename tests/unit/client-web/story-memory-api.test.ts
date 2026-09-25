import { describe, expect, it, vi } from "vitest";
import * as clientWeb from "../../../packages/client-web/src/index.js";

const settings = { level: "max", reviewMode: "enforce", availableLevels: ["off", "standard", "enhanced", "max"] };

describe("campaign memory browser API", () => {
  it("loads owner-scoped settings and saves a validated level with the request signal", async () => {
    expect(clientWeb).toHaveProperty("createStoryMemoryApi");
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(settings));
    const api = clientWeb.createStoryMemoryApi({ basePath: "/api/v1", session: clientWeb.createNoopSessionPort(), fetchImpl });
    const signal = new AbortController().signal;
    expect(await api.get("campaign/a", signal)).toEqual(settings);
    expect(fetchImpl.mock.calls[0]![0]).toBe("/api/v1/campaigns/campaign%2Fa/story-memory");
    expect(await api.update("campaign/a", { level: "max" }, signal)).toEqual(settings);
    expect(fetchImpl.mock.calls[1]![1]).toMatchObject({ method: "PUT", body: '{"level":"max","continuityReviewEnabled":false}', signal });
  });

  it("rejects invalid levels before sending and malformed server settings before display", async () => {
    expect(clientWeb).toHaveProperty("createStoryMemoryApi");
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ...settings, level: "invented" }));
    const api = clientWeb.createStoryMemoryApi({ basePath: "/api/v1", session: clientWeb.createNoopSessionPort(), fetchImpl });
    expect(() => api.update("campaign", { level: "invented" } as never)).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(api.get("campaign")).rejects.toMatchObject({ kind: "response_schema_mismatch" });
  });
});
