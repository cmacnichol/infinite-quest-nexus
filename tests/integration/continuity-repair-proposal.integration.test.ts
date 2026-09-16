import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { buildContinuityRepairProposal, loadContinuityRepairSource, proposalRevisionIsStale } from "../../scripts/lib/continuity-repair-proposal.js";
import { createCorrectionFixture } from "../helpers/campaign-state-correction-fixtures.js";

import { campaignRuntimeStateUpdateSchema } from "../../packages/contracts/src/generation.js";
import { updateCampaignRuntimeState } from "../helpers/memory-aware-services.js";
import { createTurnCorrectionApplication } from "../../packages/application/src/turn-corrections/index.js";
import { createPostgresTurnCorrectionRepository } from "../../packages/database/src/turn-correction-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("continuity repair proposal reader", () => {
  let pool: DatabasePool;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 3);
    await migrateDatabase(pool, resolve("database/migrations"));
  });

  afterAll(async () => { await pool.end(); });

  it("reads owner-scoped retained authority in a repeatable read-only transaction without changing campaign records", async () => {
    const { campaignId } = await createCorrectionFixture(pool);
    const ownerUserId = await initialOwnerId(pool);
    const world = await pool.query<{ world_version_id: string }>("SELECT world_version_id FROM campaigns WHERE id=$1 AND owner_user_id=$2", [campaignId, ownerUserId]);
    const before = await pool.query<{ state_revision: number; turn_count: string; edit_count: string; correction_count: string }>(
      `SELECT (SELECT revision FROM campaign_state WHERE campaign_id=$1)::integer AS state_revision,
              (SELECT count(*) FROM turns WHERE campaign_id=$1) AS turn_count,
              (SELECT count(*) FROM campaign_state_edits WHERE campaign_id=$1) AS edit_count,
              (SELECT count(*) FROM turn_narration_corrections WHERE campaign_id=$1) AS correction_count`, [campaignId]
    );
    const client = await pool.connect();
    try {
      const source = await loadContinuityRepairSource(client, campaignId, ownerUserId, world.rows[0]!.world_version_id, 2);
      expect(source).toMatchObject({ campaignId, ownerUserId, baseRevision: before.rows[0]!.state_revision });
      expect(source.acceptedSnapshots.length).toBeGreaterThan(0);
      expect(source.effectiveNarrations.length).toBe(source.acceptedSnapshots.length);
    } finally { client.release(); }
    await expect(pool.query(
      `SELECT (SELECT revision FROM campaign_state WHERE campaign_id=$1)::integer AS state_revision,
              (SELECT count(*) FROM turns WHERE campaign_id=$1) AS turn_count,
              (SELECT count(*) FROM campaign_state_edits WHERE campaign_id=$1) AS edit_count,
              (SELECT count(*) FROM turn_narration_corrections WHERE campaign_id=$1) AS correction_count`, [campaignId]
    )).resolves.toMatchObject({ rows: before.rows });
  });
  it("restores a retained fact through the existing revision-checked state API with a fresh identity", async () => {
    const { campaignId, ownerUserId } = await createCorrectionFixture(pool);
    const factId = crypto.randomUUID();
    const content = "The lighthouse key is silver.";
    // Simulate retained snapshot authority with a missing derived/current fact row.
    await pool.query(`UPDATE turns SET state_snapshot_private=jsonb_set(state_snapshot_private,'{canonicalFacts}',
      COALESCE(state_snapshot_private->'canonicalFacts','[]'::jsonb) || $2::jsonb) WHERE campaign_id=$1 AND turn_number=2`,
      [campaignId, JSON.stringify([{ id: factId, content }])]);
    const world = await pool.query<{ world_version_id: string }>("SELECT world_version_id FROM campaigns WHERE id=$1", [campaignId]);
    const client = await pool.connect();
    try {
      const source = await loadContinuityRepairSource(client, campaignId, ownerUserId, world.rows[0]!.world_version_id, 2);
      const artifact = buildContinuityRepairProposal(source);
      const proposal = artifact.proposals.find((item) => item.proposedValue === content)!;
      expect(proposal).toBeDefined();
      const body = campaignRuntimeStateUpdateSchema.parse((proposal.apply as { body: unknown }).body);
      expect(body.canonicalFacts.find((fact) => fact.content === content)?.id).toBeNull();
      const saved = await updateCampaignRuntimeState(pool, campaignId, body);
      expect(saved.canonicalFacts.find((fact) => fact.content === content)?.id).toEqual(expect.any(String));
      expect(saved.canonicalFacts.find((fact) => fact.content === content)?.id).not.toBe(factId);
      await expect(updateCampaignRuntimeState(pool, campaignId, body)).rejects.toThrow();
    } finally { client.release(); }
  });

  it("uses corrected retained narration and invalidates preflight even when state revision has not changed", async () => {
    const { campaignId, ownerUserId } = await createCorrectionFixture(pool);
    const content = "The lighthouse key is silver.";
    await pool.query(`UPDATE turns SET state_snapshot_private=jsonb_set(state_snapshot_private,'{canonicalFacts}',
      $2::jsonb) WHERE campaign_id=$1 AND turn_number=2`, [campaignId, JSON.stringify([{ id: crypto.randomUUID(), content }])]);
    const world = await pool.query<{ world_version_id: string }>("SELECT world_version_id FROM campaigns WHERE id=$1", [campaignId]);
    const client = await pool.connect();
    try {
      const before = await loadContinuityRepairSource(client, campaignId, ownerUserId, world.rows[0]!.world_version_id, 2);
      const artifact = buildContinuityRepairProposal(before);
      const proposed = artifact.proposals.find((item) => item.proposedValue === content)!;
      const staleBody = campaignRuntimeStateUpdateSchema.parse((proposed.apply as { body: unknown }).body);
      const turnId = before.acceptedSnapshots.find((turn) => turn.turnNumber === 2)!.turnId;
      const corrections = createTurnCorrectionApplication({ corrections: createPostgresTurnCorrectionRepository(pool, {
        memory: { async rebuildCampaignMemories() { return 0; }, async enqueueChunkIndex() { return null; } }
      }) });
      await corrections.correctNarration({ ownerUserId, campaignId }, { turnId, narration: "The lighthouse key is brass.", expectedCorrectionRevision: 0, expectedActiveTurnNumber: 2, source: "user_edit" });
      const after = await loadContinuityRepairSource(client, campaignId, ownerUserId, world.rows[0]!.world_version_id, 2);
      expect(after.baseRevision).toBe(before.baseRevision);
      await expect(updateCampaignRuntimeState(pool, campaignId, staleBody)).rejects.toThrow();
      expect(proposalRevisionIsStale(artifact, { stateRevision: after.baseRevision, narrationCorrectionRevisions: after.effectiveNarrations })).toBe(true);
      const reviewed = buildContinuityRepairProposal(after);
      expect(reviewed.proposals.some((item) => item.proposedValue === content)).toBe(false);
      expect(reviewed.unrecoverable).toContainEqual(expect.objectContaining({ reason: "corrected_source_requires_review" }));
    } finally { client.release(); }
  });

});
