import { describe, expect, it, vi } from "vitest";
import {
  loadCurrentContinuityCorrection,
  materializeGenerationContinuity
} from "../../packages/database/src/campaign-continuity-repository.js";
import type { DatabaseClient } from "../../packages/database/src/pool.js";

const scope = {
  ownerUserId: "00000000-0000-4000-8000-000000000001",
  campaignId: "00000000-0000-4000-8000-000000000002",
  worldVersionId: "00000000-0000-4000-8000-000000000003"
};

function clientReturning(rows: readonly Record<string, unknown>[]): DatabaseClient {
  return {
    query: vi.fn(async () => ({ rows }))
  } as unknown as DatabaseClient;
}

describe("loadCurrentContinuityCorrection", () => {
  it("materializes accepted state when no exact correction replaces it", () => {
    expect(materializeGenerationContinuity({
      continuitySummary: "The keeper is dead.",
      scratchpad: "late password: moonfall",
      openThreads: ["Bury the keeper."],
      canonicalFacts: []
    }, [{ id: "11111111-1111-4111-8111-111111111111", content: "The keeper died." }])).toEqual({
      continuitySummary: "The keeper is dead.",
      scratchpad: "late password: moonfall",
      openThreads: ["Bury the keeper."],
      canonicalFacts: [{ id: "11111111-1111-4111-8111-111111111111", content: "The keeper died." }]
    });
  });
  it("returns the highest revision at the exact requested base turn, preserving intentional empties", async () => {
    const client = clientReturning([{
      state_snapshot_private: {
        continuitySummary: "The keeper is alive.",
        openThreads: [],
        canonicalFacts: [],
        scratchpad: ""
      }
    }]);

    await expect(loadCurrentContinuityCorrection(client, scope, 7)).resolves.toEqual({
      continuitySummary: "The keeper is alive.",
      openThreads: [],
      canonicalFacts: [],
      scratchpad: ""
    });

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("effective_turn_number = $4"), [
      scope.ownerUserId,
      scope.campaignId,
      scope.worldVersionId,
      7
    ]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY edit.revision DESC"), expect.any(Array));
  });

  it("returns null when no correction exists at the exact base turn", async () => {
    const client = clientReturning([]);

    await expect(loadCurrentContinuityCorrection(client, scope, 6)).resolves.toBeNull();
  });

  it("rejects malformed persisted correction data instead of producing an uncorrected prompt", async () => {
    const client = clientReturning([{
      state_snapshot_private: {
        continuitySummary: "The keeper is alive.",
        openThreads: "not a list",
        canonicalFacts: [],
        scratchpad: ""
      }
    }]);

    await expect(loadCurrentContinuityCorrection(client, scope, 7)).rejects.toThrow();
  });
});
