import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { buildServer } from "../../services/api/src/server.js";
import { createWorkerMemoryApplication } from "../../services/runtime/src/memory-composition.js";
import { serverOptions } from "../helpers/build-server-options.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "chronicle-completion-audit-secret";

function config(assetStorageRoot: string): RuntimeConfig {
  const archiveLimits = {
    maxCompressedBytes: 53_687_091_200,
    maxUncompressedBytes: 214_748_364_800,
    maxEntries: 1_000_000,
    maxExpansionRatio: 100,
    maxManifestBytes: 5_242_880,
    maxJsonEntryBytes: 1_073_741_824,
    maxOriginalImageBytes: 26_214_400
  };
  return {
    role: "all",
    host: "127.0.0.1",
    port: 8080,
    databaseUrl: databaseUrl!,
    databaseMaxConnections: 4,
    migrationDirectory: resolve("database/migrations"),
    migrationWaitSeconds: 10,
    allowMaintenanceMigrations: false,
    workerPollIntervalMs: 1_000,
    workerLeaseSeconds: 60,
    workerGenerationConcurrency: 1,
    legacyWebRoot: resolve("apps/web/public"),
    nextWebRoot: resolve("apps/web-next"),
    assetStorageDriver: "filesystem",
    assetStorageRoot,
    archiveStorageRoot: assetStorageRoot,
    archivePreviewTtlSeconds: 1_800,
    systemArchiveArtifactTtlSeconds: 86_400,
    campaignArchiveLimits: {
      ...archiveLimits,
      maxCompressedBytes: 2_147_483_648,
      maxUncompressedBytes: 21_474_836_480,
      maxEntries: 100_000
    },
    systemArchiveLimits: archiveLimits,
    credentialEncryptionKey: credentialSecret,
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
}

integration("Task 14b4 Chronicle HTTP completion audit", () => {
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let ownerUserId = "";
  let foreignOwnerUserId = "";
  let foreignCampaignId = "";
  let foreignJobId = "";
  let assetRoot = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    assetRoot = await mkdtemp(join(tmpdir(), "infinitequest-chronicle-routes-"));
    app = await buildServer(serverOptions({ config: config(assetRoot), pool }));

    const foreignOwner = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name) VALUES ($1) RETURNING id",
      [`Foreign Chronicle owner ${crypto.randomUUID()}`]
    );
    foreignOwnerUserId = foreignOwner.rows[0]!.id;
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1,$2) RETURNING id",
      [foreignOwnerUserId, `Foreign Chronicle world ${crypto.randomUUID()}`]
    );
    const version = await pool.query<{ id: string }>(
      "INSERT INTO world_versions (world_id, owner_user_id, version_number, content) VALUES ($1,$2,1,'{}'::jsonb) RETURNING id",
      [world.rows[0]!.id, foreignOwnerUserId]
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
      [foreignOwnerUserId, version.rows[0]!.id, "Foreign Chronicle campaign"]
    );
    foreignCampaignId = campaign.rows[0]!.id;
    const job = await pool.query<{ id: string }>(
      "INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type, status, completed_at) VALUES ($1,$2,'reindex_campaign','completed',now()) RETURNING id",
      [foreignOwnerUserId, foreignCampaignId]
    );
    foreignJobId = job.rows[0]!.id;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(assetRoot, { recursive: true, force: true });
  });

  async function campaign(): Promise<string> {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Chronicle route campaign ${crypto.randomUUID()}`;
    return (await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `chronicle-route-${crypto.randomUUID()}.story`,
      story: fixture
    }))).campaignId;
  }

  it("applies invalid, missing, and foreign scope handling to all six memory routes and generic job read", async () => {
    const ownedCampaignId = await campaign();
    const missingCampaignId = crypto.randomUUID();
    const invalidCampaignId = "not-a-campaign-id";
    const disabledConfig = {
      enabled: false,
      providerProfileId: null,
      model: "text-embedding-nomic-embed-text-v1.5",
      batchSize: 16,
      documentPrefix: null,
      queryPrefix: null
    };
    const routes = [
      { method: "GET", suffix: "memory/metrics" },
      { method: "GET", suffix: "memory/context-preview?budgetTokens=4096&recentTurns=2" },
      { method: "POST", suffix: "memory/reindex" },
      { method: "GET", suffix: "memory/embedding-config" },
      { method: "PUT", suffix: "memory/embedding-config", payload: disabledConfig },
      { method: "POST", suffix: "memory/embeddings/reindex" }
    ] as const;

    for (const route of routes) {
      const owned = await app.inject({
        method: route.method,
        url: `/api/v1/campaigns/${ownedCampaignId}/${route.suffix}`,
        ...(route.method === "PUT" ? { payload: route.payload } : {})
      });
      expect(owned.statusCode, `${route.method} ${route.suffix} owned`).toBe(
        route.suffix === "memory/embeddings/reindex" ? 409 : route.method === "POST" ? 202 : 200
      );

      for (const scopedCampaignId of [missingCampaignId, foreignCampaignId]) {
        const response = await app.inject({
          method: route.method,
          url: `/api/v1/campaigns/${scopedCampaignId}/${route.suffix}`,
          ...(route.method === "PUT" ? { payload: route.payload } : {})
        });
        expect(response.statusCode, `${route.method} ${route.suffix} scoped`).toBe(404);
      }

      const invalid = await app.inject({
        method: route.method,
        url: `/api/v1/campaigns/${invalidCampaignId}/${route.suffix}`,
        ...(route.method === "PUT" ? { payload: route.payload } : {})
      });
      expect(invalid.statusCode, `${route.method} ${route.suffix} invalid`).toBe(400);
    }

    const invalidQuery = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${ownedCampaignId}/memory/context-preview?budgetTokens=1`
    });
    expect(invalidQuery.statusCode).toBe(400);
    const invalidConfig = await app.inject({
      method: "PUT",
      url: `/api/v1/campaigns/${ownedCampaignId}/memory/embedding-config`,
      payload: { ...disabledConfig, batchSize: 0 }
    });
    expect(invalidConfig.statusCode).toBe(400);

    for (const jobId of [crypto.randomUUID(), foreignJobId]) {
      const response = await app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}` });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Not found", message: "Job not found." });
    }
    const invalidJob = await app.inject({ method: "GET", url: "/api/v1/jobs/not-a-job-id" });
    expect(invalidJob.statusCode).toBe(400);
  });

  it("preserves duplicate/retry identity and exposes only resumable progress plus fixed safe failures", async () => {
    const campaignId = await campaign();
    const first = await app.inject({ method: "POST", url: `/api/v1/campaigns/${campaignId}/memory/reindex` });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ jobId: expect.any(String), status: "queued" });
    const firstJobId = first.json().jobId as string;

    const duplicate = await app.inject({ method: "POST", url: `/api/v1/campaigns/${campaignId}/memory/reindex` });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toMatchObject({ jobId: firstJobId, status: "queued" });

    await pool.query(
      "UPDATE chronicle_jobs SET status = 'running', attempts = 2, progress = $2::jsonb WHERE id = $1",
      [firstJobId, JSON.stringify({ rebuilt: 2, cursor: "resume-after-two" })]
    );
    const running = await app.inject({ method: "GET", url: `/api/v1/jobs/${firstJobId}` });
    expect(running.statusCode).toBe(200);
    expect(running.json()).toMatchObject({
      id: firstJobId,
      campaignId,
      jobType: "reindex_campaign",
      status: "running",
      attempts: 2,
      progress: { rebuilt: 2, cursor: "resume-after-two" }
    });

    const privateDiagnostic = "https://private.embedding.invalid/v1?token=route-secret";
    await pool.query(
      "UPDATE chronicle_jobs SET status = 'failed', error_message = $2, lease_owner = NULL, lease_expires_at = NULL WHERE id = $1",
      [firstJobId, privateDiagnostic]
    );
    const failed = await app.inject({ method: "GET", url: `/api/v1/jobs/${firstJobId}` });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({
      id: firstJobId,
      status: "failed",
      failure: { code: "memory_unavailable", message: "Chronicle memory is unavailable." }
    });
    expect(JSON.stringify(failed.json())).not.toContain(privateDiagnostic);

    const retry = await app.inject({ method: "POST", url: `/api/v1/campaigns/${campaignId}/memory/reindex` });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ jobId: expect.any(String), status: "queued" });
    expect(retry.json().jobId).not.toBe(firstJobId);
  });

  it("round-trips embedding configuration and reports disabled conflicts before queueing an owned job", async () => {
    const campaignId = await campaign();
    const disabled = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/memory/embeddings/reindex`
    });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toEqual({
      error: "Not configured",
      message: "Enable semantic memory and select an embedding provider first."
    });

    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model, enabled, is_default
       ) VALUES ($1,$2,'lmstudio','embedding','http://embedding.test','audit-embedding-model',true,true)
       RETURNING id`,
      [ownerUserId, `Chronicle route provider ${crypto.randomUUID()}`]
    );
    const input = {
      enabled: true,
      providerProfileId: provider.rows[0]!.id,
      model: "audit-embedding-model",
      batchSize: 2,
      documentPrefix: "document: ",
      queryPrefix: "query: "
    };
    const saved = await app.inject({
      method: "PUT",
      url: `/api/v1/campaigns/${campaignId}/memory/embedding-config`,
      payload: input
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ ...input, jobId: expect.any(String) });
    const jobId = saved.json().jobId as string;

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/memory/embedding-config`
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject(input);

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/memory/embeddings/reindex`
    });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toEqual({ jobId, status: "queued" });

    const disabledAgain = await app.inject({
      method: "PUT",
      url: `/api/v1/campaigns/${campaignId}/memory/embedding-config`,
      payload: { ...input, enabled: false }
    });
    expect(disabledAgain.statusCode).toBe(200);
    expect(disabledAgain.json()).toMatchObject({ enabled: false, jobId: null });
    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/memory/embeddings/reindex`
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("keeps a slow composed worker claim alive with heartbeats and reclaims an expired claim safely", async () => {
    const campaignId = await campaign();
    const queued = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/memory/reindex`
    });
    const jobId = queued.json().jobId as string;
    await pool.query("UPDATE chronicle_jobs SET created_at = timestamp '2000-01-01' WHERE id = $1", [jobId]);
    await pool.query(`
      CREATE OR REPLACE FUNCTION chronicle_audit_slow_rebuild() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.4);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER chronicle_audit_slow_rebuild_trigger
      BEFORE INSERT ON chronicle_memories
      FOR EACH ROW EXECUTE FUNCTION chronicle_audit_slow_rebuild()
    `);
    const firstWorker = createWorkerMemoryApplication(pool, credentialSecret);
    const secondWorker = createWorkerMemoryApplication(pool, credentialSecret);
    try {
      const firstRun = firstWorker.runNextChronicle({
        workerId: "chronicle-audit-heartbeat-a",
        leaseSeconds: 1,
        retrieval: { batchLimit: 1 }
      });
      let initialExpiry: Date | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const running = await pool.query<{ status: string; lease_expires_at: Date | null }>(
          "SELECT status, lease_expires_at FROM chronicle_jobs WHERE id = $1",
          [jobId]
        );
        if (running.rows[0]?.status === "running") {
          initialExpiry = running.rows[0].lease_expires_at;
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      expect(initialExpiry).toBeInstanceOf(Date);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
      const renewed = await pool.query<{ lease_expires_at: Date | null }>(
        "SELECT lease_expires_at FROM chronicle_jobs WHERE id = $1",
        [jobId]
      );
      expect(renewed.rows[0]?.lease_expires_at?.getTime()).toBeGreaterThan(initialExpiry!.getTime());
      const competingClaim = await secondWorker.claimNext({
        workerId: "chronicle-audit-heartbeat-b",
        leaseSeconds: 1
      });
      expect(competingClaim?.jobId).not.toBe(jobId);
      if (competingClaim) {
        await secondWorker.requeueClaim(competingClaim, { reason: "lease_reclaimed" });
      }
      await expect(firstRun).resolves.toBe(true);
      const completed = await pool.query<{ status: string; attempts: number }>(
        "SELECT status, attempts FROM chronicle_jobs WHERE id = $1",
        [jobId]
      );
      expect(completed.rows[0]).toEqual({ status: "completed", attempts: 1 });
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS chronicle_audit_slow_rebuild_trigger ON chronicle_memories");
      await pool.query("DROP FUNCTION IF EXISTS chronicle_audit_slow_rebuild()");
    }

    const reclaimCampaignId = await campaign();
    const reclaimQueued = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${reclaimCampaignId}/memory/reindex`
    });
    const reclaimJobId = reclaimQueued.json().jobId as string;
    await pool.query("UPDATE chronicle_jobs SET created_at = timestamp '1999-01-01' WHERE id = $1", [reclaimJobId]);
    const staleClaim = await firstWorker.claimNext({
      workerId: "chronicle-audit-stale-worker",
      leaseSeconds: 30
    });
    expect(staleClaim).toMatchObject({ jobId: reclaimJobId, campaignId: reclaimCampaignId });
    await pool.query(
      "UPDATE chronicle_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [reclaimJobId]
    );
    await expect(secondWorker.runNextChronicle({
      workerId: "chronicle-audit-reclaim-worker",
      leaseSeconds: 30,
      retrieval: { batchLimit: 1 }
    })).resolves.toBe(true);
    await expect(firstWorker.completeClaim(staleClaim!, { progress: { rebuilt: 999 } })).resolves.toBe(false);
    const reclaimed = await pool.query<{ status: string; attempts: number; lease_owner: string | null }>(
      "SELECT status, attempts, lease_owner FROM chronicle_jobs WHERE id = $1",
      [reclaimJobId]
    );
    expect(reclaimed.rows[0]).toEqual({ status: "completed", attempts: 2, lease_owner: null });
  });
});
