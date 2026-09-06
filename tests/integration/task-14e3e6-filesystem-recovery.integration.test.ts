import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresDurableFilesystemRepository } from "../../packages/database/src/durable-filesystem-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import type {
  AttachedFilesystemOperation,
  DurableFilesystemRecoveryRecord,
  PrivateStorageDescriptor,
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import { supportsSecureGeneratedArchiveStaging } from "../../services/api/src/archive-io.js";
import { createAssetImportStorageComposition } from "../../services/runtime/src/asset-import-composition.js";
import { createPrivateFilesystemRecoveryComposition } from "../../services/runtime/src/private-filesystem-recovery-composition.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const secureFilesystemIt = it.runIf(supportsSecureGeneratedArchiveStaging());

integration("Task 14e3e6 private filesystem recovery", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let archiveRoot = "";
  let assetRoot = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 3);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    archiveRoot = await mkdtemp(join(tmpdir(), "iqn-e6-archive-"));
    assetRoot = await mkdtemp(join(tmpdir(), "iqn-e6-assets-"));
    await mkdir(join(assetRoot, "assets", "content"), { recursive: true });
  });

  afterAll(async () => {
    await pool.end();
    await rm(archiveRoot, { recursive: true, force: true });
    await rm(assetRoot, { recursive: true, force: true });
  });

  const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

  async function filesystemDescriptor(relativePath: string, bytes: Uint8Array): Promise<PrivateStorageDescriptor> {
    const value = await stat(join(assetRoot, relativePath), { bigint: true });
    return Object.freeze({
      relativePath,
      identity: Object.freeze({
        deviceId: value.dev.toString(),
        fileId: value.ino.toString(),
        changeToken: `${value.mtimeNs}:${value.ctimeNs}`,
      }),
      contentHash: hash(bytes),
      byteLength: bytes.byteLength,
    });
  }

  async function attachedAsset(
    label: string,
    input: Readonly<{ domainReference: boolean; cleanupPath?: string }> = { domainReference: false },
  ): Promise<Readonly<{ operation: AttachedFilesystemOperation; assetId: string; contentHash: string; cleanupPath?: string }>> {
    const bytes = Buffer.from(`e6-${label}-${crypto.randomUUID()}`);
    const contentHash = hash(bytes);
    const deliveryPath = `assets/content/${contentHash}`;
    await writeFile(join(assetRoot, deliveryPath), bytes, { flag: "wx" });
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length)
       VALUES ($1,$2,'filesystem',$3,'image/png',$4) RETURNING id`,
      [ownerUserId, contentHash, deliveryPath, bytes.byteLength],
    );
    const durable = createPostgresDurableFilesystemRepository(pool);
    const reserved = await durable.journal.reserve({
      resourceKind: "asset",
      ownerUserId,
      assetId: asset.rows[0]!.id,
    }, {
      purpose: "asset_original",
      leaseOwner: `e6-${label}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    let cleanupDescriptor: PrivateStorageDescriptor | undefined;
    if (input.cleanupPath) {
      const cleanupBytes = Buffer.from(`cleanup-${label}-${crypto.randomUUID()}`);
      await mkdir(dirname(join(assetRoot, input.cleanupPath)), { recursive: true });
      await writeFile(join(assetRoot, input.cleanupPath), cleanupBytes, { flag: "wx" });
      cleanupDescriptor = await filesystemDescriptor(input.cleanupPath, cleanupBytes);
    }
    const delivery = await filesystemDescriptor(deliveryPath, bytes);
    const candidate = await durable.issuePublicationCandidate(reserved.operation, {
      deliveryRelativePath: deliveryPath,
      cleanupDescriptors: cleanupDescriptor ? [delivery, cleanupDescriptor] : [delivery],
    });
    await durable.completePublicationCandidate(reserved.operation, candidate, delivery);
    const attached = await withTransaction(pool, async (database) => {
      if (input.domainReference) {
        await database.query(
          "UPDATE assets SET filesystem_operation_id=$2 WHERE id=$1 AND owner_user_id=$3",
          [asset.rows[0]!.id, reserved.operation.operationId, ownerUserId],
        );
      }
      return durable.journal.attach(database, reserved.operation, candidate);
    });
    if (attached.outcome !== "attached") throw new Error(`e6_attachment_${attached.outcome}`);
    return input.cleanupPath === undefined
      ? Object.freeze({ operation: attached.operation, assetId: asset.rows[0]!.id, contentHash })
      : Object.freeze({ operation: attached.operation, assetId: asset.rows[0]!.id, contentHash, cleanupPath: input.cleanupPath });
  }

  async function expire(operationId: string): Promise<void> {
    await pool.query(
      "UPDATE durable_filesystem_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [operationId],
    );
  }

  async function expiredPortableStage(label: string): Promise<Readonly<{
    operationId: string;
    relativePath: string;
  }>> {
    const storage = await createAssetImportStorageComposition(pool, { archiveRoot, assetRoot });
    try {
      const bytes = Buffer.from(`e6-portable-${label}-${crypto.randomUUID()}`);
      const staged = await storage.adapter.stagePortableInput({
        owner: { ownerUserId },
        operationScopeId: `e6-portable-${label}-${crypto.randomUUID()}`,
        leaseOwner: `e6-portable-${label}`,
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
      if (!relativePath) throw new Error("e6_portable_descriptor_missing");
      await pool.query(
        `UPDATE durable_filesystem_operations
            SET expires_at=clock_timestamp()-interval '1 second',
                lease_expires_at=clock_timestamp()-interval '1 second'
          WHERE id=$1`,
        [staged.operation.operationId],
      );
      return Object.freeze({ operationId: staged.operation.operationId, relativePath });
    } finally {
      await storage.close();
    }
  }

  async function attachedCleanupPair(label: string): Promise<Readonly<{
    operations: readonly AttachedFilesystemOperation[];
    paths: readonly string[];
  }>> {
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length)
       VALUES ($1,$2,'filesystem',$3,'image/png',1) RETURNING id`,
      [
        ownerUserId,
        hash(`e6-pair-${label}-${crypto.randomUUID()}`),
        `assets/recovery/${crypto.randomUUID()}.asset`,
      ],
    );
    const durable = createPostgresDurableFilesystemRepository(pool);
    const operations: AttachedFilesystemOperation[] = [];
    const paths: string[] = [];
    for (const purpose of ["asset_original", "asset_derivative"] as const) {
      const bytes = Buffer.from(`e6-pair-${purpose}-${crypto.randomUUID()}`);
      const relativePath = `assets/recovery/${crypto.randomUUID()}.${purpose}`;
      await mkdir(dirname(join(assetRoot, relativePath)), { recursive: true });
      await writeFile(join(assetRoot, relativePath), bytes, { flag: "wx" });
      const reservation = await durable.journal.reserve({
        resourceKind: "asset",
        ownerUserId,
        assetId: asset.rows[0]!.id,
      }, {
        purpose,
        leaseOwner: `e6-pair-${label}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const descriptor = await filesystemDescriptor(relativePath, bytes);
      const candidate = await durable.issuePublicationCandidate(reservation.operation, {
        deliveryRelativePath: relativePath,
        cleanupDescriptors: [descriptor],
      });
      await durable.completePublicationCandidate(reservation.operation, candidate, descriptor);
      const attached = await withTransaction(pool, (database) => durable.journal.attach(
        database,
        reservation.operation,
        candidate,
      ));
      if (attached.outcome !== "attached") throw new Error(`e6_pair_attachment_${attached.outcome}`);
      operations.push(attached.operation);
      paths.push(relativePath);
    }
    return Object.freeze({ operations: Object.freeze(operations), paths: Object.freeze(paths) });
  }

  it("renews only an exact asset recovery claim and rejects its rotated predecessor", async () => {
    const contentHash = createHash("sha256").update(crypto.randomUUID()).digest("hex");
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length)
       VALUES ($1,$2,'filesystem',$3,'image/png',1) RETURNING id`,
      [ownerUserId, contentHash, `assets/e6-${crypto.randomUUID()}.png`],
    );
    const repository = createPostgresDurableFilesystemRepository(pool);
    const reservation = await repository.journal.reserve({
      resourceKind: "asset",
      ownerUserId,
      assetId: asset.rows[0]!.id,
    }, {
      purpose: "asset_original",
      leaseOwner: "e6-publisher",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await pool.query(
      "UPDATE durable_filesystem_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [reservation.operation.operationId],
    );

    const recovered = await repository.journal.recover({
      leaseOwner: "e6-recovery",
      leaseSeconds: 30,
      limit: 1,
      resourceKinds: ["asset"],
    });
    expect(recovered).toHaveLength(1);
    const record = recovered[0]!;
    const renewed = await repository.journal.heartbeatRecoveryClaim(record.claim, 30);
    expect(renewed).not.toBeNull();
    expect(renewed?.leaseId).toBe(record.claim.leaseId);
    expect(renewed?.workVersion).toBe(record.claim.workVersion);
    await expect(repository.journal.heartbeatRecoveryClaim(record.claim, 30)).resolves.toBeNull();
    await expect(repository.journal.heartbeatRecoveryClaim({
      ...renewed!,
      leaseOwner: "foreign-recovery",
    }, 30)).resolves.toBeNull();
  });

  it("keeps an exact claim renewable across a slow recovery window and rejects it after rotation", async () => {
    const contentHash = createHash("sha256").update(crypto.randomUUID()).digest("hex");
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length)
       VALUES ($1,$2,'filesystem',$3,'image/png',1) RETURNING id`,
      [ownerUserId, contentHash, `assets/e6-slow-${crypto.randomUUID()}.png`],
    );
    const repository = createPostgresDurableFilesystemRepository(pool);
    const reservation = await repository.journal.reserve({ resourceKind: "asset", ownerUserId, assetId: asset.rows[0]!.id }, {
      purpose: "asset_original", leaseOwner: "e6-slow-publisher", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expire(reservation.operation.operationId);
    const [record] = await repository.journal.recover({ leaseOwner: "e6-slow", leaseSeconds: 30, limit: 1, resourceKinds: ["asset"] });
    if (!record) throw new Error("e6_slow_recovery_missing");
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    const renewed = await repository.journal.heartbeatRecoveryClaim(record.claim, 30);
    expect(renewed).not.toBeNull();
    await expect(repository.journal.heartbeatRecoveryClaim(record.claim, 30)).resolves.toBeNull();
    await expect(repository.journal.heartbeatRecoveryClaim(renewed!, 30)).resolves.toMatchObject({ operationId: record.operation.operationId });
  });

  secureFilesystemIt("keeps an expired portable cleanup fenced through a blocked short lease and refreshes its acknowledgement", async () => {
    const staged = await expiredPortableStage("heartbeat");
    let physicalDeleteStarted!: () => void;
    const physicalDeleteStartedPromise = new Promise<void>((resolve) => { physicalDeleteStarted = resolve; });
    let releasePhysicalDelete!: () => void;
    const releasePhysicalDeletePromise = new Promise<void>((resolve) => { releasePhysicalDelete = resolve; });
    const composition = await createPrivateFilesystemRecoveryComposition(pool, { archiveRoot, assetRoot }, {
      recoveryHooks: {
        recoveryHooks: {
          async beforePhysicalDelete() {
            physicalDeleteStarted();
            await releasePhysicalDeletePromise;
          },
        },
      },
    });
    try {
      const recovery = composition.executor.processOne({ workerId: "e6-portable-heartbeat", leaseSeconds: 1, limit: 1 });
      await physicalDeleteStartedPromise;
      await pool.query("SELECT pg_sleep(1.1)");
      await expect(stat(join(archiveRoot, staged.relativePath))).resolves.toBeTruthy();
      releasePhysicalDelete();
      await expect(recovery).resolves.toMatchObject({
        portableClaimed: 1,
        portablePending: 0,
        leaseLost: 0,
      });
      await expect(stat(join(archiveRoot, staged.relativePath))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(pool.query(
        `SELECT operation.lifecycle,staged.status
           FROM durable_filesystem_operations operation
           JOIN portable_staged_inputs staged ON staged.filesystem_operation_id=operation.id
          WHERE operation.id=$1`,
        [staged.operationId],
      )).resolves.toMatchObject({ rows: [{ lifecycle: "cleaned", status: "cleaned" }] });
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("does not let a rotated foreign portable claimant delete bytes or acknowledge cleanup", async () => {
    let staged: Awaited<ReturnType<typeof expiredPortableStage>>;
    let foreignRecovery: DurableFilesystemRecoveryRecord | undefined;
    let rotateToForeign = true;
    const storage = await createAssetImportStorageComposition(pool, { archiveRoot, assetRoot }, undefined, {
      recoveryHooks: {
        async beforePhysicalDelete() {
          if (!rotateToForeign) return;
          rotateToForeign = false;
          await pool.query(
            "UPDATE durable_filesystem_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [staged.operationId],
          );
          [foreignRecovery] = await storage.journal.recover({
            leaseOwner: "e6-portable-foreign",
            leaseSeconds: 10,
            limit: 1,
            resourceKinds: ["portable"],
          });
        },
      },
    });
    staged = await expiredPortableStage("foreign");
    try {
      const [recovery] = await storage.adapter.claimExpiredPortableRecoveries({
        leaseOwner: "e6-portable-original",
        leaseSeconds: 1,
        limit: 1,
      });
      if (!recovery) throw new Error("e6_portable_recovery_missing");
      await expect(storage.adapter.recoverFilesystemOperation(recovery, () => foreignRecovery ?? recovery))
        .resolves.toEqual({ outcome: "lease_lost" });
      expect(foreignRecovery).toMatchObject({ claim: { leaseOwner: "e6-portable-foreign" } });
      await expect(stat(join(archiveRoot, staged.relativePath))).resolves.toBeTruthy();
      await expect(pool.query(
        `SELECT operation.lifecycle,operation.lease_owner,staged.status
           FROM durable_filesystem_operations operation
           JOIN portable_staged_inputs staged ON staged.filesystem_operation_id=operation.id
          WHERE operation.id=$1`,
        [staged.operationId],
      )).resolves.toMatchObject({ rows: [{
        lifecycle: "cleanup_pending",
        lease_owner: "e6-portable-foreign",
        status: "cleanup_pending",
      }] });
      await expect(storage.adapter.recoverFilesystemOperation(
        foreignRecovery!,
        () => foreignRecovery!,
      )).resolves.toEqual({ outcome: "cleaned" });
    } finally {
      await storage.close();
    }
  });

  secureFilesystemIt("quarantines an expired target-only prewrite from a fresh private composition", async () => {
    const contentHash = createHash("sha256").update(crypto.randomUUID()).digest("hex");
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length)
       VALUES ($1,$2,'filesystem',$3,'image/png',1) RETURNING id`,
      [ownerUserId, contentHash, `assets/e6-quarantine-${crypto.randomUUID()}.png`],
    );
    const durable = createPostgresDurableFilesystemRepository(pool);
    const reservation = await durable.journal.reserve({
      resourceKind: "asset",
      ownerUserId,
      assetId: asset.rows[0]!.id,
    }, {
      purpose: "asset_original",
      leaseOwner: "e6-prewrite",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await pool.query(
      `INSERT INTO durable_filesystem_prewrite_nodes (
         operation_id,owner_user_id,purpose,relative_path,authority_state
       ) VALUES ($1,$2,'asset_original',$3,'target_only')`,
      [reservation.operation.operationId, ownerUserId, `assets/content/${contentHash}`],
    );
    await pool.query(
      "UPDATE durable_filesystem_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [reservation.operation.operationId],
    );
    const composition = await createPrivateFilesystemRecoveryComposition(pool, { archiveRoot, assetRoot });
    try {
      await expect(composition.executor.processOne({ workerId: "e6-fresh", leaseSeconds: 10, limit: 1 }))
        .resolves.toMatchObject({ claimed: 1, quarantined: 1, cleaned: 0 });
      await expect(pool.query(
        "SELECT authority_state FROM durable_filesystem_prewrite_nodes WHERE operation_id=$1",
        [reservation.operation.operationId],
      )).resolves.toMatchObject({ rows: [{ authority_state: "quarantined" }] });
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("finalizes an attached post-commit operation exactly once from a fresh composition", async () => {
    const attached = await attachedAsset("finalize", { domainReference: true });
    await expire(attached.operation.operationId);
    const composition = await createPrivateFilesystemRecoveryComposition(pool, { archiveRoot, assetRoot });
    try {
      await expect(composition.executor.processOne({ workerId: "e6-finalize", leaseSeconds: 10, limit: 1 }))
        .resolves.toMatchObject({ claimed: 1, finalized: 1, cleaned: 0 });
      await expect(composition.executor.processOne({ workerId: "e6-finalize-restart", leaseSeconds: 10, limit: 1 }))
        .resolves.toMatchObject({ claimed: 0, finalized: 0 });
      await expect(pool.query(
        "SELECT lifecycle FROM durable_filesystem_operations WHERE id=$1",
        [attached.operation.operationId],
      )).resolves.toMatchObject({ rows: [{ lifecycle: "finalized" }] });
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("reconciles an exact e5 attached publication only after its filesystem operation finalizes", async () => {
    const attached = await attachedAsset("e5-reconcile", { domainReference: true });
    await pool.query(
      `INSERT INTO asset_metadata_backfill_jobs (owner_user_id,asset_id,status,next_attempt_at)
       VALUES ($1,$2,'queued',clock_timestamp())`,
      [ownerUserId, attached.assetId],
    );
    await pool.query(
      `INSERT INTO asset_metadata_backfill_publications (
         owner_user_id,asset_id,work_version,expected_content_hash,thumbnail_content_hash,filesystem_operation_id,lifecycle
       ) VALUES ($1,$2,1,$3,$4,$5,'attached')`,
      [ownerUserId, attached.assetId, attached.contentHash, hash(`thumbnail-${crypto.randomUUID()}`), attached.operation.operationId],
    );
    await expire(attached.operation.operationId);
    const composition = await createPrivateFilesystemRecoveryComposition(pool, { archiveRoot, assetRoot });
    try {
      await expect(composition.executor.processOne({ workerId: "e6-e5-reconcile", leaseSeconds: 10, limit: 1 }))
        .resolves.toMatchObject({ claimed: 1, finalized: 1, recoverable: 0 });
      await expect(pool.query(
        `SELECT publication.lifecycle AS publication_lifecycle,job.status
           FROM asset_metadata_backfill_publications publication
           JOIN asset_metadata_backfill_jobs job ON job.owner_user_id=publication.owner_user_id AND job.asset_id=publication.asset_id
          WHERE publication.filesystem_operation_id=$1`,
        [attached.operation.operationId],
      )).resolves.toMatchObject({ rows: [{ publication_lifecycle: "published", status: "completed" }] });
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("removes only unreferenced cleanup descriptors and retains a foreign shared path", async () => {
    const removablePath = `assets/recovery/${crypto.randomUUID()}.pending`;
    const removable = await attachedAsset("cleanup-removable", { cleanupPath: removablePath, domainReference: false });
    const retainedPath = `assets/recovery/${crypto.randomUUID()}.shared`;
    const retained = await attachedAsset("cleanup-retained", { cleanupPath: retainedPath, domainReference: false });
    const sharedBytes = await stat(join(assetRoot, retainedPath));
    await pool.query(
      `INSERT INTO users (system_key,display_name,status) VALUES ($1,$2,'active') RETURNING id`,
      [`e6-shared-${crypto.randomUUID()}`, "e6 shared"],
    );
    const foreignOwner = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE system_key LIKE 'e6-shared-%' ORDER BY created_at DESC LIMIT 1",
    );
    await pool.query(
      `INSERT INTO assets (owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length)
       VALUES ($1,$2,'filesystem',$3,'image/png',$4)`,
      [foreignOwner.rows[0]!.id, hash(`foreign-${crypto.randomUUID()}`), retainedPath, sharedBytes.size],
    );
    await Promise.all([expire(removable.operation.operationId), expire(retained.operation.operationId)]);
    const composition = await createPrivateFilesystemRecoveryComposition(pool, { archiveRoot, assetRoot });
    try {
      await expect(composition.executor.processOne({ workerId: "e6-cleanup", leaseSeconds: 10, limit: 2 }))
        .resolves.toMatchObject({ claimed: 2, cleaned: 2 });
      await expect(stat(join(assetRoot, removablePath))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(assetRoot, retainedPath))).resolves.toMatchObject({ size: sharedBytes.size });
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("expires paired original and derivative cleanup authority without leaving either descriptor behind", async () => {
    const pair = await attachedCleanupPair("paired-expiry");
    await Promise.all(pair.operations.map((operation) => expire(operation.operationId)));
    const composition = await createPrivateFilesystemRecoveryComposition(pool, { archiveRoot, assetRoot });
    try {
      await expect(composition.executor.processOne({ workerId: "e6-paired-expiry", leaseSeconds: 10, limit: 2 }))
        .resolves.toMatchObject({ claimed: 2, cleaned: 2, recoverable: 0 });
      await Promise.all(pair.paths.map((relativePath) => expect(stat(join(assetRoot, relativePath)))
        .rejects.toMatchObject({ code: "ENOENT" })));
      await expect(pool.query(
        `SELECT purpose,lifecycle FROM durable_filesystem_operations
          WHERE id=ANY($1::uuid[]) ORDER BY purpose`,
        [pair.operations.map((operation) => operation.operationId)],
      )).resolves.toMatchObject({ rows: [
        { purpose: "asset_derivative", lifecycle: "cleaned" },
        { purpose: "asset_original", lifecycle: "cleaned" },
      ] });
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("claims paired cleanup work once across concurrent private recovery compositions", async () => {
    const pair = await attachedCleanupPair("concurrent-cleanup");
    await Promise.all(pair.operations.map((operation) => expire(operation.operationId)));
    const first = await createPrivateFilesystemRecoveryComposition(pool, { archiveRoot, assetRoot });
    const second = await createPrivateFilesystemRecoveryComposition(pool, { archiveRoot, assetRoot });
    try {
      const completed = await Promise.race([
        Promise.all([
          first.executor.processOne({ workerId: "e6-concurrent-a", leaseSeconds: 10, limit: 1 }),
          second.executor.processOne({ workerId: "e6-concurrent-b", leaseSeconds: 10, limit: 1 }),
        ]),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("e6_concurrent_recovery_timeout")), 10_000)),
      ]);
      expect(completed[0]!.claimed + completed[1]!.claimed).toBe(2);
      expect(completed[0]!.cleaned + completed[1]!.cleaned).toBe(2);
      await expect(pool.query(
        `SELECT lifecycle,count(*)::int AS count
           FROM durable_filesystem_operations
          WHERE id=ANY($1::uuid[]) GROUP BY lifecycle`,
        [pair.operations.map((operation) => operation.operationId)],
      )).resolves.toMatchObject({ rows: [{ lifecycle: "cleaned", count: 2 }] });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  secureFilesystemIt("persists a safe cleanup diagnostic across a fault and finishes on a fresh retry without duplicate deletion", async () => {
    const cleanupPath = `assets/recovery/${crypto.randomUUID()}.retry`;
    const attached = await attachedAsset("cleanup-retry", { cleanupPath, domainReference: false });
    await pool.query(`
      CREATE FUNCTION fail_e6_cleanup_once() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.lifecycle='cleaned' AND OLD.lifecycle='cleanup_pending' THEN
          RAISE EXCEPTION 'filesystem recovery injected cleanup fault';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_e6_cleanup_once_trigger BEFORE UPDATE ON durable_filesystem_operations
      FOR EACH ROW EXECUTE FUNCTION fail_e6_cleanup_once();
    `);
    await expire(attached.operation.operationId);
    const first = await createPrivateFilesystemRecoveryComposition(pool, { archiveRoot, assetRoot });
    try {
      await expect(first.executor.processOne({ workerId: "e6-fault", leaseSeconds: 10, limit: 1 }))
        .resolves.toMatchObject({ claimed: 1, recoverable: 1, cleaned: 0 });
    } finally {
      await first.close();
      await pool.query("DROP TRIGGER IF EXISTS fail_e6_cleanup_once_trigger ON durable_filesystem_operations");
      await pool.query("DROP FUNCTION IF EXISTS fail_e6_cleanup_once()");
    }
    await expect(pool.query(
      "SELECT lifecycle,diagnostic_code FROM durable_filesystem_operations WHERE id=$1",
      [attached.operation.operationId],
    )).resolves.toMatchObject({ rows: [{ lifecycle: "cleanup_pending", diagnostic_code: "asset_storage_unavailable" }] });
    await expire(attached.operation.operationId);
    const fresh = await createPrivateFilesystemRecoveryComposition(pool, { archiveRoot, assetRoot });
    try {
      await expect(fresh.executor.processOne({ workerId: "e6-retry", leaseSeconds: 10, limit: 1 }))
        .resolves.toMatchObject({ claimed: 1, cleaned: 1, recoverable: 0 });
      await expect(stat(join(assetRoot, cleanupPath))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fresh.close();
    }
  });
});
