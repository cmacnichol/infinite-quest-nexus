import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { getDashboardStats } from "../../services/api/src/dashboard-service.js";
import { buildServer } from "../../services/api/src/server.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("dashboard statistics integration", () => {
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 3);
    await migrateDatabase(pool, resolve("database/migrations"));
    const config: RuntimeConfig = {
      role: "all",
      host: "127.0.0.1",
      port: 8080,
      databaseUrl: databaseUrl!,
      databaseMaxConnections: 3,
      migrationDirectory: resolve("database/migrations"),
      migrationWaitSeconds: 10,
      allowMaintenanceMigrations: false,
      workerPollIntervalMs: 1000,
      workerLeaseSeconds: 60,
      webRoot: resolve("apps/web/public"),
      assetStorageDriver: "filesystem",
      assetStorageRoot: resolve("local-data/assets"),
      credentialEncryptionKey: "dashboard-integration-test-key",
      corsAllowedOrigins: ["*"]
    };
    app = await buildServer({ config, pool });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("exposes the aggregate through the dashboard API", async () => {
    const expected = await getDashboardStats(pool);

    const response = await app.inject({ method: "GET", url: "/api/v1/dashboard/stats" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it("aggregates only the initial owner's records and reported costs", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const scopedPool = client as unknown as DatabasePool;
      const baseline = await getDashboardStats(scopedPool);
      const ownerUserId = await initialOwnerId(client);
      const foreignUser = await client.query<{ id: string }>(
        "INSERT INTO users (display_name) VALUES ('Dashboard Foreign Owner') RETURNING id"
      );
      const foreignUserId = foreignUser.rows[0]!.id;

      const activeWorld = await client.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id, title, status) VALUES ($1, $2, 'active') RETURNING id",
        [ownerUserId, `Dashboard active ${crypto.randomUUID()}`]
      );
      const activeWorldId = activeWorld.rows[0]!.id;
      const version = await client.query<{ id: string }>(
        `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
         VALUES ($1, $2, 1, '{}'::jsonb) RETURNING id`,
        [activeWorldId, ownerUserId]
      );
      const worldVersionId = version.rows[0]!.id;
      await client.query(
        `INSERT INTO worlds (owner_user_id, title, status) VALUES
         ($1, $2, 'draft'), ($1, $3, 'archived')`,
        [ownerUserId, `Dashboard draft ${crypto.randomUUID()}`, `Dashboard archived ${crypto.randomUUID()}`]
      );
      const openCampaign = await client.query<{ id: string }>(
        `INSERT INTO campaigns (owner_user_id, world_version_id, title, status)
         VALUES ($1, $2, $3, 'active') RETURNING id`,
        [ownerUserId, worldVersionId, `Dashboard open ${crypto.randomUUID()}`]
      );
      const openCampaignId = openCampaign.rows[0]!.id;
      await client.query(
        `INSERT INTO campaigns (owner_user_id, world_version_id, title, status)
         VALUES ($1, $2, $3, 'archived')`,
        [ownerUserId, worldVersionId, `Dashboard archived campaign ${crypto.randomUUID()}`]
      );
      await client.query(
        `INSERT INTO turns (owner_user_id, campaign_id, turn_number, narration)
         VALUES ($1, $2, 1, 'An accepted dashboard integration turn.')`,
        [ownerUserId, openCampaignId]
      );
      const provider = await client.query<{ id: string }>(
        `INSERT INTO provider_profiles (owner_user_id, name, provider_type, provider_role, base_url)
         VALUES ($1, $2, 'openrouter', 'text', 'https://dashboard.test') RETURNING id`,
        [ownerUserId, `Dashboard Provider ${crypto.randomUUID()}`]
      );
      const providerProfileId = provider.rows[0]!.id;
      await client.query(
        `INSERT INTO provider_cost_events (
           owner_user_id, campaign_id, provider_profile_id, provider_type, category, operation,
           requested_model, resolved_model, amount, currency
         ) VALUES
           ($1, $2, $3, 'openrouter', 'story', 'generate', 'test', 'test', 0.125, 'USD'),
           ($1, $2, $3, 'openrouter', 'story', 'recover', 'test', 'test', 0.250, 'USD')`,
        [ownerUserId, openCampaignId, providerProfileId]
      );

      const foreignWorld = await client.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id, title, status) VALUES ($1, $2, 'active') RETURNING id",
        [foreignUserId, `Foreign dashboard world ${crypto.randomUUID()}`]
      );
      const foreignVersion = await client.query<{ id: string }>(
        `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
         VALUES ($1, $2, 1, '{}'::jsonb) RETURNING id`,
        [foreignWorld.rows[0]!.id, foreignUserId]
      );
      const foreignCampaign = await client.query<{ id: string }>(
        `INSERT INTO campaigns (owner_user_id, world_version_id, title)
         VALUES ($1, $2, $3) RETURNING id`,
        [foreignUserId, foreignVersion.rows[0]!.id, `Foreign dashboard campaign ${crypto.randomUUID()}`]
      );
      await client.query(
        `INSERT INTO turns (owner_user_id, campaign_id, turn_number, narration)
         VALUES ($1, $2, 1, 'This foreign turn must not be counted.')`,
        [foreignUserId, foreignCampaign.rows[0]!.id]
      );

      const stats = await getDashboardStats(scopedPool);

      expect(stats.worlds).toEqual({
        available: baseline.worlds.available + 1,
        total: baseline.worlds.total + 3,
        published: baseline.worlds.published + 1,
        drafts: baseline.worlds.drafts + 1,
        archived: baseline.worlds.archived + 1
      });
      expect(stats.campaigns).toEqual({
        open: baseline.campaigns.open + 1,
        total: baseline.campaigns.total + 2,
        archived: baseline.campaigns.archived + 1
      });
      expect(stats.turns.accepted).toBe(baseline.turns.accepted + 1);
      expect(stats.providerCosts.totals).toContainEqual(expect.objectContaining({
        providerProfileId,
        providerType: "openrouter",
        currency: "USD",
        amount: "0.375000000000",
        eventCount: 2
      }));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
