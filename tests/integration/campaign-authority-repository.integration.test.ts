import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import {
  createPostgresBoundedCampaignTurnPageAdapter,
  createPostgresCampaignAuthorityAdapters
} from "../../packages/database/src/campaign-state-repository.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { turnReportedCosts } from "../../services/api/src/cost-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

integration("PostgreSQL campaign sync adapters", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  function createAdapters() {
    const turnPages = createPostgresBoundedCampaignTurnPageAdapter(pool, { turnReportedCosts });
    return createPostgresCampaignAuthorityAdapters(pool, { turnPages });
  }

  async function createCampaignFixture() {
    const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Campaign sync ${crypto.randomUUID()}`;
    return importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `campaign-sync-${crypto.randomUUID()}.story`,
      story
    }));
  }

  it("returns typed campaign_not_found outside the explicit owner scope", async () => {
    const imported = await createCampaignFixture();
    const foreign = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name, status) VALUES ($1, 'active') RETURNING id",
      [`Foreign sync owner ${crypto.randomUUID()}`]
    );
    const adapters = createAdapters();

    await expect(adapters.transaction.read((transaction) => adapters.sync.readCampaignSyncSnapshot(
      transaction,
      { ownerUserId: foreign.rows[0]!.id, campaignId: imported.campaignId }
    ))).rejects.toMatchObject({ reason: "campaign_not_found" });
  });

  it("returns raw-Date sync sources and delegates changed windows to the bounded reader", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    const scope = { ownerUserId, campaignId: imported.campaignId };

    const snapshot = await adapters.transaction.read((transaction) =>
      adapters.sync.readCampaignSyncSnapshot(transaction, scope));
    expect(snapshot.syncToken).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.projection.campaign.updatedAt).toBeInstanceOf(Date);
    expect(snapshot.projection).toMatchObject({
      id: imported.campaignId,
      campaign: { id: imported.campaignId, activeTurnNumber: 2 },
      playerConfig: { useRpgStats: false, suppressEventTriggers: false },
      pendingGeneration: null
    });

    const latest = await adapters.turnPages.readTurnPage(scope, { before: undefined, limit: 1 });
    expect(latest.turns.map((turn) => turn.turnNumber)).toEqual([2]);
    expect(latest.nextCursor).toEqual(expect.any(String));
    const earlier = await adapters.turnPages.readTurnPage(scope, { before: latest.nextCursor!, limit: 1 });
    expect(earlier.turns.map((turn) => turn.turnNumber)).toEqual([1]);
  });

  it("preserves the established owner-scoped reported cost in normal and sync turn pages", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const turn = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_number = 2",
      [ownerUserId, imported.campaignId]
    );
    const turnId = turn.rows[0]!.id;
    await pool.query(
      `INSERT INTO provider_cost_events (
         owner_user_id, campaign_id, turn_id, provider_type, category, operation,
         requested_model, resolved_model, amount, currency, usage_metadata
       ) VALUES ($1,$2,$3,'openai_compatible','story','story_turn','fixture-model',
                 'fixture-model',0.125,'USD','{}'::jsonb)`,
      [ownerUserId, imported.campaignId, turnId]
    );
    const expectedCost = {
      amount: "0.125000000000",
      currency: "USD",
      byCategory: { story: "0.125000000000", image: "0", memory: "0" }
    };

    expect((await turnReportedCosts(pool, ownerUserId, [turnId])).get(turnId)).toEqual(expectedCost);
    const syncPage = await adapters.turnPages.readTurnPage(scope, { before: undefined, limit: 1 });
    expect(syncPage.turns[0]?.reportedCost).toEqual(expectedCost);
  });

  it("rejects malformed persisted playable characters at the database boundary", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    await pool.query(
      `UPDATE world_versions
          SET content = jsonb_set(content, '{playableCharacters}',
            '[{"id":"","name":7,"characterText":false}]'::jsonb)
        WHERE id = (SELECT world_version_id FROM campaigns WHERE id = $1 AND owner_user_id = $2)`,
      [imported.campaignId, ownerUserId]
    );

    await expect(adapters.transaction.read((transaction) => adapters.sync.readCampaignSyncSnapshot(
      transaction,
      { ownerUserId, campaignId: imported.campaignId }
    ))).rejects.toMatchObject({ kind: "unavailable", reason: "invalid_transition" });
  });

  it("rejects other malformed persisted nested sync data without returning a partial projection", async () => {
    const imported = await createCampaignFixture();
    const adapters = createAdapters();
    await pool.query(
      `UPDATE campaign_state
          SET trackers = '[{"id":"","name":9,"value":{},"rules":[]}]'::jsonb
        WHERE campaign_id = $1 AND owner_user_id = $2`,
      [imported.campaignId, ownerUserId]
    );

    await expect(adapters.transaction.read((transaction) => adapters.sync.readCampaignSyncSnapshot(
      transaction,
      { ownerUserId, campaignId: imported.campaignId }
    ))).rejects.toMatchObject({ kind: "unavailable", reason: "invalid_transition" });
  });
});
