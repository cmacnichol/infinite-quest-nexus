import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresReaderHistoryRepository } from "../../packages/database/src/reader-history-repository.js";
import { createReaderHistoryApplication } from "../../packages/application/src/reader-history/index.js";
import { registerReaderHistoryRoutes } from "../../services/api/src/reader-history-routes.js";
import { sha256 } from "../../packages/domain/src/text.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { readTurnReportedCostsForTest } from "../helpers/provider-application-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

integration("PostgreSQL exact reader turn lookup", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  const importedFixtures: Array<{ importId: string; campaignId: string; worldVersionId: string; worldId: string }> = [];
  const foreignUserIds: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  afterEach(async () => {
    const fixtures = [...importedFixtures];
    const users = [...foreignUserIds];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (fixtures.length) {
        await client.query("DELETE FROM imports WHERE id = ANY($1::uuid[])", [fixtures.map(({ importId }) => importId)]);
        await client.query("DELETE FROM campaigns WHERE id = ANY($1::uuid[])", [fixtures.map(({ campaignId }) => campaignId)]);
        await client.query("DELETE FROM world_drafts WHERE world_id = ANY($1::uuid[])", [fixtures.map(({ worldId }) => worldId)]);
        await client.query("DELETE FROM world_versions WHERE id = ANY($1::uuid[])", [fixtures.map(({ worldVersionId }) => worldVersionId)]);
        await client.query("DELETE FROM worlds WHERE id = ANY($1::uuid[])", [fixtures.map(({ worldId }) => worldId)]);
      }
      if (users.length) await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [users]);
      await client.query("COMMIT");
      importedFixtures.splice(0, fixtures.length);
      foreignUserIds.splice(0, users.length);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  async function createCampaignFixture() {
    const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Reader lookup ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `reader-lookup-${crypto.randomUUID()}.story`,
      story
    }));
    importedFixtures.push(imported);
    return imported;
  }

  it("returns the corrected accepted turn with its scoped public cost projection", async () => {
    const imported = await createCampaignFixture();
    const turns = await pool.query<{ id: string; narration: string; turnNumber: number }>(
      `SELECT id, narration, turn_number AS "turnNumber" FROM turns
        WHERE owner_user_id = $1 AND campaign_id = $2 ORDER BY turn_number`,
      [ownerUserId, imported.campaignId]
    );
    const accepted = turns.rows[0]!;
    const correctedNarration = "The corrected lantern waits beside the harbor gate.";
    await pool.query(
      `INSERT INTO turn_narration_corrections (
         owner_user_id, campaign_id, turn_id, revision, narration,
         previous_effective_narration_hash, source, created_by_user_id
       ) VALUES ($1,$2,$3,1,$4,$5,'administrative',$1)`,
      [ownerUserId, imported.campaignId, accepted.id, correctedNarration, sha256(accepted.narration)]
    );
    await pool.query(
      `INSERT INTO provider_cost_events (
         owner_user_id, campaign_id, turn_id, provider_type, category, operation,
         requested_model, resolved_model, amount, currency, usage_metadata
       ) VALUES ($1,$2,$3,'openai_compatible','story','story_turn','fixture-model','fixture-model',0.125,'USD','{}')`,
      [ownerUserId, imported.campaignId, accepted.id]
    );
    const foreignUser = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name, status) VALUES ($1, 'active') RETURNING id",
      [`Reader lookup foreign ${crypto.randomUUID()}`]
    );
    foreignUserIds.push(foreignUser.rows[0]!.id);

    let resolvedOwnerUserId = ownerUserId;
    const app = Fastify();
    const repository = createPostgresReaderHistoryRepository(pool, {
      turnReportedCosts: (client, ownerId, campaignId, turnIds) => readTurnReportedCostsForTest(client, ownerId, turnIds)
    });
    await app.register(registerReaderHistoryRoutes, {
      application: createReaderHistoryApplication({ turns: repository }),
      resolveOwner: async () => ({ ownerUserId: resolvedOwnerUserId })
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/campaigns/${imported.campaignId}/reader/turns/${accepted.turnNumber}`
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        campaignId: imported.campaignId,
        turn: {
          id: accepted.id,
          turnNumber: accepted.turnNumber,
          narration: correctedNarration,
          reportedCost: { amount: "0.125", currency: "USD", byCategory: { story: "0.125", image: "0", memory: "0" } }
        }
      });

      const missing = await app.inject({
        method: "GET",
        url: `/api/v1/campaigns/${imported.campaignId}/reader/turns/99999`
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: "Turn not found." });

      resolvedOwnerUserId = foreignUser.rows[0]!.id;
      const crossOwner = await app.inject({
        method: "GET",
        url: `/api/v1/campaigns/${imported.campaignId}/reader/turns/${accepted.turnNumber}`
      });
      expect(crossOwner.statusCode).toBe(404);
      expect(crossOwner.json()).toEqual(missing.json());
      expect(JSON.stringify(crossOwner.json())).not.toContain(accepted.id);
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
