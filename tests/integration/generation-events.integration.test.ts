import pg from "pg";
import { request, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { runner } from "node-pg-migrate";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import {
  GENERATION_CHANGED_CHANNEL,
  createPostgresGenerationEventSource
} from "../../packages/database/src/postgres-generation-events.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { generationStreamSnapshotSchema, type GenerationStreamSnapshot } from "../../packages/contracts/src/generation.js";
import { logger } from "../../packages/logger/src/index.js";
import { buildServer } from "../../services/api/src/server.js";
import { createApiGenerationApplication } from "../helpers/runtime-application-fixtures.js";
import { createApiWorldCampaignApplication } from "../helpers/runtime-application-fixtures.js";
import { createApiIllustrationApplication } from "../helpers/runtime-application-fixtures.js";
import { apiMemoryApplication } from "../helpers/memory-applications.js";
import { inertProviders } from "../helpers/build-server-options.js";
import { apiProviderGraph } from "../helpers/provider-application-fixtures.js";
import { dropTestDatabaseWhenIdle } from "./database-test-helpers.js";

const { Client } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

type Change = Readonly<{ jobId: string; version: string }>;

integration("generation job notification delivery", () => {
  let pool: DatabasePool;
  let listener: InstanceType<typeof Client>;
  let ownerUserId = "";
  let providerProfileId = "";
  let storageRoot = "";
  const notifications: Change[] = [];
  const notificationWaiters: Array<() => void> = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    storageRoot = await mkdtemp(join(tmpdir(), "infinitequest-generation-events-"));
    providerProfileId = (await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model
       ) VALUES ($1,$2,'openai_compatible','text','http://127.0.0.1:9911','event-test-model')
       RETURNING id`,
      [ownerUserId, `Generation event provider ${crypto.randomUUID()}`]
    )).rows[0]!.id;

    listener = new Client({
      connectionString: databaseUrl!,
      application_name: "generation-events-integration-listener"
    });
    listener.on("notification", (notification) => {
      if (notification.channel !== GENERATION_CHANGED_CHANNEL || !notification.payload) return;
      notifications.push(JSON.parse(notification.payload) as Change);
      notificationWaiters.splice(0).forEach((resolveWaiter) => resolveWaiter());
    });
    await listener.connect();
    await listener.query(`LISTEN ${GENERATION_CHANGED_CHANNEL}`);
  });

  afterAll(async () => {
    if (listener) await listener.end();
    if (pool) await pool.end();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  async function campaign(): Promise<string> {
    const worldId = (await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `Generation event world ${crypto.randomUUID()}`]
    )).rows[0]!.id;
    const worldVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,1,'{}'::jsonb) RETURNING id`,
      [worldId, ownerUserId]
    )).rows[0]!.id;
    return (await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, worldVersionId, `Generation event campaign ${crypto.randomUUID()}`]
    )).rows[0]!.id;
  }

  async function waitForNotification(index: number, timeoutMs = 2_000): Promise<Change> {
    const deadline = Date.now() + timeoutMs;
    while (!notifications[index]) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for generation notification ${index}.`);
      await Promise.race([
        new Promise<void>((resolveWaiter) => notificationWaiters.push(resolveWaiter)),
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, remaining))
      ]);
    }
    return notifications[index]!;
  }

  async function job(campaignId: string): Promise<string> {
    return (await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key,
         expected_turn_number, action, status
       ) VALUES ($1,$2,$3,$4,1,'Open the SSE notification gate.','queued') RETURNING id`,
      [ownerUserId, campaignId, providerProfileId, crypto.randomUUID()]
    )).rows[0]!.id;
  }

  function runtimeConfig(maxConnections: number): RuntimeConfig {
    return {
      role: "api",
      host: "127.0.0.1",
      port: 0,
      databaseUrl: databaseUrl!,
      databaseMaxConnections: maxConnections,
      migrationDirectory: resolve("database/migrations"),
      migrationWaitSeconds: 10,
      allowMaintenanceMigrations: false,
      workerPollIntervalMs: 1_000,
      workerLeaseSeconds: 60,
      workerGenerationConcurrency: 1,
      legacyWebRoot: resolve("apps/web/public"),
      nextWebRoot: resolve("apps/web-next"),
      assetStorageDriver: "filesystem",
      assetStorageRoot: join(storageRoot, "assets"),
      archiveStorageRoot: join(storageRoot, "archives"),
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
      credentialEncryptionKey: "generation-event-integration-secret",
      security: {
        corsAllowedOrigins: [],
        providerNetworkAllowlist: [],
        cspImageAllowedOrigins: [],
        apiDefaultBodyLimitBytes: 1_048_576,
        apiImportBodyLimitBytes: 16_777_216,
        apiAssetBodyLimitBytes: 33_554_432,
        apiRateLimitWindowSeconds: 60,
        apiRateLimitProviderRequests: 100,
        apiRateLimitGenerationRequests: 100,
        apiRateLimitImportRequests: 100,
        apiConcurrencyProviderRequests: 2,
        apiConcurrencyImportRequests: 1,
        trustProxyHops: 0
      }
    };
  }

  async function openGenerationStream(address: string, jobId: string): Promise<{
    nextFrame(timeoutMs?: number): Promise<GenerationStreamSnapshot>;
    close(): void;
  }> {
    return new Promise((resolveOpen, rejectOpen) => {
      const frames: GenerationStreamSnapshot[] = [];
      const waiters: Array<(frame: GenerationStreamSnapshot) => void> = [];
      let response: IncomingMessage | undefined;
      let buffer = "";
      const streamRequest = request(`${address}/api/v1/generation-jobs/${jobId}/stream`, (incoming) => {
        response = incoming;
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          buffer += chunk;
          for (;;) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary < 0) break;
            const rawFrame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (!rawFrame.startsWith("data: ")) continue;
            const frame = generationStreamSnapshotSchema.parse(JSON.parse(rawFrame.slice(6)));
            const waiter = waiters.shift();
            if (waiter) waiter(frame);
            else frames.push(frame);
          }
        });
        resolveOpen({
          nextFrame(timeoutMs = 2_000) {
            const frame = frames.shift();
            if (frame) return Promise.resolve(frame);
            return new Promise<GenerationStreamSnapshot>((resolveFrame, rejectFrame) => {
              const timer = setTimeout(() => rejectFrame(new Error("Timed out waiting for an SSE frame.")), timeoutMs);
              waiters.push((next) => {
                clearTimeout(timer);
                resolveFrame(next);
              });
            });
          },
          close() {
            response?.destroy();
            streamRequest.destroy();
          }
        });
      });
      streamRequest.once("error", rejectOpen);
      streamRequest.end();
    });
  }

  async function expectNoNotificationSince(count: number, durationMs = 100): Promise<void> {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, durationMs));
    expect(notifications).toHaveLength(count);
  }

  it("publishes insert and every SSE-visible transition only after commit while rollback and lease heartbeats stay silent", async () => {
    const campaignId = await campaign();
    const transaction = await pool.connect();
    const firstIndex = notifications.length;
    await transaction.query("BEGIN");
    const jobId = (await transaction.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key,
         expected_turn_number, action, status
       ) VALUES ($1,$2,$3,$4,1,'Open the notification gate.','queued') RETURNING id`,
      [ownerUserId, campaignId, providerProfileId, crypto.randomUUID()]
    )).rows[0]!.id;

    await expectNoNotificationSince(firstIndex);
    await transaction.query("COMMIT");
    transaction.release();
    await expect(waitForNotification(firstIndex)).resolves.toMatchObject({ jobId, version: expect.any(String) });
    expect(Object.keys(notifications[firstIndex]!).sort()).toEqual(["jobId", "version"]);

    const rollbackIndex = notifications.length;
    const rollback = await pool.connect();
    await rollback.query("BEGIN");
    await rollback.query("UPDATE generation_jobs SET partial_output = 'rolled back narration' WHERE id = $1", [jobId]);
    await expectNoNotificationSince(rollbackIndex);
    await rollback.query("ROLLBACK");
    rollback.release();
    await expectNoNotificationSince(rollbackIndex);

    const resultTurnId = (await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, narration)
       VALUES ($1,$2,1,'A committed notification result.') RETURNING id`,
      [ownerUserId, campaignId]
    )).rows[0]!.id;

    const visibleTransitions: Array<Readonly<{ sql: string; values: string[] }>> = [
      { sql: "UPDATE generation_jobs SET status = 'assessing' WHERE id = $1", values: [jobId] },
      { sql: "UPDATE generation_jobs SET partial_output = 'Visible fictional narration.' WHERE id = $1", values: [jobId] },
      { sql: "UPDATE generation_jobs SET attempts = attempts + 1 WHERE id = $1", values: [jobId] },
      { sql: "UPDATE generation_jobs SET result_turn_id = $2 WHERE id = $1", values: [jobId, resultTurnId] }
    ];
    for (const { sql, values } of visibleTransitions) {
      const index = notifications.length;
      await pool.query(sql, values);
      await expect(waitForNotification(index)).resolves.toMatchObject({ jobId, version: expect.any(String) });
    }

    const heartbeatIndex = notifications.length;
    await pool.query(
      "UPDATE generation_jobs SET lease_expires_at = now() + interval '30 seconds', updated_at = now() WHERE id = $1",
      [jobId]
    );
    await expectNoNotificationSince(heartbeatIndex);

    const privateErrorIndex = notifications.length;
    await pool.query(
      "UPDATE generation_jobs SET error_code = 'private_code', error_message = 'private detail' WHERE id = $1",
      [jobId]
    );
    await expectNoNotificationSince(privateErrorIndex);
  });

  it("delivers authoritative SSE frames under the 500ms p95 budget without the former 350ms idle polling loop", async () => {
    const campaignId = await campaign();
    const jobId = await job(campaignId);
    const routePool = createDatabasePool(databaseUrl!, 3);
    let generationJobReads = 0;
    const countedPool = new Proxy(routePool, {
      get(target, property, receiver) {
        if (property === "query") {
          return async (...argumentsList: Parameters<DatabasePool["query"]>) => {
            const statement = String(argumentsList[0]).replaceAll(/\s+/g, " ").trim();
            if (statement.startsWith("SELECT id, campaign_id AS") && statement.includes("partial_output AS")) {
              generationJobReads += 1;
            }
            return target.query(...argumentsList);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as DatabasePool;
    const source = createPostgresGenerationEventSource(countedPool, databaseUrl!);
    const app = await buildServer({
      config: runtimeConfig(3),
      pool: countedPool,
      generation: createApiGenerationApplication(countedPool),
      illustration: createApiIllustrationApplication(countedPool),
      memory: apiMemoryApplication(countedPool),
      providers: inertProviders,
      infiniteWorldsProviders: apiProviderGraph(countedPool, runtimeConfig(3).credentialEncryptionKey).infiniteWorlds,
      worldCampaign: createApiWorldCampaignApplication(countedPool, { credentialSecret: runtimeConfig(3).credentialEncryptionKey }),
      generationEvents: source
    });
    let stream: Awaited<ReturnType<typeof openGenerationStream>> | undefined;
    try {
      await source.start();
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      stream = await openGenerationStream(address, jobId);
      await expect(stream.nextFrame()).resolves.toMatchObject({ id: jobId, status: "queued" });
      expect(generationJobReads).toBe(2);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 500));
      expect(generationJobReads).toBe(2);

      const latencies: number[] = [];
      for (let index = 0; index < 20; index += 1) {
        const framePromise = stream.nextFrame();
        const startedAt = performance.now();
        await pool.query(
          "UPDATE generation_jobs SET partial_output = $2 WHERE id = $1",
          [jobId, JSON.stringify({ narration: `Notification frame ${index}.` })]
        );
        await expect(framePromise).resolves.toMatchObject({
          id: jobId,
          partialNarration: `Notification frame ${index}.`
        });
        latencies.push(performance.now() - startedAt);
      }
      const terminalFrame = stream.nextFrame();
      await pool.query("UPDATE generation_jobs SET status = 'cancelled' WHERE id = $1", [jobId]);
      await expect(terminalFrame).resolves.toMatchObject({ id: jobId, status: "cancelled" });

      latencies.sort((left, right) => left - right);
      const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1]!;
      logger.info({
        event: "generation_sse_latency_evidence",
        sampleCount: latencies.length,
        minMs: latencies[0],
        medianMs: latencies[Math.floor(latencies.length / 2)],
        p95Ms: p95,
        maxMs: latencies.at(-1),
        generationJobReads
      });
      expect({ sampleCount: latencies.length, p95 }).toMatchObject({ sampleCount: 20, p95: expect.any(Number) });
      expect(p95).toBeLessThanOrEqual(500);
      expect(generationJobReads).toBe(23);
    } finally {
      stream?.close();
      await app.close();
      await source.close();
      await routePool.end();
    }
  });

  it("serves more SSE subscribers than pool max with one dedicated listener and no held subscriber checkout", async () => {
    const campaignId = await campaign();
    const jobId = await job(campaignId);
    const routePool = createDatabasePool(databaseUrl!, 3);
    const source = createPostgresGenerationEventSource(routePool, databaseUrl!);
    const app = await buildServer({
      config: runtimeConfig(3),
      pool: routePool,
      generation: createApiGenerationApplication(routePool),
      illustration: createApiIllustrationApplication(routePool),
      memory: apiMemoryApplication(routePool),
      providers: inertProviders,
      infiniteWorldsProviders: apiProviderGraph(routePool, runtimeConfig(3).credentialEncryptionKey).infiniteWorlds,
      worldCampaign: createApiWorldCampaignApplication(routePool, { credentialSecret: runtimeConfig(3).credentialEncryptionKey }),
      generationEvents: source
    });
    const streams: Array<Awaited<ReturnType<typeof openGenerationStream>>> = [];
    try {
      await source.start();
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      streams.push(...await Promise.all(Array.from({ length: 8 }, () => openGenerationStream(address, jobId))));
      await Promise.all(streams.map((stream) => stream.nextFrame()));

      expect(routePool.totalCount).toBeLessThanOrEqual(3);
      expect(routePool.waitingCount).toBe(0);
      const listeners = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name = 'infinite-quest-generation-events'`
      );
      expect(listeners.rows[0]?.count).toBe("1");
    } finally {
      streams.forEach((stream) => stream.close());
      await app.close();
      await source.close();
      await routePool.end();
    }
  });

  it("removes and restores the notification trigger and function through the migration down/up path", async () => {
    const databaseName = `infinitequest_generation_events_migration_${crypto.randomUUID().replaceAll("-", "")}`;
    const isolatedUrl = new URL(databaseUrl!);
    isolatedUrl.pathname = `/${databaseName}`;
    let migrationPool: DatabasePool | null = null;
    try {
      await pool.query(`CREATE DATABASE ${databaseName}`);
      migrationPool = createDatabasePool(isolatedUrl.toString(), 2);
      await migrateDatabase(migrationPool, resolve("database/migrations"));
      const client = await migrationPool.connect();
      try {
        await client.query("SET session_replication_role = 'replica'");
        await client.query(
          `INSERT INTO portable_import_asset_publications (
             operation_id,owner_user_id,import_id,asset_id
           ) VALUES (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid())`,
        );
        await client.query("SET session_replication_role = 'origin'");
        await expect(runner({
          dbClient: client,
          dir: resolve("database/migrations"),
          direction: "down",
          count: 1,
          migrationsTable: "schema_migrations",
          checkOrder: true,
          singleTransaction: true,
          verbose: false,
          logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
        })).rejects.toThrow("cannot downgrade portable import asset publications while retained mappings exist");
        await expect(client.query(
          "SELECT to_regclass('public.portable_import_asset_publications') AS table_name",
        )).resolves.toMatchObject({ rows: [{ table_name: "portable_import_asset_publications" }] });
        await client.query("SET session_replication_role = 'replica'");
        await client.query("DELETE FROM portable_import_asset_publications");
        await client.query(
          `INSERT INTO portable_import_asset_reservation_intents (
             operation_id,owner_user_id,ordinal,asset_id,commit_idempotency_key_hash,
             command_fingerprint,asset_idempotency_key_hash,asset_request_fingerprint
           ) VALUES (
             gen_random_uuid(),gen_random_uuid(),0,gen_random_uuid(),
             repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64)
           )`,
        );
        await client.query("SET session_replication_role = 'origin'");
        await expect(runner({
          dbClient: client,
          dir: resolve("database/migrations"),
          direction: "down",
          count: 1,
          migrationsTable: "schema_migrations",
          checkOrder: true,
          singleTransaction: true,
          verbose: false,
          logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
        })).rejects.toThrow("cannot downgrade portable import asset publications while retained mappings exist");
        await expect(client.query(
          "SELECT to_regclass('public.portable_import_asset_reservation_intents') AS table_name",
        )).resolves.toMatchObject({ rows: [{ table_name: "portable_import_asset_reservation_intents" }] });
        await client.query("SET session_replication_role = 'replica'");
        await client.query("DELETE FROM portable_import_asset_reservation_intents");
        await client.query("SET session_replication_role = 'origin'");

        const reverted = await runner({
          dbClient: client,
          dir: resolve("database/migrations"),
          direction: "down",
          count: 11,
          migrationsTable: "schema_migrations",
          checkOrder: true,
          singleTransaction: true,
          verbose: false,
          logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
        });
        expect(reverted.map((migration) => migration.name)).toEqual([
          "0062_portable_import_asset_publications",
          "0061_portable_import_composition",
          "0060_asset_publication_identities",
          "0059_secure_storage_target_intent",
          "0058_secure_storage_lifecycle",
          "0057_finalized_asset_delivery_authority",
          "0056_private_filesystem_current_clock",
          "0055_private_portable_repository_guards",
          "0054_private_filesystem_authority",
          "0053_durable_asset_portable_operations",
          "0052_generation_job_notifications"
        ]);
      } finally {
        client.release();
      }

      await expect(migrationPool.query<{ trigger_name: string | null; function_name: string | null }>(
         `SELECT (
           SELECT min(trigger_name) FROM information_schema.triggers
            WHERE event_object_table = 'generation_jobs'
              AND trigger_name = 'generation_jobs_notify_changed_v1'
         ) AS trigger_name,
         to_regprocedure('notify_generation_job_changed_v1()')::text AS function_name`
      )).resolves.toMatchObject({ rows: [{ trigger_name: null, function_name: null }] });

      await expect(migrateDatabase(migrationPool, resolve("database/migrations")))
        .resolves.toEqual([
          "0052_generation_job_notifications",
          "0053_durable_asset_portable_operations",
          "0054_private_filesystem_authority",
          "0055_private_portable_repository_guards",
          "0056_private_filesystem_current_clock",
          "0057_finalized_asset_delivery_authority",
          "0058_secure_storage_lifecycle",
          "0059_secure_storage_target_intent",
          "0060_asset_publication_identities",
          "0061_portable_import_composition",
          "0062_portable_import_asset_publications"
        ]);
      await expect(migrationPool.query<{ trigger_name: string | null; function_name: string | null }>(
         `SELECT (
           SELECT min(trigger_name) FROM information_schema.triggers
            WHERE event_object_table = 'generation_jobs'
              AND trigger_name = 'generation_jobs_notify_changed_v1'
         ) AS trigger_name,
         to_regprocedure('notify_generation_job_changed_v1()')::text AS function_name`
      )).resolves.toMatchObject({
        rows: [{
          trigger_name: "generation_jobs_notify_changed_v1",
          function_name: "notify_generation_job_changed_v1()"
        }]
      });
    } finally {
      if (migrationPool) await migrationPool.end();
      await dropTestDatabaseWhenIdle(pool, databaseName);
    }
  });
});
