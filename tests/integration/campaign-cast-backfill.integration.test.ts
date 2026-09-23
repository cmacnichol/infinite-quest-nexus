import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createCastBackfillRepository } from "../../packages/database/src/campaign-cast-backfill-repository.js";
import { createCastDiscoveryJobRepository, enqueueCastDiscoveryWithClient } from "../../packages/database/src/campaign-cast-job-repository.js";
import { deriveTextExecutionPlan, textExecutionRouteBasisHash } from "../../packages/contracts/src/text-execution-plan.js";
import { CAST_DISCOVERY_SYSTEM_PROMPT } from "../../packages/contracts/src/prompt-library.js";

describe("accepted-history scan preview", () => {
  let pool: DatabasePool, ownerUserId: string;
  const campaignIds: string[] = [];
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  }, 60000);
  afterEach(async () => { await pool.query("DELETE FROM campaigns WHERE id=ANY($1::uuid[])", [campaignIds.splice(0)]); });
  afterAll(async () => { await pool?.end(); });
  async function fixture() {
    const worldId = randomUUID(), versionId = randomUUID(), campaignId = randomUUID(), providerProfileId = randomUUID();
    campaignIds.push(campaignId);
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Scan fixture')", [worldId, ownerUserId]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,'{}')", [versionId, worldId, ownerUserId]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title,active_turn_number) VALUES($1,$2,$3,'Scan fixture',3)", [campaignId, ownerUserId, versionId]);
    const turnIds: string[] = [];
    for (let n = 1; n <= 3; n++) {
      const id = randomUUID(); turnIds.push(id);
      await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,$4,'Mara has blue eyes.')", [id, ownerUserId, campaignId, n]);
    }
    const basis = { version: 2 as const, selection: { kind: "model" as const, modelId: "scan-fixture" }, preset: null,
      candidates: [{ modelId: "scan-fixture", providerPolicy: {}, contextWindowTokens: 8000, maxOutputTokens: 2000 }],
      presetSystemPrompt: "", parameters: {}, endpointReference: "fixture-endpoint", credentialReference: providerProfileId,
      profileRevision: "fixture", authorityRevision: "fixture", requestTimeoutMs: 30000, protocolVersion: "cast-discovery-v1", routeBasisHash: "0".repeat(64) };
    return { scope: { ownerUserId, campaignId }, turnIds,
      request: { fromTurn: 1, throughTurn: 3, expectedBoundary: { turnNumber: 3, timelineRevision: 0 }, idempotencyKey: "scan" },
      execution: { providerProfileId, plan: deriveTextExecutionPlan({ ...basis, routeBasisHash: textExecutionRouteBasisHash(basis) }, CAST_DISCOVERY_SYSTEM_PROMPT) } };
  }
  it("previews selected work without enrolling cast, enqueueing jobs or returning execution credentials", async () => {
    const f = await fixture();
    const result = await createCastBackfillRepository(pool).preview(f.scope, f.request, f.execution);
    expect(result).toEqual({ fromTurn: 1, throughTurn: 3, boundary: f.request.expectedBoundary, turnCount: 3,
      estimatedChunkRequests: 3, completedChunkReceipts: 0, completedTurns: 0, manualScanTurns: [],
      providerProfileId: f.execution.providerProfileId, selection: { kind: "model", modelId: "scan-fixture" } });
    expect((await pool.query("SELECT count(*)::int n FROM campaign_cast_state WHERE campaign_id=$1", [f.scope.campaignId])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM campaign_cast_discovery_jobs WHERE campaign_id=$1", [f.scope.campaignId])).rows[0].n).toBe(0);
  });
  it("reuses completed matching source receipts and does not reuse changed narration", async () => {
    const f = await fixture();
    await withTransaction(pool, client => enqueueCastDiscoveryWithClient(client, { scope: f.scope, turnId: f.turnIds[0]!, execution: f.execution, enabled: true }));
    const jobs = createCastDiscoveryJobRepository(pool, () => true), claim = (await jobs.claim("scan-preview"))!;
    await jobs.checkpoint(claim, { version: 1, characters: [] });
    expect(await jobs.publish(claim)).toBe("complete");
    const repo = createCastBackfillRepository(pool);
    expect(await repo.preview(f.scope, f.request, f.execution)).toMatchObject({ completedTurns: 1, completedChunkReceipts: 1, estimatedChunkRequests: 2 });
    await pool.query("UPDATE turns SET narration='Mara waits.' WHERE id=$1", [f.turnIds[0]]);
    expect(await repo.preview(f.scope, f.request, f.execution)).toMatchObject({ completedTurns: 0, completedChunkReceipts: 0, estimatedChunkRequests: 3 });
  });
  it("rejects foreign ownership, stale boundaries and absent accepted history", async () => {
    const f = await fixture(), repo = createCastBackfillRepository(pool);
    await expect(repo.preview({ ...f.scope, ownerUserId: randomUUID() }, f.request, f.execution)).rejects.toMatchObject({ code: "cast_not_found" });
    await expect(repo.preview(f.scope, { ...f.request, expectedBoundary: { turnNumber: 4, timelineRevision: 0 } }, f.execution)).rejects.toThrow("cast_stale_boundary");
    await pool.query("DELETE FROM turns WHERE id=$1", [f.turnIds[1]]);
    await expect(repo.preview(f.scope, f.request, f.execution)).rejects.toThrow("cast_history_gap");
  });
  it("deducts a durable checkpoint without counting it as published evidence", async () => {
    const f = await fixture();
    await withTransaction(pool, client => enqueueCastDiscoveryWithClient(client, { scope: f.scope, turnId: f.turnIds[0]!, execution: f.execution, enabled: true }));
    const jobs = createCastDiscoveryJobRepository(pool, () => true), claim = (await jobs.claim("checkpoint-preview"))!;
    await jobs.checkpoint(claim, { version: 1, characters: [] });
    expect(await createCastBackfillRepository(pool).preview(f.scope, f.request, f.execution))
      .toMatchObject({ completedTurns: 0, completedChunkReceipts: 0, estimatedChunkRequests: 2 });
  });
  it("persists a frozen Start and returns it after repository restart without duplicate work", async () => {
    const f = await fixture(), repo = createCastBackfillRepository(pool, () => true);
    const first = await repo.start(f.scope, f.request, f.execution);
    expect(first).toMatchObject({ fromTurn: 1, throughTurn: 3, completeTurns: 0, failedTurns: 0, pendingReviewCount: 0, status: "queued" });
    const changedExecution = { ...f.execution, providerProfileId: randomUUID() };
    expect(await createCastBackfillRepository(pool, () => true).start(f.scope, f.request, changedExecution)).toEqual(first);
    const stored = (await pool.query("SELECT execution_snapshot FROM campaign_cast_scans WHERE id=$1", [first.id])).rows[0];
    expect(stored.execution_snapshot).toEqual(f.execution);
    const items = (await pool.query("SELECT source FROM campaign_cast_scan_sources WHERE scan_id=$1 ORDER BY turn_number", [first.id])).rows;
    expect(items).toHaveLength(3);
    expect(items[0].source).toMatchObject({ turnId: f.turnIds[0], narrationRevision: 0, scope: f.scope });
    await pool.query("UPDATE turns SET narration='Changed after Start.' WHERE id=$1", [f.turnIds[0]]);
    expect((await pool.query("SELECT source FROM campaign_cast_scan_sources WHERE scan_id=$1 AND turn_number=1", [first.id])).rows[0].source).toEqual(items[0].source);
    expect((await pool.query("SELECT count(*)::int n FROM campaign_cast_scans WHERE campaign_id=$1", [f.scope.campaignId])).rows[0].n).toBe(1);
  });
  it("serializes concurrent Starts and rejects changed payloads under the same key", async () => {
    const f = await fixture(), repo = createCastBackfillRepository(pool, () => true);
    const attempts = await Promise.allSettled([repo.start(f.scope, f.request, f.execution),
      repo.start(f.scope, { ...f.request, idempotencyKey: "different" }, f.execution)]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
    const winner = attempts[0]!.status === "fulfilled" ? f.request : { ...f.request, idempotencyKey: "different" };
    await expect(repo.start(f.scope, { ...winner, fromTurn: 2 }, f.execution)).rejects.toMatchObject({ code: "cast_idempotency_conflict" });
  });
  it("rejects disabled, foreign and stale Starts without persisting scans", async () => {
    const f = await fixture();
    await expect(createCastBackfillRepository(pool).start(f.scope, f.request, f.execution)).rejects.toMatchObject({ code: "cast_discovery_disabled" });
    const repo = createCastBackfillRepository(pool, () => true);
    await expect(repo.start({ ...f.scope, ownerUserId: randomUUID() }, f.request, f.execution)).rejects.toMatchObject({ code: "cast_not_found" });
    await expect(repo.start(f.scope, { ...f.request, expectedBoundary: { turnNumber: 3, timelineRevision: 1 } }, f.execution)).rejects.toThrow("cast_stale_boundary");
    expect((await pool.query("SELECT count(*)::int n FROM campaign_cast_scans WHERE campaign_id=$1", [f.scope.campaignId])).rows[0].n).toBe(0);
  });
  it("retains partial completion through pause, resume and cancellation, including when disabled", async () => {
    const f = await fixture();
    await withTransaction(pool, client => enqueueCastDiscoveryWithClient(client, { scope: f.scope, turnId: f.turnIds[0]!, execution: f.execution, enabled: true }));
    const jobs = createCastDiscoveryJobRepository(pool, () => true), claim = (await jobs.claim("scan-existing"))!;
    await jobs.checkpoint(claim, { version: 1, characters: [] });
    await jobs.publish(claim);
    const repo = createCastBackfillRepository(pool, () => true), started = await repo.start(f.scope, f.request, f.execution);
    expect(started.completeTurns).toBe(1);
    expect(await repo.control(f.scope, started.id, "pause")).toMatchObject({ status: "paused", completeTurns: 1 });
    expect(await repo.control(f.scope, started.id, "resume")).toMatchObject({ status: "queued", completeTurns: 1 });
    const disabled = createCastBackfillRepository(pool);
    await expect(disabled.control(f.scope, started.id, "resume")).rejects.toMatchObject({ code: "cast_discovery_disabled" });
    expect(await disabled.control(f.scope, started.id, "cancel")).toMatchObject({ status: "cancelled", completeTurns: 1 });
    expect(await disabled.get(f.scope, started.id)).toMatchObject({ status: "cancelled", completeTurns: 1 });
    await expect(repo.control(f.scope, started.id, "resume")).rejects.toMatchObject({ code: "cast_revision_conflict" });
    await expect(repo.get({ ...f.scope, ownerUserId: randomUUID() }, started.id)).rejects.toMatchObject({ code: "cast_not_found" });
    expect((await repo.start(f.scope, { ...f.request, idempotencyKey: "new-after-cancel" }, f.execution)).id).not.toBe(started.id);
  });
  it("reports unresolved identity decisions separately when reusing a completed turn", async () => {
    const f = await fixture();
    await withTransaction(pool, client => enqueueCastDiscoveryWithClient(client, { scope: f.scope, turnId: f.turnIds[0]!, execution: f.execution, enabled: true }));
    const jobs = createCastDiscoveryJobRepository(pool, () => true), claim = (await jobs.claim("scan-decisions"))!;
    await jobs.checkpoint(claim, { version: 1, characters: [] });
    await jobs.publish(claim);
    await pool.query(`INSERT INTO campaign_cast_discovery_candidates(owner_user_id,campaign_id,job_id,chunk_ordinal,local_key,source,proposal,reason)
      VALUES($1,$2,$3,0,'ambiguous',$4,'{}','ambiguous_identity')`, [f.scope.ownerUserId, f.scope.campaignId, claim.id, JSON.stringify(claim.source)]);
    const repo = createCastBackfillRepository(pool, () => true);
    const scan = await repo.start(f.scope, { ...f.request, throughTurn: 1 }, f.execution);
    expect(scan).toMatchObject({ status: "complete", completeTurns: 1, failedTurns: 0, pendingReviewCount: 1 });
    await pool.query("UPDATE campaign_cast_discovery_candidates SET status='resolved' WHERE job_id=$1", [claim.id]);
    expect(await repo.get(f.scope, scan.id)).toMatchObject({ pendingReviewCount: 0 });
  });
});
