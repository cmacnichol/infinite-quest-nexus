import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bindPrivateFilesystemCandidateAttachment,
  type PrivateFilesystemCandidateAttachment
} from "../../packages/application/src/assets/private-filesystem-repository.js";
import {
  bindPrivatePrewriteNodeAuthority,
  bindPrivatePrewriteTargetAuthority,
  type PrivatePrewriteCleanupPreparation
} from "../../packages/application/src/assets/private-secure-storage.js";
import type {
  PrivateStorageDescriptor,
  ReservedFilesystemOperation
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import {
  bindPrivateAtomicExportIssuance,
  bindPrivateAtomicStagedIssuance,
  type PortableExportScope,
  type PrivatePortableStagedIssuance
} from "../../packages/application/src/imports/private-portable-authority.js";
import {
  createPostgresDurableFilesystemRepository,
  type PostgresDurableFilesystemRepository
} from "../../packages/database/src/durable-filesystem-repository.js";
import { createPostgresImportRepository } from "../../packages/database/src/import-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  withTransaction,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import {
  createPostgresSecureStorageRepository,
  type PostgresSecureStorageRepository
} from "../../packages/database/src/secure-storage-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type WorldScope = Readonly<{
  campaignId: string;
  worldId: string;
  worldVersionId: string;
}>;

integration("Task 14e3b4 secure storage repository", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let world: WorldScope;
  let durable: PostgresDurableFilesystemRepository;
  let secure: PostgresSecureStorageRepository;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 10);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    world = await createWorld();
    durable = createPostgresDurableFilesystemRepository(pool);
    secure = createPostgresSecureStorageRepository(pool, durable);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createWorld(): Promise<WorldScope> {
    const createdWorld = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `b4-${crypto.randomUUID()}`],
    );
    const worldId = createdWorld.rows[0]!.id;
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,'{}'::jsonb) RETURNING id`,
      [worldId, ownerUserId],
    );
    const worldVersionId = version.rows[0]!.id;
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (owner_user_id,world_version_id,title)
       VALUES ($1,$2,'b4') RETURNING id`,
      [ownerUserId, worldVersionId],
    );
    return { worldId, worldVersionId, campaignId: campaign.rows[0]!.id };
  }

  function descriptor(label: string, operationId?: string): PrivateStorageDescriptor {
    return {
      relativePath: operationId
        ? `${label}/${operationId}.pending`
        : `${label}/${crypto.randomUUID()}.pending`,
      identity: {
        deviceId: `device-${label}`,
        fileId: `file-${label}`,
        changeToken: `change-${label}`
      },
      contentHash: sha256(`${label}-${crypto.randomUUID()}`),
      byteLength: 37
    };
  }

  async function candidate(
    purpose: "portable_staging" | "portable_export",
    expiresAt = new Date(Date.now() + 60_000).toISOString(),
  ): Promise<Readonly<{
    attachment: PrivateFilesystemCandidateAttachment;
    operation: ReservedFilesystemOperation;
    scopeId: string;
    descriptor: PrivateStorageDescriptor;
  }>> {
    const scopeId = `${purpose}:${crypto.randomUUID()}`;
    const reserved = await durable.journal.reserve(
      { resourceKind: "portable", ownerUserId, operationScopeId: scopeId },
      { purpose, leaseOwner: `b4-${purpose}`, expiresAt },
    );
    const value = descriptor(purpose);
    const bearer = await durable.issuePublicationCandidate(reserved.operation, {
      deliveryRelativePath: value.relativePath,
      cleanupDescriptors: [value]
    });
    await durable.completePublicationCandidate(reserved.operation, bearer, value);
    return {
      attachment: bindPrivateFilesystemCandidateAttachment(
        reserved.operation,
        bearer,
        value,
        reserved.claim,
      ),
      operation: reserved.operation,
      scopeId,
      descriptor: value
    };
  }

  async function waitForExpiry(expiresAt: string): Promise<void> {
    await pool.query(
      `SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05)`,
      [expiresAt],
    );
  }

  it("atomically inserts and exact-attaches staged authority, with rollback and restart-safe retry", async () => {
    const fixture = await candidate("portable_staging");
    const issuance = bindPrivateAtomicStagedIssuance({ ownerUserId }, fixture.attachment);

    await expect(withTransaction(pool, async (client) => {
      await secure.issueStagedInput(client, issuance);
      throw new Error("inject-after-attach");
    })).rejects.toThrow("inject-after-attach");

    const afterRollback = await pool.query<{ lifecycle: string; portable_count: string }>(
      `SELECT operation.lifecycle,
              (SELECT count(*)::text FROM portable_staged_inputs
                WHERE filesystem_operation_id=operation.id) AS portable_count
         FROM durable_filesystem_operations operation WHERE operation.id=$1`,
      [fixture.operation.operationId],
    );
    expect(afterRollback.rows[0]).toEqual({ lifecycle: "reserved", portable_count: "0" });

    const restarted = createPostgresSecureStorageRepository(pool, durable);
    const issued = await withTransaction(pool, (client) => restarted.issueStagedInput(client, issuance));
    expect(issued.operation.operationId).toBe(fixture.operation.operationId);
    expect(issued.claim.operationId).toBe(fixture.operation.operationId);

    const stored = await pool.query<{ handle_token_hash: string; lifecycle: string }>(
      `SELECT staged.handle_token_hash,operation.lifecycle
         FROM portable_staged_inputs staged
         JOIN durable_filesystem_operations operation ON operation.id=staged.filesystem_operation_id
        WHERE staged.filesystem_operation_id=$1`,
      [fixture.operation.operationId],
    );
    expect(stored.rows[0]!.handle_token_hash).toBe(sha256(issued.stagedInput));
    expect(stored.rows[0]!.handle_token_hash).not.toBe(issued.stagedInput);
    expect(stored.rows[0]!.lifecycle).toBe("attached");
  });

  it("rejects replay and substituted owner without leaving a second portable row", async () => {
    const fixture = await candidate("portable_staging");
    const issuance = bindPrivateAtomicStagedIssuance({ ownerUserId }, fixture.attachment);
    await withTransaction(pool, (client) => secure.issueStagedInput(client, issuance));

    await expect(withTransaction(pool, (client) => secure.issueStagedInput(client, issuance)))
      .rejects.toThrow();
    const forged = {
      ...issuance,
      owner: { ownerUserId: crypto.randomUUID() }
    } as PrivatePortableStagedIssuance;
    await expect(withTransaction(pool, (client) => secure.issueStagedInput(client, forged)))
      .rejects.toThrow();

    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM portable_staged_inputs WHERE filesystem_operation_id=$1",
      [fixture.operation.operationId],
    );
    expect(count.rows[0]!.count).toBe("1");
  });

  it("atomically persists the complete export scope and content type", async () => {
    const fixture = await candidate("portable_export");
    const scope: PortableExportScope = {
      ownerUserId,
      exportKind: "campaign_zip",
      campaignId: world.campaignId,
      worldId: world.worldId,
      worldVersionId: world.worldVersionId
    };
    const issuance = bindPrivateAtomicExportIssuance(scope, "application/zip", fixture.attachment);
    const issued = await withTransaction(pool, (client) => secure.issueExportRetrieval(client, issuance));

    const stored = await pool.query<{
      retrieval_token_hash: string;
      export_kind: string;
      campaign_id: string | null;
      world_id: string;
      world_version_id: string;
      content_type: string;
    }>(
      `SELECT retrieval_token_hash,export_kind,campaign_id,world_id,world_version_id,content_type
         FROM portable_export_artifacts WHERE filesystem_operation_id=$1`,
      [fixture.operation.operationId],
    );
    expect(stored.rows[0]).toEqual({
      retrieval_token_hash: sha256(issued.retrieval),
      export_kind: "campaign_zip",
      campaign_id: world.campaignId,
      world_id: world.worldId,
      world_version_id: world.worldVersionId,
      content_type: "application/zip"
    });
  });

  it("claims a crashed pre-write without bearer material and rehydrates its exact node identity", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const scopeId = `prewrite:${crypto.randomUUID()}`;
    const reserved = await durable.journal.reserve(
      { resourceKind: "portable", ownerUserId, operationScopeId: scopeId },
      { purpose: "portable_staging", leaseOwner: "b4-prewrite", expiresAt },
    );
    const relativePath = `staging/${reserved.operation.operationId}.pending`;
    await secure.recordPrewriteTarget(bindPrivatePrewriteTargetAuthority(
      reserved.operation,
      relativePath,
    ));
    await secure.recordPrewriteNode(bindPrivatePrewriteNodeAuthority(
      reserved.operation,
      relativePath,
      { deviceId: "prewrite-device", fileId: "prewrite-file" },
    ));
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE id=$1`,
      [reserved.operation.operationId],
    );

    const claimed = await secure.claimExpiredPortableWork({
      leaseOwner: "b4-reaper",
      leaseSeconds: 30,
      limit: 10
    });
    const recovery = claimed.find((value) => value.operation.operationId === reserved.operation.operationId);
    expect(recovery).toBeDefined();
    expect(JSON.stringify(recovery)).not.toContain(scopeId);

    const preparation = await withTransaction(
      pool,
      (client) => secure.preparePrewriteCleanup(client, recovery!),
    );
    expect(preparation.outcome).toBe("cleanup_required");
    expect(preparation).toMatchObject({
      relativePath,
      identity: { deviceId: "prewrite-device", fileId: "prewrite-file" }
    });
  });

  it("quarantines target-only crash recovery without inventing filesystem identity", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const scopeId = `target-only:${crypto.randomUUID()}`;
    const reserved = await durable.journal.reserve(
      { resourceKind: "portable", ownerUserId, operationScopeId: scopeId },
      { purpose: "portable_export", leaseOwner: "b4-target-only", expiresAt },
    );
    const relativePath = `exports/${reserved.operation.operationId}.pending`;
    await secure.recordPrewriteTarget(bindPrivatePrewriteTargetAuthority(
      reserved.operation,
      relativePath,
    ));
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE id=$1`,
      [reserved.operation.operationId],
    );

    const claimed = await secure.claimExpiredPortableWork({
      leaseOwner: "b4-target-only-reaper",
      leaseSeconds: 30,
      limit: 20
    });
    const recovery = claimed.find((value) => value.operation.operationId === reserved.operation.operationId);
    expect(recovery).toBeDefined();
    expect(JSON.stringify(recovery)).not.toContain(scopeId);
    await expect(withTransaction(
      pool,
      (client) => secure.preparePrewriteCleanup(client, recovery!),
    )).resolves.toEqual({ outcome: "quarantined" });

    const row = await pool.query<{
      authority_state: string;
      device_id: string | null;
      file_id: string | null;
      quarantine_reason: string | null;
    }>(
      `SELECT authority_state,device_id,file_id,quarantine_reason
         FROM durable_filesystem_prewrite_nodes WHERE operation_id=$1`,
      [reserved.operation.operationId],
    );
    expect(row.rows[0]).toEqual({
      authority_state: "quarantined",
      device_id: null,
      file_id: null,
      quarantine_reason: "identity_not_persisted"
    });

    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE id=$1`,
      [reserved.operation.operationId],
    );
    const repeated = await secure.claimExpiredPortableWork({
      leaseOwner: "b4-target-only-reaper-2",
      leaseSeconds: 30,
      limit: 20
    });
    expect(repeated.find((value) => value.operation.operationId === reserved.operation.operationId))
      .toBeUndefined();
  });

  it("keeps expired finalized staging fenced while its durable read lease is renewed", async () => {
    const expiresAt = new Date(Date.now() + 2_000).toISOString();
    const fixture = await candidate("portable_staging", expiresAt);
    const issued = await withTransaction(
      pool,
      (client) => secure.issueStagedInput(
        client,
        bindPrivateAtomicStagedIssuance({ ownerUserId }, fixture.attachment),
      ),
    );
    await expect(durable.journal.finalizeAfterCommit(issued.operation, issued.claim))
      .resolves.toMatchObject({ outcome: "finalized" });

    const imports = createPostgresImportRepository(pool);
    const rehydrated = await imports.rehydrateStagedInput(
      { ownerUserId },
      issued.stagedInput,
      { leaseOwner: "b4-active-stage-reader", leaseSeconds: 1 },
    );
    expect(rehydrated).not.toBeNull();
    const renewed = await durable.journal.heartbeatRecoveryClaim(rehydrated!.claim, 3);
    expect(renewed).not.toBeNull();

    await waitForExpiry(expiresAt);
    const restartedReaper = createPostgresSecureStorageRepository(
      pool,
      createPostgresDurableFilesystemRepository(pool),
    );
    const whileActive = await restartedReaper.claimExpiredPortableWork({
      leaseOwner: "b4-active-stage-reaper",
      leaseSeconds: 1,
      limit: 10
    });
    expect(whileActive.find(
      (value) => value.operation.operationId === fixture.operation.operationId,
    )).toBeUndefined();

    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE id=$1`,
      [fixture.operation.operationId],
    );
    const afterReaderLease = await secure.claimExpiredPortableWork({
      leaseOwner: "b4-finished-stage-reaper",
      leaseSeconds: 1,
      limit: 10
    });
    expect(afterReaderLease.find(
      (value) => value.operation.operationId === fixture.operation.operationId,
    )?.action).toBe("cleanup");
  });

  it("atomically rejects late or substituted identity binding and retains target-only intent", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const reserved = await durable.journal.reserve(
      { resourceKind: "portable", ownerUserId, operationScopeId: `cas:${crypto.randomUUID()}` },
      { purpose: "portable_staging", leaseOwner: "b4-cas", expiresAt },
    );
    const relativePath = `staging/${reserved.operation.operationId}.pending`;
    await secure.recordPrewriteTarget(bindPrivatePrewriteTargetAuthority(
      reserved.operation,
      relativePath,
    ));

    await expect(secure.recordPrewriteNode(bindPrivatePrewriteNodeAuthority(
      reserved.operation,
      `staging/${crypto.randomUUID()}.pending`,
      { deviceId: "substituted-device", fileId: "substituted-file" },
    ))).rejects.toThrow("secure_storage_prewrite_target_mismatch");

    await pool.query(
      "UPDATE durable_filesystem_operations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [reserved.operation.operationId],
    );
    await expect(secure.recordPrewriteNode(bindPrivatePrewriteNodeAuthority(
      reserved.operation,
      relativePath,
      { deviceId: "late-device", fileId: "late-file" },
    ))).rejects.toBeTruthy();

    const row = await pool.query<{
      authority_state: string;
      device_id: string | null;
      file_id: string | null;
    }>(
      "SELECT authority_state,device_id,file_id FROM durable_filesystem_prewrite_nodes WHERE operation_id=$1",
      [reserved.operation.operationId],
    );
    expect(row.rows[0]).toEqual({
      authority_state: "target_only",
      device_id: null,
      file_id: null
    });
  });

  it("rejects identity binding that starts live but crosses expiry behind an operation row lock", async () => {
    const reserved = await durable.journal.reserve(
      { resourceKind: "portable", ownerUserId, operationScopeId: `locked-cas:${crypto.randomUUID()}` },
      {
        purpose: "portable_export",
        leaseOwner: "b4-locked-cas",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      },
    );
    const relativePath = `exports/${reserved.operation.operationId}.pending`;
    await secure.recordPrewriteTarget(bindPrivatePrewriteTargetAuthority(
      reserved.operation,
      relativePath,
    ));
    const authority = bindPrivatePrewriteNodeAuthority(
      reserved.operation,
      relativePath,
      { deviceId: "locked-device", fileId: "locked-file" },
    );
    const locker = await pool.connect();
    const binder = await pool.connect();
    let binding: Promise<
      | Readonly<{ ok: true }>
      | Readonly<{ ok: false; error: unknown }>
    > | undefined;
    try {
      const expiry = await pool.query<{ expires_at: Date }>(
        `UPDATE durable_filesystem_operations
            SET expires_at=clock_timestamp()+interval '2 seconds'
          WHERE id=$1
        RETURNING expires_at`,
        [reserved.operation.operationId],
      );
      const expiresAt = expiry.rows[0]!.expires_at;
      const binderPid = await binder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const binderSecure = createPostgresSecureStorageRepository(
        binder as unknown as DatabasePool,
        durable,
      );
      await binder.query("BEGIN");
      const binderStart = await binder.query<{
        transaction_started_at: Date;
        observed_at: Date;
      }>(
        `SELECT now() AS transaction_started_at,
                clock_timestamp() AS observed_at`,
      );
      expect(binderStart.rows[0]!.transaction_started_at.getTime())
        .toBeLessThan(expiresAt.getTime());
      expect(binderStart.rows[0]!.observed_at.getTime())
        .toBeLessThan(expiresAt.getTime());
      await locker.query("BEGIN");
      await locker.query(
        "SELECT id FROM durable_filesystem_operations WHERE id=$1 FOR UPDATE",
        [reserved.operation.operationId],
      );
      binding = binderSecure.recordPrewriteNode(authority).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        const activity = await locker.query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname=current_database()
                AND pid=$1
                AND state='active'
                AND wait_event_type='Lock'
           ) AS blocked`,
          [binderPid.rows[0]!.pid],
        );
        blocked = activity.rows[0]!.blocked;
        if (!blocked) await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await locker.query(
        `SELECT pg_sleep(
           GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05
         )`,
        [expiresAt],
      );
      await locker.query("COMMIT");
      await expect(binding).resolves.toEqual({
        ok: false,
        error: expect.objectContaining({ code: "55000" })
      });
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      await binding?.catch(() => undefined);
      await binder.query("ROLLBACK").catch(() => undefined);
      binder.release();
      locker.release();
    }
    await expect(pool.query(
      `SELECT authority_state,device_id,file_id
         FROM durable_filesystem_prewrite_nodes WHERE operation_id=$1`,
      [reserved.operation.operationId],
    )).resolves.toMatchObject({
      rows: [{ authority_state: "target_only", device_id: null, file_id: null }]
    });
  });

  it("atomically moves an expired finalized export pair to cleanup_pending for b2c recovery", async () => {
    const expiresAt = new Date(Date.now() + 1_500).toISOString();
    const fixture = await candidate("portable_export", expiresAt);
    const scope: PortableExportScope = {
      ownerUserId,
      exportKind: "campaign_zip",
      campaignId: world.campaignId,
      worldId: world.worldId,
      worldVersionId: world.worldVersionId
    };
    const issuance = bindPrivateAtomicExportIssuance(scope, "application/zip", fixture.attachment);
    const issued = await withTransaction(pool, (client) => secure.issueExportRetrieval(client, issuance));
    await expect(durable.journal.finalizeAfterCommit(issued.operation, issued.claim))
      .resolves.toMatchObject({ outcome: "finalized" });
    await waitForExpiry(expiresAt);

    const claimed = await secure.claimExpiredPortableWork({
      leaseOwner: "b4-export-reaper",
      leaseSeconds: 30,
      limit: 10
    });
    const recovery = claimed.find((value) => value.operation.operationId === fixture.operation.operationId);
    expect(recovery?.action).toBe("cleanup");
    expect(JSON.stringify(recovery)).not.toContain(issued.retrieval);

    const pair = await pool.query<{ lifecycle: string; status: string }>(
      `SELECT operation.lifecycle,artifact.status
         FROM durable_filesystem_operations operation
         JOIN portable_export_artifacts artifact ON artifact.filesystem_operation_id=operation.id
        WHERE operation.id=$1`,
      [fixture.operation.operationId],
    );
    expect(pair.rows[0]).toEqual({ lifecycle: "cleanup_pending", status: "cleanup_pending" });

    const imports = createPostgresImportRepository(pool);
    const prepared = await withTransaction(
      pool,
      (client) => imports.prepareRecoveryCleanup(client, recovery!),
    );
    expect(prepared.outcome).toBe("cleanup_required");
  });
});
