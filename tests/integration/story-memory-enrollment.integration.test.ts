import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { clearStoryMemoryEnrollment, resolveStoryMemoryPolicySnapshot, saveStoryMemoryEnrollment } from "../../packages/database/src/story-memory-policy-repository.js";
import type { StoryMemoryOperatorConfig } from "../../packages/database/src/story-memory-policy-repository.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import { loadPromptSnapshotForTest, providerPromptProtocolVersion, readTurnReportedCostsForTest } from "../helpers/provider-application-fixtures.js";
import { createPostgresGenerationCommandRepository } from "../../packages/database/src/generation-repository.js";
import { createPromptRepository, resolveStoryMemoryPromptSnapshot } from "../../packages/database/src/prompt-repository.js";
import { generationRequestSchema, generationRetryLatestRequestSchema } from "../../packages/contracts/src/generation.js";
import { generationExecutionProtocolIdentity } from "../../packages/story-engine/src/story-only-prompt.js";
import { effectiveProviderConfigurationFingerprint } from "../../packages/contracts/src/story-memory-policy.js";
import { createRuntimeProviderAdapter } from "../../services/runtime/src/provider-credential-transport-adapter.js";

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration("Story Memory enrollment", () => {
  let pool: DatabasePool; let ownerUserId = ""; let campaignId = ""; let providerProfileId = "";
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 4); await migrateDatabase(pool, resolve("database/migrations")); ownerUserId = await initialOwnerId(pool);
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8")); fixture.world.title = `Enrollment ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "enrollment.story", story: fixture })); campaignId = imported.campaignId;
    providerProfileId = (await createProvider(pool, { name: `Enrollment ${crypto.randomUUID()}`, providerType: "openai_compatible", providerRole: "text", baseUrl: "http://127.0.0.1:9911", defaultModel: "model", contextWindowTokens: 32768, maxOutputTokens: 4096, temperature: 0, enabled: true, configuration: { retryLimit: 2 } }, "enrollment-secret")).id;
  });
  afterAll(async () => { await pool.end(); });
  const scope = () => ({ ownerUserId, campaignId });
  const resolveSnapshot = () => withTransaction(pool, (client) => resolveStoryMemoryPolicySnapshot(
    client, { ...scope(), providerProfileId, requestedModel: "" },
    { installedCapability: "r3", enforceEnabled: false }
  ));
  const commands = (config: StoryMemoryOperatorConfig = { installedCapability: "r3", enforceEnabled: false }) => createPostgresGenerationCommandRepository(pool, {
    resolvePromptSnapshot: (client, scopeOwnerUserId, scopedCampaignId, storyMemoryPolicy) => storyMemoryPolicy
      ? resolveStoryMemoryPromptSnapshot(client, { ownerUserId: scopeOwnerUserId, scope: "campaign", campaignId: scopedCampaignId })
      : loadPromptSnapshotForTest(client, scopeOwnerUserId, scopedCampaignId),
    promptProtocolVersion: providerPromptProtocolVersion,
    resolveStoryMemoryPolicySnapshot: (client, policyScope) => resolveStoryMemoryPolicySnapshot(client, policyScope, config),
    readTurnReportedCosts: (scopeOwnerUserId, _scopedCampaignId, turnIds) => readTurnReportedCostsForTest(pool, scopeOwnerUserId, [...turnIds])
  });
  const importCampaign = async (label: string) => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `${label} ${crypto.randomUUID()}`;
    return importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: `${label}.story`, story: fixture }));
  };
  const append = (idempotencyKey = crypto.randomUUID()) => generationRequestSchema.parse({
    action: "Continue the enrollment boundary.", providerProfileId, idempotencyKey,
    context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
  });
  it("freezes only an explicitly enrolled compatible policy and clears it for future jobs", async () => {
    await expect(resolveSnapshot()).resolves.toBeNull();
    await saveStoryMemoryEnrollment(pool, scope(), { capability: "r2", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });
    const frozen = await resolveSnapshot();
    expect(frozen).toMatchObject({ policy: { capability: "r2", continuityReview: "off" }, contextProtocol: "current-continuity-v3" });
    await clearStoryMemoryEnrollment(pool, scope());
    await expect(resolveSnapshot()).resolves.toBeNull();
  });
  it("hashes the same safe effective provider projection used by runtime with request overrides", async () => {
    await saveStoryMemoryEnrollment(pool, scope(), { capability: "r1", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });
    await pool.query(
      "UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1",
      [providerProfileId, JSON.stringify({ retryLimit: 2, obsoleteStoredKey: "ignored", nested: { secret: "ignored" } })]
    );
    const runtime = await withTransaction(pool, async (client) => {
      const adapter = createRuntimeProviderAdapter({
        database: client,
        credentialSecret: "enrollment-secret",
        transport: {} as never,
        health: {} as never
      });
      return adapter.execution.text({ ownerUserId }, providerProfileId, "text", "request-model");
    });
    const frozen = await withTransaction(pool, (client) => resolveStoryMemoryPolicySnapshot(client, {
      ...scope(), providerProfileId, requestedModel: "request-model", modelContextWindowTokens: 12_345
    }, { installedCapability: "r3", enforceEnabled: false }));
    expect(runtime.configuration).toEqual({ retryLimit: 2 });
    expect(frozen?.providerConfigurationFingerprint).toBe(effectiveProviderConfigurationFingerprint({
      providerId: runtime.id, providerType: runtime.providerType, endpointIdentity: runtime.endpointIdentity ?? "",
      model: runtime.model, contextWindowTokens: runtime.contextWindowTokens,
      maxOutputTokens: runtime.maxOutputTokens, temperature: runtime.temperature,
      requestTimeoutMs: runtime.requestTimeoutMs, configuration: runtime.configuration,
      effectiveContextWindowTokens: 12_345,
      inputSafetyPolicy: "estimated_20_percent_plus_1024"
    }));
  });
  it("rejects unavailable and unapproved enrollment instead of silently downgrading", async () => {
    await expect(saveStoryMemoryEnrollment(pool, scope(), { capability: "r3", reviewMode: "enforce" }, { installedCapability: "r3", enforceEnabled: false })).rejects.toMatchObject({ code: "story_memory_enforce_disabled", statusCode: 409 });
    await expect(saveStoryMemoryEnrollment(pool, scope(), { capability: "r3", reviewMode: "observe" }, { installedCapability: "r1", enforceEnabled: false })).rejects.toMatchObject({ code: "story_memory_capability_unavailable", statusCode: 409 });
  });
  it("persists a mixed-worker-incompatible protocol and frozen snapshot through the real append command", async () => {
    await saveStoryMemoryEnrollment(pool, scope(), { capability: "r1", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });
    const queued = await commands().enqueueAppend(scope(), generationRequestSchema.parse({
      action: "Continue the enrollment boundary.", providerProfileId, idempotencyKey: crypto.randomUUID(),
      context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
    }));
    const row = (await pool.query<{ prompt_protocol_version: string; context_options: { storyMemoryPolicy?: unknown } }>(
      "SELECT prompt_protocol_version,context_options FROM generation_jobs WHERE id=$1", [queued.id]
    )).rows[0]!;
    expect(row.prompt_protocol_version).toMatch(/^story-memory-v1\|/);
    expect(row.context_options.storyMemoryPolicy).toMatchObject({ policy: { capability: "r1" }, contextProtocol: "current-continuity-v3" });
    await pool.query("UPDATE generation_jobs SET status='recoverable' WHERE id=$1", [queued.id]);
    await expect(commands().retry({ ownerUserId, jobId: queued.id })).resolves.toMatchObject({ status: "queued" });
    await pool.query("UPDATE generation_jobs SET status='recoverable', error_code='generation_checkpoint_incompatible' WHERE id=$1", [queued.id]);
    await expect(commands().retry({ ownerUserId, jobId: queued.id })).rejects.toMatchObject({ details: { reason: "retry_protocol_incompatible" } });
    await expect(pool.query("SELECT status FROM generation_jobs WHERE id=$1", [queued.id])).resolves.toMatchObject({ rows: [{ status: "recoverable" }] });
  });
  it("rejects an unacknowledged custom override, then freezes its v14 proof independently of later edits", async () => {
    const imported = await importCampaign("prompt acknowledgement");
    const owned = { ownerUserId, campaignId: imported.campaignId };
    const custom = "Keep the campaign's established creative voice.";
    const customHash = createHash("sha256").update(custom).digest("hex");
    await saveStoryMemoryEnrollment(pool, owned, { capability: "r1", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });

    await withTransaction(pool, (client) => createPromptRepository(client).savePromptOverride({
      ...owned, scope: "campaign", key: "story_system", content: custom,
      compatibilityAcknowledgement: {
        requiredShapeVersion: "story-output-v2",
        protocolIdentity: "story-v13-current-state-corrections|story-output-v2|current-continuity-v2",
        contentHash: customHash
      }
    }));
    await expect(commands().enqueueAppend(owned, append()))
      .rejects.toMatchObject({ code: "prompt_override_incompatible", statusCode: 409 });

    await withTransaction(pool, (client) => createPromptRepository(client).savePromptOverride({
      ...owned, scope: "campaign", key: "story_system", content: custom,
      compatibilityAcknowledgement: {
        requiredShapeVersion: "story-output-v2",
        protocolIdentity: "story-v14-continuity-context|story-output-v2|current-continuity-v3",
        contentHash: customHash
      }
    }));
    const queued = await commands().enqueueAppend(owned, append());
    const before = (await pool.query<{ prompt_snapshot: Record<string, unknown> }>(
      "SELECT prompt_snapshot FROM generation_jobs WHERE id=$1", [queued.id]
    )).rows[0]!.prompt_snapshot;
    expect(before).toMatchObject({
      version: 2,
      templates: { story_system: { content: custom, hash: customHash, source: "campaign" } },
      storyMemoryCompatibility: {
        protocolIdentity: "story-v14-continuity-context|story-output-v2|current-continuity-v3",
        templateHashes: { story_system: customHash }
      }
    });

    const edited = "A later editable prompt version.";
    await withTransaction(pool, (client) => createPromptRepository(client).savePromptOverride({
      ...owned, scope: "campaign", key: "story_system", content: edited,
      compatibilityAcknowledgement: {
        requiredShapeVersion: "story-output-v2",
        protocolIdentity: "story-v14-continuity-context|story-output-v2|current-continuity-v3",
        contentHash: createHash("sha256").update(edited).digest("hex")
      }
    }));
    const after = (await pool.query<{ prompt_snapshot: Record<string, unknown> }>(
      "SELECT prompt_snapshot FROM generation_jobs WHERE id=$1", [queued.id]
    )).rows[0]!.prompt_snapshot;
    expect(after).toEqual(before);
  });
  it("rejects foreign enrollment save and clear without changing the owned enrollment", async () => {
    const foreignOwnerUserId = (await pool.query<{ id: string }>("INSERT INTO users(display_name) VALUES($1) RETURNING id", [`foreign enrollment ${crypto.randomUUID()}`])).rows[0]!.id;
    await saveStoryMemoryEnrollment(pool, scope(), { capability: "r1", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });
    await expect(saveStoryMemoryEnrollment(pool, { ownerUserId: foreignOwnerUserId, campaignId }, { capability: "r2", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false })).rejects.toMatchObject({ code: "not_found", statusCode: 404 });
    await expect(clearStoryMemoryEnrollment(pool, { ownerUserId: foreignOwnerUserId, campaignId })).rejects.toMatchObject({ code: "not_found", statusCode: 404 });
    await expect(resolveSnapshot()).resolves.toMatchObject({ policy: { capability: "r1" } });
  });
  it("keeps queued snapshots frozen across enrollment edits, disable, and re-enable", async () => {
    const imported = await importCampaign("frozen enrollment");
    const owned = { ownerUserId, campaignId: imported.campaignId };
    await saveStoryMemoryEnrollment(pool, owned, { capability: "r1", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });
    const job = await commands().enqueueAppend(owned, append());
    const before = (await pool.query<{ context_options: unknown; prompt_protocol_version: string }>("SELECT context_options,prompt_protocol_version FROM generation_jobs WHERE id=$1", [job.id])).rows[0]!;
    await clearStoryMemoryEnrollment(pool, owned);
    await saveStoryMemoryEnrollment(pool, owned, { capability: "r2", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });
    await expect(commands({ installedCapability: null, enforceEnabled: false }).enqueueAppend(owned, append())).rejects.toMatchObject({ details: { reason: "story_memory_capability_unavailable" } });
    await expect(commands().enqueueAppend(owned, append())).rejects.toMatchObject({ details: { reason: "active_generation" } });
    await expect(pool.query("SELECT context_options,prompt_protocol_version FROM generation_jobs WHERE id=$1", [job.id])).resolves.toMatchObject({ rows: [before] });
  });
  it("rolls back append when capability or enforce configuration conflicts", async () => {
    const imported = await importCampaign("conflict rollback");
    const owned = { ownerUserId, campaignId: imported.campaignId };
    await saveStoryMemoryEnrollment(pool, owned, { capability: "r2", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });
    const before = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM generation_jobs WHERE campaign_id=$1", [owned.campaignId]);
    await expect(commands({ installedCapability: "r1", enforceEnabled: false }).enqueueAppend(owned, append())).rejects.toMatchObject({ details: { reason: "story_memory_capability_unavailable" } });
    await expect(pool.query("SELECT count(*)::text AS count FROM generation_jobs WHERE campaign_id=$1", [owned.campaignId])).resolves.toEqual(before);
    await saveStoryMemoryEnrollment(pool, owned, { capability: "r3", reviewMode: "enforce" }, { installedCapability: "r3", enforceEnabled: true });
    await expect(commands({ installedCapability: "r3", enforceEnabled: false }).enqueueAppend(owned, append())).rejects.toMatchObject({ details: { reason: "story_memory_enforce_disabled" } });
    await expect(pool.query("SELECT count(*)::text AS count FROM generation_jobs WHERE campaign_id=$1", [owned.campaignId])).resolves.toEqual(before);
  });
  it("serializes enrollment save and clear ahead of append and replacement enqueue with the campaign lock", async () => {
    const appendImported = await importCampaign("append enrollment lock");
    const appendOwned = { ownerUserId, campaignId: appendImported.campaignId };
    const appendLock = await pool.connect();
    await appendLock.query("BEGIN");
    await appendLock.query("SELECT 1 FROM campaigns WHERE id=$1 FOR UPDATE", [appendOwned.campaignId]);
    const saving = saveStoryMemoryEnrollment(pool, appendOwned, { capability: "r1", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });
    const appending = commands().enqueueAppend(appendOwned, append());
    await appendLock.query("COMMIT");
    appendLock.release();
    const appendJob = await appending;
    await saving;
    const appendRow = (await pool.query<{ context_options: { storyMemoryPolicy?: unknown }; prompt_protocol_version: string }>(
      "SELECT context_options,prompt_protocol_version FROM generation_jobs WHERE id=$1", [appendJob.id]
    )).rows[0]!;
    expect(appendRow.context_options.storyMemoryPolicy).toMatchObject({ policy: { capability: "r1" } });
    expect(appendRow.prompt_protocol_version).toMatch(/^story-memory-v1\|/);

    const replacementImported = await importCampaign("replacement enrollment lock");
    const replacementOwned = { ownerUserId, campaignId: replacementImported.campaignId };
    const activeTurnNumber = (await pool.query<{ active_turn_number: number }>(
      "SELECT active_turn_number FROM campaigns WHERE id=$1", [replacementOwned.campaignId]
    )).rows[0]!.active_turn_number;
    await saveStoryMemoryEnrollment(pool, replacementOwned, { capability: "r1", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });
    const replacementLock = await pool.connect();
    await replacementLock.query("BEGIN");
    await replacementLock.query("SELECT 1 FROM campaigns WHERE id=$1 FOR UPDATE", [replacementOwned.campaignId]);
    const clearing = clearStoryMemoryEnrollment(pool, replacementOwned);
    const replacing = commands().enqueueReplacement(replacementOwned, generationRetryLatestRequestSchema.parse({
      ...append(), expectedCurrentTurnNumber: activeTurnNumber
    }));
    await replacementLock.query("COMMIT");
    replacementLock.release();
    const replacementJob = await replacing;
    await clearing;
    const replacementRow = (await pool.query<{ context_options: { storyMemoryPolicy?: unknown }; prompt_protocol_version: string }>(
      "SELECT context_options,prompt_protocol_version FROM generation_jobs WHERE id=$1", [replacementJob.id]
    )).rows[0]!;
    expect(replacementRow.context_options.storyMemoryPolicy).toBeUndefined();
    expect(replacementRow.prompt_protocol_version).not.toMatch(/^story-memory-v1\|/);
  });
  it("uses the incompatible protocol for replacement jobs and the pre-T02 predicate rejects it", async () => {
    const imported = await importCampaign("replacement protocol");
    const owned = { ownerUserId, campaignId: imported.campaignId };
    const activeTurnNumber = (await pool.query<{ active_turn_number: number }>("SELECT active_turn_number FROM campaigns WHERE id=$1", [owned.campaignId])).rows[0]!.active_turn_number;
    await saveStoryMemoryEnrollment(pool, owned, { capability: "r1", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });
    const queued = await commands().enqueueReplacement(owned, generationRetryLatestRequestSchema.parse({ ...append(), expectedCurrentTurnNumber: activeTurnNumber }));
    const row = (await pool.query<{ prompt_protocol_version: string }>("SELECT prompt_protocol_version FROM generation_jobs WHERE id=$1", [queued.id])).rows[0]!;
    expect(row.prompt_protocol_version).toMatch(/^story-memory-v1\|/);
    const snapshot = await loadPromptSnapshotForTest(pool, ownerUserId, owned.campaignId);
    expect(row.prompt_protocol_version).not.toBe(generationExecutionProtocolIdentity(providerPromptProtocolVersion(snapshot), { version: 1, playMode: "legacy", turnControlStyle: "flexible_action" }));
  });
});
