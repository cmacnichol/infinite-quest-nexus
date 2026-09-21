import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresPreparedTextAttemptRepository } from "../../packages/database/src/prepared-text-attempt-repository.js";
import { buildServer } from "../../services/api/src/server.js";
import { inertStorageServerOptions } from "../helpers/build-server-options.js";
import { createApiProviderApplicationComposition } from "../../services/runtime/src/provider-application-composition.js";
import { createProviderApplicationAdapter } from "../../services/api/src/provider-application-adapter.js";
import { createApiWorldCampaignApplication } from "../../services/runtime/src/world-campaign-composition.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import { worldContentSchema, playableCharacterSchema } from "../../packages/contracts/src/world-library.js";
import { apiErrorEnvelopeSchema } from "../../packages/contracts/src/http.js";
import { logger } from "../../packages/logger/src/index.js";
import { parseAuthoringFailure } from "../../apps/web-next/src/authoring-errors.js";
import fixture from "../fixtures/authoring/reliability.json" with { type: "json" };

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const content = worldContentSchema.parse({ world: { title: "Synthetic Glass Road" }, playableCharacters: [playableCharacterSchema.parse(fixture.character)] });
const prompt = "Create a synthetic traveler for the glass road.";
integration("authoring reliability API, runtime provider and PostgreSQL", () => {
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let server: Server;
  let transport: ReturnType<typeof installIntegrationProviderTransport>;
  let providerId: string;
  let config: RuntimeConfig;
  let worldId: string;
  let campaignId: string;
  let replies: string[] = [];
  let requests: unknown[] = [];
  let apiLogs: unknown[] = [];
  let nativeAccountingFixture = false;
  let nativeRequests: unknown[] = [];
  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 5);
    await migrateDatabase(pool, resolve("database/migrations"));
    transport = installIntegrationProviderTransport();
    server = createServer((request, response) => {
      if (nativeAccountingFixture && request.method === "GET" && request.url?.includes("/models")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "native-model", context_length: 16_384, supported_parameters: ["response_format", "structured_outputs"] }] }));
        return;
      }
      if (nativeAccountingFixture && request.method === "GET" && request.url?.includes("/presets/charged-terminal")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: { slug: "charged-terminal", name: "Charged terminal", status: "active",
          designated_version: { id: "charged-terminal-v1", version: 1, system_prompt: "Synthetic native prompt.", config: { model: "native-model" } } } }));
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (nativeAccountingFixture) {
          const parsed = JSON.parse(body);
          nativeRequests.push(parsed);
          const outline = parsed.response_format?.json_schema?.name === "infinite_quest_world_outline_v1";
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ id: crypto.randomUUID(), model: outline ? "native-model" : "unapproved-model",
            choices: [{ message: { content: JSON.stringify(outline ? fixture.world : fixture.character) }, finish_reason: "stop" }],
            usage: outline ? { prompt_tokens: 5, cost: "0.1", currency: "USD" }
              : { completion_tokens: 7, cost: "0.2", currency: "EUR" } }));
          return;
        }
        requests.push(JSON.parse(body));
        const reply = replies.shift();
        response.writeHead(reply === undefined ? 500 : 200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(reply === undefined ? { error: { message: "Unexpected synthetic provider request" } } : { id: crypto.randomUUID(), choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }] }));
      });
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Synthetic provider did not listen");
    config = {
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
      credentialEncryptionKey: "provider-route-test-key-32-bytes",
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
    const graph = createApiProviderApplicationComposition(pool, { credentialSecret: config.credentialEncryptionKey, transport });
    app = await buildServer(inertStorageServerOptions({ config, pool, providers: createProviderApplicationAdapter(graph), worldCampaign: createApiWorldCampaignApplication(pool, graph) }));
    app.addHook("onRequest", async (request) => {
      vi.spyOn(request.log, "error").mockImplementation((...args: unknown[]) => { apiLogs.push(args); });
    });
    const provider = await createProvider(pool, { name: "Synthetic reliability provider", providerType: "openai_compatible", providerRole: "text", baseUrl: `http://127.0.0.1:${address.port}/v1`, defaultModel: "synthetic-authoring", contextWindowTokens: 32768, maxOutputTokens: 4096, temperature: 0, enabled: true, isDefault: true, configuration: {} }, config.credentialEncryptionKey);
    providerId = provider.id;
    const created = await app.inject({ method: "POST", url: "/api/v1/worlds", payload: { title: "Synthetic existing world", content } });
    expect(created.statusCode).toBe(201);
    worldId = created.json().id;
    const published = await app.inject({ method: "POST", url: `/api/v1/worlds/${worldId}/publish`, payload: { expectedRevision: 1 } });
    expect(published.statusCode).toBe(201);
    const campaign = await app.inject({ method: "POST", url: "/api/v1/campaigns", payload: { title: "Synthetic profile revision guard", worldVersionId: published.json().worldVersionId, selectedCharacterId: fixture.character.id } });
    expect(campaign.statusCode).toBe(201);
    campaignId = campaign.json().id;
  });
  beforeEach(async () => {
    replies = []; requests = []; apiLogs = []; nativeRequests = []; nativeAccountingFixture = false;
    await pool.query("UPDATE provider_profiles SET enabled = true, is_default = true WHERE id = $1", [providerId]);
  });
  afterAll(async () => { await app?.close(); await transport?.close(); if (server) await new Promise<void>((done) => server.close(() => done())); await pool?.end(); });
  async function snapshot() {
    const worlds = await pool.query("SELECT id, title, updated_at FROM worlds ORDER BY id");
    const drafts = await pool.query("SELECT world_id, revision, content FROM world_drafts ORDER BY world_id");
    const profiles = await pool.query("SELECT id, character_profile_revision, character_profile FROM campaigns ORDER BY id");
    const versions = await pool.query("SELECT * FROM world_versions ORDER BY id");
    return { worlds: worlds.rows, drafts: drafts.rows, profiles: profiles.rows, versions: versions.rows };
  }
  it("repairs malformed standalone output through HTTP and returns 200 without saving, then saves explicitly", async () => {
    replies = [fixture.malformed, JSON.stringify(fixture.character)];
    const before = await snapshot();
    const response = await app.inject({ method: "POST", url: "/api/v1/worlds/playable-characters/generate-preview", payload: { content, prompt } });
    expect(response.statusCode).toBe(200);
    expect(response.json().character.name).toBe(fixture.character.name);
    expect(requests).toHaveLength(2);
    expect(await snapshot()).toEqual(before);
    const saved = await app.inject({ method: "PUT", url: `/api/v1/worlds/${worldId}/draft`, payload: { expectedRevision: 1, content: { ...content, playableCharacters: [response.json().character] } } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().revision).toBe(2);
    expect((await snapshot()).drafts[0].revision).toBe(2);
  });
  it("repairs world output and preserves the legacy preview shape without persistence", async () => {
    replies = [fixture.malformed, JSON.stringify(fixture.world), ...fixture.world.character_seeds.map((seed) => JSON.stringify({ ...fixture.character, id: seed.id, name: seed.name }))];
    const before = await snapshot();
    const response = await app.inject({ method: "POST", url: "/api/v1/worlds/generate-preview", payload: { prompt } });
    expect(response.statusCode).toBe(200);
    expect(response.json().content.world.title).toBe(fixture.world.title);
    expect(response.json().content.playableCharacters).toHaveLength(3);
    expect(requests).toHaveLength(5);
    expect(await snapshot()).toEqual(before);
  });
  it("reports charged native attempts across successful outline and terminal seed in the actual preview error", async () => {
    const marker = `PRIVATE_CHARGED_${crypto.randomUUID()}`;
    const ownerUserId = await initialOwnerId(pool);
    const provider = await createProvider(pool, {
      name: `task-accounting-charged-${crypto.randomUUID()}`, providerType: "openrouter", providerRole: "text",
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, defaultModel: "@preset/charged-terminal",
      textSelection: { kind: "openrouter_preset", slug: "charged-terminal" }, contextWindowTokens: 16_384,
      maxOutputTokens: 2_048, temperature: 0.2, enabled: true, isDefault: true, configuration: {}, apiKey: "test"
    }, config.credentialEncryptionKey);
    const nativeConfig = { ...config, nativeTextExecutionPlanAdmission: true };
    const graph = createApiProviderApplicationComposition(pool, {
      credentialSecret: config.credentialEncryptionKey, transport, nativeTextExecutionPlanAdmission: true
    });
    const openNativeApp = (worldGenerationGraph: typeof graph) => buildServer(inertStorageServerOptions({
      config: nativeConfig, pool, providers: createProviderApplicationAdapter(worldGenerationGraph),
      worldCampaign: createApiWorldCampaignApplication(pool, worldGenerationGraph)
    }));
    nativeAccountingFixture = true;
    try {
      const before = await snapshot();
      const nativeApp = await openNativeApp(graph);
      let first;
      try {
        first = await nativeApp.inject({ method: "POST", url: "/api/v1/worlds/generate-preview", payload: { prompt: marker } });
      } finally { await nativeApp.close(); }
      expect(first.statusCode).toBe(500);
      const firstError = apiErrorEnvelopeSchema.parse(first.json());
      expect(firstError.error).toBe("Internal server error");
      expect(firstError.details).toEqual({});
      expect(firstError.physicalAccounting).toEqual({
        attemptCount: 2, completedCount: 2,
        observedUsage: { inputTokens: 5, outputTokens: 7, totalTokens: null },
        usageCoverage: { inputTokens: 1, outputTokens: 1, totalTokens: 0 },
        reportedCosts: [{ amount: "0.2", currency: "EUR" }, { amount: "0.1", currency: "USD" }]
      });
      expect(nativeRequests).toHaveLength(2);
      expect(first.body).not.toContain(marker);
      expect(first.body).not.toContain("Synthetic native prompt.");
      expect(first.body).not.toContain("unapproved-model");
      expect(await snapshot()).toEqual(before);
      const scopes = await pool.query<{ request_scope_id: string }>(
        `SELECT DISTINCT logical_reservation->>'requestScopeId' AS request_scope_id
           FROM prepared_text_physical_attempts
          WHERE logical_kind='direct' AND request_body LIKE $1`, [`%${marker}%`]
      );
      expect(scopes.rows).toHaveLength(1);
      const attempts = await pool.query<{ outcome: string; usage: unknown; reported_cost: unknown }>(
        `SELECT outcome, usage, reported_cost FROM prepared_text_physical_attempts
          WHERE owner_user_id=$1 AND logical_kind='direct' AND logical_reservation->>'requestScopeId'=$2 ORDER BY id`,
        [ownerUserId, scopes.rows[0]!.request_scope_id]
      );
      expect(attempts.rows.map((row) => row.outcome).sort()).toEqual(["failed", "succeeded"]);
      expect(attempts.rows).toHaveLength(2);
      const accounting = createPostgresPreparedTextAttemptRepository(pool);
      const accountScope = { kind: "job", ownerUserId, logicalKind: "direct", scopeId: scopes.rows[0]!.request_scope_id } as const;
      expect(await accounting.summarize(accountScope)).toEqual(firstError.physicalAccounting);
      expect(await accounting.summarize(accountScope)).toEqual(firstError.physicalAccounting);
      expect((await accounting.summarize({ ...accountScope, ownerUserId: crypto.randomUUID() })).attemptCount).toBe(0);

      const preparedExecutor = graph.worldGeneration.authoringTextPlans?.preparedExecutor;
      if (!preparedExecutor?.summarize) throw new Error("Prepared summary fixture unavailable");
      const originalSummarize = preparedExecutor.summarize;
      const faultGraph = { ...graph, worldGeneration: { ...graph.worldGeneration,
        authoringTextPlans: { ...graph.worldGeneration.authoringTextPlans!, preparedExecutor: {
          ...preparedExecutor,
          summarize: (scope: Parameters<typeof originalSummarize>[0]) => scope.kind === "job"
            ? Promise.reject(new Error("summary read unavailable")) : originalSummarize(scope)
        } }
      } };
      const faultApp = await openNativeApp(faultGraph);
      let second;
      try {
        second = await faultApp.inject({ method: "POST", url: "/api/v1/worlds/generate-preview", payload: { prompt: marker } });
      } finally { await faultApp.close(); }
      expect(second.statusCode).toBe(first.statusCode);
      const secondError = apiErrorEnvelopeSchema.parse(second.json());
      expect(secondError.error).toBe(firstError.error);
      expect(secondError.code).toBe(firstError.code);
      expect(secondError.message).toBe(firstError.message);
      expect(secondError.details).toEqual(firstError.details);
      expect(secondError.physicalAccounting).toBeUndefined();
      expect(nativeRequests).toHaveLength(4);
      expect(await snapshot()).toEqual(before);
    } finally {
      nativeAccountingFixture = false;
      await pool.query("DELETE FROM provider_profiles WHERE id=$1", [provider.id]);
    }
  });
  it.each(["world", "character", "organizer"] as const)("exhausted %s repair is sanitized 502, logs safe, and database revisions unchanged", async (stage) => {
    const spies = ["info", "warn", "error", "debug"].map((method) => vi.spyOn(logger, method as "info").mockImplementation(() => logger));
    try {
      replies = [fixture.malformed + fixture.sentinel, fixture.malformed + fixture.sentinel];
      const before = await snapshot();
      expect(before.drafts.length).toBeGreaterThan(0);
      expect(before.profiles.length).toBeGreaterThan(0);
      const url = stage === "world" ? "/api/v1/worlds/generate-preview" : stage === "character" ? "/api/v1/worlds/playable-characters/generate-preview" : `/api/v1/campaigns/${campaignId}/character-profile/organize`;
      const payload = stage === "world" ? { prompt } : stage === "character" ? { content, prompt } : { expectedRevision: before.profiles[0].character_profile_revision, character: content.playableCharacters[0] };
      const response = await app.inject({ method: "POST", url, payload });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ code: "invalid_authoring_output", details: { code: "invalid_authoring_output", stage, retryable: true } });
      expect(requests).toHaveLength(2);
      expect(response.body).not.toContain(fixture.sentinel);
      expect(await snapshot()).toEqual(before);
      const captured = JSON.stringify({ runtime: spies.map((spy) => spy.mock.calls), api: apiLogs });
      expect(captured).toContain("authoring");
      expect(captured).not.toContain(fixture.sentinel);
    } finally { spies.forEach((spy) => spy.mockRestore()); }
  });
  it("preserves the mechanics reason across actual provider, API and browser projection", async () => {
    const rejected = JSON.stringify({ ...fixture.character, profile: { ...fixture.character.profile, story: { ...fixture.character.profile.story, role: "Roll 1d20 for a skill check." } } });
    replies = [rejected, rejected];
    const response = await app.inject({ method: "POST", url: "/api/v1/worlds/playable-characters/generate-preview", payload: { content, prompt } });
    expect(response.statusCode).toBe(502);
    const failure = parseAuthoringFailure(response.json().details);
    expect(failure?.issues).toContainEqual({ path: "profile.story.role", code: "custom", message: "Generated fictional content contains mechanics language." });
    expect(requests).toHaveLength(2);
  });
  it.each(["world", "character"] as const)("retains real no-provider 409 for %s", async (stage) => {
    await pool.query("UPDATE provider_profiles SET enabled = false, is_default = false WHERE id = $1", [providerId]);
    const response = await app.inject({ method: "POST", url: stage === "world" ? "/api/v1/worlds/generate-preview" : "/api/v1/worlds/playable-characters/generate-preview", payload: stage === "world" ? { prompt } : { content, prompt } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ details: { code: "default_text_provider_unavailable" } });
    expect(response.body).toContain("provider");
    expect(response.body).not.toContain(fixture.sentinel);
    expect(requests).toHaveLength(0);
  });
});
