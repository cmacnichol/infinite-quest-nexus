import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../../packages/database/src/config.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresReaderHistoryRepository } from "../../packages/database/src/reader-history-repository.js";
import { buildServer } from "../../services/api/src/server.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { inertProviders, inertStorageServerOptions } from "../helpers/build-server-options.js";
import { readTurnReportedCostsForTest } from "../helpers/provider-application-fixtures.js";
import { sha256 } from "../../packages/domain/src/text.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

type ImportedFixture = Readonly<{ importId: string; campaignId: string; worldVersionId: string; worldId: string }>;
type ForeignFixture = Readonly<{ ownerUserId: string; campaignId: string; worldVersionId: string; worldId: string }>;

integration("PostgreSQL exact reader turn lookup", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  const importedFixtures: ImportedFixture[] = [];
  const foreignFixtures: ForeignFixture[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  afterEach(async () => {
    const imports = [...importedFixtures];
    const foreign = [...foreignFixtures];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (imports.length) {
        await client.query("DELETE FROM imports WHERE id = ANY($1::uuid[])", [imports.map(({ importId }) => importId)]);
      }
      const campaignIds = [...imports.map(({ campaignId }) => campaignId), ...foreign.map(({ campaignId }) => campaignId)];
      const worldVersionIds = [...imports.map(({ worldVersionId }) => worldVersionId), ...foreign.map(({ worldVersionId }) => worldVersionId)];
      const worldIds = [...imports.map(({ worldId }) => worldId), ...foreign.map(({ worldId }) => worldId)];
      if (campaignIds.length) await client.query("DELETE FROM campaigns WHERE id = ANY($1::uuid[])", [campaignIds]);
      if (worldIds.length) await client.query("DELETE FROM world_drafts WHERE world_id = ANY($1::uuid[])", [worldIds]);
      if (worldVersionIds.length) await client.query("DELETE FROM world_versions WHERE id = ANY($1::uuid[])", [worldVersionIds]);
      if (worldIds.length) await client.query("DELETE FROM worlds WHERE id = ANY($1::uuid[])", [worldIds]);
      const foreignUserIds = foreign.map(({ ownerUserId }) => ownerUserId);
      if (foreignUserIds.length) await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [foreignUserIds]);
      await client.query("COMMIT");
      importedFixtures.splice(0, imports.length);
      foreignFixtures.splice(0, foreign.length);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  async function createCampaignFixture(): Promise<ImportedFixture> {
    const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Reader lookup ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `reader-lookup-${crypto.randomUUID()}.story`,
      story
    }));
    importedFixtures.push(imported);
    return imported;
  }

  async function createForeignCampaignFixture(): Promise<ForeignFixture> {
    const user = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name, status) VALUES ($1, 'active') RETURNING id",
      [`Reader lookup foreign ${crypto.randomUUID()}`]
    );
    const foreign: ForeignFixture = {
      ownerUserId: user.rows[0]!.id,
      campaignId: crypto.randomUUID(),
      worldVersionId: crypto.randomUUID(),
      worldId: crypto.randomUUID()
    };
    await pool.query("INSERT INTO worlds (id, owner_user_id, title) VALUES ($1,$2,$3)", [foreign.worldId, foreign.ownerUserId, "Foreign reader world"]);
    await pool.query("INSERT INTO world_versions (id, world_id, owner_user_id, version_number, content) VALUES ($1,$2,$3,1,'{}'::jsonb)", [foreign.worldVersionId, foreign.worldId, foreign.ownerUserId]);
    await pool.query("INSERT INTO campaigns (id, owner_user_id, world_version_id, title) VALUES ($1,$2,$3,'Foreign reader campaign')", [foreign.campaignId, foreign.ownerUserId, foreign.worldVersionId]);
    await pool.query("INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration) VALUES ($1,$2,1,'Foreign action','Foreign narration')", [foreign.ownerUserId, foreign.campaignId]);
    foreignFixtures.push(foreign);
    return foreign;
  }

  it("registers exact lookup through buildServer and hides foreign-owned campaigns", async () => {
    const imported = await createCampaignFixture();
    const accepted = (await pool.query<{ id: string; narration: string; turnNumber: number }>(
      `SELECT id, narration, turn_number AS "turnNumber" FROM turns
        WHERE owner_user_id = $1 AND campaign_id = $2 ORDER BY turn_number LIMIT 1`,
      [ownerUserId, imported.campaignId]
    )).rows[0]!;
    const correctedNarration = "The buildServer correction is visible.";
    await pool.query(
      `INSERT INTO turn_narration_corrections (
         owner_user_id,campaign_id,turn_id,revision,narration,previous_effective_narration_hash,source,created_by_user_id
       ) VALUES ($1,$2,$3,1,$4,$5,'administrative',$1)`,
      [ownerUserId, imported.campaignId, accepted.id, correctedNarration, sha256(accepted.narration)]
    );
    await pool.query(
      `INSERT INTO provider_cost_events (
         owner_user_id,campaign_id,turn_id,provider_type,category,operation,requested_model,resolved_model,amount,currency,usage_metadata
       ) VALUES ($1,$2,$3,'openai_compatible','story','story_turn','fixture-model','fixture-model',0.125,'USD','{}')`,
      [ownerUserId, imported.campaignId, accepted.id]
    );
    const foreign = await createForeignCampaignFixture();

    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl!;
    let config: RuntimeConfig;
    try {
      config = { ...loadRuntimeConfig(), systemArchiveEnabled: false };
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
    const providers = {
      ...inertProviders,
      application: {
        ...inertProviders.application,
        getTurnCosts: ({ ownerUserId: scopedOwnerId, turnIds }: { ownerUserId: string; campaignId: string; turnIds: string[] }) =>
          readTurnReportedCostsForTest(pool, scopedOwnerId, turnIds)
      }
    };
    const app = await buildServer(inertStorageServerOptions({ pool, config, providers }));
    try {
      const owned = await app.inject({ method: "GET", url: `/api/v1/campaigns/${imported.campaignId}/reader/turns/${accepted.turnNumber}` });
      expect(owned.statusCode).toBe(200);
      expect(owned.json()).toMatchObject({
        campaignId: imported.campaignId,
        turn: {
          id: accepted.id,
          turnNumber: accepted.turnNumber,
          narration: correctedNarration,
          reportedCost: { amount: "0.125", currency: "USD" }
        }
      });

      const missing = await app.inject({ method: "GET", url: `/api/v1/campaigns/${imported.campaignId}/reader/turns/99999` });
      const crossOwner = await app.inject({ method: "GET", url: `/api/v1/campaigns/${foreign.campaignId}/reader/turns/1` });
      expect(missing.statusCode).toBe(404);
      expect(crossOwner.statusCode).toBe(404);
      expect(crossOwner.json()).toEqual(missing.json());
      expect(JSON.stringify(crossOwner.json())).not.toContain(foreign.campaignId);
      expect(JSON.stringify(crossOwner.json())).not.toContain(foreign.ownerUserId);
    } finally {
      await app.close();
    }
  });

  it("never returns an accepted turn identity from another campaign", async () => {
    const first = await createCampaignFixture();
    const second = await createCampaignFixture();
    const firstTurn = await pool.query<{ id: string; turnNumber: number }>(
      "SELECT id, turn_number AS \"turnNumber\" FROM turns WHERE owner_user_id = $1 AND campaign_id = $2 ORDER BY turn_number LIMIT 1",
      [ownerUserId, first.campaignId]
    );
    const secondTurn = await pool.query<{ id: string; turnNumber: number }>(
      "SELECT id, turn_number AS \"turnNumber\" FROM turns WHERE owner_user_id = $1 AND campaign_id = $2 ORDER BY turn_number LIMIT 1",
      [ownerUserId, second.campaignId]
    );
    const repository = createPostgresReaderHistoryRepository(pool, {
      turnReportedCosts: async () => new Map()
    });

    const result = await repository.getEffectiveTurn(
      { ownerUserId, campaignId: first.campaignId },
      secondTurn.rows[0]!.turnNumber
    );

    expect(result?.id).toBe(firstTurn.rows[0]!.id);
    expect(result?.id).not.toBe(secondTurn.rows[0]!.id);
  });
});
