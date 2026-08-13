import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { getDashboardStats } from "../helpers/memory-aware-services.js";
import { buildServer } from "../../services/api/src/server.js";
import { createApiWorldCampaignApplication } from "../helpers/runtime-application-fixtures.js";
import { serverOptions } from "../helpers/build-server-options.js";
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
      workerGenerationConcurrency: 1,
      legacyWebRoot: resolve("apps/web/public"),
      nextWebRoot: resolve("apps/web-next"),
      assetStorageDriver: "filesystem",
      assetStorageRoot: resolve("local-data/assets"),
      archiveStorageRoot: resolve("local-data/archives"),
      archivePreviewTtlSeconds: 1_800,
      systemArchiveArtifactTtlSeconds: 86_400,
      campaignArchiveLimits: {
        maxCompressedBytes: 2_147_483_648,
        maxUncompressedBytes: 21_474_836_480,
        maxEntries: 100_000,
        maxExpansionRatio: 100,
        maxManifestBytes: 5_242_880,
        maxJsonEntryBytes: 1_073_741_824,
        maxOriginalImageBytes: 26_214_400
      },
      systemArchiveLimits: {
        maxCompressedBytes: 53_687_091_200,
        maxUncompressedBytes: 214_748_364_800,
        maxEntries: 1_000_000,
        maxExpansionRatio: 100,
        maxManifestBytes: 5_242_880,
        maxJsonEntryBytes: 1_073_741_824,
        maxOriginalImageBytes: 26_214_400
      },
      credentialEncryptionKey: "dashboard-integration-test-key",
      security: {
        corsAllowedOrigins: [],
        providerNetworkAllowlist: ["localhost", "127.0.0.0/8", "::1/128"],
        cspImageAllowedOrigins: [],
        apiDefaultBodyLimitBytes: 1_048_576,
        apiImportBodyLimitBytes: 16_777_216,
        apiAssetBodyLimitBytes: 33_554_432,
        apiRateLimitWindowSeconds: 60,
        apiRateLimitProviderRequests: 10,
        apiRateLimitGenerationRequests: 12,
        apiRateLimitImportRequests: 4,
        apiConcurrencyProviderRequests: 2,
        apiConcurrencyImportRequests: 1,
        trustProxyHops: 0
      }
    };
    app = await buildServer(serverOptions({
      config,
      pool,
      worldCampaign: createApiWorldCampaignApplication(pool, {
        credentialSecret: config.credentialEncryptionKey
      })
    }));
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
    const baseline = await getDashboardStats(pool);
    const ownerWorldIds: string[] = [];
    const ownerCampaignIds: string[] = [];
    let foreignUserId: string | undefined;
    let foreignWorldId: string | undefined;
    let foreignCampaignId: string | undefined;
    let providerProfileId: string | undefined;
    try {
      const ownerUserId = await initialOwnerId(pool);
      const foreignUser = await pool.query<{ id: string }>(
        "INSERT INTO users (display_name) VALUES ('Dashboard Foreign Owner') RETURNING id"
      );
      foreignUserId = foreignUser.rows[0]!.id;

      const activeWorld = await pool.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id, title, status) VALUES ($1, $2, 'active') RETURNING id",
        [ownerUserId, `Dashboard active ${crypto.randomUUID()}`]
      );
      const activeWorldId = activeWorld.rows[0]!.id;
      ownerWorldIds.push(activeWorldId);
      const version = await pool.query<{ id: string }>(
        `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
         VALUES ($1, $2, 1, '{}'::jsonb) RETURNING id`,
        [activeWorldId, ownerUserId]
      );
      const worldVersionId = version.rows[0]!.id;
      const additionalWorlds = await pool.query<{ id: string }>(
        `INSERT INTO worlds (owner_user_id, title, status) VALUES
         ($1, $2, 'draft'), ($1, $3, 'archived') RETURNING id`,
        [ownerUserId, `Dashboard draft ${crypto.randomUUID()}`, `Dashboard archived ${crypto.randomUUID()}`]
      );
      ownerWorldIds.push(...additionalWorlds.rows.map((row) => row.id));
      const openCampaign = await pool.query<{ id: string }>(
        `INSERT INTO campaigns (owner_user_id, world_version_id, title, status)
         VALUES ($1, $2, $3, 'active') RETURNING id`,
        [ownerUserId, worldVersionId, `Dashboard open ${crypto.randomUUID()}`]
      );
      const openCampaignId = openCampaign.rows[0]!.id;
      ownerCampaignIds.push(openCampaignId);
      const archivedCampaign = await pool.query<{ id: string }>(
        `INSERT INTO campaigns (owner_user_id, world_version_id, title, status)
         VALUES ($1, $2, $3, 'archived') RETURNING id`,
        [ownerUserId, worldVersionId, `Dashboard archived campaign ${crypto.randomUUID()}`]
      );
      ownerCampaignIds.push(archivedCampaign.rows[0]!.id);
      await pool.query(
        `INSERT INTO turns (owner_user_id, campaign_id, turn_number, narration)
         VALUES ($1, $2, 1, 'An accepted dashboard integration turn.')`,
        [ownerUserId, openCampaignId]
      );
      const provider = await pool.query<{ id: string }>(
        `INSERT INTO provider_profiles (owner_user_id, name, provider_type, provider_role, base_url)
         VALUES ($1, $2, 'openrouter', 'text', 'https://dashboard.test') RETURNING id`,
        [ownerUserId, `Dashboard Provider ${crypto.randomUUID()}`]
      );
      providerProfileId = provider.rows[0]!.id;
      await pool.query(
        `INSERT INTO provider_cost_events (
           owner_user_id, campaign_id, provider_profile_id, provider_type, category, operation,
           requested_model, resolved_model, amount, currency
         ) VALUES
           ($1, $2, $3, 'openrouter', 'story', 'generate', 'test', 'test', 0.125, 'USD'),
           ($1, $2, $3, 'openrouter', 'story', 'recover', 'test', 'test', 0.250, 'USD')`,
        [ownerUserId, openCampaignId, providerProfileId]
      );

      const foreignWorld = await pool.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id, title, status) VALUES ($1, $2, 'active') RETURNING id",
        [foreignUserId, `Foreign dashboard world ${crypto.randomUUID()}`]
      );
      foreignWorldId = foreignWorld.rows[0]!.id;
      const foreignVersion = await pool.query<{ id: string }>(
        `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
         VALUES ($1, $2, 1, '{}'::jsonb) RETURNING id`,
        [foreignWorldId, foreignUserId]
      );
      const foreignCampaign = await pool.query<{ id: string }>(
        `INSERT INTO campaigns (owner_user_id, world_version_id, title)
         VALUES ($1, $2, $3) RETURNING id`,
        [foreignUserId, foreignVersion.rows[0]!.id, `Foreign dashboard campaign ${crypto.randomUUID()}`]
      );
      foreignCampaignId = foreignCampaign.rows[0]!.id;
      await pool.query(
        `INSERT INTO turns (owner_user_id, campaign_id, turn_number, narration)
         VALUES ($1, $2, 1, 'This foreign turn must not be counted.')`,
        [foreignUserId, foreignCampaignId]
      );

      const stats = await getDashboardStats(pool);

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
      const campaignIds = [...ownerCampaignIds, ...(foreignCampaignId ? [foreignCampaignId] : [])];
      if (campaignIds.length) {
        await pool.query("DELETE FROM provider_cost_events WHERE campaign_id = ANY($1::uuid[])", [campaignIds]);
        await pool.query("DELETE FROM turns WHERE campaign_id = ANY($1::uuid[])", [campaignIds]);
        await pool.query("DELETE FROM campaigns WHERE id = ANY($1::uuid[])", [campaignIds]);
      }
      if (providerProfileId) {
        await pool.query("DELETE FROM provider_profiles WHERE id = $1", [providerProfileId]);
      }
      const worldIds = [...ownerWorldIds, ...(foreignWorldId ? [foreignWorldId] : [])];
      if (worldIds.length) {
        await pool.query("DELETE FROM world_versions WHERE world_id = ANY($1::uuid[])", [worldIds]);
        await pool.query("DELETE FROM worlds WHERE id = ANY($1::uuid[])", [worldIds]);
      }
      if (foreignUserId) {
        await pool.query("DELETE FROM users WHERE id = $1", [foreignUserId]);
      }
    }
  });
});
