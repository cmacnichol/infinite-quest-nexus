import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresPreparedTextAttemptRepository } from "../../packages/database/src/prepared-text-attempt-repository.js";
import type { ProviderFailureEvidenceV1 } from "../../packages/contracts/src/provider-failure.js";

const integration = process.env.TEST_DATABASE_URL ? describe.sequential : describe.skip;
const evidence: ProviderFailureEvidenceV1 = {
  version: 1, source: "http_error", observedAt: "2026-10-03T12:00:00.000Z", httpStatus: 429,
  upstreamStatus: null, reason: "rate_limit", limitSource: "unknown", upstreamCode: null,
  providerName: null, retryAfterMs: 1000, retryAt: "2026-10-03T12:00:01.000Z", rateLimit: null,
  successfulResponseStarted: false, emittedOutput: false, metadataStatus: "absent"
};
const completion = {
  outcome: "failed", failureReason: "rate_limit", providerResponseId: "rejected-request-id",
  returnedModel: null, returnedProviderRoute: null, emittedOutput: false,
  usage: { inputTokens: 2 }, reportedCost: { amount: "0.01", currency: "USD" }, failureDiagnostic: evidence
} as const;

integration("physical provider failure evidence", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });
  afterAll(async () => pool.end());

  async function fixture() {
    const repository = createPostgresPreparedTextAttemptRepository(pool);
    const reservation = { kind: "direct", ownerUserId, requestScopeId: crypto.randomUUID(), invocationId: crypto.randomUUID(), operation: "initial" } as const;
    const input = { logicalReservation: reservation, candidateOrdinal: 0,
      planProvenance: { planHash: "a".repeat(64), preset: null },
      candidate: { modelId: "test/model", providerPolicy: {}, contextWindowTokens: 1000, maxOutputTokens: 100 },
      request: { body: "{}", payloadHash: "b".repeat(64) } };
    const reserved = await repository.reserve(input);
    expect(reserved).toMatchObject({ failureDiagnostic: null, responseStarted: false });
    const attempt = await repository.markDispatched(reservation, reserved!.id, input.request.payloadHash);
    return { repository, reservation, input, id: attempt!.id };
  }

  it("atomically stores evidence, keeps rejected IDs distinct from response start, and preserves cost totals", async () => {
    const f = await fixture();
    const result = await f.repository.complete(f.reservation, f.id, completion);
    expect(result).toMatchObject({ status: "completed", failureDiagnostic: evidence, responseStarted: false, providerResponseId: "rejected-request-id" });
    expect(await f.repository.reserve(f.input)).toEqual(result);
    expect((await pool.query("SELECT outcome,failure_reason,failure_diagnostic,response_started_at FROM prepared_text_physical_attempts WHERE id=$1", [f.id])).rows[0])
      .toEqual({ outcome: "failed", failure_reason: "rate_limit", failure_diagnostic: evidence, response_started_at: null });
    expect(await f.repository.summarize({ kind: "logical", reservation: f.reservation }))
      .toMatchObject({ attemptCount: 1, completedCount: 1, observedUsage: { inputTokens: 2 }, reportedCosts: [{ amount: "0.01", currency: "USD" }] });
    expect(await f.repository.complete(f.reservation, f.id, { ...completion, failureDiagnostic: { ...evidence, httpStatus: 503 } })).toBeNull();
    expect((await f.repository.reserve(f.input))!.failureDiagnostic).toEqual(evidence);
  });

  it("rejects foreign owner and reservation writes without recording failure", async () => {
    const f = await fixture();
    expect(await f.repository.complete({ ...f.reservation, ownerUserId: crypto.randomUUID() }, f.id, completion)).toBeNull();
    expect(await f.repository.complete({ ...f.reservation, invocationId: crypto.randomUUID() }, f.id, completion)).toBeNull();
    expect(await f.repository.reserve(f.input)).toMatchObject({ status: "dispatched", failureDiagnostic: null });
  });

  it("rejects stale lease completion", async () => {
    const f = await fixture();
    const jobId = crypto.randomUUID();
    const stageId = crypto.randomUUID();
    const leaseToken = crypto.randomUUID();
    await pool.query(`INSERT INTO authoring_jobs (id,owner_user_id,kind,target,input,request_hash,idempotency_key,status,execution_generation)
      VALUES ($1,$2,'world_concept','{}','{}',$3,$4,'running',1)`, [jobId, ownerUserId, "a".repeat(64), crypto.randomUUID()]);
    await pool.query(`INSERT INTO authoring_job_stages (id,job_id,owner_user_id,stage_key,generation,status,attempt_count,lease_token,lease_owner,lease_expires_at)
      VALUES ($1,$2,$3,'outline',1,'running',1,$4,'worker',now()+interval '5 minutes')`, [stageId, jobId, ownerUserId, leaseToken]);
    const reservation = { kind: "authoring", ownerUserId, jobId, stageId, jobGeneration: 1, stageGeneration: 1, leaseToken, operation: "initial" } as const;
    const attempt = await f.repository.reserve({ ...f.input, logicalReservation: reservation });
    await f.repository.markDispatched(reservation, attempt!.id, f.input.request.payloadHash);
    expect(await f.repository.complete({ ...reservation, leaseToken: crypto.randomUUID() }, attempt!.id, completion)).toBeNull();
    await pool.query("UPDATE authoring_job_stages SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [stageId]);
    expect(await f.repository.complete(reservation, attempt!.id, completion)).toBeNull();
    expect((await pool.query("SELECT status,failure_diagnostic FROM prepared_text_physical_attempts WHERE id=$1", [attempt!.id])).rows[0])
      .toEqual({ status: "dispatched", failure_diagnostic: null });
  });

  it("reads historical null evidence and uses actual response-start timestamp", async () => {
    const f = await fixture();
    expect(await f.repository.recordResponseStart(f.reservation, f.id, { providerResponseId: null })).toMatchObject({ responseStarted: true, failureDiagnostic: null });
    expect(await f.repository.complete(f.reservation, f.id, { ...completion, providerResponseId: null, failureDiagnostic: null }))
      .toMatchObject({ responseStarted: true, failureDiagnostic: null });
  });

  it.each(["malformed", "oversized"] as const)("records original failure with minimal safe %s evidence", async (kind) => {
    const f = await fixture();
    const invalid = { ...evidence, retryAt: "wrong", message: kind === "oversized" ? "secret".repeat(1000) : "secret" } as unknown as ProviderFailureEvidenceV1;
    expect(await f.repository.complete(f.reservation, f.id, { ...completion, failureDiagnostic: invalid }))
      .toMatchObject({ status: "completed", failureDiagnostic: { version: 1, source: "http_error", httpStatus: 429, reason: "rate_limit", metadataStatus: kind, retryAt: null, retryAfterMs: null } });
    const stored = JSON.stringify((await f.repository.reserve(f.input))!.failureDiagnostic);
    expect(stored).not.toContain("secret");
  });

  it("reconstructs schema-valid fallback evidence when timezone normalization expands the year", async () => {
    const f = await fixture();
    const invalid = { ...evidence, observedAt: "9999-12-31T23:59:59-01:00" };
    const startedAt = Date.now();
    const result = await f.repository.complete(f.reservation, f.id, { ...completion, failureDiagnostic: invalid });
    expect(result).toMatchObject({ status: "completed", failureDiagnostic: {
      reason: "rate_limit", httpStatus: 429, metadataStatus: "malformed", retryAt: null
    } });
    expect(Date.parse(result!.failureDiagnostic!.observedAt)).toBeGreaterThanOrEqual(startedAt);
    expect(Date.parse(result!.failureDiagnostic!.observedAt)).toBeLessThanOrEqual(Date.now());
    expect(await f.repository.reserve(f.input)).toEqual(result);
    expect((await pool.query("SELECT outcome,failure_reason FROM prepared_text_physical_attempts WHERE id=$1", [f.id])).rows[0])
      .toEqual({ outcome: "failed", failure_reason: "rate_limit" });
  });
  it("enforces object/version/UTF-8 byte size constraints in PostgreSQL", async () => {
    const f = await fixture();
    for (const value of [[], {}, { version: 2 }, { version: 1, raw: "é".repeat(2500) }]) {
      await expect(pool.query("UPDATE prepared_text_physical_attempts SET failure_diagnostic=$2::jsonb WHERE id=$1", [f.id, JSON.stringify(value)]))
        .rejects.toMatchObject({ code: "23514" });
    }
  });
});
