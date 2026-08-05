import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { readTurnPage } from "../../packages/database/src/play-loop-read-repository.js";
import { buildServer } from "../../services/api/src/server.js";
import { createApiWorldCampaignApplication } from "../../services/runtime/src/world-campaign-composition.js";
import { serverOptions } from "../helpers/build-server-options.js";
import { createProvider } from "../../services/api/src/provider-service.js";
import { runGenerationJob } from "../helpers/generation-worker-harness.js";
import { runImageJob } from "../../services/runtime/src/illustration-image-job-adapter.js";
import { supportsSecureGeneratedArchiveStaging } from "../../services/api/src/archive-io.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";
import {
  campaignListResponseSchema,
  campaignSyncStatusSchema,
  generationActionResponseSchema,
  generationEnqueueResponseSchema,
  generationJobSnapshotSchema,
  generationResultSchema,
  generationStreamSnapshotSchema,
  turnListResponseSchema
} from "../../packages/contracts/src/client-api.js";
import { worldListResponseSchema } from "../../packages/contracts/src/world-library.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const secureGeneratedStagingIt = supportsSecureGeneratedArchiveStaging() ? it : it.skip;
const credentialSecret = "integration-test-credential-secret";

function makeConfig(databaseUrl: string): RuntimeConfig {
  return {
    role: "all",
    host: "127.0.0.1",
    port: 8080,
    databaseUrl,
    databaseMaxConnections: 5,
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

function validStory(narration = "You step into the Ancient Observatory."): string {
  return JSON.stringify({
    narration,
    choices: ["Examine the telescope.", "Read the star maps.", "Light a torch.", "Leave the observatory."],
    custom_action_suggestion: "Look up at the glass dome.",
    scratchpad: "The observatory dome is cracked and reveals strange emerald constellations.",
    tracker_updates: [{ name: "Observatory Power", value: "Offline" }],
    image_prompt: "Ancient stone observatory with cracked glass dome and emerald starlight.",
    continuity_summary: "Player arrived at the Ancient Observatory and noticed the strange emerald constellations.",
    canonical_facts: ["The Ancient Observatory dome is cracked."],
    superseded_facts: [],
    open_threads: ["Find out how to restore power to the observatory."]
  });
}

integration("gameplay: complete Story Engine & Story Player API integration", () => {
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let mockServer: Server;
  let providerTransport: ReturnType<typeof installIntegrationProviderTransport>;
  let baseUrl = "";
  let textProviderId = "";
  let imageProviderId = "";
  const replies: Array<{ content?: string; b64_json?: string; finishReason?: string }> = [];
  const requests: Array<Record<string, any>> = [];

  async function importCampaign(label: string) {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    const identity = crypto.randomUUID();
    fixture.world.title = `Integration Gameplay ${label} ${identity}`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/imports/legacy-story",
      payload: { sourceName: `gameplay-${label}-${identity}.json`, story: fixture }
    });
    expect(response.statusCode).toBe(201);
    const imported = response.json();
    expect(imported).toMatchObject({
      campaignId: expect.any(String),
      worldVersionId: expect.any(String),
      duplicate: false
    });
    return { ...imported, worldTitle: fixture.world.title };
  }

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 5);
    await migrateDatabase(pool, resolve("database/migrations"));
    providerTransport = installIntegrationProviderTransport();
    const config = makeConfig(databaseUrl!);
    app = await buildServer(serverOptions({
      config,
      pool,
      worldCampaign: createApiWorldCampaignApplication(pool, {
        credentialSecret: config.credentialEncryptionKey
      })
    }));

    mockServer = createServer((req, res) => {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        try {
          if (body) requests.push(JSON.parse(body));
        } catch (_) {}
        const nextReply = replies.shift() || { content: validStory() };
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url?.includes("/images/generations")) {
          res.end(JSON.stringify({
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: nextReply.b64_json || "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }]
          }));
        } else {
          res.end(JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "deterministic-mock",
            choices: [{
              index: 0,
              message: { role: "assistant", content: nextReply.content || validStory() },
              finish_reason: nextReply.finishReason || "stop"
            }],
            usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 }
          }));
        }
      });
    });

    await new Promise<void>((resolveListen) => mockServer.listen(0, "127.0.0.1", resolveListen));
    const address = mockServer.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not expose TCP address.");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const textProvider = await createProvider(pool, {
      name: `Mock Text ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl,
      defaultModel: "deterministic-mock",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret);
    textProviderId = textProvider.id;

    const imageProvider = await createProvider(pool, {
      name: `Mock Image ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "image",
      baseUrl,
      defaultModel: "dall-e-3",
      contextWindowTokens: 4096,
      maxOutputTokens: 1024,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret);
    imageProviderId = imageProvider.id;
  });

  afterAll(async () => {
    if (mockServer) await new Promise<void>((resolveClose, reject) => mockServer.close(error => error ? reject(error) : resolveClose()));
    if (providerTransport) await providerTransport.close();
    await pool.end();
  });

  beforeEach(() => {
    replies.length = 0;
    requests.length = 0;
  });

  it("orchestrates end-to-end Story Player turn submission, worker execution, and turn retrieval", async () => {
    // 1. Import a baseline campaign
    const { campaignId, worldVersionId, worldTitle } = await importCampaign("story-player");

    // 2. Fetch campaign initial state as story.js does on load
    const campaignResponse = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/sync-status`
    });
    expect(campaignResponse.statusCode).toBe(200);
    const campaignData = campaignSyncStatusSchema.parse(campaignResponse.json());
    expect(campaignData.campaign).toMatchObject({ id: campaignId, worldVersionId });
    expect(campaignData.world).toMatchObject({ title: worldTitle });
    expect(campaignData.playerConfig).toMatchObject({
      useRpgStats: false,
      suppressEventTriggers: false,
      rpgStats: [],
      eventTriggers: []
    });

    const turnsResponse = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/turns`
    });
    expect(turnsResponse.statusCode).toBe(200);
    const initialTurns = turnListResponseSchema.parse(turnsResponse.json()).turns;
    expect(initialTurns.length).toBeGreaterThan(0);
    expect(initialTurns.every((turn: { inputMode?: string }) => turn.inputMode === "action")).toBe(true);

    // 3. Submit action via POST /api/v1/campaigns/:campaignId/generations
    replies.push({ content: validStory("You step into the Ancient Observatory and hear a hum.") });
    const genResponse = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/generations`,
      payload: {
        action: "Examine the telescope.",
        providerProfileId: textProviderId,
        idempotencyKey: crypto.randomUUID(),
        context: { budgetTokens: 16000, compression: "auto", recentTurns: 10 }
      }
    });
    expect(genResponse.statusCode).toBe(202);
    const job = generationEnqueueResponseSchema.parse(genResponse.json());
    expect(job.id).toBeDefined();
    expect(job.status).toBe("queued");

    // 4. Simulate worker executing the generation job
    const workerRan = await runGenerationJob(pool, "worker-gameplay-1", 30, credentialSecret);
    expect(workerRan).toBe(true);

    // 5. Poll generation status via API
    const pollResponse = await app.inject({
      method: "GET",
      url: `/api/v1/generation-jobs/${job.id}`
    });
    expect(pollResponse.statusCode).toBe(200);
    const snapshot = generationJobSnapshotSchema.parse(pollResponse.json());
    expect(snapshot.status).toBe("completed");
    expect(pollResponse.json()).not.toHaveProperty("partialOutput");

    const resultResponse = await app.inject({
      method: "GET",
      url: `/api/v1/generation-jobs/${job.id}/result`
    });
    expect(resultResponse.statusCode).toBe(200);
    expect(generationResultSchema.parse(resultResponse.json())).toMatchObject({
      id: job.id,
      campaignId,
      status: "completed"
    });

    // 6. Verify that the turn list now contains the generated turn with structured choices and trackers
    const turnsResponseAfter = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/turns`
    });
    expect(turnsResponseAfter.statusCode).toBe(200);
    const turnsAfter = turnListResponseSchema.parse(turnsResponseAfter.json()).turns;
    const latestTurn = turnsAfter[turnsAfter.length - 1];
    if (!latestTurn) throw new Error("Expected the completed generation to append a turn.");
    expect(latestTurn.narration).toContain("Ancient Observatory");
    expect(latestTurn.choices).toContain("Examine the telescope.");
    expect(latestTurn).toMatchObject({ inputMode: "action", inputModeSource: "explicit" });

    const campaignList = await app.inject({ method: "GET", url: "/api/v1/campaigns" });
    expect(campaignList.statusCode).toBe(200);
    expect(campaignListResponseSchema.parse(campaignList.json()).campaigns).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: campaignId })])
    );

    const worldList = await app.inject({ method: "GET", url: "/api/v1/worlds" });
    expect(worldList.statusCode).toBe(200);
    expect(worldListResponseSchema.parse(worldList.json()).worlds).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: campaignData.world.id })])
    );
  });

  it("runs append, replacement, recovery, retry, cancel, discard, and sync through the Fastify generation routes", async () => {
    const { campaignId } = await importCampaign("generation-route-cutover");
    const append = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/generations`,
      payload: {
        action: "Open the observatory dome.",
        providerProfileId: textProviderId,
        idempotencyKey: crypto.randomUUID(),
        context: { budgetTokens: 16000, compression: "auto", recentTurns: 10 }
      }
    });
    expect(append.statusCode).toBe(202);
    const appendJob = generationEnqueueResponseSchema.parse(append.json());
    expect(appendJob).toMatchObject({ operationKind: "append", status: "queued" });

    replies.push({ content: validStory("The dome opens over a recovered constellation.") });
    expect(await runGenerationJob(pool, "worker-generation-route-cutover", 30, credentialSecret)).toBe(true);
    const recovered = await app.inject({ method: "GET", url: `/api/v1/generation-jobs/${appendJob.id}/result` });
    expect(recovered.statusCode).toBe(200);
    expect(generationResultSchema.parse(recovered.json())).toMatchObject({ id: appendJob.id, campaignId, status: "completed" });

    const replacement = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/generations/retry-latest`,
      payload: {
        action: "Choose another path beneath the dome.",
        expectedCurrentTurnNumber: 3,
        providerProfileId: textProviderId,
        idempotencyKey: crypto.randomUUID(),
        context: { budgetTokens: 16000, compression: "auto", recentTurns: 10 }
      }
    });
    expect(replacement.statusCode).toBe(202);
    const replacementJob = generationEnqueueResponseSchema.parse(replacement.json());
    expect(replacementJob).toMatchObject({ operationKind: "replace_latest", status: "replacement_queued" });

    await pool.query(
      "UPDATE generation_jobs SET status = 'recoverable', error_code = 'provider_transport_error', error_message = 'synthetic retry fixture' WHERE id = $1",
      [replacementJob.id]
    );
    const retried = await app.inject({ method: "POST", url: `/api/v1/generation-jobs/${replacementJob.id}/retry` });
    expect(retried.statusCode).toBe(202);
    expect(generationActionResponseSchema.parse(retried.json())).toMatchObject({ id: replacementJob.id, status: "replacement_queued", operationKind: "replace_latest" });
    const cancelled = await app.inject({ method: "POST", url: `/api/v1/generation-jobs/${replacementJob.id}/cancel` });
    expect(cancelled.statusCode).toBe(202);
    expect(generationActionResponseSchema.parse(cancelled.json())).toMatchObject({ id: replacementJob.id, status: "cancelled" });

    const discardCandidate = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/generations`,
      payload: {
        action: "Leave the dome unopened.",
        providerProfileId: textProviderId,
        idempotencyKey: crypto.randomUUID(),
        context: { budgetTokens: 16000, compression: "auto", recentTurns: 10 }
      }
    });
    expect(discardCandidate.statusCode).toBe(202);
    const discardJob = generationEnqueueResponseSchema.parse(discardCandidate.json());
    await pool.query(
      "UPDATE generation_jobs SET status = 'recoverable', error_code = 'provider_transport_error', error_message = 'synthetic discard fixture' WHERE id = $1",
      [discardJob.id]
    );
    const discarded = await app.inject({ method: "POST", url: `/api/v1/generation-jobs/${discardJob.id}/discard` });
    expect(discarded.statusCode).toBe(200);
    expect(generationActionResponseSchema.parse(discarded.json())).toMatchObject({ id: discardJob.id, status: "discarded" });

    const sync = await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/sync-status` });
    expect(sync.statusCode).toBe(200);
    expect(campaignSyncStatusSchema.parse(sync.json())).toMatchObject({ campaign: { id: campaignId }, pendingGeneration: null });
  });

  it("paginates a real campaign history safely across replacement, rewind, and unchanged sync", async () => {
    const { campaignId } = await importCampaign("bounded-history");
    const owner = await pool.query<{ id: string }>("SELECT id FROM users WHERE system_key = 'initial-owner'");
    const ownerUserId = owner.rows[0]?.id;
    if (!ownerUserId) throw new Error("Expected the initial owner.");
    await pool.query("DELETE FROM turns WHERE campaign_id = $1", [campaignId]);
    await pool.query(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration)
       SELECT $1, $2, turn_number, 'Action ' || turn_number, 'Narration ' || turn_number
       FROM generate_series(1, 55) AS turn_number`,
      [ownerUserId, campaignId]
    );
    await pool.query("UPDATE campaigns SET active_turn_number = 55 WHERE id = $1", [campaignId]);
    const firstTurn = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE campaign_id = $1 AND turn_number = 1",
      [campaignId]
    );
    const replacementTurnId = firstTurn.rows[0]?.id;
    if (!replacementTurnId) throw new Error("Expected the turn selected for replacement.");
    const completedRecovery = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key, expected_turn_number,
         action, operation_kind, replacement_turn_id, status
       ) VALUES ($1, $2, $3, $4, 1, 'Recovered replacement turn.', 'replace_latest', $5, 'completed')
       RETURNING id`,
      [ownerUserId, campaignId, textProviderId, crypto.randomUUID(), replacementTurnId]
    );
    const completedRecoveryId = completedRecovery.rows[0]?.id;
    if (!completedRecoveryId) throw new Error("Expected a completed recovery job.");
    await pool.query("DELETE FROM turns WHERE id = $1", [replacementTurnId]);
    const replacementResult = await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration)
       VALUES ($1, $2, 1, 'Recovered replacement action.', 'Recovered replacement narration.')
       RETURNING id`,
      [ownerUserId, campaignId]
    );
    const replacementResultTurnId = replacementResult.rows[0]?.id;
    if (!replacementResultTurnId) throw new Error("Expected the recovered replacement result turn.");
    await pool.query(
      "UPDATE generation_jobs SET result_turn_id = $1, completed_at = now() WHERE id = $2",
      [replacementResultTurnId, completedRecoveryId]
    );

    const firstResponse = await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/turns?limit=25` });
    expect(firstResponse.statusCode).toBe(200);
    const first = turnListResponseSchema.parse(firstResponse.json());
    expect(first.campaignId).toBe(campaignId);
    expect(first.turns.map((turn) => turn.turnNumber)).toEqual(Array.from({ length: 25 }, (_, index) => index + 31));
    expect(first.nextCursor).toEqual(expect.any(String));
    const middleResponse = await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/turns?limit=25&before=${encodeURIComponent(first.nextCursor || "")}` });
    expect(middleResponse.statusCode).toBe(200);
    const middle = turnListResponseSchema.parse(middleResponse.json());
    expect(middle.campaignId).toBe(campaignId);
    expect(middle.turns.map((turn) => turn.turnNumber)).toEqual(Array.from({ length: 25 }, (_, index) => index + 6));
    const lastResponse = await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/turns?limit=25&before=${encodeURIComponent(middle.nextCursor || "")}` });
    expect(lastResponse.statusCode).toBe(200);
    const last = turnListResponseSchema.parse(lastResponse.json());
    expect(last.campaignId).toBe(campaignId);
    expect(last.turns.map((turn) => turn.turnNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(last.nextCursor).toBeNull();
    expect([...last.turns, ...middle.turns, ...first.turns].map((turn) => turn.turnNumber)).toEqual(Array.from({ length: 55 }, (_, index) => index + 1));

    expect((await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/turns?before=malformed` })).statusCode).toBe(400);
    const otherCampaign = await importCampaign("bounded-history-other");
    expect((await app.inject({ method: "GET", url: `/api/v1/campaigns/${otherCampaign.campaignId}/turns?before=${encodeURIComponent(first.nextCursor || "")}` })).statusCode).toBe(400);
    const otherPageResponse = await app.inject({ method: "GET", url: `/api/v1/campaigns/${otherCampaign.campaignId}/turns` });
    expect(turnListResponseSchema.parse(otherPageResponse.json()).campaignId).toBe(otherCampaign.campaignId);

    const emptyCampaign = await importCampaign("bounded-history-empty");
    await pool.query("DELETE FROM turns WHERE campaign_id = $1", [emptyCampaign.campaignId]);
    const emptyPageResponse = await app.inject({ method: "GET", url: `/api/v1/campaigns/${emptyCampaign.campaignId}/turns?limit=25` });
    expect(emptyPageResponse.statusCode).toBe(200);
    expect(turnListResponseSchema.parse(emptyPageResponse.json())).toEqual({ campaignId: emptyCampaign.campaignId, turns: [], nextCursor: null });

    const initialSyncResponse = await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/sync-status` });
    expect(initialSyncResponse.statusCode).toBe(200);
    const initialSync = campaignSyncStatusSchema.parse(initialSyncResponse.json());
    expect(initialSync.turnWindowMode).toBe("replace");
    expect(initialSync.turns?.turns).toHaveLength(50);
    expect(initialSync.generationRecovery).toMatchObject({
      id: completedRecoveryId,
      status: "completed",
      operationKind: "replace_latest",
      replacementTurnId,
      resultTurnId: replacementResultTurnId
    });
    const unchangedSyncResponse = await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/sync-status?since=${initialSync.syncToken}` });
    expect(unchangedSyncResponse.statusCode).toBe(200);
    const unchangedSync = campaignSyncStatusSchema.parse(unchangedSyncResponse.json());
    expect(unchangedSync).toMatchObject({ turnWindowMode: "unchanged", turns: null, campaign: { id: campaignId } });
    const initialPayloadBytes = Buffer.byteLength(initialSyncResponse.body);
    const unchangedPayloadBytes = Buffer.byteLength(unchangedSyncResponse.body);
    // Measured against this deterministic 55-turn fixture: 18,002 B initial and 3,109 B unchanged.
    expect({ initialPayloadBytes, unchangedPayloadBytes }).toEqual({ initialPayloadBytes: 18_002, unchangedPayloadBytes: 3_109 });
    expect(unchangedPayloadBytes).toBeLessThan(initialPayloadBytes);

    replies.push({ content: validStory("A replacement changes the current history boundary.") });
    const replacement = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/generations/retry-latest`,
      payload: {
        action: "Replace the current ending.",
        expectedCurrentTurnNumber: 55,
        providerProfileId: textProviderId,
        idempotencyKey: crypto.randomUUID(),
        context: { budgetTokens: 16000, compression: "auto", recentTurns: 10 }
      }
    });
    expect(replacement.statusCode).toBe(202);
    expect(await runGenerationJob(pool, "worker-bounded-history-replacement", 30, credentialSecret)).toBe(true);
    expect((await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/turns?before=${encodeURIComponent(first.nextCursor || "")}` })).statusCode).toBe(409);

    const postReplacementResponse = await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/turns?limit=25` });
    expect(postReplacementResponse.statusCode).toBe(200);
    const postReplacement = turnListResponseSchema.parse(postReplacementResponse.json());
    expect((await app.inject({ method: "POST", url: `/api/v1/campaigns/${campaignId}/rewind`, payload: { targetTurnNumber: 54 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/turns?before=${encodeURIComponent(postReplacement.nextCursor || "")}` })).statusCode).toBe(409);
  });

  it("returns a page and cursor from one PostgreSQL history snapshot during a concurrent replacement", async () => {
    const { campaignId } = await importCampaign("cursor-snapshot");
    const owner = await pool.query<{ id: string }>("SELECT id FROM users WHERE system_key = 'initial-owner'");
    const ownerUserId = owner.rows[0]?.id;
    if (!ownerUserId) throw new Error("Expected the initial owner.");
    await pool.query("DELETE FROM turns WHERE campaign_id = $1", [campaignId]);
    await pool.query(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration)
       VALUES ($1, $2, 1, 'First action', 'First narration'),
              ($1, $2, 2, 'Original latest action', 'Original latest narration')`,
      [ownerUserId, campaignId]
    );
    const latest = await pool.query<{ id: string }>("SELECT id FROM turns WHERE campaign_id = $1 AND turn_number = 2", [campaignId]);
    const originalLatestId = latest.rows[0]?.id;
    if (!originalLatestId) throw new Error("Expected the original latest turn.");

    let replacementCommitted = false;
    async function queryWithConcurrentReplacement(target: Pick<DatabasePool, "query">, query: unknown, values?: unknown[]) {
      const result = await target.query(query as string, values);
      if (!replacementCommitted && String(query).includes('AS "historyVersion"')) {
        replacementCommitted = true;
        await pool.query("DELETE FROM turns WHERE id = $1", [originalLatestId]);
        await pool.query(
          `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration)
           VALUES ($1, $2, 2, 'Replacement latest action', 'Replacement latest narration')`,
          [ownerUserId, campaignId]
        );
      }
      return result;
    }
    const racingPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (query: unknown, values?: unknown[]) => queryWithConcurrentReplacement(client, query, values),
          release: () => client.release()
        };
      },
      query: (query: unknown, values?: unknown[]) => queryWithConcurrentReplacement(pool, query, values)
    } as unknown as DatabasePool;

    const page = await readTurnPage(racingPool, ownerUserId, campaignId, undefined, 1);

    expect(replacementCommitted).toBe(true);
    expect(page.turns.map((turn) => turn.id)).toEqual([originalLatestId]);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it("exposes and idempotently resumes a staged latest-turn replacement through sync-status", async () => {
    const { campaignId } = await importCampaign("retry-latest");
    const beforeResponse = await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/turns` });
    const beforeTurns = beforeResponse.json().turns;
    const originalLatest = beforeTurns.at(-1);
    const payload = {
      action: "Choose a different route through the observatory.",
      expectedCurrentTurnNumber: beforeTurns.length,
      providerProfileId: textProviderId,
      idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16000, compression: "auto", recentTurns: 10 }
    };

    const queued = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/generations/retry-latest`,
      payload
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ operationKind: "replace_latest" });

    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/generations/retry-latest`,
      payload
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: queued.json().id, duplicate: true });

    const pending = await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/sync-status` });
    expect(pending.json().pendingGeneration).toMatchObject({
      id: queued.json().id,
      operationKind: "replace_latest",
      replacementTurnId: originalLatest.id,
      action: payload.action,
      expectedTurnNumber: beforeTurns.length
    });
    const preserved = await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/turns` });
    expect(preserved.json().turns.at(-1)).toMatchObject({ id: originalLatest.id, narration: originalLatest.narration });

    replies.push({ content: validStory("A different route now leads beneath the Ancient Observatory.") });
    expect(await runGenerationJob(pool, "worker-gameplay-replacement", 30, credentialSecret)).toBe(true);
    const completedStatus = await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/sync-status` });
    expect(completedStatus.json().pendingGeneration).toBeNull();
    const replaced = await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/turns` });
    expect(replaced.json().turns.at(-1)).toMatchObject({ action: payload.action });
    expect(replaced.json().turns.at(-1).id).not.toBe(originalLatest.id);
  });

  it("synchronizes RPG and event-trigger config via PUT /api/v1/campaigns/:id/player-config", async () => {
    const { campaignId } = await importCampaign("player-config");
    const rpgStats = [
      { id: "artifact-attunement", name: "Artifact Attunement", value: 17, note: "Synthetic gameplay stat." }
    ];
    const eventTriggers = [
      {
        id: "artifact-charged",
        label: "Artifact charged",
        timing: "after",
        condition: "The artifact absorbs energy.",
        effect: "The artifact begins to glow.",
        addTextAfter: true,
        triggeredCount: 0,
        lastTriggeredTurn: null,
        lastTriggeredAt: null
      }
    ];
    const pendingEventTriggers = [
      {
        id: "pending-artifact",
        sourceTriggerId: "artifact-charged",
        name: "Describe the glow",
        timing: "after",
        condition: "The artifact is charged.",
        effect: "Its light reveals a hidden inscription.",
        instructions: "Describe the newly visible inscription.",
        reason: "Deferred synthetic event.",
        sourceTurn: 2
      }
    ];

    const configUpdate = await app.inject({
      method: "PUT",
      url: `/api/v1/campaigns/${campaignId}/player-config`,
      payload: {
        expectedTurnNumber: 2,
        useRpgStats: true,
        suppressEventTriggers: true,
        rpgStats,
        eventTriggers,
        pendingEventTriggers
      }
    });
    expect(configUpdate.statusCode).toBe(200);
    expect(configUpdate.json()).toMatchObject({
      campaignId,
      activeTurnNumber: 2,
      synchronized: true
    });

    const campaignResponse = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/sync-status`
    });
    expect(campaignResponse.statusCode).toBe(200);
    expect(campaignResponse.json().playerConfig).toMatchObject({
      useRpgStats: true,
      suppressEventTriggers: true,
      rpgStats,
      eventTriggers
    });
    const state = await pool.query<{ pending_event_triggers: unknown }>(
      "SELECT pending_event_triggers FROM campaign_state WHERE campaign_id = $1",
      [campaignId]
    );
    expect(state.rows[0]?.pending_event_triggers).toEqual(pendingEventTriggers);
  });

  it("handles campaign rewind via POST /api/v1/campaigns/:id/rewind", async () => {
    const { campaignId } = await importCampaign("rewind");

    // Rewind back to turn 1
    const rewindResponse = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/rewind`,
      payload: { targetTurnNumber: 1 }
    });
    expect(rewindResponse.statusCode).toBe(200);

    const turnsResponse = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/turns`
    });
    const turns = turnsResponse.json().turns;
    expect(turns.length).toBe(1);
    expect(turns[0].turnNumber).toBe(1);
  });

  secureGeneratedStagingIt("[secure generated staging] exports the portable campaign ZIP format via GET /api/v1/campaigns/:id/export", async () => {
    const { campaignId, worldTitle } = await importCampaign("export");

    const jsonExport = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/export`
    });

    if (jsonExport.statusCode !== 200) {
        throw new Error("Export failed: " + jsonExport.payload);
    }

    expect(jsonExport.headers["content-type"]).toContain("application/zip");
    expect(jsonExport.headers["content-disposition"]).toBe('attachment; filename="infinite-quest-campaign.zip"');

    // Fastify inject returns a stream buffer for archiver which JSZip can struggle to parse.
    // Ensure the stream is zipped.
    expect(jsonExport.payload.startsWith("PK")).toBe(true);
  });
});
