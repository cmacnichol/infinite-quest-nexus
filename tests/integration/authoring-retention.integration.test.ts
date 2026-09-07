import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authoringSubmitSchema } from "../../packages/contracts/src/index.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresAuthoringRepository } from "../../packages/database/src/authoring-job-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

type RetentionRepository = ReturnType<typeof createPostgresAuthoringRepository> & {
  cleanupAuthoring(input: { batchSize: number; now: Date }): Promise<number>;
};

integration("authoring retention PostgreSQL repository", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  const jobIds: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterEach(async () => {
    if (jobIds.length) await pool.query("DELETE FROM authoring_jobs WHERE id = ANY($1::uuid[])", [jobIds]);
    jobIds.length = 0;
  });

  afterAll(async () => { await pool?.end(); });

  function input(key = `retention-${crypto.randomUUID()}`) {
    return authoringSubmitSchema.parse({
      kind: "world_concept",
      idempotencyKey: key,
      target: { kind: "new_world" },
      prompt: "Preserve this proposal only until the durable retention deadline."
    });
  }

  async function submitted() {
    const repository = createPostgresAuthoringRepository(pool);
    const job = await repository.submit({ ownerUserId }, input(), "a".repeat(64));
    jobIds.push(job.id);
    return { repository: repository as RetentionRepository, job };
  }

  it("expires inactive proposals without allowing reads or heartbeats to extend retention", async () => {
    const { repository, job } = await submitted();
    const cutoff = new Date("2026-09-01T00:00:00.000Z");
    await pool.query("UPDATE authoring_jobs SET expires_at = $2::timestamptz WHERE id = $1", [job.id, "2026-08-25T00:00:00.000Z"]);

    await expect(repository.read({ ownerUserId }, job.id)).resolves.toMatchObject({ id: job.id });
    await expect(repository.cleanupAuthoring({ batchSize: 100, now: cutoff })).resolves.toBe(1);

    await expect(pool.query<{ status: string; input: unknown; reviewed: unknown; snapshot: unknown }>(
      `SELECT status, input, reviewed_content AS reviewed, execution_snapshot AS snapshot
         FROM authoring_jobs WHERE id = $1`,
      [job.id]
    )).resolves.toMatchObject({ rows: [{ status: "expired", input: { expired: true }, reviewed: null, snapshot: null }] });
    await expect(repository.read({ ownerUserId }, job.id)).resolves.toMatchObject({
      id: job.id,
      status: "expired"
    });
  });

  it("fences a stale running claim before removing stage payloads, including pending cancellation", async () => {
    const { repository, job } = await submitted();
    const claim = await repository.claim("retention-live-worker", 300);
    await pool.query(
      `UPDATE authoring_jobs SET status = 'cancel_requested', expires_at = $2::timestamptz WHERE id = $1`,
      [job.id, "2026-08-25T00:00:00.000Z"]
    );
    await pool.query("UPDATE authoring_job_stages SET output = $2::jsonb WHERE id = $1", [claim!.stageId, JSON.stringify({ private: "stage-payload-sentinel" })]);

    await expect(repository.cleanupAuthoring({ batchSize: 100, now: new Date("2026-09-01T00:00:00.000Z") })).resolves.toBe(1);
    await expect(repository.checkpoint(claim!, { kind: "outline", outline: { title: "Late", genre: "fantasy", tone: "calm", backgroundStory: "Late", premise: "Late", firstAction: "Late", rules: "Late", seeds: [], rpgStats: [], defaultTriggers: [], eventTriggers: [] } })).resolves.toBe(false);
    await expect(pool.query<{ status: string; lease: string | null; output: unknown }>(
      "SELECT status, lease_token AS lease, output FROM authoring_job_stages WHERE id = $1", [claim!.stageId]
    )).resolves.toMatchObject({ rows: [{ status: "cancelled", lease: null, output: null }] });
  });

  it("serializes a concurrent checkpoint and cleanup so only one can win the expired claim", async () => {
    const { repository, job } = await submitted();
    const claim = await repository.claim("retention-race-worker", 300);
    await pool.query("UPDATE authoring_jobs SET expires_at = $2::timestamptz WHERE id = $1", [job.id, "2026-08-25T00:00:00.000Z"]);
    const output = { kind: "outline" as const, outline: { title: "Race", genre: "fantasy", tone: "calm", backgroundStory: "Race", premise: "Race", firstAction: "Race", rules: "Race", seeds: [], rpgStats: [], defaultTriggers: [], eventTriggers: [] } };

    const [cleaned, checkpointed] = await Promise.all([
      repository.cleanupAuthoring({ batchSize: 100, now: new Date("2026-09-01T00:00:00.000Z") }),
      repository.checkpoint(claim!, output)
    ]);

    expect(Number(cleaned) + Number(checkpointed)).toBe(1);
    const stored = await pool.query<{ status: string; stageStatus: string; output: unknown }>(
      `SELECT jobs.status, stages.status AS "stageStatus", stages.output
         FROM authoring_jobs jobs JOIN authoring_job_stages stages ON stages.job_id = jobs.id
        WHERE jobs.id = $1`,
      [job.id]
    );
    if (cleaned === 1) {
      expect(stored.rows).toEqual([{ status: "expired", stageStatus: "cancelled", output: null }]);
    } else {
      expect(stored.rows).toMatchObject([{ status: "awaiting_review", stageStatus: "validated" }]);
    }
  });

  it("cleans applied receipts after thirty days without changing saved worlds and honors the batch cap", async () => {
    const { repository, job } = await submitted();
    const world = await pool.query<{ id: string; title: string }>(
      "INSERT INTO worlds (owner_user_id, title, status) VALUES ($1, 'Retention saved world', 'draft') RETURNING id, title",
      [ownerUserId]
    );
    const worldId = world.rows[0]!.id;
    await pool.query(
      `UPDATE authoring_jobs
          SET status = 'applied', input = '{"applied":true}'::jsonb, apply_receipt = '{"worldId":"ignored"}'::jsonb,
              expires_at = $2::timestamptz
        WHERE id = $1`,
      [job.id, "2026-08-01T00:00:00.000Z"]
    );
    const extraIds = Array.from({ length: 101 }, () => crypto.randomUUID());
    jobIds.push(...extraIds);
    await pool.query(
      `INSERT INTO authoring_jobs (id, owner_user_id, kind, target, input, request_hash, idempotency_key, status, expires_at)
       SELECT id, $1, 'world_concept', '{"kind":"new_world"}'::jsonb, '{"expired":true}'::jsonb,
              repeat('b', 64), id::text, 'failed', $2::timestamptz
         FROM unnest($3::uuid[]) id`,
      [ownerUserId, "2026-08-01T00:00:00.000Z", extraIds]
    );

    await expect(repository.cleanupAuthoring({ batchSize: 1_000, now: new Date("2026-09-01T00:00:00.000Z") })).resolves.toBe(100);
    await expect(pool.query("SELECT id, title FROM worlds WHERE id = $1", [worldId]))
      .resolves.toMatchObject({ rows: [{ id: worldId, title: "Retention saved world" }] });
    await pool.query("DELETE FROM worlds WHERE id = $1", [worldId]);
  });
});
