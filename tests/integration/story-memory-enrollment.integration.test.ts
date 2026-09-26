import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { clearStoryMemoryEnrollment, readStoryMemorySettings, resolveStoryMemoryPolicySnapshot, saveStoryMemoryEnrollment } from "../../packages/database/src/story-memory-policy-repository.js";
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
import { storyMemoryPromptCompatibilityIdentity, STORY_PROMPT_SCHEMA_VERSION } from "../../packages/contracts/src/story-prompt.js";
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
    { installedCapability: "r3", enforceEnabled: true }
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
  it("captures cast capability only when enabled without changing the saved older snapshot", async () => {
    const imported = await importCampaign("cast capability");
    const capture = (castContextEnabled: boolean) => withTransaction(pool, (client) => resolveStoryMemoryPolicySnapshot(client,
      { ownerUserId, campaignId: imported.campaignId, providerProfileId, requestedModel: "" },
      { installedCapability: "r3", enforceEnabled: true, castContextEnabled }));
    const old = await capture(false);
    const enabled = await capture(true);
    expect(enabled).toMatchObject({ castContext: true, contextProtocol: "current-continuity-v4", promptProtocol: "story-v17-campaign-cast" });
    expect(old).not.toHaveProperty("castContext");
    expect(await capture(false)).toEqual(old);
  });

  it("defaults imported campaigns to Max with review off and preserves an explicit Off", async () => {
    await expect(resolveSnapshot()).resolves.toMatchObject({ policy: { capability: "r3", continuityReview: "off" } });
    await expect(readStoryMemorySettings(pool, scope(), { installedCapability: "r3", enforceEnabled: true })).resolves.toEqual({
      level: "max", reviewMode: "off", availableLevels: ["off", "standard", "enhanced", "max"]
    });
    await clearStoryMemoryEnrollment(pool, scope());
    await expect(resolveSnapshot()).resolves.toBeNull();
    await expect(readStoryMemorySettings(pool, scope(), { installedCapability: "r3", enforceEnabled: true })).resolves.toEqual({
      level: "off", reviewMode: "off", availableLevels: ["off", "standard", "enhanced", "max"]
    });
  });

  it("saves an explicitly selected enrollment and clears it for future jobs", async () => {
    await saveStoryMemoryEnrollment(pool, scope(), { capability: "r2", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });
    const frozen = await resolveSnapshot();
    expect(frozen).toMatchObject({ policy: { capability: "r2", continuityReview: "off" }, contextProtocol: "current-continuity-v3" });
    await clearStoryMemoryEnrollment(pool, scope());
    await expect(resolveSnapshot()).resolves.toBeNull();
  });
  it("upgrades every preexisting enrollment to Max without changing accepted turns or queued snapshots", async () => {
    const standard = await importCampaign("migration standard");
    const enhanced = await importCampaign("migration enhanced");
    const observe = await importCampaign("migration observe");
    const queuedScope = { ownerUserId, campaignId: standard.campaignId };
    await saveStoryMemoryEnrollment(pool, queuedScope, { capability: "r1", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });
    const queued = await commands().enqueueAppend(queuedScope, append());
    const beforeJob = (await pool.query<{ context_options: unknown; prompt_snapshot: unknown }>(
      "SELECT context_options,prompt_snapshot FROM generation_jobs WHERE id=$1", [queued.id]
    )).rows[0]!;
    const beforeTurns = await pool.query<{ campaign_id: string; turn_number: number; narration: string }>(
      "SELECT campaign_id,turn_number,narration FROM turns WHERE campaign_id=ANY($1::uuid[]) ORDER BY campaign_id,turn_number",
      [[standard.campaignId, enhanced.campaignId, observe.campaignId]]
    );
    await pool.query(
      `UPDATE campaign_story_memory_enrollments
          SET capability=CASE campaign_id
            WHEN $1 THEN 'r1'
            WHEN $2 THEN 'r2'
            ELSE 'r3' END,
              review_mode=CASE campaign_id WHEN $3 THEN 'observe' ELSE 'off' END`,
      [standard.campaignId, enhanced.campaignId, observe.campaignId]
    );
    const migration = await readFile(resolve("database/migrations/0096_campaign_memory_defaults.sql"), "utf8");
    await pool.query(migration.slice(0, migration.indexOf("CREATE FUNCTION")));
    await expect(pool.query<{ capability: string; review_mode: string }>(
      "SELECT capability,review_mode FROM campaign_story_memory_enrollments WHERE campaign_id=ANY($1::uuid[]) ORDER BY campaign_id",
      [[standard.campaignId, enhanced.campaignId, observe.campaignId]]
    )).resolves.toMatchObject({ rows: [
      { capability: "r3", review_mode: "enforce" },
      { capability: "r3", review_mode: "enforce" },
      { capability: "r3", review_mode: "enforce" }
    ] });
    await expect(pool.query("SELECT context_options,prompt_snapshot FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [beforeJob] });
    await expect(pool.query(
      "SELECT campaign_id,turn_number,narration FROM turns WHERE campaign_id=ANY($1::uuid[]) ORDER BY campaign_id,turn_number",
      [[standard.campaignId, enhanced.campaignId, observe.campaignId]]
    )).resolves.toMatchObject({ rows: beforeTurns.rows });
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
  it("freezes the v16 fact wire contract for new work while retrying a v15 snapshot unchanged", async () => {
    const imported = await importCampaign("v16 frozen fact wire");
    const owned = { ownerUserId, campaignId: imported.campaignId };
    await saveStoryMemoryEnrollment(pool, owned, { capability: "r1", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });
    const queued = await commands().enqueueAppend(owned, append());
    const current = (await pool.query<{ prompt_snapshot: { templates: Record<string, { content: string; hash: string; source: "shipped" | "application" | "campaign" }>; storyMemoryCompatibility: { protocolIdentity: string; templateHashes: Record<string, string> } }; context_options: { storyMemoryPolicy: { promptProtocol: string } }; prompt_protocol_version: string }>(
      "SELECT prompt_snapshot,context_options,prompt_protocol_version FROM generation_jobs WHERE id=$1", [queued.id]
    )).rows[0]!;
    expect(current.context_options.storyMemoryPolicy.promptProtocol).toBe("story-v16-fact-wire-distinction");
    expect(current.prompt_snapshot.storyMemoryCompatibility.protocolIdentity).toBe("story-v16-fact-wire-distinction|story-output-v2|current-continuity-v3");
    expect(current.prompt_snapshot.templates.story_system!.content).toContain("Input canonical fact records may contain id, content, or retrieval metadata.");

    const oldCreativeOverride = "Frozen v15 creative prompt bytes.";
    const oldHash = createHash("sha256").update(oldCreativeOverride).digest("hex");
    const oldSnapshot = structuredClone(current.prompt_snapshot);
    oldSnapshot.templates.story_system = { content: oldCreativeOverride, hash: oldHash, source: "campaign" };
    oldSnapshot.storyMemoryCompatibility = {
      protocolIdentity: "story-v15-canonical-fact-format|story-output-v2|current-continuity-v3",
      templateHashes: { ...oldSnapshot.storyMemoryCompatibility.templateHashes, story_system: oldHash }
    };
    const oldContext = structuredClone(current.context_options);
    oldContext.storyMemoryPolicy.promptProtocol = "story-v15-canonical-fact-format";
    const oldProtocol = `story-memory-v1|${generationExecutionProtocolIdentity(providerPromptProtocolVersion(oldSnapshot.templates as never), { version: 1, playMode: "legacy", turnControlStyle: "flexible_action" })}`;
    await pool.query(
      "UPDATE generation_jobs SET status='recoverable',prompt_snapshot=$2::jsonb,context_options=$3::jsonb,prompt_protocol_version=$4 WHERE id=$1",
      [queued.id, JSON.stringify(oldSnapshot), JSON.stringify(oldContext), oldProtocol]
    );
    const frozenBeforeRetry = (await pool.query<{ prompt_snapshot: unknown; context_options: unknown; prompt_protocol_version: string }>(
      "SELECT prompt_snapshot,context_options,prompt_protocol_version FROM generation_jobs WHERE id=$1", [queued.id]
    )).rows[0]!;

    await expect(commands().retry({ ownerUserId, jobId: queued.id })).resolves.toMatchObject({ status: "queued" });
    await expect(pool.query("SELECT prompt_snapshot,context_options,prompt_protocol_version FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [frozenBeforeRetry] });
  });
  it("ignores a stale client-supplied acknowledgement on save, then freezes its current proof independently of later edits", async () => {
    const imported = await importCampaign("prompt acknowledgement");
    const owned = { ownerUserId, campaignId: imported.campaignId };
    const custom = "Keep the campaign's established creative voice.";
    const customHash = createHash("sha256").update(custom).digest("hex");
    await saveStoryMemoryEnrollment(pool, owned, { capability: "r1", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });

    // The client sends a stale/mismatched acknowledgement; the server ignores
    // it and derives the stored acknowledgement from the current requirement.
    await withTransaction(pool, (client) => createPromptRepository(client).savePromptOverride({
      ...owned, scope: "campaign", key: "story_system", content: custom,
      compatibilityAcknowledgement: {
        requiredShapeVersion: "story-output-v2",
        protocolIdentity: "story-v13-current-state-corrections|story-output-v2|current-continuity-v2",
        contentHash: "0".repeat(64)
      }
    }));
    const storedOverride = (await pool.query<{
      compatibility_required_shape_version: string; compatibility_protocol_identity: string; compatibility_content_hash: string;
    }>(
      "SELECT compatibility_required_shape_version,compatibility_protocol_identity,compatibility_content_hash FROM prompt_template_overrides WHERE owner_user_id=$1 AND campaign_id=$2 AND prompt_key='story_system'",
      [owned.ownerUserId, owned.campaignId]
    )).rows[0]!;
    expect(storedOverride).toEqual({
      compatibility_required_shape_version: STORY_PROMPT_SCHEMA_VERSION,
      compatibility_protocol_identity: storyMemoryPromptCompatibilityIdentity(),
      compatibility_content_hash: customHash
    });

    const queued = await commands().enqueueAppend(owned, append());
    const before = (await pool.query<{ prompt_snapshot: Record<string, unknown> }>(
      "SELECT prompt_snapshot FROM generation_jobs WHERE id=$1", [queued.id]
    )).rows[0]!.prompt_snapshot;
    expect(before).toMatchObject({
      version: 2,
      templates: { story_system: { content: custom, hash: customHash, source: "campaign" } },
      storyMemoryCompatibility: {
        protocolIdentity: storyMemoryPromptCompatibilityIdentity(),
        templateHashes: { story_system: customHash }
      }
    });

    const edited = "A later editable prompt version.";
    await withTransaction(pool, (client) => createPromptRepository(client).savePromptOverride({
      ...owned, scope: "campaign", key: "story_system", content: edited
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
    await expect(readStoryMemorySettings(pool, { ownerUserId: foreignOwnerUserId, campaignId }, { installedCapability: "r3", enforceEnabled: true })).rejects.toMatchObject({ code: "not_found", statusCode: 404 });
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

  async function waitForCampaignLockQueue(lockerPid: number, expectedWaiters: number): Promise<void> {
    await expect.poll(async () => pool.query<{ waiting: number; blockedByLocker: boolean }>(
      `SELECT count(*) FILTER (WHERE wait_event_type='Lock')::integer AS waiting,
              EXISTS (
                SELECT 1 FROM pg_stat_activity waiter
                 WHERE waiter.datname=current_database()
                   AND waiter.wait_event_type='Lock'
                   AND $1=ANY(pg_blocking_pids(waiter.pid))
              ) AS "blockedByLocker"
         FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>$1`,
      [lockerPid]
    ).then((result) => result.rows[0]), { timeout: 5_000 }).toEqual({ waiting: expectedWaiters, blockedByLocker: true });
  }

  it("serializes enrollment save and clear ahead of append and replacement enqueue with the campaign lock", async () => {
    const appendImported = await importCampaign("append enrollment lock");
    const appendOwned = { ownerUserId, campaignId: appendImported.campaignId };
    const appendLock = await pool.connect();
    try {
      await appendLock.query("BEGIN");
      await appendLock.query("SELECT 1 FROM campaigns WHERE id=$1 FOR UPDATE", [appendOwned.campaignId]);
      const appendLockerPid = (await appendLock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const saving = saveStoryMemoryEnrollment(pool, appendOwned, { capability: "r1", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });
      await waitForCampaignLockQueue(appendLockerPid, 1);
      const appending = commands().enqueueAppend(appendOwned, append());
      await waitForCampaignLockQueue(appendLockerPid, 2);
      await appendLock.query("COMMIT");
      const appendJob = await appending;
      await saving;
      const appendRow = (await pool.query<{ context_options: { storyMemoryPolicy?: unknown }; prompt_protocol_version: string }>(
        "SELECT context_options,prompt_protocol_version FROM generation_jobs WHERE id=$1", [appendJob.id]
      )).rows[0]!;
      expect(appendRow.context_options.storyMemoryPolicy).toMatchObject({ policy: { capability: "r1" } });
      expect(appendRow.prompt_protocol_version).toMatch(/^story-memory-v1\|/);
    } finally {
      await appendLock.query("ROLLBACK").catch(() => undefined);
      appendLock.release();
    }

    const replacementImported = await importCampaign("replacement enrollment lock");
    const replacementOwned = { ownerUserId, campaignId: replacementImported.campaignId };
    const activeTurnNumber = (await pool.query<{ active_turn_number: number }>(
      "SELECT active_turn_number FROM campaigns WHERE id=$1", [replacementOwned.campaignId]
    )).rows[0]!.active_turn_number;
    await saveStoryMemoryEnrollment(pool, replacementOwned, { capability: "r1", reviewMode: "off" }, { installedCapability: "r3", enforceEnabled: false });
    const replacementLock = await pool.connect();
    try {
      await replacementLock.query("BEGIN");
      await replacementLock.query("SELECT 1 FROM campaigns WHERE id=$1 FOR UPDATE", [replacementOwned.campaignId]);
      const replacementLockerPid = (await replacementLock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const clearing = clearStoryMemoryEnrollment(pool, replacementOwned);
      await waitForCampaignLockQueue(replacementLockerPid, 1);
      const replacing = commands().enqueueReplacement(replacementOwned, generationRetryLatestRequestSchema.parse({
        ...append(), expectedCurrentTurnNumber: activeTurnNumber
      }));
      await waitForCampaignLockQueue(replacementLockerPid, 2);
      await replacementLock.query("COMMIT");
      const replacementJob = await replacing;
      await clearing;
      const replacementRow = (await pool.query<{ context_options: { storyMemoryPolicy?: unknown }; prompt_protocol_version: string }>(
        "SELECT context_options,prompt_protocol_version FROM generation_jobs WHERE id=$1", [replacementJob.id]
      )).rows[0]!;
      expect(replacementRow.context_options.storyMemoryPolicy).toBeUndefined();
      expect(replacementRow.prompt_protocol_version).not.toMatch(/^story-memory-v1\|/);
    } finally {
      await replacementLock.query("ROLLBACK").catch(() => undefined);
      replacementLock.release();
    }
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
