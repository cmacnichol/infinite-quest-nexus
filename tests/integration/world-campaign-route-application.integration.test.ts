import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorldCampaignApplication } from "../../packages/application/src/world-campaign/index.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { buildServer, type BuildServerOptions } from "../../services/api/src/server.js";
import { serverOptions, testWorldCampaignApplication } from "../helpers/build-server-options.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;
const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const WORLD_ID = "22222222-2222-4222-8222-222222222222";
const WORLD_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const WORLD_CONTENT = {
  world: {
    title: "Route World",
    genre: "Test",
    tone: "Measured",
    premise: "Exercise every route boundary.",
    backgroundStory: "A portable parity fixture.",
    firstAction: "Begin the route audit.",
    rules: "Keep authority server-side."
  },
  playableCharacters: [{
    id: "route-explorer",
    name: "Route Explorer",
    characterText: "An explorer of application boundaries.",
    rpgStats: [],
    defaultTriggers: []
  }],
  eventTriggers: [],
  defaults: { trackers: [] }
};
const RUNTIME_STATE = {
  continuitySummary: "The route audit is active.",
  openThreads: ["Complete the parity matrix."],
  canonicalFacts: [],
  scratchpad: "",
  trackers: [],
  rpgStats: [],
  eventTriggers: [],
  pendingEventTriggers: []
};

function runtimeConfig(): RuntimeConfig {
  return {
    role: "api",
    host: "127.0.0.1",
    port: 8080,
    databaseUrl: databaseUrl!,
    databaseMaxConnections: 4,
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
    credentialEncryptionKey: "world-campaign-route-test-key",
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

integration("world campaign Fastify application cutover", () => {
  let pool: DatabasePool;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("routes dashboard reads through the injected application with server-resolved authority", async () => {
    const expectedOwnerUserId = await initialOwnerId(pool);
    const scopes: unknown[] = [];
    const dashboard = {
      worlds: { available: 101, total: 102, published: 103, drafts: 104, archived: 105 },
      campaigns: { open: 106, total: 107, archived: 108 },
      turns: { accepted: 109 },
      providerCosts: { hasReportedCosts: false, totals: [] }
    };
    const worldCampaign = {
      async getDashboard(scope: unknown) {
        scopes.push(scope);
        return dashboard;
      }
    } as unknown as WorldCampaignApplication;
    const options = Object.assign(serverOptions({ config: runtimeConfig(), pool }), {
      worldCampaign
    }) as BuildServerOptions;
    const app = await buildServer(options);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/stats",
        headers: { "x-user-id": crypto.randomUUID() }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(dashboard);
      expect(scopes).toEqual([{ ownerUserId: expectedOwnerUserId }]);
    } finally {
      await app.close();
    }
  });

  it("routes every session and profile alias through the injected owner-scoped application", async () => {
    const expectedOwnerUserId = await initialOwnerId(pool);
    const calls: Array<{ operation: string; scope: unknown; request?: unknown }> = [];
    const profile = {
      id: expectedOwnerUserId,
      systemKey: "initial-owner",
      displayName: "Route Owner",
      settings: {
        autoSubmitTurnChoices: true,
        continuousReading: false,
        defaultTurnControlStyle: "flexible_auto" as const
      }
    };
    const worldCampaign = testWorldCampaignApplication({
      async getSessionProfile(scope) {
        calls.push({ operation: "read", scope });
        return profile;
      },
      async updateSessionProfile(scope, request) {
        calls.push({ operation: "update", scope, request });
        return {
          ...profile,
          displayName: request.displayName ?? profile.displayName,
          settings: request.settings ?? profile.settings
        };
      }
    });
    const app = await buildServer(Object.assign(serverOptions({ config: runtimeConfig(), pool }), {
      worldCampaign
    }) as BuildServerOptions);
    const spoofedHeaders = { "x-user-id": crypto.randomUUID() };
    const update = {
      displayName: "Updated Route Owner",
      settings: {
        autoSubmitTurnChoices: false,
        continuousReading: true,
        defaultTurnControlStyle: "flexible_action" as const
      }
    };

    try {
      const requests = [
        { method: "GET", url: "/api/v1/session" },
        { method: "GET", url: "/api/v1/users/me" },
        { method: "GET", url: "/api/v1/user/profile" },
        { method: "PATCH", url: "/api/v1/users/me/profile", payload: update },
        { method: "PUT", url: "/api/v1/users/me/profile", payload: update },
        { method: "PATCH", url: "/api/v1/user/profile", payload: update },
        { method: "PUT", url: "/api/v1/user/profile", payload: update }
      ] as const;
      const responses = [];
      for (const request of requests) {
        responses.push(await app.inject({ ...request, headers: spoofedHeaders }));
      }

      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(responses[0]?.json()).toEqual({ user: profile, authentication: "deferred" });
      expect(responses.slice(1, 3).map((response) => response.json())).toEqual([
        { user: profile },
        { user: profile }
      ]);
      expect(responses.slice(3).every((response) => response.json().user.displayName === update.displayName)).toBe(true);
      expect(calls.map(({ operation }) => operation)).toEqual([
        "read", "read", "read", "update", "update", "update", "update"
      ]);
      expect(calls.every(({ scope }) => (
        JSON.stringify(scope) === JSON.stringify({ ownerUserId: expectedOwnerUserId })
      ))).toBe(true);
      expect(calls.filter(({ operation }) => operation === "update").every(({ request }) => (
        JSON.stringify(request) === JSON.stringify(update)
      ))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("routes the complete world lifecycle, generation, and progress family through the application", async () => {
    const operations: string[] = [];
    const base = testWorldCampaignApplication();
    const record = <T extends unknown[], R>(name: string, operation: (...args: T) => Promise<R>) => async (...args: T) => {
      operations.push(name);
      return operation(...args);
    };
    const empty = async () => ({} as never);
    const worldCampaign = testWorldCampaignApplication({
      listWorlds: record("listWorlds", base.listWorlds.bind(base)),
      createWorld: record("createWorld", base.createWorld.bind(base)),
      generateWorldPreview: record("generateWorldPreview", empty),
      deleteExpiredWorldGenerationProgress: record("deleteExpiredWorldGenerationProgress", base.deleteExpiredWorldGenerationProgress.bind(base)),
      getWorldGenerationProgress: record("getWorldGenerationProgress", base.getWorldGenerationProgress.bind(base)),
      generatePlayableCharacterPreview: record("generatePlayableCharacterPreview", empty),
      getWorld: record("getWorld", empty),
      updateWorldDraft: record("updateWorldDraft", empty),
      generatePlayableCharacter: record("generatePlayableCharacter", empty),
      organizeWorldCharacterProfile: record("organizeWorldCharacterProfile", empty),
      publishWorld: record("publishWorld", empty),
      updateWorldStatus: record("updateWorldStatus", empty),
      deleteWorld: record("deleteWorld", async () => undefined),
      deleteWorldVersion: record("deleteWorldVersion", async () => undefined),
      forkWorld: record("forkWorld", empty),
      exportWorld: record("exportWorld", async () => ({
        format: "infinite-quest-world" as const,
        formatVersion: 1 as const,
        title: "Route World",
        content: WORLD_CONTENT as never
      }))
    });
    const app = await buildServer(Object.assign(serverOptions({ config: runtimeConfig(), pool }), { worldCampaign }) as BuildServerOptions);
    const requests = [
      { method: "GET", url: "/api/v1/worlds" },
      { method: "POST", url: "/api/v1/worlds", payload: { title: "Route World" } },
      { method: "POST", url: "/api/v1/worlds/generate-preview", payload: { prompt: "Generate a route world." } },
      { method: "GET", url: "/api/v1/worlds/generate-progress?key=route-progress" },
      { method: "POST", url: "/api/v1/worlds/playable-characters/generate-preview", payload: { content: WORLD_CONTENT, prompt: "Generate a route explorer." } },
      { method: "GET", url: `/api/v1/worlds/${WORLD_ID}` },
      { method: "PUT", url: `/api/v1/worlds/${WORLD_ID}/draft`, payload: { expectedRevision: 1, title: "Route World", content: WORLD_CONTENT } },
      { method: "POST", url: `/api/v1/worlds/${WORLD_ID}/draft/playable-characters/generate`, payload: { expectedRevision: 1, prompt: "Generate a route explorer." } },
      { method: "POST", url: `/api/v1/worlds/${WORLD_ID}/draft/playable-characters/organize`, payload: { expectedRevision: 1, character: WORLD_CONTENT.playableCharacters[0] } },
      { method: "POST", url: `/api/v1/worlds/${WORLD_ID}/publish`, payload: { expectedRevision: 1, releaseNotes: "Route parity." } },
      { method: "PATCH", url: `/api/v1/worlds/${WORLD_ID}`, payload: { status: "archived" } },
      { method: "DELETE", url: `/api/v1/worlds/${WORLD_ID}`, payload: { confirmation: "DELETE", expectedTitle: "Route World" } },
      { method: "DELETE", url: `/api/v1/worlds/${WORLD_ID}/versions/${WORLD_VERSION_ID}`, payload: { confirmation: "DELETE", expectedVersionNumber: 1 } },
      { method: "POST", url: `/api/v1/worlds/${WORLD_ID}/fork`, payload: { title: "Forked Route World", sourceWorldVersionId: WORLD_VERSION_ID } },
      { method: "GET", url: `/api/v1/worlds/${WORLD_ID}/export?worldVersionId=${WORLD_VERSION_ID}` }
    ];

    try {
      const responses = [];
      for (const request of requests) responses.push(await app.inject(request as never));
      expect(responses.every((response) => response.statusCode >= 200 && response.statusCode < 300)).toBe(true);
      expect(operations).toEqual([
        "listWorlds", "createWorld", "generateWorldPreview",
        "deleteExpiredWorldGenerationProgress", "getWorldGenerationProgress",
        "generatePlayableCharacterPreview", "getWorld", "updateWorldDraft",
        "generatePlayableCharacter", "organizeWorldCharacterProfile", "publishWorld",
        "updateWorldStatus", "deleteWorld", "deleteWorldVersion", "forkWorld", "exportWorld"
      ]);
    } finally {
      await app.close();
    }
  });

  it("routes campaign lifecycle and playable-character lookup through the application", async () => {
    const operations: string[] = [];
    const base = testWorldCampaignApplication();
    const record = <T extends unknown[], R>(name: string, operation: (...args: T) => Promise<R>) => async (...args: T) => {
      operations.push(name);
      return operation(...args);
    };
    const empty = async () => ({} as never);
    const worldCampaign = testWorldCampaignApplication({
      listCampaigns: record("listCampaigns", base.listCampaigns.bind(base)),
      getWorldVersionPlayableCharacterSummary: record("getWorldVersionPlayableCharacterSummary", base.getWorldVersionPlayableCharacterSummary.bind(base)),
      createCampaign: record("createCampaign", base.createCampaign.bind(base)),
      updateCampaign: record("updateCampaign", empty),
      deleteCampaign: record("deleteCampaign", async () => undefined),
      migrateCampaignWorldVersion: record("migrateCampaignWorldVersion", empty)
    });
    const app = await buildServer(Object.assign(serverOptions({ config: runtimeConfig(), pool }), { worldCampaign }) as BuildServerOptions);
    const requests = [
      { method: "GET", url: "/api/v1/campaigns" },
      { method: "GET", url: `/api/v1/world-versions/${WORLD_VERSION_ID}/playable-characters` },
      { method: "POST", url: "/api/v1/campaigns", payload: { worldVersionId: WORLD_VERSION_ID, title: "Route Campaign", selectedCharacterId: "route-explorer" } },
      { method: "PATCH", url: `/api/v1/campaigns/${CAMPAIGN_ID}`, payload: { title: "Updated Route Campaign" } },
      { method: "DELETE", url: `/api/v1/campaigns/${CAMPAIGN_ID}`, payload: { confirmation: "DELETE", expectedTitle: "Route Campaign" } },
      { method: "POST", url: `/api/v1/campaigns/${CAMPAIGN_ID}/migrate-world`, payload: { worldVersionId: WORLD_VERSION_ID, note: "Route parity." } }
    ];
    try {
      const responses = [];
      for (const request of requests) responses.push(await app.inject(request as never));
      expect(responses.every((response) => response.statusCode >= 200 && response.statusCode < 300)).toBe(true);
      expect(operations).toEqual([
        "listCampaigns", "getWorldVersionPlayableCharacterSummary", "createCampaign",
        "updateCampaign", "deleteCampaign", "migrateCampaignWorldVersion"
      ]);
    } finally {
      await app.close();
    }
  });

  it("routes character profile and campaign transfer operations through the application", async () => {
    const operations: string[] = [];
    const empty = async () => ({} as never);
    const record = <T extends unknown[], R>(name: string, operation: (...args: T) => Promise<R>) => async (...args: T) => {
      operations.push(name);
      return operation(...args);
    };
    const worldCampaign = testWorldCampaignApplication({
      getCampaignCharacterProfile: record("getCampaignCharacterProfile", empty),
      updateCampaignCharacterProfile: record("updateCampaignCharacterProfile", empty),
      organizeCampaignCharacterProfile: record("organizeCampaignCharacterProfile", empty),
      previewCampaignWorldTransfer: record("previewCampaignWorldTransfer", empty),
      transferCampaignWorld: record("transferCampaignWorld", empty)
    });
    const app = await buildServer(Object.assign(serverOptions({ config: runtimeConfig(), pool }), { worldCampaign }) as BuildServerOptions);
    const previewRequest = { targetWorldVersionId: WORLD_VERSION_ID, title: "Transferred Route Campaign" };
    const requests = [
      { method: "GET", url: `/api/v1/campaigns/${CAMPAIGN_ID}/character-profile` },
      { method: "PUT", url: `/api/v1/campaigns/${CAMPAIGN_ID}/character-profile`, payload: { expectedRevision: 0, name: "Route Explorer", profile: {} } },
      { method: "POST", url: `/api/v1/campaigns/${CAMPAIGN_ID}/character-profile/organize`, payload: { expectedRevision: 0, character: WORLD_CONTENT.playableCharacters[0] } },
      { method: "POST", url: `/api/v1/campaigns/${CAMPAIGN_ID}/transfer-world/preview`, payload: previewRequest },
      { method: "POST", url: `/api/v1/campaigns/${CAMPAIGN_ID}/transfer-world`, payload: { ...previewRequest, idempotencyKey: crypto.randomUUID(), expectedActiveTurnNumber: 0, expectedStateRevision: 0, sourceFingerprint: "a".repeat(64) } }
    ];
    try {
      const responses = [];
      for (const request of requests) responses.push(await app.inject(request as never));
      expect(responses.every((response) => response.statusCode >= 200 && response.statusCode < 300)).toBe(true);
      expect(operations).toEqual([
        "getCampaignCharacterProfile", "updateCampaignCharacterProfile",
        "organizeCampaignCharacterProfile", "previewCampaignWorldTransfer", "transferCampaignWorld"
      ]);
    } finally {
      await app.close();
    }
  });

  it("routes campaign state, sync, and player configuration through the application", async () => {
    const operations: string[] = [];
    const base = testWorldCampaignApplication();
    const record = <T extends unknown[], R>(name: string, operation: (...args: T) => Promise<R>) => async (...args: T) => {
      operations.push(name);
      return operation(...args);
    };
    const worldCampaign = testWorldCampaignApplication({
      getCampaignRuntimeState: record("getCampaignRuntimeState", base.getCampaignRuntimeState.bind(base)),
      updateCampaignRuntimeState: record("updateCampaignRuntimeState", base.updateCampaignRuntimeState.bind(base)),
      getCampaignSyncStatus: record("getCampaignSyncStatus", base.getCampaignSyncStatus.bind(base)),
      syncPlayerCampaignConfig: record("syncPlayerCampaignConfig", async () => ({ campaignId: CAMPAIGN_ID, activeTurnNumber: 0, synchronized: true as const }))
    });
    const app = await buildServer(Object.assign(serverOptions({ config: runtimeConfig(), pool }), { worldCampaign }) as BuildServerOptions);
    const requests = [
      { method: "GET", url: `/api/v1/campaigns/${CAMPAIGN_ID}/state?turnNumber=0` },
      { method: "PATCH", url: `/api/v1/campaigns/${CAMPAIGN_ID}/state`, payload: { expectedTurnNumber: 0, expectedRevision: 1, ...RUNTIME_STATE } },
      { method: "GET", url: `/api/v1/campaigns/${CAMPAIGN_ID}/sync-status` },
      { method: "PUT", url: `/api/v1/campaigns/${CAMPAIGN_ID}/player-config`, payload: { expectedTurnNumber: 0, useRpgStats: false, suppressEventTriggers: false, rpgStats: [], eventTriggers: [], pendingEventTriggers: [] } }
    ];
    try {
      const responses = [];
      for (const request of requests) responses.push(await app.inject(request as never));
      expect(responses.every((response) => response.statusCode >= 200 && response.statusCode < 300)).toBe(true);
      expect(operations).toEqual([
        "getCampaignRuntimeState", "updateCampaignRuntimeState", "getCampaignSyncStatus",
        "getCampaignRuntimeState", "syncPlayerCampaignConfig"
      ]);
    } finally {
      await app.close();
    }
  });

  it("routes rewind and branch through the application and validates rewind before reading state", async () => {
    const operations: string[] = [];
    const base = testWorldCampaignApplication();
    const record = <T extends unknown[], R>(name: string, operation: (...args: T) => Promise<R>) => async (...args: T) => {
      operations.push(name);
      return operation(...args);
    };
    const worldCampaign = testWorldCampaignApplication({
      getCampaignRuntimeState: record("getCampaignRuntimeState", base.getCampaignRuntimeState.bind(base)),
      rewindCampaign: record("rewindCampaign", base.rewindCampaign.bind(base)),
      branchCampaign: record("branchCampaign", base.branchCampaign.bind(base))
    });
    const app = await buildServer(Object.assign(serverOptions({ config: runtimeConfig(), pool }), { worldCampaign }) as BuildServerOptions);
    try {
      const invalid = await app.inject({ method: "POST", url: `/api/v1/campaigns/${CAMPAIGN_ID}/rewind`, payload: { targetTurnNumber: -1 } });
      expect(invalid.statusCode).toBe(400);
      expect(operations).toEqual([]);

      const rewind = await app.inject({ method: "POST", url: `/api/v1/campaigns/${CAMPAIGN_ID}/rewind`, payload: { targetTurnNumber: 0 } });
      const branch = await app.inject({ method: "POST", url: `/api/v1/campaigns/${CAMPAIGN_ID}/branch`, payload: { targetTurnNumber: 0, title: "Branched Route Campaign" } });
      expect(rewind.statusCode).toBe(200);
      expect(branch.statusCode).toBe(201);
      expect(operations).toEqual(["getCampaignRuntimeState", "rewindCampaign", "branchCampaign"]);
    } finally {
      await app.close();
    }
  });

  it("routes Infinite Worlds world preview and import through the named portable-world application port", async () => {
    const expectedOwnerUserId = await initialOwnerId(pool);
    const calls: Array<{ operation: string; scope: unknown; request: unknown }> = [];
    const worldId = crypto.randomUUID();
    const worldVersionId = crypto.randomUUID();
    const importId = crypto.randomUUID();
    const worldCampaign = testWorldCampaignApplication({
      async previewWorldImport(scope, request) {
        calls.push({ operation: "preview", scope, request });
        return {
          kind: "world",
          title: request.worldExport.title,
          duplicate: false,
          existingWorldId: null,
          counts: { entities: 0, relationships: 0, triggers: 0 },
          warnings: []
        };
      },
      async importWorld(scope, request) {
        calls.push({ operation: "import", scope, request });
        return { importId, worldId, worldVersionId, duplicate: false };
      }
    });
    const app = await buildServer(Object.assign(serverOptions({ config: runtimeConfig(), pool }), {
      worldCampaign
    }) as BuildServerOptions);
    const body = {
      sourceName: "portable-infinite-worlds.json",
      sourceKind: "world_json",
      sourceText: JSON.stringify({
        title: "Portable Route World",
        background: "A route parity fixture.",
        possibleCharacters: [{ name: "Route Explorer", description: "Tests the portable port." }]
      }),
      enrichFinalTurn: false
    };

    try {
      const preview = await app.inject({
        method: "POST",
        url: "/api/v1/imports/infinite-worlds/preview",
        headers: { "x-user-id": crypto.randomUUID() },
        payload: body
      });
      const imported = await app.inject({
        method: "POST",
        url: "/api/v1/imports/infinite-worlds",
        headers: { "x-user-id": crypto.randomUUID() },
        payload: body
      });

      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({
        kind: "world_json",
        valid: true,
        title: "Portable Route World",
        duplicate: false
      });
      expect(imported.statusCode).toBe(201);
      expect(imported.json()).toEqual({ kind: "world", importId, worldId, worldVersionId, duplicate: false });
      expect(calls).toHaveLength(2);
      expect(calls.map(({ operation, scope }) => ({ operation, scope }))).toEqual([
        { operation: "preview", scope: { ownerUserId: expectedOwnerUserId } },
        { operation: "import", scope: { ownerUserId: expectedOwnerUserId } }
      ]);
      expect(calls[0]?.request).toMatchObject({
        sourceName: body.sourceName,
        worldExport: { title: "Portable Route World", format: "infinite-quest-world", formatVersion: 1 }
      });
      expect(calls[1]?.request).toEqual(calls[0]?.request);
    } finally {
      await app.close();
    }
  });
});
