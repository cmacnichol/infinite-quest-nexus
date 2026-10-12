import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { activityPageSchema } from "../../packages/contracts/src/activity.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { loadRuntimeConfig } from "../../packages/database/src/config.js";
import { createPostgresActivityMaintenanceRepository } from "../../packages/database/src/activity-maintenance-repository.js";
import { captureActivity, encodeActivityCursor } from "../../packages/database/src/activity-repository.js";
import { createActivityComposition } from "../../services/runtime/src/activity-composition.js";
import { buildServer } from "../../services/api/src/server.js";
import { inertStorageServerOptions } from "../helpers/build-server-options.js";
import { importLegacyStoryWithMemoryOff } from "../helpers/memory-aware-services.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import { runGenerationJob } from "../helpers/generation-worker-harness.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";

import { getIllustrationConfig, insertImageJob, runImageJob } from "../../services/runtime/src/illustration-image-job-adapter.js";
import type { IllustrationWorkerPorts } from "../../packages/application/src/index.js";
import type { PrivateIllustrationAssetPublicationCoordinator } from "../../packages/application/src/illustration/private-illustration-asset-publication.js";

import { loadCampaignArchiveExportSnapshot } from "../../packages/database/src/campaign-archive-export-repository.js";
import { campaignArchivePayloads } from "../../services/runtime/src/campaign-archive-export-composition.js";
import { SYSTEM_ARCHIVE_TABLE_CLASSIFICATIONS } from "../../packages/application/src/system-archives/portability-registry.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const secret = "integration-test-credential-secret";
function validStory(narration = "Location Gamma opens and Marker Three becomes visible."): string {
  return JSON.stringify({
    narration,
    choices: ["Enter Location Gamma.", "Call Test Character.", "Study Marker Three.", "Wait."],
    custom_action_suggestion: "Inspect Object Delta.",
    scratchpad: "Private synthetic continuity marker.",
    tracker_updates: [{ name: "Location Gamma", value: "open" }],
    image_prompt: "Synthetic Location Gamma with Marker Three visible.",
    continuity_summary: "Test Character has reached Location Gamma after discovering Marker Three.",
    canonical_facts: ["Location Gamma is open."],
    superseded_facts: [],
    canonical_fact_updates: [],
    open_threads: ["Determine what Marker Three unlocks."]
  });
}

(databaseUrl ? describe : describe.skip)("composed persistent activity workflow", () => {
  let pool: DatabasePool, provider: Server;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let transport: ReturnType<typeof installIntegrationProviderTransport>;
  let ownerUserId: string, providerId: string;
  let content = validStory(), finishReason = "stop", status = 200, providerCalls = 0;
  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    transport = installIntegrationProviderTransport();
    provider = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        providerCalls++;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(status === 200 ? { id: crypto.randomUUID(), model: "deterministic-mock",
          choices: [{ message: { content }, finish_reason: finishReason }],
          usage: { prompt_tokens: 700, completion_tokens: 220, total_tokens: 920 } }
          : { error: { message: "PRIVATE-PROVIDER-CANARY" } }));
      });
    });
    await new Promise<void>(done => provider.listen(0, "127.0.0.1", done));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Missing deterministic provider port");
    providerId = (await createProvider(pool, { name: "Activity workflow", providerType: "openai_compatible",
      providerRole: "text", baseUrl: `http://127.0.0.1:${address.port}`, defaultModel: "deterministic-mock",
      contextWindowTokens: 32768, maxOutputTokens: 4096, temperature: 0, enabled: true,
      configuration: { textResponseFormatPolicy: "auto" } }, secret)).id;
    vi.stubEnv("DATABASE_URL", databaseUrl!); vi.stubEnv("APP_ROLE", "api");
    const config = loadRuntimeConfig(); vi.unstubAllEnvs();
    app = await buildServer(inertStorageServerOptions({ pool, config: { ...config, credentialEncryptionKey: secret } }));
  });
  afterEach(async () => {
    content = validStory(); finishReason = "stop"; status = 200;
    await pool.query("DELETE FROM campaigns WHERE owner_user_id=$1", [ownerUserId]);
  });
  afterAll(async () => {
    await app?.close();
    if (provider) await new Promise<void>((done, reject) => provider.close(error => error ? reject(error) : done()));
    await transport?.close(); await pool?.end();
  });
  async function campaign() {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Activity workflow ${crypto.randomUUID()}`;
    return (await importLegacyStoryWithMemoryOff(pool, storyImportRequestSchema.parse({ sourceName: "activity.story", story: fixture }))).campaignId;
  }
  async function enqueue(campaignId: string, idempotencyKey = crypto.randomUUID(), replacement = false) {
    const response = await app.inject({ method: "POST", url: `/api/v1/campaigns/${campaignId}/generations${replacement ? "/retry-latest" : ""}`,
      payload: { action: "PRIVATE-ACTION-CANARY", providerProfileId: providerId, idempotencyKey,
        ...(replacement ? { expectedCurrentTurnNumber: 2 } : {}), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } } });
    expect([200, 202]).toContain(response.statusCode);
    return response.json().id as string;
  }
  async function history(campaignId: string, query = "") {
    const response = await app.inject(`/api/v1/campaigns/${campaignId}/activity${query}`);
    expect(response.statusCode).toBe(200);
    return activityPageSchema.parse(response.json());
  }
  async function command(jobId: string, suffix: string, payload?: unknown) {
    const response = await app.inject({ method: "POST", url: `/api/v1/generation-jobs/${jobId}/${suffix}`, ...(payload ? { payload } : {}) });
    expect(response.statusCode).toBe(202);
    return response.json();
  }
  const run = () => runGenerationJob(pool, "activity-composed-worker", 30, secret);
  it("completes without a browser, survives publisher outage/restart and source cleanup, and reopens ordered unique history", async () => {
    const campaignId = await campaign();
    expect((await history(campaignId)).coverage.capturedSince).toBeNull();
    const key = crypto.randomUUID(), jobId = await enqueue(campaignId, key);
    expect(await enqueue(campaignId, key)).toBe(jobId);
    const before = providerCalls;
    expect(await run()).toBe(true);
    expect(providerCalls).toBeGreaterThan(before);
    const job = (await app.inject(`/api/v1/generation-jobs/${jobId}`)).json();
    expect(job.status).toBe("completed");
    expect((await pool.query("SELECT active_turn_number FROM campaigns WHERE id=$1", [campaignId])).rows[0].active_turn_number).toBe(3);
    const delayed = await history(campaignId);
    expect(delayed.events).toEqual([]); expect(delayed.coverage.pendingPublication).toBe(true);
    await pool.query("CREATE FUNCTION reject_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'publication fixture outage'; END $$");
    await pool.query("CREATE TRIGGER reject_publication BEFORE INSERT ON story_activity_events FOR EACH ROW EXECUTE FUNCTION reject_publication()");
    try {
      await expect(createPostgresActivityMaintenanceRepository(pool).publishBatch(100)).rejects.toThrow("publication fixture outage");
      expect(await createActivityComposition(pool).maintenance.tick()).toBe(false);
    }
    finally { await pool.query("DROP TRIGGER reject_publication ON story_activity_events"); await pool.query("DROP FUNCTION reject_publication()"); }
    expect((await history(campaignId)).coverage.pendingPublication).toBe(true);
    const restarted = createPostgresActivityMaintenanceRepository(pool);
    expect(await createActivityComposition(pool).maintenance.tick()).toBe(true);
    const page = await history(campaignId);
    expect(page.events.map(event => event.kind).reverse()).toEqual(["generation.queued", "generation.claimed", "generation.generating", "generation.validating", "generation.committing", "generation.completed"]);
    expect(page.events[0]!.turnId).toBe(job.resultTurnId);
    const imageProvider = (await createProvider(pool, { name: "Independent activity image", providerType: "openai_compatible",
      providerRole: "image", baseUrl: "http://127.0.0.1:9911", defaultModel: "activity-image", contextWindowTokens: 8192,
      maxOutputTokens: 1024, temperature: 0, enabled: true, configuration: {} }, "independent-image-secret")).id;
    const config = await getIllustrationConfig(pool, campaignId);
    const image = await withTransaction(pool, client => insertImageJob(client, { ownerUserId, campaignId, turnId: job.resultTurnId,
      prompt: "A quiet silver forest.", config: { ...config, enabled: true, providerProfileId: imageProvider, model: "activity-image",
        size: "1024x1024", aspectRatio: "1:1", quality: "auto", outputFormat: "png", maxAttempts: 1, imagesPerSegment: 1 } }));
    const ports = { imageProvider: { executeImage: async () => { throw Object.assign(new Error("PRIVATE-IMAGE-CANARY"), { permanent: true }); } } } as unknown as IllustrationWorkerPorts;
    await runImageJob(pool, "activity-independent-image", 60, ports, {} as PrivateIllustrationAssetPublicationCoordinator);
    expect((await app.inject(`/api/v1/generation-jobs/${jobId}`)).json().status).toBe("completed");
    await restarted.publishBatch(100);
    const illustrated = await history(campaignId);
    expect(illustrated.events.filter(event => event.source === "image").map(event => event.kind).sort()).toEqual(["image.failed", "image.generating", "image.queued"]);
    expect((await pool.query("SELECT snapshot->>'kind' AS kind FROM activity_event_outbox WHERE source_id=$1 ORDER BY activity_revision", [image!.id])).rows.map(row => row.kind)).toEqual(["image.queued", "image.generating", "image.failed"]);
    expect(JSON.stringify(illustrated)).not.toContain("PRIVATE-");
    expect(new Set(page.events.map(event => event.eventId)).size).toBe(page.events.length);
    expect(page.events.every((event, index) => !index || BigInt(event.sequence) < BigInt(page.events[index-1]!.sequence))).toBe(true);
    expect(JSON.stringify(page)).not.toContain("PRIVATE-");
    expect(await restarted.publishBatch(100)).toEqual({ published: 0, quarantined: 0 });
    await pool.query("DELETE FROM generation_jobs WHERE id=$1", [jobId]);
    expect((await history(campaignId)).events).toEqual(illustrated.events);
    expect(illustrated.events.every((event, index) => !index || BigInt(event.sequence) < BigInt(illustrated.events[index - 1]!.sequence))).toBe(true);
    const older = await history(campaignId, "?limit=2");
    const next = await history(campaignId, `?limit=2&before=${older.nextBefore}`);
    expect(BigInt(next.events[0]!.sequence)).toBeLessThan(BigInt(older.events[1]!.sequence));
    const incremental = await history(campaignId, `?after=${next.nextAfter}`);
    expect(incremental.events.every((event, index) => !index || BigInt(event.sequence) > BigInt(incremental.events[index - 1]!.sequence))).toBe(true);
    expect((await history(campaignId, `?after=${illustrated.nextAfter}`)).events).toEqual([]);
  });
  it("preserves authority through structured review/retry and independent provider failure, then accepts a fresh attempt", async () => {
    const campaignId = await campaign();
    content = '{"narration":"PRIVATE-PARTIAL-CANARY'; finishReason = "length";
    const jobId = await enqueue(campaignId); await run();
    const reviewResponse = await app.inject(`/api/v1/generation-jobs/${jobId}/review`);
    expect(reviewResponse.statusCode).toBe(200);
    const review = reviewResponse.json(); expect(review.canKeep).toBe(false); expect(review.canRetry).toBe(true);
    expect((await pool.query("SELECT active_turn_number FROM campaigns WHERE id=$1", [campaignId])).rows[0].active_turn_number).toBe(2);
    await command(jobId, "review-decision", { reviewId: review.reviewId, revision: review.revision, decision: "retry" });
    status = 401; finishReason = "stop"; await run();
    expect((await app.inject(`/api/v1/generation-jobs/${jobId}`)).json().status).toBe("failed");
    await command(jobId, "retry"); status = 200; content = validStory(); await run();
    expect((await app.inject(`/api/v1/generation-jobs/${jobId}`)).json().status).toBe("completed");
    await createPostgresActivityMaintenanceRepository(pool).publishBatch(100);
    const page = await history(campaignId);
    expect(page.events.map(event => event.kind)).toEqual(expect.arrayContaining(["generation.review_required", "generation.review_decided", "generation.retry_queued", "generation.failed", "generation.completed"]));
    expect(page.events.filter(event => event.kind === "generation.completed")).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain("PRIVATE-");
  });
  it("rolls capture failure back at API enqueue and safely replays the same idempotency key", async () => {
    const campaignId = await campaign(), key = crypto.randomUUID();
    await pool.query("CREATE FUNCTION reject_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'capture fixture outage'; END $$");
    await pool.query("CREATE TRIGGER reject_capture BEFORE INSERT ON activity_event_outbox FOR EACH ROW EXECUTE FUNCTION reject_capture()");
    try {
      const response = await app.inject({ method: "POST", url: `/api/v1/campaigns/${campaignId}/generations`, payload: { action: "Inspect.", providerProfileId: providerId, idempotencyKey: key, context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } } });
      expect(response.statusCode).toBe(500);
      expect((await pool.query("SELECT count(*) FROM generation_jobs WHERE campaign_id=$1", [campaignId])).rows[0].count).toBe("0");
      expect((await history(campaignId)).coverage.capturedSince).toBeNull();
    } finally { await pool.query("DROP TRIGGER reject_capture ON activity_event_outbox"); await pool.query("DROP FUNCTION reject_capture()"); }
    const jobId = await enqueue(campaignId, key);
    expect(await enqueue(campaignId, key)).toBe(jobId);
    expect((await pool.query("SELECT count(*) FROM activity_event_outbox WHERE source_id=$1", [jobId])).rows[0].count).toBe("1");
    await command(jobId, "cancel");
  });
  it("excludes operational events from portable projections while preserving the original private ledger", async () => {
    const campaignId = await campaign(), jobId = await enqueue(campaignId);
    await command(jobId, "cancel");
    await createPostgresActivityMaintenanceRepository(pool).publishBatch(100);
    await pool.query("INSERT INTO activity_events(owner_user_id,campaign_id,event_type,details) VALUES ($1,$2,'fixture','{\"private\":\"PORTABLE-LEDGER-CANARY\"}')", [ownerUserId, campaignId]);
    const snapshot = await loadCampaignArchiveExportSnapshot(pool, ownerUserId, campaignId);
    const portable = JSON.stringify(campaignArchivePayloads(snapshot));
    const page = await history(campaignId);
    for (const event of page.events) expect(portable).not.toContain(event.eventId);
    for (const table of ["story_activity_events", "activity_event_outbox", "campaign_activity_history"] as const) {
      expect(SYSTEM_ARCHIVE_TABLE_CLASSIFICATIONS[table]).toBe("operational");
      expect(portable).not.toContain(table);
    }
    expect(SYSTEM_ARCHIVE_TABLE_CLASSIFICATIONS.activity_events).toBe("portable_authority");
    expect((await pool.query("SELECT details FROM activity_events WHERE campaign_id=$1 AND event_type='fixture'", [campaignId])).rows[0].details).toEqual({ private: "PORTABLE-LEDGER-CANARY" });
    const importedAgain = await campaign();
    expect((await history(importedAgain)).events).toEqual([]);
    expect((await history(importedAgain)).coverage.capturedSince).toBeNull();
  });
  it("measures bounded transaction capture cost without treating a fixture as throughput capacity", async () => {
    const campaignId = await campaign(), samples = 20;
    const emptyStart = performance.now();
    for (let index = 0; index < samples; index++) await withTransaction(pool, async () => undefined);
    const emptyMs = performance.now() - emptyStart;
    const captureStart = performance.now();
    for (let index = 0; index < samples; index++) {
      const eventId = crypto.randomUUID();
      await withTransaction(pool, client => captureActivity(client, { scope: { ownerUserId, campaignId }, sourceId: eventId, revision: "1",
        draft: { version: 1, eventId, occurredAt: new Date().toISOString(), campaignId, source: "generation", kind: "generation.queued", severity: "info", status: "queued",
          jobId: eventId, generationJobId: eventId, segmentId: null, turnId: null, turnNumber: null, attemptNumber: null, diagnostic: null } }));
    }
    const captureMs = performance.now() - captureStart;
    expect((await pool.query("SELECT count(*) FROM activity_event_outbox WHERE campaign_id=$1", [campaignId])).rows[0].count).toBe(String(samples));
    process.stdout.write(`Activity capture fixture: ${samples} sequential empty transactions=${emptyMs.toFixed(2)}ms; capture transactions=${captureMs.toFixed(2)}ms; delta/sample=${((captureMs-emptyMs)/samples).toFixed(2)}ms. No capacity promise.\n`);
  });
  it("captures replacement cancellation, refuses foreign scope and resets a future same-origin cursor", async () => {
    const campaignId = await campaign(), jobId = await enqueue(campaignId, crypto.randomUUID(), true);
    await command(jobId, "cancel");
    await createPostgresActivityMaintenanceRepository(pool).publishBatch(100);
    const page = await history(campaignId);
    expect(page.events.map(event => event.kind)).toEqual(["generation.cancelled", "generation.queued"]);
    expect((await history(campaignId, `?after=${encodeActivityCursor(campaignId, "after", "999999999999999999")}`)).coverage.resetRequired).toBe(true);
    const foreign = (await pool.query("INSERT INTO users(display_name) VALUES ('Activity foreign owner') RETURNING id")).rows[0].id;
    const world = (await pool.query("INSERT INTO worlds(owner_user_id,title) VALUES ($1,'Foreign activity') RETURNING id", [foreign])).rows[0].id;
    const version = (await pool.query("INSERT INTO world_versions(owner_user_id,world_id,version_number,content) VALUES ($1,$2,1,'{}') RETURNING id", [foreign, world])).rows[0].id;
    const foreignCampaign = (await pool.query("INSERT INTO campaigns(owner_user_id,world_version_id,title) VALUES ($1,$2,'Foreign activity') RETURNING id", [foreign, version])).rows[0].id;
    expect((await app.inject(`/api/v1/campaigns/${foreignCampaign}/activity`)).statusCode).toBe(404);
    const eventId = crypto.randomUUID();
    await withTransaction(pool, client => captureActivity(client, { scope: { ownerUserId: foreign, campaignId: foreignCampaign }, sourceId: eventId, revision: "1",
      draft: { version: 1, eventId, occurredAt: new Date().toISOString(), campaignId: foreignCampaign, source: "generation", kind: "generation.queued", severity: "info", status: "queued",
        jobId: eventId, generationJobId: eventId, segmentId: null, turnId: null, turnNumber: null, attemptNumber: null, diagnostic: null } }));
    await createPostgresActivityMaintenanceRepository(pool).publishBatch(100);
    // Existing owned root constraints require deleting the campaign/world graph before the user.
    await expect(pool.query("DELETE FROM users WHERE id=$1", [foreign])).rejects.toMatchObject({ code: "23503" });
    expect((await pool.query("SELECT count(*) FROM story_activity_events WHERE campaign_id=$1", [foreignCampaign])).rows[0].count).toBe("1");
    await pool.query("DELETE FROM campaigns WHERE id=$1", [foreignCampaign]);
    await pool.query("DELETE FROM world_versions WHERE id=$1", [version]);
    await pool.query("DELETE FROM worlds WHERE id=$1", [world]);
    await pool.query("DELETE FROM users WHERE id=$1", [foreign]);
    for (const table of ["activity_event_outbox", "story_activity_events", "campaign_activity_history"]) {
      expect((await pool.query(`SELECT count(*) FROM ${table} WHERE campaign_id=$1`, [foreignCampaign])).rows[0].count).toBe("0");
    }
    await pool.query("DELETE FROM campaigns WHERE id=$1", [campaignId]);
    for (const table of ["activity_event_outbox", "story_activity_events", "campaign_activity_history"]) {
      expect((await pool.query(`SELECT count(*) FROM ${table} WHERE campaign_id=$1`, [campaignId])).rows[0].count).toBe("0");
    }
  });
});
