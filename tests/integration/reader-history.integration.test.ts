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

  async function createReaderHistoryApp(): Promise<Awaited<ReturnType<typeof buildServer>>> {
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
    return buildServer(inertStorageServerOptions({ pool, config, providers }));
  }

  function sceneWindowPath(campaignId: string, options: Readonly<{
    anchorTurnNumber: number;
    anchorTurnId: string;
    direction: "older" | "newer";
    neighborLimit?: number;
    historyToken?: string;
  }>): string {
    const query = new URLSearchParams({
      anchorTurnNumber: String(options.anchorTurnNumber),
      anchorTurnId: options.anchorTurnId,
      direction: options.direction
    });
    if (options.neighborLimit !== undefined) query.set("neighborLimit", String(options.neighborLimit));
    if (options.historyToken !== undefined) query.set("historyToken", options.historyToken);
    return `/api/v1/campaigns/${campaignId}/reader/scene-window?${query.toString()}`;
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

  it("continues a matching query without duplicates and rejects cursors after correction-only changes", async () => {
    const imported = await createCampaignFixture();
    const inserted = await pool.query<{ id: string; turnNumber: number; narration: string }>(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration)
       VALUES ($1,$2,100,'Inspect the archive','Pagination marker older original prose'),
              ($1,$2,101,'Inspect the tower','Pagination marker newer original prose'),
              ($1,$2,102,'Walk away','Unrelated newest prose')
       RETURNING id, turn_number AS "turnNumber", narration`,
      [ownerUserId, imported.campaignId]
    );
    const older = inserted.rows.find(({ turnNumber }) => turnNumber === 100)!;
    const newer = inserted.rows.find(({ turnNumber }) => turnNumber === 101)!;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl!;
    let config: RuntimeConfig;
    try {
      config = { ...loadRuntimeConfig(), systemArchiveEnabled: false };
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
    const app = await buildServer(inertStorageServerOptions({ pool, config, providers: inertProviders }));
    try {
      const base = `/api/v1/campaigns/${imported.campaignId}/reader/history?q=pagination%20marker&limit=1`;
      const first = await app.inject({ method: "GET", url: base });
      expect(first.statusCode).toBe(200);
      expect(first.json().items.map(({ id }: { id: string }) => id)).toEqual([newer.id]);
      const cursor = first.json().nextCursor;
      expect(cursor).toEqual(expect.any(String));
      expect(cursor.length).toBeGreaterThan(0);
      const next = await app.inject({ method: "GET", url: `${base}&before=${encodeURIComponent(cursor)}` });
      expect(next.statusCode).toBe(200);
      expect(next.json().items.map(({ id }: { id: string }) => id)).toEqual([older.id]);
      expect(next.json().items[0].turnNumber).toBe(100);
      expect(next.json().nextCursor).toBeNull();
      expect(new Set([...first.json().items, ...next.json().items].map(({ id }: { id: string }) => id)).size).toBe(2);

      const before = await pool.query<{ count: string; maximum: number }>(
        'SELECT COUNT(*)::text AS count, MAX(turn_number) AS maximum FROM turns WHERE owner_user_id=$1 AND campaign_id=$2',
        [ownerUserId, imported.campaignId]
      );
      const correctedNarration = "Pagination marker corrected prose after the revision.";
      await pool.query(
        `INSERT INTO turn_narration_corrections (
           owner_user_id,campaign_id,turn_id,revision,narration,previous_effective_narration_hash,source,created_by_user_id
         ) VALUES ($1,$2,$3,1,$4,$5,'administrative',$1)`,
        [ownerUserId, imported.campaignId, older.id, correctedNarration, sha256(older.narration)]
      );
      const after = await pool.query<{ count: string; maximum: number }>(
        'SELECT COUNT(*)::text AS count, MAX(turn_number) AS maximum FROM turns WHERE owner_user_id=$1 AND campaign_id=$2',
        [ownerUserId, imported.campaignId]
      );
      expect(after.rows).toEqual(before.rows);
      const stale = await app.inject({ method: "GET", url: `${base}&before=${encodeURIComponent(cursor)}` });
      expect(stale.statusCode).toBe(409);
      const refreshed = await app.inject({ method: "GET", url: base });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().nextCursor).toEqual(expect.any(String));
      expect(refreshed.json().nextCursor).not.toBe(cursor);
      const correctedPage = await app.inject({ method: "GET", url: `${base}&before=${encodeURIComponent(refreshed.json().nextCursor)}` });
      expect(correctedPage.statusCode).toBe(200);
      expect(correctedPage.json().items).toEqual([expect.objectContaining({ id: older.id, excerpt: correctedNarration })]);
      expect(correctedPage.json().nextCursor).toBeNull();
      const authoritative = await pool.query<{ narration: string }>(
        'SELECT narration FROM turns WHERE id=$1 AND owner_user_id=$2 AND campaign_id=$3',
        [older.id, ownerUserId, imported.campaignId]
      );
      expect(authoritative.rows[0]?.narration).toBe(older.narration);
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

  it("returns actual sparse neighbors, validates tokens, and keeps scene data public", async () => {
    const imported = await createCampaignFixture();
    const numbers = [10, 42, 60, 100, 135, 222, 900];
    const inserted = await pool.query<{ id: string; turnNumber: number; narration: string }>(
      `INSERT INTO turns (
         owner_user_id,campaign_id,turn_number,action,narration,mechanics_private,model_metadata
       )
       SELECT $1,$2,item.turn_number,'Action ' || item.turn_number,
              'Narration ' || item.turn_number,
              CASE WHEN item.turn_number=60 THEN '{"privateCanary":"PRIVATE_SCENE_CANARY"}'::jsonb ELSE NULL END,
              CASE WHEN item.turn_number=60 THEN '{"raw":"PRIVATE_SCENE_CANARY"}'::jsonb ELSE '{}'::jsonb END
         FROM unnest($3::integer[]) AS item(turn_number)
       RETURNING id,turn_number AS "turnNumber",narration`,
      [ownerUserId, imported.campaignId, numbers]
    );
    const turn = (turnNumber: number) => inserted.rows.find((row) => row.turnNumber === turnNumber)!;
    await pool.query("UPDATE campaigns SET active_turn_number=900 WHERE id=$1 AND owner_user_id=$2", [imported.campaignId, ownerUserId]);
    await pool.query(
      `INSERT INTO provider_cost_events (
         owner_user_id,campaign_id,turn_id,provider_type,category,operation,requested_model,resolved_model,amount,currency,usage_metadata
       ) VALUES ($1,$2,$3,'openai_compatible','story','story_turn','fixture-model','fixture-model',0.125,'USD','{}')`,
      [ownerUserId, imported.campaignId, turn(100).id]
    );
    const otherCampaign = await createCampaignFixture();
    const otherTurn = (await pool.query<{ id: string; turnNumber: number }>(
      "SELECT id,turn_number AS \"turnNumber\" FROM turns WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY turn_number LIMIT 1",
      [ownerUserId, otherCampaign.campaignId]
    )).rows[0]!;
    const foreign = await createForeignCampaignFixture();
    const app = await createReaderHistoryApp();
    try {
      const older = await app.inject({
        method: "GET",
        url: sceneWindowPath(imported.campaignId, {
          anchorTurnNumber: 100,
          anchorTurnId: turn(100).id,
          direction: "older",
          neighborLimit: 2
        })
      });
      expect(older.statusCode).toBe(200);
      expect(older.json().campaignId).toBe(imported.campaignId);
      expect(older.json().anchor).toEqual({ turnNumber: 100, id: turn(100).id });
      expect(older.json().direction).toBe("older");
      expect(older.json().turns.map(({ turnNumber }: { turnNumber: number }) => turnNumber)).toEqual([42, 60, 100]);
      expect(older.json().turns[2]).toMatchObject({
        id: turn(100).id,
        turnNumber: 100,
        reportedCost: { amount: "0.125", currency: "USD" }
      });
      expect(older.json().hasMore).toBe(true);
      expect(older.json().historyToken).toEqual(expect.any(String));
      expect(JSON.stringify(older.json())).not.toContain("PRIVATE_SCENE_CANARY");

      const newer = await app.inject({
        method: "GET",
        url: sceneWindowPath(imported.campaignId, {
          anchorTurnNumber: 100,
          anchorTurnId: turn(100).id,
          direction: "newer",
          neighborLimit: 9,
          historyToken: older.json().historyToken
        })
      });
      expect(newer.statusCode).toBe(200);
      expect(newer.json().turns.map(({ turnNumber }: { turnNumber: number }) => turnNumber)).toEqual([100, 135, 222, 900]);
      expect(newer.json().hasMore).toBe(false);

      const edge = await app.inject({
        method: "GET",
        url: sceneWindowPath(imported.campaignId, {
          anchorTurnNumber: 900,
          anchorTurnId: turn(900).id,
          direction: "newer",
          neighborLimit: 1
        })
      });
      expect(edge.statusCode).toBe(200);
      expect(edge.json().turns.map(({ turnNumber }: { turnNumber: number }) => turnNumber)).toEqual([900]);
      expect(edge.json().hasMore).toBe(false);

      const malformed = await app.inject({
        method: "GET",
        url: sceneWindowPath(imported.campaignId, {
          anchorTurnNumber: 100,
          anchorTurnId: turn(100).id,
          direction: "older",
          neighborLimit: 10
        })
      });
      expect(malformed.statusCode).toBe(400);

      const mismatchedAnchor = await app.inject({
        method: "GET",
        url: sceneWindowPath(imported.campaignId, {
          anchorTurnNumber: 100,
          anchorTurnId: turn(135).id,
          direction: "older"
        })
      });
      expect(mismatchedAnchor.statusCode).toBe(409);
      expect(mismatchedAnchor.json().code).toBe("reader_anchor_changed");

      const missing = await app.inject({
        method: "GET",
        url: sceneWindowPath(imported.campaignId, {
          anchorTurnNumber: 9999,
          anchorTurnId: crypto.randomUUID(),
          direction: "older"
        })
      });
      const crossOwner = await app.inject({
        method: "GET",
        url: sceneWindowPath(foreign.campaignId, {
          anchorTurnNumber: 1,
          anchorTurnId: crypto.randomUUID(),
          direction: "older"
        })
      });
      expect(missing.statusCode).toBe(404);
      expect(crossOwner.statusCode).toBe(404);
      expect(crossOwner.json()).toEqual(missing.json());
      expect(JSON.stringify(crossOwner.json())).not.toContain(foreign.ownerUserId);

      const crossCampaignToken = await app.inject({
        method: "GET",
        url: sceneWindowPath(otherCampaign.campaignId, {
          anchorTurnNumber: otherTurn.turnNumber,
          anchorTurnId: otherTurn.id,
          direction: "older",
          historyToken: older.json().historyToken
        })
      });
      expect(crossCampaignToken.statusCode).toBe(400);

      const malformedToken = await app.inject({
        method: "GET",
        url: sceneWindowPath(imported.campaignId, {
          anchorTurnNumber: 100,
          anchorTurnId: turn(100).id,
          direction: "older",
          historyToken: "not-a-base64url-history-token!"
        })
      });
      expect(malformedToken.statusCode).toBe(400);

      await pool.query(
        "INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration) VALUES ($1,$2,901,'Appended action','Appended narration')",
        [ownerUserId, imported.campaignId]
      );
      await pool.query("UPDATE campaigns SET active_turn_number=901 WHERE id=$1 AND owner_user_id=$2", [imported.campaignId, ownerUserId]);
      const staleAfterAppend = await app.inject({
        method: "GET",
        url: sceneWindowPath(imported.campaignId, {
          anchorTurnNumber: 100,
          anchorTurnId: turn(100).id,
          direction: "older",
          neighborLimit: 2,
          historyToken: older.json().historyToken
        })
      });
      expect(staleAfterAppend.statusCode).toBe(409);
      expect(staleAfterAppend.json().code).toBe("reader_history_changed");
      const afterAppendWindow = await app.inject({
        method: "GET",
        url: sceneWindowPath(imported.campaignId, {
          anchorTurnNumber: 100,
          anchorTurnId: turn(100).id,
          direction: "older",
          neighborLimit: 2
        })
      });
      const appendedId = (await pool.query<{ id: string }>(
        "SELECT id FROM turns WHERE owner_user_id=$1 AND campaign_id=$2 AND turn_number=901",
        [ownerUserId, imported.campaignId]
      )).rows[0]!.id;
      await pool.query("DELETE FROM turns WHERE owner_user_id=$1 AND campaign_id=$2 AND id=$3", [ownerUserId, imported.campaignId, appendedId]);
      await pool.query("UPDATE campaigns SET active_turn_number=900 WHERE id=$1 AND owner_user_id=$2", [imported.campaignId, ownerUserId]);
      const staleAfterRewind = await app.inject({
        method: "GET",
        url: sceneWindowPath(imported.campaignId, {
          anchorTurnNumber: 100,
          anchorTurnId: turn(100).id,
          direction: "older",
          neighborLimit: 2,
          historyToken: afterAppendWindow.json().historyToken
        })
      });
      expect(staleAfterRewind.statusCode).toBe(409);
      expect(staleAfterRewind.json().code).toBe("reader_history_changed");

      await pool.query(
        `INSERT INTO turn_narration_corrections (
           owner_user_id,campaign_id,turn_id,revision,narration,previous_effective_narration_hash,source,created_by_user_id
         ) VALUES ($1,$2,$3,1,'Corrected scene 60',$4,'administrative',$1)`,
        [ownerUserId, imported.campaignId, turn(60).id, sha256(turn(60).narration)]
      );
      const staleAfterCorrection = await app.inject({
        method: "GET",
        url: sceneWindowPath(imported.campaignId, {
          anchorTurnNumber: 100,
          anchorTurnId: turn(100).id,
          direction: "older",
          neighborLimit: 2,
          historyToken: older.json().historyToken
        })
      });
      expect(staleAfterCorrection.statusCode).toBe(409);
      expect(staleAfterCorrection.json().code).toBe("reader_history_changed");

      const fresh = await app.inject({
        method: "GET",
        url: sceneWindowPath(imported.campaignId, {
          anchorTurnNumber: 100,
          anchorTurnId: turn(100).id,
          direction: "older",
          neighborLimit: 2
        })
      });
      const beforeReplacement = await pool.query<{ count: string; maximum: number; latestId: string }>(
        `SELECT count(*)::text AS count, max(turn_number) AS maximum,
                (SELECT id::text FROM turns WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY turn_number DESC LIMIT 1) AS "latestId"
           FROM turns WHERE owner_user_id=$1 AND campaign_id=$2`,
        [ownerUserId, imported.campaignId]
      );
      await pool.query("DELETE FROM turns WHERE owner_user_id=$1 AND campaign_id=$2 AND id=$3", [ownerUserId, imported.campaignId, turn(42).id]);
      const replacementId = crypto.randomUUID();
      await pool.query(
        "INSERT INTO turns (id,owner_user_id,campaign_id,turn_number,action,narration) VALUES ($1,$2,$3,42,'Replacement action','Replacement narration')",
        [replacementId, ownerUserId, imported.campaignId]
      );
      const afterReplacement = await pool.query<{ count: string; maximum: number; latestId: string }>(
        `SELECT count(*)::text AS count, max(turn_number) AS maximum,
                (SELECT id::text FROM turns WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY turn_number DESC LIMIT 1) AS "latestId"
           FROM turns WHERE owner_user_id=$1 AND campaign_id=$2`,
        [ownerUserId, imported.campaignId]
      );
      expect(afterReplacement.rows).toEqual(beforeReplacement.rows);
      const staleAfterInteriorReplacement = await app.inject({
        method: "GET",
        url: sceneWindowPath(imported.campaignId, {
          anchorTurnNumber: 100,
          anchorTurnId: turn(100).id,
          direction: "older",
          neighborLimit: 2,
          historyToken: fresh.json().historyToken
        })
      });
      expect(staleAfterInteriorReplacement.statusCode).toBe(409);
      expect(staleAfterInteriorReplacement.json().code).toBe("reader_history_changed");
    } finally {
      await app.close();
    }
  });

  it("keeps neighbor, correction, and reported-cost reads in one repeatable-read snapshot", async () => {
    const imported = await createCampaignFixture();
    const inserted = await pool.query<{ id: string; turnNumber: number; narration: string }>(
      `INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration)
       VALUES ($1,$2,20,'Older action','Older original narration'),
              ($1,$2,50,'Anchor action','Anchor narration')
       RETURNING id,turn_number AS "turnNumber",narration`,
      [ownerUserId, imported.campaignId]
    );
    const older = inserted.rows.find(({ turnNumber }) => turnNumber === 20)!;
    const anchor = inserted.rows.find(({ turnNumber }) => turnNumber === 50)!;
    await pool.query(
      `INSERT INTO provider_cost_events (
         owner_user_id,campaign_id,turn_id,provider_type,category,operation,requested_model,resolved_model,amount,currency,usage_metadata
       ) VALUES ($1,$2,$3,'openai_compatible','story','story_turn','fixture-model','fixture-model',0.1,'USD','{}')`,
      [ownerUserId, imported.campaignId, older.id]
    );

    let resumeRead!: () => void;
    let announceFingerprint!: () => void;
    const continueRead = new Promise<void>((resolvePromise) => { resumeRead = resolvePromise; });
    const fingerprintObserved = new Promise<void>((resolvePromise) => { announceFingerprint = resolvePromise; });
    let paused = false;
    const gatedPool = {
      connect: async () => {
        const client = await pool.connect();
        const rawQuery = client.query.bind(client) as (
          query: unknown,
          values?: unknown[]
        ) => Promise<{ rows: unknown[] }>;
        return {
          query: async (query: unknown, values?: unknown[]) => {
            const result = await rawQuery(query, values);
            if (!paused && typeof query === "string" && query.includes("scene-window-fingerprint")) {
              paused = true;
              announceFingerprint();
              await continueRead;
            }
            return result;
          },
          release: () => client.release()
        };
      }
    } as unknown as DatabasePool;
    const repository = createPostgresReaderHistoryRepository(gatedPool, { turnReportedCosts: async () => new Map() });
    const pending = repository.getSceneWindow({ ownerUserId, campaignId: imported.campaignId }, {
      anchorTurnNumber: 50,
      anchorTurnId: anchor.id,
      direction: "older",
      neighborLimit: 1
    });
    try {
      await fingerprintObserved;
      await pool.query(
        `INSERT INTO turn_narration_corrections (
           owner_user_id,campaign_id,turn_id,revision,narration,previous_effective_narration_hash,source,created_by_user_id
         ) VALUES ($1,$2,$3,1,'New correction after snapshot',$4,'administrative',$1)`,
        [ownerUserId, imported.campaignId, older.id, sha256(older.narration)]
      );
      await pool.query(
        `INSERT INTO provider_cost_events (
           owner_user_id,campaign_id,turn_id,provider_type,category,operation,requested_model,resolved_model,amount,currency,usage_metadata
         ) VALUES ($1,$2,$3,'openai_compatible','image','image_generation','fixture-model','fixture-model',0.2,'USD','{}')`,
        [ownerUserId, imported.campaignId, older.id]
      );
    } finally {
      resumeRead();
    }

    const window = await pending;
    expect(window?.turns).toMatchObject([{
      id: older.id,
      turnNumber: 20,
      narration: "Older original narration",
      reportedCost: { amount: "0.1", byCategory: { story: "0.1", image: "0", memory: "0" } }
    }, { id: anchor.id, turnNumber: 50 }]);
    await expect(repository.getSceneWindow({ ownerUserId, campaignId: imported.campaignId }, {
      anchorTurnNumber: 50,
      anchorTurnId: anchor.id,
      direction: "older",
      neighborLimit: 1,
      historyToken: window!.historyToken
    })).rejects.toMatchObject({ statusCode: 409, details: { code: "reader_history_changed" } });
  }, 30_000);

  it("captures query plans for sparse and 2,000-turn windows", async () => {
    const imported = await createCampaignFixture();
    await pool.query(
      `INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration)
       SELECT $1,$2,item.turn_number,'Sparse plan action ' || item.turn_number,'Sparse plan narration ' || item.turn_number
         FROM unnest($3::integer[]) AS item(turn_number)`,
      [ownerUserId, imported.campaignId, [100, 105, 200, 500]]
    );
    await pool.query("ANALYZE turns");
    await pool.query("ANALYZE turn_narration_corrections");

    const explainRecords: Array<Record<string, unknown>> = [];
    const explainPlanDocuments: Array<Readonly<{ dataset: string; kind: string; queryPlan: unknown }>> = [];
    let currentPlanSet = "sparse-six-turn-ledger";
    const explainedPool = {
      connect: async () => {
        const client = await pool.connect();
        const rawQuery = client.query.bind(client) as (
          query: unknown,
          values?: unknown[]
        ) => Promise<{ rows: unknown[] }>;
        return {
          query: async (query: unknown, values?: unknown[]) => {
            if (typeof query === "string") {
              const kind = query.includes("scene-window-fingerprint")
                ? "fingerprint"
                : query.includes("scene-window-neighbors")
                  ? "neighbors"
                  : query.includes("ledger_scope AS")
                    ? "reported-costs"
                    : null;
              if (kind) {
                const explained = await rawQuery(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, values);
                const record = explained.rows[0] as Record<string, unknown> | undefined;
                const queryPlan = record?.["QUERY PLAN"];
                const document = (queryPlan as Array<Record<string, unknown>> | undefined)?.[0];
                const root = document?.Plan as Record<string, unknown> | undefined;
                explainPlanDocuments.push({ dataset: currentPlanSet, kind, queryPlan });
                explainRecords.push({
                  dataset: currentPlanSet,
                  kind,
                  planningTimeMs: document?.["Planning Time"],
                  executionTimeMs: document?.["Execution Time"],
                  nodeType: root?.["Node Type"],
                  actualRows: root?.["Actual Rows"],
                  sharedHitBlocks: root?.["Shared Hit Blocks"],
                  sharedReadBlocks: root?.["Shared Read Blocks"]
                });
              }
            }
            return rawQuery(query, values);
          },
          release: () => client.release()
        };
      }
    } as unknown as DatabasePool;
    const repository = createPostgresReaderHistoryRepository(explainedPool, { turnReportedCosts: async () => new Map() });

    const sparseAnchor = (await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE owner_user_id=$1 AND campaign_id=$2 AND turn_number=200",
      [ownerUserId, imported.campaignId]
    )).rows[0]!;
    const sparseWindow = await repository.getSceneWindow({ ownerUserId, campaignId: imported.campaignId }, {
      anchorTurnNumber: 200,
      anchorTurnId: sparseAnchor.id,
      direction: "older",
      neighborLimit: 9
    });
    expect(sparseWindow?.turns.map(({ turnNumber }) => turnNumber)).toEqual([1, 2, 100, 105, 200]);
    expect(sparseWindow?.hasMore).toBe(false);

    const count = 2000;
    const firstTurnNumber = 10000;
    await pool.query(
      `INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration)
       SELECT $1,$2,$3 + ordinal * 3,'Plan action ' || ordinal,'Plan narration ' || ordinal
         FROM generate_series(1,$4) AS series(ordinal)`,
      [ownerUserId, imported.campaignId, firstTurnNumber, count]
    );
    const anchorTurnNumber = firstTurnNumber + 1500 * 3;
    const anchor = (await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE owner_user_id=$1 AND campaign_id=$2 AND turn_number=$3",
      [ownerUserId, imported.campaignId, anchorTurnNumber]
    )).rows[0]!;
    await pool.query("ANALYZE turns");
    await pool.query("ANALYZE turn_narration_corrections");

    currentPlanSet = "two-thousand-added-2006-total";

    const window = await repository.getSceneWindow({ ownerUserId, campaignId: imported.campaignId }, {
      anchorTurnNumber,
      anchorTurnId: anchor.id,
      direction: "older",
      neighborLimit: 9
    });

    expect(window?.turns).toHaveLength(10);
    expect(window?.hasMore).toBe(true);
    expect(explainRecords
      .filter(({ kind }) => kind === "fingerprint")
      .map(({ actualRows }) => actualRows)).toEqual([6, 2006]);
    expect(explainRecords.map(({ dataset, kind }) => `${dataset}:${kind}`)).toEqual([
      "sparse-six-turn-ledger:fingerprint", "sparse-six-turn-ledger:neighbors", "sparse-six-turn-ledger:reported-costs",
      "two-thousand-added-2006-total:fingerprint", "two-thousand-added-2006-total:neighbors", "two-thousand-added-2006-total:reported-costs"
    ]);
    for (const record of explainRecords) {
      expect(record.executionTimeMs).toEqual(expect.any(Number));
      expect(record.actualRows).toEqual(expect.any(Number));
    }
    const explainJsonPath = ".superpowers/sdd/legacy-ui-2026-10-03/evidence/T16-scene-window-explain-plans.json";
    await writeFile(resolve(explainJsonPath), `${JSON.stringify(explainPlanDocuments, null, 2)}\n`, "utf8");
    process.stdout.write(`T16_EXPLAIN_SPARSE_AND_2000 ${JSON.stringify(explainRecords)}\n`);
    process.stdout.write(`T16_EXPLAIN_JSON_PATH ${explainJsonPath}\n`);
  }, 30_000);
});
