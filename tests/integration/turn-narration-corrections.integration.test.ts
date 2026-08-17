import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import {
  createTurnCorrectionApplication
} from "../../packages/application/src/turn-corrections/index.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, type DatabaseClient, type DatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresTurnCorrectionRepository } from "../../packages/database/src/turn-correction-repository.js";
import { readTurnPage } from "../../packages/database/src/play-loop-read-repository.js";
import { readReadableCampaignExport } from "../../packages/database/src/readable-campaign-export-repository.js";
import type { MemoryGenerationTransactionPort } from "../../packages/application/src/memory/index.js";
import { DEDICATED_CHUNKED_AUDIT } from "../fixtures/chronicle-retrieval-audits.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("accepted-turn narration corrections", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  let campaignId: string;
  let turnId: string;
  const enqueueChunkIndex = vi.fn(async () => null);

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = (await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE system_key = 'initial-owner'"
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    enqueueChunkIndex.mockClear();
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1,'Correction World') RETURNING id",
      [ownerUserId]
    );
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,1,'{"world":{"title":"Correction World"}}'::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerUserId]
    );
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (owner_user_id, world_version_id, title, active_turn_number)
       VALUES ($1,$2,'Correction Campaign',1) RETURNING id`,
      [ownerUserId, version.rows[0]!.id]
    );
    campaignId = campaign.rows[0]!.id;
    const turn = await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, narration, image_url, model_metadata)
       VALUES ($1,$2,1,'The old moon fades.','/api/assets/existing', $3::jsonb) RETURNING id`,
      [ownerUserId, campaignId, JSON.stringify({ chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })]
    );
    turnId = turn.rows[0]!.id;
  });

  function application(memory: Pick<MemoryGenerationTransactionPort, "rebuildCampaignMemories" | "enqueueChunkIndex"> = {
    async rebuildCampaignMemories() { return 0; },
    enqueueChunkIndex
  }) {
    const repository = createPostgresTurnCorrectionRepository(pool, {
      memory
    });
    return createTurnCorrectionApplication({ corrections: repository });
  }

  const request = (narration: string, expectedCorrectionRevision = 0) => ({
    turnId,
    narration,
    expectedCorrectionRevision,
    expectedActiveTurnNumber: 1,
    source: "user_edit" as const
  });

  it("appends revisioned corrections while preserving the accepted narration", async () => {
    const corrections = application();

    const first = await corrections.correctNarration(
      { ownerUserId, campaignId },
      request("The silver moon rises above the quiet harbor.")
    );
    const second = await corrections.correctNarration(
      { ownerUserId, campaignId },
      request("The silver moon rises above the lantern-lit harbor.", 1)
    );

    expect(first).toMatchObject({
      correctionRevision: 1,
      originalNarration: "The old moon fades.",
      illustrationsMayBeStale: true
    });
    expect(second).toMatchObject({
      correctionRevision: 2,
      originalNarration: "The old moon fades.",
      effectiveNarration: "The silver moon rises above the lantern-lit harbor.",
      illustrationsMayBeStale: true
    });
    await expect(readTurnPage(pool, ownerUserId, campaignId, undefined, 10)).resolves.toMatchObject({
      turns: [{ narration: "The silver moon rises above the lantern-lit harbor.", chronicleRetrieval: DEDICATED_CHUNKED_AUDIT }]
    });
    await expect(readReadableCampaignExport(pool, ownerUserId, campaignId)).resolves.toMatchObject({
      turns: [{ narration: "The silver moon rises above the lantern-lit harbor." }]
    });
    await expect(pool.query<{ narration: string }>(
      "SELECT narration FROM turns WHERE id = $1",
      [turnId]
    )).resolves.toMatchObject({ rows: [{ narration: "The old moon fades." }] });
    await expect(pool.query<{ revisions: string; events: string }>(
      `SELECT
         (SELECT count(*)::text FROM turn_narration_corrections WHERE turn_id = $1) AS revisions,
         (SELECT count(*)::text FROM activity_events
           WHERE campaign_id = $2 AND event_type = 'turn_narration_corrected') AS events`,
      [turnId, campaignId]
    )).resolves.toMatchObject({ rows: [{ revisions: "2", events: "2" }] });
    expect(enqueueChunkIndex).toHaveBeenCalledTimes(2);
    expect(enqueueChunkIndex).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      ownerUserId,
      campaignId
    }));
  });

  it("keeps an accepted correction when chunk enqueue SQL fails", async () => {
    const failedEnqueue = vi.fn(async (database: DatabaseClient) => {
      await database.query("SELECT * FROM task_11_missing_chunk_enqueue_relation");
      return null;
    });
    const corrections = application({
      async rebuildCampaignMemories() { return 0; },
      enqueueChunkIndex: failedEnqueue
    });

    await expect(corrections.correctNarration(
      { ownerUserId, campaignId },
      request("The silver moon survives a derived indexing outage.")
    )).resolves.toMatchObject({ correctionRevision: 1 });
    expect(failedEnqueue).toHaveBeenCalledOnce();
    await expect(pool.query(
      "SELECT narration FROM turn_narration_corrections WHERE turn_id = $1",
      [turnId]
    )).resolves.toMatchObject({ rows: [{ narration: "The silver moon survives a derived indexing outage." }] });
  });

  it("fails closed on stale correction and active-turn fences", async () => {
    const corrections = application();
    await corrections.correctNarration(
      { ownerUserId, campaignId },
      request("The silver moon rises above the quiet harbor.")
    );

    await expect(corrections.correctNarration(
      { ownerUserId, campaignId },
      request("A second editor changes the harbor.")
    )).rejects.toMatchObject({
      kind: "stale_state",
      reason: "correction_revision_changed"
    });
    await expect(corrections.correctNarration(
      { ownerUserId, campaignId },
      { ...request("The active fence is stale.", 1), expectedActiveTurnNumber: 2 }
    )).rejects.toMatchObject({
      kind: "stale_state",
      reason: "active_turn_changed"
    });
  });

  it("rejects mechanics leakage and cross-campaign turn identifiers", async () => {
    const corrections = application();

    await expect(corrections.correctNarration(
      { ownerUserId, campaignId },
      request("The d20 roll succeeds and the gate opens.")
    )).rejects.toMatchObject({
      kind: "invalid_request",
      reason: "mechanics_leak"
    });
    await expect(corrections.correctNarration(
      { ownerUserId, campaignId: crypto.randomUUID() },
      request("The silver moon rises above the quiet harbor.")
    )).rejects.toMatchObject({
      kind: "not_found",
      reason: "campaign_not_found"
    });

    const foreignOwner = await pool.query<{ id: string }>(
      `INSERT INTO users (system_key, display_name)
       VALUES ($1,'Foreign Owner') RETURNING id`,
      [`turn-correction-${crypto.randomUUID()}`]
    );
    await expect(corrections.correctNarration(
      { ownerUserId: foreignOwner.rows[0]!.id, campaignId },
      request("The silver moon rises above the quiet harbor.")
    )).rejects.toMatchObject({
      kind: "not_found",
      reason: "campaign_not_found"
    });
  });

  it("rejects corrections while generation work is active", async () => {
    const profile = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model
       ) VALUES ($1,$2,'openai_compatible','text','http://provider.invalid','test-model')
       RETURNING id`,
      [ownerUserId, `Correction provider ${crypto.randomUUID()}`]
    );
    await pool.query(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key,
         expected_turn_number, action, status
       ) VALUES ($1,$2,$3,$4,2,'Continue','recoverable')`,
      [ownerUserId, campaignId, profile.rows[0]!.id, crypto.randomUUID()]
    );

    await expect(application().correctNarration(
      { ownerUserId, campaignId },
      request("The silver moon rises above the quiet harbor.")
    )).rejects.toMatchObject({
      kind: "conflict",
      reason: "generation_active"
    });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM turn_narration_corrections WHERE turn_id = $1",
      [turnId]
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("allows only one concurrent correction at the same expected revision", async () => {
    const corrections = application();
    const results = await Promise.allSettled([
      corrections.correctNarration(
        { ownerUserId, campaignId },
        request("The first editor restores the moonlit harbor.")
      ),
      corrections.correctNarration(
        { ownerUserId, campaignId },
        request("The second editor restores the moonlit harbor.")
      )
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM turn_narration_corrections WHERE turn_id = $1",
      [turnId]
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });
});
