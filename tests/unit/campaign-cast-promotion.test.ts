import { describe, expect, it } from "vitest";
import { castPromoteSchema } from "../../packages/contracts/src/campaign-cast-promotion.js";

describe("promotion contract", () => {
  const base = { worldId: "00000000-0000-4000-8000-000000000001", expectedDraftRevision: 1, expectedCastRevision: 1,
    expectedBoundary: { turnNumber: 0, timelineRevision: 0 }, expectedCharacterRevision: 1,
    mode: "add", selections: [{ destinationPath: "name", sourcePath: "name" }], idempotencyKey: "a" };
  it("rejects duplicate destination selections and replace without a target", () => {
    expect(castPromoteSchema.safeParse({ ...base, selections: [...base.selections, ...base.selections] }).success).toBe(false);
    expect(castPromoteSchema.safeParse({ ...base, mode: "replace" }).success).toBe(false);
    expect(castPromoteSchema.safeParse(base).success).toBe(true);
  });
});
