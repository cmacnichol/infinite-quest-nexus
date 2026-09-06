import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createCorrectionFixture, snapshotCorrectionEvidence } from "../helpers/campaign-state-correction-fixtures.js";
import { buildContextPreview, getCampaignRuntimeState, rebuildCampaignMemories, rewindCampaign, updateCampaignRuntimeState } from "../helpers/memory-aware-services.js";
import { snapshotTurnRows } from "../helpers/turn-row-snapshot.js";

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
    return createCorrectionFixture(pool).then(({ campaignId }) => ({ campaignId }));
  }

  it("keeps a turn-zero correction fact through a Chronicle rebuild", async () => {
    const imported = await campaign();
    await rewindCampaign(pool, imported.campaignId, { targetTurnNumber: 0 });
    const before = await getCampaignRuntimeState(pool, imported.campaignId);
    expect(before.activeTurnNumber).toBe(0);

    const corrected = await updateCampaignRuntimeState(pool, imported.campaignId, {
      expectedTurnNumber: before.activeTurnNumber,
      expectedRevision: before.revision,
      continuitySummary: before.continuitySummary,
      openThreads: before.openThreads,
      canonicalFacts: [{ id: null, content: "The bell is silver." }],
      scratchpad: before.scratchpad,
      trackers: before.trackers,
      rpgStats: before.rpgStats,
      eventTriggers: before.eventTriggers,
      pendingEventTriggers: before.pendingEventTriggers
    });
    const factId = corrected.canonicalFacts[0]?.id;
    expect(factId).toEqual(expect.any(String));
    await expect(pool.query(
      `SELECT source_turn_id,source_state_edit_id,source_turn_number,valid_from_turn
         FROM campaign_canonical_facts
        WHERE campaign_id=$1 AND id=$2`,
      [imported.campaignId, factId]
    )).resolves.toMatchObject({
      rows: [{ source_turn_id: null, source_state_edit_id: expect.any(String), source_turn_number: 0, valid_from_turn: 0 }]
    });
    await expect(pool.query(
      "UPDATE campaign_canonical_facts SET source_turn_number=-1 WHERE campaign_id=$1 AND id=$2",
      [imported.campaignId, factId]
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      "UPDATE campaign_canonical_facts SET valid_from_turn=-1 WHERE campaign_id=$1 AND id=$2",
      [imported.campaignId, factId]
    )).rejects.toMatchObject({ code: "23514" });

    await rebuildCampaignMemories(pool, imported.campaignId);
    await expect(getCampaignRuntimeState(pool, imported.campaignId)).resolves.toMatchObject({
      activeTurnNumber: 0,
      canonicalFacts: [{ id: factId, content: "The bell is silver." }]
    });
  });

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

  it("supersedes stale state-correction chunks and queues replacement work without touching accepted turns", async () => {
    const imported = await campaign();
    const ownerUserId = await initialOwnerId(pool);
    const acceptedBefore = await snapshotTurnRows(pool, ownerUserId, imported.campaignId);
    await pool.query(
      `INSERT INTO campaign_memory_configs
         (campaign_id,owner_user_id,embedding_enabled,retrieval_shadow_enabled)
       VALUES ($1,$2,false,true)
       ON CONFLICT (campaign_id) DO UPDATE
         SET retrieval_shadow_enabled=EXCLUDED.retrieval_shadow_enabled`,
      [imported.campaignId, ownerUserId]
    );
    const before = await getCampaignRuntimeState(pool, imported.campaignId);
    const first = await updateCampaignRuntimeState(pool, imported.campaignId, {
      expectedTurnNumber: before.activeTurnNumber,
      expectedRevision: before.revision,
      continuitySummary: "The first corrected state projection.",
      openThreads: before.openThreads,
      canonicalFacts: [{ id: null, content: "The first correction marks the moon gate." }],
      scratchpad: before.scratchpad,
      trackers: before.trackers,
      rpgStats: before.rpgStats,
      eventTriggers: before.eventTriggers,
      pendingEventTriggers: before.pendingEventTriggers
    });
    const oldParent = await pool.query<{ id: string; content_hash: string; content: string }>(
      `SELECT id,content_hash,content FROM chronicle_memories
        WHERE campaign_id=$1 AND memory_kind='canonical_fact'`,
      [imported.campaignId]
    );
    expect(oldParent.rows).toHaveLength(1);
    const oldParentRow = oldParent.rows[0]!;
    const oldChunk = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memory_chunks (
         owner_user_id,campaign_id,world_version_id,parent_memory_id,parent_content_hash,
         chunking_protocol_version,chunk_ordinal,chunk_kind,content,source_end_offset,
         token_estimate,embedding_status,embedding_skip_reason
       ) SELECT owner_user_id,campaign_id,world_version_id,id,content_hash,
                'chronicle-chunk-v1',0,'canonical_fact',content,length(content),
                token_estimate,'skipped','semantic_retrieval_disabled'
           FROM chronicle_memories WHERE id=$1 RETURNING id`,
      [oldParentRow.id]
    );
    await pool.query("DELETE FROM chronicle_chunk_jobs WHERE campaign_id=$1", [imported.campaignId]);

    await updateCampaignRuntimeState(pool, imported.campaignId, {
      expectedTurnNumber: first.activeTurnNumber,
      expectedRevision: first.revision,
      continuitySummary: "The replacement corrected state projection.",
      openThreads: first.openThreads,
      canonicalFacts: [{ id: first.canonicalFacts[0]!.id, content: "The replacement correction seals the moon gate." }],
      scratchpad: first.scratchpad,
      trackers: first.trackers,
      rpgStats: first.rpgStats,
      eventTriggers: first.eventTriggers,
      pendingEventTriggers: first.pendingEventTriggers
    });

    await expect(pool.query("SELECT id FROM chronicle_memories WHERE id=$1", [oldParentRow.id]))
      .resolves.toMatchObject({ rows: [{ id: oldParentRow.id }] });
    await expect(pool.query("SELECT id FROM chronicle_memory_chunks WHERE id=$1", [oldChunk.rows[0]!.id]))
      .resolves.toMatchObject({ rows: [] });
    await expect(pool.query<{ content: string }>(
      "SELECT content FROM chronicle_memories WHERE campaign_id=$1 AND memory_kind='canonical_fact'",
      [imported.campaignId]
    )).resolves.toMatchObject({ rows: [{ content: expect.stringContaining("replacement correction seals") }] });
    await expect(pool.query<{ status: string }>(
      "SELECT status FROM chronicle_chunk_jobs WHERE campaign_id=$1",
      [imported.campaignId]
    )).resolves.toMatchObject({ rows: [{ status: "queued" }] });
    await expect(snapshotTurnRows(pool, ownerUserId, imported.campaignId)).resolves.toEqual(acceptedBefore);
    await pool.query("DELETE FROM chronicle_chunk_jobs WHERE campaign_id=$1", [imported.campaignId]);
  });

  it("rejects historical corrections without changing campaign authority or derived work", async () => {
    const { campaignId, before } = await createCorrectionFixture(pool);
    expect(before.activeTurnNumber).toBeGreaterThan(0);
    const evidence = await snapshotCorrectionEvidence(pool, campaignId);

    await expect(updateCampaignRuntimeState(pool, campaignId, {
      ...before,
      expectedTurnNumber: before.activeTurnNumber,
      expectedRevision: before.revision,
      effectiveTurnNumber: before.activeTurnNumber - 1,
      continuitySummary: "A rejected historical correction.",
    })).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "active_turn_changed" },
    });

    expect(await snapshotCorrectionEvidence(pool, campaignId)).toEqual(evidence);
  });

  it("rejects a correction targeted beyond the active turn without writes", async () => {
    const imported = await campaign();
    const before = await getCampaignRuntimeState(pool, imported.campaignId);

    await expect(updateCampaignRuntimeState(pool, imported.campaignId, {
      expectedTurnNumber: before.activeTurnNumber,
      expectedRevision: before.revision,
      effectiveTurnNumber: before.activeTurnNumber + 1,
      continuitySummary: before.continuitySummary,
      openThreads: before.openThreads,
      canonicalFacts: before.canonicalFacts,
      scratchpad: before.scratchpad,
      trackers: before.trackers,
      rpgStats: before.rpgStats,
      eventTriggers: before.eventTriggers,
      pendingEventTriggers: before.pendingEventTriggers
    })).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "active_turn_changed" }
    });

    await expect(pool.query(
      "SELECT * FROM campaign_state_edits WHERE campaign_id = $1",
      [imported.campaignId]
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("projects multiple manual canonical facts as one Chronicle memory", async () => {
    const imported = await campaign();
    const before = await getCampaignRuntimeState(pool, imported.campaignId);

    await expect(updateCampaignRuntimeState(pool, imported.campaignId, {
      expectedTurnNumber: before.activeTurnNumber,
      expectedRevision: before.revision,
      continuitySummary: before.continuitySummary,
      openThreads: before.openThreads,
      canonicalFacts: [
        { id: null, content: "The lens is moon glass." },
        { id: null, content: "The keeper guards the flooded stair." }
      ],
      scratchpad: before.scratchpad,
      trackers: before.trackers,
      rpgStats: before.rpgStats,
      eventTriggers: before.eventTriggers,
      pendingEventTriggers: before.pendingEventTriggers
    })).resolves.toMatchObject({
      canonicalFacts: [
        expect.objectContaining({ content: "The lens is moon glass." }),
        expect.objectContaining({ content: "The keeper guards the flooded stair." })
      ]
    });

    const memories = await pool.query<{ content: string; metadata: { structuredFactIds?: string[] } }>(
      `SELECT content, metadata FROM chronicle_memories
        WHERE campaign_id = $1 AND memory_kind = 'canonical_fact'`,
      [imported.campaignId]
    );
    expect(memories.rows).toHaveLength(1);
    expect(memories.rows[0]).toMatchObject({
      content: expect.stringContaining("The lens is moon glass."),
      metadata: { structuredFactIds: expect.arrayContaining([expect.any(String), expect.any(String)]) }
    });
    expect(memories.rows[0]?.content).toContain("The keeper guards the flooded stair.");
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
