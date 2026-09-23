import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createCastDiscoveryJobRepository, enqueueCastDiscoveryWithClient } from "../../packages/database/src/campaign-cast-job-repository.js";
import { applyCastBatchWithClient, createPostgresCampaignCastRepository } from "../../packages/database/src/campaign-cast-repository.js";
import { deriveTextExecutionPlan, textExecutionRouteBasisHash } from "../../packages/contracts/src/text-execution-plan.js";
import { CAST_DISCOVERY_SYSTEM_PROMPT } from "../../packages/contracts/src/prompt-library.js";

describe("durable cast discovery", () => {
  let pool: DatabasePool, ownerUserId: string;
  const campaignIds: string[] = [];
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  }, 60000);
  afterAll(async () => { await pool?.end(); });
  afterEach(async () => { await pool.query("DELETE FROM campaigns WHERE id=ANY($1::uuid[])", [campaignIds.splice(0)]); });
  async function fixture(count = 1) {
    const worldId = randomUUID(), versionId = randomUUID(), campaignId = randomUUID(), providerProfileId = randomUUID();
    campaignIds.push(campaignId);
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Discovery fixture')", [worldId, ownerUserId]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,'{}')", [versionId, worldId, ownerUserId]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title,active_turn_number) VALUES($1,$2,$3,'Discovery fixture',$4)", [campaignId, ownerUserId, versionId, count]);
    const turnIds: string[] = [];
    for (let n = 1; n <= count; n++) {
      const id = randomUUID(); turnIds.push(id);
      await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,$4,'Mara has blue eyes.')", [id, ownerUserId, campaignId, n]);
    }
    const scope = { ownerUserId, campaignId };
    await createPostgresCampaignCastRepository(pool).initialize(scope);
    const basis = { version: 2 as const, selection: { kind: "model" as const, modelId: "fixture" }, preset: null,
      candidates: [{ modelId: "fixture", providerPolicy: {}, contextWindowTokens: 8000, maxOutputTokens: 2000 }],
      presetSystemPrompt: "", parameters: {}, endpointReference: "fixture-endpoint", credentialReference: providerProfileId,
      profileRevision: "fixture", authorityRevision: "fixture", requestTimeoutMs: 30000, protocolVersion: "cast-discovery-v1", routeBasisHash: "0".repeat(64) };
    const execution = { providerProfileId, plan: deriveTextExecutionPlan({ ...basis, routeBasisHash: textExecutionRouteBasisHash(basis) }, CAST_DISCOVERY_SYSTEM_PROMPT) };
    const enqueue = (n = 0, enabled = true) => withTransaction(pool, (client) => enqueueCastDiscoveryWithClient(client, { scope, turnId: turnIds[n]!, execution, enabled }));
    return { scope, turnIds, enqueue, execution };
  }
  const emptyOutput = { version: 1 as const, characters: [] };
  const applied = async () => ({ characterIds: [], observationIds: [] });

  it("enqueues once in the caller transaction, freezes execution, and does nothing while disabled", async () => {
    const f = await fixture();
    expect(await f.enqueue(0, false)).toBeNull();
    const first = await f.enqueue();
    expect(await f.enqueue()).toBe(first);
    const row = (await pool.query("SELECT execution_snapshot FROM campaign_cast_discovery_jobs WHERE id=$1", [first])).rows[0];
    expect(row.execution_snapshot).toEqual(f.execution);
    await expect(withTransaction(pool, async (client) => {
      await enqueueCastDiscoveryWithClient(client, { scope: { ...f.scope, ownerUserId: randomUUID() }, turnId: f.turnIds[0]!, execution: f.execution, enabled: true });
    })).rejects.toThrow(/not found/i);
  });

  it("recovers a checkpoint with a new lease and publishes it exactly once", async () => {
    const f = await fixture(); await f.enqueue();
    const repo = createCastDiscoveryJobRepository(pool, () => true);
    const first = (await repo.claim("worker-a"))!;
    expect(first.scope).toEqual(f.scope);
    expect(await repo.checkpoint(first, emptyOutput)).toBe(true);
    await pool.query("UPDATE campaign_cast_discovery_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id]);
    const restarted = createCastDiscoveryJobRepository(pool, () => true);
    const second = (await restarted.claim("worker-b"))!;
    expect(second.output).toEqual(emptyOutput);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(await repo.checkpoint(first, emptyOutput)).toBe(false);
    expect(await repo.fail(first, "provider_timeout")).toBe(false);
    expect(await repo.publish(first, applied)).toBe("lost_lease");
    expect(await restarted.publish(second, applied)).toBe("complete");
    expect(await restarted.publish(second, applied)).toBe("lost_lease");
    expect((await pool.query("SELECT count(*)::int n FROM campaign_cast_discovery_receipts WHERE job_id=$1", [second.id])).rows[0].n).toBe(1);
    expect(await restarted.claim("worker-c")).toBeNull();
  });
  it("rolls back enqueue with the accepted-turn transaction", async () => {
    const f = await fixture();
    await expect(withTransaction(pool, async (client) => {
      await enqueueCastDiscoveryWithClient(client, { scope: f.scope, turnId: f.turnIds[0]!, execution: f.execution, enabled: true });
      throw new Error("acceptance rolled back");
    })).rejects.toThrow("acceptance rolled back");
    expect((await pool.query("SELECT count(*)::int n FROM campaign_cast_discovery_jobs WHERE campaign_id=$1", [f.scope.campaignId])).rows[0].n).toBe(0);
  });
  it("rejects a persisted chunk that no longer binds the job's accepted source", async () => {
    const f = await fixture(2), id = await f.enqueue();
    const row = (await pool.query("SELECT chunks FROM campaign_cast_discovery_jobs WHERE id=$1", [id])).rows[0];
    row.chunks[0].turnId = f.turnIds[1]; row.chunks[0].turnNumber = 2;
    await pool.query("UPDATE campaign_cast_discovery_jobs SET chunks=$2 WHERE id=$1", [id, JSON.stringify(row.chunks)]);
    await expect(createCastDiscoveryJobRepository(pool, () => true).claim("a")).rejects.toThrow(/source binding/i);
    expect((await pool.query("SELECT status FROM campaign_cast_discovery_jobs WHERE id=$1", [id])).rows[0].status).toBe("queued");
  });
  it("exhausts abandoned extraction leases without issuing a third attempt", async () => {
    const f = await fixture(2); await f.enqueue(0); await f.enqueue(1);
    const repo = createCastDiscoveryJobRepository(pool, () => true);
    for (const attempt of [1, 2]) {
      const job = (await repo.claim("worker"))!;
      expect(job.attempt).toBe(attempt);
      await pool.query("UPDATE campaign_cast_discovery_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    }
    expect(await repo.claim("worker")).toBeNull();
    const jobs = (await pool.query("SELECT status,attempt FROM campaign_cast_discovery_jobs WHERE campaign_id=$1 ORDER BY turn_number", [f.scope.campaignId])).rows;
    expect(jobs).toEqual([{ status: "failed", attempt: 2 }, { status: "queued", attempt: 0 }]);
  });

  it("serializes a campaign in source order and retains failed gaps", async () => {
    const f = await fixture(2); await f.enqueue(1); await f.enqueue(0);
    const repo = createCastDiscoveryJobRepository(pool, () => true);
    const claims = await Promise.all([repo.claim("a"), repo.claim("b")]);
    const first = claims.find(Boolean)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(first.source.turnNumber).toBe(1);
    expect(await repo.fail(first, "provider_timeout")).toBe(true);
    expect(await repo.claim("a")).toBeNull();
    await pool.query("UPDATE campaign_cast_discovery_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id]);
    const retry = (await repo.claim("a"))!;
    expect(retry.attempt).toBe(2);
    await repo.fail(retry, "provider_timeout");
    expect(await repo.claim("a")).toBeNull();
    expect((await pool.query("SELECT status,diagnostic_code FROM campaign_cast_discovery_jobs WHERE id=$1", [first.id])).rows[0])
      .toEqual({ status: "failed", diagnostic_code: "provider_timeout" });
  });

  it("fences changed sources and disables claims and publication without losing checkpoints", async () => {
    const f = await fixture(); await f.enqueue();
    let enabled = true;
    const repo = createCastDiscoveryJobRepository(pool, () => enabled);
    const job = (await repo.claim("a"))!; await repo.checkpoint(job, emptyOutput);
    enabled = false;
    expect(await repo.claim("b")).toBeNull();
    expect(await repo.publish(job, applied)).toBe("disabled");
    enabled = true;
    await pool.query("UPDATE campaign_cast_state SET timeline_revision=timeline_revision+1 WHERE campaign_id=$1", [f.scope.campaignId]);
    expect(await repo.publish(job, applied)).toBe("stale_source");
    expect((await pool.query("SELECT status FROM campaign_cast_discovery_jobs WHERE id=$1", [job.id])).rows[0].status).toBe("cancelled");
  });
  it("defers publication through every active generation stage and retains the parsed output", async () => {
    const f = await fixture(); await f.enqueue();
    const provider = randomUUID();
    await pool.query(`INSERT INTO provider_profiles(id,owner_user_id,provider_role,name,base_url,default_model,provider_type)
      VALUES($1,$2,'text','Cast fixture','http://localhost:1234','fixture','lmstudio')`, [provider, ownerUserId]);
    const generation = (await pool.query(`INSERT INTO generation_jobs(owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,status)
      VALUES($1,$2,$3,$4,2,'Continue','queued') RETURNING id`, [ownerUserId, f.scope.campaignId, provider, randomUUID()])).rows[0];
    const repo = createCastDiscoveryJobRepository(pool, () => true), job = (await repo.claim("a"))!;
    await repo.checkpoint(job, emptyOutput);
    for (const status of ["queued", "replacement_queued", "assessing", "generating", "validating", "committing", "recoverable"]) {
      await pool.query("UPDATE generation_jobs SET status=$2 WHERE id=$1", [generation.id, status]);
      expect(await repo.publish(job, applied), status).toBe("generation_active");
    }
    expect((await pool.query("SELECT checkpoint FROM campaign_cast_discovery_jobs WHERE id=$1", [job.id])).rows[0].checkpoint).toEqual(emptyOutput);
    await pool.query("UPDATE generation_jobs SET status='failed' WHERE id=$1", [generation.id]);
    expect(await repo.publish(job, applied)).toBe("complete");
  });
  it("rolls back publication and its receipt together, then resumes the retained checkpoint", async () => {
    const f = await fixture(); await f.enqueue();
    const repo = createCastDiscoveryJobRepository(pool, () => true), job = (await repo.claim("a"))!;
    await repo.checkpoint(job, emptyOutput);
    await expect(repo.publish(job, async (client) => {
      await client.query("UPDATE campaigns SET title='uncommitted publication' WHERE id=$1", [f.scope.campaignId]);
      throw new Error("synthetic apply failure");
    })).rejects.toThrow("synthetic apply failure");
    expect((await pool.query("SELECT title FROM campaigns WHERE id=$1", [f.scope.campaignId])).rows[0].title).toBe("Discovery fixture");
    expect((await pool.query("SELECT count(*)::int n FROM campaign_cast_discovery_receipts WHERE job_id=$1", [job.id])).rows[0].n).toBe(0);
    expect(await repo.publish(job, applied)).toBe("complete");
  });
  it("retains all source chunks and finishes only after the last atomic publication", async () => {
    const f = await fixture();
    const narration = "Mara waits by the bridge. ".repeat(900);
    await pool.query("UPDATE turns SET narration=$2 WHERE id=$1", [f.turnIds[0], narration]);
    await f.enqueue();
    const repo = createCastDiscoveryJobRepository(pool, () => true);
    let text = "", count = 0;
    for (let job = await repo.claim("a"); job; job = await repo.claim("a")) {
      text += job.source.paragraphs.map((p) => p.text).join(""); count++;
      await repo.checkpoint(job, emptyOutput);
      expect(await repo.publish(job, applied)).toBe(count === job.chunkCount ? "complete" : "next_chunk");
    }
    expect(count).toBeGreaterThan(1); expect(text).toBe(narration);
  });
  it("commits cast authority with the job receipt and rolls both back on failure", async () => {
    const f = await fixture(); await f.enqueue();
    const repo = createCastDiscoveryJobRepository(pool, () => true), job = (await repo.claim("a"))!;
    await repo.checkpoint(job, emptyOutput);
    const batch = { boundary: { turnNumber: 1, timelineRevision: 0 }, idempotencyKey: `discovery:${job.id}:0`,
      commands: [{ kind: "create" as const, name: "Mara", aliases: [], origin: { kind: "discovered" as const }, evidence: {
        kind: "turn" as const, turnId: job.source.turnId, turnNumber: 1, narrationRevision: 0, sourceHash: job.source.sourceHash,
        paragraphId: "p1", quote: "Mara has blue eyes." } }] };
    await expect(repo.publish(job, async (client) => {
      await applyCastBatchWithClient(client, f.scope, batch);
      throw new Error("abort after authority");
    })).rejects.toThrow("abort after authority");
    expect((await createPostgresCampaignCastRepository(pool).initialize(f.scope)).characters).toHaveLength(1);
    expect(await repo.publish(job, (client) => applyCastBatchWithClient(client, f.scope, batch))).toBe("complete");
    const cast = await createPostgresCampaignCastRepository(pool).initialize(f.scope);
    const person = cast.characters.find((p) => p.name === "Mara")!;
    const receipt = (await pool.query("SELECT character_ids FROM campaign_cast_discovery_receipts WHERE job_id=$1", [job.id])).rows[0];
    expect(receipt.character_ids).toEqual([person.id]);
    expect(cast.characters).toHaveLength(2);
  });
});
