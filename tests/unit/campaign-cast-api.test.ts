import { describe, expect, it } from "vitest";
import { createCampaignCastApi } from "../../packages/client-web/src/campaign-cast-api.js";
import Fastify from "fastify";
import { registerCampaignCastRoutes } from "../../services/api/src/campaign-cast-routes.js";
import { apiErrorEnvelopeSchema } from "../../packages/contracts/src/http.js";
describe("cast browser adapter", () => {
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
