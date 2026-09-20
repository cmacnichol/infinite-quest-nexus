import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPostgresPreparedTextAttemptRepository } from "../../packages/database/src/prepared-text-attempt-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { executePresetRoutes, type LogicalReservation } from "../../packages/story-engine/src/preset-route-execution.js";

const integration = process.env.TEST_DATABASE_URL ? describe.sequential : describe.skip;
const candidates = [
  { modelId: "route/model-a", providerPolicy: { only: ["route-a"] }, contextWindowTokens: 16_000, maxOutputTokens: 1_000 },
  { modelId: "route/model-b", providerPolicy: { order: ["route-b"], allow_fallbacks: false, data_collection: "deny" as const }, contextWindowTokens: 16_000, maxOutputTokens: 1_000 }
];
const planProvenance = {
  planHash: "a".repeat(64),
  preset: { slug: "durable-preset", versionId: "preset-v1", configHash: "b".repeat(64) }
} as const;

integration("durable preset physical attempts", () => {
  let pool: DatabasePool;
  let ownerUserId: string;

  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => pool.end());

  async function authoringReservation(operation: "initial" | "repair" = "initial") {
    const jobId = crypto.randomUUID();
    const stageId = crypto.randomUUID();
    const leaseToken = crypto.randomUUID();
    await pool.query(
      `INSERT INTO authoring_jobs (id,owner_user_id,kind,target,input,request_hash,idempotency_key,status,execution_generation)
       VALUES ($1,$2,'world_concept','{}'::jsonb,'{}'::jsonb,$3,$4,'running',1)`,
      [jobId, ownerUserId, "a".repeat(64), crypto.randomUUID()]
    );
    await pool.query(
      `INSERT INTO authoring_job_stages (id,job_id,owner_user_id,stage_key,generation,status,attempt_count,lease_token,lease_owner,lease_expires_at)
       VALUES ($1,$2,$3,'outline',1,'running',1,$4,'worker-a',now()+interval '5 minutes')`,
      [stageId, jobId, ownerUserId, leaseToken]
    );
    return {
      reservation: { kind: "authoring", ownerUserId, jobId, stageId, jobGeneration: 1, stageGeneration: 1, leaseToken, operation } as const,
      jobId, stageId
    };
  }

  it("persists safe fallback attempts in frozen order and isolates logical owners", async () => {
    const attempts = createPostgresPreparedTextAttemptRepository(pool);
    const firstScope = { kind: "direct", ownerUserId, requestScopeId: crypto.randomUUID(), invocationId: crypto.randomUUID(), operation: "initial" } as const;
    const secondScope = { ...firstScope, requestScopeId: crypto.randomUUID() };
    const invoke = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { statusCode: 429, retryAfterMs: 0 }))
      .mockResolvedValueOnce({ content: "accepted", responseId: "response-b", returnedModel: "route/model-b", returnedProviderRoute: "route-b", usageReported: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, reportedCost: null });
    const execute = (logicalReservation: LogicalReservation, currentInvoke = invoke) => executePresetRoutes({
      candidates, planProvenance, logicalReservation, attempts,
      prepareCandidate: (candidate, index) => ({ body: JSON.stringify({ model: candidate.modelId, index }), payloadHash: `${index + 1}`.repeat(64) }),
      invoke: currentInvoke, totalDeadlineMs: 2_000, sleep: async () => undefined
    });

    const first = await execute(firstScope);
    const second = await execute(secondScope, vi.fn(async ({ candidate, preparedRequest }) => ({
      content: "separate", responseId: "response-separate", returnedModel: candidate.modelId,
      returnedProviderRoute: "route-a", usageReported: true, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      reportedCost: { amount: "0.001", currency: "USD" }, preparedRequest
    })));

    expect(first.candidateOrdinal).toBe(1);
    expect(second.attemptId).not.toBe(first.attemptId);
    const rows = await pool.query<{ reservation_key: string; candidate_ordinal: number; outcome: string; failure_reason: string | null; usage: unknown; reported_cost: unknown; plan_hash: string; requested_preset_slug: string; requested_preset_version_id: string; requested_preset_config_hash: string; emitted_output: boolean }>(
      `SELECT reservation_key,candidate_ordinal,outcome,failure_reason,usage,reported_cost,plan_hash,
              requested_preset_slug,requested_preset_version_id,requested_preset_config_hash,emitted_output
         FROM prepared_text_physical_attempts
        WHERE reservation_key LIKE ANY($1::text[]) ORDER BY reservation_key,candidate_ordinal`,
      [[`${firstScope.requestScopeId}:%`, `${secondScope.requestScopeId}:%`]]
    );
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.filter((row) => row.reservation_key.startsWith(firstScope.requestScopeId))).toEqual([
      expect.objectContaining({ candidate_ordinal: 0, outcome: "failed", failure_reason: "rate_limit", usage: null, reported_cost: null,
        plan_hash: planProvenance.planHash, requested_preset_slug: "durable-preset", requested_preset_version_id: "preset-v1",
        requested_preset_config_hash: planProvenance.preset.configHash, emitted_output: false }),
      expect.objectContaining({ candidate_ordinal: 1, outcome: "succeeded", failure_reason: null, usage: null, reported_cost: null,
        plan_hash: planProvenance.planHash, emitted_output: false })
    ]);
    expect(rows.rows.find((row) => row.reservation_key.startsWith(secondScope.requestScopeId))).toMatchObject({
      candidate_ordinal: 0, outcome: "succeeded", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      reported_cost: { amount: "0.001", currency: "USD" }
    });
  });

  it("rejects late completion after durable lease loss and records no accounting", async () => {
    const attempts = createPostgresPreparedTextAttemptRepository(pool);
    const fixture = await authoringReservation();
    await expect(executePresetRoutes({
      candidates: candidates.slice(0, 1), planProvenance, logicalReservation: fixture.reservation, attempts,
      prepareCandidate: () => ({ body: "{}", payloadHash: "c".repeat(64) }), totalDeadlineMs: 2_000,
      invoke: async () => {
        await pool.query(
          `UPDATE authoring_job_stages SET status='recoverable',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
            WHERE id=$1`,
          [fixture.stageId]
        );
        return { content: "late", returnedModel: "route/model-a", returnedProviderRoute: "route-a",
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, reportedCost: { amount: "1", currency: "USD" } };
      }
    })).rejects.toMatchObject({ code: "prepared_route_lease_lost" });
    const row = await pool.query<{ status: string; usage: unknown; reported_cost: unknown }>(
      "SELECT status,usage,reported_cost FROM prepared_text_physical_attempts WHERE reservation_key LIKE $1",
      [`${fixture.jobId}:%`]
    );
    expect(row.rows).toEqual([{ status: "dispatched", usage: null, reported_cost: null }]);
  });

  it("never resends or advances an unknown dispatched attempt after reclaim", async () => {
    const attempts = createPostgresPreparedTextAttemptRepository(pool);
    const fixture = await authoringReservation();
    const request = { body: "{}", payloadHash: "d".repeat(64) };
    const reserved = await attempts.reserve({ logicalReservation: fixture.reservation, planProvenance, candidateOrdinal: 0, candidate: candidates[0]!, request });
    expect(reserved?.status).toBe("reserved");
    expect((await attempts.markDispatched(fixture.reservation, reserved!.id, request.payloadHash))?.status).toBe("dispatched");
    const nextLeaseToken = crypto.randomUUID();
    await pool.query(
      `UPDATE authoring_job_stages SET attempt_count=attempt_count+1,lease_token=$2,lease_owner='worker-b',lease_expires_at=now()+interval '5 minutes'
        WHERE id=$1`,
      [fixture.stageId, nextLeaseToken]
    );
    const reclaimed = { ...fixture.reservation, leaseToken: nextLeaseToken };
    const invoke = vi.fn();
    await expect(executePresetRoutes({
      candidates, planProvenance, logicalReservation: reclaimed, attempts,
      prepareCandidate: () => request, invoke, totalDeadlineMs: 2_000
    })).rejects.toMatchObject({ code: "prepared_route_unknown_outcome", attemptId: reserved!.id });
    expect(invoke).not.toHaveBeenCalled();
    expect((await pool.query("SELECT count(*)::int AS count FROM prepared_text_physical_attempts WHERE reservation_key LIKE $1", [`${fixture.jobId}:%`])).rows[0].count).toBe(1);
  });

  it("durably records direct-request provenance and emitted output before terminal completion", async () => {
    const attempts = createPostgresPreparedTextAttemptRepository(pool);
    const scope = { kind: "direct", ownerUserId, requestScopeId: crypto.randomUUID(), invocationId: crypto.randomUUID(), operation: "initial" } as const;
    await expect(executePresetRoutes({
      candidates: candidates.slice(0, 1), planProvenance, logicalReservation: scope, attempts,
      prepareCandidate: () => ({ body: "{}", payloadHash: "e".repeat(64) }), totalDeadlineMs: 2_000,
      invoke: async ({ onOutput }) => {
        await onOutput("partial narration");
        throw Object.assign(new Error("stream interrupted"), { routeFailureReason: "ambiguous_transport" });
      }
    })).rejects.toMatchObject({ reason: "ambiguous_transport" });
    const row = (await pool.query<{
      planHash: string; requestedPresetSlug: string; requestedPresetVersionId: string; requestedPresetConfigHash: string;
      emittedOutput: boolean; outcome: string; failureReason: string | null;
    }>(
      `SELECT plan_hash AS "planHash",requested_preset_slug AS "requestedPresetSlug",
              requested_preset_version_id AS "requestedPresetVersionId",requested_preset_config_hash AS "requestedPresetConfigHash",
              emitted_output AS "emittedOutput",outcome,failure_reason AS "failureReason"
         FROM prepared_text_physical_attempts WHERE reservation_key LIKE $1`,
      [`${scope.requestScopeId}:%`]
    )).rows[0]!;
    expect(row).toEqual({
      planHash: planProvenance.planHash, requestedPresetSlug: "durable-preset", requestedPresetVersionId: "preset-v1",
      requestedPresetConfigHash: planProvenance.preset.configHash, emittedOutput: true,
      outcome: "failed", failureReason: "ambiguous_transport"
    });
  });
});
