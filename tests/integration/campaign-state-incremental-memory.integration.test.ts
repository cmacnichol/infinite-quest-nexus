import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createCorrectionFixture, snapshotCorrectionEvidence } from "../helpers/campaign-state-correction-fixtures.js";
import { getCampaignRuntimeState, updateCampaignRuntimeState } from "../helpers/memory-aware-services.js";
import { memoryGeneration } from "../helpers/memory-applications.js";
import { withTransaction } from "../../packages/database/src/pool.js";

describe("incremental current state memory", () => {
  let pool: DatabasePool;
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 5);
    await migrateDatabase(pool, resolve("database/migrations"));
  });
  afterAll(async () => { await pool.end(); });

  it("keeps all Chronicle rows and jobs identical for a private-only correction", async () => {
    const { campaignId, before } = await createCorrectionFixture(pool);
    const evidence = await snapshotCorrectionEvidence(pool, campaignId);
    await updateCampaignRuntimeState(pool, campaignId, {
      ...before, expectedTurnNumber: before.activeTurnNumber, expectedRevision: before.revision,
      scratchpad: "The keeper privately recognizes the traveler."
    });
    const after = await snapshotCorrectionEvidence(pool, campaignId);
    for (const table of ["turns", "campaign_canonical_facts", "chronicle_memories", "chronicle_memory_chunks", "summary_checkpoints", "chronicle_jobs", "chronicle_chunk_jobs"]) {
      expect(after[table], table).toEqual(evidence[table]);
    }
  });

  it("changes only affected fact groups, and preserves explicit empty continuity on subsequent reads", async () => {
    const { campaignId, before } = await createCorrectionFixture(pool);
    // Portable archives can contain historical, turn-bound summary/thread parents.
    const retained = await pool.query<{ id: string }>(`INSERT INTO chronicle_memories
      (owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,content,token_estimate,ordinal)
      SELECT c.owner_user_id,c.id,c.world_version_id,t.id,kind,'The old harbor record.',6,t.turn_number
      FROM campaigns c JOIN turns t ON t.campaign_id=c.id
      CROSS JOIN unnest(ARRAY['campaign_summary','open_thread']) AS kind
      WHERE c.id=$1 AND t.turn_number=1 RETURNING id`, [campaignId]);
    expect(retained.rows).toHaveLength(2);
    const evidence = await snapshotCorrectionEvidence(pool, campaignId);
    const updated = await updateCampaignRuntimeState(pool, campaignId, {
      ...before, expectedTurnNumber: before.activeTurnNumber, expectedRevision: before.revision,
      canonicalFacts: [...before.canonicalFacts, { id: null, content: "The bell is made of moon glass." }]
    });
    const after = await snapshotCorrectionEvidence(pool, campaignId);
    expect(after.turns).toEqual(evidence.turns);
    expect(after.summary_checkpoints).toEqual(evidence.summary_checkpoints);
    for (const memory of evidence.chronicle_memories!) {
      expect(after.chronicle_memories).toContainEqual(memory);
    }
    const cleared = await updateCampaignRuntimeState(pool, campaignId, {
      ...updated, expectedTurnNumber: updated.activeTurnNumber, expectedRevision: updated.revision,
      continuitySummary: "", openThreads: [], canonicalFacts: []
    });
    expect(cleared).toMatchObject({ continuitySummary: "", openThreads: [], canonicalFacts: [] });
    expect(await getCampaignRuntimeState(pool, campaignId)).toMatchObject({ continuitySummary: "", openThreads: [], canonicalFacts: [] });
    const memories = await pool.query("SELECT id FROM chronicle_memories WHERE campaign_id=$1 AND memory_kind IN ('canonical_fact','campaign_summary','open_thread')", [campaignId]);
    expect(memories.rows).toEqual(expect.arrayContaining(retained.rows));
    expect(memories.rows).toHaveLength(2);
    const clearedEvidence = await snapshotCorrectionEvidence(pool, campaignId);
    for (const memory of evidence.chronicle_memories!.filter((row: { id: string }) => retained.rows.some(({ id }) => id === row.id))) {
      expect(clearedEvidence.chronicle_memories).toContainEqual(memory);
    }
  });

  it("treats a repeated reordered fact draft as a no-op", async () => {
    const { campaignId, before } = await createCorrectionFixture(pool);
    let current = await updateCampaignRuntimeState(pool, campaignId, {
      ...before, expectedTurnNumber: before.activeTurnNumber, expectedRevision: before.revision,
      canonicalFacts: [{ id: null, content: "The bell is silver." }, { id: null, content: "The gate is oak." }]
    });
    current = await updateCampaignRuntimeState(pool, campaignId, {
      ...current, expectedTurnNumber: current.activeTurnNumber, expectedRevision: current.revision,
      canonicalFacts: [...current.canonicalFacts].reverse()
    });
    const evidence = await snapshotCorrectionEvidence(pool, campaignId);
    const saved = await updateCampaignRuntimeState(pool, campaignId, {
      ...current, expectedTurnNumber: current.activeTurnNumber, expectedRevision: current.revision
    });
    expect(saved.revision).toBe(current.revision);
    expect(await snapshotCorrectionEvidence(pool, campaignId)).toEqual(evidence);
  });

  it("retains complete corrected authority and fails explicitly when it cannot fit the context budget", async () => {
    const { campaignId, ownerUserId, before } = await createCorrectionFixture(pool);
    const current = await updateCampaignRuntimeState(pool, campaignId, {
      ...before, expectedTurnNumber: before.activeTurnNumber, expectedRevision: before.revision,
      continuitySummary: "The keeper remembers the silver harbor. ".repeat(100), canonicalFacts: [], openThreads: []
    });
    const world = await pool.query<{ world_version_id: string }>("SELECT world_version_id FROM campaigns WHERE id=$1", [campaignId]);
    const scope = { ownerUserId, campaignId, worldVersionId: world.rows[0]!.world_version_id,
      request: { query: "The keeper", budgetTokens: 512, compression: "full" as const, recentTurns: 1 },
      costAttribution: { operation: "retrieval_embedding" as const } };
    await expect(withTransaction(pool, (client) => memoryGeneration(pool).buildContextPreview(client, scope)))
      .rejects.toMatchObject({ code: "context_budget_exceeded" });
    const context = await withTransaction(pool, (client) => memoryGeneration(pool).buildContextPreview(client, {
      ...scope, request: { ...scope.request, budgetTokens: 12_000 }
    }));
    expect(context.scopes).toMatchObject({ currentContinuity: {
      continuitySummary: current.continuitySummary, canonicalFacts: [], openThreads: [], scratchpad: current.scratchpad
    } });
  });

  it("rolls back authority and projections when required indexing cannot be recorded", async () => {
    const { campaignId, ownerUserId, before } = await createCorrectionFixture(pool);
    await pool.query(`INSERT INTO campaign_memory_configs (campaign_id,owner_user_id,embedding_enabled,retrieval_shadow_enabled)
      VALUES ($1,$2,false,true) ON CONFLICT (campaign_id) DO UPDATE SET retrieval_shadow_enabled=true`, [campaignId, ownerUserId]);
    const evidence = await snapshotCorrectionEvidence(pool, campaignId);
    await pool.query(`CREATE FUNCTION reject_correction_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic enqueue failure'; END $$`);
    await pool.query("CREATE TRIGGER reject_correction_enqueue BEFORE INSERT ON chronicle_chunk_jobs FOR EACH ROW EXECUTE FUNCTION reject_correction_enqueue()");
    try {
      await expect(updateCampaignRuntimeState(pool, campaignId, {
        ...before, expectedTurnNumber: before.activeTurnNumber, expectedRevision: before.revision,
        continuitySummary: "The harbor has a silver bell."
      })).rejects.toThrow();
      expect(await snapshotCorrectionEvidence(pool, campaignId)).toEqual(evidence);
    } finally {
      await pool.query("DROP TRIGGER reject_correction_enqueue ON chronicle_chunk_jobs");
      await pool.query("DROP FUNCTION reject_correction_enqueue()");
    }
  });
});
