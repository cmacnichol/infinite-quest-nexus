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

describe("campaign reload provider failure evidence", () => {
  it("changes the sync token for safe evidence changes while ignoring private canaries", async () => {
    const providerFailure = { version: 1, source: "http_error", observedAt: "2026-10-03T15:00:00.000Z",
      httpStatus: 429, upstreamStatus: null, reason: "rate_limit", limitSource: "unknown", upstreamCode: null,
      providerName: null, retryAfterMs: null, retryAt: null, rateLimit: null, successfulResponseStarted: false,
      emittedOutput: false, metadataStatus: "absent" };
    const failureDiagnostic = { version: 1, category: "provider_rejection", code: "provider_rate_limited",
      phase: "story_generation", attemptNumber: 1, occurredAt: providerFailure.observedAt, providerFailure };
    const row = {
      id: scope.campaignId, title: "Campaign", activeTurnNumber: 1,
      worldVersionId: "00000000-0000-4000-8000-000000000003", storyLengthProfile: "standard",
      storyContextBudgetTokens: 32000, turnControlStyle: "flexible_action", updatedAt: "2026-10-03T15:00:00.000Z",
      selectedCharacterId: null, characterSnapshot: null, characterProfile: null, characterProfileRevision: 0,
      status: "active", worldId: "00000000-0000-4000-8000-000000000004", worldTitle: "World", worldVersionNumber: 1,
      worldContent: {}, legacySettings: {}, trackers: [], rpgStats: [], eventTriggers: [],
      recoveryId: "00000000-0000-4000-8000-000000000005", recoveryStatus: "failed", recoveryExpectedTurnNumber: 2,
      recoveryAttempts: 1, recoveryOperationKind: "append", recoveryReplacementTurnId: null, recoveryResultTurnId: null,
      recoveryResultIsRecent: false, recoveryErrorCode: "generation_failed", recoveryMetadata: {},
      recoveryFailureDiagnostic: failureDiagnostic
    };
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      expect(sql).toContain("WHERE c.id = $1 AND c.owner_user_id = $2");
      expect(sql).toContain("expanded_private->'lastFailureDiagnostic'");
      expect(params).toEqual([scope.campaignId, scope.ownerUserId]);
      return { rows: [row] };
    });
    const adapters = createPostgresCampaignAuthorityAdapters({} as never, { memory: {} as never, turnPages: {} as never });
    const client = { query, release: () => undefined } as unknown as DatabaseClient;
    const read = () => runPostgresWorldCampaignCommandWithClient(client, (transaction) => adapters.sync.readCampaignSyncSnapshot(transaction, scope));
    const original = await read();
    providerFailure.limitSource = "upstream_provider";
    const updated = await read();
    expect(updated.syncToken).not.toBe(original.syncToken);
    expect(updated.projection.generationRecovery?.failureDiagnostic?.providerFailure?.limitSource).toBe("upstream_provider");
    Object.assign(providerFailure, { providerName: "PRIVATE_PROVIDER_CANARY", raw: "PRIVATE_RAW_CANARY" });
    const privateChanged = await read();
    expect(privateChanged.syncToken).toBe(updated.syncToken);
    expect(JSON.stringify(privateChanged.projection)).not.toContain("PRIVATE_");
  });
});
