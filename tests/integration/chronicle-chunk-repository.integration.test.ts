import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createPostgresChronicleChunkBatchPort,
  createPostgresChronicleChunkJobStatePort,
  createPostgresChronicleChunkParentPort,
  enqueuePostgresChronicleChunkIndex
} from "../../packages/database/src/chronicle-chunk-repository.js";
import { createPostgresChronicleConfigurationRepository } from "../../packages/database/src/chronicle-repository.js";
import { createPostgresProviderRepositories } from "../../packages/database/src/provider-repository.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

integration("PostgreSQL Chronicle chunk repository", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM campaigns");
    await pool.query("DELETE FROM provider_profiles");
    await pool.query("DELETE FROM world_versions");
    await pool.query("DELETE FROM worlds");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function fixture(label: string) {
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `Chunk ${label} ${crypto.randomUUID()}`]
    );
    const version = await pool.query<{ id: string }>(
      "INSERT INTO world_versions (world_id, owner_user_id, version_number, content) VALUES ($1,$2,1,'{}') RETURNING id",
      [world.rows[0]!.id, ownerUserId]
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, version.rows[0]!.id, `Chunk ${label}`]
    );
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles
         (owner_user_id, name, provider_type, provider_role, base_url, default_model)
       VALUES ($1,$2,'openai_compatible','embedding','http://provider.invalid/v1','embed-v1') RETURNING id`,
      [ownerUserId, `Chunk provider ${label}`]
    );
    await pool.query(
      `INSERT INTO campaign_memory_configs
         (campaign_id, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model)
       VALUES ($1,$2,true,$3,'embed-v1')`,
      [campaign.rows[0]!.id, ownerUserId, provider.rows[0]!.id]
    );
    const parents = await pool.query<{ id: string; content_hash: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate, entities, entity_ids)
       VALUES ($1,$2,$3,'campaign_summary',1,'First safe parent.',4,ARRAY['Gate'],ARRAY['gate']),
              ($1,$2,$3,'open_thread',2,'Who opened the gate?',5,ARRAY['Gate'],ARRAY['gate'])
       RETURNING id, content_hash`,
      [ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id]
    );
    return {
      ownerUserId,
      campaignId: campaign.rows[0]!.id,
      worldVersionId: version.rows[0]!.id,
      providerId: provider.rows[0]!.id,
      parents: parents.rows
    };
  }

  it("idempotently enqueues one active job and claims with campaign-scoped SKIP LOCKED fencing", async () => {
    const locked = await fixture("locked");
    const available = await fixture("available");
    const lockedJob = await enqueuePostgresChronicleChunkIndex(pool, locked);
    const duplicate = await enqueuePostgresChronicleChunkIndex(pool, locked);
    const availableJob = await enqueuePostgresChronicleChunkIndex(pool, available);
    expect(duplicate).toBe(lockedJob);
    expect(await pool.query<{ work_version: string; progress: Record<string, unknown> }>(
      "SELECT work_version::text,progress FROM chronicle_chunk_jobs WHERE id=$1", [lockedJob]
    )).toMatchObject({ rows: [{ work_version: "1", progress: {} }] });
    expect(await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_chunk_jobs WHERE campaign_id=$1 AND status IN ('queued','running')",
      [locked.campaignId]
    )).toMatchObject({ rows: [{ count: "1" }] });

    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM chronicle_chunk_jobs WHERE id=$1 FOR UPDATE", [lockedJob]);
      const state = createPostgresChronicleChunkJobStatePort(pool);
      const claim = await state.claimNext({ workerId: "chunk-claim-worker", leaseSeconds: 30 });
      expect(claim?.jobId).toBe(availableJob);
      if (!claim) throw new Error("available chunk job was not claimed");
      await expect(state.heartbeatClaim(claim)).resolves.toBe(true);
      await expect(state.heartbeatClaim({ ...claim, workerId: "wrong-worker" })).resolves.toBe(false);
      await expect(state.heartbeatClaim({ ...claim, ownerUserId: crypto.randomUUID() })).resolves.toBe(false);
      await expect(state.heartbeatClaim({ ...claim, campaignId: locked.campaignId })).resolves.toBe(false);
      await expect(state.heartbeatClaim({ ...claim, worldVersionId: locked.worldVersionId })).resolves.toBe(false);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  });

  it("preserves a durable cursor on unchanged lease reclaim and clears it for newer work", async () => {
    const value = await fixture("resume");
    await enqueuePostgresChronicleChunkIndex(pool, value);
    const state = createPostgresChronicleChunkJobStatePort(pool);
    const first = await state.claimNext({ workerId: "chunk-resume-a", leaseSeconds: 30 });
    if (!first) throw new Error("chunk job was not claimed");
    const firstPage = await createPostgresChronicleChunkParentPort(pool).loadForClaim(
      first,
      { batchLimit: 1, cursor: null }
    );
    await pool.query(
      `UPDATE chronicle_chunk_jobs
          SET progress=$2::jsonb, lease_expires_at=now()-interval '1 second'
        WHERE id=$1`,
      [first.jobId, JSON.stringify({
        parentCursor: `1:${value.parents[0]!.id}`,
        processedParents: 1,
        embeddedChunks: 1,
        skippedChunks: 0,
        totalParents: 2,
        capabilityFingerprint: "fingerprint-a"
      })]
    );
    const reclaimed = await state.claimNext({ workerId: "chunk-resume-a", leaseSeconds: 30 });
    expect(reclaimed?.progress.parentCursor).toBe(`1:${value.parents[0]!.id}`);
    expect(reclaimed?.leaseToken).not.toBe(first.leaseToken);
    await expect(state.loadClaimedJob(first)).resolves.toBeNull();
    await expect(state.heartbeatClaim(first)).resolves.toBe(false);
    await expect(state.completeClaim(first, { progress: first.progress })).resolves.toBe(false);
    await expect(state.failClaim(first, { diagnosticCode: "stale_executor" })).resolves.toBe(false);
    const staleBatches = createPostgresChronicleChunkBatchPort(pool, {
      recordCost: async () => null
    });
    await expect(staleBatches.prepareClaim(first, {
      capabilityFingerprint: "fingerprint-a"
    })).resolves.toBe("requeued");
    const staleParent = firstPage.parents[0]!;
    await expect(staleBatches.commitParentBatch(first, {
      parent: staleParent,
      previousParentCursor: null,
      provider: null,
      providerFingerprint: null,
      capabilityFingerprint: "fingerprint-a",
      embeddingProtocolVersion: "chronicle-embedding-v1",
      chunks: [{
        protocolVersion: "chronicle-chunk-v1",
        parentMemoryId: staleParent.id,
        kind: "campaign_summary",
        chunkIndex: 0,
        content: staleParent.content,
        contentHash: staleParent.contentHash,
        estimatedTokens: 4,
        sourceStartOffset: 0,
        sourceEndOffset: staleParent.content.length,
        embedding: null,
        skipReason: "semantic_disabled"
      }],
      embeddingEvidence: [],
      costResults: [],
      progress: {
        parentCursor: `1:${staleParent.id}`,
        processedParents: 1,
        embeddedChunks: 0,
        skippedChunks: 1,
        totalParents: 2,
        capabilityFingerprint: "fingerprint-a"
      }
    })).resolves.toBe(false);

    await enqueuePostgresChronicleChunkIndex(pool, value);
    expect(await pool.query<{ progress: Record<string, unknown>; work_version: string }>(
      "SELECT progress,work_version::text FROM chronicle_chunk_jobs WHERE id=$1", [first.jobId]
    )).toMatchObject({
      rows: [{
        work_version: "1",
        progress: expect.objectContaining({ parentCursor: `1:${value.parents[0]!.id}` })
      }]
    });

    await pool.query(
      "UPDATE chronicle_memories SET content='First safe parent changed.' WHERE id=$1",
      [value.parents[0]!.id]
    );
    await enqueuePostgresChronicleChunkIndex(pool, value);
    expect(await pool.query<{ progress: Record<string, unknown>; work_version: string }>(
      "SELECT progress, work_version::text FROM chronicle_chunk_jobs WHERE id=$1",
      [first.jobId]
    )).toMatchObject({ rows: [{ progress: {}, work_version: "2" }] });
    if (!reclaimed) throw new Error("chunk job was not reclaimed");
    await expect(state.completeClaim(reclaimed, { progress: reclaimed.progress })).resolves.toBe(true);
    expect(await pool.query<{ status: string; progress: Record<string, unknown> }>(
      "SELECT status, progress FROM chronicle_chunk_jobs WHERE id=$1", [first.jobId]
    )).toMatchObject({ rows: [{ status: "queued", progress: {} }] });
  });

  it("pages parents by ordinal and id and atomically upserts chunks, vectors, cost, progress, and lease", async () => {
    const value = await fixture("commit");
    await enqueuePostgresChronicleChunkIndex(pool, value);
    const state = createPostgresChronicleChunkJobStatePort(pool);
    const claim = await state.claimNext({ workerId: "chunk-commit", leaseSeconds: 30 });
    if (!claim) throw new Error("chunk job was not claimed");
    const parents = createPostgresChronicleChunkParentPort(pool);
    const page = await parents.loadForClaim(claim, { batchLimit: 1, cursor: null });
    expect(page.parents.map((parent) => parent.id)).toEqual([value.parents[0]!.id]);
    expect(page.nextCursor).toBe(`1:${value.parents[0]!.id}`);

    const recordCost = async (database: object) => {
      await (database as DatabasePool).query(
        `INSERT INTO provider_cost_events
           (owner_user_id,campaign_id,provider_profile_id,provider_type,operation,category,amount,currency)
         VALUES ($1,$2,$3,'openai_compatible','memory_embedding','memory',0.01,'USD')`,
        [value.ownerUserId, value.campaignId, value.providerId]
      );
      return null;
    };
    const batches = createPostgresChronicleChunkBatchPort(pool, { recordCost });
    await expect(batches.prepareClaim(claim, { capabilityFingerprint: "capability-a" })).resolves.toBe("ready");
    const parent = page.parents[0]!;
    const progress = {
      parentCursor: `1:${parent.id}`,
      processedParents: 1,
      embeddedChunks: 1,
      skippedChunks: 0,
      totalParents: 2,
      capabilityFingerprint: "capability-a"
    };
    const input = {
      parent,
      previousParentCursor: null,
      provider: {
        id: value.providerId,
        model: "embed-v1",
        providerType: "openai_compatible",
        contextWindowTokens: 1_024,
        requestTimeoutMs: 10_000,
        configuration: {}
      },
      providerFingerprint: "provider-a",
      capabilityFingerprint: "capability-a",
      embeddingProtocolVersion: "chronicle-embedding-v1",
      chunks: [{
        protocolVersion: "chronicle-chunk-v1" as const,
        parentMemoryId: parent.id,
        kind: "campaign_summary" as const,
        chunkIndex: 0,
        content: "First safe parent.",
        contentHash: parent.contentHash,
        estimatedTokens: 4,
        sourceStartOffset: 0,
        sourceEndOffset: 18,
        embedding: [0.1, 0.2],
        skipReason: null
      }],
      embeddingEvidence: [[0.1, 0.2]],
      costResults: [{ embeddings: [[0.1, 0.2]], responseId: "response-a", usage: {}, reportedCost: null }],
      progress
    };
    await expect(batches.commitParentBatch(claim, input)).resolves.toBe(true);
    await expect(batches.commitParentBatch(claim, input)).rejects.toMatchObject({ statusCode: 400 });
    expect(await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_memory_chunks WHERE parent_memory_id=$1",
      [parent.id]
    )).toMatchObject({ rows: [{ count: "1" }] });
    expect(await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM provider_cost_events WHERE campaign_id=$1 AND operation='memory_embedding'",
      [value.campaignId]
    )).toMatchObject({ rows: [{ count: "1" }] });

    const stableChunk = await pool.query<{ id: string }>(
      "SELECT id FROM chronicle_memory_chunks WHERE parent_memory_id=$1", [parent.id]
    );
    await enqueuePostgresChronicleChunkIndex(pool, value, { forceNewWork: true });
    await expect(state.completeClaim(claim, { progress })).resolves.toBe(true);
    const replay = await state.claimNext({ workerId: "chunk-replay", leaseSeconds: 30 });
    if (!replay) throw new Error("replayed chunk job was not claimed");
    await batches.prepareClaim(replay, { capabilityFingerprint: "capability-a" });
    await expect(batches.commitParentBatch(replay, input)).resolves.toBe(true);
    expect(await pool.query<{ id: string }>(
      "SELECT id FROM chronicle_memory_chunks WHERE parent_memory_id=$1", [parent.id]
    )).toEqual(stableChunk);

    await expect(state.completeClaim(replay, { progress })).resolves.toBe(true);
    await enqueuePostgresChronicleChunkIndex(pool, value, { forceNewWork: true });
    const worldRace = await state.claimNext({ workerId: "chunk-world-race", leaseSeconds: 30 });
    if (!worldRace) throw new Error("world-race chunk job was not claimed");
    await batches.prepareClaim(worldRace, { capabilityFingerprint: "capability-a" });
    const world = await pool.query<{ world_id: string }>(
      "SELECT world_id FROM world_versions WHERE id=$1", [value.worldVersionId]
    );
    const movedVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,2,'{}') RETURNING id`,
      [world.rows[0]!.world_id, value.ownerUserId]
    );
    await pool.query(
      "UPDATE campaigns SET world_version_id=$2 WHERE id=$1 AND owner_user_id=$3",
      [value.campaignId, movedVersion.rows[0]!.id, value.ownerUserId]
    );
    await expect(batches.commitParentBatch(worldRace, input)).resolves.toBe(false);
    await expect(batches.prepareClaim(worldRace, {
      capabilityFingerprint: "capability-a"
    })).resolves.toBe("requeued");
  });

  it("separates per-parent embedding evidence from page-wide cost results", async () => {
    const value = await fixture("split evidence cost");
    await enqueuePostgresChronicleChunkIndex(pool, value);
    const state = createPostgresChronicleChunkJobStatePort(pool);
    const claim = await state.claimNext({ workerId: "chunk-split-cost", leaseSeconds: 30 });
    if (!claim) throw new Error("chunk job was not claimed");
    const page = await createPostgresChronicleChunkParentPort(pool).loadForClaim(
      claim,
      { batchLimit: 2, cursor: null }
    );
    const recordCost = vi.fn().mockResolvedValue(null);
    const batches = createPostgresChronicleChunkBatchPort(pool, { recordCost });
    await batches.prepareClaim(claim, { capabilityFingerprint: "capability-page" });
    const provider = { id: value.providerId, model: "embed-v1", providerType: "openai_compatible" };
    const first = page.parents[0]!;
    const second = page.parents[1]!;
    const firstCursor = `1:${first.id}`;

    await expect(batches.commitParentBatch(claim, {
      parent: first,
      previousParentCursor: null,
      provider,
      providerFingerprint: "provider-page",
      capabilityFingerprint: "capability-page",
      embeddingProtocolVersion: "chronicle-embedding-v1",
      chunks: [{
        protocolVersion: "chronicle-chunk-v1",
        parentMemoryId: first.id,
        kind: "campaign_summary",
        chunkIndex: 0,
        content: first.content,
        contentHash: first.contentHash,
        estimatedTokens: 4,
        sourceStartOffset: 0,
        sourceEndOffset: first.content.length,
        embedding: [0.1, 0.2],
        skipReason: null
      }],
      embeddingEvidence: [[0.1, 0.2]],
      costResults: [{
        embeddings: [[0.1, 0.2], [0.3, 0.4]],
        responseId: "page-response",
        usage: { inputTokens: 9 },
        reportedCost: { amount: "0.01", currency: "USD" }
      }],
      progress: {
        parentCursor: firstCursor,
        processedParents: 1,
        embeddedChunks: 1,
        skippedChunks: 0,
        totalParents: 2,
        capabilityFingerprint: "capability-page"
      }
    })).resolves.toBe(true);

    await expect(batches.commitParentBatch(claim, {
      parent: second,
      previousParentCursor: firstCursor,
      provider,
      providerFingerprint: "provider-page",
      capabilityFingerprint: "capability-page",
      embeddingProtocolVersion: "chronicle-embedding-v1",
      chunks: [{
        protocolVersion: "chronicle-chunk-v1" as const,
        parentMemoryId: second.id,
        kind: "open_thread" as const,
        chunkIndex: 0,
        content: second.content,
        contentHash: second.contentHash,
        estimatedTokens: 5,
        sourceStartOffset: 0,
        sourceEndOffset: second.content.length,
        embedding: [0.3, 0.4],
        skipReason: null
      }],
      embeddingEvidence: [[0.3, 0.4]],
      costResults: [],
      progress: {
        parentCursor: `2:${second.id}`,
        processedParents: 2,
        embeddedChunks: 2,
        skippedChunks: 0,
        totalParents: 2,
        capabilityFingerprint: "capability-page"
      }
    })).resolves.toBe(true);

    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_memory_chunks WHERE campaign_id=$1",
      [value.campaignId]
    )).toMatchObject({ rows: [{ count: "2" }] });
  });

  it("keeps the first parent cursor and page cost durable when a later parent commit fails", async () => {
    const value = await fixture("split evidence cost");
    await enqueuePostgresChronicleChunkIndex(pool, value);
    const state = createPostgresChronicleChunkJobStatePort(pool);
    const claim = await state.claimNext({ workerId: "chunk-split-cost", leaseSeconds: 30 });
    if (!claim) throw new Error("chunk job was not claimed");
    const page = await createPostgresChronicleChunkParentPort(pool).loadForClaim(
      claim,
      { batchLimit: 2, cursor: null }
    );
    const recordCost = vi.fn(async (database: object) => {
      await (database as DatabasePool).query(
        `INSERT INTO provider_cost_events
           (owner_user_id,campaign_id,provider_profile_id,provider_type,operation,category,amount,currency)
         VALUES ($1,$2,$3,'openai_compatible','memory_embedding','memory',0.01,'USD')`,
        [value.ownerUserId, value.campaignId, value.providerId]
      );
      return null;
    });
    const batches = createPostgresChronicleChunkBatchPort(pool, { recordCost });
    await batches.prepareClaim(claim, { capabilityFingerprint: "capability-page" });
    const provider = { id: value.providerId, model: "embed-v1", providerType: "openai_compatible" };
    const first = page.parents[0]!;
    const second = page.parents[1]!;
    const firstCursor = `1:${first.id}`;

    await expect(batches.commitParentBatch(claim, {
      parent: first,
      previousParentCursor: null,
      provider,
      providerFingerprint: "provider-page",
      capabilityFingerprint: "capability-page",
      embeddingProtocolVersion: "chronicle-embedding-v1",
      chunks: [{
        protocolVersion: "chronicle-chunk-v1",
        parentMemoryId: first.id,
        kind: "campaign_summary",
        chunkIndex: 0,
        content: first.content,
        contentHash: first.contentHash,
        estimatedTokens: 4,
        sourceStartOffset: 0,
        sourceEndOffset: first.content.length,
        embedding: [0.1, 0.2],
        skipReason: null
      }],
      embeddingEvidence: [[0.1, 0.2]],
      costResults: [{
        embeddings: [[0.1, 0.2], [0.3, 0.4]],
        responseId: "page-response",
        usage: { inputTokens: 9 },
        reportedCost: { amount: "0.01", currency: "USD" }
      }],
      progress: {
        parentCursor: firstCursor,
        processedParents: 1,
        embeddedChunks: 1,
        skippedChunks: 0,
        totalParents: 2,
        capabilityFingerprint: "capability-page"
      }
    })).resolves.toBe(true);

    const staleSecondInput = {
      parent: second,
      previousParentCursor: firstCursor,
      provider,
      providerFingerprint: "provider-page",
      capabilityFingerprint: "capability-page",
      embeddingProtocolVersion: "chronicle-embedding-v1",
      chunks: [{
        protocolVersion: "chronicle-chunk-v1" as const,
        parentMemoryId: second.id,
        kind: "open_thread" as const,
        chunkIndex: 0,
        content: second.content,
        contentHash: second.contentHash,
        estimatedTokens: 5,
        sourceStartOffset: 0,
        sourceEndOffset: second.content.length,
        embedding: [0.3, 0.4],
        skipReason: null
      }],
      embeddingEvidence: [[0.3, 0.4]],
      costResults: [],
      progress: {
        parentCursor: `2:${second.id}`,
        processedParents: 2,
        embeddedChunks: 2,
        skippedChunks: 0,
        totalParents: 2,
        capabilityFingerprint: "capability-page"
      }
    };
    await pool.query(
      "UPDATE chronicle_memories SET content='Who closed the gate?' WHERE id=$1",
      [second.id]
    );
    await expect(batches.commitParentBatch(claim, staleSecondInput))
      .rejects.toMatchObject({ statusCode: 400 });

    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(await pool.query<{ progress: Record<string, unknown> }>(
      "SELECT progress FROM chronicle_chunk_jobs WHERE id=$1",
      [claim.jobId]
    )).toMatchObject({
      rows: [{ progress: expect.objectContaining({ parentCursor: firstCursor, processedParents: 1 }) }]
    });
    expect(await pool.query<{ parent_memory_id: string }>(
      "SELECT parent_memory_id FROM chronicle_memory_chunks WHERE campaign_id=$1 ORDER BY parent_memory_id",
      [value.campaignId]
    )).toMatchObject({ rows: [{ parent_memory_id: first.id }] });
    expect(await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM provider_cost_events WHERE campaign_id=$1 AND operation='memory_embedding'",
      [value.campaignId]
    )).toMatchObject({ rows: [{ count: "1" }] });

    const retryPage = await createPostgresChronicleChunkParentPort(pool).loadForClaim(
      claim,
      { batchLimit: 2, cursor: firstCursor }
    );
    expect(retryPage.parents.map((parent) => ({ id: parent.id, content: parent.content }))).toEqual([{
      id: second.id,
      content: "Who closed the gate?"
    }]);
    const retrySecond = retryPage.parents[0]!;
    await expect(batches.commitParentBatch(claim, {
      ...staleSecondInput,
      parent: retrySecond,
      chunks: [{
        ...staleSecondInput.chunks[0]!,
        content: retrySecond.content,
        contentHash: retrySecond.contentHash,
        sourceEndOffset: retrySecond.content.length,
        embedding: [0.7, 0.8]
      }],
      embeddingEvidence: [[0.7, 0.8]],
      costResults: [{
        embeddings: [[0.7, 0.8]],
        responseId: "retry-response",
        usage: { inputTokens: 5 },
        reportedCost: { amount: "0.01", currency: "USD" }
      }]
    })).resolves.toBe(true);

    expect(recordCost).toHaveBeenCalledTimes(2);
    expect(await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM provider_cost_events WHERE campaign_id=$1 AND operation='memory_embedding'",
      [value.campaignId]
    )).toMatchObject({ rows: [{ count: "2" }] });
    expect(await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_memory_chunks WHERE campaign_id=$1",
      [value.campaignId]
    )).toMatchObject({ rows: [{ count: "2" }] });
  });

  it("rolls back an incomplete batch and cascades chunk work with its campaign", async () => {
    const value = await fixture("rollback cascade");
    await enqueuePostgresChronicleChunkIndex(pool, value);
    const state = createPostgresChronicleChunkJobStatePort(pool);
    const claim = await state.claimNext({ workerId: "chunk-rollback", leaseSeconds: 30 });
    if (!claim) throw new Error("chunk job was not claimed");
    const page = await createPostgresChronicleChunkParentPort(pool).loadForClaim(claim, { batchLimit: 1 });
    const batches = createPostgresChronicleChunkBatchPort(pool, { recordCost: async () => null });
    await batches.prepareClaim(claim, { capabilityFingerprint: "capability-b" });
    const parent = page.parents[0]!;
    await expect(batches.commitParentBatch(claim, {
      parent,
      previousParentCursor: null,
      provider: { id: value.providerId, model: "embed-v1", providerType: "openai_compatible" },
      providerFingerprint: "provider-b",
      capabilityFingerprint: "capability-b",
      embeddingProtocolVersion: "chronicle-embedding-v1",
      chunks: [{
        protocolVersion: "chronicle-chunk-v1", parentMemoryId: parent.id, kind: "campaign_summary",
        chunkIndex: 0, content: "First safe parent.", contentHash: parent.contentHash,
        estimatedTokens: 4, sourceStartOffset: 0, sourceEndOffset: 18,
        embedding: [0.1, 0.2], skipReason: null
      }],
      embeddingEvidence: [],
      costResults: [{ embeddings: [], responseId: "incomplete", usage: {}, reportedCost: null }],
      progress: {
        parentCursor: `1:${parent.id}`, processedParents: 1, embeddedChunks: 1,
        skippedChunks: 0, totalParents: 2, capabilityFingerprint: "capability-b"
      }
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_memory_chunks WHERE parent_memory_id=$1", [parent.id]
    )).toMatchObject({ rows: [{ count: "0" }] });
    expect(await pool.query<{ progress: Record<string, unknown> }>(
      "SELECT progress FROM chronicle_chunk_jobs WHERE id=$1", [claim.jobId]
    )).toMatchObject({ rows: [{ progress: { parentCursor: null, processedParents: 0 } }] });

    const costFailure = createPostgresChronicleChunkBatchPort(pool, {
      recordCost: async () => {
        throw new Error("private provider cost failure");
      }
    });
    await expect(costFailure.commitParentBatch(claim, {
      parent,
      previousParentCursor: null,
      provider: { id: value.providerId, model: "embed-v1", providerType: "openai_compatible" },
      providerFingerprint: "provider-b",
      capabilityFingerprint: "capability-b",
      embeddingProtocolVersion: "chronicle-embedding-v1",
      chunks: [{
        protocolVersion: "chronicle-chunk-v1", parentMemoryId: parent.id, kind: "campaign_summary",
        chunkIndex: 0, content: "First safe parent.", contentHash: parent.contentHash,
        estimatedTokens: 4, sourceStartOffset: 0, sourceEndOffset: 18,
        embedding: [0.1, 0.2], skipReason: null
      }],
      embeddingEvidence: [[0.1, 0.2]],
      costResults: [{
        embeddings: [[0.1, 0.2]], responseId: "cost-failure", usage: {},
        reportedCost: { amount: "1.2e-7", currency: "USD" }
      }],
      progress: {
        parentCursor: `1:${parent.id}`, processedParents: 1, embeddedChunks: 1,
        skippedChunks: 0, totalParents: 2, capabilityFingerprint: "capability-b"
      }
    })).rejects.toMatchObject({
      providerExecutionContext: {
        commitStage: "cost_recording",
        reportedCostPresent: true,
        reportedCostCount: 1,
        reportedCostNotation: "scientific",
        reportedCostCurrencyValid: true
      }
    });
    expect(await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_memory_chunks WHERE parent_memory_id=$1", [parent.id]
    )).toMatchObject({ rows: [{ count: "0" }] });
    expect(await pool.query<{ progress: Record<string, unknown> }>(
      "SELECT progress FROM chronicle_chunk_jobs WHERE id=$1", [claim.jobId]
    )).toMatchObject({ rows: [{ progress: { parentCursor: null, processedParents: 0 } }] });

    await expect(batches.commitParentBatch(claim, {
      parent,
      previousParentCursor: null,
      provider: {
        id: value.providerId, model: "embed-v1", providerType: "openai_compatible"
      },
      providerFingerprint: "provider-b",
      capabilityFingerprint: "capability-b",
      embeddingProtocolVersion: "chronicle-embedding-v1",
      chunks: [{
        protocolVersion: "chronicle-chunk-v1", parentMemoryId: parent.id, kind: "campaign_summary",
        chunkIndex: 0, content: "First safe parent.", contentHash: parent.contentHash,
        estimatedTokens: 4, sourceStartOffset: 0, sourceEndOffset: 18,
        embedding: null, skipReason: "https://provider.invalid?token=must-not-persist"
      }],
      embeddingEvidence: [],
      costResults: [],
      progress: {
        parentCursor: `1:${parent.id}`, processedParents: 1, embeddedChunks: 0,
        skippedChunks: 1, totalParents: 2, capabilityFingerprint: "capability-b"
      }
    })).resolves.toBe(true);
    expect(await pool.query<{ embedding_skip_reason: string }>(
      "SELECT embedding_skip_reason FROM chronicle_memory_chunks WHERE parent_memory_id=$1", [parent.id]
    )).toMatchObject({ rows: [{ embedding_skip_reason: "chunk_embedding_skipped" }] });

    await expect(pool.query(
      "UPDATE chronicle_memory_chunks SET embedding_skip_reason='chunk_exceeds_provider_capacity' WHERE parent_memory_id=$1",
      [parent.id]
    )).resolves.toMatchObject({ rowCount: 1 });

    await expect(pool.query(
      "UPDATE chronicle_memory_chunks SET embedding_skip_reason='provider said no' WHERE parent_memory_id=$1",
      [parent.id]
    )).rejects.toMatchObject({ constraint: "chronicle_memory_chunks_embedding_skip_reason_check" });

    await pool.query("DELETE FROM campaigns WHERE id=$1 AND owner_user_id=$2", [value.campaignId, value.ownerUserId]);
    expect(await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_chunk_jobs WHERE campaign_id=$1", [value.campaignId]
    )).toMatchObject({ rows: [{ count: "0" }] });
    expect(await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_memory_chunks WHERE campaign_id=$1", [value.campaignId]
    )).toMatchObject({ rows: [{ count: "0" }] });
  });

  it("clears only chunk vector metadata and requeues on provider, model, and fingerprint invalidation", async () => {
    const value = await fixture("invalidate");
    const jobId = await enqueuePostgresChronicleChunkIndex(pool, value);
    await pool.query(
      `INSERT INTO chronicle_memory_chunks
         (owner_user_id,campaign_id,world_version_id,parent_memory_id,parent_content_hash,
          chunking_protocol_version,chunk_ordinal,chunk_kind,content,token_estimate,
          embedding,embedding_status,embedding_provider_profile_id,embedding_model,embedding_dimensions,
          embedding_protocol_version,embedding_provider_fingerprint,embedding_content_hash,embedding_updated_at)
       VALUES ($1,$2,$3,$4,$5,'chronicle-chunk-v1',0,'campaign_summary','First safe parent.',4,
               '[0.1,0.2]'::vector,'embedded',$6,'embed-v1',2,'chronicle-embedding-v1','old',$5,now())`,
      [value.ownerUserId, value.campaignId, value.worldVersionId, value.parents[0]!.id,
        value.parents[0]!.content_hash, value.providerId]
    );
    const persistedChunk = await pool.query<{ id: string }>(
      "SELECT id FROM chronicle_memory_chunks WHERE campaign_id=$1", [value.campaignId]
    );
    const providerClient = await pool.connect();
    try {
      await providerClient.query("BEGIN");
      await createPostgresProviderRepositories(providerClient).profiles.updateProfile({
        ownerUserId: value.ownerUserId,
        providerProfileId: value.providerId,
        changes: { contextWindowTokens: 8_192 }
      });
      await providerClient.query("COMMIT");
    } catch (error) {
      await providerClient.query("ROLLBACK");
      throw error;
    } finally {
      providerClient.release();
    }
    expect(await pool.query<{ id: string; content: string; embedding_status: string; embedding: string | null }>(
      "SELECT id,content,embedding_status,embedding::text FROM chronicle_memory_chunks WHERE campaign_id=$1",
      [value.campaignId]
    )).toMatchObject({ rows: [{
      id: persistedChunk.rows[0]!.id, content: "First safe parent.", embedding_status: "pending", embedding: null
    }] });

    await pool.query(
      `UPDATE chronicle_memory_chunks
          SET embedding='[0.2,0.3]'::vector,embedding_status='embedded',
              embedding_provider_profile_id=$2,embedding_model='embed-v1',embedding_dimensions=2,
              embedding_protocol_version='chronicle-embedding-v1',embedding_provider_fingerprint='old',
              embedding_content_hash=parent_content_hash,embedding_updated_at=now()
        WHERE campaign_id=$1`,
      [value.campaignId, value.providerId]
    );
    await createPostgresChronicleConfigurationRepository(pool).setEmbeddingConfig(value, {
      enabled: true,
      providerProfileId: value.providerId,
      model: "embed-v2",
      batchSize: 16,
      documentPrefix: null,
      queryPrefix: null
    });
    expect(await pool.query<{ id: string; content: string; embedding_status: string; embedding: string | null }>(
      "SELECT id,content,embedding_status,embedding::text FROM chronicle_memory_chunks WHERE campaign_id=$1",
      [value.campaignId]
    )).toMatchObject({ rows: [{
      id: persistedChunk.rows[0]!.id, content: "First safe parent.", embedding_status: "pending", embedding: null
    }] });

    const batch = createPostgresChronicleChunkBatchPort(pool, { recordCost: async () => null });
    const state = createPostgresChronicleChunkJobStatePort(pool);
    const claim = await state.claimNext({ workerId: "chunk-invalidate", leaseSeconds: 30 });
    if (!claim) throw new Error("chunk job was not claimed");
    await pool.query(
      "UPDATE chronicle_chunk_jobs SET progress=jsonb_build_object('capabilityFingerprint','old') WHERE id=$1",
      [jobId]
    );
    await expect(batch.prepareClaim(claim, { capabilityFingerprint: "new" })).resolves.toBe("requeued");
    expect(await pool.query<{ content: string; embedding_status: string; embedding: string | null }>(
      "SELECT content,embedding_status,embedding::text FROM chronicle_memory_chunks WHERE campaign_id=$1",
      [value.campaignId]
    )).toMatchObject({ rows: [{ content: "First safe parent.", embedding_status: "pending", embedding: null }] });
  });

  it("returns only parents whose current content is not already terminally chunked", async () => {
    const value = await fixture("incremental");
    await enqueuePostgresChronicleChunkIndex(pool, value);
    const state = createPostgresChronicleChunkJobStatePort(pool);
    const parents = createPostgresChronicleChunkParentPort(pool);
    const claim = await state.claimNext({ workerId: "incremental-worker", leaseSeconds: 30 });
    if (!claim) throw new Error("chunk job was not claimed");

    const initial = await parents.loadForClaim(claim, { batchLimit: 10, cursor: null });
    expect(initial.parents.map((parent) => parent.id).sort())
      .toEqual(value.parents.map((parent) => parent.id).sort());
    expect(initial.totalParents).toBe(2);

    // The first parent becomes terminally chunked at its current content hash.
    await pool.query(
      `INSERT INTO chronicle_memory_chunks
         (owner_user_id,campaign_id,world_version_id,parent_memory_id,parent_content_hash,
          chunking_protocol_version,chunk_ordinal,chunk_kind,content,token_estimate,
          embedding_status,embedding_skip_reason)
       VALUES ($1,$2,$3,$4,$5,'chronicle-chunk-v1',0,'campaign_summary','First safe parent.',4,
               'skipped','semantic_retrieval_disabled')`,
      [value.ownerUserId, value.campaignId, value.worldVersionId,
        value.parents[0]!.id, value.parents[0]!.content_hash]
    );

    const afterIndexing = await parents.loadForClaim(claim, { batchLimit: 10, cursor: null });
    expect(afterIndexing.parents.map((parent) => parent.id)).toEqual([value.parents[1]!.id]);
    // Scope total stays stable so the worker's mid-run parent-total invariant still holds.
    expect(afterIndexing.totalParents).toBe(2);

    // Editing that parent's content makes its chunks stale, so it needs work again.
    await pool.query(
      "UPDATE chronicle_memories SET content='First safe parent, corrected.' WHERE id=$1",
      [value.parents[0]!.id]
    );
    const afterEdit = await parents.loadForClaim(claim, { batchLimit: 10, cursor: null });
    expect(afterEdit.parents.map((parent) => parent.id).sort())
      .toEqual(value.parents.map((parent) => parent.id).sort());
  });

  it("resumes a durable cursor across an appended parent and restarts when the processed prefix changes", async () => {
    const value = await fixture("resume-prefix");
    const jobId = await enqueuePostgresChronicleChunkIndex(pool, value);
    const cursor = `1:${value.parents[0]!.id}`;
    const processedSignature = (await pool.query<{ signature: string }>(
      `SELECT encode(digest(COALESCE(string_agg(
                m.ordinal::text || ':' || m.id::text || ':' || m.content_hash, E'\\x1e'
                ORDER BY m.ordinal,m.id), ''),'sha256'),'hex') AS signature
         FROM chronicle_memories m
        WHERE m.owner_user_id=$1 AND m.campaign_id=$2 AND m.world_version_id=$3 AND m.ordinal<=1`,
      [value.ownerUserId, value.campaignId, value.worldVersionId]
    )).rows[0]!.signature;
    await pool.query(
      "UPDATE chronicle_chunk_jobs SET progress=$2::jsonb, processed_signature=$3 WHERE id=$1",
      [jobId, JSON.stringify({
        parentCursor: cursor, processedParents: 1, embeddedChunks: 1,
        skippedChunks: 0, totalParents: 2, capabilityFingerprint: "fingerprint-a"
      }), processedSignature]
    );

    // A newly accepted turn appends a parent after the cursor. The processed prefix is
    // untouched, so a long backfill must resume rather than restart from zero.
    await pool.query(
      `INSERT INTO chronicle_memories
         (owner_user_id,campaign_id,world_version_id,memory_kind,ordinal,content,token_estimate)
       VALUES ($1,$2,$3,'turn_fiction',3,'A newly accepted turn.',5)`,
      [value.ownerUserId, value.campaignId, value.worldVersionId]
    );
    await enqueuePostgresChronicleChunkIndex(pool, value);
    expect(await pool.query<{ progress: Record<string, unknown>; work_version: string }>(
      "SELECT progress,work_version::text FROM chronicle_chunk_jobs WHERE id=$1", [jobId]
    )).toMatchObject({
      rows: [{ work_version: "2", progress: expect.objectContaining({ parentCursor: cursor }) }]
    });

    // Editing an already-processed parent invalidates the prefix, so the cursor is cleared.
    await pool.query(
      "UPDATE chronicle_memories SET content='First safe parent, rewritten.' WHERE id=$1",
      [value.parents[0]!.id]
    );
    await enqueuePostgresChronicleChunkIndex(pool, value);
    expect(await pool.query<{ progress: Record<string, unknown>; processed_signature: string | null }>(
      "SELECT progress,processed_signature FROM chronicle_chunk_jobs WHERE id=$1", [jobId]
    )).toMatchObject({ rows: [{ progress: {}, processed_signature: null }] });
  });
});
