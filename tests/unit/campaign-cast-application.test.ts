import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createCastCharacterSchema, editCastCharacterSchema } from "../../packages/contracts/src/campaign-cast.js";
import { createCampaignCastApplication } from "../../packages/application/src/campaign-cast/use-cases.js";
import type { CampaignCastWritePort } from "../../packages/application/src/campaign-cast/ports.js";

const base = { expectedCastRevision: 2, expectedCharacterRevision: 1,
  expectedBoundary: { turnNumber: 4, timelineRevision: 0 }, idempotencyKey: "edit-1" };
describe("cast editing application boundary", () => {
  it("preserves intentional blanks and rejects ambiguous reset/set and empty edits", () => {
    expect(editCastCharacterSchema.parse({ ...base, setOverrides: { "appearance.description": "" } }).setOverrides)
      .toEqual({ "appearance.description": "" });
    expect(editCastCharacterSchema.safeParse({ ...base, setOverrides: { "appearance.description": "" }, clearOverrides: ["appearance.description"] }).success).toBe(false);
    expect(editCastCharacterSchema.safeParse(base).success).toBe(false);
    expect(createCastCharacterSchema.safeParse({ ...base, name: "Mara", aliases: [], profile: {}, ownerUserId: "forged" }).success).toBe(false);
  });
  it("rejects invalid scope and mutation fields before the persistence boundary", async () => {
    const repository = new Proxy({}, { get() { throw new Error("Unexpected persistence access"); } }) as CampaignCastWritePort;
    const app = createCampaignCastApplication(repository);
    await expect(app.create({ ownerUserId: "forged", campaignId: "forged" }, {} as never)).rejects.toBeInstanceOf(ZodError);
    await expect(app.list({ ownerUserId: "11111111-1111-4111-8111-111111111111", campaignId: "22222222-2222-4222-8222-222222222222" }, { limit: 51 })).rejects.toBeInstanceOf(ZodError);
    await expect(app.edit({ ownerUserId: "11111111-1111-4111-8111-111111111111", campaignId: "22222222-2222-4222-8222-222222222222" }, "invalid", { ...base, profile: {} } as never)).rejects.toBeInstanceOf(ZodError);
  });
});
