import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindPrivateFilesystemCandidateAttachment } from "../../packages/application/src/assets/private-filesystem-repository.js";
import type {
  AssetPublicationCandidate,
  AttachedFilesystemOperation,
  DurableFilesystemRecoveryClaim,
  DurableFilesystemPurpose,
  DurableFilesystemScope,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import { bindPrivateFilesystemCandidateAuthority } from "../../packages/application/src/assets/private-storage-lifecycle.js";
import { createPostgresDurableFilesystemRepository } from "../../packages/database/src/durable-filesystem-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabaseClient,
  type DatabasePool
} from "../../packages/database/src/pool.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function descriptor(relativePath: string, seed: string): PrivateStorageDescriptor {
  return {
    relativePath,
    identity: {
      deviceId: `device-${seed}`,
      fileId: `file-${seed}`,
      changeToken: `change-${seed}`
    },
    contentHash: hash(seed),
    byteLength: 128
  };
}

integration("PostgreSQL durable filesystem repository", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 12);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function owner(prefix: string): Promise<string> {
    const created = await pool.query<{ id: string }>(
      "INSERT INTO users (system_key,display_name) VALUES ($1,$2) RETURNING id",
      [`${prefix}-${crypto.randomUUID()}`, prefix]
    );
    return created.rows[0]!.id;
  }

  async function asset(scopedOwner = ownerUserId, path = `originals/old-${crypto.randomUUID()}.png`): Promise<string> {
    const created = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length
       ) VALUES ($1,$2,'filesystem',$3,'image/png',128) RETURNING id`,
      [scopedOwner, hash(crypto.randomUUID()), path]
    );
    return created.rows[0]!.id;
  }

  function scope(assetId: string, scopedOwner = ownerUserId): DurableFilesystemScope {
    return { resourceKind: "asset", ownerUserId: scopedOwner, assetId };
  }

  async function publish(
    repository: ReturnType<typeof createPostgresDurableFilesystemRepository>,
    operationScope: DurableFilesystemScope,
    delivery: PrivateStorageDescriptor,
    cleanup: readonly [PrivateStorageDescriptor, ...PrivateStorageDescriptor[]] = [delivery],
    purpose: DurableFilesystemPurpose = "asset_original",
  ) {
    const reserved = await repository.journal.reserve(operationScope, {
      purpose,
      leaseOwner: "publisher",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const candidate = await repository.issuePublicationCandidate(reserved.operation, {
      deliveryRelativePath: delivery.relativePath,
      cleanupDescriptors: cleanup
    });
    await repository.completePublicationCandidate(reserved.operation, candidate, delivery);
    return { ...reserved, candidate };
  }

  async function persistCandidate(
    repository: ReturnType<typeof createPostgresDurableFilesystemRepository>,
    operationScope: DurableFilesystemScope,
    delivery: PrivateStorageDescriptor,
    purpose: DurableFilesystemPurpose = "asset_original",
    expiresInMs = 60_000,
  ) {
    const reserved = await repository.journal.reserve(operationScope, {
      purpose,
      leaseOwner: "private-candidate-publisher",
      expiresAt: new Date(Date.now() + expiresInMs).toISOString()
    });
    const candidate = crypto.randomUUID() as AssetPublicationCandidate;
    const authority = bindPrivateFilesystemCandidateAuthority(
      reserved.operation,
      candidate,
      delivery,
    );
    const attachment = bindPrivateFilesystemCandidateAttachment(
      authority.reservation,
      authority.candidate,
      authority.descriptor,
      reserved.claim,
    );
    await repository.persistCandidate(attachment);
    return { ...reserved, authority, attachment };
  }

  async function attachPersistedCandidate(
    repository: ReturnType<typeof createPostgresDurableFilesystemRepository>,
    persisted: Awaited<ReturnType<typeof persistCandidate>>,
    bindDomain: (client: DatabaseClient, operationId: string) => Promise<void>,
  ) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await bindDomain(client, persisted.operation.operationId);
      const attached = await repository.attachCandidate(client, persisted.attachment);
      await client.query("COMMIT");
      return attached;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function attachAndCommit(
    repository: ReturnType<typeof createPostgresDurableFilesystemRepository>,
    reservation: ReservedFilesystemOperation,
    candidate: Awaited<ReturnType<typeof repository.issuePublicationCandidate>>,
    updateDomain: boolean,
    deliveryPath: string,
  ) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const attached = await repository.journal.attach(client, reservation, candidate);
      expect(attached.outcome).toBe("attached");
      if (attached.outcome !== "attached") throw new Error("attachment failed");
      if (updateDomain) {
        if (reservation.resourceKind !== "asset") throw new Error("asset reservation required");
        await client.query(
          `UPDATE assets
              SET storage_path=$3,filesystem_operation_id=$4
            WHERE id=$1 AND owner_user_id=$2`,
          [reservation.assetId, reservation.ownerUserId, deliveryPath, attached.operation.operationId]
        );
      }
      await client.query("COMMIT");
      return attached;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function expire(operationId: string): Promise<void> {
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=now()-interval '1 second',expires_at=now()-interval '1 second'
        WHERE id=$1`,
      [operationId]
    );
  }

  async function expectBackendBlockedBy(blockedPid: number, blockerPid: number): Promise<void> {
    await expect.poll(async () => {
      const blocked = await pool.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM pg_stat_activity activity
            WHERE activity.pid=$1
              AND $2::integer=ANY(pg_blocking_pids(activity.pid))
         ) AS blocked`,
        [blockedPid, blockerPid]
      );
      return blocked.rows[0]!.blocked;
    }, { timeout: 5_000 }).toBe(true);
  }

  async function waitUntilAfter(client: DatabaseClient, timestamp: string): Promise<void> {
    await client.query(
      `SELECT pg_sleep(
         GREATEST(EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))+0.1,0)
       )`,
      [timestamp]
    );
  }

  async function attachInTransaction(
    repository: ReturnType<typeof createPostgresDurableFilesystemRepository>,
    published: Awaited<ReturnType<typeof publish>>,
    domainWrite: (client: DatabaseClient, operationId: string) => Promise<void>,
  ) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const attached = await repository.journal.attach(client, published.operation, published.candidate);
      expect(attached.outcome).toBe("attached");
      if (attached.outcome !== "attached") throw new Error("attachment failed");
      await domainWrite(client, attached.operation.operationId);
      await client.query("COMMIT");
      return attached;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  it("persists publication evidence, attaches in the caller transaction, finalizes, and redeems owner-scoped identity", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const assetId = await asset();
    const operationScope = scope(assetId);
    const delivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "happy-delivery");
    const temporary = descriptor(`tmp/${crypto.randomUUID()}.part`, "happy-temp");
    const published = await publish(repository, operationScope, delivery, [temporary, delivery]);

    const beforeAttach = await pool.query<{ lifecycle: string; roles: string[] }>(
      `SELECT operation.lifecycle,
              array_agg(descriptor.descriptor_role ORDER BY descriptor.descriptor_role) AS roles
         FROM durable_filesystem_operations operation
         JOIN durable_filesystem_descriptors descriptor ON descriptor.operation_id=operation.id
        WHERE operation.id=$1 GROUP BY operation.lifecycle`,
      [published.operation.operationId]
    );
    expect(beforeAttach.rows[0]).toEqual({ lifecycle: "reserved", roles: ["cleanup", "cleanup", "delivery"] });

    const attached = await attachAndCommit(
      repository,
      published.operation,
      published.candidate,
      true,
      delivery.relativePath,
    );
    if (attached.outcome !== "attached") throw new Error("attachment failed");
    await expect(repository.journal.finalizeAfterCommit(attached.operation, attached.claim))
      .resolves.toEqual({ outcome: "finalized" });
    await expect(repository.journal.finalizeAfterCommit(attached.operation, attached.claim))
      .resolves.toEqual({ outcome: "already_finalized" });
  });

  it("persists only hashed candidate authority and rehydrates its exact descriptor after restart", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const assetId = await asset();
    const delivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "private-candidate-restart");
    const persisted = await persistCandidate(repository, scope(assetId), delivery);

    const stored = await pool.query<{
      candidate_token_hash: string;
      operation_id: string;
      lifecycle: string;
    }>(
      `SELECT candidate_token_hash,operation_id,lifecycle
         FROM durable_filesystem_candidate_authorities
        WHERE operation_id=$1`,
      [persisted.operation.operationId]
    );
    expect(stored.rows).toEqual([{
      candidate_token_hash: hash(persisted.authority.candidate),
      operation_id: persisted.operation.operationId,
      lifecycle: "issued"
    }]);
    expect(JSON.stringify(stored.rows)).not.toContain(persisted.authority.candidate);

    const restarted = createPostgresDurableFilesystemRepository(pool);
    await expect(restarted.redeemCandidate(persisted.attachment)).resolves.toEqual(delivery);
    for (const substituted of [
      {
        ...persisted.attachment,
        operation: { ...persisted.operation, ownerUserId: await owner("candidate-owner") }
      },
      {
        ...persisted.attachment,
        operation: { ...persisted.operation, assetId: await asset() }
      },
      {
        ...persisted.attachment,
        operation: { ...persisted.operation, purpose: "asset_derivative" }
      },
      {
        ...persisted.attachment,
        descriptor: { ...delivery, contentHash: hash("substituted-candidate-content") }
      }
    ]) {
      await expect(restarted.redeemCandidate(
        substituted as typeof persisted.attachment,
      )).resolves.toBeNull();
    }
  });

  it("attaches a persisted candidate atomically, keeps rollback retryable, and requires the exact asset binding", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const assetId = await asset();
    const delivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "private-attach-rollback");
    const persisted = await persistCandidate(repository, scope(assetId), delivery);
    const missingBinding = await pool.connect();
    try {
      await missingBinding.query("BEGIN");
      await expect(repository.attachCandidate(missingBinding, persisted.attachment))
        .resolves.toEqual({ outcome: "candidate_mismatch" });
      await missingBinding.query("ROLLBACK");
    } finally {
      missingBinding.release();
    }

    const rollingBack = await pool.connect();
    try {
      await rollingBack.query("BEGIN");
      await rollingBack.query(
        `UPDATE assets
            SET storage_path=$3,filesystem_operation_id=$4
          WHERE id=$1 AND owner_user_id=$2`,
        [assetId, ownerUserId, delivery.relativePath, persisted.operation.operationId]
      );
      await expect(repository.attachCandidate(rollingBack, persisted.attachment))
        .resolves.toMatchObject({ outcome: "attached" });
      await rollingBack.query("ROLLBACK");
    } finally {
      rollingBack.release();
    }

    const afterRollback = await pool.query<{ operation_lifecycle: string; candidate_lifecycle: string }>(
      `SELECT operation.lifecycle AS operation_lifecycle,candidate.lifecycle AS candidate_lifecycle
         FROM durable_filesystem_operations operation
         JOIN durable_filesystem_candidate_authorities candidate ON candidate.operation_id=operation.id
        WHERE operation.id=$1`,
      [persisted.operation.operationId]
    );
    expect(afterRollback.rows[0]).toEqual({
      operation_lifecycle: "reserved",
      candidate_lifecycle: "issued"
    });

    const restarted = createPostgresDurableFilesystemRepository(pool);
    const attached = await attachPersistedCandidate(restarted, persisted, async (client, operationId) => {
      await client.query(
        `UPDATE assets
            SET storage_path=$3,filesystem_operation_id=$4
          WHERE id=$1 AND owner_user_id=$2`,
        [assetId, ownerUserId, delivery.relativePath, operationId]
      );
    });
    expect(attached.outcome).toBe("attached");
  });

  it("accepts the exact serialized lease claim when PostgreSQL retains sub-millisecond precision", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const assetId = await asset();
    const delivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "private-attach-lease-precision");
    const persisted = await persistCandidate(repository, scope(assetId), delivery, "asset_original", 60 * 60 * 1000);
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=$2::timestamptz+interval '0.321 milliseconds'
        WHERE id=$1`,
      [persisted.operation.operationId, persisted.claim.leaseExpiresAt]
    );

    const attached = await attachPersistedCandidate(repository, persisted, async (client, operationId) => {
      await client.query(
        `UPDATE assets
            SET storage_path=$3,filesystem_operation_id=$4
          WHERE id=$1 AND owner_user_id=$2`,
        [assetId, ownerUserId, delivery.relativePath, operationId]
      );
    });
    expect(attached.outcome).toBe("attached");
  });

  it("rejects stale, foreign, and expired candidate lease claims after a recovery claimant wins", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const assetId = await asset();
    const delivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "private-candidate-reaper");
    const persisted = await persistCandidate(repository, scope(assetId), delivery);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE assets SET filesystem_operation_id=$3 WHERE id=$1 AND owner_user_id=$2",
        [assetId, ownerUserId, persisted.operation.operationId]
      );
      for (const claim of [
        { ...persisted.claim, workVersion: persisted.claim.workVersion + 1 },
        { ...persisted.claim, leaseId: crypto.randomUUID() },
        { ...persisted.claim, leaseOwner: "foreign-candidate-worker" },
        {
          ...persisted.claim,
          leaseExpiresAt: new Date(Date.parse(persisted.claim.leaseExpiresAt) + 1_000).toISOString()
        }
      ]) {
        await expect(repository.attachCandidate(client, {
          ...persisted.attachment,
          claim
        } as typeof persisted.attachment)).resolves.toEqual({ outcome: "stale" });
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    await expire(persisted.operation.operationId);
    const recovered = await repository.journal.recover({
      leaseOwner: "candidate-reaper-winner",
      leaseSeconds: 30,
      limit: 100
    });
    expect(recovered.some((record) => record.operation.operationId === persisted.operation.operationId)).toBe(true);
    const afterRecovery = await pool.connect();
    try {
      await afterRecovery.query("BEGIN");
      await expect(repository.attachCandidate(afterRecovery, persisted.attachment))
        .resolves.toEqual({ outcome: "stale" });
      await afterRecovery.query("ROLLBACK");
    } finally {
      afterRecovery.release();
    }
  });

  it("lets an in-flight candidate attachment win the operation lock over an expiry reaper", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const assetId = await asset();
    const delivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "private-candidate-attach-race");
    const persisted = await persistCandidate(repository, scope(assetId), delivery, "asset_original", 2_000);
    const attaching = await pool.connect();
    try {
      await attaching.query("BEGIN");
      await attaching.query(
        "UPDATE assets SET filesystem_operation_id=$3 WHERE id=$1 AND owner_user_id=$2",
        [assetId, ownerUserId, persisted.operation.operationId]
      );
      await expect(repository.attachCandidate(attaching, persisted.attachment))
        .resolves.toMatchObject({ outcome: "attached" });
      await attaching.query("SELECT pg_sleep(2.1)");
      const recovered = await repository.journal.recover({
        leaseOwner: "candidate-race-reaper",
        leaseSeconds: 30,
        limit: 100
      });
      expect(recovered.some((record) => record.operation.operationId === persisted.operation.operationId)).toBe(false);
      await attaching.query("COMMIT");
    } finally {
      await attaching.query("ROLLBACK").catch(() => undefined);
      attaching.release();
    }
  });

  it("rejects a candidate attachment that expires while waiting for the operation lock", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const assetId = await asset();
    const delivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "private-candidate-lock-expiry");
    const persisted = await persistCandidate(repository, scope(assetId), delivery, "asset_original", 2_000);
    const attaching = await pool.connect();
    const blocker = await pool.connect();
    try {
      await attaching.query("BEGIN");
      const attachingBackend = await attaching.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await attaching.query(
        "UPDATE assets SET filesystem_operation_id=$3 WHERE id=$1 AND owner_user_id=$2",
        [assetId, ownerUserId, persisted.operation.operationId]
      );

      await blocker.query("BEGIN");
      const blockerBackend = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query(
        "SELECT id FROM durable_filesystem_operations WHERE id=$1 FOR NO KEY UPDATE",
        [persisted.operation.operationId]
      );

      const attachment = repository.attachCandidate(attaching, persisted.attachment);
      await expectBackendBlockedBy(attachingBackend.rows[0]!.pid, blockerBackend.rows[0]!.pid);
      await waitUntilAfter(blocker, persisted.claim.leaseExpiresAt);
      await blocker.query("COMMIT");

      await expect(attachment).resolves.toEqual({ outcome: "stale" });
      await attaching.query("ROLLBACK");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await attaching.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      attaching.release();
    }

    const lifecycle = await pool.query<{
      operation_lifecycle: string;
      candidate_lifecycle: string;
    }>(
      `SELECT operation.lifecycle AS operation_lifecycle,candidate.lifecycle AS candidate_lifecycle
         FROM durable_filesystem_operations operation
         JOIN durable_filesystem_candidate_authorities candidate ON candidate.operation_id=operation.id
        WHERE operation.id=$1`,
      [persisted.operation.operationId]
    );
    expect(lifecycle.rows[0]).toEqual({
      operation_lifecycle: "reserved",
      candidate_lifecycle: "issued"
    });
  });

  it("requires an exact derivative filesystem-operation binding before private attachment", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const sourceAssetId = await asset();
    const delivery = descriptor(`derivatives/${hash(crypto.randomUUID())}.webp`, "private-derivative-binding");
    const persisted = await persistCandidate(
      repository,
      scope(sourceAssetId),
      delivery,
      "asset_derivative",
    );
    const unbound = await pool.connect();
    try {
      await unbound.query("BEGIN");
      await unbound.query(
        `INSERT INTO asset_derivatives (
           owner_user_id,source_asset_id,derivative_kind,transform_version,pixel_width,pixel_height,
           storage_driver,storage_path,mime_type,byte_length,content_hash
         ) VALUES ($1,$2,'thumbnail',1,480,270,'filesystem',$3,'image/webp',$4,$5)`,
        [ownerUserId, sourceAssetId, delivery.relativePath, delivery.byteLength, delivery.contentHash]
      );
      await expect(repository.attachCandidate(unbound, persisted.attachment))
        .resolves.toEqual({ outcome: "candidate_mismatch" });
      await unbound.query("ROLLBACK");
    } finally {
      unbound.release();
    }

    const attached = await attachPersistedCandidate(repository, persisted, async (client, operationId) => {
      await client.query(
        `INSERT INTO asset_derivatives (
           owner_user_id,source_asset_id,derivative_kind,transform_version,pixel_width,pixel_height,
           storage_driver,storage_path,mime_type,byte_length,content_hash,filesystem_operation_id
         ) VALUES ($1,$2,'thumbnail',1,480,270,'filesystem',$3,'image/webp',$4,$5,$6)`,
        [ownerUserId, sourceAssetId, delivery.relativePath, delivery.byteLength, delivery.contentHash, operationId]
      );
    });
    expect(attached.outcome).toBe("attached");
  });

  it("accepts only an adoption change-token transition and persists the actual delivery descriptor", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const assetId = await asset();
    const operationScope = scope(assetId);
    const provisional = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "provisional-adoption");
    const delivery = {
      ...provisional,
      identity: {
        ...provisional.identity,
        changeToken: "change-after-link-and-unlink"
      }
    } satisfies PrivateStorageDescriptor;
    const reserved = await repository.journal.reserve(operationScope, {
      purpose: "asset_original",
      leaseOwner: "publisher",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const candidate = await repository.issuePublicationCandidate(reserved.operation, {
      deliveryRelativePath: delivery.relativePath,
      cleanupDescriptors: [provisional]
    });

    await expect(repository.completePublicationCandidate(reserved.operation, candidate, delivery))
      .resolves.toBeUndefined();
    const persisted = await pool.query<{
      descriptor_role: string;
      change_token: string;
    }>(
      `SELECT descriptor_role,change_token
         FROM durable_filesystem_descriptors
        WHERE operation_id=$1
        ORDER BY descriptor_role`,
      [reserved.operation.operationId]
    );
    expect(persisted.rows).toEqual([
      { descriptor_role: "cleanup", change_token: provisional.identity.changeToken },
      { descriptor_role: "delivery", change_token: delivery.identity.changeToken }
    ]);

    const attached = await attachAndCommit(
      repository,
      reserved.operation,
      candidate,
      true,
      delivery.relativePath,
    );
    if (attached.outcome !== "attached") throw new Error("attachment failed");
    await expect(repository.journal.finalizeAfterCommit(attached.operation, attached.claim))
      .resolves.toEqual({ outcome: "finalized" });

    expect(attached.operation).toMatchObject(operationScope);
  });

  it.each([
    {
      mismatch: "relative path",
      mutate: (value: PrivateStorageDescriptor): PrivateStorageDescriptor => ({
        ...value,
        relativePath: `originals/${hash(crypto.randomUUID())}.png`
      })
    },
    {
      mismatch: "device",
      mutate: (value: PrivateStorageDescriptor): PrivateStorageDescriptor => ({
        ...value,
        identity: { ...value.identity, deviceId: "different-device" }
      })
    },
    {
      mismatch: "inode",
      mutate: (value: PrivateStorageDescriptor): PrivateStorageDescriptor => ({
        ...value,
        identity: { ...value.identity, fileId: "different-file" }
      })
    },
    {
      mismatch: "content hash",
      mutate: (value: PrivateStorageDescriptor): PrivateStorageDescriptor => ({
        ...value,
        contentHash: hash("different-content")
      })
    },
    {
      mismatch: "byte length",
      mutate: (value: PrivateStorageDescriptor): PrivateStorageDescriptor => ({
        ...value,
        byteLength: value.byteLength + 1
      })
    }
  ])("rejects a publication candidate with a mismatched $mismatch", async ({ mutate }) => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const provisional = descriptor(`originals/${hash(crypto.randomUUID())}.png`, crypto.randomUUID());
    const reserved = await repository.journal.reserve(scope(await asset()), {
      purpose: "asset_original",
      leaseOwner: "publisher",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const candidate = await repository.issuePublicationCandidate(reserved.operation, {
      deliveryRelativePath: provisional.relativePath,
      cleanupDescriptors: [provisional]
    });

    await expect(repository.completePublicationCandidate(
      reserved.operation,
      candidate,
      mutate(provisional),
    )).rejects.toThrow("durable_filesystem_candidate_mismatch");
  });

  it("deduplicates cleanup paths and prefers the immutable actual delivery identity", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const provisional = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "cleanup-provisional");
    const temporary = descriptor(`tmp/${crypto.randomUUID()}.part`, "cleanup-temporary");
    const delivery = {
      ...provisional,
      identity: { ...provisional.identity, changeToken: "cleanup-after-adoption" }
    } satisfies PrivateStorageDescriptor;
    const reserved = await repository.journal.reserve(scope(await asset()), {
      purpose: "asset_original",
      leaseOwner: "publisher",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const candidate = await repository.issuePublicationCandidate(reserved.operation, {
      deliveryRelativePath: delivery.relativePath,
      cleanupDescriptors: [temporary, provisional, provisional]
    });
    await repository.completePublicationCandidate(reserved.operation, candidate, delivery);
    await expect(repository.journal.markCleanup(
      reserved.operation,
      reserved.claim,
      { cause: "rollback" },
    )).resolves.toEqual({ outcome: "cleanup_pending" });

    await expect(repository.preparePublicationCleanup(reserved.operation, reserved.claim))
      .resolves.toEqual({ outcome: "cleanup_required", descriptors: [temporary, delivery] });
  });

  it("recovers crashes before publication, after publication, after rollback, and on either side of the domain commit", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);

    const prePublication = await repository.journal.reserve(scope(await asset()), {
      purpose: "asset_original",
      leaseOwner: "crashed-before-publication",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await expire(prePublication.operation.operationId);

    const afterPublicationDelivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "after-publication");
    const afterPublication = await publish(repository, scope(await asset()), afterPublicationDelivery);
    await expire(afterPublication.operation.operationId);

    const rollbackDelivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "rollback");
    const rollback = await publish(repository, scope(await asset()), rollbackDelivery);
    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query("BEGIN");
      expect((await repository.journal.attach(
        rollbackClient,
        rollback.operation,
        rollback.candidate,
      )).outcome).toBe("attached");
      await rollbackClient.query("ROLLBACK");
    } finally {
      rollbackClient.release();
    }
    await expire(rollback.operation.operationId);

    const beforeDomainDelivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "before-domain");
    const beforeDomain = await publish(repository, scope(await asset()), beforeDomainDelivery);
    const beforeDomainAttached = await attachAndCommit(
      repository,
      beforeDomain.operation,
      beforeDomain.candidate,
      false,
      beforeDomainDelivery.relativePath,
    );
    if (beforeDomainAttached.outcome !== "attached") throw new Error("attachment failed");
    await expire(beforeDomain.operation.operationId);

    const afterDomainDelivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "after-domain");
    const afterDomain = await publish(repository, scope(await asset()), afterDomainDelivery);
    const afterDomainAttached = await attachAndCommit(
      repository,
      afterDomain.operation,
      afterDomain.candidate,
      true,
      afterDomainDelivery.relativePath,
    );
    if (afterDomainAttached.outcome !== "attached") throw new Error("attachment failed");
    await expire(afterDomain.operation.operationId);

    const recovered = await repository.journal.recover({ leaseOwner: "reaper-a", leaseSeconds: 30, limit: 20 });
    const actionById = new Map(recovered.map((record) => [record.operation.operationId, record.action]));
    expect(actionById.get(prePublication.operation.operationId)).toBe("cleanup");
    expect(actionById.get(afterPublication.operation.operationId)).toBe("cleanup");
    expect(actionById.get(rollback.operation.operationId)).toBe("cleanup");
    expect(actionById.get(beforeDomain.operation.operationId)).toBe("cleanup");
    expect(actionById.get(afterDomain.operation.operationId)).toBe("finalize");
    expect(recovered.every((record) => record.operation.ownerUserId === ownerUserId)).toBe(true);

    const expectedIds = new Set([
      prePublication.operation.operationId,
      afterPublication.operation.operationId,
      rollback.operation.operationId,
      beforeDomain.operation.operationId,
      afterDomain.operation.operationId
    ]);
    for (const record of recovered.filter((item) => expectedIds.has(item.operation.operationId))) {
      if (record.action === "finalize") {
        await expect(repository.journal.finalizeAfterCommit(record.operation, record.claim))
          .resolves.toEqual({ outcome: "finalized" });
      } else {
        await expect(repository.journal.markCleanup(
          record.operation,
          record.claim,
          { cause: "recovery" },
        )).resolves.toEqual({ outcome: "cleanup_pending" });
        await expect(repository.preparePublicationCleanup(record.operation, record.claim))
          .resolves.toMatchObject({ outcome: "cleanup_required" });
        await expect(repository.journal.completeCleanup(record.operation, record.claim))
          .resolves.toEqual({ outcome: "cleaned" });
      }
    }
    const terminal = await pool.query<{ id: string; lifecycle: string }>(
      "SELECT id,lifecycle FROM durable_filesystem_operations WHERE id=ANY($1::uuid[])",
      [[...expectedIds]]
    );
    expect(new Map(terminal.rows.map((row) => [row.id, row.lifecycle]))).toEqual(new Map([
      [prePublication.operation.operationId, "cleaned"],
      [afterPublication.operation.operationId, "cleaned"],
      [rollback.operation.operationId, "cleaned"],
      [beforeDomain.operation.operationId, "cleaned"],
      [afterDomain.operation.operationId, "finalized"]
    ]));
  });

  it.each([
    { purpose: "portable_staging" as const, resourceLabel: "staging" },
    { purpose: "portable_export" as const, resourceLabel: "export" }
  ])("recovers $resourceLabel operations from persisted portable scope and reaches terminal acknowledgement", async ({ purpose }) => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const operationScope: DurableFilesystemScope = {
      resourceKind: "portable",
      ownerUserId,
      operationScopeId: `${purpose}-${crypto.randomUUID()}`
    };
    const delivery = descriptor(`${purpose}/${hash(crypto.randomUUID())}.bin`, purpose);
    const published = await publish(repository, operationScope, delivery, [delivery], purpose);
    const attached = await attachInTransaction(repository, published, async (client, operationId) => {
      if (purpose === "portable_staging") {
        await client.query(
          `INSERT INTO portable_staged_inputs (
             owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
           ) VALUES ($1,$2,$3,$4,$5,now()+interval '1 day')`,
          [ownerUserId, hash(crypto.randomUUID()), operationId, delivery.contentHash, delivery.byteLength]
        );
        return;
      }
      const world = await client.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
        [ownerUserId, `Durable export ${crypto.randomUUID()}`]
      );
      const version = await client.query<{ id: string }>(
        `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
         VALUES ($1,$2,1,'{}'::jsonb) RETURNING id`,
        [world.rows[0]!.id, ownerUserId]
      );
      await client.query(
        `INSERT INTO portable_export_artifacts (
           owner_user_id,retrieval_token_hash,filesystem_operation_id,export_kind,
           world_id,world_version_id,content_type,content_hash,byte_length,expires_at
         ) VALUES ($1,$2,$3,'world_json',$4,$5,'application/json',$6,$7,now()+interval '1 day')`,
        [
          ownerUserId,
          hash(crypto.randomUUID()),
          operationId,
          world.rows[0]!.id,
          version.rows[0]!.id,
          delivery.contentHash,
          delivery.byteLength
        ]
      );
    });
    await expire(attached.operation.operationId);
    const recovered = await repository.journal.recover({
      leaseOwner: `${purpose}-reaper`,
      leaseSeconds: 30,
      limit: 100
    });
    const record = recovered.find((item) => item.operation.operationId === attached.operation.operationId);
    expect(record?.action).toBe("finalize");
    if (!record || record.action !== "finalize") throw new Error("expected portable finalize recovery");
    await expect(repository.journal.finalizeAfterCommit(record.operation, record.claim))
      .resolves.toEqual({ outcome: "finalized" });
    await expect(repository.journal.finalizeAfterCommit(record.operation, record.claim))
      .resolves.toEqual({ outcome: "already_finalized" });

    const abandonedScope: DurableFilesystemScope = {
      resourceKind: "portable",
      ownerUserId,
      operationScopeId: `${purpose}-abandoned-${crypto.randomUUID()}`
    };
    const abandonedDelivery = descriptor(`${purpose}/${hash(crypto.randomUUID())}.tmp`, `${purpose}-abandoned`);
    const abandoned = await publish(repository, abandonedScope, abandonedDelivery, [abandonedDelivery], purpose);
    await expire(abandoned.operation.operationId);
    const cleanupRecovery = await repository.journal.recover({
      leaseOwner: `${purpose}-cleanup-reaper`,
      leaseSeconds: 30,
      limit: 100
    });
    const cleanup = cleanupRecovery.find((item) => item.operation.operationId === abandoned.operation.operationId);
    expect(cleanup?.action).toBe("cleanup");
    if (!cleanup || cleanup.action !== "cleanup") throw new Error("expected portable cleanup recovery");
    await expect(repository.journal.markCleanup(cleanup.operation, cleanup.claim, { cause: "recovery" }))
      .resolves.toEqual({ outcome: "cleanup_pending" });
    await expect(repository.preparePublicationCleanup(cleanup.operation, cleanup.claim))
      .resolves.toEqual({ outcome: "cleanup_required", descriptors: [abandonedDelivery] });
    await expect(repository.journal.completeCleanup(cleanup.operation, cleanup.claim))
      .resolves.toEqual({ outcome: "cleaned" });
    await expect(repository.journal.completeCleanup(cleanup.operation, cleanup.claim))
      .resolves.toEqual({ outcome: "already_cleaned" });
  });

  it("does not treat another owner's shared path as this operation's domain commit", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const delivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "foreign-finalize");
    const localAssetId = await asset();
    const foreignOwner = await owner("foreign-finalize");
    await asset(foreignOwner, delivery.relativePath);
    const published = await publish(repository, scope(localAssetId), delivery);
    const attached = await attachAndCommit(
      repository,
      published.operation,
      published.candidate,
      false,
      delivery.relativePath,
    );
    if (attached.outcome !== "attached") throw new Error("attachment failed");
    await expire(attached.operation.operationId);
    const recovered = await repository.journal.recover({ leaseOwner: "foreign-path-reaper", leaseSeconds: 30, limit: 100 });
    const record = recovered.find((item) => item.operation.operationId === attached.operation.operationId);
    expect(record?.action).toBe("cleanup");
    if (!record || record.action !== "cleanup") throw new Error("expected cleanup recovery");
    await expect(repository.journal.markCleanup(record.operation, record.claim, { cause: "recovery" }))
      .resolves.toEqual({ outcome: "cleanup_pending" });
    await expect(repository.preparePublicationCleanup(record.operation, record.claim))
      .resolves.toEqual({ outcome: "cleanup_required", descriptors: [] });
  });

  it("finalizes a derivative only from the exact owner and source asset reference", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const sourceAssetId = await asset();
    const delivery = descriptor(`derivatives/${hash(crypto.randomUUID())}.webp`, "local-derivative");
    const published = await publish(
      repository,
      scope(sourceAssetId),
      delivery,
      [delivery],
      "asset_derivative",
    );
    const attached = await attachInTransaction(repository, published, async (client) => {
      await client.query(
        `INSERT INTO asset_derivatives (
           owner_user_id,source_asset_id,derivative_kind,transform_version,pixel_width,pixel_height,
           storage_driver,storage_path,mime_type,byte_length,content_hash,filesystem_operation_id
         ) VALUES ($1,$2,'thumbnail',1,480,270,'filesystem',$3,'image/webp',$4,$5,$6)`,
        [
          ownerUserId,
          sourceAssetId,
          delivery.relativePath,
          delivery.byteLength,
          delivery.contentHash,
          published.operation.operationId
        ]
      );
    });
    await expire(attached.operation.operationId);
    const recovered = await repository.journal.recover({ leaseOwner: "derivative-reaper", leaseSeconds: 30, limit: 100 });
    const record = recovered.find((item) => item.operation.operationId === attached.operation.operationId);
    expect(record?.action).toBe("finalize");
  });

  it("does not classify same-owner path heuristics as original or derivative domain bindings", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const originalAssetId = await asset();
    const originalDelivery = descriptor(
      `originals/${hash(crypto.randomUUID())}.png`,
      "unbound-original-heuristic",
    );
    const original = await publish(repository, scope(originalAssetId), originalDelivery);
    const originalAttached = await attachInTransaction(repository, original, async (client) => {
      await client.query(
        "UPDATE assets SET storage_path=$3 WHERE id=$1 AND owner_user_id=$2",
        [originalAssetId, ownerUserId, originalDelivery.relativePath]
      );
    });

    const sourceAssetId = await asset();
    const derivativeDelivery = descriptor(
      `derivatives/${hash(crypto.randomUUID())}.webp`,
      "unbound-derivative-heuristic",
    );
    const derivative = await publish(
      repository,
      scope(sourceAssetId),
      derivativeDelivery,
      [derivativeDelivery],
      "asset_derivative",
    );
    const derivativeAttached = await attachInTransaction(repository, derivative, async (client) => {
      await client.query(
        `INSERT INTO asset_derivatives (
           owner_user_id,source_asset_id,derivative_kind,transform_version,pixel_width,pixel_height,
           storage_driver,storage_path,mime_type,byte_length,content_hash
         ) VALUES ($1,$2,'thumbnail',1,480,270,'filesystem',$3,'image/webp',$4,$5)`,
        [
          ownerUserId,
          sourceAssetId,
          derivativeDelivery.relativePath,
          derivativeDelivery.byteLength,
          derivativeDelivery.contentHash
        ]
      );
    });

    if (originalAttached.outcome !== "attached" || derivativeAttached.outcome !== "attached") {
      throw new Error("attachment failed");
    }
    await expire(originalAttached.operation.operationId);
    await expire(derivativeAttached.operation.operationId);
    const recovered = await repository.journal.recover({
      leaseOwner: "exact-binding-reaper",
      leaseSeconds: 30,
      limit: 100
    });
    const actionById = new Map(recovered.map((record) => [record.operation.operationId, record.action]));
    expect(actionById.get(originalAttached.operation.operationId)).toBe("cleanup");
    expect(actionById.get(derivativeAttached.operation.operationId)).toBe("cleanup");
  });

  it("uses SKIP LOCKED for competing reapers and rejects a stale lease fence", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const first = await repository.journal.reserve(scope(await asset()), {
      purpose: "asset_original",
      leaseOwner: "publisher",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const second = await repository.journal.reserve(scope(await asset()), {
      purpose: "asset_original",
      leaseOwner: "publisher",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await expire(first.operation.operationId);
    await expire(second.operation.operationId);

    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT 1 FROM durable_filesystem_operations WHERE id=$1 FOR UPDATE", [first.operation.operationId]);
      const claimed = await repository.journal.recover({ leaseOwner: "reaper-b", leaseSeconds: 30, limit: 100 });
      expect(claimed.some((record) => record.operation.operationId === second.operation.operationId)).toBe(true);
      expect(claimed.some((record) => record.operation.operationId === first.operation.operationId)).toBe(false);
      await locker.query("ROLLBACK");

      await expect(repository.journal.completeCleanup(
        claimed.find((record) => record.operation.operationId === second.operation.operationId)!.operation,
        first.claim,
      )).resolves.toEqual({ outcome: "stale" });
    } finally {
      locker.release();
    }
  });

  it("retains shared physical paths referenced by any owner while returning unreferenced cleanup identities", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const sharedPath = `originals/${hash(crypto.randomUUID())}.png`;
    const sharedDerivativePath = `derivatives/${hash(crypto.randomUUID())}.webp`;
    const foreignOwner = await owner("shared-reference");
    const foreignAssetId = await asset(foreignOwner, sharedPath);
    await pool.query(
      `INSERT INTO asset_derivatives (
         owner_user_id,source_asset_id,derivative_kind,transform_version,
         pixel_width,pixel_height,storage_driver,storage_path,mime_type,byte_length,content_hash
       ) VALUES ($1,$2,'thumbnail',1,480,270,'filesystem',$3,'image/webp',64,$4)`,
      [foreignOwner, foreignAssetId, sharedDerivativePath, hash("shared-derivative")]
    );

    const delivery = descriptor(sharedPath, "shared-delivery");
    const derivative = descriptor(sharedDerivativePath, "shared-derivative");
    const temporary = descriptor(`tmp/${crypto.randomUUID()}.part`, "shared-temp");
    const published = await publish(repository, scope(await asset()), delivery, [delivery, derivative, temporary]);
    const marked = await repository.journal.markCleanup(
      published.operation,
      published.claim,
      { cause: "rollback" },
    );
    expect(marked).toEqual({ outcome: "cleanup_pending" });

    const prepared = await repository.preparePublicationCleanup(published.operation, published.claim);
    expect(prepared).toEqual({ outcome: "cleanup_required", descriptors: [temporary] });
  });

  it("acquires physical cleanup path locks in sorted order", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const firstPath = `tmp/a-${crypto.randomUUID()}.part`;
    const lastPath = `tmp/z-${crypto.randomUUID()}.part`;
    const delivery = descriptor(lastPath, "sorted-last");
    const first = descriptor(firstPath, "sorted-first");
    const published = await publish(repository, scope(await asset()), delivery, [delivery, first]);
    await repository.journal.markCleanup(published.operation, published.claim, { cause: "rollback" });

    const blocker = await pool.connect();
    const probe = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`infinite-quest-nexus:asset-path:${firstPath}`]
      );
      const preparing = repository.preparePublicationCleanup(published.operation, published.claim);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      await probe.query("BEGIN");
      const laterLock = await probe.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
        [`infinite-quest-nexus:asset-path:${lastPath}`]
      );
      expect(laterLock.rows[0]!.acquired).toBe(true);
      await probe.query("ROLLBACK");
      await blocker.query("COMMIT");
      await expect(preparing).resolves.toMatchObject({ outcome: "cleanup_required" });
    } finally {
      await probe.query("ROLLBACK").catch(() => undefined);
      await blocker.query("ROLLBACK").catch(() => undefined);
      probe.release();
      blocker.release();
    }
  });

  it("keeps cleanup retryable until the fenced acknowledgement and makes a repeated acknowledgement idempotent", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const delivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "cleanup-retry");
    const published = await publish(repository, scope(await asset()), delivery);
    await expect(repository.journal.markCleanup(
      published.operation,
      published.claim,
      { cause: "rollback", diagnosticCode: "asset_storage_unavailable" },
    )).resolves.toEqual({ outcome: "cleanup_pending" });

    const first = await repository.preparePublicationCleanup(published.operation, published.claim);
    const afterFilesystemDelete = await repository.preparePublicationCleanup(published.operation, published.claim);
    expect(afterFilesystemDelete).toEqual(first);
    await expect(repository.journal.completeCleanup(published.operation, published.claim))
      .resolves.toEqual({ outcome: "cleaned" });
    await expect(repository.journal.completeCleanup(published.operation, published.claim))
      .resolves.toEqual({ outcome: "already_cleaned" });
    await expect(repository.preparePublicationCleanup(published.operation, published.claim))
      .resolves.toEqual({ outcome: "already_cleaned" });
  });

  it("rejects wrong lease identity at finalized and cleaned terminal states", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const finalizedDelivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "terminal-finalized");
    const finalized = await publish(repository, scope(await asset()), finalizedDelivery);
    const attached = await attachAndCommit(
      repository,
      finalized.operation,
      finalized.candidate,
      true,
      finalizedDelivery.relativePath,
    );
    if (attached.outcome !== "attached") throw new Error("attachment failed");
    await repository.journal.finalizeAfterCommit(attached.operation, attached.claim);
    const wrongFinalizedClaim = {
      ...attached.claim,
      leaseId: crypto.randomUUID()
    } as DurableFilesystemRecoveryClaim;
    await expect(repository.journal.finalizeAfterCommit(attached.operation, wrongFinalizedClaim))
      .resolves.toEqual({ outcome: "lease_lost" });
    const wrongFinalizedExpiry = {
      ...attached.claim,
      leaseExpiresAt: new Date(Date.parse(attached.claim.leaseExpiresAt) + 1_000).toISOString()
    } as DurableFilesystemRecoveryClaim;
    await expect(repository.journal.finalizeAfterCommit(attached.operation, wrongFinalizedExpiry))
      .resolves.toEqual({ outcome: "lease_lost" });

    const cleanedDelivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "terminal-cleaned");
    const cleaned = await publish(repository, scope(await asset()), cleanedDelivery);
    await repository.journal.markCleanup(cleaned.operation, cleaned.claim, { cause: "rollback" });
    await repository.journal.completeCleanup(cleaned.operation, cleaned.claim);
    const wrongCleanedClaim = {
      ...cleaned.claim,
      leaseOwner: "wrong-terminal-owner"
    } as DurableFilesystemRecoveryClaim;
    await expect(repository.journal.completeCleanup(cleaned.operation, wrongCleanedClaim))
      .resolves.toEqual({ outcome: "lease_lost" });
  });

  it("keeps a persistent cleanup path fence through acknowledgement and closes both attach race orders", async () => {
    const repository = createPostgresDurableFilesystemRepository(pool);
    const sharedDelivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "cleanup-fence");
    const cleanup = await publish(repository, scope(await asset()), sharedDelivery);
    await repository.journal.markCleanup(cleanup.operation, cleanup.claim, { cause: "rollback" });
    await expect(repository.preparePublicationCleanup(cleanup.operation, cleanup.claim))
      .resolves.toEqual({ outcome: "cleanup_required", descriptors: [sharedDelivery] });

    const foreignOwner = await owner("cleanup-fence");
    const foreignAssetId = await asset(foreignOwner);
    const foreign = await publish(
      repository,
      scope(foreignAssetId, foreignOwner),
      sharedDelivery,
    );
    const rejectedClient = await pool.connect();
    try {
      await rejectedClient.query("BEGIN");
      await expect(repository.journal.attach(rejectedClient, foreign.operation, foreign.candidate))
        .resolves.toEqual({ outcome: "stale" });
      await rejectedClient.query("ROLLBACK");
    } finally {
      rejectedClient.release();
    }
    await expect(repository.journal.completeCleanup(cleanup.operation, cleanup.claim))
      .resolves.toEqual({ outcome: "cleaned" });
    const republished = await publish(
      repository,
      scope(foreignAssetId, foreignOwner),
      sharedDelivery,
    );
    const afterAcknowledgement = await pool.connect();
    try {
      await afterAcknowledgement.query("BEGIN");
      expect((await repository.journal.attach(
        afterAcknowledgement,
        republished.operation,
        republished.candidate,
      )).outcome).toBe("attached");
      await afterAcknowledgement.query("ROLLBACK");
    } finally {
      afterAcknowledgement.release();
    }

    const secondDelivery = descriptor(`originals/${hash(crypto.randomUUID())}.png`, "cleanup-fence-ordered");
    const secondCleanup = await publish(repository, scope(await asset()), secondDelivery);
    const secondForeignOwner = await owner("cleanup-fence-ordered");
    const secondForeignAssetId = await asset(secondForeignOwner);
    const secondForeign = await publish(
      repository,
      scope(secondForeignAssetId, secondForeignOwner),
      secondDelivery,
    );
    const attaching = await pool.connect();
    try {
      await attaching.query("BEGIN");
      const attached = await repository.journal.attach(
        attaching,
        secondForeign.operation,
        secondForeign.candidate,
      );
      expect(attached.outcome).toBe("attached");
      await repository.journal.markCleanup(secondCleanup.operation, secondCleanup.claim, { cause: "rollback" });
      let prepared = false;
      const preparing = repository.preparePublicationCleanup(secondCleanup.operation, secondCleanup.claim)
        .finally(() => { prepared = true; });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      expect(prepared).toBe(false);
      await attaching.query(
        "UPDATE assets SET storage_path=$3 WHERE id=$1 AND owner_user_id=$2",
        [secondForeignAssetId, secondForeignOwner, secondDelivery.relativePath]
      );
      await attaching.query("COMMIT");
      await expect(preparing).resolves.toEqual({ outcome: "cleanup_required", descriptors: [] });
      await expect(repository.journal.completeCleanup(secondCleanup.operation, secondCleanup.claim))
        .resolves.toEqual({ outcome: "cleaned" });
    } finally {
      await attaching.query("ROLLBACK").catch(() => undefined);
      attaching.release();
    }
  });
});
