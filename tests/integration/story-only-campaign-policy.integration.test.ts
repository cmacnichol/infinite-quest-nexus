import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { worldContentSchema, WORLD_CONTENT_SCHEMA_VERSION } from "../../packages/contracts/src/world-library.js";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

function fixtureContent(title: string) {
  return worldContentSchema.parse({
    schemaVersion: WORLD_CONTENT_SCHEMA_VERSION,
    world: { title, genre: "test", tone: "neutral", premise: "P", backgroundStory: "B", firstAction: "Begin.", rules: "R" },
    playableCharacters: [{ id: "hero", name: "Hero", characterText: "Hero", rpgStats: [], defaultTriggers: [] }]
  });
}

integration("story-only campaign policy migration", () => {
  let pool: DatabasePool;
  let ownerUserId: string;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 2);
  });

  afterAll(async () => { await pool?.end(); });

  it("upgrades populated pre-0094 data while normalizing only persisted Auto defaults", async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    const migrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-pre0094-"));
    try {
      for (const file of await readdir(resolve("database/migrations"))) {
        if (file.endsWith(".sql") && !file.startsWith("0094_")) {
          await copyFile(join(resolve("database/migrations"), file), join(migrationDirectory, file));
        }
      }
      await migrateDatabase(pool, migrationDirectory);
      ownerUserId = await initialOwnerId(pool);
      const adapters = createPostgresWorldRepositoryAdapters(pool, {
        memory: { async autoEnableCampaignEmbedding() {} } as never
      });
      const title = `Pre-0094 ${crypto.randomUUID()}`;
      const created = await adapters.transaction.command((transaction) => adapters.worlds.createWorld(
        transaction, { ownerUserId }, { title, content: fixtureContent(title) }
      ));
      if (!created.ok) throw new Error(created.failure.reason);
      const published = await adapters.transaction.command((transaction) => adapters.worlds.publishWorld(
        transaction, { ownerUserId, worldId: created.value.id }, { expectedRevision: created.value.draftRevision, releaseNotes: "pre-0094" }
      ));
      if (!published.ok) throw new Error(published.failure.reason);
      const campaign = await adapters.transaction.command((transaction) => adapters.campaigns.createCampaign(
        transaction,
        { ownerUserId },
        { worldVersionId: published.value.worldVersionId, title: "Pre-0094 campaign", storyLengthProfile: "standard", storyContextBudgetTokens: 32000, turnControlStyle: "flexible_action" }
      ));
      if (!campaign.ok) throw new Error(campaign.failure.reason);
      const foreign = await pool.query<{ id: string }>(
        `INSERT INTO users (display_name, settings) VALUES ($1,$2::jsonb) RETURNING id`,
        ["Pre-0094 profile", JSON.stringify({ defaultTurnControlStyle: "flexible_auto", retainedPreference: "keep" })]
      );
      const provider = await pool.query<{ id: string }>(
        `INSERT INTO provider_profiles (owner_user_id,name,provider_type,provider_role,base_url,default_model)
         VALUES ($1,'pre-0094 provider','openai_compatible','text','http://provider.test','model') RETURNING id`, [ownerUserId]
      );
      await pool.query("UPDATE campaigns SET turn_control_style = 'flexible_auto' WHERE id = $1", [campaign.value.id]);
      await pool.query(
        `UPDATE campaign_state SET trackers = '[{"id":"tracker","value":"kept"}]',
           pending_event_triggers = '[{"id":"pending","value":"kept"}]', rpg_stats = '[{"id":"stat","value":7}]'
         WHERE campaign_id = $1`, [campaign.value.id]
      );
      await pool.query(
        `INSERT INTO turns (owner_user_id,campaign_id,turn_number,narration,model_metadata)
         VALUES ($1,$2,1,'Historic turn',$3::jsonb)`, [ownerUserId, campaign.value.id, JSON.stringify({ historical: true })]
      );
      await pool.query(
        `INSERT INTO generation_jobs (owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,status,prompt_protocol_version,prompt_snapshot)
         VALUES ($1,$2,$3,$4,2,'Historic job','completed','story-v1','{}'::jsonb)`,
        [ownerUserId, campaign.value.id, provider.rows[0]!.id, crypto.randomUUID()]
      );
      await migrateDatabase(pool, resolve("database/migrations"));
      expect(await pool.query("SELECT turn_control_style FROM campaigns WHERE id=$1", [campaign.value.id])).toMatchObject({ rows: [{ turn_control_style: "flexible_action" }] });
      expect(await pool.query("SELECT settings FROM users WHERE id=$1", [foreign.rows[0]!.id])).toMatchObject({ rows: [{ settings: { defaultTurnControlStyle: "flexible_action", retainedPreference: "keep" } }] });
      expect(await pool.query("SELECT trackers,pending_event_triggers,rpg_stats FROM campaign_state WHERE campaign_id=$1", [campaign.value.id])).toMatchObject({ rows: [{ trackers: [{ id: "tracker", value: "kept" }], pending_event_triggers: [{ id: "pending", value: "kept" }], rpg_stats: [{ id: "stat", value: 7 }] }] });
      expect(await pool.query("SELECT generation_policy FROM generation_jobs WHERE campaign_id=$1", [campaign.value.id])).toMatchObject({ rows: [{ generation_policy: null }] });
      expect(await pool.query("SELECT generation_policy,model_metadata FROM turns WHERE campaign_id=$1", [campaign.value.id])).toMatchObject({ rows: [{ generation_policy: null, model_metadata: { historical: true } }] });
    } finally {
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it("adds nullable historical policy columns and rejects malformed policies on both rows", async () => {
    const columns = await pool.query<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable FROM information_schema.columns WHERE table_schema='public' AND column_name='generation_policy' ORDER BY table_name`
    );
    expect(columns.rows).toEqual([{ table_name: "generation_jobs", is_nullable: "YES" }, { table_name: "turns", is_nullable: "YES" }]);
    expect(ownerUserId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});