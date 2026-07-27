import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { importLegacyStory } from "../../services/api/src/import-service.js";
import { buildContextPreview } from "../../services/api/src/memory-service.js";
import { getCampaignRuntimeState, updateCampaignRuntimeState } from "../../services/api/src/campaign-state-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("campaign state corrections", () => {
  let pool: DatabasePool;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 5);
    await migrateDatabase(pool, resolve("database/migrations"));
  });

  afterAll(async () => {
    await pool.end();
  });

  async function campaign() {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `State corrections ${crypto.randomUUID()}`;
    return importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "campaign-state-corrections.story", story: fixture }));
  }

  it("persists a complete append-only correction without rewriting the accepted turn", async () => {
    const imported = await campaign();
    const before = await getCampaignRuntimeState(pool, imported.campaignId);
    const acceptedBefore = await pool.query<{ state_snapshot_private: Record<string, unknown> }>(
      `SELECT state_snapshot_private FROM turns
        WHERE campaign_id = $1 AND turn_number = $2`,
      [imported.campaignId, before.activeTurnNumber]
    );
    const corrected = await updateCampaignRuntimeState(pool, imported.campaignId, {
      expectedTurnNumber: before.activeTurnNumber,
      expectedRevision: before.revision,
      continuitySummary: "The corrected lighthouse summary.",
      openThreads: ["Find the keeper."],
      canonicalFacts: [{ id: null, content: "The lens is moon glass." }],
      scratchpad: "The keeper waits below the stair.",
      trackers: [{ id: "trust", name: "Keeper trust", value: "wary", rules: "Update after honest exchanges." }],
      rpgStats: [{ id: "resolve", name: "Resolve", value: 61, note: "" }],
      eventTriggers: [],
      pendingEventTriggers: []
    });

    expect(corrected).toMatchObject({
      continuitySummary: "The corrected lighthouse summary.",
      openThreads: ["Find the keeper."],
      scratchpad: "The keeper waits below the stair.",
      rpgStats: [{ id: "resolve", value: 61 }],
      eventTriggers: [],
      pendingEventTriggers: []
    });
    expect(corrected.canonicalFacts).toEqual([
      expect.objectContaining({ id: expect.any(String), content: "The lens is moon glass." })
    ]);

    const edits = await pool.query<{ state_snapshot_private: Record<string, unknown>; changed_fields: string[] }>(
      `SELECT state_snapshot_private, changed_fields FROM campaign_state_edits
        WHERE campaign_id = $1 ORDER BY revision`,
      [imported.campaignId]
    );
    expect(edits.rows).toHaveLength(1);
    expect(edits.rows[0]?.state_snapshot_private).toMatchObject({
      continuitySummary: "The corrected lighthouse summary.",
      openThreads: ["Find the keeper."],
      canonicalFacts: [{ id: expect.any(String), content: "The lens is moon glass." }],
      scratchpad: "The keeper waits below the stair.",
      trackers: [{ id: "trust", name: "Keeper trust" }],
      rpgStats: [{ id: "resolve", value: 61 }],
      eventTriggers: [],
      pendingEventTriggers: []
    });
    expect(edits.rows[0]?.changed_fields).toEqual(expect.arrayContaining([
      "continuitySummary", "openThreads", "canonicalFacts", "scratchpad", "trackers", "rpgStats"
    ]));

    const materialized = await pool.query<{
      scratchpad_private: string;
      trackers: unknown;
      rpg_stats: unknown;
      event_triggers: unknown;
      pending_event_triggers: unknown;
    }>(
      `SELECT scratchpad_private, trackers, rpg_stats, event_triggers, pending_event_triggers
         FROM campaign_state WHERE campaign_id = $1`,
      [imported.campaignId]
    );
    expect(materialized.rows[0]).toMatchObject({
      scratchpad_private: "The keeper waits below the stair.",
      rpg_stats: [{ id: "resolve", value: 61 }],
      event_triggers: [],
      pending_event_triggers: []
    });
    expect(acceptedBefore.rows[0]?.state_snapshot_private).toEqual((await pool.query<{ state_snapshot_private: Record<string, unknown> }>(
      `SELECT state_snapshot_private FROM turns WHERE campaign_id = $1 AND turn_number = $2`,
      [imported.campaignId, before.activeTurnNumber]
    )).rows[0]?.state_snapshot_private);

    const context = await buildContextPreview(pool, imported.campaignId, {
      query: "keeper lens",
      budgetTokens: 12_000,
      compression: "full",
      recentTurns: 8
    });
    expect(JSON.stringify(context)).toContain("The corrected lighthouse summary.");
    expect(JSON.stringify(context)).toContain("The lens is moon glass.");
    expect(JSON.stringify(context)).toContain("Find the keeper.");
  });

  it("rejects unsafe continuity atomically and leaves no correction row", async () => {
    const imported = await campaign();
    const before = await getCampaignRuntimeState(pool, imported.campaignId);
    await expect(updateCampaignRuntimeState(pool, imported.campaignId, {
      expectedTurnNumber: before.activeTurnNumber,
      expectedRevision: before.revision,
      continuitySummary: "The d20 roll decides the keeper's fate.",
      openThreads: before.openThreads,
      canonicalFacts: before.canonicalFacts,
      scratchpad: before.scratchpad,
      trackers: before.trackers,
      rpgStats: before.rpgStats,
      eventTriggers: before.eventTriggers,
      pendingEventTriggers: before.pendingEventTriggers
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(pool.query("SELECT * FROM campaign_state_edits WHERE campaign_id = $1", [imported.campaignId]))
      .resolves.toMatchObject({ rowCount: 0 });
  });

  it("loads current and historical state whose persisted trackers predate tracker IDs", async () => {
    const imported = await campaign();
    const legacyTrackers = [
      { name: "Keeper trust", value: "wary", rules: "Update after honest exchanges." },
      { label: "Moon gate", currentValue: "sealed", updateRules: "Change when the lens is lit." }
    ];
    await pool.query(
      `UPDATE campaign_state
          SET trackers = $2::jsonb,
              initial_state_snapshot = jsonb_set(initial_state_snapshot, '{trackers}', $2::jsonb)
        WHERE campaign_id = $1`,
      [imported.campaignId, JSON.stringify(legacyTrackers)]
    );
    await pool.query(
      `UPDATE turns
          SET state_snapshot_private = jsonb_set(state_snapshot_private, '{trackers}', $2::jsonb)
        WHERE campaign_id = $1 AND turn_number = 1`,
      [imported.campaignId, JSON.stringify(legacyTrackers)]
    );

    const current = await getCampaignRuntimeState(pool, imported.campaignId);
    const historical = await getCampaignRuntimeState(pool, imported.campaignId, 1);

    expect(current.trackers).toEqual([
      expect.objectContaining({ id: "Keeper trust", name: "Keeper trust" }),
      expect.objectContaining({ id: "Moon gate", name: "Moon gate" })
    ]);
    expect(historical.trackers).toEqual(current.trackers);
  });
});
