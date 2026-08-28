import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  WorldCampaignApplicationError,
  type WorldCampaignApplication
} from "../../packages/application/src/world-campaign/index.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { supportsSecureGeneratedArchiveStaging } from "../../services/api/src/archive-io.js";
import { buildServer } from "../../services/api/src/server.js";
import { createApiWorldCampaignApplication } from "../helpers/runtime-application-fixtures.js";
import { inertStorageServerOptions, serverOptions } from "../helpers/build-server-options.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;
const secureFilesystemSupported = supportsSecureGeneratedArchiveStaging();
const secureFilesystemIt = it.runIf(secureFilesystemSupported);

function worldContent(title: string, marker = "One") {
  return {
    schemaVersion: 5,
    world: {
      title,
      genre: "Test",
      tone: "Measured",
      premise: `Exercise every route boundary (${marker}).`,
      backgroundStory: "A portable parity fixture.",
      firstAction: "Begin the route audit.",
      rules: "Keep authority server-side."
    },
    playableCharacters: [{
      id: "route-explorer",
      name: "Route Explorer",
      characterText: "An explorer of application boundaries.",
      rpgStats: [],
      defaultTriggers: [],
      source: {}
    }],
    entities: [],
    relationships: [],
    rpgStats: [],
    defaultTriggers: [],
    eventTriggers: [],
    assets: [],
    defaults: { trackers: [] }
  };
}

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
      apiRateLimitProviderRequests: 1_000,
      apiRateLimitGenerationRequests: 12,
      apiRateLimitImportRequests: 4,
      apiConcurrencyProviderRequests: 100,
      apiConcurrencyImportRequests: 1,
      trustProxyHops: 0
    }
  };
}

type TrackedResource = { ownerUserId: string; id: string; title: string };

integration("world campaign Fastify production application cutover", () => {
  let pool: DatabasePool;
  let app: FastifyInstance;
  let worldCampaign: WorldCampaignApplication;
  let ownerUserId: string;
  const trackedCampaigns: TrackedResource[] = [];
  const trackedWorlds: TrackedResource[] = [];
  const trackedForeignUsers: string[] = [];

  const ownerScope = (boundOwnerUserId = ownerUserId) => ({ ownerUserId: boundOwnerUserId });
  const worldScope = (worldId: string, boundOwnerUserId = ownerUserId) => ({
    ownerUserId: boundOwnerUserId,
    worldId
  });
  const campaignScope = (campaignId: string, boundOwnerUserId = ownerUserId) => ({
    ownerUserId: boundOwnerUserId,
    campaignId
  });
  const trackWorld = (id: string, title: string, boundOwnerUserId = ownerUserId) => {
    trackedWorlds.push({ ownerUserId: boundOwnerUserId, id, title });
  };
  const trackCampaign = (id: string, title: string, boundOwnerUserId = ownerUserId) => {
    trackedCampaigns.push({ ownerUserId: boundOwnerUserId, id, title });
  };
  const forget = (resources: TrackedResource[], id: string) => {
    const index = resources.findIndex((resource) => resource.id === id);
    if (index >= 0) resources.splice(index, 1);
  };
  const rename = (resources: TrackedResource[], id: string, title: string) => {
    const resource = resources.find((candidate) => candidate.id === id);
    if (resource) resource.title = title;
  };
  const notFound = (error: unknown) => error instanceof WorldCampaignApplicationError
    && error.kind === "not_found";

  function expectUnavailableProviderResponse(
    response: Awaited<ReturnType<FastifyInstance["inject"]>>,
    code: "default_text_provider_unavailable" | "text_provider_unavailable",
    message: string
  ): void {
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.correlationId).toEqual(expect.any(String));
    expect(body).toEqual({
      error: "Error",
      message: `${message} Correlation ID: ${body.correlationId}.`,
      correlationId: body.correlationId,
      details: { code }
    });
  }

  async function withTextProvidersUnavailable<T>(operation: () => Promise<T>): Promise<T> {
    const fixtureId = crypto.randomUUID();
    const snapshot = await pool.query<{ id: string; enabled: boolean; is_default: boolean }>(
      `SELECT id, enabled, is_default
         FROM provider_profiles
        WHERE owner_user_id = $1 AND provider_role = 'text'
        ORDER BY id`,
      [ownerUserId]
    );
    try {
      await pool.query(
        `UPDATE provider_profiles
            SET is_default = false
          WHERE owner_user_id = $1 AND provider_role = 'text'`,
        [ownerUserId]
      );
      await pool.query(
        `INSERT INTO provider_profiles (
           id, owner_user_id, name, provider_type, provider_role, base_url,
           default_model, request_timeout_ms, enabled, is_default
         ) VALUES ($1, $2, $3, 'openai_compatible', 'text', 'http://127.0.0.1:1',
           '14c3-unreachable', 5000, true, true)`,
        [fixtureId, ownerUserId, `14c3 provider contaminant ${fixtureId}`]
      );
      await pool.query(
        `UPDATE provider_profiles
            SET enabled = false, is_default = false
          WHERE owner_user_id = $1 AND provider_role = 'text'`,
        [ownerUserId]
      );
      const selection = await pool.query<{ enabled_count: string }>(
        `SELECT count(*)::text AS enabled_count
           FROM provider_profiles
          WHERE owner_user_id = $1 AND provider_role = 'text' AND enabled = true`,
        [ownerUserId]
      );
      if (selection.rows[0]?.enabled_count !== "0") {
        throw new Error("Task 14c3 provider fixture failed to establish an unavailable text-provider selection.");
      }
      return await operation();
    } finally {
      await pool.query("DELETE FROM provider_profiles WHERE id = $1 AND owner_user_id = $2", [fixtureId, ownerUserId]);
      for (const profile of snapshot.rows) {
        await pool.query(
          `UPDATE provider_profiles
              SET enabled = $3, is_default = $4
            WHERE id = $1 AND owner_user_id = $2`,
          [profile.id, ownerUserId, profile.enabled, profile.is_default]
        );
      }
    }
  }

  async function cleanupTrackedResources(): Promise<void> {
    for (const campaign of trackedCampaigns.splice(0).reverse()) {
      await pool.query(
        "DELETE FROM chronicle_jobs WHERE campaign_id = $1 AND owner_user_id = $2",
        [campaign.id, campaign.ownerUserId]
      );
      try {
        await worldCampaign.deleteCampaign(
          campaignScope(campaign.id, campaign.ownerUserId),
          { confirmation: "DELETE", expectedTitle: campaign.title }
        );
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    }
    for (const world of trackedWorlds.splice(0).reverse()) {
      await pool.query(
        `DELETE FROM campaign_world_transfers
          WHERE owner_user_id = $2
            AND (
              from_world_version_id IN (
                SELECT id FROM world_versions WHERE world_id = $1 AND owner_user_id = $2
              )
              OR to_world_version_id IN (
                SELECT id FROM world_versions WHERE world_id = $1 AND owner_user_id = $2
              )
            )`,
        [world.id, world.ownerUserId]
      );
      await pool.query(
        `DELETE FROM chronicle_memories
          WHERE owner_user_id = $2
            AND world_version_id IN (
              SELECT id FROM world_versions WHERE world_id = $1 AND owner_user_id = $2
            )`,
        [world.id, world.ownerUserId]
      );
      try {
        await worldCampaign.deleteWorld(
          worldScope(world.id, world.ownerUserId),
          { confirmation: "DELETE", expectedTitle: world.title }
        );
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    }
    for (const userId of trackedForeignUsers.splice(0).reverse()) {
      await pool.query("DELETE FROM activity_events WHERE owner_user_id = $1", [userId]);
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    }
  }

  async function createPublishedWorld(label: string, boundOwnerUserId = ownerUserId) {
    const title = `14c3 ${label} ${crypto.randomUUID()}`;
    const created = await worldCampaign.createWorld(
      ownerScope(boundOwnerUserId),
      { title, content: worldContent(title) }
    );
    trackWorld(created.id, title, boundOwnerUserId);
    const published = await worldCampaign.publishWorld(
      worldScope(created.id, boundOwnerUserId),
      { expectedRevision: created.draftRevision, releaseNotes: "14c3 production parity" }
    );
    return { title, created, published };
  }

  async function publishNextVersion(worldId: string, title: string) {
    const detail = await worldCampaign.getWorld(worldScope(worldId));
    const saved = await worldCampaign.updateWorldDraft(worldScope(worldId), {
      expectedRevision: detail.draftRevision!,
      content: worldContent(title, "Two")
    });
    return worldCampaign.publishWorld(worldScope(worldId), {
      expectedRevision: saved.revision,
      releaseNotes: "14c3 production parity version two"
    });
  }

  async function createCampaign(label: string, worldVersionId: string) {
    const title = `14c3 ${label} ${crypto.randomUUID()}`;
    const campaign = await worldCampaign.createCampaign(ownerScope(), {
      title,
      worldVersionId,
      selectedCharacterId: "route-explorer",
      storyLengthProfile: "standard",
      storyContextBudgetTokens: 32_000,
      turnControlStyle: "flexible_auto"
    });
    trackCampaign(campaign.id, title);
    return { title, campaign };
  }

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    const config = runtimeConfig();
    worldCampaign = createApiWorldCampaignApplication(pool, {
      credentialSecret: config.credentialEncryptionKey
    });
    app = await buildServer({
      ...(secureFilesystemSupported
        ? serverOptions({ config, pool })
        : inertStorageServerOptions({ config, pool })),
      worldCampaign
    });
  });

  afterEach(async () => {
    await cleanupTrackedResources();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("serves dashboard data from the production PostgreSQL application under server authority", async () => {
    const expected = await worldCampaign.getDashboard(ownerScope());
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/stats",
      headers: { "x-user-id": crypto.randomUUID() }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
  });

  it("serves every session/profile alias from the production owner-scoped application", async () => {
    const original = await worldCampaign.getSessionProfile(ownerScope());
    const spoofedHeaders = { "x-user-id": crypto.randomUUID() };
    const update = {
      displayName: `14c3 owner ${crypto.randomUUID()}`,
      settings: {
        autoSubmitTurnChoices: false,
        continuousReading: true,
        defaultTurnControlStyle: "flexible_action" as const
      }
    };

    try {
      const reads = await Promise.all([
        app.inject({ method: "GET", url: "/api/v1/session", headers: spoofedHeaders }),
        app.inject({ method: "GET", url: "/api/v1/users/me", headers: spoofedHeaders }),
        app.inject({ method: "GET", url: "/api/v1/user/profile", headers: spoofedHeaders })
      ]);
      expect(reads.every((response) => response.statusCode === 200)).toBe(true);
      expect(reads.map((response) => response.json().user.id)).toEqual([
        ownerUserId,
        ownerUserId,
        ownerUserId
      ]);

      for (const request of [
        { method: "PATCH", url: "/api/v1/users/me/profile" },
        { method: "PUT", url: "/api/v1/users/me/profile" },
        { method: "PATCH", url: "/api/v1/user/profile" },
        { method: "PUT", url: "/api/v1/user/profile" }
      ] as const) {
        const response = await app.inject({ ...request, headers: spoofedHeaders, payload: update });
        expect(response.statusCode).toBe(200);
        expect(response.json().user).toMatchObject({ id: ownerUserId, displayName: update.displayName });
      }
    } finally {
      await worldCampaign.updateSessionProfile(ownerScope(), {
        displayName: original.displayName,
        settings: original.settings
      });
    }
  });

  it("exercises the complete world, generation, progress, and portable-export route family against production PostgreSQL", async () => {
    const title = `14c3 route world ${crypto.randomUUID()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/worlds",
      payload: { title, content: worldContent(title) }
    });
    expect(create.statusCode).toBe(201);
    const created = create.json();
    trackWorld(created.id, title);

    const list = await app.inject({ method: "GET", url: "/api/v1/worlds" });
    expect(list.statusCode).toBe(200);
    expect(list.json().worlds.some((world: { id: string }) => world.id === created.id)).toBe(true);

    const get = await app.inject({ method: "GET", url: `/api/v1/worlds/${created.id}` });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ id: created.id, title });

    const update = await app.inject({
      method: "PUT",
      url: `/api/v1/worlds/${created.id}/draft`,
      payload: { expectedRevision: created.draftRevision, content: worldContent(title, "Updated") }
    });
    expect(update.statusCode).toBe(200);
    const revision = update.json().revision;

    const providerBackedRequests = [
      {
        method: "POST",
        url: "/api/v1/worlds/generate-preview",
        payload: { prompt: "Generate a production parity world." }
      },
      {
        method: "POST",
        url: "/api/v1/worlds/playable-characters/generate-preview",
        payload: { content: worldContent(title), prompt: "Generate a production parity explorer." }
      },
      {
        method: "POST",
        url: `/api/v1/worlds/${created.id}/draft/playable-characters/generate`,
        payload: { expectedRevision: revision, prompt: "Generate a production parity explorer." }
      },
      {
        method: "POST",
        url: `/api/v1/worlds/${created.id}/draft/playable-characters/organize`,
        payload: { expectedRevision: revision, character: worldContent(title).playableCharacters[0] }
      }
    ] as const;
    const providerBackedResponses = await withTextProvidersUnavailable(async () => {
      const responses = [];
      for (const request of providerBackedRequests) {
        responses.push(await app.inject(request));
      }
      return responses;
    });
    const providerFailureModes = [
      {
        code: "default_text_provider_unavailable",
        message: "Add a text provider or mark one as default in Provider Management before generating a world."
      },
      {
        code: "default_text_provider_unavailable",
        message: "Add a text provider or mark one as default in Provider Management before generating a character."
      },
      {
        code: "default_text_provider_unavailable",
        message: "Add a text provider or mark one as default in Provider Management before generating a character."
      },
      {
        code: "text_provider_unavailable",
        message: "No enabled text provider is available to organize this profile."
      }
    ] as const;
    providerBackedResponses.forEach((response, index) => {
      const expected = providerFailureModes[index]!;
      expectUnavailableProviderResponse(response, expected.code, expected.message);
    });

    const progress = await app.inject({
      method: "GET",
      url: `/api/v1/worlds/generate-progress?key=${crypto.randomUUID()}`
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json()).toEqual({ status: "unknown", phase: "unknown", progressPercent: 0, message: "" });

    const publish = await app.inject({
      method: "POST",
      url: `/api/v1/worlds/${created.id}/publish`,
      payload: { expectedRevision: revision, releaseNotes: "14c3 route publication" }
    });
    expect(publish.statusCode).toBe(201);
    const published = publish.json();

    for (const url of [
      `/api/v1/worlds/${created.id}/export`,
      `/api/v1/worlds/${created.id}/export?worldVersionId=${published.worldVersionId}`
    ]) {
      const exported = await app.inject({ method: "GET", url });
      expect(exported.statusCode).toBe(200);
      expect(exported.headers["content-disposition"]).toContain("infinite-quest-world.json");
      expect(exported.json()).toMatchObject({ format: "infinite-quest-world", formatVersion: 1, title });
    }

    const forkTitle = `14c3 fork ${crypto.randomUUID()}`;
    const fork = await app.inject({
      method: "POST",
      url: `/api/v1/worlds/${created.id}/fork`,
      payload: { title: forkTitle, sourceWorldVersionId: published.worldVersionId }
    });
    expect(fork.statusCode).toBe(201);
    trackWorld(fork.json().worldId, forkTitle);

    const archive = await app.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${created.id}`,
      payload: { status: "archived" }
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json()).toMatchObject({ id: created.id, status: "archived" });

    const disposable = await createPublishedWorld("disposable version");
    const second = await publishNextVersion(disposable.created.id, disposable.title);
    const deleteVersion = await app.inject({
      method: "DELETE",
      url: `/api/v1/worlds/${disposable.created.id}/versions/${disposable.published.worldVersionId}`,
      payload: { confirmation: "DELETE", expectedVersionNumber: 1 }
    });
    expect(deleteVersion.statusCode).toBe(200);
    expect(second.versionNumber).toBe(2);

    const draftTitle = `14c3 disposable draft ${crypto.randomUUID()}`;
    const draft = await worldCampaign.createWorld(ownerScope(), {
      title: draftTitle,
      content: worldContent(draftTitle)
    });
    trackWorld(draft.id, draftTitle);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/worlds/${draft.id}`,
      payload: { confirmation: "DELETE", expectedTitle: draftTitle }
    });
    expect(deleted.statusCode).toBe(200);
    forget(trackedWorlds, draft.id);

    const foreignUserId = crypto.randomUUID();
    trackedForeignUsers.push(foreignUserId);
    await pool.query(
      "INSERT INTO users (id, display_name, status) VALUES ($1,$2,'active')",
      [foreignUserId, `14c3 foreign ${foreignUserId}`]
    );
    const foreign = await createPublishedWorld("foreign export", foreignUserId);
    const foreignExport = await app.inject({
      method: "GET",
      url: `/api/v1/worlds/${foreign.created.id}/export?worldVersionId=${foreign.published.worldVersionId}`,
      headers: { "x-user-id": foreignUserId }
    });
    expect(foreignExport.statusCode).toBe(404);
    expect(foreignExport.json()).toMatchObject({ details: { code: "world_version_not_found" } });
  });

  it("exercises campaign lifecycle, playable-character lookup, and migration against production PostgreSQL", async () => {
    const world = await createPublishedWorld("campaign lifecycle");
    const characters = await app.inject({
      method: "GET",
      url: `/api/v1/world-versions/${world.published.worldVersionId}/playable-characters`
    });
    expect(characters.statusCode).toBe(200);
    expect(characters.json()).toMatchObject({
      characters: [{ id: "route-explorer", name: "Route Explorer" }],
      readiness: { ready: true }
    });

    const campaignTitle = `14c3 route campaign ${crypto.randomUUID()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      payload: {
        worldVersionId: world.published.worldVersionId,
        title: campaignTitle,
        selectedCharacterId: "route-explorer"
      }
    });
    expect(create.statusCode).toBe(201);
    const campaign = create.json();
    trackCampaign(campaign.id, campaignTitle);

    const list = await app.inject({ method: "GET", url: "/api/v1/campaigns" });
    expect(list.statusCode).toBe(200);
    expect(list.json().campaigns.some((item: { id: string }) => item.id === campaign.id)).toBe(true);

    const updatedTitle = `14c3 updated campaign ${crypto.randomUUID()}`;
    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/campaigns/${campaign.id}`,
      payload: { title: updatedTitle, storyLengthProfile: "long" }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ id: campaign.id, title: updatedTitle, storyLengthProfile: "long" });
    rename(trackedCampaigns, campaign.id, updatedTitle);

    const second = await publishNextVersion(world.created.id, world.title);
    const migrate = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id}/migrate-world`,
      payload: { worldVersionId: second.worldVersionId, note: "14c3 route migration" }
    });
    expect(migrate.statusCode).toBe(200);
    expect(migrate.json()).toMatchObject({
      campaignId: campaign.id,
      fromWorldVersionId: world.published.worldVersionId,
      toWorldVersionId: second.worldVersionId
    });

    await pool.query(
      "DELETE FROM chronicle_jobs WHERE campaign_id = $1 AND owner_user_id = $2",
      [campaign.id, ownerUserId]
    );
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/campaigns/${campaign.id}`,
      payload: { confirmation: "DELETE", expectedTitle: updatedTitle }
    });
    expect(deleted.statusCode).toBe(200);
    forget(trackedCampaigns, campaign.id);
  });

  it("exercises character profile and campaign transfer routes against production PostgreSQL", async () => {
    const sourceWorld = await createPublishedWorld("transfer source");
    const targetWorld = await createPublishedWorld("transfer target");
    const source = await createCampaign("transfer source", sourceWorld.published.worldVersionId);

    const profile = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${source.campaign.id}/character-profile`
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({ campaignId: source.campaign.id, revision: 0 });

    const update = await app.inject({
      method: "PUT",
      url: `/api/v1/campaigns/${source.campaign.id}/character-profile`,
      payload: { expectedRevision: 0, name: "Route Explorer", profile: {} }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ campaignId: source.campaign.id, revision: 1 });

    const organize = await withTextProvidersUnavailable(() => app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${source.campaign.id}/character-profile/organize`,
      payload: { expectedRevision: 1, character: worldContent(sourceWorld.title).playableCharacters[0] }
    }));
    expectUnavailableProviderResponse(
      organize,
      "text_provider_unavailable",
      "No enabled text provider is available to organize this profile."
    );

    const transferTitle = `14c3 transferred ${crypto.randomUUID()}`;
    const preview = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${source.campaign.id}/transfer-world/preview`,
      payload: { targetWorldVersionId: targetWorld.published.worldVersionId, title: transferTitle }
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json();
    expect(previewBody).toMatchObject({ allowed: true, proposedTitle: transferTitle });

    const transfer = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${source.campaign.id}/transfer-world`,
      payload: {
        targetWorldVersionId: targetWorld.published.worldVersionId,
        title: transferTitle,
        idempotencyKey: crypto.randomUUID(),
        expectedActiveTurnNumber: previewBody.expectedActiveTurnNumber,
        expectedStateRevision: previewBody.expectedStateRevision,
        sourceFingerprint: previewBody.sourceFingerprint,
        note: "14c3 production route transfer"
      }
    });
    expect(transfer.statusCode).toBe(201);
    expect(transfer.json()).toMatchObject({
      sourceCampaignId: source.campaign.id,
      targetWorldVersionId: targetWorld.published.worldVersionId,
      reused: false
    });
    trackCampaign(transfer.json().targetCampaignId, transferTitle);
  });

  it("exercises campaign state, sync, and player configuration routes against production PostgreSQL", async () => {
    const world = await createPublishedWorld("state");
    const source = await createCampaign("state", world.published.worldVersionId);

    const state = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${source.campaign.id}/state?turnNumber=0`
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({
      campaignId: source.campaign.id,
      activeTurnNumber: 0,
      viewedTurnNumber: 0,
      isCurrent: true
    });

    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/campaigns/${source.campaign.id}/state`,
      payload: {
        expectedTurnNumber: 0,
        expectedRevision: state.json().revision,
        ...RUNTIME_STATE
      }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ campaignId: source.campaign.id, continuitySummary: RUNTIME_STATE.continuitySummary });

    const sync = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${source.campaign.id}/sync-status`
    });
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toMatchObject({ campaign: { id: source.campaign.id }, turnWindowMode: "replace" });

    const playerConfig = await app.inject({
      method: "PUT",
      url: `/api/v1/campaigns/${source.campaign.id}/player-config`,
      payload: {
        expectedTurnNumber: 0,
        useRpgStats: false,
        suppressEventTriggers: false,
        rpgStats: [],
        eventTriggers: [],
        pendingEventTriggers: []
      }
    });
    expect(playerConfig.statusCode).toBe(200);
    expect(playerConfig.json()).toEqual({
      campaignId: source.campaign.id,
      activeTurnNumber: 0,
      synchronized: true
    });
  });

  it("exercises rewind validation and branch routes against production PostgreSQL", async () => {
    const world = await createPublishedWorld("rewind branch");
    const source = await createCampaign("rewind branch", world.published.worldVersionId);

    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${source.campaign.id}/rewind`,
      payload: { targetTurnNumber: -1 }
    });
    expect(invalid.statusCode).toBe(400);

    const currentTurn = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${source.campaign.id}/rewind`,
      payload: { targetTurnNumber: 0 }
    });
    expect(currentTurn.statusCode).toBe(200);
    expect(currentTurn.json()).toMatchObject({
      campaignId: source.campaign.id,
      activeTurnNumber: 0,
      discardedTurnCount: 0
    });

    const branchTitle = `14c3 branch ${crypto.randomUUID()}`;
    const branch = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${source.campaign.id}/branch`,
      payload: { targetTurnNumber: 0, title: branchTitle }
    });
    expect(branch.statusCode).toBe(201);
    expect(branch.json()).toMatchObject({ title: branchTitle, activeTurnNumber: 0 });
    trackCampaign(branch.json().id, branchTitle);
  });

  secureFilesystemIt("exercises Infinite Worlds preview/import through the production owner-bound portable port", async () => {
    const title = `14c3 portable import ${crypto.randomUUID()}`;
    const body = {
      sourceName: `${title}.json`,
      sourceKind: "world_json",
      sourceText: JSON.stringify({
        title,
        background: "A route parity fixture.",
        possibleCharacters: [{ name: "Route Explorer", description: "Tests the portable port." }]
      }),
      enrichFinalTurn: false
    };
    const spoofedHeaders = { "x-user-id": crypto.randomUUID() };

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/imports/infinite-worlds/preview",
      headers: spoofedHeaders,
      payload: body
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      kind: "world_json",
      valid: true,
      title,
      duplicate: false
    });

    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/imports/infinite-worlds",
      headers: spoofedHeaders,
      payload: body
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ kind: "world", duplicate: false });

    // A committed portable import deliberately retains durable operation and
    // result authority. Let this file's isolated database teardown own that
    // graph instead of routing it through ordinary world-deletion cleanup.

    await expect(worldCampaign.getWorld(worldScope(imported.json().worldId))).resolves.toMatchObject({
      id: imported.json().worldId,
      title
    });
  });
});
