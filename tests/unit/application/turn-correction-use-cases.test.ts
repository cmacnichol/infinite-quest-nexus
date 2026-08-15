import { describe, expect, it } from "vitest";
import {
  createTurnCorrectionApplication,
  type TurnCorrectionRepositoryPort
} from "../../../packages/application/src/turn-corrections/index.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const campaignId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";

function repository(): TurnCorrectionRepositoryPort {
  return {
    async correctNarration(scope, request) {
      if (request.narration.includes("d20 roll")) {
        return { ok: false, failure: { reason: "mechanics_leak" } };
      }
      return {
        ok: true,
        value: {
          ownerUserId: scope.ownerUserId,
          campaignId: scope.campaignId,
          turnId: request.turnId,
          turnNumber: 4,
          correctionRevision: 1,
          originalNarration: "The old moon fades.",
          effectiveNarration: request.narration,
          correctedAt: "2026-08-13T12:00:00.000Z",
          illustrationsMayBeStale: true
        }
      };
    },
    async getEffectiveNarration() {
      return null;
    }
  };
}

describe("accepted-turn narration correction application", () => {
  it("returns the durable effective narration from the owner-scoped repository", async () => {
    const application = createTurnCorrectionApplication({ corrections: repository() });

    await expect(application.correctNarration(
      { ownerUserId, campaignId },
      {
        turnId,
        narration: "The silver moon rises above the quiet harbor.",
        expectedCorrectionRevision: 0,
        expectedActiveTurnNumber: 4,
        reason: "Correct the established weather.",
        source: "user_edit"
      }
    )).resolves.toEqual({
      ownerUserId,
      campaignId,
      turnId,
      turnNumber: 4,
      correctionRevision: 1,
      originalNarration: "The old moon fades.",
      effectiveNarration: "The silver moon rises above the quiet harbor.",
      correctedAt: "2026-08-13T12:00:00.000Z",
      illustrationsMayBeStale: true
    });
  });

  it("rejects mechanics language before it can become effective fiction", async () => {
    const application = createTurnCorrectionApplication({ corrections: repository() });

    await expect(application.correctNarration(
      { ownerUserId, campaignId },
      {
        turnId,
        narration: "The d20 roll succeeds and the gate opens.",
        expectedCorrectionRevision: 0,
        expectedActiveTurnNumber: 4,
        source: "user_edit"
      }
    )).rejects.toMatchObject({
      kind: "invalid_request",
      reason: "mechanics_leak"
    });
  });
});
