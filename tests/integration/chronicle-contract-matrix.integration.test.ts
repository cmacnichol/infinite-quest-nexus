import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresChronicleConfigurationRepository,
  createPostgresChronicleEmbeddingBatchPort,
  createPostgresChronicleGenerationTransactionPort,
  createPostgresChronicleJobRepository,
  createPostgresChronicleWorkerAdapters
} from "../../packages/database/src/chronicle-repository.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabaseClient,
  type DatabasePool,
  withTransaction
} from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
  chronicleContentHash,
  modelAwareEmbeddingPrefixes,
  providerModelFingerprint
} from "../../packages/domain/src/chronicle-memory-helpers.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

integration("PostgreSQL Chronicle contract matrix", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterEach(async () => {
    await pool.query("DROP TRIGGER IF EXISTS chronicle_claim_race_delay_trigger ON chronicle_jobs");
    await pool.query("DROP FUNCTION IF EXISTS chronicle_claim_race_delay()");
    await pool.query("DELETE FROM campaigns");
    await pool.query("DELETE FROM provider_profiles");
    await pool.query("DELETE FROM world_versions");
    await pool.query("DELETE FROM worlds");
    await pool.query("DELETE FROM users WHERE system_key IS NULL");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function campaignFixture(label: string, ownerId = ownerUserId) {
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1,$2) RETURNING id",
      [ownerId, `Chronicle matrix ${label} ${crypto.randomUUID()}`]
    );
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerId, JSON.stringify({ world: { title: label }, entities: [] })]
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
      [ownerId, version.rows[0]!.id, `Chronicle ${label}`]
    );
    await pool.query(
      "INSERT INTO campaign_state (campaign_id, owner_user_id) VALUES ($1,$2)",
      [campaign.rows[0]!.id, ownerId]
    );
    return {
      ownerUserId: ownerId,
      worldId: world.rows[0]!.id,
      worldVersionId: version.rows[0]!.id,
      campaignId: campaign.rows[0]!.id
    };
  }

  async function jobFixture(
    campaignId: string,
    jobType: "reindex_campaign" | "embed_campaign",
    createdAt: string,
    status: "queued" | "running" = "queued"
  ) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type, status, created_at)
       VALUES ($1,$2,$3,$4,$5::timestamptz) RETURNING id`,
      [ownerUserId, campaignId, jobType, status, createdAt]
    );
    return result.rows[0]!.id;
  }

  async function providerFixture(label: string, role: "text" | "image" | "embedding" = "embedding") {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles
         (owner_user_id, name, provider_type, provider_role, base_url, default_model)
       VALUES ($1,$2,'openai_compatible',$3,'http://provider.invalid/v1',$4) RETURNING id`,
      [ownerUserId, `Chronicle ${label} ${crypto.randomUUID()}`, role, `${label}-model`]
    );
    return result.rows[0]!.id;
  }

  async function configureEmbedding(
    campaignId: string,
    providerId: string,
    model: string,
    documentPrefix: string | null = null,
    queryPrefix: string | null = null,
  ) {
    await pool.query(
      `INSERT INTO campaign_memory_configs
         (campaign_id, owner_user_id, embedding_enabled, embedding_provider_profile_id,
          embedding_model, embedding_document_prefix, embedding_query_prefix)
       VALUES ($1,$2,true,$3,$4,$5,$6)`,
      [campaignId, ownerUserId, providerId, model, documentPrefix, queryPrefix]
    );
  }

  function embeddingFingerprint(
    providerId: string,
    model: string,
    documentPrefix: string | null = null,
    queryPrefix: string | null = null,
  ) {
    return providerModelFingerprint({
      providerType: "openai_compatible",
      baseUrl: providerId,
      model,
      configuration: {},
      protocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION
    }, modelAwareEmbeddingPrefixes(model, documentPrefix, queryPrefix));
  }

  async function installClaimRaceDelay() {
    await pool.query(`
      CREATE FUNCTION chronicle_claim_race_delay() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'running' AND NEW.lease_owner LIKE 'race-%' THEN
          PERFORM pg_sleep(0.2);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE TRIGGER chronicle_claim_race_delay_trigger
      BEFORE UPDATE ON chronicle_jobs
      FOR EACH ROW EXECUTE FUNCTION chronicle_claim_race_delay()
    `);
  }

  it("skips a locked oldest row and claims the next eligible job", async () => {
    const oldest = await campaignFixture("locked oldest");
    const next = await campaignFixture("next oldest");
    const oldestJobId = await jobFixture(oldest.campaignId, "reindex_campaign", "2000-01-01T00:00:00Z");
    const nextJobId = await jobFixture(next.campaignId, "reindex_campaign", "2000-01-02T00:00:00Z");
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM chronicle_jobs WHERE id = $1 FOR UPDATE", [oldestJobId]);
      const { state } = createPostgresChronicleWorkerAdapters(pool);
      const claim = await state.claimNext({ workerId: "skip-locked-worker", leaseSeconds: 30 });
      expect(claim?.jobId).toBe(nextJobId);
      if (!claim) throw new Error("next fixture job was not claimed");
      await expect(state.completeClaim(claim, { progress: {} })).resolves.toBe(true);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  });

  it("keeps at most one live Chronicle job per campaign", async () => {
    const fixture = await campaignFixture("one live job");
    const firstJobId = await jobFixture(fixture.campaignId, "reindex_campaign", "2000-02-01T00:00:00Z");
    const secondJobId = await jobFixture(fixture.campaignId, "embed_campaign", "2000-02-02T00:00:00Z");
    const { state } = createPostgresChronicleWorkerAdapters(pool);

    const first = await state.claimNext({ workerId: "campaign-worker-a", leaseSeconds: 30 });
    expect(first?.jobId).toBe(firstJobId);
    await expect(state.claimNext({ workerId: "campaign-worker-b", leaseSeconds: 30 })).resolves.toBeNull();
    if (!first) throw new Error("first fixture job was not claimed");
    await expect(state.completeClaim(first, { progress: {} })).resolves.toBe(true);

    const second = await state.claimNext({ workerId: "campaign-worker-b", leaseSeconds: 30 });
    expect(second?.jobId).toBe(secondJobId);
    if (!second) throw new Error("second fixture job was not claimed");
    await expect(state.completeClaim(second, { progress: {} })).resolves.toBe(true);
  });

  it("returns one safe no-claim when simultaneous workers contend for queued siblings", async () => {
    const fixture = await campaignFixture("simultaneous sibling claim");
    await jobFixture(fixture.campaignId, "reindex_campaign", "2000-02-03T00:00:00Z");
    await jobFixture(fixture.campaignId, "embed_campaign", "2000-02-04T00:00:00Z");
    await installClaimRaceDelay();
    const { state } = createPostgresChronicleWorkerAdapters(pool);

    const results = await Promise.allSettled([
      state.claimNext({ workerId: "race-queued-a", leaseSeconds: 30 }),
      state.claimNext({ workerId: "race-queued-b", leaseSeconds: 30 })
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const claims = results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
    expect(claims).toHaveLength(1);
    await expect(pool.query<{ running: string; queued: string }>(
      `SELECT
         count(*) FILTER (WHERE status = 'running')::text AS running,
         count(*) FILTER (WHERE status = 'queued')::text AS queued
       FROM chronicle_jobs WHERE campaign_id = $1`,
      [fixture.campaignId]
    )).resolves.toMatchObject({ rows: [{ running: "1", queued: "1" }] });
  });

  it("returns one safe no-claim when an expired job races its queued sibling", async () => {
    const fixture = await campaignFixture("expired sibling claim");
    const expiredJobId = await jobFixture(
      fixture.campaignId,
      "reindex_campaign",
      "2000-02-05T00:00:00Z",
      "running"
    );
    await pool.query(
      `UPDATE chronicle_jobs
          SET lease_owner = 'expired-sibling-worker', lease_expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [expiredJobId]
    );
    await jobFixture(fixture.campaignId, "embed_campaign", "2000-02-06T00:00:00Z");
    await installClaimRaceDelay();
    const { state } = createPostgresChronicleWorkerAdapters(pool);

    const results = await Promise.allSettled([
      state.claimNext({ workerId: "race-expired-a", leaseSeconds: 30 }),
      state.claimNext({ workerId: "race-expired-b", leaseSeconds: 30 })
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const claims = results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
    expect(claims).toEqual([expect.objectContaining({ jobId: expiredJobId })]);
    await expect(pool.query<{ running: string; queued: string }>(
      `SELECT
         count(*) FILTER (WHERE status = 'running')::text AS running,
         count(*) FILTER (WHERE status = 'queued')::text AS queued
       FROM chronicle_jobs WHERE campaign_id = $1`,
      [fixture.campaignId]
    )).resolves.toMatchObject({ rows: [{ running: "1", queued: "1" }] });
  });

  it("claims the oldest eligible queued job before a newer expired lease", async () => {
    const oldest = await campaignFixture("old queued");
    const newer = await campaignFixture("new expired");
    const oldestJobId = await jobFixture(oldest.campaignId, "reindex_campaign", "2000-03-01T00:00:00Z");
    const newerJobId = await jobFixture(newer.campaignId, "reindex_campaign", "2000-03-02T00:00:00Z", "running");
    await pool.query(
      `UPDATE chronicle_jobs
          SET lease_owner = 'expired-worker', lease_expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [newerJobId]
    );
    const { state } = createPostgresChronicleWorkerAdapters(pool);

    const claim = await state.claimNext({ workerId: "oldest-first-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(oldestJobId);
    if (!claim) throw new Error("oldest fixture job was not claimed");
    await expect(state.completeClaim(claim, { progress: {} })).resolves.toBe(true);
  });

  it("reclaims an expired lease and fences every operation from the lost worker", async () => {
    const fixture = await campaignFixture("lost lease");
    const jobId = await jobFixture(fixture.campaignId, "embed_campaign", "2000-04-01T00:00:00Z");
    const { state } = createPostgresChronicleWorkerAdapters(pool);
    const lost = await state.claimNext({ workerId: "lost-worker", leaseSeconds: 30 });
    expect(lost?.jobId).toBe(jobId);
    if (!lost) throw new Error("lost-worker fixture job was not claimed");
    await pool.query(
      "UPDATE chronicle_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [jobId]
    );

    const replacement = await state.claimNext({ workerId: "replacement-worker", leaseSeconds: 30 });
    expect(replacement).toMatchObject({ jobId, workerId: "replacement-worker" });
    if (!replacement) throw new Error("expired fixture job was not reclaimed");
    await expect(state.loadClaimedJob(lost)).resolves.toBeNull();
    await expect(state.heartbeatClaim(lost)).resolves.toBe(false);
    await expect(state.failClaim(lost, { diagnosticCode: "lost" })).resolves.toBe(false);
    await expect(state.requeueClaim(lost, { reason: "lease_reclaimed" })).resolves.toBe(false);
    await expect(state.completeClaim(lost, { progress: { stale: true } })).resolves.toBe(false);
    await expect(state.heartbeatClaim(replacement)).resolves.toBe(true);
    await expect(state.completeClaim(replacement, { progress: { current: true } })).resolves.toBe(true);
    await expect(pool.query<{ attempts: number; status: string; progress: Record<string, unknown> }>(
      "SELECT attempts, status, progress FROM chronicle_jobs WHERE id = $1",
      [jobId]
    )).resolves.toMatchObject({ rows: [{ attempts: 2, status: "completed", progress: { current: true } }] });
  });

  it("requeues unconditionally on a newer work version and rejects the stale completion afterward", async () => {
    const fixture = await campaignFixture("work version");
    const jobId = await jobFixture(fixture.campaignId, "reindex_campaign", "2000-05-01T00:00:00Z");
    const { state } = createPostgresChronicleWorkerAdapters(pool);
    const stale = await state.claimNext({ workerId: "work-version-worker", leaseSeconds: 30 });
    expect(stale?.jobId).toBe(jobId);
    if (!stale) throw new Error("work-version fixture job was not claimed");
    await pool.query("UPDATE chronicle_jobs SET work_version = work_version + 1 WHERE id = $1", [jobId]);

    await expect(state.completeClaim(stale, {
      progress: { staleVersion: stale.workVersion },
      requeueIfWorkVersionChanged: false
    })).resolves.toBe(true);
    await expect(pool.query<{ status: string; completed_at: Date | null; progress: Record<string, unknown> }>(
      "SELECT status, completed_at, progress FROM chronicle_jobs WHERE id = $1",
      [jobId]
    )).resolves.toMatchObject({
      rows: [{ status: "queued", completed_at: null, progress: { staleVersion: stale.workVersion } }]
    });
    await expect(state.completeClaim(stale, { progress: { overwritten: true } })).resolves.toBe(false);

    const current = await state.claimNext({ workerId: "work-version-worker", leaseSeconds: 30 });
    expect(current).toMatchObject({ jobId, workVersion: stale.workVersion + 1 });
    if (!current) throw new Error("new work version was not claimed");
    await expect(state.completeClaim(current, { progress: { currentVersion: current.workVersion } })).resolves.toBe(true);
  });

  it("paginates a bounded claimed scope without a false cursor or cross-scope rows", async () => {
    const fixture = await campaignFixture("bounded retrieval");
    const other = await campaignFixture("retrieval exclusion");
    const jobId = await jobFixture(fixture.campaignId, "embed_campaign", "2000-06-01T00:00:00Z");
    await pool.query(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
       VALUES ($1,$2,$3,'campaign_summary',1,'owned page one',3),
              ($1,$2,$3,'open_thread',2,'owned page two',3),
              ($1,$4,$5,'campaign_summary',1,'other campaign',3),
              ($1,$2,$5,'canonical_fact',3,'other world version',3)`,
      [ownerUserId, fixture.campaignId, fixture.worldVersionId, other.campaignId, other.worldVersionId]
    );
    const { state, retrieval } = createPostgresChronicleWorkerAdapters(pool);
    const claim = await state.claimNext({ workerId: "retrieval-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(jobId);
    if (!claim) throw new Error("retrieval fixture job was not claimed");

    const first = await retrieval.loadForClaim(claim, { batchLimit: 1 });
    expect(first.memories).toEqual([expect.objectContaining({ content: "owned page one" })]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await retrieval.loadForClaim(claim, { batchLimit: 1, cursor: first.nextCursor });
    expect(second.memories).toEqual([expect.objectContaining({ content: "owned page two" })]);
    expect(second.nextCursor).toBeNull();
    await expect(retrieval.loadForClaim(claim, { batchLimit: 129 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(retrieval.loadForClaim(claim, { batchLimit: 1, cursor: "1:not-a-uuid" }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(state.completeClaim(claim, { progress: {} })).resolves.toBe(true);
  });

  it("rejects a first embedding batch that skips unrecorded progress", async () => {
    const fixture = await campaignFixture("first batch gap");
    const providerId = await providerFixture("first batch gap");
    await configureEmbedding(fixture.campaignId, providerId, "first-batch-gap-model");
    const jobId = await jobFixture(fixture.campaignId, "embed_campaign", "2000-06-15T00:00:00Z");
    const memory = await pool.query<{ id: string; content: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
       VALUES ($1,$2,$3,'campaign_summary',1,'gap batch',2) RETURNING id, content`,
      [ownerUserId, fixture.campaignId, fixture.worldVersionId]
    );
    const { state } = createPostgresChronicleWorkerAdapters(pool);
    const claim = await state.claimNext({ workerId: "gap-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(jobId);
    if (!claim) throw new Error("gap fixture job was not claimed");
    const batches = createPostgresChronicleEmbeddingBatchPort(pool, {
      async recordCost(database, _provider, scope) {
        await (database as DatabaseClient).query(
          `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
           VALUES ($1,$2,'chronicle_batch_cost',$3,'{}'::jsonb)`,
          [scope.ownerUserId, scope.campaignId, scope.chronicleJobId]
        );
        return null;
      }
    });

    await expect(batches.commitClaimBatch(claim, {
      provider: {
        id: providerId,
        model: "first-batch-gap-model",
        providerType: "openai_compatible",
      },
      providerFingerprint: embeddingFingerprint(providerId, "first-batch-gap-model"),
      protocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
      memories: [{
        ...memory.rows[0]!,
        contentHash: chronicleContentHash(memory.rows[0]!.content)
      }],
      result: {
        embeddings: [[0.1, 0.2]],
        responseId: "first-batch-gap-response",
        usage: {},
        reportedCost: null
      },
      processed: 2,
      total: 2
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(pool.query<{ embedded: boolean }>(
      "SELECT embedding IS NOT NULL AS embedded FROM chronicle_memories WHERE id = $1",
      [memory.rows[0]!.id]
    )).resolves.toMatchObject({ rows: [{ embedded: false }] });
    await expect(pool.query<{ progress: Record<string, unknown> }>(
      "SELECT progress FROM chronicle_jobs WHERE id = $1",
      [jobId]
    )).resolves.toMatchObject({ rows: [{ progress: {} }] });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM activity_events WHERE correlation_id = $1",
      [jobId]
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it.each(["provider", "model", "fingerprint", "configuration"] as const)(
    "rejects a first embedding batch after campaign %s drift with no partial writes",
    async (drift) => {
      const fixture = await campaignFixture(`configuration ${drift}`);
      const providerId = await providerFixture(`configuration ${drift}`);
      const otherProviderId = await providerFixture(`configuration ${drift} other`);
      const model = "configuration-anchor-model";
      const documentPrefix = "document: ";
      const queryPrefix = "query: ";
      await configureEmbedding(fixture.campaignId, providerId, model, documentPrefix, queryPrefix);
      const jobId = await jobFixture(fixture.campaignId, "embed_campaign", "2000-06-20T00:00:00Z");
      const memory = await pool.query<{ id: string; content: string }>(
        `INSERT INTO chronicle_memories
           (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
         VALUES ($1,$2,$3,'campaign_summary',1,'configuration batch',2) RETURNING id, content`,
        [ownerUserId, fixture.campaignId, fixture.worldVersionId]
      );
      const { state } = createPostgresChronicleWorkerAdapters(pool);
      const claim = await state.claimNext({ workerId: `configuration-${drift}-worker`, leaseSeconds: 30 });
      expect(claim?.jobId).toBe(jobId);
      if (!claim) throw new Error("configuration fixture job was not claimed");
      const batches = createPostgresChronicleEmbeddingBatchPort(pool, {
        async recordCost(database, _provider, scope) {
          await (database as DatabaseClient).query(
            `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
             VALUES ($1,$2,'chronicle_batch_cost',$3,'{}'::jsonb)`,
            [scope.ownerUserId, scope.campaignId, scope.chronicleJobId]
          );
          return null;
        }
      });
      const configuredProvider = {
        id: providerId,
        model,
        providerType: "openai_compatible",
      };
      const input = {
        provider: drift === "provider"
          ? { ...configuredProvider, id: otherProviderId }
          : drift === "model"
            ? { ...configuredProvider, model: "changed-model" }
            : configuredProvider,
        providerFingerprint: drift === "fingerprint"
          ? "changed-provider-model-hash"
          : embeddingFingerprint(providerId, model, documentPrefix, queryPrefix),
        protocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
        memories: [{
          ...memory.rows[0]!,
          contentHash: chronicleContentHash(memory.rows[0]!.content)
        }],
        result: {
          embeddings: [[0.1, 0.2]],
          responseId: `configuration-${drift}-response`,
          usage: {},
          reportedCost: null
        },
        processed: 1,
        total: 1
      } as const;
      if (drift === "configuration") {
        await pool.query(
          `UPDATE campaign_memory_configs SET embedding_query_prefix = 'changed-query: '
            WHERE campaign_id = $1 AND owner_user_id = $2`,
          [fixture.campaignId, ownerUserId]
        );
      }

      await expect(batches.commitClaimBatch(claim, input)).rejects.toMatchObject({ statusCode: 400 });
      await expect(pool.query<{ embedded: boolean }>(
        "SELECT embedding IS NOT NULL AS embedded FROM chronicle_memories WHERE id = $1",
        [memory.rows[0]!.id]
      )).resolves.toMatchObject({ rows: [{ embedded: false }] });
      await expect(pool.query<{ progress: Record<string, unknown> }>(
        "SELECT progress FROM chronicle_jobs WHERE id = $1",
        [jobId]
      )).resolves.toMatchObject({ rows: [{ progress: {} }] });
      await expect(pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM activity_events WHERE correlation_id = $1",
        [jobId]
      )).resolves.toMatchObject({ rows: [{ count: "0" }] });
    }
  );

  it("commits embeddings, attributed cost, and guarded progress in one batch transaction", async () => {
    const fixture = await campaignFixture("atomic batch");
    const providerId = await providerFixture("atomic batch");
    await configureEmbedding(fixture.campaignId, providerId, "atomic-batch-model");
    const jobId = await jobFixture(fixture.campaignId, "embed_campaign", "2000-07-01T00:00:00Z");
    const memories = await pool.query<{ id: string; content: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
       VALUES ($1,$2,$3,'campaign_summary',1,'batch one',2),
              ($1,$2,$3,'open_thread',2,'batch two',2)
       RETURNING id, content`,
      [ownerUserId, fixture.campaignId, fixture.worldVersionId]
    );
    const { state } = createPostgresChronicleWorkerAdapters(pool);
    const claim = await state.claimNext({ workerId: "batch-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(jobId);
    if (!claim) throw new Error("batch fixture job was not claimed");
    const costs: Array<Record<string, unknown>> = [];
    const batches = createPostgresChronicleEmbeddingBatchPort(pool, {
      async recordCost(database, _provider, scope) {
        costs.push(scope);
        await (database as DatabaseClient).query(
          `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
           VALUES ($1,$2,'chronicle_batch_cost',$3,'{}'::jsonb)`,
          [scope.ownerUserId, scope.campaignId, scope.chronicleJobId]
        );
        return null;
      }
    });
    const provider = {
      id: providerId,
      model: "atomic-batch-model",
      providerType: "openai_compatible",
    };
    const providerFingerprint = embeddingFingerprint(provider.id, provider.model);

    await expect(batches.commitClaimBatch(claim, {
      provider,
      providerFingerprint,
      protocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
      memories: [memories.rows[0]!].map((memory) => ({
        ...memory,
        contentHash: chronicleContentHash(memory.content)
      })),
      result: {
        embeddings: [[0.1, 0.2, 0.3]],
        responseId: "atomic-batch-response",
        usage: { inputTokens: 2 },
        reportedCost: { amount: "0.0001", currency: "USD" }
      },
      processed: 1,
      total: 2
    })).resolves.toBe(true);
    expect(costs).toEqual([expect.objectContaining({
      ownerUserId,
      campaignId: fixture.campaignId,
      chronicleJobId: jobId,
      operation: "memory_embedding"
    })]);
    await expect(pool.query<{
      embedded: boolean;
      embedding_dimensions: number | null;
      embedding_provider_profile_id: string | null;
      embedding_model: string | null;
      embedding_provider_fingerprint: string | null;
    }>(
      `SELECT embedding IS NOT NULL AS embedded, embedding_dimensions,
              embedding_provider_profile_id, embedding_model, embedding_provider_fingerprint
         FROM chronicle_memories WHERE id = $1`,
      [memories.rows[0]!.id]
    )).resolves.toMatchObject({ rows: [{
      embedded: true,
      embedding_dimensions: 3,
      embedding_provider_profile_id: providerId,
      embedding_model: provider.model,
      embedding_provider_fingerprint: providerFingerprint
    }] });
    await expect(pool.query<{ progress: Record<string, unknown> }>(
      "SELECT progress FROM chronicle_jobs WHERE id = $1",
      [jobId]
    )).resolves.toMatchObject({ rows: [{ progress: {
      embedded: 1,
      total: 2,
      embeddingDimensions: 3,
      embeddingProviderProfileId: providerId,
      embeddingModel: provider.model,
      embeddingProviderFingerprint: providerFingerprint,
      embeddingProtocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION
    } }] });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM activity_events WHERE correlation_id = $1",
      [jobId]
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });

    const secondProviderId = await providerFixture("changed provider");
    const secondMemory = memories.rows[1]!;
    const nextBatch = {
      provider,
      providerFingerprint,
      protocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
      memories: [{
        ...secondMemory,
        contentHash: chronicleContentHash(secondMemory.content)
      }],
      result: {
        embeddings: [[0.7, 0.8, 0.9]],
        responseId: "guarded-second-response",
        usage: {},
        reportedCost: null
      },
      processed: 2,
      total: 2
    } as const;
    await expect(batches.commitClaimBatch(claim, {
      ...nextBatch,
      provider: { ...provider, id: secondProviderId }
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(batches.commitClaimBatch(claim, {
      ...nextBatch,
      provider: { ...provider, model: "changed-model" }
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(batches.commitClaimBatch(claim, {
      ...nextBatch,
      providerFingerprint: "changed-provider-model-hash"
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(batches.commitClaimBatch(claim, {
      ...nextBatch,
      protocolVersion: "chronicle-embedding-v2"
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(batches.commitClaimBatch(claim, {
      ...nextBatch,
      result: { ...nextBatch.result, embeddings: [[0.1, 0.2]] }
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(batches.commitClaimBatch(claim, {
      ...nextBatch,
      memories: [{ ...nextBatch.memories[0], contentHash: "stale-content-hash" }]
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(batches.commitClaimBatch(claim, {
      ...nextBatch,
      memories: [{ ...nextBatch.memories[0], id: crypto.randomUUID() }]
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(pool.query<{ embedded: boolean }>(
      "SELECT embedding IS NOT NULL AS embedded FROM chronicle_memories WHERE id = $1",
      [secondMemory.id]
    )).resolves.toMatchObject({ rows: [{ embedded: false }] });
    await expect(pool.query<{ progress: Record<string, unknown> }>(
      "SELECT progress FROM chronicle_jobs WHERE id = $1",
      [jobId]
    )).resolves.toMatchObject({ rows: [{ progress: expect.objectContaining({ embedded: 1, total: 2 }) }] });
    expect(costs).toHaveLength(1);
  });

  it("rolls back a whole embedding batch when cost attribution fails", async () => {
    const fixture = await campaignFixture("batch rollback");
    const providerId = await providerFixture("batch rollback");
    await configureEmbedding(fixture.campaignId, providerId, "batch-rollback-model");
    const jobId = await jobFixture(fixture.campaignId, "embed_campaign", "2000-08-01T00:00:00Z");
    const memory = await pool.query<{ id: string; content: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
       VALUES ($1,$2,$3,'campaign_summary',1,'rollback batch',2) RETURNING id, content`,
      [ownerUserId, fixture.campaignId, fixture.worldVersionId]
    );
    const { state } = createPostgresChronicleWorkerAdapters(pool);
    const claim = await state.claimNext({ workerId: "rollback-worker", leaseSeconds: 30 });
    expect(claim?.jobId).toBe(jobId);
    if (!claim) throw new Error("rollback fixture job was not claimed");
    const batches = createPostgresChronicleEmbeddingBatchPort(pool, {
      async recordCost(database, _provider, scope) {
        await (database as DatabaseClient).query(
          `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
           VALUES ($1,$2,'chronicle_batch_cost',$3,'{}'::jsonb)`,
          [scope.ownerUserId, scope.campaignId, scope.chronicleJobId]
        );
        throw new Error("synthetic cost failure");
      }
    });

    await expect(batches.commitClaimBatch(claim, {
      provider: {
        id: providerId,
        model: "batch-rollback-model",
        providerType: "openai_compatible",
      },
      providerFingerprint: embeddingFingerprint(providerId, "batch-rollback-model"),
      protocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
      memories: [{
        ...memory.rows[0]!,
        contentHash: chronicleContentHash(memory.rows[0]!.content)
      }],
      result: {
        embeddings: [[0.4, 0.5]],
        responseId: "batch-rollback-response",
        usage: {},
        reportedCost: { amount: "0.0001", currency: "USD" }
      },
      processed: 1,
      total: 1
    })).rejects.toThrow("synthetic cost failure");
    await expect(pool.query<{ embedded: boolean }>(
      "SELECT embedding IS NOT NULL AS embedded FROM chronicle_memories WHERE id = $1",
      [memory.rows[0]!.id]
    )).resolves.toMatchObject({ rows: [{ embedded: false }] });
    await expect(pool.query<{ progress: Record<string, unknown> }>(
      "SELECT progress FROM chronicle_jobs WHERE id = $1",
      [jobId]
    )).resolves.toMatchObject({ rows: [{ progress: {} }] });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM activity_events WHERE correlation_id = $1",
      [jobId]
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("enforces owner, campaign, and world-version scope through repositories and foreign keys", async () => {
    const owned = await campaignFixture("owned isolation");
    const otherWorld = await campaignFixture("other world");
    const foreignUser = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name) VALUES ('Chronicle foreign owner') RETURNING id"
    );
    const foreign = await campaignFixture("foreign isolation", foreignUser.rows[0]!.id);
    const jobs = createPostgresChronicleJobRepository(pool);
    const queued = await jobs.enqueueChronicleReindex(owned);

    await expect(jobs.getJob({ ownerUserId: foreign.ownerUserId, jobId: queued.jobId }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(jobs.enqueueChronicleReindex({ ...owned, ownerUserId: foreign.ownerUserId }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(jobs.enqueueChronicleReindex({ ...owned, worldVersionId: otherWorld.worldVersionId }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(pool.query(
      `INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type)
       VALUES ($1,$2,'embed_campaign')`,
      [foreign.ownerUserId, owned.campaignId]
    )).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, memory_kind, content, token_estimate)
       VALUES ($1,$2,$3,'campaign_summary','foreign mismatch',2)`,
      [foreign.ownerUserId, owned.campaignId, foreign.worldVersionId]
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("excludes image providers, prefers dedicated embeddings, and projects failed jobs safely", async () => {
    const fixture = await campaignFixture("provider boundary");
    const imageProviderId = await providerFixture("image only", "image");
    const textProviderId = await providerFixture("text fallback", "text");
    const embeddingProviderId = await providerFixture("dedicated embedding", "embedding");
    const configuration = createPostgresChronicleConfigurationRepository(pool);
    const input = {
      enabled: true,
      model: "nomic-embed-text",
      batchSize: 16,
      documentPrefix: null,
      queryPrefix: null
    };

    await expect(configuration.setEmbeddingConfig(fixture, {
      ...input,
      providerProfileId: imageProviderId
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(configuration.setEmbeddingConfig(fixture, {
      ...input,
      providerProfileId: textProviderId
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(configuration.setEmbeddingConfig(fixture, {
      ...input,
      providerProfileId: embeddingProviderId
    })).resolves.toMatchObject({ enabled: true, providerProfileId: embeddingProviderId });

    const failed = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type, status, error_message)
       VALUES ($1,$2,'embed_campaign','failed',$3) RETURNING id`,
      [ownerUserId, fixture.campaignId, "token=super-secret http://internal.provider.invalid/v1"]
    );
    const publicJob = await createPostgresChronicleJobRepository(pool).getJob({
      ownerUserId,
      jobId: failed.rows[0]!.id
    });
    expect(publicJob.failure).toEqual({
      code: "memory_unavailable",
      message: "Chronicle memory is unavailable."
    });
    expect(JSON.stringify(publicJob)).not.toContain("super-secret");
    expect(JSON.stringify(publicJob)).not.toContain("internal.provider.invalid");
  });

  it("round-trips chunked retrieval controls while omitted controls retain legacy defaults", async () => {
    const fixture = await campaignFixture("retrieval configuration");
    const embeddingProviderId = await providerFixture("retrieval configuration");
    const configuration = createPostgresChronicleConfigurationRepository(pool);
    const input = {
      enabled: true,
      providerProfileId: embeddingProviderId,
      model: "retrieval-model",
      batchSize: 16,
      documentPrefix: null,
      queryPrefix: null
    };

    await expect(configuration.getEmbeddingConfig(fixture)).resolves.toMatchObject({
      retrievalImplementation: "legacy_hybrid",
      retrievalShadowEnabled: false
    });
    await expect(configuration.setEmbeddingConfig(fixture, {
      ...input,
      retrievalImplementation: "chunked_hybrid",
      retrievalShadowEnabled: true
    })).resolves.toMatchObject({
      retrievalImplementation: "chunked_hybrid",
      retrievalShadowEnabled: true
    });
    await expect(configuration.getEmbeddingConfig(fixture)).resolves.toMatchObject({
      retrievalImplementation: "chunked_hybrid",
      retrievalShadowEnabled: true
    });
    await expect(configuration.setEmbeddingConfig(fixture, input)).resolves.toMatchObject({
      retrievalImplementation: "legacy_hybrid",
      retrievalShadowEnabled: false
    });
    await expect(pool.query<{ count: string; job_type: string }>(
      `SELECT count(*)::text AS count, min(job_type) AS job_type
         FROM chronicle_chunk_jobs WHERE campaign_id=$1`,
      [fixture.campaignId]
    )).resolves.toMatchObject({ rows: [{ count: "1", job_type: "index_memory_chunks_v2" }] });
  });

  it("enqueues only v2 chunk work after an accepted parent write and rebuild", async () => {
    const fixture = await campaignFixture("accepted chunk enqueue");
    const providerId = await providerFixture("accepted chunk enqueue");
    await configureEmbedding(fixture.campaignId, providerId, "embed-v1");
    const turn = await pool.query<{ id: string }>(
      `INSERT INTO turns
         (owner_user_id,campaign_id,turn_number,action,narration,state_snapshot_private)
       VALUES ($1,$2,1,'Open the gate.','The gate opens.','{}'::jsonb) RETURNING id`,
      [ownerUserId, fixture.campaignId]
    );
    const transaction = createPostgresChronicleGenerationTransactionPort({
      embeddings: {
        async resolve() { return providerId; },
        async load() {
          return {
            id: providerId, model: "embed-v1", providerType: "openai_compatible",
            embed: async () => ({ embeddings: [], responseId: "unused", usage: {}, reportedCost: null })
          };
        },
        async embed() { return { embeddings: [], responseId: "unused", usage: {}, reportedCost: null }; },
        async fingerprint() { return "unused"; },
        async recordHealth() {},
        async recordCost() { return null; },
        logDiagnostic() {}
      }
    });
    const scope = { ...fixture, ownerUserId };
    const before = await pool.query<{ row: Record<string, unknown>; xmin: string }>(
      `SELECT to_jsonb(t)-'state_snapshot_private' AS row,xmin::text
         FROM turns t WHERE id=$1`, [turn.rows[0]!.id]
    );

    await withTransaction(pool, async (client) => {
      await transaction.writeAcceptedTurnFiction(client, {
        ...scope, turnId: turn.rows[0]!.id, ordinal: 1,
        action: "Open the gate.", narration: "The gate opens."
      });
    });
    const first = await pool.query<{ id: string; work_version: string }>(
      "SELECT id,work_version::text FROM chronicle_chunk_jobs WHERE campaign_id=$1",
      [fixture.campaignId]
    );
    expect(first.rows).toEqual([{ id: expect.any(String), work_version: "1" }]);
    expect(await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_jobs WHERE campaign_id=$1 AND job_type='index_memory_chunks_v2'",
      [fixture.campaignId]
    )).toMatchObject({ rows: [{ count: "0" }] });

    await withTransaction(pool, (client) => transaction.rebuildCampaignMemories(client, scope));
    expect(await pool.query<{ id: string; work_version: string; progress: Record<string, unknown> }>(
      "SELECT id,work_version::text,progress FROM chronicle_chunk_jobs WHERE campaign_id=$1",
      [fixture.campaignId]
    )).toMatchObject({ rows: [{ id: first.rows[0]!.id, work_version: "2", progress: {} }] });
    expect(await pool.query<{ row: Record<string, unknown>; xmin: string }>(
      `SELECT to_jsonb(t)-'state_snapshot_private' AS row,xmin::text
         FROM turns t WHERE id=$1`, [turn.rows[0]!.id]
    )).toEqual(before);
  });

  it("rolls back every direct Chronicle generation operation with its caller-owned transaction", async () => {
    const fixture = await campaignFixture("direct rollback");
    const providerId = await providerFixture("direct rollback");
    const turn = await pool.query<{ id: string }>(
      `INSERT INTO turns
         (owner_user_id, campaign_id, turn_number, action, narration, state_snapshot_private)
       VALUES ($1,$2,1,'Open the observatory.','Starlight floods the chamber.',$3::jsonb)
       RETURNING id`,
      [ownerUserId, fixture.campaignId, JSON.stringify({
        continuitySummary: "The observatory is open.",
        canonicalFacts: ["The observatory answers to moonlight."],
        openThreads: ["Find the hidden lens."]
      })]
    );
    const provider = {
      id: providerId,
      model: "direct-rollback-model",
      providerType: "openai_compatible",
      embed: async () => ({ embeddings: [], responseId: "unused", usage: {}, reportedCost: null }),
    };
    const transaction = createPostgresChronicleGenerationTransactionPort({
      embeddings: {
        async resolve(_database, scope) {
          return scope.selectedProviderProfileId ?? providerId;
        },
        async load() {
          return provider;
        },
        async embed() {
          return {
            embeddings: [[0.1, 0.2]],
            responseId: "direct-preview-response",
            usage: {},
            reportedCost: null
          };
        },
        async fingerprint() {
          return "direct-preview-fingerprint";
        },
        async recordHealth(database, scope, healthy) {
          await (database as DatabaseClient).query(
            `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
             VALUES ($1,$2,'chronicle_direct_health',$3,$4::jsonb)`,
            [scope.ownerUserId, fixture.campaignId, scope.providerProfileId, JSON.stringify({ healthy })]
          );
        },
        async recordCost(database, _loadedProvider, scope) {
          await (database as DatabaseClient).query(
            `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
             VALUES ($1,$2,'chronicle_direct_cost',$3,'{}'::jsonb)`,
            [scope.ownerUserId, scope.campaignId, scope.generationJobId ?? "preview"]
          );
          return null;
        },
        logDiagnostic() {}
      }
    });
    const rollback = new Error("forced outer rollback");
    const scope = {
      ownerUserId,
      campaignId: fixture.campaignId,
      worldVersionId: fixture.worldVersionId
    };
    const expectForcedRollback = async (operation: Parameters<typeof withTransaction>[1]) => {
      await expect(withTransaction(pool, operation)).rejects.toBe(rollback);
    };

    await expectForcedRollback(async (client) => {
      await transaction.writeAcceptedTurnFiction(client, {
        ...scope,
        turnId: turn.rows[0]!.id,
        ordinal: 1,
        action: "Open the observatory.",
        narration: "Starlight floods the chamber."
      });
      throw rollback;
    });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_memories WHERE campaign_id = $1",
      [fixture.campaignId]
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });

    await expectForcedRollback(async (client) => {
      await transaction.storeDerivedTurnMemories(client, {
        ...scope,
        turnId: turn.rows[0]!.id,
        ordinal: 8,
        derived: {
          continuitySummary: "The observatory is open.",
          canonicalFacts: ["The observatory answers to moonlight."],
          openThreads: ["Find the hidden lens."]
        }
      });
      throw rollback;
    });
    await expect(pool.query<{ memories: string; facts: string; checkpoints: string }>(
      `SELECT
         (SELECT count(*)::text FROM chronicle_memories WHERE campaign_id = $1) AS memories,
         (SELECT count(*)::text FROM campaign_canonical_facts WHERE campaign_id = $1) AS facts,
         (SELECT count(*)::text FROM summary_checkpoints WHERE campaign_id = $1) AS checkpoints`,
      [fixture.campaignId]
    )).resolves.toMatchObject({ rows: [{ memories: "0", facts: "0", checkpoints: "0" }] });

    await pool.query(
      `INSERT INTO summary_checkpoints
         (owner_user_id, campaign_id, through_turn, summary_kind, content, token_estimate)
       VALUES ($1,$2,0,'campaign_continuity','{"baseline":true}'::jsonb,1)`,
      [ownerUserId, fixture.campaignId]
    );
    await expectForcedRollback(async (client) => {
      await transaction.rebuildCampaignMemories(client, scope);
      throw rollback;
    });
    await expect(pool.query<{ memories: string; facts: string; checkpoints: string; baseline: boolean }>(
      `SELECT
         (SELECT count(*)::text FROM chronicle_memories WHERE campaign_id = $1) AS memories,
         (SELECT count(*)::text FROM campaign_canonical_facts WHERE campaign_id = $1) AS facts,
         (SELECT count(*)::text FROM summary_checkpoints WHERE campaign_id = $1) AS checkpoints,
         (SELECT content->>'baseline' = 'true' FROM summary_checkpoints WHERE campaign_id = $1 LIMIT 1) AS baseline`,
      [fixture.campaignId]
    )).resolves.toMatchObject({ rows: [{ memories: "0", facts: "0", checkpoints: "1", baseline: true }] });

    await expectForcedRollback(async (client) => {
      await transaction.autoEnableCampaignEmbedding(client, scope);
      throw rollback;
    });
    await expect(pool.query<{ configs: string; jobs: string }>(
      `SELECT
         (SELECT count(*)::text FROM campaign_memory_configs WHERE campaign_id = $1) AS configs,
         (SELECT count(*)::text FROM chronicle_jobs WHERE campaign_id = $1) AS jobs`,
      [fixture.campaignId]
    )).resolves.toMatchObject({ rows: [{ configs: "0", jobs: "0" }] });

    await pool.query(
      `INSERT INTO campaign_memory_configs
         (campaign_id, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model)
       VALUES ($1,$2,true,$3,$4)`,
      [fixture.campaignId, ownerUserId, providerId, provider.model]
    );
    await expectForcedRollback(async (client) => {
      await transaction.enqueueEmbeddingReindex(client, scope);
      throw rollback;
    });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_jobs WHERE campaign_id = $1",
      [fixture.campaignId]
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expectForcedRollback(async (client) => {
      await transaction.enqueueChunkIndex!(client, scope);
      throw rollback;
    });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_chunk_jobs WHERE campaign_id = $1",
      [fixture.campaignId]
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });

    await pool.query(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal, content,
          token_estimate, embedding, embedding_provider_profile_id, embedding_model,
          embedding_dimensions, embedding_content_hash, embedding_updated_at, embedding_provider_fingerprint)
       VALUES ($1,$2,$3,$4,'turn_fiction',1,'Starlight floods the chamber.',4,'[0.1,0.2]'::vector,
               $5,$6,2,$7,now(),'direct-preview-fingerprint')`,
      [ownerUserId, fixture.campaignId, fixture.worldVersionId, turn.rows[0]!.id,
        providerId, provider.model, chronicleContentHash("Starlight floods the chamber.")]
    );
    await expectForcedRollback(async (client) => {
      await transaction.buildContextPreview(client, {
        ...scope,
        request: { budgetTokens: 4096, compression: "auto", query: "starlight", recentTurns: 4 },
        costAttribution: { generationJobId: crypto.randomUUID(), operation: "context_preview_embedding" }
      });
      throw rollback;
    });
    await expect(pool.query<{ side_effects: string; memories: string }>(
      `SELECT
         (SELECT count(*)::text FROM activity_events
           WHERE campaign_id = $1 AND event_type IN ('chronicle_direct_cost','chronicle_direct_health')) AS side_effects,
         (SELECT count(*)::text FROM chronicle_memories WHERE campaign_id = $1) AS memories`,
      [fixture.campaignId]
    )).resolves.toMatchObject({ rows: [{ side_effects: "0", memories: "1" }] });
  });

  it("rebuilds idempotently with stable manual-correction provenance", async () => {
    const fixture = await campaignFixture("rebuild provenance");
    const turn = await pool.query<{ id: string }>(
      `INSERT INTO turns
         (owner_user_id, campaign_id, turn_number, action, narration, state_snapshot_private)
       VALUES ($1,$2,1,'Read the astrolabe.','The old constellations realign.',$3::jsonb)
       RETURNING id`,
      [ownerUserId, fixture.campaignId, JSON.stringify({
        continuitySummary: "The astrolabe has awakened.",
        canonicalFacts: ["The first constellation points north."],
        openThreads: ["Trace the northern star."]
      })]
    );
    const edit = await pool.query<{ id: string }>(
      `INSERT INTO campaign_state_edits
         (owner_user_id, campaign_id, effective_turn_number, revision, state_snapshot_private, changed_fields)
       VALUES ($1,$2,1,1,$3::jsonb,'["canonicalFacts"]'::jsonb) RETURNING id`,
      [ownerUserId, fixture.campaignId, JSON.stringify({
        continuitySummary: "The astrolabe now charts the southern sky.",
        canonicalFacts: [{ id: null, content: "The corrected constellation points south." }],
        openThreads: ["Trace the southern star."]
      })]
    );
    const transaction = createPostgresChronicleGenerationTransactionPort({
      embeddings: {
        async resolve() { return null; },
        async load() { throw new Error("not used by rebuild"); },
        async embed() { throw new Error("not used by rebuild"); },
        async fingerprint() { throw new Error("not used by rebuild"); },
        async recordHealth() {},
        async recordCost() { return null; },
        logDiagnostic() {}
      }
    });
    const scope = {
      ownerUserId,
      campaignId: fixture.campaignId,
      worldVersionId: fixture.worldVersionId
    };
    const snapshot = async () => {
      const facts = await pool.query(
        `SELECT id, source_turn_id, source_state_edit_id, source_turn_number, source_fact_index,
                content, valid_from_turn, valid_until_turn, metadata
           FROM campaign_canonical_facts WHERE campaign_id = $1
           ORDER BY source_turn_number, source_fact_index, id`,
        [fixture.campaignId]
      );
      const memories = await pool.query(
        `SELECT turn_id, memory_kind, ordinal, content, token_estimate, importance, metadata
           FROM chronicle_memories WHERE campaign_id = $1
           ORDER BY ordinal, memory_kind, content`,
        [fixture.campaignId]
      );
      const checkpoints = await pool.query(
        `SELECT through_turn, summary_kind, content, token_estimate
           FROM summary_checkpoints WHERE campaign_id = $1
           ORDER BY through_turn, summary_kind`,
        [fixture.campaignId]
      );
      return { facts: facts.rows, memories: memories.rows, checkpoints: checkpoints.rows };
    };

    await withTransaction(pool, (client) => transaction.rebuildCampaignMemories(client, scope));
    const first = await snapshot();
    await withTransaction(pool, (client) => transaction.rebuildCampaignMemories(client, scope));
    const second = await snapshot();
    expect(second).toEqual(first);
    expect(second.facts).toEqual([expect.objectContaining({
      source_turn_id: null,
      source_state_edit_id: edit.rows[0]!.id,
      content: "The corrected constellation points south.",
      metadata: expect.objectContaining({ stateEditId: edit.rows[0]!.id, manualCorrection: true })
    })]);
    expect(second.memories).toEqual(expect.arrayContaining([
      expect.objectContaining({
        turn_id: turn.rows[0]!.id,
        memory_kind: "turn_fiction"
      }),
      expect.objectContaining({
        turn_id: null,
        memory_kind: "canonical_fact",
        metadata: expect.objectContaining({ stateEditId: edit.rows[0]!.id, manualCorrection: true })
      }),
      expect.objectContaining({
        turn_id: null,
        memory_kind: "campaign_summary",
        metadata: expect.objectContaining({ stateEditId: edit.rows[0]!.id, manualCorrection: true })
      })
    ]));
  });
});
