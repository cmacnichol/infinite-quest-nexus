import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPostgresChronicleGenerationTransactionPort } from "../../packages/database/src/chronicle-repository.js";
import { buildCanonicalChronicleFacts } from "../../packages/domain/src/chronicle-memory-helpers.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool,
  withTransaction
} from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

integration("mixed canonical fact persistence", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM campaigns");
    await pool.query("DELETE FROM world_versions");
    await pool.query("DELETE FROM worlds");
    await pool.query("DELETE FROM users WHERE system_key IS NULL");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function campaignFixture() {
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `Mixed canonical facts ${crypto.randomUUID()}`]
    );
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerUserId, JSON.stringify({ world: { title: "Mixed canonical facts" }, entities: [] })]
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, version.rows[0]!.id, "Mixed canonical facts"]
    );
    await pool.query(
      "INSERT INTO campaign_state (campaign_id, owner_user_id) VALUES ($1,$2)",
      [campaign.rows[0]!.id, ownerUserId]
    );
    return { campaignId: campaign.rows[0]!.id, worldVersionId: version.rows[0]!.id };
  }

  it("persists and replays distinct additions alongside structured updates", async () => {
    const fixture = await campaignFixture();
    const first = await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration,state_snapshot_private)
       VALUES ($1,$2,1,'Inspect the harbor.','The harbor gate remains locked.',$3::jsonb) RETURNING id`,
      [ownerUserId, fixture.campaignId, JSON.stringify({
        canonicalFacts: ["The harbor gate is locked."],
        canonicalFactUpdates: []
      })]
    );
    const lockedFactId = buildCanonicalChronicleFacts({
      campaignId: fixture.campaignId,
      turnId: first.rows[0]!.id,
      canonicalFacts: ["The harbor gate is locked."],
      entityCatalog: []
    })[0]!.id;
    const second = await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration,state_snapshot_private)
       VALUES ($1,$2,2,'Search beneath the bridge.','A brass key is found as the harbor gate opens.',$3::jsonb) RETURNING id`,
      [ownerUserId, fixture.campaignId, JSON.stringify({
        canonicalFacts: ["The brass key rests beneath the bridge."],
        canonicalFactUpdates: [{
          content: "The harbor gate is open.",
          supersedesFactIds: [lockedFactId]
        }]
      })]
    );
    const transaction = createPostgresChronicleGenerationTransactionPort({
      embeddings: {
        async resolve() { return { status: "unconfigured" as const, resolutionSource: "none" as const, resolvedRole: null }; },
        async load() { throw new Error("not used by canonical fact persistence"); },
        async embed() { throw new Error("not used by canonical fact persistence"); },
        async fingerprint() { throw new Error("not used by canonical fact persistence"); },
        async recordHealth() {},
        async recordCost() { return null; },
        logDiagnostic() {}
      }
    });
    const scope = { ownerUserId, campaignId: fixture.campaignId, worldVersionId: fixture.worldVersionId };

    await withTransaction(pool, async (client) => {
      await transaction.storeDerivedTurnMemories(client, {
        ...scope,
        turnId: first.rows[0]!.id,
        ordinal: 1,
        derived: { canonicalFacts: ["The harbor gate is locked."] }
      });
      await transaction.storeDerivedTurnMemories(client, {
        ...scope,
        turnId: second.rows[0]!.id,
        ordinal: 2,
        derived: {
          canonicalFacts: ["The brass key rests beneath the bridge."],
          canonicalFactUpdates: [{ content: "The harbor gate is open.", supersedesFactIds: [lockedFactId] }]
        }
      });
    });

    const activeFacts = async () => pool.query<{ content: string; superseded_by_fact_id: string | null }>(
      `SELECT content,superseded_by_fact_id FROM campaign_canonical_facts
        WHERE campaign_id=$1 AND valid_until_turn IS NULL ORDER BY source_turn_number,source_fact_index`,
      [fixture.campaignId]
    );
    await expect(activeFacts()).resolves.toMatchObject({ rows: [
      { content: "The harbor gate is open.", superseded_by_fact_id: null },
      { content: "The brass key rests beneath the bridge.", superseded_by_fact_id: null }
    ] });

    await withTransaction(pool, (client) => transaction.rebuildCampaignMemories(client, scope));

    await expect(activeFacts()).resolves.toMatchObject({ rows: [
      { content: "The harbor gate is open.", superseded_by_fact_id: null },
      { content: "The brass key rests beneath the bridge.", superseded_by_fact_id: null }
    ] });
    const canonicalMemory = await pool.query<{ content: string }>(
      `SELECT content FROM chronicle_memories
        WHERE campaign_id=$1 AND memory_kind='canonical_fact' ORDER BY content`,
      [fixture.campaignId]
    );
    expect(canonicalMemory.rows).toHaveLength(1);
    expect(canonicalMemory.rows[0]?.content).toContain("The harbor gate is open.");
    expect(canonicalMemory.rows[0]?.content).toContain("The brass key rests beneath the bridge.");
  });
});
