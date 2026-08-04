import { describe, expect, it } from "vitest";
import { createGenerationRouteLifecycle } from "../../services/api/src/generation-route-lifecycle.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const generationJobId = "22222222-2222-4222-8222-222222222222";
const context = {
  generationJobId,
  campaignId: "33333333-3333-4333-8333-333333333333",
  providerProfileId: "44444444-4444-4444-8444-444444444444",
  expectedTurnNumber: 7,
  operationKind: "append" as const,
  jobAttempt: 2
};

describe("generation route lifecycle logging", () => {
  it("reads owner-scoped retry context before a successful mutation and logs the complete event", async () => {
    const order: string[] = [];
    const logs: Record<string, unknown>[] = [];
    const lifecycle = createGenerationRouteLifecycle({
      readContext: async (owner, job) => {
        order.push(`read:${owner}:${job}`);
        return context;
      },
      logger: { info: (fields) => { logs.push(fields); } }
    });

    const result = await lifecycle.retry(ownerUserId, generationJobId, async () => {
      order.push("mutate");
      return { id: generationJobId, status: "queued", operationKind: "append", replacementTurnId: null };
    });

    expect(result.status).toBe("queued");
    expect(order).toEqual([`read:${ownerUserId}:${generationJobId}`, "mutate"]);
    expect(logs).toEqual([{ event: "turn_generation_requeued", ...context }]);
  });

  it("does not mutate or log when the pre-mutation context read fails", async () => {
    const failure = new Error("context read failed");
    const logs: Record<string, unknown>[] = [];
    const lifecycle = createGenerationRouteLifecycle({
      readContext: async () => { throw failure; },
      logger: { info: (fields) => { logs.push(fields); } }
    });
    let mutated = false;

    await expect(lifecycle.cancel(ownerUserId, generationJobId, async () => {
      mutated = true;
      return { id: generationJobId, status: "cancelled", operationKind: "append", replacementTurnId: null };
    })).rejects.toBe(failure);

    expect(mutated).toBe(false);
    expect(logs).toEqual([]);
  });
});
