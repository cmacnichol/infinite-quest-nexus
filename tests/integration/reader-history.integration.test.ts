import { readFile, writeFile } from "node:fs/promises";
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

  it("searches the complete accepted ledger with literal queries and a history-bound cursor", async () => {
    const imported = await createCampaignFixture();
    const otherCampaign = await createCampaignFixture();
    const generated = await pool.query<{ id: string; turnNumber: number; narration: string }>(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration, mechanics_private, model_metadata)
       SELECT $1, $2, turn_number, 'Routine action ' || turn_number,
              CASE turn_number
                WHEN 1000 THEN 'The oldneedle is buried in the earliest record.'
                WHEN 1001 THEN 'Before correction text is searchable here.'
                WHEN 1002 THEN 'Literal token stored safely.'
                WHEN 1003 THEN repeat('Excerpt bound verification. ', 12)
                WHEN 1004 THEN 'Private evidence stays hidden.'
                WHEN 1005 THEN repeat('🧪', 160)
                ELSE 'Ordinary historical summary ' || turn_number
              END,
              CASE WHEN turn_number = 1004 THEN '{"canary":"PRIVATE_HISTORY_CANARY"}'::jsonb ELSE NULL END,
              CASE WHEN turn_number = 1004 THEN '{"raw":"PRIVATE_HISTORY_CANARY"}'::jsonb ELSE '{}'::jsonb END
         FROM generate_series(1000, 2999) AS turn_number
        RETURNING id, turn_number AS "turnNumber", narration`,
      [ownerUserId, imported.campaignId]
    );
    expect(generated.rows).toHaveLength(2000);
    const corrected = generated.rows.find(({ turnNumber }) => turnNumber === 1001)!;
    await pool.query(
      `INSERT INTO turn_narration_corrections (
         owner_user_id,campaign_id,turn_id,revision,narration,previous_effective_narration_hash,source,created_by_user_id
       ) VALUES ($1,$2,$3,1,'The Effective Corrected Phrase replaces the old prose.',$4,'administrative',$1)`,
      [ownerUserId, imported.campaignId, corrected.id, sha256(corrected.narration)]
    );
    await pool.query(
      "UPDATE turns SET action = $1 WHERE owner_user_id = $2 AND campaign_id = $3 AND turn_number = 1002",
      ["Find %_O'Reilly exactly", ownerUserId, imported.campaignId]
    );
    await pool.query("ANALYZE turns");
    await pool.query("ANALYZE turn_narration_corrections");
    const unmaterializedHistoryPlan = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT effective.turn_id
         FROM effective_turn_narrations effective
         JOIN turns turn_row
           ON turn_row.id = effective.turn_id
          AND turn_row.campaign_id = effective.campaign_id
          AND turn_row.owner_user_id = effective.owner_user_id
        WHERE effective.owner_user_id = $1 AND effective.campaign_id = $2
          AND (effective.effective_narration ILIKE '%' || $3 || '%' ESCAPE E'\\\\'
               OR turn_row.action ILIKE '%' || $3 || '%' ESCAPE E'\\\\')
        ORDER BY effective.turn_number DESC, effective.turn_id DESC
        LIMIT 51`,
      [ownerUserId, imported.campaignId, "oldneedle"]
    );
    await writeFile(
      resolve(".superpowers/sdd/legacy-ui-2026-10-03/evidence/T14/explain-2000-turn-search-unmaterialized.json"),
      `${JSON.stringify(unmaterializedHistoryPlan.rows[0]?.["QUERY PLAN"], null, 2)}\n`,
      "utf8"
    );
    const historyPlan = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       WITH effective_history AS MATERIALIZED (
         SELECT turn_id, owner_user_id, campaign_id, turn_number, effective_narration
           FROM effective_turn_narrations
          WHERE owner_user_id = $1 AND campaign_id = $2
       )
       SELECT effective.turn_id
         FROM effective_history effective
         JOIN turns turn_row
           ON turn_row.id = effective.turn_id
          AND turn_row.campaign_id = effective.campaign_id
          AND turn_row.owner_user_id = effective.owner_user_id
        WHERE (effective.effective_narration ILIKE '%' || $3 || '%' ESCAPE E'\\\\'
               OR turn_row.action ILIKE '%' || $3 || '%' ESCAPE E'\\\\')
        ORDER BY effective.turn_number DESC, effective.turn_id DESC
        LIMIT 51`,
      [ownerUserId, imported.campaignId, "oldneedle"]
    );
    await writeFile(
      resolve(".superpowers/sdd/legacy-ui-2026-10-03/evidence/T14/explain-2000-turn-search.json"),
      `${JSON.stringify(historyPlan.rows[0]?.["QUERY PLAN"], null, 2)}\n`,
      "utf8"
    );

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
      const base = `/api/v1/campaigns/${imported.campaignId}/reader/history`;
      const oldMatch = await app.inject({ method: "GET", url: `${base}?q=oldneedle&limit=1` });
      expect(oldMatch.statusCode).toBe(200);
      expect(oldMatch.json().items).toEqual([expect.objectContaining({
        id: generated.rows.find(({ turnNumber }) => turnNumber === 1000)!.id,
        turnNumber: 1000
      })]);

      const effectiveMatch = await app.inject({ method: "GET", url: `${base}?q=effective%20corrected%20phrase` });
      expect(effectiveMatch.statusCode).toBe(200);
      expect(effectiveMatch.json().items).toHaveLength(1);
      expect(effectiveMatch.json().items[0].excerpt).toContain("Effective Corrected Phrase");
      const supersededMatch = await app.inject({ method: "GET", url: `${base}?q=before%20correction` });
      expect(supersededMatch.json().items).toHaveLength(0);

      const literalMatch = await app.inject({ method: "GET", url: `${base}?q=${encodeURIComponent("%_O'Reilly")}` });
      expect(literalMatch.statusCode).toBe(200);
      expect(literalMatch.json().items.map((item: { turnNumber: number }) => item.turnNumber)).toEqual([1002]);

      const privateSearch = await app.inject({ method: "GET", url: `${base}?q=PRIVATE_HISTORY_CANARY` });
      expect(privateSearch.statusCode).toBe(200);
      expect(privateSearch.json().items).toHaveLength(0);
      expect(JSON.stringify(privateSearch.json())).not.toContain("PRIVATE_HISTORY_CANARY");

      const foreign = await createForeignCampaignFixture();
      const foreignSearch = await app.inject({ method: "GET", url: `/api/v1/campaigns/${foreign.campaignId}/reader/history` });
      expect(foreignSearch.statusCode).toBe(200);
      expect(foreignSearch.json().items).toHaveLength(0);
      expect(JSON.stringify(foreignSearch.json())).not.toContain(foreign.ownerUserId);

      const excerpt = await app.inject({ method: "GET", url: `${base}?q=excerpt%20bound%20verification` });
      expect(excerpt.json().items[0].excerpt).toHaveLength(240);
      const unicodeExcerpt = await app.inject({ method: "GET", url: `${base}?q=${encodeURIComponent("🧪")}&limit=50` });
      const boundedUnicode = unicodeExcerpt.json().items.find((item: { turnNumber: number }) => item.turnNumber === 1005).excerpt as string;
      expect(boundedUnicode.length).toBeLessThanOrEqual(240);
      expect(() => encodeURIComponent(boundedUnicode)).not.toThrow();

      const firstPage = await app.inject({ method: "GET", url: `${base}?limit=1` });
      const cursor = firstPage.json().nextCursor;
      expect(typeof cursor).toBe("string");
      expect(firstPage.json().items[0].turnNumber).toBe(2999);
      expect(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")).schemaVersion).toBe(1);
      const wrongQuery = await app.inject({ method: "GET", url: `${base}?q=different&limit=1&before=${encodeURIComponent(cursor)}` });
      const wrongCampaign = await app.inject({ method: "GET", url: `/api/v1/campaigns/${otherCampaign.campaignId}/reader/history?limit=1&before=${encodeURIComponent(cursor)}` });
      const malformed = await app.inject({ method: "GET", url: `${base}?limit=1&before=not-a-cursor` });
      expect(wrongQuery.statusCode).toBe(400);
      expect(wrongCampaign.statusCode).toBe(400);
      expect(malformed.statusCode).toBe(400);

      await pool.query(
        "INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration) VALUES ($1,$2,3000,'Later action','Later accepted narration')",
        [ownerUserId, imported.campaignId]
      );
      const changedHistory = await app.inject({ method: "GET", url: `${base}?limit=1&before=${encodeURIComponent(cursor)}` });
      expect(changedHistory.statusCode).toBe(409);

      for (const limit of [0, 51, 1.5]) {
        const invalidLimit = await app.inject({ method: "GET", url: `${base}?limit=${limit}` });
        expect(invalidLimit.statusCode).toBe(400);
      }
      const longQuery = await app.inject({ method: "GET", url: `${base}?q=${"x".repeat(201)}` });
      expect(longQuery.statusCode).toBe(400);
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
