import { describe, expect, it, vi } from "vitest";
import type { CampaignRuntimeStateResponse } from "../../packages/contracts/src/index.js";
import { createPostgresCampaignAuthorityAdapters } from "../../packages/database/src/campaign-state-repository.js";
import type { DatabaseClient } from "../../packages/database/src/pool.js";
import { runPostgresWorldCampaignCommandWithClient } from "../../packages/database/src/world-campaign-transaction.js";

const scope = {
  ownerUserId: "00000000-0000-4000-8000-000000000001",
  campaignId: "00000000-0000-4000-8000-000000000002"
};

const runtimeSnapshot = {
  continuitySummary: "The observatory is awake.",
  openThreads: [],
  canonicalFacts: [],
  scratchpad: "",
  trackers: [],
  rpgStats: [],
  eventTriggers: [],
  pendingEventTriggers: []
};

describe("campaign state mechanics projection", () => {
  it("selects and returns a recorded resolution only for an explicit inspected state", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM campaigns c")) return { rows: [{
        activeTurnNumber: 2,
        worldVersionId: "00000000-0000-4000-8000-000000000003",
        revision: 1,
        scratchpadPrivate: "",
        trackers: [],
        rpgStats: [],
        eventTriggers: [],
        pendingEventTriggers: [],
        initialStateSnapshot: runtimeSnapshot,
        updatedAt: "2026-08-01T12:00:00.000Z"
      }] };
      if (sql.includes("FROM turns")) return { rows: [{
        stateSnapshotPrivate: runtimeSnapshot,
        mechanicsPrivate: {
          roll: {
            statName: "Resolve", base: 61, modifier: 0, target: 61, roll: 37,
            success: true, margin: 24, difficultyLabel: "standard",
            rationale: "Private referee reasoning."
          }
        },
        acceptedAt: "2026-08-01T12:00:00.000Z"
      }] };
      if (sql.includes("SELECT EXISTS")) return { rows: [{ hasProjection: false }] };
      if (sql.includes("FROM campaign_state_edits") || sql.includes("FROM campaign_canonical_facts")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const adapters = createPostgresCampaignAuthorityAdapters({} as never, {
      memory: {} as never,
      turnPages: {} as never
    });
    const client = { query, release: () => undefined } as unknown as DatabaseClient;

    const generic = await runPostgresWorldCampaignCommandWithClient<CampaignRuntimeStateResponse>(client, (transaction) => (
      adapters.state.getCampaignRuntimeState(transaction, scope, 2)
    ));
    const inspected = await runPostgresWorldCampaignCommandWithClient<CampaignRuntimeStateResponse>(client, (transaction) => (
      adapters.state.getCampaignRuntimeState(transaction, scope, 2, true)
    ));

    expect(generic.recordedResolution).toBeNull();
    expect(inspected.recordedResolution).toEqual({
      statName: "Resolve", base: 61, modifier: 0, target: 61, roll: 37,
      success: true, margin: 24, difficultyLabel: "standard"
    });
    expect(JSON.stringify(inspected)).not.toContain("Private referee reasoning.");
    const turnSelects = query.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes("FROM turns"));
    expect(turnSelects).toHaveLength(2);
    expect(turnSelects[0]).not.toContain("mechanics_private");
    expect(turnSelects[1]).toContain("mechanics_private");
  });
});
