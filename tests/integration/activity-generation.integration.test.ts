import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema } from "../../packages/contracts/src/generation.js";
import { ACTIVITY_DIAGNOSTIC_MESSAGES } from "../../packages/contracts/src/activity.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createPostgresGenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
import { createPostgresGenerationCommandRepository } from "../../packages/database/src/generation-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { providerPromptProtocolVersion, loadPromptSnapshotForTest, createProvider, readTurnReportedCostsForTest } from "../helpers/provider-application-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "generation-execution-repository-secret";

integration("Persistent generation activity", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let providerProfileId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    providerProfileId = (await createProvider(pool, {
      name: `Generation execution repository ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl: "http://127.0.0.1:9911",
      defaultModel: "execution-repository-model",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret)).id;
  });

  // Every case creates durable queued/leased jobs. Remove its imported
  // campaign graph so claimNext cannot observe a prior case's job.
  afterEach(async () => {
    await pool.query("DELETE FROM campaigns WHERE owner_user_id=$1", [ownerUserId]);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function campaign() {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Generation execution repository ${crypto.randomUUID()}`;
    return importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: "generation-execution-repository.story",
      story: fixture
    }));
  }

  function commands() {
    return createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: (client, scopeOwnerUserId, campaignId) =>
        loadPromptSnapshotForTest(client, scopeOwnerUserId, campaignId),
      promptProtocolVersion: providerPromptProtocolVersion,
      readTurnReportedCosts: (scopeOwnerUserId, _campaignId, turnIds) =>
        readTurnReportedCostsForTest(pool, scopeOwnerUserId, [...turnIds])
    });
  }

  async function queue(campaignId: string, action: string) {
    return commands().enqueueAppend(
      { ownerUserId, campaignId },
      generationRequestSchema.parse({
        action,
        providerProfileId,
        idempotencyKey: crypto.randomUUID(),
        context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
      })
    );
  }


  async function events(jobId: string) {
    return (await pool.query<{ snapshot: { kind: string; turnId: string | null }; activity_revision: string }>(
      "SELECT snapshot,activity_revision::text FROM activity_event_outbox WHERE source_id=$1 ORDER BY activity_revision,ordinal", [jobId])).rows;
  }
  it("records distinct retry revisions, omits replay, partials and renewals, and hides private canaries", async () => {
    const imported = await campaign();
    const request = generationRequestSchema.parse({ action: "PRIVATE-ACTION-CANARY", providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } });
    const job = await commands().enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, request);
    await commands().enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, request);
    const execution = createPostgresGenerationExecutionRepository(pool);
    await execution.claimNext({ workerId: "activity-worker", leaseSeconds: 30 });
    const scope = { ownerUserId, jobId: job.id, workerId: "activity-worker" };
    expect(await execution.markGenerating(scope)).toBe(true);
    await execution.renewLease(scope, 30);
    await execution.savePartialNarration(scope, "PRIVATE-PARTIAL-CANARY");
    await execution.markFailed({ ...scope, errorCode: "provider_transport_error", errorMessage: "PRIVATE-ERROR-CANARY", recoveryMetadata: { private: "PRIVATE-METADATA-CANARY" } });
    await commands().retry({ ownerUserId, jobId: job.id });
    await execution.claimNext({ workerId: "activity-worker", leaseSeconds: 30 });
    await commands().cancel({ ownerUserId, jobId: job.id });
    await commands().cancel({ ownerUserId, jobId: job.id });
    const captured = await events(job.id);
    expect(captured.map(row => row.snapshot.kind)).toEqual(["generation.queued", "generation.claimed", "generation.generating", "generation.failed", "generation.retry_queued", "generation.claimed", "generation.cancelled"]);
    expect(captured.map(row => row.activity_revision)).toEqual(["1","2","3","4","5","6","7"]);
    expect(JSON.stringify(captured)).not.toContain("PRIVATE-");
    expect((await pool.query("SELECT active_turn_number FROM campaigns WHERE id=$1", [imported.campaignId])).rows[0].active_turn_number).toBe(2);
  });
  it.each(["failed", "recoverable"] as const)("projects current %s diagnostics with a fixed fallback and never reuses prior failure evidence", async (outcome) => {
    const imported = await campaign(), queued = await queue(imported.campaignId, "Inspect.");
    const execution = createPostgresGenerationExecutionRepository(pool);
    await execution.claimNext({ workerId: "diagnostic", leaseSeconds: 30 });
    const scope = { ownerUserId, jobId: queued.id, workerId: "diagnostic" };
    const prior = { version: 1, category: "provider_timeout", code: "provider_request_timeout", phase: "generating", attemptNumber: 1, occurredAt: new Date().toISOString(), private: "PRIVATE-PRIOR-CANARY" };
    await pool.query("UPDATE generation_jobs SET error_code='provider_request_timeout', orchestration_private=jsonb_build_object('lastFailureDiagnostic',$2::jsonb) WHERE id=$1", [queued.id, JSON.stringify(prior)]);
    expect(await execution.markGenerating(scope)).toBe(true);
    expect((await pool.query("SELECT snapshot->'diagnostic' AS diagnostic FROM activity_event_outbox WHERE source_id=$1 ORDER BY activity_revision DESC LIMIT 1", [queued.id])).rows[0].diagnostic).toBeNull();
    const terminate = (errorCode: string) => outcome === "failed"
      ? execution.markFailed({ ...scope, errorCode, errorMessage: "PRIVATE-ERROR-CANARY", recoveryMetadata: {} })
      : execution.markRecoverable({ ...scope, errorCode, errorMessage: "PRIVATE-ERROR-CANARY", recoveryMetadata: {}, providerResponseId: null, providerFinishReason: null });
    expect(await terminate("PRIVATE-UNKNOWN-CODE-CANARY")).toBe(true);
    let snapshot = (await pool.query("SELECT snapshot FROM activity_event_outbox WHERE source_id=$1 ORDER BY activity_revision DESC LIMIT 1", [queued.id])).rows[0].snapshot;
    expect(snapshot.diagnostic).toEqual({ code: "generation_failed", message: "The generation could not be completed." });
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE-");
    await commands().retry({ ownerUserId, jobId: queued.id });
    await execution.claimNext({ workerId: "diagnostic", leaseSeconds: 30 });
    expect(await terminate("provider_transport_error")).toBe(true);
    snapshot = (await pool.query("SELECT snapshot FROM activity_event_outbox WHERE source_id=$1 ORDER BY activity_revision DESC LIMIT 1", [queued.id])).rows[0].snapshot;
    expect(snapshot.diagnostic).toEqual({ code: "provider_transport_error", message: "The provider connection failed." });
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE-");
    expect(snapshot.diagnostic.code).not.toBe("provider_request_timeout");
  });
  it.each(["provider_rate_limited", "provider_authentication_failed", "provider_request_timeout", "provider_transport_error"] as const)("preserves the current %s diagnostic when the executor persists a generic failure code", async (code) => {
    const imported = await campaign(), queued = await queue(imported.campaignId, "Inspect.");
    const execution = createPostgresGenerationExecutionRepository(pool);
    await execution.claimNext({ workerId: "executor-shape", leaseSeconds: 30 });
    const scope = { ownerUserId, jobId: queued.id, workerId: "executor-shape" };
    // Matches the real executor catch: generic durable code and CURRENT typed diagnostic.
    expect(await execution.markFailed({ ...scope, errorCode: "generation_failed", errorMessage: "The generation could not be completed.", recoveryMetadata: {},
      lastFailureDiagnostic: { version: 1, category: "unknown", code, phase: "generating", attemptNumber: 1, occurredAt: new Date().toISOString() }
    })).toBe(true);
    let snapshot = (await pool.query("SELECT snapshot FROM activity_event_outbox WHERE source_id=$1 ORDER BY activity_revision DESC LIMIT 1", [queued.id])).rows[0].snapshot;
    expect(snapshot.diagnostic).toEqual({ code, message: ACTIVITY_DIAGNOSTIC_MESSAGES[code] });
    await commands().retry({ ownerUserId, jobId: queued.id });
    await execution.claimNext({ workerId: "executor-shape", leaseSeconds: 30 });
    expect(await execution.markFailed({ ...scope, errorCode: "generation_failed", errorMessage: "PRIVATE-ERROR-CANARY", recoveryMetadata: {} })).toBe(true);
    snapshot = (await pool.query("SELECT snapshot FROM activity_event_outbox WHERE source_id=$1 ORDER BY activity_revision DESC LIMIT 1", [queued.id])).rows[0].snapshot;
    expect(snapshot.diagnostic).toEqual({ code: "generation_failed", message: ACTIVITY_DIAGNOSTIC_MESSAGES.generation_failed });
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE-");
  });
  it("captures provider failures without widening activity diagnostics or reusing evidence on recovery", async () => {
    const imported = await campaign(), queued = await queue(imported.campaignId, "Inspect.");
    const execution = createPostgresGenerationExecutionRepository(pool);
    await execution.claimNext({ workerId: "provider-evidence", leaseSeconds: 30 });
    const scope = { ownerUserId, jobId: queued.id, workerId: "provider-evidence" };
    const observedAt = new Date().toISOString();
    const providerFailure = {
      version: 1 as const, source: "http_error" as const, observedAt,
      httpStatus: 429, upstreamStatus: 429, reason: "rate_limit" as const,
      limitSource: "upstream_provider" as const, upstreamCode: null, providerName: "PRIVATE-PROVIDER-CANARY",
      retryAfterMs: 2000, retryAt: new Date(Date.parse(observedAt) + 2000).toISOString(), rateLimit: null,
      successfulResponseStarted: false, emittedOutput: false, metadataStatus: "recognized" as const
    };
    const lastFailureDiagnostic = { version: 1 as const, category: "unknown" as const, code: "provider_rate_limited" as const,
      phase: "generating", attemptNumber: 1, occurredAt: new Date().toISOString(), providerFailure };
    expect(await execution.markFailed({ ...scope, errorCode: "generation_failed", errorMessage: "PRIVATE-ERROR-CANARY",
      recoveryMetadata: {}, lastFailureDiagnostic })).toBe(true);
    const read = async () => (await pool.query(`SELECT status, orchestration_private->'lastFailureDiagnostic' AS diagnostic,
      (SELECT snapshot FROM activity_event_outbox WHERE source_id=$1 ORDER BY activity_revision DESC LIMIT 1) AS activity
      FROM generation_jobs WHERE id=$1`, [queued.id])).rows[0];
    let stored = await read();
    expect(stored.status).toBe("failed");
    expect(stored.diagnostic).toEqual(lastFailureDiagnostic);
    expect(stored.activity.diagnostic).toEqual({ code: "provider_rate_limited", message: ACTIVITY_DIAGNOSTIC_MESSAGES.provider_rate_limited });
    expect(JSON.stringify(stored.activity)).not.toContain("PRIVATE-");
    await commands().retry({ ownerUserId, jobId: queued.id });
    await execution.claimNext({ workerId: "provider-evidence", leaseSeconds: 30 });
    expect(await execution.markRecoverable({ ...scope, errorCode: "provider_transport_error", errorMessage: "PRIVATE-RECOVERY-CANARY",
      recoveryMetadata: {}, providerResponseId: null, providerFinishReason: null })).toBe(true);
    stored = await read();
    expect(stored.status).toBe("recoverable");
    expect(stored.diagnostic).toEqual(lastFailureDiagnostic);
    expect(stored.activity.diagnostic).toEqual({ code: "provider_transport_error", message: ACTIVITY_DIAGNOSTIC_MESSAGES.provider_transport_error });
    expect(JSON.stringify(stored.activity)).not.toContain("PRIVATE-");
  });
  it("captures tracker identity recovery with the generic Activity diagnostic and private job-specific recovery", async () => {
    const imported = await campaign(), queued = await queue(imported.campaignId, "PRIVATE-TRACKER-ACTION");
    const execution = createPostgresGenerationExecutionRepository(pool);
    await execution.claimNext({ workerId: "tracker-recovery", leaseSeconds: 30 });
    const scope = { ownerUserId, jobId: queued.id, workerId: "tracker-recovery" };
    const errorMessage = "Tracker updates could not be matched safely. Discard this attempt and resolve the tracker identity before generating again.";

    expect(await execution.markRecoverable({ ...scope, errorCode: "tracker_update_identity_invalid", errorMessage,
      recoveryMetadata: { reason: "tracker_update_identity_invalid", diagnostic: { code: "tracker_update_identity_invalid",
        operation: "story_generation", action: "repair_authority" } }, providerResponseId: null, providerFinishReason: null
    })).toBe(true);

    const activity = (await events(queued.id)).at(-1)?.snapshot;
    expect(activity).toMatchObject({ kind: "generation.recoverable", status: "recoverable",
      diagnostic: { code: "generation_failed", message: "The generation could not be completed." } });
    const stored = await pool.query<{ status: string; recovery_metadata: Record<string, unknown> }>(
      "SELECT status,recovery_metadata FROM generation_jobs WHERE id=$1", [queued.id]
    );
    expect(stored.rows[0]).toMatchObject({ status: "recoverable", recovery_metadata: {
      reason: "tracker_update_identity_invalid", diagnostic: { code: "tracker_update_identity_invalid",
        operation: "story_generation", action: "repair_authority" }
    } });
    expect(JSON.stringify(activity)).not.toMatch(/PRIVATE-|Gate|north private value|south private value|ambiguous_name|conflicting_identity/);
  });
  it("does not let an expired tracker-recovery lease overwrite the new claimant", async () => {
    const imported = await campaign(), queued = await queue(imported.campaignId, "Inspect.");
    const execution = createPostgresGenerationExecutionRepository(pool);
    await execution.claimNext({ workerId: "tracker-stale", leaseSeconds: 30 });
    await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [queued.id]);
    await execution.claimNext({ workerId: "tracker-current", leaseSeconds: 30 });

    expect(await execution.markRecoverable({ ownerUserId, jobId: queued.id, workerId: "tracker-stale",
      errorCode: "tracker_update_identity_invalid", errorMessage: "fixed tracker recovery message",
      recoveryMetadata: { reason: "tracker_update_identity_invalid" }, providerResponseId: null, providerFinishReason: null
    })).toBe(false);
    expect(await pool.query<{ status: string; lease_owner: string }>(
      "SELECT status,lease_owner FROM generation_jobs WHERE id=$1", [queued.id]
    )).toMatchObject({ rows: [{ status: "assessing", lease_owner: "tracker-current" }] });
  });
  it("staleWorkerCapturesNothing and foreign owners cannot capture", async () => {
    const imported = await campaign(), queued = await queue(imported.campaignId, "Inspect.");
    const execution = createPostgresGenerationExecutionRepository(pool);
    await execution.claimNext({ workerId: "current", leaseSeconds: 30 });
    const before = await events(queued.id);
    expect(await execution.markGenerating({ ownerUserId, jobId: queued.id, workerId: "stale" })).toBe(false);
    expect(await execution.markGenerating({ ownerUserId: crypto.randomUUID(), jobId: queued.id, workerId: "current" })).toBe(false);
    await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [queued.id]);
    expect(await execution.markGenerating({ ownerUserId, jobId: queued.id, workerId: "current" })).toBe(false);
    expect(await events(queued.id)).toEqual(before);
  });
  it("same-status reclaim and semantic repair restart do not invent phases", async () => {
    const imported = await campaign(), queued = await queue(imported.campaignId, "Inspect.");
    const execution = createPostgresGenerationExecutionRepository(pool);
    await execution.claimNext({ workerId: "first", leaseSeconds: 30 });
    await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [queued.id]);
    await execution.claimNext({ workerId: "reclaimed", leaseSeconds: 30 });
    expect(await events(queued.id)).toHaveLength(2);
    const scope = { ownerUserId, jobId: queued.id, workerId: "reclaimed" };
    await execution.markGenerating(scope); await execution.markValidating(scope);
    const before = await events(queued.id);
    expect(await execution.restartAfterSemanticRepair!(scope)).toBe(true);
    expect(await events(queued.id)).toEqual(before);
  });
  it("capture failure rolls back guarded phase and revision", async () => {
    const imported = await campaign(), queued = await queue(imported.campaignId, "Inspect.");
    const execution = createPostgresGenerationExecutionRepository(pool);
    await execution.claimNext({ workerId: "rollback", leaseSeconds: 30 });
    await pool.query(`CREATE FUNCTION reject_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'capture rejected'; END $$`);
    await pool.query("CREATE TRIGGER reject_activity BEFORE INSERT ON activity_event_outbox FOR EACH ROW EXECUTE FUNCTION reject_activity()");
    try {
      await expect(execution.markGenerating({ ownerUserId, jobId: queued.id, workerId: "rollback" })).rejects.toThrow("capture rejected");
      expect((await pool.query("SELECT status,activity_revision::text FROM generation_jobs WHERE id=$1", [queued.id])).rows[0]).toEqual({ status: "assessing", activity_revision: "2" });
      expect(await events(queued.id)).toHaveLength(2);
    } finally { await pool.query("DROP TRIGGER reject_activity ON activity_event_outbox"); await pool.query("DROP FUNCTION reject_activity()"); }
  });
  it("alternate invalid authority exit captures recoverable without private saved evidence", async () => {
    const imported = await campaign(), queued = await queue(imported.campaignId, "Inspect.");
    await pool.query(`UPDATE generation_jobs SET orchestration_private='{"semanticRepair":{"private":"PRIVATE-CHECKPOINT-CANARY"}}'::jsonb WHERE id=$1`, [queued.id]);
    const execution = createPostgresGenerationExecutionRepository(pool);
    const claim = await execution.claimNext({ workerId: "invalid-checkpoint", leaseSeconds: 30 });
    expect(await execution.loadExecutionPayload({ claim: claim!, workerId: "invalid-checkpoint", leaseSeconds: 30 })).toBeNull();
    expect((await events(queued.id)).map(row => row.snapshot.kind)).toEqual(["generation.queued","generation.claimed","generation.recoverable"]);
    expect(JSON.stringify(await events(queued.id))).not.toContain("PRIVATE-");
  });
});
