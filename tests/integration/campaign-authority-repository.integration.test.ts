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
    const turnPages = createPostgresBoundedCampaignTurnPageAdapter(pool);
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
});
