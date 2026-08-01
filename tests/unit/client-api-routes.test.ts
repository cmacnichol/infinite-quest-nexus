import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import {
  apiErrorEnvelopeSchema,
  campaignListResponseSchema,
  campaignSyncStatusSchema,
  generationActionResponseSchema,
  generationEnqueueResponseSchema,
  generationJobSnapshotSchema,
  generationResultSchema,
  generationStreamSnapshotSchema,
  turnListResponseSchema,
  worldListResponseSchema
} from "../../packages/contracts/src/index.js";
import { buildServer } from "../../services/api/src/server.js";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const WORLD_ID = "22222222-2222-4222-8222-222222222222";
const WORLD_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const TURN_ID = "55555555-5555-4555-8555-555555555555";
const PROVIDER_ID = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-08-01T12:00:00.000Z");

type MockPoolOptions = {
  malformedJob?: boolean;
  missingJob?: boolean;
  missingSync?: boolean;
  streamReadFailure?: boolean;
  streamSnapshots?: Array<Record<string, unknown>>;
};

function config(storageRoot: string): RuntimeConfig {
  return {
    role: "all",
    host: "127.0.0.1",
    port: 8080,
    databaseUrl: "postgresql://mock@localhost:5432/mock",
    databaseMaxConnections: 2,
    migrationDirectory: resolve("database/migrations"),
    migrationWaitSeconds: 10,
    allowMaintenanceMigrations: false,
    workerPollIntervalMs: 1000,
    workerLeaseSeconds: 60,
    webRoot: resolve("apps/web/public"),
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
    credentialEncryptionKey: "client-api-route-test-secret",
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

function jobRow(options: MockPoolOptions) {
  const row: Record<string, unknown> = {
    id: JOB_ID,
    campaignId: CAMPAIGN_ID,
    providerProfileId: PROVIDER_ID,
    expectedTurnNumber: 3,
    action: "Open the observatory dome.",
    requestedInputMode: "action",
    resolvedInputMode: "action",
    inputModeSource: "explicit",
    operationKind: "append",
    replacementTurnId: null,
    baseTurnNumber: null,
    status: "completed",
    attempts: 1,
    requestedModel: "test-model",
    providerResponseId: null,
    providerFinishReason: "stop",
    resultTurnId: TURN_ID,
    errorCode: null,
    errorMessage: null,
    recoveryMetadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
    partialOutput: "raw provider payload"
  };
  if (options.malformedJob) delete row.operationKind;
  return row;
}

function mockPool(options: MockPoolOptions = {}): DatabasePool {
  let generationJobReads = 0;
  const query = async (queryInput: unknown, params: unknown[] = []) => {
    const sql = String(queryInput).replaceAll(/\s+/g, " ").trim();
    if (["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT enqueue_generation_insert"].includes(sql)) return { rows: [] };
    if (sql.startsWith("SELECT id FROM users")) return { rows: [{ id: OWNER_ID }] };

    if (sql.startsWith("SELECT w.id, w.title, w.status")) return { rows: [{
      id: WORLD_ID,
      title: "Emerald Skies",
      status: "active",
      imageUrl: "",
      forkedFromWorldId: null,
      forkedFromWorldVersionId: null,
      createdAt: NOW,
      updatedAt: NOW,
      draftRevision: 1,
      draftUpdatedAt: NOW,
      draftPreview: { title: "Emerald Skies", genre: "Fantasy", tone: "Mysterious", premise: "Stars wake.", backgroundStory: "Stars slept.", firstAction: "Open the dome." },
      latestVersionId: WORLD_VERSION_ID,
      latestVersionNumber: 1,
      latestPublishedAt: NOW,
      latestPreview: { title: "Emerald Skies", genre: "Fantasy", tone: "Mysterious", premise: "Stars wake.", backgroundStory: "Stars slept.", firstAction: "Open the dome.", rules: "Stay curious." },
      campaignCount: 1
    }] };

    if (sql.startsWith("SELECT c.id, c.title, c.status")) return { rows: [{
      id: CAMPAIGN_ID,
      title: "The Observatory",
      status: "active",
      activeTurnNumber: 2,
      createdAt: NOW,
      updatedAt: NOW,
      storyLengthProfile: "standard",
      turnControlStyle: "flexible_auto",
      selectedCharacterId: "observer",
      selectedCharacterName: "The Observer",
      worldId: WORLD_ID,
      worldTitle: "Emerald Skies",
      worldVersionId: WORLD_VERSION_ID,
      textProviderProfileId: PROVIDER_ID,
      imageProviderProfileId: null,
      worldVersionNumber: 1,
      latestWorldVersionNumber: 1,
      worldUpdateAvailable: false,
      costInformation: []
    }] };

    if (sql.startsWith("SELECT c.id, c.title, c.active_turn_number")) return { rows: options.missingSync ? [] : [{
      id: CAMPAIGN_ID,
      title: "The Observatory",
      activeTurnNumber: 2,
      worldVersionId: WORLD_VERSION_ID,
      storyLengthProfile: "standard",
      turnControlStyle: "flexible_auto",
      selectedCharacterId: "observer",
      characterSnapshot: { name: "The Observer", characterText: "A patient observer." },
      characterProfile: null,
      characterProfileRevision: 0,
      legacySettings: {},
      status: "active",
      updatedAt: NOW,
      worldId: WORLD_ID,
      worldTitle: "Emerald Skies",
      worldVersionNumber: 1,
      worldContent: { world: { title: "Emerald Skies", genre: "Fantasy", tone: "Mysterious", premise: "Stars wake.", backgroundStory: "Stars slept.", firstAction: "Open the dome.", rules: "Stay curious." }, playableCharacters: [] },
      rpgStats: [],
      eventTriggers: [],
      trackers: [],
      pendingGenerationId: null
    }] };

    if (sql.startsWith("SELECT id, turn_number AS")) return { rows: [{
      id: TURN_ID,
      turnNumber: 2,
      action: "Open the dome.",
      inputMode: "action",
      inputModeSource: "explicit",
      narration: "Emerald light fills the room.",
      choices: ["Look up.", "Step back.", "Call out.", "Close it."],
      customActionSuggestion: "Study the constellations.",
      imagePrompt: "An emerald observatory.",
      imageUrl: null,
      acceptedAt: NOW
    }] };
    if (sql.includes("FROM provider_cost_events") || sql.includes("FROM category_totals")) return { rows: [] };

    if (sql.includes("idempotency_key = $2") && sql.includes("FROM generation_jobs")) {
      const replacement = params[1] === "replace-route-key";
      return { rows: [{
        id: JOB_ID,
        status: replacement ? "replacement_queued" : "queued",
        resultTurnId: null,
        action: replacement ? "Take another route." : "Open the dome.",
        operationKind: replacement ? "replace_latest" : "append",
        expectedTurnNumber: 2,
        recoveryMetadata: {}
      }] };
    }

    if (sql.startsWith("SELECT id, campaign_id AS") && sql.includes("partial_output AS")) {
      if (options.missingJob) return { rows: [] };
      generationJobReads += 1;
      if (options.streamReadFailure && generationJobReads > 1) throw new Error("generation job read failed");
      const snapshot = options.streamSnapshots?.[Math.min(generationJobReads - 1, options.streamSnapshots.length - 1)];
      return { rows: [{ ...jobRow(options), ...snapshot }] };
    }
    if (sql.startsWith("SELECT j.id, j.status")) return { rows: [{
      id: JOB_ID,
      status: "completed",
      campaignId: CAMPAIGN_ID,
      expectedTurnNumber: 3,
      resultTurnId: TURN_ID,
      errorCode: null,
      errorMessage: null,
      turnNumber: 3,
      action: "Open the dome.",
      inputMode: "action",
      inputModeSource: "explicit",
      narration: "Emerald light fills the room.",
      choices: ["Look up.", "Step back.", "Call out.", "Close it."],
      customActionSuggestion: "Study the constellations.",
      imagePrompt: "An emerald observatory.",
      modelMetadata: {},
      mechanics: {},
      acceptedAt: NOW,
      stateSnapshot: {},
      reportedCost: null
    }] };

    if (sql.startsWith("UPDATE generation_jobs SET status = CASE")) return { rows: [{ id: JOB_ID, status: "queued" }] };
    if (sql.startsWith("UPDATE generation_jobs SET status = 'discarded'")) return { rows: [{ id: JOB_ID, status: "discarded", campaignId: CAMPAIGN_ID, operationKind: "append" }] };
    if (sql.startsWith("UPDATE generation_jobs SET status = 'cancelled'")) return { rows: [{ id: JOB_ID, status: "cancelled", campaignId: CAMPAIGN_ID, operationKind: "append" }] };
    if (sql.startsWith("UPDATE") || sql.startsWith("DELETE")) return { rows: [] };

    throw new Error(`Unexpected client API route query: ${sql}`);
  };
  const client = { query, release: () => undefined };
  return {
    query,
    connect: async () => client
  } as unknown as DatabasePool;
}

describe("client API route contracts without PostgreSQL", () => {
  let storageRoot: string;

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "infinitequest-client-api-routes-"));
  });

  afterAll(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it("serializes adopted read routes through their shared response schemas", async () => {
    const app = await buildServer({ config: config(storageRoot), pool: mockPool() });
    try {
      expect(worldListResponseSchema.parse((await app.inject({ method: "GET", url: "/api/v1/worlds" })).json()).worlds).toHaveLength(1);
      expect(campaignListResponseSchema.parse((await app.inject({ method: "GET", url: "/api/v1/campaigns" })).json()).campaigns).toHaveLength(1);
      expect(campaignSyncStatusSchema.parse((await app.inject({ method: "GET", url: `/api/v1/campaigns/${CAMPAIGN_ID}/sync-status` })).json()).campaign.id).toBe(CAMPAIGN_ID);
      expect(turnListResponseSchema.parse((await app.inject({ method: "GET", url: `/api/v1/campaigns/${CAMPAIGN_ID}/turns` })).json()).turns).toHaveLength(1);
      const snapshotResponse = await app.inject({ method: "GET", url: `/api/v1/generation-jobs/${JOB_ID}` });
      expect(generationJobSnapshotSchema.parse(snapshotResponse.json())).toMatchObject({ id: JOB_ID, operationKind: "append", updatedAt: NOW.toISOString() });
      expect(snapshotResponse.json()).not.toHaveProperty("partialOutput");
      expect(generationResultSchema.parse((await app.inject({ method: "GET", url: `/api/v1/generation-jobs/${JOB_ID}/result` })).json()).resultTurnId).toBe(TURN_ID);
    } finally {
      await app.close();
    }
  });

  it("does not emit a lease-only snapshot and closes cleanly on a later read failure", async () => {
    const leaseRenewedAt = new Date("2026-08-01T12:00:05.000Z");
    const completedAt = new Date("2026-08-01T12:00:10.000Z");
    const dedupeApp = await buildServer({
      config: config(storageRoot),
      pool: mockPool({
        streamSnapshots: [
          { status: "generating", updatedAt: NOW },
          { status: "generating", updatedAt: leaseRenewedAt },
          { status: "completed", updatedAt: completedAt }
        ]
      })
    });
    const failureApp = await buildServer({ config: config(storageRoot), pool: mockPool({
      streamSnapshots: [{ status: "generating" }],
      streamReadFailure: true
    }) });

    try {
      const dedupeResponse = await dedupeApp.inject({ method: "GET", url: `/api/v1/generation-jobs/${JOB_ID}/stream` });
      const frames = dedupeResponse.body.trim().split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.replace(/^data: /, "")));
      expect(frames).toHaveLength(2);
      expect(frames.map((frame) => generationStreamSnapshotSchema.parse(frame).status)).toEqual(["generating", "completed"]);
      expect(frames[0]).not.toHaveProperty("updatedAt");

      const failureResponse = await failureApp.inject({ method: "GET", url: `/api/v1/generation-jobs/${JOB_ID}/stream` });
      const failureFrames = failureResponse.body.trim().split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.replace(/^data: /, "")));
      expect(failureResponse.statusCode).toBe(200);
      expect(failureFrames).toHaveLength(1);
      expect(generationStreamSnapshotSchema.parse(failureFrames[0]).status).toBe("generating");
      expect(failureResponse.body).not.toContain('"status":"failed"');
    } finally {
      await Promise.all([dedupeApp.close(), failureApp.close()]);
    }
  });

  it("serializes adopted generation mutation routes through their shared schemas", async () => {
    const app = await buildServer({ config: config(storageRoot), pool: mockPool() });
    try {
      const append = await app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${CAMPAIGN_ID}/generations`,
        payload: { action: "Open the dome.", providerProfileId: PROVIDER_ID, idempotencyKey: "append-route-key" }
      });
      expect(generationEnqueueResponseSchema.parse(append.json())).toMatchObject({ status: "queued", duplicate: true });

      const replacement = await app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${CAMPAIGN_ID}/generations/retry-latest`,
        payload: { action: "Take another route.", expectedCurrentTurnNumber: 2, providerProfileId: PROVIDER_ID, idempotencyKey: "replace-route-key" }
      });
      expect(generationEnqueueResponseSchema.parse(replacement.json())).toMatchObject({ status: "replacement_queued", duplicate: true });

      for (const [path, status] of [["retry", "queued"], ["cancel", "cancelled"], ["discard", "discarded"]] as const) {
        const response = await app.inject({ method: "POST", url: `/api/v1/generation-jobs/${JOB_ID}/${path}` });
        expect(response.statusCode).toBe(path === "discard" ? 200 : 202);
        expect(generationActionResponseSchema.parse(response.json()).status).toBe(status);
      }
    } finally {
      await app.close();
    }
  });

  it("uses structured envelopes for sync 404s, initial SSE failures, and malformed service projections", async () => {
    const missingSyncApp = await buildServer({ config: config(storageRoot), pool: mockPool({ missingSync: true }) });
    const missingJobApp = await buildServer({ config: config(storageRoot), pool: mockPool({ missingJob: true }) });
    const malformedJobApp = await buildServer({ config: config(storageRoot), pool: mockPool({ malformedJob: true }) });
    try {
      const syncResponse = await missingSyncApp.inject({
        method: "GET",
        url: `/api/v1/campaigns/${CAMPAIGN_ID}/sync-status`,
        headers: { "x-correlation-id": "missing-sync-route" }
      });
      expect(syncResponse.statusCode).toBe(404);
      expect(apiErrorEnvelopeSchema.parse(syncResponse.json())).toMatchObject({
        error: "CampaignNotFoundError",
        correlationId: "missing-sync-route",
        details: { code: "campaign_not_found" }
      });

      const streamResponse = await missingJobApp.inject({ method: "GET", url: `/api/v1/generation-jobs/${JOB_ID}/stream` });
      expect(streamResponse.statusCode).toBe(404);
      expect(streamResponse.headers["content-type"]).toContain("application/json");
      expect(apiErrorEnvelopeSchema.parse(streamResponse.json())).toMatchObject({ error: "Error", details: {} });

      const malformedResponse = await malformedJobApp.inject({ method: "GET", url: `/api/v1/generation-jobs/${JOB_ID}` });
      expect(malformedResponse.statusCode).toBe(500);
      expect(apiErrorEnvelopeSchema.parse(malformedResponse.json())).toMatchObject({ error: "Internal server error", details: {} });
    } finally {
      await Promise.all([missingSyncApp.close(), missingJobApp.close(), malformedJobApp.close()]);
    }
  });
});
