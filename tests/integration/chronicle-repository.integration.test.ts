import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresChronicleWorkerAdapters
} from "../../packages/database/src/chronicle-repository.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { resolve } from "node:path";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("PostgreSQL Chronicle repository", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function campaignFixture(label: string) {
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `Chronicle repository ${label} ${crypto.randomUUID()}`]
    );
    const version = await pool.query<{ id: string }>(
      "INSERT INTO world_versions (world_id, owner_user_id, version_number, content) VALUES ($1,$2,1,'{}') RETURNING id",
      [world.rows[0]!.id, ownerUserId]
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, version.rows[0]!.id, `Chronicle ${label}`]
    );
    return { campaignId: campaign.rows[0]!.id, worldVersionId: version.rows[0]!.id };
  }

  it("claims one oldest job, fences the lease, and requeues on a newer work version", async () => {
    const first = await campaignFixture("first");
    const second = await campaignFixture("second");
    const firstJob = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type, status, created_at)
       VALUES ($1,$2,'reindex_campaign','queued', now() - interval '1000 years') RETURNING id`,
      [ownerUserId, first.campaignId]
    );
    const secondJob = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type, status, created_at)
       VALUES ($1,$2,'embed_campaign','queued', now() - interval '999 years') RETURNING id`,
      [ownerUserId, second.campaignId]
    );
    const { state } = createPostgresChronicleWorkerAdapters(pool);

    const claimed = await state.claimNext({ workerId: "chronicle-worker-a", leaseSeconds: 30 });
    expect(claimed).toMatchObject({
      jobId: firstJob.rows[0]!.id,
      ownerUserId,
      campaignId: first.campaignId,
      worldVersionId: first.worldVersionId,
      workVersion: 1,
      workerId: "chronicle-worker-a"
    });
    if (!claimed) throw new Error("fixture job was not claimed");
    await expect(state.heartbeatClaim(claimed)).resolves.toBe(true);
    await expect(state.completeClaim({ ...claimed, workerId: "other-worker" }, { progress: {} })).resolves.toBe(false);

    await pool.query("UPDATE chronicle_jobs SET work_version = work_version + 1 WHERE id = $1", [claimed.jobId]);
    await expect(state.completeClaim(claimed, { progress: {} })).resolves.toBe(true);
    await expect(pool.query<{ status: string; lease_owner: string | null }>(
      "SELECT status, lease_owner FROM chronicle_jobs WHERE id = $1", [claimed.jobId]
    )).resolves.toMatchObject({ rows: [{ status: "queued", lease_owner: null }] });
    await pool.query(
      `UPDATE chronicle_jobs SET status = 'running', work_version = work_version + 1,
          lease_owner = $2, lease_expires_at = now() + interval '30 seconds' WHERE id = $1`,
      [claimed.jobId, claimed.workerId]
    );
    await expect(state.completeClaim({ ...claimed, workVersion: 2 }, {
      progress: {},
      requeueIfWorkVersionChanged: false
    })).resolves.toBe(true);
    await expect(pool.query<{ status: string; lease_owner: string | null }>(
      "SELECT status, lease_owner FROM chronicle_jobs WHERE id = $1", [claimed.jobId]
    )).resolves.toMatchObject({ rows: [{ status: "queued", lease_owner: null }] });
    await pool.query("UPDATE chronicle_jobs SET status = 'completed' WHERE id = $1", [claimed.jobId]);
    await pool.query("UPDATE chronicle_jobs SET status = 'completed' WHERE id = $1", [secondJob.rows[0]!.id]);
  });

  it("keeps worker retrieval bounded to the claimed owner, campaign, and world version", async () => {
    const fixture = await campaignFixture("retrieval");
    const job = await pool.query<{ id: string }>(
      "INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type, status) VALUES ($1,$2,'embed_campaign','queued') RETURNING id",
      [ownerUserId, fixture.campaignId]
    );
    await pool.query(
      `INSERT INTO chronicle_memories (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
       VALUES ($1,$2,$3,'campaign_summary',1,'owned fiction',2),
              ($1,$2,$3,'open_thread',2,'second fiction',2)`,
      [ownerUserId, fixture.campaignId, fixture.worldVersionId]
    );
    await pool.query(
      `UPDATE chronicle_jobs
          SET status = 'running', attempts = 1, lease_owner = 'chronicle-worker-b',
              lease_expires_at = now() + interval '30 seconds'
        WHERE id = $1`,
      [job.rows[0]!.id]
    );
    const { retrieval } = createPostgresChronicleWorkerAdapters(pool);
    const claim = {
      jobId: job.rows[0]!.id,
      ownerUserId,
      campaignId: fixture.campaignId,
      worldVersionId: fixture.worldVersionId,
      jobType: "embed_campaign" as const,
      workVersion: 1,
      workerId: "chronicle-worker-b",
      leaseSeconds: 30
    };

    const page = await retrieval.loadForClaim(claim, { batchLimit: 1 });
    expect(page.batchLimit).toBe(1);
    expect(page.memories).toHaveLength(1);
    expect(page.memories[0]).toMatchObject({ content: "owned fiction" });
    expect(page.nextCursor).toEqual(expect.any(String));
    await expect(retrieval.loadForClaim(claim, { batchLimit: 0 })).rejects.toMatchObject({ statusCode: 400 });
  });
});
