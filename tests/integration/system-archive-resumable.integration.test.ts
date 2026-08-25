import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_ARCHIVE_DOMAINS, type SystemArchiveDomain } from "@infinite-quest/contracts";
import type { OwnerScope } from "../../packages/application/src/generation/types.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresSystemArchiveJobRepository } from "../../packages/database/src/system-archive-job-repository.js";
import { createPostgresSystemArchiveExportJobPort } from "../../packages/database/src/system-archive-export-repository.js";
import { createPostgresSystemArchiveUploadRepository } from "../../packages/database/src/system-archive-upload-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

integration("durable System Archive jobs and resumable uploads", () => {
  let pool: DatabasePool;
  let owner: OwnerScope;
  let foreignOwner: OwnerScope;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    owner = { ownerUserId: await initialOwnerId(pool) };
    const created = await pool.query<{ id: string }>(
      "INSERT INTO users (system_key,display_name) VALUES ($1,$2) RETURNING id",
      [`system-archive-foreign-${randomUUID()}`, "System Archive foreign owner"]
    );
    foreignOwner = { ownerUserId: created.rows[0]!.id };
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM system_archive_jobs");
    await pool.query("DELETE FROM system_archive_uploads");
  });

  async function reservePortableOperation(scopedOwner: OwnerScope, purpose: "portable_staging" | "portable_export") {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,$3,'portable',$4,gen_random_uuid(),'system-archive-test',
                 now()+interval '5 minutes',now()+interval '1 day')
       RETURNING id`,
      [scopedOwner.ownerUserId, hash(randomUUID()), purpose, hash(randomUUID())]
    );
    return inserted.rows[0]!.id;
  }

  async function createStagedInput(scopedOwner: OwnerScope): Promise<string> {
    const operationId = await reservePortableOperation(scopedOwner, "portable_staging");
    const staged = await pool.query<{ id: string }>(
      `INSERT INTO portable_staged_inputs (
         owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,$4,4,now()+interval '1 day') RETURNING id`,
      [scopedOwner.ownerUserId, hash(randomUUID()), operationId, hash("test-system-archive")]
    );
    return staged.rows[0]!.id;
  }

  it("idempotently enqueues one active export per owner while allowing another owner", async () => {
    const repository = createPostgresSystemArchiveJobRepository(pool);
    const idempotencyKeyHash = hash(`export-${randomUUID()}`);
    const first = await repository.enqueueExport(owner, idempotencyKeyHash);

    await expect(repository.enqueueExport(owner, idempotencyKeyHash)).resolves.toMatchObject({
      id: first.id,
      kind: "export",
      status: "queued"
    });
    await expect(repository.enqueueExport(owner, hash(`competing-${randomUUID()}`)))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(repository.enqueueExport(foreignOwner, hash(`foreign-${randomUUID()}`)))
      .resolves.toMatchObject({ kind: "export", status: "queued" });
  });

  it("allows only one active import globally and enforces staged-input ownership", async () => {
    const repository = createPostgresSystemArchiveJobRepository(pool);
    const ownerStaged = await createStagedInput(owner);
    const foreignStaged = await createStagedInput(foreignOwner);

    await expect(repository.enqueueImport(owner, ownerStaged, hash(`import-${randomUUID()}`)))
      .resolves.toMatchObject({ kind: "import", status: "queued" });
    await expect(repository.enqueueImport(foreignOwner, foreignStaged, hash(`foreign-import-${randomUUID()}`)))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(repository.enqueueImport(owner, foreignStaged, hash(`wrong-owner-${randomUUID()}`)))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects job statuses that belong to the other job kind", async () => {
    await expect(pool.query(
      `INSERT INTO system_archive_jobs (
         owner_user_id,kind,status,idempotency_key_hash
       ) VALUES ($1,'export','previewed',$2)`,
      [owner.ownerUserId, hash(`export-as-import-${randomUUID()}`)]
    )).rejects.toMatchObject({ constraint: "system_archive_jobs_kind_status_check" });

    const stagedInputId = await createStagedInput(owner);
    await expect(pool.query(
      `INSERT INTO system_archive_jobs (
         owner_user_id,kind,status,idempotency_key_hash,staged_input_id
       ) VALUES ($1,'import','published',$2,$3)`,
      [owner.ownerUserId, hash(`import-as-export-${randomUUID()}`), stagedInputId]
    )).rejects.toMatchObject({ constraint: "system_archive_jobs_kind_status_check" });
  });

  it("requires worker-owned states to carry complete lease evidence", async () => {
    await expect(pool.query(
      `INSERT INTO system_archive_jobs (
         owner_user_id,kind,status,idempotency_key_hash
       ) VALUES ($1,'export','capturing',$2)`,
      [owner.ownerUserId, hash(`unleased-worker-state-${randomUUID()}`)]
    )).rejects.toMatchObject({ constraint: "system_archive_jobs_lease_check" });

    await expect(pool.query(
      `INSERT INTO system_archive_jobs (
         owner_user_id,kind,status,idempotency_key_hash,lease_owner,lease_expires_at
       ) VALUES ($1,'export','queued',$2,'worker-that-must-not-own-waiting',now()+interval '1 minute')`,
      [owner.ownerUserId, hash(`leased-waiting-state-${randomUUID()}`)]
    )).rejects.toMatchObject({ constraint: "system_archive_jobs_lease_check" });

    await expect(pool.query(
      `INSERT INTO system_archive_jobs (
         owner_user_id,kind,status,idempotency_key_hash,lease_owner,lease_expires_at
       ) VALUES ($1,'export','capturing',$2,'system-archive-worker',now()+interval '1 minute')`,
      [owner.ownerUserId, hash(`valid-worker-state-${randomUUID()}`)]
    )).resolves.toMatchObject({ rowCount: 1 });

    const stagedInputId = await createStagedInput(owner);
    await expect(pool.query(
      `INSERT INTO system_archive_jobs (
         owner_user_id,kind,status,idempotency_key_hash,staged_input_id
       ) VALUES ($1,'import','waiting_for_gate',$2,$3)`,
      [owner.ownerUserId, hash(`valid-unleased-waiting-state-${randomUUID()}`), stagedInputId]
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("claims jobs once, heartbeats only a live owned lease, and reclaims an expired lease", async () => {
    const repository = createPostgresSystemArchiveJobRepository(pool);
    await pool.query("UPDATE system_archive_jobs SET status='failed',lease_owner=NULL,lease_expires_at=NULL WHERE status IN ('queued','capturing','revalidating','cancelling')");
    const queued = await repository.enqueueExport(owner, hash(`claim-${randomUUID()}`));

    const [first, second] = await Promise.all([
      repository.claimNext("system-archive-worker-a", 30),
      repository.claimNext("system-archive-worker-b", 30)
    ]);
    const claimed = first ?? second;
    expect(claimed).toMatchObject({ id: queued.id, status: "capturing" });
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await repository.heartbeat(queued.id, claimed!.leaseOwner, 30)).toBe(true);
    expect(await repository.heartbeat(queued.id, "not-the-owner", 30)).toBe(false);

    await pool.query("UPDATE system_archive_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [queued.id]);
    expect(await repository.heartbeat(queued.id, claimed!.leaseOwner, 30)).toBe(false);
    await expect(repository.claimNext("system-archive-worker-c", 30)).resolves.toMatchObject({
      id: queued.id,
      leaseOwner: "system-archive-worker-c"
    });
  });

  it("keeps cancellation owner-scoped and preserves terminal cancellation state", async () => {
    const repository = createPostgresSystemArchiveJobRepository(pool);
    await pool.query("UPDATE system_archive_jobs SET status='failed',lease_owner=NULL,lease_expires_at=NULL WHERE status IN ('queued','capturing','revalidating','cancelling')");
    const queued = await repository.enqueueExport(owner, hash(`cancel-${randomUUID()}`));

    await expect(repository.requestCancellation(foreignOwner, queued.id))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(repository.requestCancellation(owner, queued.id))
      .resolves.toMatchObject({ id: queued.id, status: "cancelling" });
  });

  it("lets a finalized durable publication win cancellation requested during publish", async () => {
    const leaseOwner = "system-archive-publish-race";
    const operationId = await reservePortableOperation(owner, "portable_export");
    const artifact = await pool.query<{ id: string }>(
      `INSERT INTO portable_export_artifacts (
         owner_user_id,retrieval_token_hash,filesystem_operation_id,export_kind,
         campaign_id,world_id,world_version_id,content_type,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,'system_zip',NULL,NULL,NULL,'application/zip',$4,4,now()+interval '1 day')
       RETURNING id`,
      [owner.ownerUserId, hash(randomUUID()), operationId, hash("published-system-archive")]
    );
    const exportJob = await pool.query<{ id: string }>(
      `INSERT INTO system_archive_jobs (
         owner_user_id,kind,status,idempotency_key_hash,lease_owner,lease_expires_at
       ) VALUES ($1,'export','verifying',$2,$3,now()+interval '1 minute') RETURNING id`,
      [owner.ownerUserId, hash(randomUUID()), leaseOwner]
    );
    await pool.query(
      "UPDATE system_archive_jobs SET status='cancelling' WHERE id=$1",
      [exportJob.rows[0]!.id]
    );
    const domainCounts = Object.fromEntries(
      SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0])
    ) as Record<SystemArchiveDomain, number>;

    await createPostgresSystemArchiveExportJobPort(pool).markPublished({
      id: exportJob.rows[0]!.id,
      ownerUserId: owner.ownerUserId,
      leaseOwner,
    }, {
      artifactId: artifact.rows[0]!.id,
      relativePath: "exports/finalized.pending",
      byteLength: 4,
      sha256: hash("published-system-archive"),
      contentFingerprint: hash("system-content"),
    }, {
      completedAt: new Date().toISOString(),
      contentFingerprint: hash("system-content"),
      domainCounts,
      originalAssets: 0,
      originalBytes: 0,
      excludedOperationalWork: {},
    });

    await expect(pool.query<{ status: string; export_artifact_id: string }>(
      "SELECT status,export_artifact_id FROM system_archive_jobs WHERE id=$1",
      [exportJob.rows[0]!.id]
    )).resolves.toMatchObject({
      rows: [{ status: "published", export_artifact_id: artifact.rows[0]!.id }]
    });
    await expect(pool.query(
      "SELECT id FROM portable_export_artifacts WHERE id=$1",
      [artifact.rows[0]!.id]
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("records chunks idempotently while rejecting conflicts, overlaps, and foreign owners", async () => {
    const uploads = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 86_400 });
    const filesystemOperationId = await reservePortableOperation(owner, "portable_staging");
    const upload = await uploads.createUpload(owner, {
      handleTokenHash: hash(`upload-${randomUUID()}`),
      filesystemOperationId,
      byteLength: 12,
      sha256: hash("abcdefghijkl")
    });

    const first = await uploads.recordChunk(owner, {
      uploadId: upload.id,
      index: 0,
      offset: 0,
      bytes: 4,
      sha256: hash("abcd")
    });
    expect(first).toMatchObject({ status: "uploading", receivedBytes: 4 });
    await expect(uploads.recordChunk(owner, {
      uploadId: upload.id,
      index: 0,
      offset: 0,
      bytes: 4,
      sha256: hash("abcd")
    })).resolves.toMatchObject({ receivedBytes: 4 });
    await expect(uploads.recordChunk(owner, {
      uploadId: upload.id,
      index: 0,
      offset: 0,
      bytes: 4,
      sha256: hash("different")
    })).rejects.toMatchObject({ statusCode: 409 });
    await expect(uploads.recordChunk(owner, {
      uploadId: upload.id,
      index: 1,
      offset: 2,
      bytes: 4,
      sha256: hash("cdef")
    })).rejects.toMatchObject({ statusCode: 409 });
    await expect(uploads.recordChunk(foreignOwner, {
      uploadId: upload.id,
      index: 1,
      offset: 4,
      bytes: 4,
      sha256: hash("efgh")
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("persists an upload expiry before returning the safe expiry error", async () => {
    const uploads = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 86_400 });
    const filesystemOperationId = await reservePortableOperation(owner, "portable_staging");
    const upload = await uploads.createUpload(owner, {
      handleTokenHash: hash(`expired-upload-${randomUUID()}`),
      filesystemOperationId,
      byteLength: 4,
      sha256: hash("abcd")
    });
    await pool.query(
      "UPDATE system_archive_uploads SET expires_at=now()-interval '1 second' WHERE id=$1",
      [upload.id]
    );

    await expect(uploads.recordChunk(owner, {
      uploadId: upload.id,
      index: 0,
      offset: 0,
      bytes: 4,
      sha256: hash("abcd")
    })).rejects.toMatchObject({ statusCode: 410 });
    await expect(uploads.getUpload(owner, upload.id)).resolves.toMatchObject({ status: "expired" });
  });

  it("rejects chunk indexes outside the PostgreSQL integer range before persistence", async () => {
    const uploads = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 86_400 });
    const filesystemOperationId = await reservePortableOperation(owner, "portable_staging");
    const upload = await uploads.createUpload(owner, {
      handleTokenHash: hash(`chunk-index-upload-${randomUUID()}`),
      filesystemOperationId,
      byteLength: 4,
      sha256: hash("abcd")
    });

    await expect(uploads.recordChunk(owner, {
      uploadId: upload.id,
      index: 2_147_483_648,
      offset: 0,
      bytes: 4,
      sha256: hash("abcd")
    })).rejects.toMatchObject({
      statusCode: 400,
      message: "System Archive chunk index must be a PostgreSQL integer between 0 and 2147483647."
    });
  });

  it("accepts System ZIP artifacts only with null campaign/world/version scope and preserves existing kinds", async () => {
    const operationId = await reservePortableOperation(owner, "portable_export");
    await expect(pool.query(
      `INSERT INTO portable_export_artifacts (
         owner_user_id,retrieval_token_hash,filesystem_operation_id,export_kind,
         campaign_id,world_id,world_version_id,content_type,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,'system_zip',NULL,NULL,NULL,'application/zip',$4,4,now()+interval '1 day')`,
      [owner.ownerUserId, hash(randomUUID()), operationId, hash("system-zip")]
    )).resolves.toMatchObject({ rowCount: 1 });

    const invalidOperationId = await reservePortableOperation(owner, "portable_export");
    await expect(pool.query(
      `INSERT INTO portable_export_artifacts (
         owner_user_id,retrieval_token_hash,filesystem_operation_id,export_kind,
         campaign_id,world_id,world_version_id,content_type,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,'system_zip',NULL,NULL,NULL,'application/json',$4,4,now()+interval '1 day')`,
      [owner.ownerUserId, hash(randomUUID()), invalidOperationId, hash("not-a-system-zip")]
    )).rejects.toMatchObject({ constraint: "portable_export_scope_check" });

    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [owner.ownerUserId, `System archive world ${randomUUID()}`]
    );
    const version = await pool.query<{ id: string }>(
      "INSERT INTO world_versions (world_id,owner_user_id,version_number,content) VALUES ($1,$2,1,'{}'::jsonb) RETURNING id",
      [world.rows[0]!.id, owner.ownerUserId]
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,$3) RETURNING id",
      [owner.ownerUserId, version.rows[0]!.id, `System archive campaign ${randomUUID()}`]
    );
    const campaignOperationId = await reservePortableOperation(owner, "portable_export");
    await expect(pool.query(
      `INSERT INTO portable_export_artifacts (
         owner_user_id,retrieval_token_hash,filesystem_operation_id,export_kind,
         campaign_id,world_id,world_version_id,content_type,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,'campaign_zip',$4,$5,$6,'application/zip',$7,4,now()+interval '1 day')`,
      [owner.ownerUserId, hash(randomUUID()), campaignOperationId, campaign.rows[0]!.id,
        world.rows[0]!.id, version.rows[0]!.id, hash("campaign-zip")]
    )).resolves.toMatchObject({ rowCount: 1 });

    const invalidSystemScopeOperationId = await reservePortableOperation(owner, "portable_export");
    await expect(pool.query(
      `INSERT INTO portable_export_artifacts (
         owner_user_id,retrieval_token_hash,filesystem_operation_id,export_kind,
         campaign_id,world_id,world_version_id,content_type,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,'system_zip',NULL,$4,$5,'application/zip',$6,4,now()+interval '1 day')`,
      [owner.ownerUserId, hash(randomUUID()), invalidSystemScopeOperationId,
        world.rows[0]!.id, version.rows[0]!.id, hash("scoped-system-zip")]
    )).rejects.toMatchObject({ constraint: "portable_export_scope_check" });

    const worldOperationId = await reservePortableOperation(owner, "portable_export");
    await expect(pool.query(
      `INSERT INTO portable_export_artifacts (
         owner_user_id,retrieval_token_hash,filesystem_operation_id,export_kind,
         campaign_id,world_id,world_version_id,content_type,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,'world_json',NULL,$4,$5,'application/json',$6,4,now()+interval '1 day')`,
      [owner.ownerUserId, hash(randomUUID()), worldOperationId,
        world.rows[0]!.id, version.rows[0]!.id, hash("world-json")]
    )).resolves.toMatchObject({ rowCount: 1 });
  });
});
