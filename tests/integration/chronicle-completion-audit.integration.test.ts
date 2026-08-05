import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { buildServer } from "../../services/api/src/server.js";
import { createWorkerMemoryApplication } from "../helpers/runtime-application-fixtures.js";
import { serverOptions } from "../helpers/build-server-options.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";

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
  let foreignWorldId = "";
  let foreignCampaignId = "";
  let foreignJobId = "";
  let assetRoot = "";
  let providerTransport: ReturnType<typeof installIntegrationProviderTransport>;
  const testCampaignIds = new Set<string>();
  const testWorldIds = new Set<string>();
  const testProviderIds = new Set<string>();

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    providerTransport = installIntegrationProviderTransport(["127.0.0.0/8", "embedding.test"]);
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
    foreignWorldId = world.rows[0]!.id;
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
    await pool.query("DELETE FROM campaigns WHERE id = $1", [foreignCampaignId]);
    await pool.query("DELETE FROM world_versions WHERE world_id = $1", [foreignWorldId]);
    await pool.query("DELETE FROM worlds WHERE id = $1", [foreignWorldId]);
    await pool.query("DELETE FROM users WHERE id = $1", [foreignOwnerUserId]);
    await providerTransport.close();
    await pool.end();
    await rm(assetRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const campaignIds = [...testCampaignIds];
    const worldIds = [...testWorldIds];
    const providerIds = [...testProviderIds];
    testCampaignIds.clear();
    testWorldIds.clear();
    testProviderIds.clear();
    if (campaignIds.length) {
      await pool.query("DELETE FROM campaigns WHERE id = ANY($1::uuid[])", [campaignIds]);
    }
    if (worldIds.length) {
      await pool.query("DELETE FROM world_versions WHERE world_id = ANY($1::uuid[])", [worldIds]);
      await pool.query("DELETE FROM worlds WHERE id = ANY($1::uuid[])", [worldIds]);
    }
    if (providerIds.length) {
      await pool.query("DELETE FROM provider_profiles WHERE id = ANY($1::uuid[])", [providerIds]);
    }
  });

  async function campaign(): Promise<string> {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Chronicle route campaign ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `chronicle-route-${crypto.randomUUID()}.story`,
      story: fixture
    }));
    testCampaignIds.add(imported.campaignId);
    testWorldIds.add(imported.worldId);
    return imported.campaignId;
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
    testProviderIds.add(provider.rows[0]!.id);
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

  it("atomically persists composed embedding vectors, reported costs, progress, and completion", async () => {
    const campaignId = await campaign();
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model, enabled, is_default
       ) VALUES ($1,$2,'openai_compatible','embedding','http://embedding.test','audit-embedding-model',true,true)
       RETURNING id`,
      [ownerUserId, `Chronicle composed success ${crypto.randomUUID()}`]
    );
    const providerId = provider.rows[0]!.id;
    testProviderIds.add(providerId);
    const configured = await app.inject({
      method: "PUT",
      url: `/api/v1/campaigns/${campaignId}/memory/embedding-config`,
      payload: {
        enabled: true,
        providerProfileId: providerId,
        model: "audit-embedding-model",
        batchSize: 2,
        documentPrefix: "document: ",
        queryPrefix: "query: "
      }
    });
    expect(configured.statusCode).toBe(200);
    const jobId = configured.json().jobId as string;
    const before = await pool.query<{ indexed: number; costs: number; status: string; progress: Record<string, unknown> }>(
      `SELECT
         count(memory.id) FILTER (WHERE memory.embedding IS NOT NULL)::int AS indexed,
         (SELECT count(*)::int FROM provider_cost_events WHERE chronicle_job_id = job.id) AS costs,
         job.status, job.progress
       FROM chronicle_jobs job
       LEFT JOIN chronicle_memories memory ON memory.campaign_id = job.campaign_id
       WHERE job.id = $1
       GROUP BY job.id`,
      [jobId]
    );
    expect(before.rows[0]).toEqual({ indexed: 0, costs: 0, status: "queued", progress: {} });

    let responseNumber = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      responseNumber += 1;
      return new Response(JSON.stringify({
        id: `audit-embedding-response-${responseNumber}`,
        model: "audit-embedding-model",
        data: body.input.map((_content, index) => ({ index, embedding: [1, 0, 0] })),
        usage: {
          prompt_tokens: body.input.length,
          total_tokens: body.input.length,
          cost: "0.001",
          currency: "USD"
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const worker = createWorkerMemoryApplication(pool, credentialSecret);
    await expect(worker.runNextChronicle({
      workerId: "chronicle-audit-embedding-success",
      leaseSeconds: 30,
      retrieval: { batchLimit: 2 }
    })).resolves.toBe(true);

    const durable = await pool.query<{
      status: string;
      progress: { embedded: number; total: number; skipped: number };
      total_memories: number;
      indexed_memories: number;
      correct_provider: number;
      cost_events: number;
      cost_amount: string;
    }>(
      `SELECT job.status, job.progress,
              count(memory.id)::int AS total_memories,
              count(memory.id) FILTER (WHERE memory.embedding IS NOT NULL)::int AS indexed_memories,
              count(memory.id) FILTER (
                WHERE memory.embedding_provider_profile_id = $2
                  AND memory.embedding_dimensions = 3
                  AND memory.embedding_content_hash IS NOT NULL
                  AND memory.embedding_provider_fingerprint IS NOT NULL
              )::int AS correct_provider,
              (SELECT count(*)::int FROM provider_cost_events cost
                WHERE cost.chronicle_job_id = job.id AND cost.category = 'memory'
                  AND cost.operation = 'memory_embedding') AS cost_events,
              (SELECT coalesce(sum(cost.amount), 0)::text FROM provider_cost_events cost
                WHERE cost.chronicle_job_id = job.id) AS cost_amount
         FROM chronicle_jobs job
         JOIN chronicle_memories memory ON memory.campaign_id = job.campaign_id
        WHERE job.id = $1
        GROUP BY job.id`,
      [jobId, providerId]
    );
    expect(durable.rows[0]).toMatchObject({
      status: "completed",
      total_memories: expect.any(Number),
      indexed_memories: expect.any(Number),
      correct_provider: expect.any(Number),
      cost_events: responseNumber
    });
    expect(durable.rows[0]!.total_memories).toBeGreaterThan(0);
    expect(durable.rows[0]!.indexed_memories).toBe(durable.rows[0]!.total_memories);
    expect(durable.rows[0]!.correct_provider).toBe(durable.rows[0]!.total_memories);
    expect(durable.rows[0]!.progress).toEqual({
      embedded: durable.rows[0]!.total_memories,
      skipped: 0,
      total: durable.rows[0]!.total_memories
    });
    expect(Number(durable.rows[0]!.cost_amount)).toBeCloseTo(responseNumber * 0.001, 6);
  });

  it("terminalizes composed provider failure with safe projection and no partial embedding writes", async () => {
    const campaignId = await campaign();
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model, enabled, is_default
       ) VALUES ($1,$2,'openai_compatible','embedding','http://embedding.test','audit-failing-model',true,true)
       RETURNING id`,
      [ownerUserId, `Chronicle composed failure ${crypto.randomUUID()}`]
    );
    const providerId = provider.rows[0]!.id;
    testProviderIds.add(providerId);
    const configured = await app.inject({
      method: "PUT",
      url: `/api/v1/campaigns/${campaignId}/memory/embedding-config`,
      payload: {
        enabled: true,
        providerProfileId: providerId,
        model: "audit-failing-model",
        batchSize: 2,
        documentPrefix: null,
        queryPrefix: null
      }
    });
    const jobId = configured.json().jobId as string;
    const privateDiagnostic = "https://private.embedding.invalid/v1?token=never-public";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { message: privateDiagnostic }
    }), { status: 503, headers: { "content-type": "application/json" } })));

    const worker = createWorkerMemoryApplication(pool, credentialSecret);
    await expect(worker.runNextChronicle({
      workerId: "chronicle-audit-embedding-failure",
      leaseSeconds: 30,
      retrieval: { batchLimit: 2 }
    })).resolves.toBe(true);

    const internal = await pool.query<{
      status: string;
      error_message: string;
      progress: Record<string, unknown>;
      indexed: number;
      costs: number;
      provider_error: string | null;
    }>(
      `SELECT job.status, job.error_message, job.progress,
              count(memory.id) FILTER (WHERE memory.embedding IS NOT NULL)::int AS indexed,
              (SELECT count(*)::int FROM provider_cost_events WHERE chronicle_job_id = job.id) AS costs,
              provider.last_health_error AS provider_error
         FROM chronicle_jobs job
         JOIN provider_profiles provider ON provider.id = $2
         LEFT JOIN chronicle_memories memory ON memory.campaign_id = job.campaign_id
        WHERE job.id = $1
        GROUP BY job.id, provider.id`,
      [jobId, providerId]
    );
    expect(internal.rows[0]).toEqual({
      status: "failed",
      error_message: "chronicle_execution_failed",
      progress: {},
      indexed: 0,
      costs: 0,
      provider_error: "provider_unavailable"
    });
    expect(JSON.stringify(internal.rows[0])).not.toContain(privateDiagnostic);

    const publicJob = await app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}` });
    expect(publicJob.statusCode).toBe(200);
    expect(publicJob.json()).toMatchObject({
      id: jobId,
      status: "failed",
      failure: { code: "memory_unavailable", message: "Chronicle memory is unavailable." }
    });
    expect(JSON.stringify(publicJob.json())).not.toContain(privateDiagnostic);
  });

  it("keeps a slow composed worker claim alive with heartbeats and reclaims an expired claim safely", async () => {
    const campaignId = await campaign();
    const queued = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/memory/reindex`
    });
    const jobId = queued.json().jobId as string;
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
