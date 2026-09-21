import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenerationApplicationError } from "../../packages/application/src/index.js";
import { generationRequestSchema, generationRetryLatestRequestSchema } from "../../packages/contracts/src/generation.js";
import type { TextExecutionRouteBasis } from "../../packages/contracts/src/text-execution-plan.js";
import { defaultStoryMemoryPolicy, storyMemoryPolicyHash } from "../../packages/contracts/src/story-memory-policy.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createPostgresGenerationCommandRepository } from "../../packages/database/src/generation-repository.js";
import { createPostgresGenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
import { loadPrivateProviderCredentialRow, writeEncryptedProviderCredential } from "../../packages/database/src/provider-repository.js";
import { createApiGenerationApplication } from "../../services/runtime/src/generation-api-composition.js";
import { capabilityRouteConfigHash } from "../../services/runtime/src/provider-capability-cache.js";
import { getProviderOutputSchemaV2 } from "../../packages/contracts/src/provider-output-schema.js";
import { sha256, stableStringify } from "../../packages/domain/src/index.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabaseClient, type DatabasePool } from "../../packages/database/src/pool.js";
import { readTurnReportedCostsForTest } from "../helpers/provider-application-fixtures.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { providerPromptProtocolVersion, loadPromptSnapshotForTest } from "../helpers/provider-application-fixtures.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "generation-repository-test-secret";

integration("PostgreSQL generation command repository", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let providerProfileId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 5);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    providerProfileId = (await createProvider(pool, {
      name: `Generation repository ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl: "http://127.0.0.1:9911",
      defaultModel: "repository-test-model",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret)).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  function repository() {
    return createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: (client, scopeOwnerUserId, campaignId) =>
        loadPromptSnapshotForTest(client, scopeOwnerUserId, campaignId),
      promptProtocolVersion: providerPromptProtocolVersion,
      readTurnReportedCosts: (scopeOwnerUserId, _campaignId, turnIds) =>
        readTurnReportedCostsForTest(pool, scopeOwnerUserId, [...turnIds])
    });
  }

  function frozenRouteBasis() {
    const basis = {
      version: 2 as const, selection: { kind: "model" as const, modelId: "repository-test-model" }, preset: null,
      candidates: [{ modelId: "repository-test-model", providerPolicy: {}, contextWindowTokens: 32768, maxOutputTokens: 4096 }],
      presetSystemPrompt: "", parameters: {}, endpointReference: "provider-endpoint",
      credentialReference: providerProfileId, profileRevision: "a".repeat(64), requestTimeoutMs: 30_000,
      protocolVersion: "text-execution-route-basis-v2"
    };
    return { ...basis, routeBasisHash: sha256(stableStringify(basis)) };
  }

  function plannedRepository(
    prepare: () => Promise<TextExecutionRouteBasis> = async () => frozenRouteBasis(),
    verify: () => Promise<boolean> = async () => true
  ) {
    return createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: (client, scopeOwnerUserId, campaignId) => loadPromptSnapshotForTest(client, scopeOwnerUserId, campaignId),
      promptProtocolVersion: providerPromptProtocolVersion,
      readTurnReportedCosts: (scopeOwnerUserId, _campaignId, turnIds) => readTurnReportedCostsForTest(pool, scopeOwnerUserId, [...turnIds]),
      prepareTextExecutionRouteBasis: prepare,
      verifyTextExecutionRouteBasis: verify
    });
  }

  function enrolledPolicyRepository() {
    const policy = defaultStoryMemoryPolicy("r1");
    return createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: (client, scopeOwnerUserId, campaignId) =>
        loadPromptSnapshotForTest(client, scopeOwnerUserId, campaignId),
      promptProtocolVersion: providerPromptProtocolVersion,
      readTurnReportedCosts: (scopeOwnerUserId, _campaignId, turnIds) =>
        readTurnReportedCostsForTest(pool, scopeOwnerUserId, [...turnIds]),
      resolveStoryMemoryPolicySnapshot: async () => ({
        policy,
        policyHash: storyMemoryPolicyHash(policy),
        contextProtocol: "current-continuity-v3",
        promptProtocol: "story-v14-continuity-context",
        providerConfigurationFingerprint: "a".repeat(64)
      })
    });
  }

  function recordingRepository() {
    const statements: string[] = [];
    const recordQuery = (target: { query: (...argumentsList: unknown[]) => unknown }) => async (...argumentsList: unknown[]) => {
      const statement = argumentsList[0];
      if (typeof statement === "string") statements.push(statement);
      else if (statement && typeof statement === "object" && "text" in statement && typeof statement.text === "string") {
        statements.push(statement.text);
      }
      return target.query(...argumentsList);
    };
    const instrumentedPool = new Proxy(pool, {
      get(target, property, receiver) {
        if (property === "query") return recordQuery(target as unknown as { query: (...argumentsList: unknown[]) => unknown });
        if (property === "connect") return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty === "query") return recordQuery(clientTarget as unknown as { query: (...argumentsList: unknown[]) => unknown });
              const value = Reflect.get(clientTarget, clientProperty, clientReceiver);
              return typeof value === "function" ? value.bind(clientTarget) : value;
            }
          });
        };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as DatabasePool;
    return {
      commands: createPostgresGenerationCommandRepository(instrumentedPool, {
        resolvePromptSnapshot: (client, scopeOwnerUserId, campaignId) =>
          loadPromptSnapshotForTest(client, scopeOwnerUserId, campaignId),
        promptProtocolVersion: providerPromptProtocolVersion,
        readTurnReportedCosts: (scopeOwnerUserId, _campaignId, turnIds) =>
          readTurnReportedCostsForTest(pool, scopeOwnerUserId, [...turnIds])
      }),
      statements
    };
  }

  async function campaign() {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Generation repository ${crypto.randomUUID()}`;
    return importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "generation-repository.story", story: fixture }));
  }

  function appendRequest(
    action: string,
    idempotencyKey = crypto.randomUUID(),
    storyLengthProfileOverride?: "brief" | "standard" | "long" | "extended"
  ) {
    return generationRequestSchema.parse({
      action,
      providerProfileId,
      idempotencyKey,
      ...(storyLengthProfileOverride ? { storyLengthProfileOverride } : {}),
      context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
    });
  }

  it("persists a prepared plan privately and replays before a second preflight", async () => {
    const imported = await campaign();
    let calls = 0;
    const commands = plannedRepository(async () => { calls += 1; return frozenRouteBasis(); });
    const request = appendRequest("Freeze this route before queueing.");
    const queued = await commands.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, request);
    const replay = await commands.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, request);
    expect(replay).toMatchObject({ id: queued.id, duplicate: true });
    expect(calls).toBe(1);
    const saved = await pool.query<{ basis: unknown }>("SELECT orchestration_private->'textExecutionRouteBasis' AS basis FROM generation_jobs WHERE id=$1", [queued.id]);
    expect(saved.rows[0]?.basis).toMatchObject({ version: 2, routeBasisHash: frozenRouteBasis().routeBasisHash });
  });

  it("persists the same frozen private plan for replacement jobs", async () => {
    const imported = await campaign();
    const queued = await plannedRepository().enqueueReplacement(
      { ownerUserId, campaignId: imported.campaignId }, replacementRequest("Freeze the replacement route.")
    );
    const saved = await pool.query<{ basis: unknown; status: string }>(
      "SELECT orchestration_private->'textExecutionRouteBasis' AS basis,status FROM generation_jobs WHERE id=$1", [queued.id]
    );
    expect(saved.rows[0]).toMatchObject({ status: "replacement_queued", basis: { version: 2, routeBasisHash: frozenRouteBasis().routeBasisHash } });
  });

  it("rejects a changed profile, credential, or campaign provider after preflight without queueing", async () => {
    for (const changed of ["profile", "credential", "campaign-provider"]) {
      const imported = await campaign();
      const commands = plannedRepository(async () => frozenRouteBasis(), async () => false);
      await expect(commands.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, appendRequest(`Reject ${changed} revision race.`)))
        .rejects.toMatchObject({ kind: "conflict", details: { reason: "provider_profile_changed_refresh_required" } });
      await expect(pool.query<{ count: string }>("SELECT count(*)::text AS count FROM generation_jobs WHERE campaign_id=$1", [imported.campaignId]))
        .resolves.toMatchObject({ rows: [{ count: "0" }] });
    }
  });

  it("rejects a tampered preflight plan before an accepted turn or Chronicle work can be queued", async () => {
    const imported = await campaign();
    const tampered = { ...frozenRouteBasis(), routeBasisHash: "b".repeat(64) };
    const before = await pool.query<{ jobs: string; turns: string; chronicle: string }>(
      `SELECT (SELECT count(*)::text FROM generation_jobs WHERE campaign_id=$1) AS jobs,
              (SELECT count(*)::text FROM turns WHERE campaign_id=$1) AS turns,
              (SELECT count(*)::text FROM chronicle_jobs WHERE campaign_id=$1) AS chronicle`, [imported.campaignId]
    );
    await expect(plannedRepository(async () => tampered).enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId }, appendRequest("Reject the tampered queue descriptor.")
    )).rejects.toMatchObject({ kind: "invalid_state" });
    await expect(pool.query<{ jobs: string; turns: string; chronicle: string }>(
      `SELECT (SELECT count(*)::text FROM generation_jobs WHERE campaign_id=$1) AS jobs,
              (SELECT count(*)::text FROM turns WHERE campaign_id=$1) AS turns,
              (SELECT count(*)::text FROM chronicle_jobs WHERE campaign_id=$1) AS chronicle`, [imported.campaignId]
    )).resolves.toMatchObject({ rows: before.rows });
  });

  it("keeps v1 queue jobs without a text execution plan", async () => {
    const imported = await campaign();
    const queued = await repository().enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, appendRequest("Keep historical queue behavior."));
    await expect(pool.query<{ basis: unknown }>("SELECT orchestration_private->'textExecutionRouteBasis' AS basis FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ basis: null }] });
  });

  it("retains a frozen plan when a recoverable job is retried", async () => {
    const imported = await campaign();
    const commands = plannedRepository();
    const queued = await commands.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, appendRequest("Retry without changing route."));
    await pool.query("UPDATE generation_jobs SET status='recoverable',error_code='provider_unavailable' WHERE id=$1", [queued.id]);
    await expect(commands.retry({ ownerUserId, jobId: queued.id })).resolves.toMatchObject({ id: queued.id, status: "queued" });
    await expect(pool.query<{ basis: unknown }>("SELECT orchestration_private->'textExecutionRouteBasis' AS basis FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ basis: { routeBasisHash: frozenRouteBasis().routeBasisHash } }] });
  });

  it("retains a frozen plan after an expired lease is reclaimed", async () => {
    const imported = await campaign();
    const queued = await plannedRepository().enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId }, appendRequest("Reclaim the original frozen route.")
    );
    await pool.query("UPDATE generation_jobs SET status='failed',lease_owner=NULL,lease_expires_at=NULL WHERE id<>$1 AND status IN ('queued','replacement_queued','assessing','generating','validating','committing')", [queued.id]);
    const execution = createPostgresGenerationExecutionRepository(pool);
    const first = await execution.claimNext({ workerId: `first-${crypto.randomUUID()}`, leaseSeconds: 30 });
    expect(first?.jobId).toBe(queued.id);
    await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [queued.id]);
    const second = await execution.claimNext({ workerId: `second-${crypto.randomUUID()}`, leaseSeconds: 30 });
    expect(second).toMatchObject({ jobId: queued.id, attempts: 2 });
    await expect(pool.query<{ attempts: number; basis: unknown }>(
      "SELECT attempts,orchestration_private->'textExecutionRouteBasis' AS basis FROM generation_jobs WHERE id=$1", [queued.id]
    )).resolves.toMatchObject({ rows: [{ attempts: 2, basis: { routeBasisHash: frozenRouteBasis().routeBasisHash } }] });
    await pool.query("UPDATE generation_jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [queued.id]);
  });

  it("resumes a queued native route after ordinary profile edits with its saved limits and policy", async () => {
    const imported = await campaign();
    const basisWithoutHash = {
      version: 2 as const, selection: { kind: "openrouter_preset" as const, slug: "queued" },
      preset: { slug: "queued", versionId: "queued-v1", configHash: "c".repeat(64) },
      candidates: [{ modelId: "queued-model", providerPolicy: { order: ["queued-model"] }, contextWindowTokens: 12000, maxOutputTokens: 1400 }],
      presetSystemPrompt: "Saved queue prompt.", parameters: { temperature: 0.21 }, endpointReference: "provider-endpoint",
      credentialReference: providerProfileId, profileRevision: "b".repeat(64), authorityRevision: "a".repeat(64), requestTimeoutMs: 23456,
      protocolVersion: "text-execution-route-basis-v2"
    };
    const basis = { ...basisWithoutHash, routeBasisHash: sha256(stableStringify(basisWithoutHash)) };
    const commands = plannedRepository(async () => basis);
    const workerId = `saved-route-${crypto.randomUUID()}`;
    const queued = await commands.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, appendRequest("Resume the frozen native queue."));
    await pool.query("UPDATE provider_profiles SET temperature=0.91,request_timeout_ms=98765,configuration=$2::jsonb WHERE id=$1", [providerProfileId, JSON.stringify({ changed: true })]);
    await pool.query("UPDATE generation_jobs SET status='recoverable',error_code='provider_unavailable' WHERE id=$1", [queued.id]);
    await expect(commands.retry({ ownerUserId, jobId: queued.id })).resolves.toMatchObject({ status: "queued" });
    const execution = createPostgresGenerationExecutionRepository(pool);
    const claim = await execution.claimNext({ workerId, leaseSeconds: 30 });
    const payload = await execution.loadExecutionPayload({ workerId, leaseSeconds: 30, claim: claim! });
    expect(payload?.orchestration_private?.textExecutionRouteBasis).toMatchObject({
      routeBasisHash: basis.routeBasisHash, parameters: { temperature: 0.21 }, requestTimeoutMs: 23456,
      candidates: [{ modelId: "queued-model", providerPolicy: { order: ["queued-model"] }, contextWindowTokens: 12000, maxOutputTokens: 1400 }]
    });
    await pool.query("UPDATE generation_jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [queued.id]);
    await pool.query("UPDATE provider_profiles SET temperature=0,request_timeout_ms=300000,configuration='{}'::jsonb WHERE id=$1", [providerProfileId]);
  });

  it("rejects post-queue plan tampering at the database immutability fence", async () => {
    const imported = await campaign();
    const queued = await plannedRepository().enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, appendRequest("Reject tampering before dispatch."));
    const execution = createPostgresGenerationExecutionRepository(pool);
    const workerId = `tamper-${crypto.randomUUID()}`;
    await pool.query("UPDATE generation_jobs SET status='failed',lease_owner=NULL,lease_expires_at=NULL WHERE id<>$1 AND status IN ('queued','replacement_queued','assessing','generating','validating','committing')", [queued.id]);
    const claim = await execution.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    await expect(pool.query(
      "UPDATE generation_jobs SET orchestration_private=jsonb_set(orchestration_private,'{textExecutionRouteBasis,routeBasisHash}',$2::jsonb) WHERE id=$1",
      [queued.id, JSON.stringify("b".repeat(64))]
    )).rejects.toThrow(/immutable/i);
    await expect(execution.loadExecutionPayload({ workerId, leaseSeconds: 30, claim: claim! }))
      .resolves.toMatchObject({ orchestration_private: { textExecutionRouteBasis: { routeBasisHash: frozenRouteBasis().routeBasisHash } } });
    await pool.query("UPDATE generation_jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [queued.id]);
  });

  it("freezes ordinary metadata-time edits while rejecting credential and campaign authority changes", async () => {
    const alternateProvider = await createProvider(pool, {
      name: `Alternate native preset ${crypto.randomUUID()}`, providerType: "openrouter", providerRole: "text",
      baseUrl: "https://openrouter.ai/api/v1", defaultModel: "alternate-model", contextWindowTokens: 32768,
      maxOutputTokens: 4096, temperature: 0, enabled: true, configuration: {}
    }, credentialSecret);
    const presetProvider = await createProvider(pool, {
      name: `Native preset ${crypto.randomUUID()}`, providerType: "openrouter", providerRole: "text",
      baseUrl: "https://openrouter.ai/api/v1", defaultModel: "@preset/test",
      contextWindowTokens: 32768, maxOutputTokens: 4096, temperature: 0, enabled: true, configuration: {}, apiKey: "before-rotation"
    }, credentialSecret);
    await pool.query("UPDATE provider_profiles SET text_selection=$2::jsonb WHERE id=$1", [presetProvider.id, JSON.stringify({ kind: "openrouter_preset", slug: "test" })]);
    await expect(loadPrivateProviderCredentialRow(pool as unknown as DatabaseClient, ownerUserId, presetProvider.id)).resolves.toMatchObject({
      textSelection: { kind: "openrouter_preset", slug: "test" }
    });
    let activeTransactions = 0;
    const trackQuery = (target: { query: (...argumentsList: any[]) => any }) => async (...argumentsList: any[]) => {
      const statement = typeof argumentsList[0] === "string" ? argumentsList[0] : argumentsList[0]?.text;
      if (statement === "BEGIN") activeTransactions += 1;
      try { return await target.query(...argumentsList); }
      finally { if (statement === "COMMIT" || statement === "ROLLBACK") activeTransactions -= 1; }
    };
    const trackedPool = new Proxy(pool, {
      get(target, property, receiver) {
        if (property === "query") return trackQuery(target as unknown as { query: (...argumentsList: any[]) => any });
        if (property === "connect") return async () => {
          const client = await target.connect();
          return new Proxy(client, { get(clientTarget, clientProperty, clientReceiver) {
            if (clientProperty === "query") return trackQuery(clientTarget as unknown as { query: (...argumentsList: any[]) => any });
            const value = Reflect.get(clientTarget, clientProperty, clientReceiver);
            return typeof value === "function" ? value.bind(clientTarget) : value;
          }});
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as DatabasePool;
    const descriptor = async (database: DatabaseClient | DatabasePool, id: string, model?: string) => {
      const row = await loadPrivateProviderCredentialRow(database as DatabaseClient, ownerUserId, id);
      if (!row) throw new Error("Expected a real enabled provider profile.");
      return { id: row.providerProfileId, name: row.name, providerRole: "text" as const, providerType: row.providerType,
        model: model?.trim() || row.defaultModel, contextWindowTokens: row.contextWindowTokens, maxOutputTokens: row.maxOutputTokens,
        temperature: row.temperature, requestTimeoutMs: row.requestTimeoutMs, endpointIdentity: row.baseUrl,
        executionRevision: row.executionRevision,
        authorityRevision: createHash("sha256").update(JSON.stringify({ providerProfileId: row.providerProfileId, providerRole: row.providerRole, baseUrl: row.baseUrl, credential: row.encryptedCredential })).digest("hex"),
        ...(row.textSelection ? { textSelection: row.textSelection } : {}), configuration: row.configuration };
    };
    for (const mutation of ["profile", "credential", "campaign-default"] as const) {
      const imported = await campaign();
      await pool.query("UPDATE campaigns SET text_provider_profile_id=$2 WHERE id=$1", [imported.campaignId, presetProvider.id]);
      let metadataCalls = 0;
      const mutate = async () => {
        if (mutation === "profile") await pool.query("UPDATE provider_profiles SET max_output_tokens=max_output_tokens+1 WHERE id=$1", [presetProvider.id]);
        if (mutation === "credential") await writeEncryptedProviderCredential(pool as unknown as DatabaseClient, ownerUserId, presetProvider.id, { ciphertext: `rotated-${crypto.randomUUID()}`, nonce: "rotated-nonce", authTag: "rotated-tag", keyVersion: 1 });
        if (mutation === "campaign-default") await pool.query("UPDATE campaigns SET text_provider_profile_id=$2 WHERE id=$1", [imported.campaignId, alternateProvider.id]);
      };
      const collaborators = {
        execution: { text: async (scope: { ownerUserId: string }, id: string) => descriptor(pool, id) },
        loadQueuedTextProfile: (client: DatabaseClient, _owner: string, id: string, model?: string) => descriptor(client, id, model),
        responseFormatInventory: {
          getPreset: async () => { expect(activeTransactions).toBe(0); metadataCalls += 1; await mutate(); return { providerProfileId: presetProvider.id, preset: { slug: "test", versionId: "v1", config: { model: "preset-model" }, configHash: "c".repeat(64) } }; },
          listModels: async () => { expect(activeTransactions).toBe(0); metadataCalls += 1; return { providerProfileId: presetProvider.id, providerRole: "text" as const, models: [{ id: "preset-model", name: "Preset", contextWindowTokens: 32768 }] }; }
        }, responseFormatCapabilities: { registryDigest: "d".repeat(64) }, promptTools: { protocolVersion: () => "test" }, prompts: {}, costs: {}, reads: { getTurnCosts: async () => new Map() }
      } as never;
      const app = createApiGenerationApplication(trackedPool, collaborators, undefined, { installedCapability: "r3", enforceEnabled: true }, true);
      const { providerProfileId: _ignored, ...campaignRequest } = appendRequest(`Reject real ${mutation} changes.`);
      const enqueue = app.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse(campaignRequest));
      if (mutation === "profile") {
        const queued = await enqueue;
        await expect(pool.query<{ basis: TextExecutionRouteBasis }>(
          "SELECT orchestration_private->'textExecutionRouteBasis' AS basis FROM generation_jobs WHERE id=$1", [queued.id]
        )).resolves.toMatchObject({ rows: [{ basis: { profileRevision: expect.any(String), candidates: [{ maxOutputTokens: 4096 }] } }] });
        await app.cancel({ ownerUserId, jobId: queued.id });
      } else {
        await expect(enqueue).rejects.toMatchObject({ kind: "conflict", details: { reason: "provider_profile_changed_refresh_required" } });
      }
      expect(metadataCalls).toBe(2);
      await expect(pool.query<{ count: string }>("SELECT count(*)::text AS count FROM generation_jobs WHERE campaign_id=$1", [imported.campaignId]))
        .resolves.toMatchObject({ rows: [{ count: mutation === "profile" ? "1" : "0" }] });
    }
  });

  it("verifies an explicit model without preset metadata and short-circuits missing or foreign campaigns", async () => {
    let profileCalls = 0;
    let presetCalls = 0;
    let modelCalls = 0;
    const profile = { id: providerProfileId, name: "preset", providerRole: "text" as const, providerType: "openrouter" as const,
      model: "@preset/test", contextWindowTokens: 32768, maxOutputTokens: 4096, temperature: 0, requestTimeoutMs: 1000,
      endpointIdentity: "endpoint", executionRevision: "a".repeat(64), authorityRevision: "b".repeat(64),
      textSelection: { kind: "openrouter_preset" as const, slug: "test" }, configuration: {} };
    const collaborators = { execution: { text: async () => { profileCalls += 1; return profile; } }, loadQueuedTextProfile: async (_client: DatabaseClient, _owner: string, _id: string, model?: string) => ({ ...profile, model: model?.trim() || profile.model }),
      responseFormatInventory: {
        getPreset: async () => { presetCalls += 1; throw new Error("Preset metadata must not be called for an explicit model."); },
        listModels: async () => {
          modelCalls += 1;
          return { providerProfileId, providerRole: "text" as const, models: [{
            id: "direct-model", name: "Direct", contextWindowTokens: 32_768, maxOutputTokens: 4_096,
            responseFormatAdvertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: "2026-09-20T00:00:00.000Z" }
          }] };
        }
      },
      responseFormatCapabilities: {
        registryDigest: "d".repeat(64), now: () => "2026-09-20T00:00:00.000Z",
        eligibilityV2: (input: { operation: Parameters<typeof getProviderOutputSchemaV2>[0]; streaming: boolean }) => ({
          status: "verified" as const,
          verification: {
            version: 2 as const, providerType: "openrouter" as const, endpointIdentity: profile.endpointIdentity,
            model: "direct-model", routeConfigHash: capabilityRouteConfigHash(profile.configuration),
            adapterProtocol: "text-schema-adapter-v2" as const, operation: input.operation,
            schemaHash: getProviderOutputSchemaV2(input.operation).schemaHash, streaming: input.streaming,
            verifiedAt: "2026-09-19T00:00:00.000Z", expiresAt: "2026-09-21T00:00:00.000Z",
            providerRoutingSlugs: [], nativeOpenTrackerObjects: true
          }
        })
      }, promptTools: { protocolVersion: () => "test" }, prompts: {}, costs: {}, reads: { getTurnCosts: async () => new Map() } } as never;
    const disabledCampaign = await campaign();
    const disabled = createApiGenerationApplication(pool, collaborators, undefined, { installedCapability: "r3", enforceEnabled: true }, false);
    await disabled.enqueueAppend({ ownerUserId, campaignId: disabledCampaign.campaignId }, appendRequest("Keep admission disabled."));
    expect(profileCalls).toBe(0);
    expect(presetCalls).toBe(0);
    expect(modelCalls).toBe(0);
    const app = createApiGenerationApplication(pool, collaborators, undefined, { installedCapability: "r3", enforceEnabled: true }, true);
    const imported = await campaign();
    await app.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ ...appendRequest("Use the direct model."), model: "direct-model" }));
    expect(presetCalls).toBe(0);
    expect(modelCalls).toBe(2);
    const foreignCampaignId = crypto.randomUUID();
    await expect(app.enqueueAppend({ ownerUserId, campaignId: foreignCampaignId }, appendRequest("Do not discover a missing campaign.")))
      .rejects.toMatchObject({ kind: "not_found", details: { campaignId: foreignCampaignId } });
    expect(profileCalls).toBe(2);
    expect(presetCalls).toBe(0);
    expect(modelCalls).toBe(2);
    const foreignOwner = await pool.query<{ id: string }>("INSERT INTO users (display_name) VALUES ('Native preflight foreign owner') RETURNING id");
    const foreignWorld = await pool.query<{ id: string }>("INSERT INTO worlds (owner_user_id,title) VALUES ($1,'Native preflight foreign world') RETURNING id", [foreignOwner.rows[0]!.id]);
    const foreignVersion = await pool.query<{ id: string }>("INSERT INTO world_versions (world_id,owner_user_id,version_number,content) VALUES ($1,$2,1,'{}'::jsonb) RETURNING id", [foreignWorld.rows[0]!.id, foreignOwner.rows[0]!.id]);
    const foreignCampaign = await pool.query<{ id: string }>("INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,'Native preflight foreign campaign') RETURNING id", [foreignOwner.rows[0]!.id, foreignVersion.rows[0]!.id]);
    await expect(app.enqueueAppend({ ownerUserId, campaignId: foreignCampaign.rows[0]!.id }, appendRequest("Do not discover a foreign campaign.")))
      .rejects.toMatchObject({ kind: "not_found", details: { campaignId: foreignCampaign.rows[0]!.id } });
    expect(profileCalls).toBe(2);
    expect(presetCalls).toBe(0);
    expect(modelCalls).toBe(2);
  });

  it("preflights an owner-default preset when the campaign has no provider binding", async () => {
    const imported = await campaign();
    const defaultPreset = await createProvider(pool, {
      name: `Default native preset ${crypto.randomUUID()}`, providerType: "openrouter", providerRole: "text",
      baseUrl: "https://openrouter.ai/api/v1", defaultModel: "@preset/default", contextWindowTokens: 32768,
      maxOutputTokens: 4096, temperature: 0, enabled: true, configuration: {}
    }, credentialSecret);
    await pool.query("UPDATE provider_profiles SET is_default=true,text_selection=$2::jsonb WHERE id=$1", [defaultPreset.id, JSON.stringify({ kind: "openrouter_preset", slug: "default" })]);
    try {
      await pool.query("UPDATE campaigns SET text_provider_profile_id=NULL WHERE id=$1", [imported.campaignId]);
      let metadataCalls = 0;
      const profile = { id: defaultPreset.id, name: "default", providerRole: "text" as const, providerType: "openrouter" as const,
        model: "@preset/default", contextWindowTokens: 32768, maxOutputTokens: 4096, temperature: 0, requestTimeoutMs: 1000,
        endpointIdentity: "endpoint", executionRevision: "a".repeat(64), authorityRevision: "b".repeat(64), textSelection: { kind: "openrouter_preset" as const, slug: "default" }, configuration: {} };
      const collaborators = { execution: { text: async () => profile }, loadQueuedTextProfile: async () => profile,
        responseFormatInventory: {
          getPreset: async () => { metadataCalls += 1; return { providerProfileId: defaultPreset.id, preset: { slug: "default", versionId: "v1", config: { model: "preset-model" }, configHash: "c".repeat(64) } }; },
          listModels: async () => { metadataCalls += 1; return { providerProfileId: defaultPreset.id, providerRole: "text" as const, models: [{ id: "preset-model", name: "Preset", contextWindowTokens: 32768 }] }; }
        }, responseFormatCapabilities: { registryDigest: "d".repeat(64) }, promptTools: { protocolVersion: () => "test" }, prompts: {}, costs: {}, reads: { getTurnCosts: async () => new Map() } } as never;
      const app = createApiGenerationApplication(pool, collaborators, undefined, { installedCapability: "r3", enforceEnabled: true }, true);
      const { providerProfileId: _ignored, ...defaultRequest } = appendRequest("Freeze the owner default preset.");
      await app.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse(defaultRequest));
      expect(metadataCalls).toBe(2);
      await expect(pool.query<{ providerProfileId: string; basis: unknown }>(
        "SELECT provider_profile_id AS \"providerProfileId\",orchestration_private->'textExecutionRouteBasis' AS basis FROM generation_jobs WHERE campaign_id=$1", [imported.campaignId]
      )).resolves.toMatchObject({ rows: [{ providerProfileId: defaultPreset.id, basis: { version: 2, preset: { slug: "default" }, authorityRevision: "b".repeat(64), parameters: { temperature: 0 }, requestTimeoutMs: 1000 } }] });
    } finally {
      await pool.query("UPDATE provider_profiles SET is_default=false WHERE id=$1", [defaultPreset.id]);
    }
  });

  it("freezes typed and exact legacy preset overrides through the API while a concrete model replaces inheritance", async () => {
    const nativeProvider = await createProvider(pool, {
      name: `API native override ${crypto.randomUUID()}`, providerType: "openrouter", providerRole: "text",
      baseUrl: "https://openrouter.ai/api/v1", defaultModel: "@preset/inherited", contextWindowTokens: 32768,
      maxOutputTokens: 4096, temperature: 0.35, enabled: true, configuration: {
        textExecutionOverrides: { parameters: { temperature: 0.2, max_tokens: 1_000 }, conservativeContextWindowTokens: 12_000 }
      }
    }, credentialSecret);
    await pool.query("UPDATE provider_profiles SET text_selection=$2::jsonb WHERE id=$1", [
      nativeProvider.id, JSON.stringify({ kind: "openrouter_preset", slug: "inherited" })
    ]);
    const metadataCalls: string[] = [];
    const profile = {
      id: nativeProvider.id, name: "API native override", providerRole: "text" as const, providerType: "openrouter" as const,
      model: "@preset/inherited", contextWindowTokens: 32768, maxOutputTokens: 4096, temperature: 0.35,
      requestTimeoutMs: 1_000, endpointIdentity: "api-native-endpoint", executionRevision: "e".repeat(64),
      authorityRevision: "a".repeat(64), textSelection: { kind: "openrouter_preset" as const, slug: "inherited" },
      configuration: { textExecutionOverrides: { parameters: { temperature: 0.2, max_tokens: 1_000 }, conservativeContextWindowTokens: 12_000 } }
    };
    const collaborators = {
      execution: { text: async () => profile },
      loadQueuedTextProfile: async (_client: DatabaseClient, _ownerUserId: string, _providerProfileId: string, model?: string) => ({
        ...profile, model: model?.trim() || profile.model
      }),
      responseFormatInventory: {
        getPreset: async ({ slug }: { slug: string }) => {
          metadataCalls.push(`preset:${slug}`);
          return { providerProfileId: nativeProvider.id, preset: {
            slug, versionId: `${slug}-v1`, systemPrompt: `${slug} system prompt`, config: { model: `${slug}-model` }, configHash: sha256(`${slug}-config`)
          } };
        },
        listModels: async () => {
          metadataCalls.push("models");
          return { providerProfileId: nativeProvider.id, providerRole: "text" as const, models: [
            { id: "typed-model", name: "Typed", contextWindowTokens: 32768 },
            { id: "legacy-model", name: "Legacy", contextWindowTokens: 32768 },
            { id: "concrete-model", name: "Concrete", contextWindowTokens: 32768,
              responseFormatAdvertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: "2026-09-20T00:00:00.000Z" } }
          ] };
        }
      },
      responseFormatCapabilities: {
        registryDigest: "d".repeat(64), now: () => "2026-09-20T00:00:00.000Z",
        eligibilityV2: (input: { operation: Parameters<typeof getProviderOutputSchemaV2>[0]; streaming: boolean }) => ({
          status: "verified" as const,
          verification: {
            version: 2 as const, providerType: "openrouter" as const, endpointIdentity: profile.endpointIdentity,
            model: "concrete-model", routeConfigHash: capabilityRouteConfigHash(profile.configuration),
            adapterProtocol: "text-schema-adapter-v2" as const, operation: input.operation,
            schemaHash: getProviderOutputSchemaV2(input.operation).schemaHash, streaming: input.streaming,
            verifiedAt: "2026-09-19T00:00:00.000Z", expiresAt: "2026-09-21T00:00:00.000Z",
            providerRoutingSlugs: [], nativeOpenTrackerObjects: true
          }
        })
      }, promptTools: { protocolVersion: () => "test" },
      prompts: {}, costs: {}, reads: { getTurnCosts: async () => new Map() }
    } as never;
    const app = createApiGenerationApplication(pool, collaborators, undefined, { installedCapability: "r3", enforceEnabled: true }, true);
    const inheritedCampaign = await campaign();
    const typedCampaign = await campaign();
    const requestOverrideCampaign = await campaign();
    const typedReplacementCampaign = await campaign();
    const concreteReplacementCampaign = await campaign();
    const legacyCampaign = await campaign();
    await pool.query("UPDATE campaigns SET text_provider_profile_id=$2 WHERE id = ANY($1::uuid[])", [
      [inheritedCampaign.campaignId, typedCampaign.campaignId, requestOverrideCampaign.campaignId, typedReplacementCampaign.campaignId, concreteReplacementCampaign.campaignId, legacyCampaign.campaignId], nativeProvider.id
    ]);
    const inherited = await app.enqueueAppend({ ownerUserId, campaignId: inheritedCampaign.campaignId }, generationRequestSchema.parse({
      ...appendRequest("Freeze saved overrides for the inherited preset."), providerProfileId: nativeProvider.id
    }));
    await expect(pool.query<{ basis: unknown }>(
      "SELECT orchestration_private->'textExecutionRouteBasis' AS basis FROM generation_jobs WHERE id=$1", [inherited.id]
    )).resolves.toMatchObject({ rows: [{ basis: {
      selection: { kind: "openrouter_preset", slug: "inherited" }, parameters: { temperature: 0.2, max_tokens: 1_000 },
      candidates: [{ contextWindowTokens: 12_000, maxOutputTokens: 1_000 }]
    } }] });
    const typedRequest = generationRequestSchema.parse({
      ...appendRequest("Freeze the typed API preset."), providerProfileId: nativeProvider.id,
      textSelection: { kind: "openrouter_preset", slug: "typed" }
    });
    const typed = await app.enqueueAppend({ ownerUserId, campaignId: typedCampaign.campaignId }, typedRequest);
    const replay = await app.enqueueAppend({ ownerUserId, campaignId: typedCampaign.campaignId }, typedRequest);
    expect(replay).toMatchObject({ id: typed.id, duplicate: true });
    expect(metadataCalls).toEqual(["preset:inherited", "models", "preset:typed", "models"]);
    await expect(pool.query<{ basis: unknown }>(
      "SELECT orchestration_private->'textExecutionRouteBasis' AS basis FROM generation_jobs WHERE id=$1", [typed.id]
    )).resolves.toMatchObject({ rows: [{ basis: {
      selection: { kind: "openrouter_preset", slug: "typed" }, preset: { slug: "typed" }, presetSystemPrompt: "typed system prompt",
      parameters: { temperature: 0.35 }, candidates: [{ contextWindowTokens: 32_768, maxOutputTokens: 4_096 }]
    } }] });

    const requested = await app.enqueueAppend({ ownerUserId, campaignId: requestOverrideCampaign.campaignId }, generationRequestSchema.parse({
      ...appendRequest("Replace saved overrides on a different preset."), providerProfileId: nativeProvider.id,
      textSelection: { kind: "openrouter_preset", slug: "typed" },
      textExecutionOverrides: { parameters: { temperature: 0.11 }, conservativeContextWindowTokens: 8_000 }
    }));
    await expect(pool.query<{ basis: unknown }>(
      "SELECT orchestration_private->'textExecutionRouteBasis' AS basis FROM generation_jobs WHERE id=$1", [requested.id]
    )).resolves.toMatchObject({ rows: [{ basis: {
      selection: { kind: "openrouter_preset", slug: "typed" }, parameters: { temperature: 0.11 },
      candidates: [{ contextWindowTokens: 8_000, maxOutputTokens: 4_096 }]
    } }] });

    const typedReplacement = await app.enqueueReplacement({ ownerUserId, campaignId: typedReplacementCampaign.campaignId }, generationRetryLatestRequestSchema.parse({
      ...replacementRequest("Freeze the typed replacement preset."), providerProfileId: nativeProvider.id,
      textSelection: { kind: "openrouter_preset", slug: "typed" }
    }));
    await expect(pool.query<{ basis: unknown }>(
      "SELECT orchestration_private->'textExecutionRouteBasis' AS basis FROM generation_jobs WHERE id=$1", [typedReplacement.id]
    )).resolves.toMatchObject({ rows: [{ basis: {
      selection: { kind: "openrouter_preset", slug: "typed" }, preset: { slug: "typed" }, presetSystemPrompt: "typed system prompt"
    } }] });
    expect(metadataCalls).toEqual(["preset:inherited", "models", "preset:typed", "models", "preset:typed", "models", "preset:typed", "models"]);

    const replacement = await app.enqueueReplacement({ ownerUserId, campaignId: concreteReplacementCampaign.campaignId }, generationRetryLatestRequestSchema.parse({
      ...replacementRequest("Replace inherited routing with a concrete model."), providerProfileId: nativeProvider.id,
      textSelection: { kind: "model", modelId: "concrete-model" }
    }));
    await expect(pool.query<{ basis: unknown }>(
      "SELECT orchestration_private->'textExecutionRouteBasis' AS basis FROM generation_jobs WHERE id=$1", [replacement.id]
    )).resolves.toMatchObject({ rows: [{ basis: {
      selection: { kind: "model", modelId: "concrete-model" }, parameters: { temperature: 0.35 },
      candidates: [{ contextWindowTokens: 32_768, maxOutputTokens: 4_096 }]
    } }] });
    expect(metadataCalls).toEqual(["preset:inherited", "models", "preset:typed", "models", "preset:typed", "models", "preset:typed", "models", "models", "models"]);

    const legacy = await app.enqueueAppend({ ownerUserId, campaignId: legacyCampaign.campaignId }, generationRequestSchema.parse({
      ...appendRequest("Freeze the exact legacy preset alias."), providerProfileId: nativeProvider.id, model: "@preset/legacy"
    }));
    await expect(pool.query<{ basis: unknown }>(
      "SELECT orchestration_private->'textExecutionRouteBasis' AS basis FROM generation_jobs WHERE id=$1", [legacy.id]
    )).resolves.toMatchObject({ rows: [{ basis: {
      selection: { kind: "openrouter_preset", slug: "legacy" }, preset: { slug: "legacy" }, presetSystemPrompt: "legacy system prompt"
    } }] });
    expect(metadataCalls).toEqual(["preset:inherited", "models", "preset:typed", "models", "preset:typed", "models", "preset:typed", "models", "models", "models", "preset:legacy", "models"]);
    await app.cancel({ ownerUserId, jobId: inherited.id });
    await app.cancel({ ownerUserId, jobId: typed.id });
    await app.cancel({ ownerUserId, jobId: requested.id });
    await app.cancel({ ownerUserId, jobId: typedReplacement.id });
    await app.cancel({ ownerUserId, jobId: replacement.id });
    await app.cancel({ ownerUserId, jobId: legacy.id });
  });

  it("freezes a v3 effective character identity for an enrolled append and replacement", async () => {
    const imported = await campaign();
    const replacementCampaign = await campaign();
    const commands = enrolledPolicyRepository();
    const append = await commands.enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      appendRequest("Freeze the selected cartographer.")
    );
    const replacement = await commands.enqueueReplacement(
      { ownerUserId, campaignId: replacementCampaign.campaignId },
      replacementRequest("Replace the latest cartographer scene.")
    );
    const identities = await pool.query<{ id: string; generation_base_identity: Record<string, unknown> }>(
      "SELECT id,generation_base_identity FROM generation_jobs WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[append.id, replacement.id]]
    );
    expect(identities.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ generation_base_identity: expect.objectContaining({
        version: "generation-base-v3", characterProfileRevision: expect.any(Number),
        characterProfileFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
      }) })
    ]));
  });

  function replacementRequest(
    action: string,
    idempotencyKey = crypto.randomUUID(),
    storyLengthProfileOverride?: "brief" | "standard" | "long" | "extended"
  ) {
    return generationRetryLatestRequestSchema.parse({
      action,
      providerProfileId,
      idempotencyKey,
      expectedCurrentTurnNumber: 2,
      ...(storyLengthProfileOverride ? { storyLengthProfileOverride } : {}),
      context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
    });
  }

  function autoRequest(action: string, classificationId: string) {
    return generationRequestSchema.parse({
      action,
      requestedInputMode: "auto",
      resolvedInputMode: "action",
      inputModeSource: "auto",
      classificationId,
      providerProfileId,
      idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
    });
  }

  async function latestTurnId(campaignId: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE campaign_id = $1 AND owner_user_id = $2 ORDER BY turn_number DESC LIMIT 1",
      [campaignId, ownerUserId]
    );
    return result.rows[0]!.id;
  }

  async function authoritativeCampaignSnapshot(campaignId: string) {
    const result = await pool.query<{ snapshot: unknown }>(
      `SELECT jsonb_build_object(
         'acceptedTurns', COALESCE((
           SELECT jsonb_agg(to_jsonb(turn_row) ORDER BY turn_row.turn_number)
             FROM turns turn_row
            WHERE turn_row.campaign_id = $1
              AND turn_row.owner_user_id = $2
              AND turn_row.accepted_at IS NOT NULL
         ), '[]'::jsonb),
         'campaignState', COALESCE((
           SELECT to_jsonb(campaign_state_row)
             FROM campaign_state campaign_state_row
            WHERE campaign_state_row.campaign_id = $1
              AND campaign_state_row.owner_user_id = $2
         ), '{}'::jsonb),
         'chronicle', COALESCE((
           SELECT jsonb_agg(to_jsonb(memory_row) ORDER BY memory_row.ordinal, memory_row.id)
             FROM chronicle_memories memory_row
            WHERE memory_row.campaign_id = $1
              AND memory_row.owner_user_id = $2
         ), '[]'::jsonb),
         'completedResultRows', COALESCE((
           SELECT jsonb_agg(to_jsonb(completed_job) ORDER BY completed_job.created_at, completed_job.id)
             FROM generation_jobs completed_job
            WHERE completed_job.campaign_id = $1
              AND completed_job.owner_user_id = $2
              AND completed_job.status = 'completed'
         ), '[]'::jsonb)
       ) AS snapshot`,
      [campaignId, ownerUserId]
    );
    return result.rows[0]!.snapshot;
  }

  async function directGenerationJob(
    campaignId: string,
    status: string,
    options: Readonly<{ resultTurnId?: string | null; expectedTurnNumber?: number }> = {}
  ): Promise<string> {
    const promptSnapshot = await loadPromptSnapshotForTest(pool, ownerUserId, campaignId);
    const result = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key, expected_turn_number,
         action, status, result_turn_id, completed_at, prompt_snapshot, prompt_protocol_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8::uuid IS NULL THEN NULL ELSE now() END,$9,$10) RETURNING id`,
      [ownerUserId, campaignId, providerProfileId, crypto.randomUUID(), options.expectedTurnNumber ?? 3,
        "Inspect the repository observatory.", status, options.resultTurnId ?? null,
        JSON.stringify(promptSnapshot), providerPromptProtocolVersion(promptSnapshot)]
    );
    return result.rows[0]!.id;
  }

  async function directTurnImageJob(campaignId: string, turnId: string, status: "queued" | "generating"): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO image_jobs (
         owner_user_id, campaign_id, turn_id, provider_profile_id, provider_type, requested_model,
         prompt, prompt_hash, target_type, status
       ) VALUES ($1,$2,$3,$4,'openai_compatible','repository-image-model',$5,$6,'turn_illustration',$7) RETURNING id`,
      [ownerUserId, campaignId, turnId, providerProfileId, "A quiet repository observatory.", sha256(`image-${crypto.randomUUID()}`), status]
    );
    return result.rows[0]!.id;
  }

  async function installGenerationInsertBarrier(campaignId: string, idempotencyKey?: string) {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const trigger = `hold_generation_insert_${suffix}`;
    const classId = Number.parseInt(suffix.slice(0, 7), 16);
    const objectId = Number.parseInt(suffix.slice(7, 14), 16);
    const holder = await pool.connect();
    const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await holder.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [classId, objectId]);
    await pool.query(`CREATE FUNCTION ${trigger}_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${classId}, ${objectId});
        RETURN NEW;
      END
    $$`);
    const idempotencyPredicate = idempotencyKey ? ` AND NEW.idempotency_key = '${idempotencyKey.replaceAll("'", "''")}'` : "";
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON generation_jobs
      FOR EACH ROW WHEN (NEW.campaign_id = '${campaignId}'::uuid${idempotencyPredicate}) EXECUTE FUNCTION ${trigger}_fn()`);
    return {
      wait: async () => expect.poll(async () => pool.query<{ pid: number }>(
        `SELECT activity.pid FROM pg_stat_activity activity
           WHERE activity.datname = current_database()
             AND activity.wait_event_type = 'Lock'
             AND $1 = ANY(pg_blocking_pids(activity.pid))`,
        [holderPid]
      ).then((result) => result.rows[0]?.pid), { timeout: 5_000 }).toBeTypeOf("number"),
      release: async () => holder.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [classId, objectId]),
      cleanup: async () => {
        await holder.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [classId, objectId]).catch(() => undefined);
        holder.release();
        await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON generation_jobs`);
        await pool.query(`DROP FUNCTION IF EXISTS ${trigger}_fn()`);
      }
    };
  }

  async function provisionalIllustrationChildren(campaignId: string, generationJobId: string) {
    const set = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_sets (
         owner_user_id, campaign_id, generation_job_id, source_text_hash, segment_word_count,
         images_per_segment, prompt_mode, status
       ) VALUES ($1,$2,$3,$4,500,1,'direct','provisional') RETURNING id`,
      [ownerUserId, campaignId, generationJobId, sha256(`set-${generationJobId}`)]
    );
    const segment = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_segments (
         owner_user_id, illustration_set_id, campaign_id, generation_job_id, ordinal,
         start_offset, end_offset, start_word, end_word, source_text, source_text_hash,
         direct_prompt, resolved_prompt, status
       ) VALUES ($1,$2,$3,$4,0,0,26,0,4,$5,$6,$7,$7,'completed') RETURNING id`,
      [ownerUserId, set.rows[0]!.id, campaignId, generationJobId, "A provisional observatory scene.",
        sha256(`segment-${generationJobId}`), "A provisional observatory scene."]
    );
    const image = await pool.query<{ id: string }>(
      `INSERT INTO image_jobs (
         owner_user_id, campaign_id, provider_profile_id, provider_type, requested_model,
         prompt, prompt_hash, target_type, generation_job_id, status
       ) VALUES ($1,$2,$3,'openai_compatible','repository-image-model',$4,$5,
         'streaming_illustration',$6,'generating') RETURNING id`,
      [ownerUserId, campaignId, providerProfileId, "A streaming observatory illustration.",
        sha256(`streaming-image-${generationJobId}`), generationJobId]
    );
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id, campaign_id, content_hash, storage_driver, storage_path, mime_type, byte_length
       ) VALUES ($1,$2,$3,'filesystem',$4,'image/png',1) RETURNING id`,
      [ownerUserId, campaignId, sha256(`provisional-asset-${generationJobId}`), `provisional/${generationJobId}.png`]
    );
    await pool.query(
      `INSERT INTO turn_illustration_segment_assets (segment_id, owner_user_id, asset_id, image_job_id, variant_index)
       VALUES ($1,$2,$3,$4,0)`,
      [segment.rows[0]!.id, ownerUserId, asset.rows[0]!.id, image.rows[0]!.id]
    );
    const assetReference = await pool.query<{ id: string }>(
      `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
       VALUES ($1,$2,$3,NULL,'turn_illustration') RETURNING id`,
      [ownerUserId, asset.rows[0]!.id, campaignId]
    );
    const prompt = await pool.query<{ id: string }>(
      `INSERT INTO illustration_prompt_jobs (
         owner_user_id, campaign_id, segment_id, provider_profile_id, status
       ) VALUES ($1,$2,$3,$4,'queued') RETURNING id`,
      [ownerUserId, campaignId, segment.rows[0]!.id, providerProfileId]
    );
    const resolution = await pool.query<{ id: string }>(
      `INSERT INTO illustration_resolution_jobs (
         owner_user_id, campaign_id, segment_id, source_policy, matching_scope,
         confidence_profile, query_context_snapshot, selected_asset_id, status
       ) VALUES ($1,$2,$3,'library_only','campaign','balanced','{}'::jsonb,$4,'queued') RETURNING id`,
      [ownerUserId, campaignId, segment.rows[0]!.id, asset.rows[0]!.id]
    );
    return {
      setId: set.rows[0]!.id,
      segmentId: segment.rows[0]!.id,
      imageId: image.rows[0]!.id,
      assetId: asset.rows[0]!.id,
      assetReferenceId: assetReference.rows[0]!.id,
      promptId: prompt.rows[0]!.id,
      resolutionId: resolution.rows[0]!.id
    };
  }

  it("implements owner-scoped append reads and command state guards without transactions for reads", async () => {
    const imported = await campaign();
    const commands = repository();
    const idempotencyKey = crypto.randomUUID();
    const queued = await commands.enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      appendRequest("Open the repository observatory.", idempotencyKey)
    );

    expect(queued).toMatchObject({ status: "queued", duplicate: false, operationKind: "append", replacementTurnId: null });
    await expect(commands.enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      appendRequest("Open the repository observatory.", idempotencyKey)
    )).resolves.toMatchObject({ id: queued.id, duplicate: true, status: "queued", operationKind: "append" });
    await expect(commands.enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      appendRequest("Open a different repository observatory.", idempotencyKey)
    )).rejects.toMatchObject({ kind: "conflict", details: { reason: "idempotency_mismatch" } });
    await expect(commands.getJob({ ownerUserId, jobId: queued.id })).resolves.toMatchObject({ id: queued.id, status: "queued" });
    await expect(commands.getResult({ ownerUserId, jobId: queued.id }))
      .rejects.toMatchObject({ kind: "invalid_state", details: { reason: "result_not_completed", generationStatus: "queued" } });
    await expect(commands.retry({ ownerUserId, jobId: queued.id }))
      .rejects.toMatchObject({ kind: "invalid_state", details: { reason: "retry_source_state" } });
    await expect(commands.cancel({ ownerUserId, jobId: queued.id })).resolves.toMatchObject({ id: queued.id, status: "cancelled" });
    await expect(commands.cancel({ ownerUserId, jobId: queued.id })).resolves.toMatchObject({ id: queued.id, status: "cancelled" });
    await expect(commands.discard({ ownerUserId, jobId: queued.id }))
      .rejects.toMatchObject({ kind: "invalid_state", details: { reason: "discard_source_state" } });
  });

  it("snapshots the effective per-turn story-length profile into durable generation context", async () => {
    const imported = await campaign();
    const commands = repository();
    await pool.query("UPDATE campaigns SET story_length_profile = 'standard' WHERE id = $1", [imported.campaignId]);

    const overridden = await commands.enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      appendRequest("Use the extended repository observatory.", crypto.randomUUID(), "extended")
    );
    expect((await pool.query(
      "SELECT context_options FROM generation_jobs WHERE id = $1",
      [overridden.id]
    )).rows[0]?.context_options).toMatchObject({
      storyLengthProfile: "extended",
      narrationMinWords: 1200,
      narrationMaxWords: 2000
    });
    await commands.cancel({ ownerUserId, jobId: overridden.id });

    const defaulted = await commands.enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      appendRequest("Use the standard repository observatory.")
    );
    expect((await pool.query(
      "SELECT context_options FROM generation_jobs WHERE id = $1",
      [defaulted.id]
    )).rows[0]?.context_options).toMatchObject({
      storyLengthProfile: "standard",
      narrationMinWords: 450,
      narrationMaxWords: 900
    });
    await commands.cancel({ ownerUserId, jobId: defaulted.id });

    const replacement = await commands.enqueueReplacement(
      { ownerUserId, campaignId: imported.campaignId },
      replacementRequest("Use the brief replacement observatory.", crypto.randomUUID(), "brief")
    );
    expect((await pool.query(
      "SELECT context_options FROM generation_jobs WHERE id = $1",
      [replacement.id]
    )).rows[0]?.context_options).toMatchObject({
      storyLengthProfile: "brief",
      narrationMinWords: 250,
      narrationMaxWords: 450
    });
    await commands.cancel({ ownerUserId, jobId: replacement.id });

    const idempotencyKey = crypto.randomUUID();
    await commands.enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      appendRequest("Use one idempotency key for story length.", idempotencyKey, "brief")
    );
    await expect(commands.enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      appendRequest("Use one idempotency key for story length.", idempotencyKey, "long")
    )).rejects.toMatchObject({ kind: "conflict", details: { reason: "idempotency_mismatch" } });
  });

  it("persists append authority separately from replacement-only base fields", async () => {
    const imported = await campaign();
    const queued = await repository().enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      appendRequest("Capture the append authority observatory.")
    );

    await expect(pool.query<{ generation_base_identity: Record<string, unknown>; base_turn_number: number | null }>(
      "SELECT generation_base_identity, base_turn_number FROM generation_jobs WHERE id = $1",
      [queued.id]
    )).resolves.toMatchObject({ rows: [{
      base_turn_number: null,
      generation_base_identity: expect.objectContaining({
        operationKind: "append",
        expectedTurnNumber: 3,
        baseTurnNumber: 2
      })
    }] });
  });

  it("rejects fresh Auto generation requests without reading or consuming historical classifications", async () => {
    const imported = await campaign();
    const commands = repository();
    const action = "Open the Auto-classification observatory.";

    await expect(commands.enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      autoRequest(action, crypto.randomUUID())
    )).rejects.toMatchObject({ kind: "invalid_state", details: { reason: "turn_input_classification_removed" } });

    const classification = await pool.query<{ id: string }>(
      `INSERT INTO turn_input_classifications (
         owner_user_id, campaign_id, input_hash, classification, resolved_mode, confidence_band,
         provider_profile_id, provider_source, diagnostics
       ) VALUES ($1,$2,$3,'scene','scene','clear',$4,'story_text','{}'::jsonb) RETURNING id`,
      [ownerUserId, imported.campaignId, sha256(action), providerProfileId]
    );
    await expect(commands.enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      autoRequest(action, classification.rows[0]!.id)
    )).rejects.toMatchObject({ kind: "invalid_state", details: { reason: "turn_input_classification_removed" } });
    await expect(pool.query("SELECT consumed_at FROM turn_input_classifications WHERE id=$1", [classification.rows[0]!.id]))
      .resolves.toMatchObject({ rows: [{ consumed_at: null }] });
  });

  it("does not issue classification writes for rejected Auto input", async () => {
    const imported = await campaign();
    const { commands, statements } = recordingRepository();
    const action = "Open the owner-scoped Auto-classification observatory.";
    const classification = await pool.query<{ id: string }>(
      `INSERT INTO turn_input_classifications (
         owner_user_id, campaign_id, input_hash, classification, resolved_mode, confidence_band,
         provider_profile_id, provider_source, diagnostics
       ) VALUES ($1,$2,$3,'action','action','clear',$4,'story_text','{}'::jsonb) RETURNING id`,
      [ownerUserId, imported.campaignId, sha256(action), providerProfileId]
    );

    await expect(commands.enqueueAppend(
      { ownerUserId, campaignId: imported.campaignId },
      autoRequest(action, classification.rows[0]!.id)
    )).rejects.toMatchObject({ details: { reason: "turn_input_classification_removed" } });

    expect(statements.some((statement) => statement.startsWith("UPDATE turn_input_classifications"))).toBe(false);
  });

  it("rejects stale, missing, and actively illustrated latest turns while removing only queued latest-turn images", async () => {
    const commands = repository();
    const stale = await campaign();
    await expect(commands.enqueueReplacement(
      { ownerUserId, campaignId: stale.campaignId },
      generationRetryLatestRequestSchema.parse({
        ...replacementRequest("Rewrite a stale latest turn."),
        expectedCurrentTurnNumber: 1
      })
    )).rejects.toMatchObject({
      kind: "stale_turn",
      details: { reason: "stale_current_turn", expectedTurnNumber: 1, actualTurnNumber: 2 }
    });

    const missing = await campaign();
    await pool.query("DELETE FROM turns WHERE campaign_id = $1 AND owner_user_id = $2", [missing.campaignId, ownerUserId]);
    await expect(commands.enqueueReplacement(
      { ownerUserId, campaignId: missing.campaignId },
      replacementRequest("Rewrite a missing latest turn.")
    )).rejects.toMatchObject({ kind: "not_found", details: { reason: "missing_latest_turn" } });

    const activelyIllustrated = await campaign();
    const activeTurnId = await latestTurnId(activelyIllustrated.campaignId);
    await directTurnImageJob(activelyIllustrated.campaignId, activeTurnId, "generating");
    await expect(commands.enqueueReplacement(
      { ownerUserId, campaignId: activelyIllustrated.campaignId },
      replacementRequest("Rewrite while the illustration is generating.")
    )).rejects.toMatchObject({ kind: "active_job", details: { reason: "active_illustration" } });

    const queuedIllustration = await campaign();
    const queuedTurnId = await latestTurnId(queuedIllustration.campaignId);
    const queuedImageJobId = await directTurnImageJob(queuedIllustration.campaignId, queuedTurnId, "queued");
    await expect(commands.enqueueReplacement(
      { ownerUserId, campaignId: queuedIllustration.campaignId },
      replacementRequest("Rewrite after discarding the queued illustration.")
    )).resolves.toMatchObject({ status: "replacement_queued", duplicate: false });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM image_jobs WHERE id = $1",
      [queuedImageJobId]
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("keeps concurrent append requests to one campaign to one active durable job", async () => {
    const imported = await campaign();
    const commands = repository();
    const results = await Promise.allSettled([
      commands.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, appendRequest("Open the concurrent append archive.")),
      commands.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, appendRequest("Open the concurrent append observatory."))
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof commands.enqueueAppend>>> => result.status === "fulfilled"
    );
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value).toMatchObject({ status: "queued", duplicate: false, operationKind: "append" });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ kind: "active_job", details: { reason: "active_generation" } });
  });

  it("formats completed results and reports their single-currency turn cost", async () => {
    const imported = await campaign();
    const turnId = await latestTurnId(imported.campaignId);
    await pool.query(
      "UPDATE turns SET narration = $3, accepted_at = COALESCE(accepted_at, now()) WHERE id = $1 AND owner_user_id = $2",
      [turnId, ownerUserId, "The observatory door opens.\n\nStars spill across the archive floor."]
    );
    const jobId = await directGenerationJob(imported.campaignId, "completed", { resultTurnId: turnId, expectedTurnNumber: 2 });
    await pool.query(
      `INSERT INTO provider_cost_events (
         owner_user_id, campaign_id, turn_id, provider_profile_id, generation_job_id, provider_type,
         category, operation, requested_model, resolved_model, amount, currency
       ) VALUES ($1,$2,$3,$4,$5,'openai_compatible','story','story_generation',
         'repository-test-model','repository-test-model',0.25,'USD')`,
      [ownerUserId, imported.campaignId, turnId, providerProfileId, jobId]
    );

    await expect(repository().getResult({ ownerUserId, jobId })).resolves.toMatchObject({
      id: jobId,
      status: "completed",
      narration: "The observatory door opens.\n\nStars spill across the archive floor.",
      reportedCost: {
        amount: "0.250000000000",
        currency: "USD",
        byCategory: { story: "0.250000000000", image: "0", memory: "0" }
      }
    });
  });

  it("retries recoverable jobs and discards failed jobs without changing their campaign scope", async () => {
    const retryCampaign = await campaign();
    const retryJobId = await directGenerationJob(retryCampaign.campaignId, "recoverable");
    const retryCompletedJobId = await directGenerationJob(retryCampaign.campaignId, "completed", {
      resultTurnId: await latestTurnId(retryCampaign.campaignId),
      expectedTurnNumber: 2
    });
    const retryCommands = repository();
    const retryBefore = await authoritativeCampaignSnapshot(retryCampaign.campaignId);
    const retryResultBefore = await retryCommands.getResult({ ownerUserId, jobId: retryCompletedJobId });
    await expect(retryCommands.retry({ ownerUserId, jobId: retryJobId })).resolves.toMatchObject({
      id: retryJobId,
      status: "queued",
      operationKind: "append",
      replacementTurnId: null
    });
    await expect(authoritativeCampaignSnapshot(retryCampaign.campaignId)).resolves.toEqual(retryBefore);
    await expect(retryCommands.getResult({ ownerUserId, jobId: retryCompletedJobId })).resolves.toEqual(retryResultBefore);

    const discardCampaign = await campaign();
    const discardJobId = await directGenerationJob(discardCampaign.campaignId, "failed");
    const discardCompletedJobId = await directGenerationJob(discardCampaign.campaignId, "completed", {
      resultTurnId: await latestTurnId(discardCampaign.campaignId),
      expectedTurnNumber: 2
    });
    const discardCommands = repository();
    const discardBefore = await authoritativeCampaignSnapshot(discardCampaign.campaignId);
    const discardResultBefore = await discardCommands.getResult({ ownerUserId, jobId: discardCompletedJobId });
    await expect(discardCommands.discard({ ownerUserId, jobId: discardJobId })).resolves.toMatchObject({
      id: discardJobId,
      status: "discarded",
      operationKind: "append",
      replacementTurnId: null
    });
    await expect(pool.query<{ status: string; campaign_id: string }>(
      "SELECT status, campaign_id FROM generation_jobs WHERE id = $1",
      [discardJobId]
    )).resolves.toMatchObject({ rows: [{ status: "discarded", campaign_id: discardCampaign.campaignId }] });
    await expect(authoritativeCampaignSnapshot(discardCampaign.campaignId)).resolves.toEqual(discardBefore);
    await expect(discardCommands.getResult({ ownerUserId, jobId: discardCompletedJobId })).resolves.toEqual(discardResultBefore);
  });

  it("preserves the last safe failure diagnostic when a job is cancelled or discarded", async () => {
    const diagnostic = {
      version: 1,
      category: "provider_timeout",
      code: "provider_request_timeout",
      phase: "story_generation",
      attemptNumber: 1,
      occurredAt: "2026-09-18T00:00:00.000Z",
      privateMessage: "provider-specific detail is retained only in orchestration state"
    };
    const cancelledCampaign = await campaign();
    const cancelledJobId = await directGenerationJob(cancelledCampaign.campaignId, "queued");
    const discardedCampaign = await campaign();
    const discardedJobId = await directGenerationJob(discardedCampaign.campaignId, "failed");
    await pool.query(
      "UPDATE generation_jobs SET orchestration_private = jsonb_build_object('lastFailureDiagnostic', $2::jsonb) WHERE id = ANY($1::uuid[])",
      [[cancelledJobId, discardedJobId], JSON.stringify(diagnostic)]
    );

    await expect(repository().cancel({ ownerUserId, jobId: cancelledJobId })).resolves.toMatchObject({
      id: cancelledJobId, status: "cancelled"
    });
    await expect(repository().discard({ ownerUserId, jobId: discardedJobId })).resolves.toMatchObject({
      id: discardedJobId, status: "discarded"
    });
    const after = await pool.query<{ id: string; status: string; failure_diagnostic: unknown }>(
      `SELECT id, status, orchestration_private->'lastFailureDiagnostic' AS failure_diagnostic
         FROM generation_jobs WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[cancelledJobId, discardedJobId]]
    );
    expect(Object.fromEntries(after.rows.map((row) => [row.id, { status: row.status, failureDiagnostic: row.failure_diagnostic }]))).toEqual({
      [cancelledJobId]: { status: "cancelled", failureDiagnostic: diagnostic },
      [discardedJobId]: { status: "discarded", failureDiagnostic: diagnostic }
    });
  });

  it("rejects an incompatible retry without rewriting its durable prompt snapshot", async () => {
    const imported = await campaign();
    const jobId = await directGenerationJob(imported.campaignId, "recoverable");
    const before = (await pool.query<{ prompt_snapshot: Record<string, unknown>; prompt_protocol_version: string }>(
      `UPDATE generation_jobs
          SET prompt_snapshot = '{"story":"legacy instruction"}'::jsonb,
              prompt_protocol_version = 'story-v1'
        WHERE id = $1
        RETURNING prompt_snapshot, prompt_protocol_version`,
      [jobId]
    )).rows[0]!;
    await expect(repository().retry({ ownerUserId, jobId }))
      .rejects.toMatchObject({ kind: "conflict", details: { reason: "retry_protocol_incompatible" } });

    const after = (await pool.query<{ prompt_snapshot: Record<string, unknown>; prompt_protocol_version: string }>(
      "SELECT prompt_snapshot, prompt_protocol_version FROM generation_jobs WHERE id = $1",
      [jobId]
    )).rows[0]!;
    expect(after.prompt_snapshot).toEqual(before.prompt_snapshot);
    expect(after.prompt_protocol_version).toBe(before.prompt_protocol_version);
  });

  it.each(["scene", "action"] as const)("captures an immutable story-only policy for %s append input and rejects retired Auto after replay lookup", async (inputMode) => {
    const imported = await campaign();
    await pool.query("UPDATE campaigns SET turn_control_style = 'flexible_scene' WHERE id = $1 AND owner_user_id = $2", [imported.campaignId, ownerUserId]);
    const commands = repository();
    const key = crypto.randomUUID();
    const scene = generationRequestSchema.parse({
      action: "The observatory roof collapses in rain.", providerProfileId, idempotencyKey: key,
      requestedInputMode: inputMode, resolvedInputMode: inputMode, inputModeSource: "explicit",
      context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
    });
    const queued = await commands.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, scene);
    const stored = await commands.getJob({ ownerUserId, jobId: queued.id });
    expect(stored.generationPolicy).toMatchObject({
      version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1",
      prompts: { systemSupplementHash: expect.stringMatching(/^[a-f0-9]{64}$/) }
    });
    expect(stored.requestedInputMode).toBe("scene");
    expect(stored.inputModeSource).toBe("explicit");
    await pool.query("UPDATE campaigns SET turn_control_style = 'flexible_action' WHERE id = $1 AND owner_user_id = $2", [imported.campaignId, ownerUserId]);
    expect((await commands.getJob({ ownerUserId, jobId: queued.id })).generationPolicy).toEqual(stored.generationPolicy);

    const replay = await commands.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, scene);
    expect(replay).toMatchObject({ id: queued.id, duplicate: true });
    await expect(commands.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({
      ...scene, idempotencyKey: crypto.randomUUID(), requestedInputMode: "auto", resolvedInputMode: "action", inputModeSource: "auto", classificationId: crypto.randomUUID()
    }))).rejects.toMatchObject({ details: { reason: "turn_input_classification_removed" } });
  });

  it.each(["scene", "action"] as const)("persists a fresh Story Direction replacement policy for %s input", async (inputMode) => {
    const imported = await campaign();
    await pool.query("UPDATE campaigns SET turn_control_style = 'flexible_scene' WHERE id = $1", [imported.campaignId]);
    const replacement = await repository().enqueueReplacement({ ownerUserId, campaignId: imported.campaignId }, generationRetryLatestRequestSchema.parse({
      ...replacementRequest("Replace the observatory scene."), requestedInputMode: inputMode, resolvedInputMode: inputMode, inputModeSource: "explicit"
    }));
    const stored = (await pool.query("SELECT generation_policy, prompt_protocol_version, requested_input_mode, resolved_input_mode, input_mode_source FROM generation_jobs WHERE id = $1", [replacement.id])).rows[0]!;
    expect(stored).toMatchObject({ generation_policy: { version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1", prompts: { systemSupplementHash: expect.stringMatching(/^[a-f0-9]{64}$/), choiceRepairSystemHash: expect.stringMatching(/^[a-f0-9]{64}$/) } }, requested_input_mode: "scene", resolved_input_mode: "scene", input_mode_source: "explicit" });
    await pool.query("UPDATE campaigns SET turn_control_style = 'flexible_action' WHERE id = $1", [imported.campaignId]);
    await expect(pool.query("SELECT generation_policy, prompt_protocol_version FROM generation_jobs WHERE id = $1", [replacement.id])).resolves.toMatchObject({ rows: [{ generation_policy: stored.generation_policy, prompt_protocol_version: stored.prompt_protocol_version }] });
  });

  it("retains a fresh Action policy across retry", async () => {
    const imported = await campaign();
    const queued = await repository().enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({
      ...appendRequest("Take the lantern."), requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit"
    }));
    const before = (await pool.query("UPDATE generation_jobs SET status = 'recoverable' WHERE id = $1 RETURNING generation_policy, prompt_snapshot, prompt_protocol_version", [queued.id])).rows[0]!;
    expect(before.generation_policy).toEqual({ version: 1, playMode: "legacy", turnControlStyle: "flexible_action" });
    await expect(repository().retry({ ownerUserId, jobId: queued.id })).resolves.toMatchObject({ id: queued.id, status: "queued" });
    await expect(pool.query("SELECT generation_policy, prompt_snapshot, prompt_protocol_version FROM generation_jobs WHERE id = $1", [queued.id])).resolves.toMatchObject({ rows: [before] });
  });

  it("rejects a hash-mismatched frozen policy retry without rewriting the recoverable job", async () => {
    const imported = await campaign();
    await pool.query("UPDATE campaigns SET turn_control_style = 'flexible_scene' WHERE id = $1", [imported.campaignId]);
    const queued = await repository().enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({
      action: "Continue through the flooded archive.", providerProfileId, idempotencyKey: crypto.randomUUID(),
      requestedInputMode: "scene", resolvedInputMode: "scene", inputModeSource: "explicit",
      context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
    }));
    const original = (await pool.query<{
      status: string;
      generation_policy: { prompts: { systemSupplementHash: string } };
      prompt_snapshot: Record<string, unknown>;
      prompt_protocol_version: string;
    }>("SELECT status, generation_policy, prompt_snapshot, prompt_protocol_version FROM generation_jobs WHERE id = $1", [queued.id])).rows[0]!;
    const malformed = {
      ...original.generation_policy,
      prompts: { ...original.generation_policy.prompts, systemSupplementHash: "0".repeat(64) }
    };
    const before = (await pool.query<{
      status: string;
      generation_policy: unknown;
      prompt_snapshot: Record<string, unknown>;
      prompt_protocol_version: string;
    }>(
      "UPDATE generation_jobs SET status = 'recoverable', generation_policy = $2::jsonb WHERE id = $1 RETURNING status, generation_policy, prompt_snapshot, prompt_protocol_version",
      [queued.id, JSON.stringify(malformed)]
    )).rows[0]!;

    await expect(repository().retry({ ownerUserId, jobId: queued.id }))
      .rejects.toMatchObject({ kind: "conflict", details: { reason: "retry_protocol_incompatible" } });
    await expect(pool.query(
      "SELECT status, generation_policy, prompt_snapshot, prompt_protocol_version FROM generation_jobs WHERE id = $1",
      [queued.id]
    )).resolves.toMatchObject({ rows: [before] });
  });

  it("replays persisted historical Auto append and replacement jobs before retirement validation", async () => {
    const imported = await campaign();
    const commands = repository();
    const promptSnapshot = await loadPromptSnapshotForTest(pool, ownerUserId, imported.campaignId);
    const append = generationRequestSchema.parse({
      action: "Historical Auto append.", providerProfileId, idempotencyKey: crypto.randomUUID(),
      requestedInputMode: "auto", resolvedInputMode: "action", inputModeSource: "auto", classificationId: crypto.randomUUID(),
      context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
    });
    const replacement = generationRetryLatestRequestSchema.parse({
      ...append, action: "Historical Auto replacement.", idempotencyKey: crypto.randomUUID(), expectedCurrentTurnNumber: 2
    });
    const seed = async (request: typeof append | typeof replacement, operationKind: "append" | "replace_latest") => (
      await pool.query<{ id: string }>(
        `INSERT INTO generation_jobs (owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,
          requested_input_mode,resolved_input_mode,input_mode_source,turn_input_classification_id,operation_kind,replacement_turn_id,
          status,prompt_snapshot,prompt_protocol_version,recovery_metadata,generation_policy)
         VALUES ($1,$2,$3,$4,$5,$6,'auto','action','auto',NULL,$7,$8,$9,$10,$11,$12::jsonb,NULL) RETURNING id`,
        [ownerUserId, imported.campaignId, providerProfileId, request.idempotencyKey,
          operationKind === "append" ? 3 : 2, request.action, operationKind,
          operationKind === "append" ? null : await latestTurnId(imported.campaignId), operationKind === "append" ? "queued" : "failed",
          JSON.stringify(promptSnapshot), providerPromptProtocolVersion(promptSnapshot), JSON.stringify({ requestFingerprint: sha256(stableStringify(request)) })]
      )).rows[0]!.id;
    const appendId = await seed(append, "append");
    const replacementId = await seed(replacement, "replace_latest");
    await expect(commands.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, append))
      .resolves.toMatchObject({ id: appendId, duplicate: true });
    await expect(commands.enqueueReplacement({ ownerUserId, campaignId: imported.campaignId }, replacement))
      .resolves.toMatchObject({ id: replacementId, duplicate: true });
    await expect(commands.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, { ...append, action: "Changed historical request." }))
      .rejects.toMatchObject({ details: { reason: "idempotency_mismatch" } });
  });

  it("rejects a malformed retry snapshot even when its stored protocol hash matches", async () => {
    const imported = await campaign();
    const jobId = await directGenerationJob(imported.campaignId, "recoverable");
    const emptySnapshot = {};
    const before = (await pool.query<{
      status: string;
      prompt_snapshot: Record<string, unknown>;
      prompt_protocol_version: string;
    }>(
      `UPDATE generation_jobs
          SET prompt_snapshot = $2::jsonb, prompt_protocol_version = $3
        WHERE id = $1
        RETURNING status, prompt_snapshot, prompt_protocol_version`,
      [jobId, JSON.stringify(emptySnapshot), providerPromptProtocolVersion(emptySnapshot as never)]
    )).rows[0]!;
    const providerCallsBefore = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM generation_attempts WHERE generation_job_id = $1",
      [jobId]
    );

    await expect(repository().retry({ ownerUserId, jobId }))
      .rejects.toMatchObject({ kind: "conflict", details: { reason: "retry_protocol_incompatible" } });

    await expect(pool.query(
      "SELECT status, prompt_snapshot, prompt_protocol_version FROM generation_jobs WHERE id = $1",
      [jobId]
    )).resolves.toMatchObject({ rows: [before] });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM generation_attempts WHERE generation_job_id = $1",
      [jobId]
    )).resolves.toEqual(providerCallsBefore);
  });

  it("leaves completed result data and authoritative campaign records intact on invalid mutations", async () => {
    const imported = await campaign();
    const turnId = await latestTurnId(imported.campaignId);
    const completedJobId = await directGenerationJob(imported.campaignId, "completed", { resultTurnId: turnId, expectedTurnNumber: 2 });
    const commands = repository();
    const before = await authoritativeCampaignSnapshot(imported.campaignId);
    const resultBefore = await commands.getResult({ ownerUserId, jobId: completedJobId });

    await expect(commands.retry({ ownerUserId, jobId: completedJobId }))
      .rejects.toMatchObject({ kind: "invalid_state", details: { reason: "retry_source_state" } });
    await expect(commands.cancel({ ownerUserId, jobId: completedJobId }))
      .rejects.toMatchObject({ kind: "invalid_state", details: { reason: "cancel_source_state" } });
    await expect(commands.discard({ ownerUserId, jobId: completedJobId }))
      .rejects.toMatchObject({ kind: "invalid_state", details: { reason: "discard_source_state" } });

    await expect(commands.getResult({ ownerUserId, jobId: completedJobId })).resolves.toEqual(resultBefore);
    await expect(authoritativeCampaignSnapshot(imported.campaignId)).resolves.toEqual(before);
  });

  it("uses exactly the required transaction boundaries for each command", async () => {
    const { commands, statements } = recordingRepository();
    const readCampaign = await campaign();
    const completedTurnId = await latestTurnId(readCampaign.campaignId);
    const completedJobId = await directGenerationJob(readCampaign.campaignId, "completed", { resultTurnId: completedTurnId, expectedTurnNumber: 2 });

    statements.length = 0;
    await commands.getJob({ ownerUserId, jobId: completedJobId });
    await commands.getResult({ ownerUserId, jobId: completedJobId });
    expect(statements.filter((statement) => /^(BEGIN|COMMIT|ROLLBACK)/.test(statement))).toEqual([]);

    const appendCampaign = await campaign();
    statements.length = 0;
    const queued = await commands.enqueueAppend(
      { ownerUserId, campaignId: appendCampaign.campaignId },
      appendRequest("Open the transaction-instrumented append observatory.")
    );
    expect(statements.filter((statement) => statement === "BEGIN")).toHaveLength(1);
    expect(statements.filter((statement) => statement === "COMMIT")).toHaveLength(1);
    expect(statements.filter((statement) => statement === "ROLLBACK")).toHaveLength(0);
    expect(statements.filter((statement) => statement === "SAVEPOINT enqueue_generation_insert")).toHaveLength(1);

    statements.length = 0;
    await commands.cancel({ ownerUserId, jobId: queued.id });
    expect(statements.filter((statement) => statement === "BEGIN")).toHaveLength(1);
    expect(statements.filter((statement) => statement === "COMMIT")).toHaveLength(1);
    expect(statements.filter((statement) => statement === "ROLLBACK")).toHaveLength(0);

    const retryCampaign = await campaign();
    const retryJobId = await directGenerationJob(retryCampaign.campaignId, "recoverable");
    statements.length = 0;
    await commands.retry({ ownerUserId, jobId: retryJobId });
    expect(statements.filter((statement) => statement === "BEGIN")).toHaveLength(1);
    expect(statements.filter((statement) => statement === "COMMIT")).toHaveLength(1);
    expect(statements.filter((statement) => statement === "ROLLBACK")).toHaveLength(0);
    expect(statements.filter((statement) => statement.startsWith("SELECT id, status AS \"generationStatus\""))).toHaveLength(1);
    expect(statements.filter((statement) => statement.startsWith("UPDATE generation_jobs"))).toHaveLength(1);

    const discardCampaign = await campaign();
    const discardJobId = await directGenerationJob(discardCampaign.campaignId, "failed");
    statements.length = 0;
    await commands.discard({ ownerUserId, jobId: discardJobId });
    expect(statements).toHaveLength(1);
    expect(statements.filter((statement) => /^(BEGIN|COMMIT|ROLLBACK)/.test(statement))).toEqual([]);
    expect(statements.filter((statement) => statement.startsWith("WITH source AS"))).toHaveLength(1);

    const replacementCampaign = await campaign();
    statements.length = 0;
    await commands.enqueueReplacement(
      { ownerUserId, campaignId: replacementCampaign.campaignId },
      replacementRequest("Open the transaction-instrumented replacement observatory.")
    );
    expect(statements.filter((statement) => statement === "BEGIN")).toHaveLength(1);
    expect(statements.filter((statement) => statement === "COMMIT")).toHaveLength(1);
    expect(statements.filter((statement) => statement === "ROLLBACK")).toHaveLength(0);
    expect(statements.filter((statement) => statement === "SAVEPOINT enqueue_replacement_insert")).toHaveLength(1);
  });

  it.each(["queued", "replacement_queued", "assessing", "generating", "validating", "committing"])(
    "cancels a %s generation job and only that same-owner campaign job",
    async (status) => {
      const targetCampaign = await campaign();
      const otherCampaign = await campaign();
      const targetJobId = await directGenerationJob(targetCampaign.campaignId, status);
      const otherJobId = await directGenerationJob(otherCampaign.campaignId, "queued");
      const completedJobId = await directGenerationJob(targetCampaign.campaignId, "completed", {
        resultTurnId: await latestTurnId(targetCampaign.campaignId),
        expectedTurnNumber: 2
      });
      const commands = repository();
      const targetBefore = await authoritativeCampaignSnapshot(targetCampaign.campaignId);
      const resultBefore = await commands.getResult({ ownerUserId, jobId: completedJobId });

      await expect(commands.cancel({ ownerUserId, jobId: targetJobId })).resolves.toMatchObject({
        id: targetJobId,
        status: "cancelled",
        operationKind: "append",
        replacementTurnId: null
      });
      await expect(pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM generation_jobs WHERE id = ANY($1::uuid[]) ORDER BY id",
        [[targetJobId, otherJobId]]
      )).resolves.toMatchObject({ rows: expect.arrayContaining([
        { id: targetJobId, status: "cancelled" },
        { id: otherJobId, status: "queued" }
      ]) });
      await expect(authoritativeCampaignSnapshot(targetCampaign.campaignId)).resolves.toEqual(targetBefore);
      await expect(commands.getResult({ ownerUserId, jobId: completedJobId })).resolves.toEqual(resultBefore);
    }
  );

  it("cancels provisional illustration children while leaving another campaign's children intact", async () => {
    const targetCampaign = await campaign();
    const otherCampaign = await campaign();
    const targetJobId = await directGenerationJob(targetCampaign.campaignId, "generating");
    const otherJobId = await directGenerationJob(otherCampaign.campaignId, "generating");
    const targetChildren = await provisionalIllustrationChildren(targetCampaign.campaignId, targetJobId);
    const otherChildren = await provisionalIllustrationChildren(otherCampaign.campaignId, otherJobId);
    const targetBefore = await authoritativeCampaignSnapshot(targetCampaign.campaignId);
    const otherBefore = await authoritativeCampaignSnapshot(otherCampaign.campaignId);

    await repository().cancel({ ownerUserId, jobId: targetJobId });

    await expect(pool.query<{ status: string }>("SELECT status FROM image_jobs WHERE id = $1", [targetChildren.imageId]))
      .resolves.toMatchObject({ rows: [{ status: "cancelled" }] });
    await expect(pool.query<{ status: string }>("SELECT status FROM turn_illustration_sets WHERE id = $1", [targetChildren.setId]))
      .resolves.toMatchObject({ rows: [{ status: "orphaned" }] });
    await expect(pool.query<{ status: string }>("SELECT status FROM turn_illustration_segments WHERE id = $1", [targetChildren.segmentId]))
      .resolves.toMatchObject({ rows: [{ status: "failed" }] });
    await expect(pool.query<{ status: string }>("SELECT status FROM illustration_prompt_jobs WHERE id = $1", [targetChildren.promptId]))
      .resolves.toMatchObject({ rows: [{ status: "cancelled" }] });
    await expect(pool.query<{ status: string }>("SELECT status FROM illustration_resolution_jobs WHERE id = $1", [targetChildren.resolutionId]))
      .resolves.toMatchObject({ rows: [{ status: "cancelled" }] });
    await expect(pool.query("SELECT segment_id FROM turn_illustration_segment_assets WHERE segment_id = $1", [targetChildren.segmentId]))
      .resolves.toMatchObject({ rows: [] });
    await expect(pool.query("SELECT id FROM asset_references WHERE id = $1", [targetChildren.assetReferenceId]))
      .resolves.toMatchObject({ rows: [] });
    await expect(pool.query<{ status: string }>("SELECT status FROM image_jobs WHERE id = $1", [otherChildren.imageId]))
      .resolves.toMatchObject({ rows: [{ status: "generating" }] });
    await expect(pool.query<{ status: string }>("SELECT status FROM turn_illustration_sets WHERE id = $1", [otherChildren.setId]))
      .resolves.toMatchObject({ rows: [{ status: "provisional" }] });
    await expect(pool.query<{ status: string }>("SELECT status FROM turn_illustration_segments WHERE id = $1", [otherChildren.segmentId]))
      .resolves.toMatchObject({ rows: [{ status: "completed" }] });
    await expect(pool.query<{ status: string }>("SELECT status FROM illustration_prompt_jobs WHERE id = $1", [otherChildren.promptId]))
      .resolves.toMatchObject({ rows: [{ status: "queued" }] });
    await expect(pool.query<{ status: string }>("SELECT status FROM illustration_resolution_jobs WHERE id = $1", [otherChildren.resolutionId]))
      .resolves.toMatchObject({ rows: [{ status: "queued" }] });
    await expect(pool.query<{ id: string }>("SELECT id FROM assets WHERE id = $1 AND campaign_id = $2 AND owner_user_id = $3", [
      otherChildren.assetId,
      otherCampaign.campaignId,
      ownerUserId
    ])).resolves.toMatchObject({ rows: [{ id: otherChildren.assetId }] });
    await expect(pool.query<{ asset_id: string }>("SELECT asset_id FROM turn_illustration_segment_assets WHERE segment_id = $1", [otherChildren.segmentId]))
      .resolves.toMatchObject({ rows: [{ asset_id: otherChildren.assetId }] });
    await expect(pool.query<{ id: string }>("SELECT id FROM asset_references WHERE id = $1", [otherChildren.assetReferenceId]))
      .resolves.toMatchObject({ rows: [{ id: otherChildren.assetReferenceId }] });
    await expect(authoritativeCampaignSnapshot(targetCampaign.campaignId)).resolves.toEqual(targetBefore);
    await expect(authoritativeCampaignSnapshot(otherCampaign.campaignId)).resolves.toEqual(otherBefore);
  });

  it("does not reveal or mutate a known foreign-owner job through any command or query", async () => {
    const foreignUser = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name) VALUES ('Generation repository foreign owner') RETURNING id"
    );
    const foreignOwnerUserId = foreignUser.rows[0]!.id;
    const foreignWorld = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1, 'Foreign generation repository world') RETURNING id",
      [foreignOwnerUserId]
    );
    const foreignWorldVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,1,'{}'::jsonb) RETURNING id`,
      [foreignWorld.rows[0]!.id, foreignOwnerUserId]
    );
    const foreignCampaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,'Foreign generation repository campaign') RETURNING id",
      [foreignOwnerUserId, foreignWorldVersion.rows[0]!.id]
    );
    const foreignProvider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (owner_user_id, name, provider_type, provider_role, base_url, default_model)
       VALUES ($1,'Foreign generation repository provider','openai_compatible','text','http://127.0.0.1:9912','foreign-model')
       RETURNING id`,
      [foreignOwnerUserId]
    );
    const foreignJob = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key, expected_turn_number, action
       ) VALUES ($1,$2,$3,$4,1,'Open the foreign observatory.') RETURNING id`,
      [foreignOwnerUserId, foreignCampaign.rows[0]!.id, foreignProvider.rows[0]!.id, crypto.randomUUID()]
    );
    const commands = repository();
    const foreignJobId = foreignJob.rows[0]!.id;

    await expect(commands.enqueueAppend(
      { ownerUserId, campaignId: foreignCampaign.rows[0]!.id },
      appendRequest("Attempt to reach the foreign observatory.")
    )).rejects.toMatchObject({ kind: "not_found", details: { campaignId: foreignCampaign.rows[0]!.id } });
    await expect(commands.enqueueReplacement(
      { ownerUserId, campaignId: foreignCampaign.rows[0]!.id },
      replacementRequest("Attempt to replace the foreign observatory.")
    )).rejects.toMatchObject({ kind: "not_found", details: { campaignId: foreignCampaign.rows[0]!.id } });
    await expect(commands.getJob({ ownerUserId, jobId: foreignJobId }))
      .rejects.toMatchObject({ kind: "not_found", details: { jobId: foreignJobId } });
    await expect(commands.getResult({ ownerUserId, jobId: foreignJobId }))
      .rejects.toMatchObject({ kind: "not_found", details: { jobId: foreignJobId } });
    await expect(commands.retry({ ownerUserId, jobId: foreignJobId }))
      .rejects.toMatchObject({ kind: "not_found", details: { jobId: foreignJobId } });
    await expect(commands.cancel({ ownerUserId, jobId: foreignJobId }))
      .rejects.toMatchObject({ kind: "not_found", details: { jobId: foreignJobId } });
    await expect(commands.discard({ ownerUserId, jobId: foreignJobId }))
      .rejects.toMatchObject({ kind: "not_found", details: { jobId: foreignJobId } });
    await expect(pool.query<{ status: string }>("SELECT status FROM generation_jobs WHERE id = $1", [foreignJobId]))
      .resolves.toMatchObject({ rows: [{ status: "queued" }] });
  });

  it("recovers replacement unique conflicts with its savepoint and leaves one durable active job", async () => {
    const imported = await campaign();
    const commands = repository();
    const requests = [
      replacementRequest("Rewrite the latest turn from the archive."),
      replacementRequest("Rewrite the latest turn from the observatory.")
    ];
    const results = await Promise.allSettled(requests.map((request) =>
      commands.enqueueReplacement({ ownerUserId, campaignId: imported.campaignId }, request)
    ));
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof commands.enqueueReplacement>>> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value).toMatchObject({ status: "replacement_queued", operationKind: "replace_latest", duplicate: false });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(GenerationApplicationError);
    expect(rejected[0]?.reason).toMatchObject({ kind: "active_job", details: { reason: "active_generation" } });
    expect((rejected[0]?.reason as Error).message).not.toContain("25P02");

    const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
    const replay = await commands.enqueueReplacement(
      { ownerUserId, campaignId: imported.campaignId },
      requests[winnerIndex]!
    );
    expect(replay).toMatchObject({ id: fulfilled[0]?.value.id, duplicate: true, operationKind: "replace_latest" });
    const active = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM generation_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2
          AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable')`,
      [imported.campaignId, ownerUserId]
    );
    expect(active.rows[0]?.count).toBe("1");
  });

  it("replays a same-key concurrent replacement deterministically after the unique conflict", async () => {
    const imported = await campaign();
    const commands = repository();
    const key = crypto.randomUUID();
    const request = replacementRequest("Rewrite the latest turn from the same-key archive.", key);
    const results = await Promise.allSettled([
      commands.enqueueReplacement({ ownerUserId, campaignId: imported.campaignId }, request),
      commands.enqueueReplacement({ ownerUserId, campaignId: imported.campaignId }, request)
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof commands.enqueueReplacement>>> => result.status === "fulfilled"
    );

    expect(fulfilled).toHaveLength(2);
    expect(new Set(fulfilled.map((result) => result.value.id)).size).toBe(1);
    expect(fulfilled.map((result) => result.value.duplicate).sort()).toEqual([false, true]);
    expect(fulfilled.map((result) => result.value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "replacement_queued", operationKind: "replace_latest" })
    ]));
  });

  it("rejects a replacement idempotency-key reuse with a different fingerprint", async () => {
    const imported = await campaign();
    const commands = repository();
    const idempotencyKey = crypto.randomUUID();
    await commands.enqueueReplacement(
      { ownerUserId, campaignId: imported.campaignId },
      replacementRequest("Rewrite the observatory ledger.", idempotencyKey)
    );

    await expect(commands.enqueueReplacement(
      { ownerUserId, campaignId: imported.campaignId },
      replacementRequest("Rewrite the observatory ledger with a different intent.", idempotencyKey)
    )).rejects.toMatchObject({ kind: "conflict", details: { reason: "idempotency_mismatch" } });
  });

  it("rolls back a losing replacement's pre-insert cleanup without touching historical classification provenance", async () => {
    const imported = await campaign();
    const { commands, statements } = recordingRepository();
    const latestTurn = await latestTurnId(imported.campaignId);
    const queuedImageJobId = await directTurnImageJob(imported.campaignId, latestTurn, "queued");
    const competingJobId = await directGenerationJob(imported.campaignId, "failed");
    const losingAction = "Rewrite the turn with the losing explicit request.";
    const losingIdempotencyKey = crypto.randomUUID();
    const classification = await pool.query<{ id: string }>(
      `INSERT INTO turn_input_classifications (
         owner_user_id, campaign_id, input_hash, classification, resolved_mode, confidence_band,
         provider_profile_id, provider_source, diagnostics
       ) VALUES ($1,$2,$3,'action','action','clear',$4,'story_text','{}'::jsonb) RETURNING id`,
      [ownerUserId, imported.campaignId, sha256(losingAction), providerProfileId]
    );
    const barrier = await installGenerationInsertBarrier(imported.campaignId, losingIdempotencyKey);
    const loser = commands.enqueueReplacement(
      { ownerUserId, campaignId: imported.campaignId },
      generationRetryLatestRequestSchema.parse({
        ...replacementRequest(losingAction, losingIdempotencyKey),
        requestedInputMode: "action",
        resolvedInputMode: "action",
        inputModeSource: "explicit"
      })
    );
    try {
      await barrier.wait();
      const queuedImageDuringLosingTransaction = await pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM image_jobs WHERE id = $1",
        [queuedImageJobId]
      );
      expect(queuedImageDuringLosingTransaction.rows).toEqual([{ id: queuedImageJobId, status: "queued" }]);
      await expect(pool.query<{ id: string; status: string }>(
        "UPDATE generation_jobs SET status = 'queued' WHERE id = $1 AND status = 'failed' RETURNING id, status",
        [competingJobId]
      )).resolves.toMatchObject({ rows: [{ id: competingJobId, status: "queued" }] });
      await barrier.release();
      await expect(loser).rejects.toMatchObject({ kind: "active_job", details: { reason: "active_generation" } });
    } finally {
      await barrier.cleanup();
    }

    await expect(pool.query<{ consumed_at: string | null }>(
      "SELECT consumed_at FROM turn_input_classifications WHERE id = $1",
      [classification.rows[0]!.id]
    )).resolves.toMatchObject({ rows: [{ consumed_at: null }] });
    await expect(pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM image_jobs WHERE id = $1",
      [queuedImageJobId]
    )).resolves.toMatchObject({ rows: [{ id: queuedImageJobId, status: "queued" }] });
    await expect(pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM generation_jobs WHERE id = $1",
      [competingJobId]
    )).resolves.toMatchObject({ rows: [{ id: competingJobId, status: "queued" }] });

    const queuedImageDelete = statements.findIndex((statement) => statement.startsWith("DELETE FROM image_jobs"));
    const savepoint = statements.indexOf("SAVEPOINT enqueue_replacement_insert");
    const rollbackToSavepoint = statements.indexOf("ROLLBACK TO SAVEPOINT enqueue_replacement_insert");
    const releaseSavepoint = statements.indexOf("RELEASE SAVEPOINT enqueue_replacement_insert");
    const outerRollback = statements.indexOf("ROLLBACK");
    const replayLookup = statements.findIndex((statement, index) => index > outerRollback
      && statement.includes("FROM generation_jobs")
      && statement.includes("idempotency_key = $2"));
    const activeLookup = statements.findIndex((statement, index) => index > replayLookup
      && statement.includes("FROM generation_jobs WHERE campaign_id = $1 AND owner_user_id = $2"));
    expect(queuedImageDelete).toBeGreaterThan(-1);
    expect(queuedImageDelete).toBeLessThan(savepoint);
    expect(savepoint).toBeLessThan(rollbackToSavepoint);
    expect(rollbackToSavepoint).toBeLessThan(releaseSavepoint);
    expect(releaseSavepoint).toBeLessThan(outerRollback);
    expect(outerRollback).toBeLessThan(replayLookup);
    expect(replayLookup).toBeLessThan(activeLookup);
  });
});
