import { describe, expect, it } from "vitest";
import type { CampaignProjection, GenerationJobProjection } from "../../../packages/client-core/src/index.js";
import {
  selectGeneration,
  selectHistorySyncRequired,
  selectIsGenerationInFlight,
  selectLatestAcceptedTurn,
  selectLatestAcceptedTurnNumber,
  selectRequestedTurnInputMode,
  selectRuntimeState
} from "../../../packages/client-core/src/index.js";

const turn = {
  id: "11111111-1111-4111-8111-111111111111",
  turnNumber: 7,
  action: "continue",
  inputMode: "action" as const,
  inputModeSource: "explicit" as const,
  narration: "narration",
  choices: [],
  customActionSuggestion: "",
  imagePrompt: "",
  imageUrl: null,
  acceptedAt: "2026-08-03T12:00:00.000Z",
  reportedCost: null
};

function generation(overrides: Partial<GenerationJobProjection> = {}): GenerationJobProjection {
  return {
    campaignId: "22222222-2222-4222-8222-222222222222",
    jobId: "33333333-3333-4333-8333-333333333333",
    origin: "live",
    operation: { operationKind: "append", replacementTurnId: null },
    monitoring: "attached",
    hydratedGeneration: null,
    snapshot: null,
    narration: "",
    transport: { state: "unobserved" },
    result: { state: "pending" },
    ...overrides
  } as GenerationJobProjection;
}

function state(overrides: Partial<CampaignProjection> = {}): CampaignProjection {
  return {
    campaign: null,
    world: null,
    playerConfig: null,
    turns: [],
    nextTurnsCursor: null,
    syncToken: null,
    historySyncRequired: false,
    runtimeState: null,
    latestStateSnapshot: null,
    requestedTurnInputMode: "action",
    nextTurnInputModeSource: null,
    generation: null,
    ...overrides
  } as CampaignProjection;
}

describe("campaign selectors", () => {
  it("returns existing turn and generation references without allocation", () => {
    const job = generation();
    const projection = state({ turns: [turn], generation: job, historySyncRequired: true, requestedTurnInputMode: "auto" });

    expect(selectLatestAcceptedTurn(projection)).toBe(turn);
    expect(selectLatestAcceptedTurnNumber(projection)).toBe(7);
    expect(selectGeneration(projection)).toBe(job);
    expect(selectRequestedTurnInputMode(projection)).toBe("auto");
    expect(selectHistorySyncRequired(projection)).toBe(true);
    expect(selectRuntimeState(projection)).toBeNull();
  });

  it("returns null for empty plain projections", () => {
    const projection = state();

    expect(selectLatestAcceptedTurn(projection)).toBeNull();
    expect(selectLatestAcceptedTurnNumber(projection)).toBeNull();
    expect(selectGeneration(projection)).toBeNull();
    expect(selectIsGenerationInFlight(projection)).toBe(false);
  });

  it.each([
    [generation(), true],
    [generation({ monitoring: "detached" }), true],
    [generation({ snapshot: { id: "33333333-3333-4333-8333-333333333333", campaignId: "22222222-2222-4222-8222-222222222222", expectedTurnNumber: 8, status: "recoverable", action: "", operationKind: "append", replacementTurnId: null, attempts: 1, partialNarration: null, resultTurnId: null, errorCode: null, errorMessage: null } }), true],
    [generation({ result: { state: "unavailable", message: "later", correlationId: null } }), false],
    [generation({ result: { state: "failed", outcome: "failed", message: "failed" } }), false]
  ])("derives in-flight only from an active pending generation", (job, expected) => {
    expect(selectIsGenerationInFlight(state({ generation: job }))).toBe(expected);
  });
});
