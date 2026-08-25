import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_ARCHIVE_DOMAINS, type SystemArchiveDomain } from "@infinite-quest/contracts";
import type { OwnerScope } from "../../packages/application/src/generation/types.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresSystemArchiveJobRepository } from "../../packages/database/src/system-archive-job-repository.js";
import { createPostgresSystemArchiveExportJobPort } from "../../packages/database/src/system-archive-export-repository.js";
import { createPostgresSystemArchiveImportRepository } from "../../packages/database/src/system-archive-import-repository.js";
import { createPostgresSystemArchivePrivateStorageRepository } from "../../packages/database/src/system-archive-private-storage-repository.js";
import { createPostgresSystemArchiveUploadRepository } from "../../packages/database/src/system-archive-upload-repository.js";
import {
  createSystemArchiveImportComposition,
  createSystemArchiveUploadService,
  type SystemArchiveUploadStoragePort,
} from "../../services/runtime/src/system-archive-composition.js";
import { createAssetImportStorageComposition } from "../../services/runtime/src/asset-import-composition.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function emptySystemArchive(ownerUserId: string): Promise<Buffer> {
  const system = Buffer.from(JSON.stringify({
    formatVersion: 1,
    sourceInstallationId: ownerUserId,
    sourceOwnerCount: 1,
    sourceOwner: { sourceId: ownerUserId, displayName: "Initial owner" },
    records: [],
  }), "utf8");
  const assets = Buffer.from(JSON.stringify({ formatVersion: 1, assets: [] }), "utf8");
  const entries = [
    {
      path: "system.json",
      logicalType: "system",
      mediaType: "application/json",
      byteLength: system.byteLength,
      sha256: hash(system),
    },
    {
      path: "assets/assets.json",
      logicalType: "assets",
      mediaType: "application/json",
      byteLength: assets.byteLength,
      sha256: hash(assets),
    },
  ];
  const contentFingerprint = hash(JSON.stringify({
    originalAssetHashes: [],
    payloadHashes: entries.map((entry) => entry.sha256).sort(),
  }));
  const manifest = {
    format: "infinite-quest-archive",
    formatVersion: 1,
    archiveType: "system",
    createdAt: "2026-08-25T12:00:00.000Z",
    contentFingerprint,
    sourceApplication: "0.1.0",
    sourceMigration: "0079_resumable_system_archive_uploads",
    sourceInstallationId: ownerUserId,
    sourceOwnerCount: 1,
    sourceOwner: { sourceId: ownerUserId, displayName: "Initial owner" },
    entries,
    payloads: [
      { kind: "system", path: "system.json", formatVersion: 1 },
      { kind: "assets", path: "assets/assets.json", formatVersion: 1 },
    ],
    assets: [],
  };
  const zip = new JSZip();
  zip.file("system.json", system);
  zip.file("assets/assets.json", assets);
  zip.file("manifest.json", JSON.stringify(manifest));
  return zip.generateAsync({ type: "nodebuffer" });
}

function safePreviewProjection(ownerUserId: string, archiveFingerprint: string) {
  return {
    versions: {
      archiveFormat: 1 as const,
      sourceApplication: "0.1.0",
      sourceMigration: "0079_resumable_system_archive_uploads",
      destinationApplication: "0.1.0",
      destinationMigration: "0079_resumable_system_archive_uploads"
    },
    sourceOwnerCount: 1 as const,
    archiveFingerprint,
    recordsByDomain: Object.fromEntries(SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0])),
    assets: { originalCount: 0, totalBytes: 0 },
    destinationEmpty: true,
    ownerMapping: { sourceOwnerId: ownerUserId, destinationOwnerId: ownerUserId },
    disabledProviders: 0,
    invalidatedAccess: ["share-links", "sessions", "oidc-identities", "external-authorizations"] as const,
    normalization: ["map-source-owner-to-initial-owner", "disable-provider-profiles"],
    rebuilds: ["chronicle-index", "asset-thumbnails"] as const,
    space: {
      staging: { requiredBytes: 0, availableBytes: 0, verified: true, sufficient: true, overrideUsed: false },
      assetRoot: { requiredBytes: 0, availableBytes: 0, verified: true, sufficient: true, overrideUsed: false }
    },
    warnings: [],
    errors: []
  };
}

integration("durable System Archive jobs and resumable uploads", () => {
  let pool: DatabasePool;
  let owner: OwnerScope;
  let foreignOwner: OwnerScope | undefined;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    owner = { ownerUserId: await initialOwnerId(pool) };
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

  async function foreign(): Promise<OwnerScope> {
    if (foreignOwner) return foreignOwner;
    const created = await pool.query<{ id: string }>(
      "INSERT INTO users (system_key,display_name) VALUES ($1,$2) RETURNING id",
      [`system-archive-foreign-${randomUUID()}`, "System Archive foreign owner"]
    );
    foreignOwner = { ownerUserId: created.rows[0]!.id };
    return foreignOwner;
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

  it("binds an opaque 30-minute preview to the completed upload and exact destination fingerprint", async () => {
    expect(() => createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_799 }))
      .toThrow("system_archive_preview_ttl_invalid");
    const uploads = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 86_400 });
    const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
    const filesystemOperationId = await reservePortableOperation(owner, "portable_staging");
    const upload = await uploads.createUpload(owner, {
      handleTokenHash: hash(randomUUID()),
      filesystemOperationId,
      byteLength: 4,
      sha256: hash("abcd")
    });
    await uploads.recordChunk(owner, {
      uploadId: upload.id,
      index: 0,
      offset: 0,
      bytes: 4,
      sha256: hash("abcd")
    });
    const staged = await pool.query<{ id: string }>(
      `INSERT INTO portable_staged_inputs (
         owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,$4,4,now()+interval '1 day') RETURNING id`,
      [owner.ownerUserId, hash(randomUUID()), filesystemOperationId, hash("abcd")]
    );
    await uploads.completeUpload(owner, { uploadId: upload.id, stagedInputId: staged.rows[0]!.id });

    const destination = await imports.destinationFingerprint(owner, { ignoreUploadId: upload.id });
    expect(destination.destinationEmpty).toBe(true);
    const archiveFingerprint = hash("validated-system-archive");
    const projection = safePreviewProjection(owner.ownerUserId, archiveFingerprint);
    await expect(imports.createPreview(owner, {
      uploadId: upload.id,
      archiveFingerprint,
      destination,
      projection: { ...projection, localPath: "C:/private/system.zip" }
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(imports.createPreview(owner, {
      uploadId: upload.id,
      archiveFingerprint,
      destination,
      projection: { ...projection, archiveFingerprint: hash("different-archive") }
    })).rejects.toMatchObject({ statusCode: 400 });
    const before = Date.now();
    const authority = await imports.createPreview(owner, {
      uploadId: upload.id,
      archiveFingerprint,
      destination,
      projection
    });
    const lifetime = new Date(authority.expiresAt).getTime() - before;
    expect(lifetime).toBeGreaterThanOrEqual(1_795_000);
    expect(lifetime).toBeLessThanOrEqual(1_805_000);
    expect(authority.previewHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const persisted = await pool.query<{
      idempotency_key_hash: string;
      progress: unknown;
      report: unknown;
    }>("SELECT idempotency_key_hash,progress,report FROM system_archive_jobs WHERE id=$1", [authority.jobId]);
    expect(persisted.rows[0]!.idempotency_key_hash).toBe(hash(authority.previewHandle));
    expect(JSON.stringify(persisted.rows[0])).not.toContain(authority.previewHandle);
    expect(JSON.stringify(persisted.rows[0])).not.toMatch(/[A-Za-z]:[\\/]|\/tmp\//u);
    await expect(imports.destinationFingerprint(owner, {
      ignoreJobId: authority.jobId,
      ignoreUploadId: upload.id
    }))
      .resolves.toMatchObject({
        destinationEmpty: true,
        authoritativeCountsHash: destination.authoritativeCountsHash,
        activeJobsHash: destination.activeJobsHash
      });
    await expect(imports.destinationFingerprint(owner, {}))
      .resolves.toMatchObject({ destinationEmpty: false });

    await pool.query(
      `UPDATE system_archive_jobs
          SET progress=jsonb_set(progress,'{expiresAt}',to_jsonb((now()-interval '1 second')::text))
        WHERE id=$1`,
      [authority.jobId]
    );
    const afterExpiry = await imports.destinationFingerprint(owner, { ignoreUploadId: upload.id });
    expect(afterExpiry.destinationEmpty).toBe(true);
    const replacement = await imports.createPreview(owner, {
      uploadId: upload.id,
      archiveFingerprint,
      destination: afterExpiry,
      projection
    });
    expect(replacement.jobId).not.toBe(authority.jobId);
    await expect(pool.query<{ status: string }>(
      "SELECT status FROM system_archive_jobs WHERE id=$1",
      [authority.jobId]
    )).resolves.toMatchObject({ rows: [{ status: "expired" }] });
  });

  it("fingerprints an exactly empty destination and rejects unrelated owner or active-upload state", async () => {
    const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
    const clean = await imports.destinationFingerprint(owner, {});
    expect(clean).toMatchObject({
      initialOwnerId: owner.ownerUserId,
      latestMigration: "0079_resumable_system_archive_uploads",
      destinationEmpty: true
    });

    const expiredStagedInputId = await createStagedInput(owner);
    const expiredPortablePreview = await pool.query<{ id: string }>(
      `INSERT INTO portable_import_operations (
         owner_user_id,staged_input_id,import_kind,preview_token_hash,content_fingerprint,
         destination_fingerprint,destination_kind,preview_projection,expires_at
       ) VALUES ($1,$2,'world_text',$3,$4,$5,'create_world','{}'::jsonb,now()-interval '1 second')
       RETURNING id`,
      [owner.ownerUserId, expiredStagedInputId, hash(randomUUID()), hash("expired-portable-preview"), hash("empty")]
    );
    await expect(imports.destinationFingerprint(owner, {})).resolves.toMatchObject({
      destinationEmpty: true,
      activeJobsHash: clean.activeJobsHash
    });
    await pool.query(
      "UPDATE portable_import_operations SET expires_at=now()+interval '5 minutes' WHERE id=$1",
      [expiredPortablePreview.rows[0]!.id]
    );
    await expect(imports.destinationFingerprint(owner, {}))
      .resolves.toMatchObject({ destinationEmpty: false });
    await pool.query("DELETE FROM portable_import_operations WHERE id=$1", [expiredPortablePreview.rows[0]!.id]);

    const currentOperation = await reservePortableOperation(owner, "portable_staging");
    const uploads = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 86_400 });
    const current = await uploads.createUpload(owner, {
      handleTokenHash: hash(`current-upload-${randomUUID()}`),
      filesystemOperationId: currentOperation,
      byteLength: 4,
      sha256: hash("abcd")
    });
    await expect(imports.destinationFingerprint(owner, { ignoreUploadId: current.id }))
      .resolves.toMatchObject({
        destinationEmpty: true,
        authoritativeCountsHash: clean.authoritativeCountsHash,
        activeJobsHash: clean.activeJobsHash
      });

    const unrelatedOperation = await reservePortableOperation(owner, "portable_staging");
    await uploads.createUpload(owner, {
      handleTokenHash: hash(`unrelated-upload-${randomUUID()}`),
      filesystemOperationId: unrelatedOperation,
      byteLength: 4,
      sha256: hash("efgh")
    });
    await expect(imports.destinationFingerprint(owner, { ignoreUploadId: current.id }))
      .resolves.toMatchObject({ destinationEmpty: false });

    await pool.query("DELETE FROM system_archive_uploads");
    await pool.query(
      `INSERT INTO world_generation_progress (
         progress_key,owner_user_id,status,phase,expires_at
       ) VALUES ($1,$2,'processing','drafting',now()+interval '5 minutes')`,
      [`system-archive-active-${randomUUID()}`, owner.ownerUserId]
    );
    const activeWork = await imports.destinationFingerprint(owner, {});
    expect(activeWork.destinationEmpty).toBe(false);
    expect(activeWork.activeJobsHash).not.toBe(clean.activeJobsHash);
    await pool.query("DELETE FROM world_generation_progress WHERE owner_user_id=$1", [owner.ownerUserId]);

  });

  it("counts every unexpired competing completed upload while ignoring only the current upload", async () => {
    const uploads = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 86_400 });
    const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
    const complete = async (content: string) => {
      const filesystemOperationId = await reservePortableOperation(owner, "portable_staging");
      const upload = await uploads.createUpload(owner, {
        handleTokenHash: hash(`completed-${content}-${randomUUID()}`),
        filesystemOperationId,
        byteLength: content.length,
        sha256: hash(content)
      });
      await uploads.recordChunk(owner, {
        uploadId: upload.id,
        index: 0,
        offset: 0,
        bytes: content.length,
        sha256: hash(content)
      });
      const staged = await pool.query<{ id: string }>(
        `INSERT INTO portable_staged_inputs (
           owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
         ) VALUES ($1,$2,$3,$4,$5,now()+interval '1 day') RETURNING id`,
        [owner.ownerUserId, hash(randomUUID()), filesystemOperationId, hash(content), content.length]
      );
      await uploads.completeUpload(owner, { uploadId: upload.id, stagedInputId: staged.rows[0]!.id });
      return upload.id;
    };
    const currentUploadId = await complete("abcd");
    const competingUploadId = await complete("efgh");

    await expect(imports.destinationFingerprint(owner, { ignoreUploadId: currentUploadId }))
      .resolves.toMatchObject({ destinationEmpty: false });
    await pool.query(
      "UPDATE system_archive_uploads SET expires_at=now()-interval '1 second' WHERE id=$1",
      [competingUploadId]
    );
    await expect(imports.destinationFingerprint(owner, { ignoreUploadId: currentUploadId }))
      .resolves.toMatchObject({ destinationEmpty: true });
  });

  it.each([
    ["upload expiry", "upload"],
    ["staged-input expiry", "staged-expiry"],
    ["staged-input status", "staged-status"],
  ] as const)("refuses preview issuance after %s invalidates completed staging", async (_label, invalidation) => {
    const uploads = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 86_400 });
    const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
    const filesystemOperationId = await reservePortableOperation(owner, "portable_staging");
    const upload = await uploads.createUpload(owner, {
      handleTokenHash: hash(`expiry-preview-${randomUUID()}`),
      filesystemOperationId,
      byteLength: 4,
      sha256: hash("abcd")
    });
    await uploads.recordChunk(owner, {
      uploadId: upload.id,
      index: 0,
      offset: 0,
      bytes: 4,
      sha256: hash("abcd")
    });
    const staged = await pool.query<{ id: string }>(
      `INSERT INTO portable_staged_inputs (
         owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,$4,4,now()+$5::interval) RETURNING id`,
      [
        owner.ownerUserId,
        hash(randomUUID()),
        filesystemOperationId,
        hash("abcd"),
        invalidation === "staged-expiry" ? "200 milliseconds" : "1 day"
      ]
    );
    await uploads.completeUpload(owner, { uploadId: upload.id, stagedInputId: staged.rows[0]!.id });
    const destination = await imports.destinationFingerprint(owner, { ignoreUploadId: upload.id });
    if (invalidation === "upload") {
      await pool.query(
        "UPDATE system_archive_uploads SET expires_at=now()-interval '1 second' WHERE id=$1",
        [upload.id]
      );
    } else if (invalidation === "staged-expiry") {
      await pool.query("SELECT pg_sleep(0.25)");
    } else {
      await pool.query(
        "UPDATE portable_staged_inputs SET status='expired' WHERE id=$1",
        [staged.rows[0]!.id]
      );
    }

    await expect(imports.createPreview(owner, {
      uploadId: upload.id,
      archiveFingerprint: hash("expiry-preview-archive"),
      destination,
      projection: safePreviewProjection(owner.ownerUserId, hash("expiry-preview-archive"))
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(pool.query(
      "SELECT id FROM system_archive_jobs WHERE kind='import' AND status='previewed'"
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("rehydrates identity-bound private authority and fences a live foreign lease", async () => {
    const uploads = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 86_400 });
    const storage = createPostgresSystemArchivePrivateStorageRepository(pool);
    const filesystemOperationId = await reservePortableOperation(owner, "portable_staging");
    const upload = await uploads.createUpload(owner, {
      handleTokenHash: hash(`private-storage-${randomUUID()}`),
      filesystemOperationId,
      byteLength: 4,
      sha256: hash("abcd")
    });
    const relativePath = `staging/${filesystemOperationId}.pending`;
    await pool.query(
      `INSERT INTO durable_filesystem_prewrite_nodes (
         operation_id,owner_user_id,purpose,relative_path,authority_state
       ) VALUES ($1,$2,'portable_staging',$3,'target_only')`,
      [filesystemOperationId, owner.ownerUserId, relativePath]
    );
    await pool.query(
      `UPDATE durable_filesystem_prewrite_nodes
          SET authority_state='identity_bound',device_id='device-1',file_id='file-1',
              identity_bound_at=clock_timestamp()
        WHERE operation_id=$1 AND authority_state='target_only'`,
      [filesystemOperationId]
    );

    await expect(storage.withUploadLock({
      ownerUserId: owner.ownerUserId,
      uploadId: upload.id,
      filesystemOperationId,
      leaseOwner: "system-archive-test",
      leaseSeconds: 30
    }, async (authority) => authority)).resolves.toMatchObject({
      state: "assembling",
      relativePath,
      identity: { deviceId: "device-1", fileId: "file-1" },
      claim: { leaseOwner: "system-archive-test" }
    });

    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_owner='other-worker',lease_expires_at=clock_timestamp()+interval '5 minutes'
        WHERE id=$1`,
      [filesystemOperationId]
    );
    await expect(storage.withUploadLock({
      ownerUserId: owner.ownerUserId,
      uploadId: upload.id,
      filesystemOperationId,
      leaseOwner: "system-archive-test",
      leaseSeconds: 30
    }, async (authority) => authority)).rejects.toMatchObject({ statusCode: 409 });
    await expect(pool.query<{ lease_owner: string }>(
      "SELECT lease_owner FROM durable_filesystem_operations WHERE id=$1",
      [filesystemOperationId]
    )).resolves.toMatchObject({ rows: [{ lease_owner: "other-worker" }] });

    await pool.query(
      "UPDATE durable_filesystem_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [filesystemOperationId]
    );
    await expect(storage.withUploadLock({
      ownerUserId: owner.ownerUserId,
      uploadId: upload.id,
      filesystemOperationId,
      leaseOwner: "system-archive-test",
      leaseSeconds: 30
    }, async (authority) => authority)).resolves.toMatchObject({
      state: "assembling",
      claim: { leaseOwner: "system-archive-test" }
    });
    await expect(storage.withUploadLock({
      ownerUserId: owner.ownerUserId,
      uploadId: upload.id,
      filesystemOperationId,
      leaseOwner: "system-archive-test",
      leaseSeconds: 301
    }, async (authority) => authority)).rejects.toThrow("system_archive_storage_lease_invalid");
  });

  it.skipIf(process.platform !== "linux")(
    "recovers the production private upload across adapter recreation and previews without mutation",
    verifyProductionPrivateUploadRecovery,
  );

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
    const scopedForeign = await foreign();
    await expect(repository.enqueueExport(scopedForeign, hash(`foreign-${randomUUID()}`)))
      .resolves.toMatchObject({ kind: "export", status: "queued" });
    const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
    const populated = await imports.destinationFingerprint(owner, {});
    expect(populated.destinationEmpty).toBe(false);
    expect(populated).not.toHaveProperty("path");
  });

  it("allows only one active import globally and enforces staged-input ownership", async () => {
    const repository = createPostgresSystemArchiveJobRepository(pool);
    const ownerStaged = await createStagedInput(owner);
    const scopedForeign = await foreign();
    const foreignStaged = await createStagedInput(scopedForeign);

    await expect(repository.enqueueImport(owner, ownerStaged, hash(`import-${randomUUID()}`)))
      .resolves.toMatchObject({ kind: "import", status: "queued" });
    await expect(repository.enqueueImport(scopedForeign, foreignStaged, hash(`foreign-import-${randomUUID()}`)))
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

    await expect(repository.requestCancellation(await foreign(), queued.id))
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
    await expect(uploads.recordChunk(await foreign(), {
      uploadId: upload.id,
      index: 1,
      offset: 4,
      bytes: 4,
      sha256: hash("efgh")
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("publishes bounded chunks privately and completes after a process recreation", async () => {
    const chunks = new Map<string, Map<number, Readonly<{ offset: number; bytes: Buffer; sha256: string }>>>();
    const stagedByOperation = new Map<string, string>();
    const createStorage = (): SystemArchiveUploadStoragePort => ({
      async prepare(input) {
        const filesystemOperationId = await reservePortableOperation(
          { ownerUserId: input.ownerUserId },
          "portable_staging"
        );
        chunks.set(filesystemOperationId, new Map());
        return {
          filesystemOperationId,
          async rollback() {
            chunks.delete(filesystemOperationId);
          }
        };
      },
      async publishChunk(input, persist) {
        const operation = chunks.get(input.assemblyOperationId);
        if (!operation) throw new Error("private_upload_operation_unavailable");
        const existing = operation.get(input.index);
        if (existing && (existing.offset !== input.offset
          || existing.sha256 !== input.sha256
          || !existing.bytes.equals(Buffer.from(input.bytes)))) {
          throw Object.assign(new Error("private_upload_chunk_conflict"), { statusCode: 409 });
        }
        const created = !existing;
        if (created) operation.set(input.index, {
          offset: input.offset,
          bytes: Buffer.from(input.bytes),
          sha256: input.sha256
        });
        try {
          return await persist();
        } catch (error) {
          if (created) operation.delete(input.index);
          throw error;
        }
      },
      async assemble(input) {
        const operation = chunks.get(input.assembly.filesystemOperationId);
        if (!operation) throw new Error("private_upload_operation_unavailable");
        const bytes = Buffer.concat(input.assembly.chunks.map((chunk) => {
          const stored = operation.get(chunk.index);
          if (!stored || stored.offset !== chunk.offset || stored.bytes.byteLength !== chunk.bytes
            || stored.sha256 !== chunk.sha256) {
            throw new Error("private_upload_chunk_identity_changed");
          }
          return stored.bytes;
        }));
        const sha256 = hash(bytes.toString("utf8"));
        let stagedInputId = stagedByOperation.get(input.assembly.filesystemOperationId);
        let created = false;
        if (!stagedInputId) {
          const inserted = await pool.query<{ id: string }>(
            `INSERT INTO portable_staged_inputs (
               owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
             ) VALUES ($1,$2,$3,$4,$5,now()+interval '1 day') RETURNING id`,
            [input.ownerUserId, hash(randomUUID()), input.assembly.filesystemOperationId,
              sha256, bytes.byteLength]
          );
          stagedInputId = inserted.rows[0]!.id;
          stagedByOperation.set(input.assembly.filesystemOperationId, stagedInputId);
          created = true;
        }
        return {
          stagedInputId,
          byteLength: bytes.byteLength,
          sha256,
          async rollback() {
            if (!created) return;
            await pool.query("DELETE FROM portable_staged_inputs WHERE id=$1", [stagedInputId]);
            stagedByOperation.delete(input.assembly.filesystemOperationId);
          }
        };
      }
    });
    const repository = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 86_400 });
    const firstProcess = createSystemArchiveUploadService({
      uploads: repository,
      storage: createStorage(),
      chunkBytes: 4,
      maximumBytes: 12
    });
    const archiveBytes = Buffer.from("abcdefghijkl");
    await expect(firstProcess.createUpload(owner, {
      byteLength: 13,
      sha256: hash("oversized-system-archive")
    })).rejects.toMatchObject({ statusCode: 400 });
    const upload = await firstProcess.createUpload(owner, {
      byteLength: archiveBytes.byteLength,
      sha256: hash(archiveBytes.toString("utf8"))
    });

    await firstProcess.putChunk(owner, {
      uploadId: upload.id,
      index: 0,
      offset: 0,
      bytes: Buffer.from("abcd"),
      sha256: hash("abcd")
    });
    await expect(firstProcess.putChunk(owner, {
      uploadId: upload.id,
      index: 1,
      offset: 4,
      bytes: Buffer.from("efghx"),
      sha256: hash("efghx")
    })).rejects.toMatchObject({ statusCode: 413 });
    await expect(firstProcess.completeUpload(owner, upload.id)).rejects.toMatchObject({ statusCode: 409 });

    const secondProcess = createSystemArchiveUploadService({
      uploads: createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 86_400 }),
      storage: createStorage(),
      chunkBytes: 4,
      maximumBytes: 12
    });
    await secondProcess.putChunk(owner, {
      uploadId: upload.id,
      index: 1,
      offset: 4,
      bytes: Buffer.from("efgh"),
      sha256: hash("efgh")
    });
    await secondProcess.putChunk(owner, {
      uploadId: upload.id,
      index: 2,
      offset: 8,
      bytes: Buffer.from("ijkl"),
      sha256: hash("ijkl")
    });
    await expect(secondProcess.putChunk(owner, {
      uploadId: upload.id,
      index: 2,
      offset: 8,
      bytes: Buffer.from("ijkl"),
      sha256: hash("ijkl")
    })).resolves.toMatchObject({ receivedBytes: 12 });
    await expect(secondProcess.completeUpload(owner, upload.id)).resolves.toMatchObject({
      id: upload.id,
      status: "completed",
      receivedBytes: 12
    });
  });

  async function verifyProductionPrivateUploadRecovery(): Promise<void> {
      const root = await mkdtemp(join(tmpdir(), "infinitequest-system-upload-production-"));
      const archiveRoot = join(root, "archive");
      const assetRoot = join(root, "assets");
      await mkdir(archiveRoot, { recursive: true });
      await mkdir(assetRoot, { recursive: true });
      const archive = await emptySystemArchive(owner.ownerUserId);
      const compositionOptions = {
        pool,
        archiveRoot,
        capacity: { availableBytes: async () => ({ staging: 10_000_000, assetRoot: 10_000_000 }) },
        limits: {
          maxCompressedBytes: 10_000_000,
          maxUncompressedBytes: 20_000_000,
          maxEntries: 100,
          maxManifestBytes: 1_000_000,
          maxJsonEntryBytes: 2_000_000,
          maxExpansionRatio: 100,
          maxOriginalImageBytes: 2_000_000,
        },
        destinationApplicationVersion: "0.1.0",
        uploadTtlSeconds: 3_600,
        previewTtlSeconds: 1_800,
        chunkBytes: archive.byteLength,
        maximumUploadBytes: 10_000_000,
        leaseOwner: "system-archive-production-restart-test",
        leaseSeconds: 300,
        allowUnknownFreeSpace: false,
      } as const;
      let firstStorage: Awaited<ReturnType<typeof createAssetImportStorageComposition>> | undefined;
      let secondStorage: Awaited<ReturnType<typeof createAssetImportStorageComposition>> | undefined;
      try {
        firstStorage = await createAssetImportStorageComposition(pool, { archiveRoot, assetRoot });
        const first = createSystemArchiveImportComposition({
          ...compositionOptions,
          storage: firstStorage.adapter,
        });
        const upload = await first.uploads.createUpload(owner, {
          byteLength: archive.byteLength,
          sha256: hash(archive),
        });
        await first.uploads.putChunk(owner, {
          uploadId: upload.id,
          index: 0,
          offset: 0,
          bytes: archive,
          sha256: hash(archive),
        });
        await firstStorage.close();
        firstStorage = undefined;

        secondStorage = await createAssetImportStorageComposition(pool, { archiveRoot, assetRoot });
        const second = createSystemArchiveImportComposition({
          ...compositionOptions,
          storage: secondStorage.adapter,
        });
        await expect(second.uploads.completeUpload(owner, upload.id)).resolves.toMatchObject({
          id: upload.id,
          status: "completed",
          receivedBytes: archive.byteLength,
        });
        await expect(second.previews.preview(owner, upload.id)).resolves.toMatchObject({
          valid: true,
          previewHandle: expect.any(String),
          archiveFingerprint: expect.any(String),
          recordsByDomain: Object.fromEntries(SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0])),
        });
        await expect(pool.query(
          "SELECT count(*)::int AS count FROM worlds WHERE owner_user_id=$1",
          [owner.ownerUserId],
        )).resolves.toMatchObject({ rows: [{ count: 0 }] });
      } finally {
        await firstStorage?.close().catch(() => undefined);
        await secondStorage?.close().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
  }

  it("refuses incomplete assembly and completes only against the exact durable staged input", async () => {
    const uploads = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 86_400 });
    const filesystemOperationId = await reservePortableOperation(owner, "portable_staging");
    const uploadBytes = Buffer.from("abcdefghijkl");
    const upload = await uploads.createUpload(owner, {
      handleTokenHash: hash(`assembly-upload-${randomUUID()}`),
      filesystemOperationId,
      byteLength: uploadBytes.byteLength,
      sha256: hash(uploadBytes.toString("utf8"))
    });
    await uploads.recordChunk(owner, {
      uploadId: upload.id,
      index: 0,
      offset: 0,
      bytes: 4,
      sha256: hash("abcd")
    });
    await uploads.recordChunk(owner, {
      uploadId: upload.id,
      index: 2,
      offset: 8,
      bytes: 4,
      sha256: hash("ijkl")
    });

    await expect(uploads.getAssembly(owner, upload.id)).rejects.toMatchObject({
      statusCode: 409,
      message: "System Archive upload is missing a contiguous chunk range."
    });

    await uploads.recordChunk(owner, {
      uploadId: upload.id,
      index: 1,
      offset: 4,
      bytes: 4,
      sha256: hash("efgh")
    });
    const assembly = await uploads.getAssembly(owner, upload.id);
    expect(assembly).toMatchObject({
      uploadId: upload.id,
      filesystemOperationId,
      byteLength: 12,
      sha256: hash("abcdefghijkl"),
      chunks: [
        { index: 0, offset: 0, bytes: 4, sha256: hash("abcd") },
        { index: 1, offset: 4, bytes: 4, sha256: hash("efgh") },
        { index: 2, offset: 8, bytes: 4, sha256: hash("ijkl") }
      ]
    });

    const staged = await pool.query<{ id: string }>(
      `INSERT INTO portable_staged_inputs (
         owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,$4,$5,now()+interval '1 day') RETURNING id`,
      [owner.ownerUserId, hash(randomUUID()), filesystemOperationId, hash("abcdefghijkl"), uploadBytes.byteLength]
    );
    const recreated = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 86_400 });
    await expect(recreated.completeUpload(owner, {
      uploadId: upload.id,
      stagedInputId: staged.rows[0]!.id
    })).resolves.toMatchObject({
      id: upload.id,
      status: "completed",
      receivedBytes: 12
    });
    await expect(recreated.getAssembly(owner, upload.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a truncated or hash-mismatched staged input without completing the upload", async () => {
    const uploads = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 86_400 });
    const filesystemOperationId = await reservePortableOperation(owner, "portable_staging");
    const upload = await uploads.createUpload(owner, {
      handleTokenHash: hash(`truncated-upload-${randomUUID()}`),
      filesystemOperationId,
      byteLength: 4,
      sha256: hash("abcd")
    });
    await uploads.recordChunk(owner, {
      uploadId: upload.id,
      index: 0,
      offset: 0,
      bytes: 4,
      sha256: hash("abcd")
    });
    const truncated = await pool.query<{ id: string }>(
      `INSERT INTO portable_staged_inputs (
         owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,$4,3,now()+interval '1 day') RETURNING id`,
      [owner.ownerUserId, hash(randomUUID()), filesystemOperationId, hash("abc")]
    );

    await expect(uploads.completeUpload(owner, {
      uploadId: upload.id,
      stagedInputId: truncated.rows[0]!.id
    })).rejects.toMatchObject({ statusCode: 409 });
    await expect(uploads.getUpload(owner, upload.id)).resolves.toMatchObject({
      status: "uploading",
      receivedBytes: 4
    });
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
