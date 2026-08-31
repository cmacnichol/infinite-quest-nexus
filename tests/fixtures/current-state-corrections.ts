import type { CampaignRuntimeStateResponse } from "../../packages/contracts/src/index.js";

export function currentStateFixture(
  overrides: Partial<CampaignRuntimeStateResponse> = {}
): CampaignRuntimeStateResponse {
  return {
    campaignId: "11111111-1111-4111-8111-111111111111",
    activeTurnNumber: 5,
    viewedTurnNumber: 5,
    isCurrent: true,
    revision: 7,
    updatedAt: "2026-08-30T12:00:00.000Z",
    recordedResolution: null,
    continuitySummary: "The keeper guards the harbor.",
    openThreads: ["Find the missing harbor chart."],
    canonicalFacts: [{
      id: "22222222-2222-4222-8222-222222222222",
      content: "The lens is moon glass."
    }],
    scratchpad: "The keeper recognizes the visitor.",
    trackers: [],
    rpgStats: [],
    eventTriggers: [],
    pendingEventTriggers: [],
    ...overrides
  };
}
