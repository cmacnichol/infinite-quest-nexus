import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresDurableFilesystemRepository } from "../../packages/database/src/durable-filesystem-repository.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import type { PrivateStorageDescriptor } from "../../packages/application/src/assets/private-storage-lifecycle.js";
import { supportsSecureGeneratedArchiveStaging } from "../../services/api/src/archive-io.js";
import { createAssetImportStorageComposition } from "../../services/runtime/src/asset-import-composition.js";
import { createPrivateAssetMaintenanceComposition } from "../../services/runtime/src/private-asset-maintenance-composition.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl && supportsSecureGeneratedArchiveStaging() ? describe : describe.skip;

integration("Task 14e3e7 private asset-maintenance composition", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let archiveRoot = "";
  let assetRoot = "";
  const compositions = new Set<Readonly<{ close(): Promise<void> }>>();

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 3);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    archiveRoot = await mkdtemp(join(tmpdir(), "iqn-e7-archive-"));
    assetRoot = await mkdtemp(join(tmpdir(), "iqn-e7-assets-"));
    await mkdir(join(assetRoot, "assets", "content"), { recursive: true });
  });

  afterAll(async () => {
    await Promise.all([...compositions].map((composition) => composition.close()));
    await pool.end();
    await rm(archiveRoot, { recursive: true, force: true });
    await rm(assetRoot, { recursive: true, force: true });
  });

  const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

  async function queueLegacyImage(label: string): Promise<string> {
    const shade = [...label].reduce((total, character) => total + character.charCodeAt(0), 0) % 255;
    const bytes = await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 4,
        background: { r: 20, g: 40, b: shade, alpha: 1 },
      },
    }).png().toBuffer();
    const contentHash = hash(bytes);
    const relativePath = `assets/content/${contentHash}`;
    await writeFile(join(assetRoot, relativePath), bytes, { flag: "wx" });
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,
         pixel_width,pixel_height,technical_metadata
       ) VALUES ($1,$2,'filesystem',$3,'image/png',$4,NULL,NULL,'{}'::jsonb)
       RETURNING id`,
      [ownerUserId, contentHash, relativePath, bytes.byteLength],
    );
    const assetId = asset.rows[0]!.id;
    await pool.query(
      `INSERT INTO asset_metadata_backfill_jobs (owner_user_id,asset_id,status,next_attempt_at)
       VALUES ($1,$2,'queued',clock_timestamp())`,
      [ownerUserId, assetId],
    );
    return assetId;
  }

  async function stagePortable(
    label: string,
    options: Readonly<{ expire?: boolean }> = {},
  ): Promise<Readonly<{ operationId: string; relativePath: string }>> {
    const storage = await createAssetImportStorageComposition(pool, { archiveRoot, assetRoot });
    try {
      const bytes = Buffer.from(`e7-portable-${label}-${randomUUID()}`);
      const staged = await storage.adapter.stagePortableInput({
        owner: { ownerUserId },
        operationScopeId: `e7-portable-${label}-${randomUUID()}`,
        leaseOwner: `e7-stage-${label}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        byteLength: bytes.byteLength,
        source: [bytes],
      });
      const descriptor = await pool.query<{ relative_path: string }>(
        `SELECT relative_path FROM durable_filesystem_descriptors
          WHERE operation_id=$1 AND descriptor_role='delivery'`,
        [staged.operation.operationId],
      );
      const relativePath = descriptor.rows[0]?.relative_path;
      if (!relativePath) throw new Error("e7_portable_descriptor_missing");
      if (options.expire ?? true) {
        await pool.query(
          `UPDATE durable_filesystem_operations
              SET expires_at=clock_timestamp()-interval '1 second',
                  lease_expires_at=clock_timestamp()-interval '1 second'
            WHERE id=$1`,
          [staged.operation.operationId],
        );
      }
      return Object.freeze({ operationId: staged.operation.operationId, relativePath });
    } finally {
      await storage.close();
    }
  }

  async function attachedAsset(
    label: string,
    options: Readonly<{ expireClaim?: boolean; domainReference?: boolean }> = {},
  ): Promise<Readonly<{ operationId: string; relativePath: string; cleanupRelativePath?: string }>> {
    const bytes = Buffer.from(`e7-asset-recovery-${label}-${randomUUID()}`);
    const contentHash = hash(bytes);
    const relativePath = `assets/content/${contentHash}`;
    await writeFile(join(assetRoot, relativePath), bytes, { flag: "wx" });
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length)
       VALUES ($1,$2,'filesystem',$3,'image/png',$4) RETURNING id`,
      [ownerUserId, contentHash, relativePath, bytes.byteLength],
    );
    // This fixture exercises only durable filesystem recovery. Its bytes are
    // deliberately not a decodable image, so retain the terminal metadata
    // outcome that a prior backfill attempt would have recorded instead of
    // letting live discovery divert the scheduler into unrelated work.
    await pool.query(
      `INSERT INTO asset_metadata_backfill_jobs (
         owner_user_id,asset_id,status,diagnostic_code,attempts,next_attempt_at
       ) VALUES ($1,$2,'failed','asset_unsupported_media',1,clock_timestamp())`,
      [ownerUserId, asset.rows[0]!.id],
    );
    const inode = await stat(join(assetRoot, relativePath), { bigint: true });
    const descriptor: PrivateStorageDescriptor = Object.freeze({
      relativePath,
      identity: Object.freeze({
        deviceId: inode.dev.toString(),
        fileId: inode.ino.toString(),
        changeToken: `${inode.mtimeNs}:${inode.ctimeNs}`,
      }),
      contentHash,
      byteLength: bytes.byteLength,
    });
    let cleanupRelativePath: string | undefined;
    let cleanupDescriptor: PrivateStorageDescriptor | undefined;
    if (!(options.domainReference ?? true)) {
      const cleanupBytes = Buffer.from(`e7-asset-cleanup-${label}-${randomUUID()}`);
      cleanupRelativePath = `assets/recovery/${randomUUID()}.cleanup`;
      await mkdir(join(assetRoot, "assets", "recovery"), { recursive: true });
      await writeFile(join(assetRoot, cleanupRelativePath), cleanupBytes, { flag: "wx" });
      const cleanupInode = await stat(join(assetRoot, cleanupRelativePath), { bigint: true });
      cleanupDescriptor = Object.freeze({
        relativePath: cleanupRelativePath,
        identity: Object.freeze({
          deviceId: cleanupInode.dev.toString(),
          fileId: cleanupInode.ino.toString(),
          changeToken: `${cleanupInode.mtimeNs}:${cleanupInode.ctimeNs}`,
        }),
        contentHash: hash(cleanupBytes),
        byteLength: cleanupBytes.byteLength,
      });
    }
    const durable = createPostgresDurableFilesystemRepository(pool);
    const reserved = await durable.journal.reserve({
      resourceKind: "asset",
      ownerUserId,
      assetId: asset.rows[0]!.id,
    }, {
      purpose: "asset_original",
      leaseOwner: `e7-asset-${label}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const candidate = await durable.issuePublicationCandidate(reserved.operation, {
      deliveryRelativePath: relativePath,
      cleanupDescriptors: cleanupDescriptor ? [descriptor, cleanupDescriptor] : [descriptor],
    });
    await durable.completePublicationCandidate(reserved.operation, candidate, descriptor);
    const attached = await withTransaction(pool, async (database) => {
      if (options.domainReference ?? true) {
        await database.query(
          "UPDATE assets SET filesystem_operation_id=$1 WHERE id=$2 AND owner_user_id=$3",
          [reserved.operation.operationId, asset.rows[0]!.id, ownerUserId],
        );
      }
      return durable.journal.attach(database, reserved.operation, candidate);
    });
    if (attached.outcome !== "attached") throw new Error(`e7_asset_attachment_${attached.outcome}`);
    if (options.expireClaim ?? true) {
      await pool.query(
        "UPDATE durable_filesystem_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [attached.operation.operationId],
      );
    }
    return Object.freeze({
      operationId: attached.operation.operationId,
      relativePath,
      ...(cleanupRelativePath ? { cleanupRelativePath } : {}),
    });
  }

  it("round-robins real e5 and e6 work so recurring metadata does not starve portable expiry", async () => {
    const firstAsset = await queueLegacyImage("one");
    const firstRecovery = await attachedAsset("one");
    const firstPortable = await stagePortable("one");
    const composition = await createPrivateAssetMaintenanceComposition(pool, { archiveRoot, assetRoot });
    compositions.add(composition);

    await expect(composition.scheduler.tick({ workerId: "e7-round-robin", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "metadata_backfill", completed: 1 });
    await expect(pool.query(
      "SELECT status FROM asset_metadata_backfill_jobs WHERE owner_user_id=$1 AND asset_id=$2",
      [ownerUserId, firstAsset],
    )).resolves.toMatchObject({ rows: [{ status: "completed" }] });

    await expect(composition.scheduler.tick({ workerId: "e7-round-robin", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "asset_filesystem_recovery", completed: 1 });
    await expect(pool.query(
      "SELECT lifecycle FROM durable_filesystem_operations WHERE id=$1",
      [firstRecovery.operationId],
    )).resolves.toMatchObject({ rows: [{ lifecycle: "finalized" }] });
    await expect(composition.scheduler.tick({ workerId: "e7-round-robin", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "portable_expiry_recovery", completed: 1 });
    await expect(stat(join(archiveRoot, firstPortable.relativePath))).rejects.toMatchObject({ code: "ENOENT" });

    const secondAsset = await queueLegacyImage("two");
    const secondPortable = await stagePortable("two");
    await expect(composition.scheduler.tick({ workerId: "e7-round-robin", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "metadata_backfill", completed: 1 });
    await expect(pool.query(
      "SELECT status FROM asset_metadata_backfill_jobs WHERE owner_user_id=$1 AND asset_id=$2",
      [ownerUserId, secondAsset],
    )).resolves.toMatchObject({ rows: [{ status: "completed" }] });
    await expect(composition.scheduler.tick({ workerId: "e7-round-robin", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "asset_filesystem_recovery", idle: 1 });
    await expect(composition.scheduler.tick({ workerId: "e7-round-robin", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "portable_expiry_recovery", completed: 1 });
    await expect(stat(join(archiveRoot, secondPortable.relativePath))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(composition.scheduler.tick({ workerId: "e7-round-robin", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "metadata_backfill", idle: 1 });
    await expect(composition.scheduler.tick({ workerId: "e7-round-robin", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "asset_filesystem_recovery", idle: 1 });
    await expect(composition.scheduler.tick({ workerId: "e7-round-robin", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "portable_expiry_recovery", idle: 1 });
    await expect(pool.query(
      `SELECT count(*)::text AS count FROM asset_derivatives
        WHERE owner_user_id=$1 AND source_asset_id=$2 AND derivative_kind='thumbnail' AND transform_version=1`,
      [ownerUserId, firstAsset],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("reclaims only an expired force-stopped metadata claim from a fresh private composition", async () => {
    const assetId = await queueLegacyImage("force-stop");
    await pool.query(
      `UPDATE asset_metadata_backfill_jobs
          SET status='running',lease_id=gen_random_uuid(),lease_owner='e7-forced-stop',
              lease_expires_at=clock_timestamp()+interval '60 seconds',attempts=1
        WHERE owner_user_id=$1 AND asset_id=$2`,
      [ownerUserId, assetId],
    );
    const beforeExpiry = await createPrivateAssetMaintenanceComposition(pool, { archiveRoot, assetRoot });
    compositions.add(beforeExpiry);
    await expect(beforeExpiry.scheduler.tick({ workerId: "e7-fresh-before-expiry", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "metadata_backfill", idle: 1 });
    await beforeExpiry.close();
    await pool.query(
      "UPDATE asset_metadata_backfill_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE owner_user_id=$1 AND asset_id=$2",
      [ownerUserId, assetId],
    );
    const afterExpiry = await createPrivateAssetMaintenanceComposition(pool, { archiveRoot, assetRoot });
    compositions.add(afterExpiry);
    await expect(afterExpiry.scheduler.tick({ workerId: "e7-fresh-after-expiry", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "metadata_backfill", completed: 1 });
    await expect(pool.query(
      "SELECT status,lease_owner FROM asset_metadata_backfill_jobs WHERE owner_user_id=$1 AND asset_id=$2",
      [ownerUserId, assetId],
    )).resolves.toMatchObject({ rows: [{ status: "completed", lease_owner: null }] });
  });

  it("does not reclaim an unexpired asset cleanup claim, then reclaims and cleans it exactly once after force-stop expiry", async () => {
    const asset = await attachedAsset("force-stop-cleanup", { expireClaim: false, domainReference: false });
    const beforeExpiry = await createPrivateAssetMaintenanceComposition(pool, { archiveRoot, assetRoot });
    compositions.add(beforeExpiry);
    await expect(beforeExpiry.scheduler.tick({ workerId: "e7-asset-before-metadata", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "metadata_backfill", idle: 1 });
    await expect(beforeExpiry.scheduler.tick({ workerId: "e7-asset-before-expiry", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "asset_filesystem_recovery", idle: 1 });
    await expect(stat(join(assetRoot, asset.cleanupRelativePath!))).resolves.toBeTruthy();
    await beforeExpiry.close();

    await pool.query(
      "UPDATE durable_filesystem_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [asset.operationId],
    );
    const afterExpiry = await createPrivateAssetMaintenanceComposition(pool, { archiveRoot, assetRoot });
    compositions.add(afterExpiry);
    await expect(afterExpiry.scheduler.tick({ workerId: "e7-asset-after-metadata", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "metadata_backfill", idle: 1 });
    await expect(afterExpiry.scheduler.tick({ workerId: "e7-asset-after-expiry", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "asset_filesystem_recovery", completed: 1 });
    await expect(stat(join(assetRoot, asset.cleanupRelativePath!))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(pool.query(
      "SELECT lifecycle FROM durable_filesystem_operations WHERE id=$1",
      [asset.operationId],
    )).resolves.toMatchObject({ rows: [{ lifecycle: "cleaned" }] });

    await expect(afterExpiry.scheduler.tick({ workerId: "e7-asset-idempotent-portable", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "portable_expiry_recovery", idle: 1 });
    await expect(afterExpiry.scheduler.tick({ workerId: "e7-asset-idempotent-metadata", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "metadata_backfill", idle: 1 });
    await expect(afterExpiry.scheduler.tick({ workerId: "e7-asset-idempotent", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "asset_filesystem_recovery", idle: 1 });
  });

  it("does not reclaim an unexpired portable cleanup claim, then reclaims and cleans it exactly once after force-stop expiry", async () => {
    const portable = await stagePortable("force-stop", { expire: false });
    const beforeExpiry = await createPrivateAssetMaintenanceComposition(pool, { archiveRoot, assetRoot });
    compositions.add(beforeExpiry);
    await expect(beforeExpiry.scheduler.tick({ workerId: "e7-portable-before-metadata", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "metadata_backfill", idle: 1 });
    await expect(beforeExpiry.scheduler.tick({ workerId: "e7-portable-before-asset", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "asset_filesystem_recovery", idle: 1 });
    await expect(beforeExpiry.scheduler.tick({ workerId: "e7-portable-before-expiry", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "portable_expiry_recovery", idle: 1 });
    await expect(stat(join(archiveRoot, portable.relativePath))).resolves.toBeTruthy();
    await beforeExpiry.close();

    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=clock_timestamp()-interval '1 second',
              expires_at=clock_timestamp()-interval '1 second'
        WHERE id=$1`,
      [portable.operationId],
    );
    const afterExpiry = await createPrivateAssetMaintenanceComposition(pool, { archiveRoot, assetRoot });
    compositions.add(afterExpiry);
    await expect(afterExpiry.scheduler.tick({ workerId: "e7-portable-after-metadata", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "metadata_backfill", idle: 1 });
    await expect(afterExpiry.scheduler.tick({ workerId: "e7-portable-after-asset", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "asset_filesystem_recovery", idle: 1 });
    await expect(afterExpiry.scheduler.tick({ workerId: "e7-portable-after-expiry", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "portable_expiry_recovery", completed: 1 });
    await expect(stat(join(archiveRoot, portable.relativePath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(pool.query(
      `SELECT operation.lifecycle,staged.status
         FROM durable_filesystem_operations operation
         JOIN portable_staged_inputs staged ON staged.filesystem_operation_id=operation.id
        WHERE operation.id=$1`,
      [portable.operationId],
    )).resolves.toMatchObject({ rows: [{ lifecycle: "cleaned", status: "cleaned" }] });

    await expect(afterExpiry.scheduler.tick({ workerId: "e7-portable-idempotent-metadata", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "metadata_backfill", idle: 1 });
    await expect(afterExpiry.scheduler.tick({ workerId: "e7-portable-idempotent-asset", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "asset_filesystem_recovery", idle: 1 });
    await expect(afterExpiry.scheduler.tick({ workerId: "e7-portable-idempotent", leaseSeconds: 30 }))
      .resolves.toMatchObject({ probe: "portable_expiry_recovery", idle: 1 });
  });
});
