import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AttachedFilesystemOperation,
  DurableFilesystemRecoveryClaim,
  DurableFilesystemScope,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
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
  ) {
    const reserved = await repository.journal.reserve(operationScope, {
      purpose: "asset_original",
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
      if (updateDomain) {
        if (reservation.resourceKind !== "asset") throw new Error("asset reservation required");
        await client.query(
          "UPDATE assets SET storage_path=$3 WHERE id=$1 AND owner_user_id=$2",
          [reservation.assetId, reservation.ownerUserId, deliveryPath]
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
    await expect(repository.redeemStorageLocator(operationScope, attached.locator)).resolves.toEqual(delivery);
    await expect(repository.redeemStorageLocator(
      { ...operationScope, ownerUserId: await owner("wrong-owner") },
      attached.locator,
    )).resolves.toBeNull();
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
});
