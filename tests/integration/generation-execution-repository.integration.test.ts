import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema } from "../../packages/contracts/src/generation.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import {
  createPostgresGenerationExecutionRepository,
  type GenerationLeaseScope
} from "../../packages/database/src/generation-execution-repository.js";
import { createPostgresGenerationCommandRepository } from "../../packages/database/src/generation-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { turnReportedCosts } from "../../services/api/src/cost-service.js";
import { importLegacyStory } from "../../services/api/src/import-service.js";
import { promptProtocolVersion, resolvePromptSnapshot } from "../../services/api/src/prompt-library-service.js";
import { createProvider } from "../../services/api/src/provider-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "generation-execution-repository-secret";

integration("PostgreSQL generation execution repository", () => {
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
      resolvePromptSnapshot,
      promptProtocolVersion,
      readTurnReportedCosts: (scopeOwnerUserId, turnIds) =>
        turnReportedCosts(pool, scopeOwnerUserId, [...turnIds])
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

  function attemptInput(scope: GenerationLeaseScope, attemptNumber = 1) {
    return {
      ...scope,
      attemptNumber,
      recoveryKind: "initial",
      requestMetadata: { model: "execution-repository-model" },
      responseMetadata: { outputLimited: false },
      providerResponseId: crypto.randomUUID(),
      finishReason: "stop",
      rawOutput: "A safe fictional response.",
      validationErrors: [],
      overwrite: true
    };
  }

  async function recordAttemptRaceState(
    settled: () => boolean,
    blockerPid: number
  ): Promise<"blocked" | "settled" | "timeout"> {
    for (let index = 0; index < 500; index += 1) {
      if (settled()) return "settled";
      const activity = await pool.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND query LIKE '%INSERT INTO generation_attempts%'
              AND wait_event_type = 'Lock'
              AND $1 = ANY(pg_blocking_pids(pid))
         ) AS blocked`,
        [blockerPid]
      );
      if (activity.rows[0]?.blocked) return "blocked";
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    }
    return "timeout";
  }

  it("claims a minimal job once and reclaims an expired lease without an initial-owner lookup", async () => {
    const imported = await campaign();
    const queued = await queue(imported.campaignId, "Open the lease observatory.");
    const repository = createPostgresGenerationExecutionRepository(pool);

    const claims = await Promise.all([
      repository.claimNext({ workerId: "worker-a", leaseSeconds: 30 }),
      repository.claimNext({ workerId: "worker-b", leaseSeconds: 30 })
    ]);
    const claimed = claims.find((value) => value?.jobId === queued.id);

    expect(claimed).toEqual({
      jobId: queued.id,
      ownerUserId,
      campaignId: imported.campaignId,
      providerProfileId,
      expectedTurnNumber: 3,
      attempts: 1,
      operationKind: "append",
      replacementTurnId: null
    });
    expect(claims.filter((value) => value?.jobId === queued.id)).toHaveLength(1);

    await pool.query(
      "UPDATE generation_jobs SET status = 'generating', lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [queued.id]
    );
    const reclaimed = await repository.claimNext({ workerId: "worker-c", leaseSeconds: 45 });
    expect(reclaimed).toMatchObject({ jobId: queued.id, ownerUserId, attempts: 2 });

    await expect(repository.loadExecutionPayload({
      workerId: "worker-a",
      leaseSeconds: 30,
      claim: claimed!
    })).resolves.toBeNull();
    await expect(repository.loadExecutionPayload({
      workerId: "worker-c",
      leaseSeconds: 45,
      claim: reclaimed!
    })).resolves.toMatchObject({
      id: queued.id,
      owner_user_id: ownerUserId,
      campaign_id: imported.campaignId,
      attempts: 2
    });
  });

  it("guards payload loading by durable owner, lease owner, and assessing state", async () => {
    const imported = await campaign();
    const queued = await queue(imported.campaignId, "Inspect the guarded payload archive.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "guard-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);

    await expect(repository.loadExecutionPayload({
      workerId: "guard-worker",
      leaseSeconds: 30,
      claim: { ...claim!, ownerUserId: crypto.randomUUID() }
    })).resolves.toBeNull();

    await commands().cancel({ ownerUserId, jobId: queued.id });
    await expect(repository.loadExecutionPayload({
      workerId: "guard-worker",
      leaseSeconds: 30,
      claim: claim!
    })).resolves.toBeNull();
  });

  it("applies lease and phase mutations only to the claimed owner, worker, and source state", async () => {
    const imported = await campaign();
    const queued = await queue(imported.campaignId, "Trace the durable phase corridor.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "phase-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const scope = { jobId: queued.id, ownerUserId, workerId: "phase-worker" };

    await expect(repository.renewLease(scope, 60)).resolves.toBe(true);
    await expect(repository.renewLease({ ...scope, workerId: "foreign-worker" }, 60)).resolves.toBe(false);
    await expect(repository.saveOrchestration(scope, { roll: null })).resolves.toBe(true);
    await expect(repository.markGenerating(scope)).resolves.toBe(true);
    await expect(repository.markGenerating(scope)).resolves.toBe(false);
    await expect(repository.recordAttempt(attemptInput(scope))).resolves.toBeUndefined();
    await expect(repository.recordAttempt(attemptInput({
      ...scope,
      workerId: "foreign-worker"
    }, 2))).rejects.toMatchObject({ code: "generation_cancelled" });
    await expect(repository.savePartialNarration(scope, "A safe fictional preview.")).resolves.toBe(true);
    await expect(repository.saveStreamingSegments(scope, { provisionalSetId: null })).resolves.toBe(true);
    await expect(repository.markValidating(scope)).resolves.toBe(true);
    await expect(repository.markCommitting(scope)).resolves.toBe(true);
    await expect(repository.markFailed({
      ...scope,
      errorCode: "generation_failed",
      errorMessage: "The story could not be generated.",
      recoveryMetadata: { transportError: false }
    })).resolves.toBe(true);
    await expect(repository.markFailed({
      ...scope,
      errorCode: "generation_failed",
      errorMessage: "The story could not be generated.",
      recoveryMetadata: {}
    })).resolves.toBe(false);

    await expect(pool.query<{
      status: string;
      partial_output: string | null;
      orchestration_private: Record<string, unknown>;
      streaming_segments_state: Record<string, unknown>;
    }>(
      `SELECT status, partial_output, orchestration_private, streaming_segments_state
         FROM generation_jobs WHERE id = $1`,
      [queued.id]
    )).resolves.toMatchObject({ rows: [{
      status: "failed",
      partial_output: "A safe fictional preview.",
      orchestration_private: { roll: null },
      streaming_segments_state: { provisionalSetId: null }
    }] });
    await expect(pool.query<{ attempt_number: number }>(
      "SELECT attempt_number FROM generation_attempts WHERE generation_job_id = $1",
      [queued.id]
    )).resolves.toMatchObject({ rows: [{ attempt_number: 1 }] });
  });

  it("does not overwrite attempt metadata after cancellation wins the row-lock race", async () => {
    const imported = await campaign();
    const queued = await queue(imported.campaignId, "Cancel the stale attempt recorder.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "cancelled-attempt-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const scope = {
      jobId: queued.id,
      ownerUserId,
      workerId: "cancelled-attempt-worker"
    };
    await expect(repository.recordAttempt(attemptInput(scope))).resolves.toBeUndefined();
    const cancellation = await pool.connect();
    let settled = false;
    let attemptOutcome: Promise<{ status: "resolved" } | { status: "rejected"; error: unknown }> | undefined;
    try {
      await cancellation.query("BEGIN");
      const blockerPid = (await cancellation.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid"
      )).rows[0]!.pid;
      await cancellation.query(
        `UPDATE generation_jobs
            SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL
          WHERE id = $1 AND owner_user_id = $2`,
        [queued.id, ownerUserId]
      );
      attemptOutcome = repository.recordAttempt({
        ...attemptInput(scope),
        responseMetadata: { outputLimited: true },
        rawOutput: "Stale output that must not overwrite the admitted attempt."
      }).then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error })
      ).finally(() => { settled = true; });

      expect(await recordAttemptRaceState(() => settled, blockerPid)).toBe("blocked");
      await cancellation.query("COMMIT");
    } finally {
      await cancellation.query("ROLLBACK").catch(() => undefined);
      cancellation.release();
    }

    await expect(attemptOutcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "generation_cancelled" }
    });
    await expect(pool.query(
      "SELECT raw_output FROM generation_attempts WHERE generation_job_id = $1",
      [queued.id]
    )).resolves.toMatchObject({ rows: [{ raw_output: "A safe fictional response." }] });
  });

  it("rejects a stale attempt recorder after expired-lease reclaim wins the row-lock race", async () => {
    const imported = await campaign();
    const queued = await queue(imported.campaignId, "Reclaim the stale attempt recorder.");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId: "expired-attempt-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const staleScope = {
      jobId: queued.id,
      ownerUserId,
      workerId: "expired-attempt-worker"
    };
    await expect(repository.markGenerating(staleScope)).resolves.toBe(true);
    await pool.query(
      "UPDATE generation_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [queued.id]
    );

    const reclaim = await pool.connect();
    let settled = false;
    let attemptOutcome: Promise<{ status: "resolved" } | { status: "rejected"; error: unknown }> | undefined;
    try {
      await reclaim.query("BEGIN");
      const blockerPid = (await reclaim.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid"
      )).rows[0]!.pid;
      const reclaimed = await reclaim.query<{ id: string }>(
        `UPDATE generation_jobs
            SET status = 'assessing', attempts = attempts + 1,
                lease_owner = 'replacement-attempt-worker',
                lease_expires_at = now() + interval '30 seconds'
          WHERE id = $1 AND owner_user_id = $2
            AND status = 'generating' AND lease_expires_at < now()
          RETURNING id`,
        [queued.id, ownerUserId]
      );
      expect(reclaimed.rows).toEqual([{ id: queued.id }]);
      attemptOutcome = repository.recordAttempt(attemptInput(staleScope)).then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error })
      ).finally(() => { settled = true; });

      expect(await recordAttemptRaceState(() => settled, blockerPid)).toBe("blocked");
      await reclaim.query("COMMIT");
    } finally {
      await reclaim.query("ROLLBACK").catch(() => undefined);
      reclaim.release();
    }

    await expect(attemptOutcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "generation_cancelled" }
    });
    await expect(pool.query(
      "SELECT id FROM generation_attempts WHERE generation_job_id = $1",
      [queued.id]
    )).resolves.toMatchObject({ rows: [] });
  });
});
