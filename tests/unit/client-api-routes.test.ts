import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import {
  apiErrorEnvelopeSchema,
  campaignBranchResponseSchema,
  campaignCreateResponseSchema,
  campaignListResponseSchema,
  campaignRewindResponseSchema,
  campaignRuntimeStateResponseSchema,
  campaignSyncStatusSchema,
  generationActionResponseSchema,
  generationEnqueueResponseSchema,
  generationJobSnapshotSchema,
  generationResultSchema,
  generationStreamSnapshotSchema,
  metaResponseSchema,
  playableCharacterListResponseSchema,
  providerListResponseSchema,
  sessionResponseSchema,
  turnInputClassificationResponseSchema,
  turnListResponseSchema,
  userProfileResponseSchema,
  worldCreateResponseSchema,
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
const BRANCH_ID = "77777777-7777-4777-8777-777777777777";
const CLASSIFICATION_ID = "88888888-8888-4888-8888-888888888888";
const NOW = new Date("2026-08-01T12:00:00.000Z");
const RUNTIME_STATE = {
  continuitySummary: "The observatory is awake.",
  openThreads: ["Read the constellations."],
  canonicalFacts: [],
  scratchpad: "Keep the dome open.",
  trackers: [],
  rpgStats: [],
  eventTriggers: [],
  pendingEventTriggers: []
};
const WORLD_CONTENT = {
  world: {
    title: "Emerald Skies",
    genre: "Fantasy",
    tone: "Mysterious",
    premise: "Stars wake.",
    backgroundStory: "Stars slept.",
    firstAction: "Open the dome.",
    rules: "Stay curious."
  },
  playableCharacters: [{
    id: "observer",
    name: "The Observer",
    characterText: "A patient observer.",
    rpgStats: [],
    defaultTriggers: []
  }],
  eventTriggers: [],
  defaults: { trackers: [] }
};

type MockPoolOptions = {
  malformedJob?: boolean;
  missingJob?: boolean;
  missingSync?: boolean;
  onGenerationJobRead?: () => void;
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
  let userDisplayName = "Initial Owner";
  const query = async (queryInput: unknown, params: unknown[] = []) => {
    const sql = String(queryInput).replaceAll(/\s+/g, " ").trim();
    if (["BEGIN", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT", "ROLLBACK", "SAVEPOINT enqueue_generation_insert"].includes(sql)) return { rows: [] };
    if (sql.startsWith("SELECT id FROM users")) return { rows: [{ id: OWNER_ID }] };
    if (sql.startsWith('SELECT id, system_key AS "systemKey"')) return { rows: [{
      id: OWNER_ID,
      systemKey: "initial-owner",
      displayName: userDisplayName,
      settings: {}
    }] };
    if (sql.startsWith("UPDATE users SET")) {
      userDisplayName = String(params[0]);
      return { rows: [] };
    }
    if (sql.includes("FROM provider_profiles WHERE owner_user_id") && sql.includes("ORDER BY provider_role, name")) return { rows: [{
      id: PROVIDER_ID,
      name: "Route Text Provider",
      provider_type: "lmstudio",
      provider_role: "text",
      base_url: "http://localhost:1234",
      default_model: "route-model",
      context_window_tokens: 32_768,
      max_output_tokens: 4_096,
      temperature: 0.8,
      request_timeout_ms: 300_000,
      configuration: {},
      encrypted_api_key: null,
      credential_nonce: null,
      credential_auth_tag: null,
      credential_key_version: null,
      enabled: true,
      is_default: true,
      health_status: "healthy",
      consecutive_failures: 0,
      last_health_check_at: NOW,
      last_health_error: null,
      created_at: NOW,
      updated_at: NOW
    }] };

    if (sql.startsWith("SELECT c.active_turn_number, cs.scratchpad_private")) return { rows: [{
      active_turn_number: 2,
      scratchpad_private: RUNTIME_STATE.scratchpad,
      trackers: RUNTIME_STATE.trackers,
      rpg_stats: RUNTIME_STATE.rpgStats,
      event_triggers: RUNTIME_STATE.eventTriggers,
      pending_event_triggers: RUNTIME_STATE.pendingEventTriggers,
      initial_state_snapshot: RUNTIME_STATE,
      revision: 1,
      updated_at: NOW
    }] };
    if (sql.startsWith("SELECT id, revision, effective_turn_number, state_snapshot_private")) return { rows: [] };
    if (sql.startsWith("SELECT id, content, source_turn_number") && sql.includes("FROM campaign_canonical_facts")) return { rows: [] };
    if (sql.startsWith("SELECT active_turn_number FROM campaigns") && sql.endsWith("FOR UPDATE")) return { rows: [{ active_turn_number: 2 }] };
    if (sql.startsWith("SELECT revision, scratchpad_private") && sql.includes("FROM campaign_state")) return { rows: [{
      revision: 1,
      scratchpad_private: RUNTIME_STATE.scratchpad,
      trackers: RUNTIME_STATE.trackers,
      rpg_stats: RUNTIME_STATE.rpgStats,
      event_triggers: RUNTIME_STATE.eventTriggers,
      pending_event_triggers: RUNTIME_STATE.pendingEventTriggers,
      initial_state_snapshot: RUNTIME_STATE
    }] };
    if (sql.startsWith("SELECT id FROM generation_jobs") && sql.includes("status IN")) return { rows: [] };
    if (sql.startsWith("SELECT state_snapshot_private FROM turns")) return { rows: [{ state_snapshot_private: RUNTIME_STATE }] };
    if (sql.startsWith("SELECT state_snapshot_private, accepted_at FROM turns")) return { rows: [{
      state_snapshot_private: RUNTIME_STATE,
      accepted_at: NOW
    }] };
    if (sql.startsWith("SELECT turn_control_style, text_provider_profile_id")) return { rows: [{
      turn_control_style: "action_only",
      text_provider_profile_id: null
    }] };
    if (sql.startsWith("SELECT prompt_key, content, campaign_id, updated_at")) return { rows: [] };
    if (sql.startsWith("INSERT INTO turn_input_classifications")) return { rows: [{
      id: CLASSIFICATION_ID,
      expires_at: new Date("2026-08-01T12:05:00.000Z")
    }] };
    if (sql.startsWith("SELECT state_snapshot_private, model_metadata FROM turns")) return { rows: [{
      state_snapshot_private: RUNTIME_STATE,
      model_metadata: { promptProtocolVersion: "v1" }
    }] };
    if (sql.startsWith("SELECT state_snapshot_private FROM campaign_state_edits")) return { rows: [] };
    if (sql.startsWith("SELECT active_turn_number, world_version_id, title")) return { rows: [{
      active_turn_number: 2,
      world_version_id: WORLD_VERSION_ID,
      title: "The Observatory",
      story_length_profile: "standard",
      turn_control_style: "flexible_auto",
      selected_character_id: "observer",
      character_snapshot: { name: "The Observer", characterText: "A patient observer." },
      character_profile: null,
      character_profile_revision: 0,
      legacy_settings: {},
      text_provider_profile_id: null,
      image_provider_profile_id: null
    }] };
    if (sql.startsWith("SELECT default_triggers, initial_state_snapshot FROM campaign_state")) return { rows: [{
      default_triggers: [],
      initial_state_snapshot: RUNTIME_STATE
    }] };
    if (sql.startsWith("INSERT INTO campaigns") && sql.includes("'active'")) return { rows: [{ id: BRANCH_ID }] };
    if (sql.startsWith("SELECT content, world_id, version_number FROM world_versions")) return { rows: [{
      content: WORLD_CONTENT,
      world_id: WORLD_ID,
      version_number: 1
    }] };
    if (sql.startsWith("SELECT content FROM world_versions")) return { rows: [{ content: WORLD_CONTENT }] };
    if (sql.startsWith("SELECT id FROM provider_profiles") && sql.includes("provider_role = 'embedding'")) return { rows: [] };
    if (sql.startsWith("SELECT text_provider_profile_id FROM campaigns")) return { rows: [{ text_provider_profile_id: null }] };
    if (sql.startsWith("SELECT id, is_default FROM provider_profiles")) return { rows: [] };
    if (sql.startsWith("SELECT embedding_enabled, embedding_provider_profile_id") && sql.includes("FROM campaign_memory_configs")) return { rows: [] };
    if (sql.startsWith("SELECT c.id, c.title, c.active_turn_number, c.world_version_id")) return { rows: [{
      id: BRANCH_ID,
      title: "The Grounded Observatory",
      active_turn_number: 0,
      world_version_id: WORLD_VERSION_ID,
      selected_character_id: "observer",
      character_snapshot: { name: "The Observer", characterText: "A patient observer." },
      character_profile: null,
      character_profile_revision: 0,
      world_content: WORLD_CONTENT,
      scratchpad_private: RUNTIME_STATE.scratchpad,
      scratchpad_safe_for_prompt: true,
      trackers: []
    }] };
    if (sql.startsWith("SELECT id, turn_number, action, narration, state_snapshot_private")) return { rows: [] };
    if (sql.startsWith("SELECT id, effective_turn_number, state_snapshot_private") && sql.includes("FROM campaign_state_edits")) return { rows: [] };
    if (sql.startsWith("INSERT INTO campaigns")) return { rows: [{ id: CAMPAIGN_ID }] };
    if (sql.startsWith("INSERT INTO worlds")) return { rows: [{ id: WORLD_ID }] };
    if (sql.startsWith("SELECT w.id, w.title, w.status") && sql.includes('wd.content AS "draftContent"')) return { rows: [{
      id: WORLD_ID,
      title: "Route World",
      status: "draft",
      imageUrl: "",
      draftRevision: 1,
      draftContent: { ...WORLD_CONTENT, world: { ...WORLD_CONTENT.world, title: "Route World" } },
      draftBasedOnWorldVersionId: null,
      createdAt: NOW,
      updatedAt: NOW
    }] };

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
      pendingGenerationId: null,
      recoveryId: JOB_ID,
      recoveryStatus: "completed",
      recoveryOperationKind: "replace_latest",
      recoveryExpectedTurnNumber: 2,
      recoveryAttempts: 1,
      recoveryErrorCode: null,
      recoveryErrorMessage: null,
      recoveryResultTurnId: "99999999-9999-4999-8999-999999999999",
      recoveryReplacementTurnId: TURN_ID
    }] };

    if (sql.includes('AS "historyVersion"') && sql.includes("FROM turns")) return { rows: [{ historyVersion: `1:2:${TURN_ID}` }] };

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
        replacementTurnId: replacement ? TURN_ID : null,
        expectedTurnNumber: 2,
        recoveryMetadata: {}
      }] };
    }

    if (sql.startsWith("SELECT id, campaign_id AS") && sql.includes("partial_output AS")) {
      if (options.missingJob) return { rows: [] };
      generationJobReads += 1;
      options.onGenerationJobRead?.();
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

    if (sql.startsWith("UPDATE generation_jobs SET status = CASE")) return { rows: [{ id: JOB_ID, status: "queued", operation_kind: "append", replacementTurnId: null }] };
    if (sql.startsWith("UPDATE generation_jobs SET status = 'discarded'")) return { rows: [{ id: JOB_ID, status: "discarded", campaignId: CAMPAIGN_ID, operationKind: "append", replacementTurnId: null }] };
    if (sql.startsWith("UPDATE generation_jobs SET status = 'cancelled'")) return { rows: [{ id: JOB_ID, status: "cancelled", campaignId: CAMPAIGN_ID, operationKind: "append", replacementTurnId: null }] };
    if (sql.startsWith("INSERT INTO campaign_state")
        || sql.startsWith("INSERT INTO campaign_illustration_configs")
        || sql.startsWith("INSERT INTO campaign_memory_configs")
        || sql.startsWith("INSERT INTO asset_references")
        || sql.startsWith("INSERT INTO activity_events")
        || sql.startsWith("INSERT INTO chronicle_jobs")
        || sql.startsWith("INSERT INTO world_drafts")) return { rows: [] };
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
      const sync = campaignSyncStatusSchema.parse((await app.inject({ method: "GET", url: `/api/v1/campaigns/${CAMPAIGN_ID}/sync-status` })).json());
      expect(sync.campaign.id).toBe(CAMPAIGN_ID);
      expect(sync.turnWindowMode).toBe("replace");
      expect(sync.turns?.campaignId).toBe(CAMPAIGN_ID);
      expect(sync.turns?.nextCursor).toBeNull();
      expect(sync.generationRecovery).toMatchObject({
        operationKind: "replace_latest",
        replacementTurnId: TURN_ID
      });
      const turns = turnListResponseSchema.parse((await app.inject({ method: "GET", url: `/api/v1/campaigns/${CAMPAIGN_ID}/turns?limit=50` })).json());
      expect(turns.campaignId).toBe(CAMPAIGN_ID);
      expect(turns.turns).toHaveLength(1);
      expect(turns.nextCursor).toBeNull();
      const snapshotResponse = await app.inject({ method: "GET", url: `/api/v1/generation-jobs/${JOB_ID}` });
      expect(generationJobSnapshotSchema.parse(snapshotResponse.json())).toMatchObject({ id: JOB_ID, operationKind: "append", updatedAt: NOW.toISOString() });
      expect(snapshotResponse.json()).not.toHaveProperty("partialOutput");
      expect(generationResultSchema.parse((await app.inject({ method: "GET", url: `/api/v1/generation-jobs/${JOB_ID}/result` })).json()).resultTurnId).toBe(TURN_ID);
    } finally {
      await app.close();
    }
  });

  it("serves metadata without accepting caller identity as application identity", async () => {
    const app = await buildServer({ config: config(storageRoot), pool: mockPool() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/meta",
        headers: {
          "x-correlation-id": "meta-route-correlation",
          "x-user-id": "99999999-9999-4999-8999-999999999999"
        }
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-correlation-id"]).toBe("meta-route-correlation");
      expect(metaResponseSchema.parse(response.json()).application.name).toBe("Infinite Quest Nexus");
      expect(response.body).not.toContain("99999999-9999-4999-8999-999999999999");
    } finally {
      await app.close();
    }
  });

  it("serializes every remaining adopted success route through its shared response schema", async () => {
    const app = await buildServer({ config: config(storageRoot), pool: mockPool() });
    const runtimeStateUpdate = {
      expectedTurnNumber: 2,
      expectedRevision: 1,
      ...RUNTIME_STATE
    };
    try {
      const session = await app.inject({ method: "GET", url: "/api/v1/session" });
      expect(session.statusCode).toBe(200);
      expect(sessionResponseSchema.parse(session.json()).user.id).toBe(OWNER_ID);

      const profile = await app.inject({
        method: "PATCH",
        url: "/api/v1/users/me/profile",
        payload: { displayName: "Route Owner" }
      });
      expect(profile.statusCode).toBe(200);
      expect(userProfileResponseSchema.parse(profile.json()).user.displayName).toBe("Route Owner");

      const providers = await app.inject({ method: "GET", url: "/api/v1/providers" });
      expect(providers.statusCode).toBe(200);
      expect(providerListResponseSchema.parse(providers.json()).providers[0]?.id).toBe(PROVIDER_ID);

      const currentState = await app.inject({ method: "GET", url: `/api/v1/campaigns/${CAMPAIGN_ID}/state?turnNumber=0` });
      expect(currentState.statusCode).toBe(200);
      expect(campaignRuntimeStateResponseSchema.parse(currentState.json())).toMatchObject({
        campaignId: CAMPAIGN_ID,
        viewedTurnNumber: 0
      });

      const updatedState = await app.inject({
        method: "PATCH",
        url: `/api/v1/campaigns/${CAMPAIGN_ID}/state`,
        payload: runtimeStateUpdate
      });
      expect(updatedState.statusCode).toBe(200);
      expect(campaignRuntimeStateResponseSchema.parse(updatedState.json())).toMatchObject({
        campaignId: CAMPAIGN_ID,
        revision: 1
      });

      const classification = await app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${CAMPAIGN_ID}/turn-input/classify`,
        payload: { text: "Open the dome.", preferredFallback: "action" }
      });
      expect(classification.statusCode).toBe(200);
      expect(turnInputClassificationResponseSchema.parse(classification.json())).toMatchObject({
        classification: "action",
        resolvedMode: "action"
      });

      const rewind = await app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${CAMPAIGN_ID}/rewind`,
        payload: { targetTurnNumber: 2, expectedCurrentTurnNumber: 2 }
      });
      expect(rewind.statusCode).toBe(200);
      expect(campaignRewindResponseSchema.parse(rewind.json())).toMatchObject({
        campaignId: CAMPAIGN_ID,
        activeTurnNumber: 2,
        discardedTurnCount: 0
      });

      const branch = await app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${CAMPAIGN_ID}/branch`,
        payload: { targetTurnNumber: 0, expectedCurrentTurnNumber: 2, title: "The Grounded Observatory" }
      });
      expect(branch.statusCode).toBe(201);
      expect(campaignBranchResponseSchema.parse(branch.json())).toMatchObject({
        title: "The Grounded Observatory",
        activeTurnNumber: 0,
        worldVersionId: WORLD_VERSION_ID
      });

      const world = await app.inject({
        method: "POST",
        url: "/api/v1/worlds",
        payload: { title: "Route World" }
      });
      expect(world.statusCode).toBe(201);
      expect(worldCreateResponseSchema.parse(world.json())).toMatchObject({ id: WORLD_ID, status: "draft" });

      const campaign = await app.inject({
        method: "POST",
        url: "/api/v1/campaigns",
        payload: {
          worldVersionId: WORLD_VERSION_ID,
          title: "Route Campaign",
          selectedCharacterId: "observer",
          storyLengthProfile: "standard",
          turnControlStyle: "flexible_auto"
        }
      });
      expect(campaign.statusCode).toBe(201);
      expect(campaignCreateResponseSchema.parse(campaign.json())).toMatchObject({
        id: CAMPAIGN_ID,
        selectedCharacterId: "observer"
      });

      const characters = await app.inject({
        method: "GET",
        url: `/api/v1/world-versions/${WORLD_VERSION_ID}/playable-characters`
      });
      expect(characters.statusCode).toBe(200);
      expect(playableCharacterListResponseSchema.parse(characters.json()).characters).toEqual([{
        id: "observer",
        name: "The Observer",
        rpgStatCount: 0,
        defaultTriggerCount: 0
      }]);
    } finally {
      await app.close();
    }
  });

  it.each([
    ["PATCH", "/api/v1/users/me/profile"],
    ["POST", "/api/v1/worlds"],
    ["POST", "/api/v1/campaigns"],
    ["PATCH", `/api/v1/campaigns/${CAMPAIGN_ID}/state`],
    ["POST", `/api/v1/campaigns/${CAMPAIGN_ID}/turn-input/classify`],
    ["POST", `/api/v1/campaigns/${CAMPAIGN_ID}/rewind`],
    ["POST", `/api/v1/campaigns/${CAMPAIGN_ID}/branch`]
  ] as const)("returns a correlated contract error for malformed %s %s input", async (method, url) => {
    const app = await buildServer({ config: config(storageRoot), pool: mockPool() });
    try {
      const response = await app.inject({
        method,
        url,
        headers: { "x-correlation-id": `invalid-${method.toLowerCase()}` },
        payload: {}
      });
      expect(response.statusCode).toBe(400);
      expect(apiErrorEnvelopeSchema.parse(response.json())).toMatchObject({
        correlationId: `invalid-${method.toLowerCase()}`,
        details: {}
      });
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

  it("does not query a generation job after the stream disconnects during its poll sleep", async () => {
    let generationJobReads = 0;
    const app = await buildServer({
      config: config(storageRoot),
      pool: mockPool({
        streamSnapshots: [{ status: "generating" }],
        onGenerationJobRead: () => { generationJobReads += 1; }
      })
    });

    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      await new Promise<void>((resolve, reject) => {
        const streamRequest = request(`${address}/api/v1/generation-jobs/${JOB_ID}/stream`, (response) => {
          response.once("data", () => {
            response.destroy();
            resolve();
          });
        });
        streamRequest.once("error", reject);
        streamRequest.end();
      });
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(generationJobReads).toBe(1);
    } finally {
      await app.close();
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
