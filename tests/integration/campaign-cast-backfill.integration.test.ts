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
});
