import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AttachedFilesystemOperation,
  DurableFilesystemRecoveryRecord,
  PrivateStorageDescriptor
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import type { PortableExportScope } from "../../packages/application/src/imports/private-portable-authority.js";
import type {
  PrivatePortableExportCleanupPreparation,
  PrivatePortableExportRehydration,
  PrivatePortableRecoveryCleanupResult,
  PrivatePortableStagedCleanupPreparation,
  PrivatePortableStagedRehydration
} from "../../packages/application/src/imports/private-portable-repository.js";
import {
  createPostgresDurableFilesystemRepository,
  type PostgresDurableFilesystemRepository
} from "../../packages/database/src/durable-filesystem-repository.js";
import {
  createPostgresImportRepository,
  PortableImportRepositoryError,
  type PostgresPortableImportRepository
} from "../../packages/database/src/import-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  withTransaction,
  type DatabasePool
} from "../../packages/database/src/pool.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type WorldScope = Readonly<{
  worldId: string;
  worldVersionId: string;
  campaignId: string;
}>;

integration("Task 14e3b2c private portable repository", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let foreignOwnerUserId = "";
  let world: WorldScope;
  let imports: PostgresPortableImportRepository;
  let durable: PostgresDurableFilesystemRepository;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 12);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    foreignOwnerUserId = await createOwner("portable-cleanup-foreign");
    world = await createWorldScope(ownerUserId, "Portable cleanup");
    imports = createPostgresImportRepository(pool);
    durable = createPostgresDurableFilesystemRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createOwner(prefix: string): Promise<string> {
    const created = await pool.query<{ id: string }>(
      `INSERT INTO users (system_key,display_name)
       VALUES ($1,$2) RETURNING id`,
      [`${prefix}-${crypto.randomUUID()}`, prefix]
    );
    return created.rows[0]!.id;
  }

  async function createWorldScope(scopedOwner: string, title: string): Promise<WorldScope> {
    const worldRow = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [scopedOwner, `${title} ${crypto.randomUUID()}`]
    );
    const worldId = worldRow.rows[0]!.id;
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,'{}'::jsonb) RETURNING id`,
      [worldId, scopedOwner]
    );
    const worldVersionId = version.rows[0]!.id;
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (owner_user_id,world_version_id,title)
       VALUES ($1,$2,$3) RETURNING id`,
      [scopedOwner, worldVersionId, title]
    );
    return { worldId, worldVersionId, campaignId: campaign.rows[0]!.id };
  }

  async function attachedPortable(
    purpose: "portable_staging" | "portable_export",
    descriptor: PrivateStorageDescriptor,
    cleanupDescriptor: PrivateStorageDescriptor = descriptor,
    expiresAt: string = new Date(Date.now() + 60_000).toISOString(),
  ): Promise<Readonly<{
    operationScopeId: string;
    operation: AttachedFilesystemOperation;
  }>> {
    const operationScopeId = `${purpose}:${crypto.randomUUID()}`;
    const reserved = await durable.journal.reserve(
      { resourceKind: "portable", ownerUserId, operationScopeId },
      { purpose, leaseOwner: `b2c-${purpose}`, expiresAt },
    );
    const candidate = await durable.issuePublicationCandidate(reserved.operation, {
      deliveryRelativePath: descriptor.relativePath,
      cleanupDescriptors: [cleanupDescriptor]
    });
    await durable.completePublicationCandidate(reserved.operation, candidate, descriptor);
    const attached = await withTransaction(
      pool,
      (client) => durable.journal.attach(client, reserved.operation, candidate),
    );
    if (attached.outcome !== "attached") throw new Error(`b2c_attach_${attached.outcome}`);
    const finalized = await durable.journal.finalizeAfterCommit(attached.operation, attached.claim);
    if (finalized.outcome !== "finalized") throw new Error(`b2c_finalize_${finalized.outcome}`);
    return { operationScopeId, operation: attached.operation };
  }

  function descriptor(label: string): PrivateStorageDescriptor {
    return {
      relativePath: `portable/${label}-${crypto.randomUUID()}.zip`,
      identity: {
        deviceId: `device-${label}`,
        fileId: `file-${label}`,
        changeToken: `change-${label}`
      },
      contentHash: sha256(`${label}-${crypto.randomUUID()}`),
      byteLength: 512
    };
  }

  function requireStagedRehydration(
    value: PrivatePortableStagedRehydration | null,
  ): PrivatePortableStagedRehydration {
    if (!value) throw new Error("b2c_staged_rehydration_missing");
    return value;
  }

  function requireExportRehydration(
    value: PrivatePortableExportRehydration | null,
  ): PrivatePortableExportRehydration {
    if (!value) throw new Error("b2c_export_rehydration_missing");
    return value;
  }

  function requireStagedPreparation(
    value: Awaited<ReturnType<PostgresPortableImportRepository["prepareStagedCleanup"]>>,
  ): PrivatePortableStagedCleanupPreparation {
    if (value.outcome !== "cleanup_required") throw new Error(`b2c_staged_prepare_${value.outcome}`);
    return value;
  }

  function requireExportPreparation(
    value: Awaited<ReturnType<PostgresPortableImportRepository["prepareExportCleanup"]>>,
  ): PrivatePortableExportCleanupPreparation {
    if (value.outcome !== "cleanup_required") throw new Error(`b2c_export_prepare_${value.outcome}`);
    return value;
  }

  function isRecoveryStagedPreparation(
    value: PrivatePortableRecoveryCleanupResult,
  ): value is PrivatePortableStagedCleanupPreparation {
    return value.outcome === "cleanup_required" && value.identity.portableKind === "staged_input";
  }

  function requireRecoveryStagedPreparation(
    value: PrivatePortableRecoveryCleanupResult,
  ): PrivatePortableStagedCleanupPreparation {
    if (!isRecoveryStagedPreparation(value)) {
      throw new Error(`b2c_staged_recovery_prepare_${value.outcome}`);
    }
    return value;
  }

  function isRecoveryExportPreparation(
    value: PrivatePortableRecoveryCleanupResult,
  ): value is PrivatePortableExportCleanupPreparation {
    return value.outcome === "cleanup_required" && value.identity.portableKind === "export_artifact";
  }

  function requireRecoveryExportPreparation(
    value: PrivatePortableRecoveryCleanupResult,
  ): PrivatePortableExportCleanupPreparation {
    if (!isRecoveryExportPreparation(value)) {
      throw new Error(`b2c_export_recovery_prepare_${value.outcome}`);
    }
    return value;
  }

  async function stagedFixture(expiresAt: string = new Date(Date.now() + 60_000).toISOString()) {
    const value = descriptor("staged");
    const attached = await attachedPortable("portable_staging", value, value, expiresAt);
    const stagedInput = await imports.registerStagedInput({
      ownerUserId,
      filesystemOperationId: attached.operation.operationId,
      operationScopeId: attached.operationScopeId,
      contentHash: value.contentHash,
      byteLength: value.byteLength,
      expiresAt
    });
    return { ...attached, descriptor: value, stagedInput };
  }

  async function exportFixture(expiresAt: string = new Date(Date.now() + 60_000).toISOString()) {
    const value = descriptor("export");
    const attached = await attachedPortable("portable_export", value, value, expiresAt);
    const scope: PortableExportScope = {
      ownerUserId,
      exportKind: "campaign_zip",
      campaignId: world.campaignId,
      worldId: world.worldId,
      worldVersionId: world.worldVersionId
    };
    const view = await imports.registerExportArtifact({
      ...scope,
      filesystemOperationId: attached.operation.operationId,
      operationScopeId: attached.operationScopeId,
      contentType: "application/zip",
      contentHash: value.contentHash,
      byteLength: value.byteLength,
      expiresAt
    });
    return { ...attached, descriptor: value, scope, retrieval: view.retrieval };
  }

  async function waitForDatabaseExpiry(expiresAt: string): Promise<void> {
    await pool.query(
      `SELECT pg_sleep(
         GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05
       )`,
      [expiresAt]
    );
  }

  it("requires a caller-owned transaction before portable cleanup preparation", async () => {
    const staged = await stagedFixture();
    const rehydrated = await imports.rehydrateStagedInput(
      { ownerUserId },
      staged.stagedInput,
      { leaseOwner: "b2c-interactive", leaseSeconds: 30 },
    );
    expect(rehydrated).not.toBeNull();

    await expect(imports.prepareStagedCleanup(
      {},
      rehydrated!,
    )).rejects.toEqual(new PortableImportRepositoryError("transaction_unavailable", 503));
  });

  it("rehydrates staged and export authority after repository restart while storing only bearer hashes", async () => {
    const staged = await stagedFixture();
    const exported = await exportFixture();
    const restarted = createPostgresImportRepository(pool);

    const stagedRehydration = await restarted.rehydrateStagedInput(
      { ownerUserId },
      staged.stagedInput,
      { leaseOwner: "b2c-staged-restart", leaseSeconds: 30 },
    );
    const exportRehydration = await restarted.rehydrateExportArtifact(
      exported.scope,
      exported.retrieval,
      { leaseOwner: "b2c-export-restart", leaseSeconds: 30 },
    );

    expect(stagedRehydration).toMatchObject({
      identity: { ownerUserId, stagedInput: staged.stagedInput },
      operation: { operationId: staged.operation.operationId, purpose: "portable_staging" },
      descriptor: staged.descriptor
    });
    expect(exportRehydration).toMatchObject({
      identity: {
        exportScope: exported.scope,
        retrieval: exported.retrieval,
        contentType: "application/zip"
      },
      operation: { operationId: exported.operation.operationId, purpose: "portable_export" },
      descriptor: exported.descriptor
    });

    const persisted = await pool.query<{
      handle_token_hash: string;
      retrieval_token_hash: string;
    }>(
      `SELECT staged.handle_token_hash,artifact.retrieval_token_hash
         FROM portable_staged_inputs staged
         CROSS JOIN portable_export_artifacts artifact
        WHERE staged.filesystem_operation_id=$1 AND artifact.filesystem_operation_id=$2`,
      [staged.operation.operationId, exported.operation.operationId]
    );
    expect(persisted.rows[0]).toEqual({
      handle_token_hash: sha256(staged.stagedInput),
      retrieval_token_hash: sha256(exported.retrieval)
    });
    expect(JSON.stringify(persisted.rows[0])).not.toContain(staged.stagedInput);
    expect(JSON.stringify(persisted.rows[0])).not.toContain(exported.retrieval);
  });

  it("rejects raw-bearer substitution across owner and complete export scope", async () => {
    const staged = await stagedFixture();
    const exported = await exportFixture();

    await expect(imports.rehydrateStagedInput(
      { ownerUserId: foreignOwnerUserId },
      staged.stagedInput,
      { leaseOwner: "b2c-foreign", leaseSeconds: 30 },
    )).resolves.toBeNull();
    await expect(imports.rehydrateStagedInput(
      { ownerUserId },
      exported.retrieval as unknown as typeof staged.stagedInput,
      { leaseOwner: "b2c-wrong-bearer", leaseSeconds: 30 },
    )).resolves.toBeNull();
    for (const [label, substitutedScope] of [
      ["owner", { ...exported.scope, ownerUserId: foreignOwnerUserId }],
      ["kind", { ...exported.scope, exportKind: "world_json" as const, campaignId: null }],
      ["campaign", { ...exported.scope, campaignId: crypto.randomUUID() }],
      ["world", { ...exported.scope, worldId: crypto.randomUUID() }],
      ["version", { ...exported.scope, worldVersionId: crypto.randomUUID() }]
    ] as const) {
      await expect(imports.rehydrateExportArtifact(
        substitutedScope,
        exported.retrieval,
        { leaseOwner: `b2c-wrong-scope-${label}`, leaseSeconds: 30 },
      )).resolves.toBeNull();
    }
  });

  it("accepts only an exact cleanup recovery record and never needs a raw bearer", async () => {
    const staged = await stagedFixture();
    const rehydrated = await imports.rehydrateStagedInput(
      { ownerUserId },
      staged.stagedInput,
      { leaseOwner: "b2c-failed-cleanup", leaseSeconds: 30 },
    );
    const initialPreparation = await withTransaction(
      pool,
      (client) => imports.prepareStagedCleanup(client, rehydrated!),
    );
    expect(initialPreparation).toMatchObject({ outcome: "cleanup_required" });

    // Model physical cleanup failure: do not acknowledge, so both durable
    // rows remain cleanup_pending and become eligible for fenced recovery.
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE id=$1`,
      [staged.operation.operationId]
    );
    const records = await durable.journal.recover({
      leaseOwner: "b2c-recovery",
      leaseSeconds: 30,
      limit: 20
    });
    const recovery = records.find((record) => record.operation.operationId === staged.operation.operationId);
    expect(recovery).toMatchObject({ action: "cleanup" });

    const forgedReservedRecord = {
      ...recovery,
      operation: {
        ...recovery!.operation,
        expiresAt: new Date(Date.now() + 30_000).toISOString()
      }
    } as DurableFilesystemRecoveryRecord;
    expect(await withTransaction(
      pool,
      (client) => imports.prepareRecoveryCleanup(client, forgedReservedRecord),
    )).toEqual({ outcome: "stale" });

    const rawScopePreimage = {
      ...recovery,
      operation: {
        ...recovery!.operation,
        operationScopeId: staged.operationScopeId
      }
    } as DurableFilesystemRecoveryRecord;
    expect(await withTransaction(
      pool,
      (client) => imports.prepareRecoveryCleanup(client, rawScopePreimage),
    )).toEqual({ outcome: "stale" });

    const wrongOwner = {
      ...recovery,
      operation: { ...recovery!.operation, ownerUserId: foreignOwnerUserId }
    } as DurableFilesystemRecoveryRecord;
    const wrongOperation = {
      ...recovery,
      operation: { ...recovery!.operation, operationId: crypto.randomUUID() }
    } as DurableFilesystemRecoveryRecord;
    const wrongPurpose = {
      ...recovery,
      operation: { ...recovery!.operation, purpose: "portable_export" }
    } as DurableFilesystemRecoveryRecord;
    const wrongWork = {
      ...recovery,
      claim: { ...recovery!.claim, workVersion: recovery!.claim.workVersion - 1 }
    } as DurableFilesystemRecoveryRecord;
    const wrongLease = {
      ...recovery,
      claim: { ...recovery!.claim, leaseId: crypto.randomUUID() }
    } as DurableFilesystemRecoveryRecord;
    for (const [substitution, outcome] of [
      [wrongOwner, "stale"],
      [wrongOperation, "stale"],
      [wrongPurpose, "stale"],
      [wrongWork, "stale"],
      [wrongLease, "lease_lost"]
    ] as const) {
      expect(await withTransaction(
        pool,
        (client) => imports.prepareRecoveryCleanup(client, substitution),
      )).toEqual({ outcome });
    }

    const prepared = await withTransaction(
      pool,
      (client) => imports.prepareRecoveryCleanup(client, recovery as DurableFilesystemRecoveryRecord),
    );
    expect(prepared).toMatchObject({
      outcome: "cleanup_required",
      identity: {
        portableKind: "staged_input",
        ownerUserId,
        filesystemOperationId: staged.operation.operationId
      },
      descriptors: [staged.descriptor, staged.descriptor]
    });
    expect(prepared).not.toHaveProperty("stagedInput");
  });

  it("recovers and acknowledges staged cleanup after the portable authority expires", async () => {
    const expiresAt = new Date(Date.now() + 3_000).toISOString();
    const staged = await stagedFixture(expiresAt);
    const rehydrated = requireStagedRehydration(await imports.rehydrateStagedInput(
      { ownerUserId },
      staged.stagedInput,
      { leaseOwner: "b2c-expired-staged-active", leaseSeconds: 30 },
    ));
    expect(await withTransaction(
      pool,
      (client) => imports.prepareStagedCleanup(client, rehydrated),
    )).toMatchObject({ outcome: "cleanup_required" });

    await waitForDatabaseExpiry(expiresAt);
    const recovered = (await durable.journal.recover({
      leaseOwner: "b2c-expired-staged-recovery",
      leaseSeconds: 30,
      limit: 100
    })).find((record) => record.operation.operationId === staged.operation.operationId);
    if (!recovered || recovered.action !== "cleanup") throw new Error("b2c_expired_staged_recovery_missing");

    const restartedImports = createPostgresImportRepository(pool);
    const preparation = requireRecoveryStagedPreparation(await withTransaction(
      pool,
      (client) => restartedImports.prepareRecoveryCleanup(client, recovered),
    ));
    expect(preparation).not.toHaveProperty("stagedInput");
    expect(await withTransaction(
      pool,
      (client) => restartedImports.acknowledgeStagedCleanup(client, preparation),
    )).toEqual({ outcome: "cleaned" });
    await expect(pool.query<{ operation_expired: boolean; portable_expired: boolean; lifecycle: string; status: string }>(
      `SELECT clock_timestamp() >= operation.expires_at AS operation_expired,
              clock_timestamp() >= staged.expires_at AS portable_expired,
              operation.lifecycle,staged.status
         FROM durable_filesystem_operations operation
         JOIN portable_staged_inputs staged ON staged.filesystem_operation_id=operation.id
        WHERE operation.id=$1`,
      [staged.operation.operationId]
    )).resolves.toMatchObject({
      rows: [{ operation_expired: true, portable_expired: true, lifecycle: "cleaned", status: "cleaned" }]
    });
  });

  it("reconstructs full export scope after restart and cleans expired authority with an exact recovery claim", async () => {
    const expiresAt = new Date(Date.now() + 3_000).toISOString();
    const exported = await exportFixture(expiresAt);
    const rehydrated = requireExportRehydration(await imports.rehydrateExportArtifact(
      exported.scope,
      exported.retrieval,
      { leaseOwner: "b2c-expired-export-active", leaseSeconds: 30 },
    ));
    expect(await withTransaction(
      pool,
      (client) => imports.prepareExportCleanup(client, rehydrated),
    )).toMatchObject({ outcome: "cleanup_required" });

    await waitForDatabaseExpiry(expiresAt);
    const recovered = (await durable.journal.recover({
      leaseOwner: "b2c-expired-export-recovery",
      leaseSeconds: 30,
      limit: 100
    })).find((record) => record.operation.operationId === exported.operation.operationId);
    if (!recovered || recovered.action !== "cleanup") throw new Error("b2c_expired_export_recovery_missing");

    const restartedImports = createPostgresImportRepository(pool);
    const preparation = requireRecoveryExportPreparation(await withTransaction(
      pool,
      (client) => restartedImports.prepareRecoveryCleanup(client, recovered),
    ));
    expect(preparation.identity.exportScope).toEqual(exported.scope);
    expect(preparation).not.toHaveProperty("retrieval");
    const rawScopePreimage = {
      ...preparation,
      operation: { ...preparation.operation, operationScopeId: exported.operationScopeId }
    } as PrivatePortableExportCleanupPreparation;
    const forgedScope = {
      ...preparation,
      identity: {
        ...preparation.identity,
        exportScope: { ...preparation.identity.exportScope, worldVersionId: crypto.randomUUID() }
      }
    } as PrivatePortableExportCleanupPreparation;
    expect(await withTransaction(
      pool,
      (client) => restartedImports.acknowledgeExportCleanup(client, rawScopePreimage),
    )).toEqual({ outcome: "stale" });
    expect(await withTransaction(
      pool,
      (client) => restartedImports.acknowledgeExportCleanup(client, forgedScope),
    )).toEqual({ outcome: "stale" });
    expect(await withTransaction(
      pool,
      (client) => restartedImports.acknowledgeExportCleanup(client, preparation),
    )).toEqual({ outcome: "cleaned" });
    await expect(pool.query<{ operation_expired: boolean; portable_expired: boolean; lifecycle: string; status: string }>(
      `SELECT clock_timestamp() >= operation.expires_at AS operation_expired,
              clock_timestamp() >= artifact.expires_at AS portable_expired,
              operation.lifecycle,artifact.status
         FROM durable_filesystem_operations operation
         JOIN portable_export_artifacts artifact ON artifact.filesystem_operation_id=operation.id
        WHERE operation.id=$1`,
      [exported.operation.operationId]
    )).resolves.toMatchObject({
      rows: [{ operation_expired: true, portable_expired: true, lifecycle: "cleaned", status: "cleaned" }]
    });
  });

  it("keeps expired active portable authority ineligible for interactive cleanup", async () => {
    const expiresAt = new Date(Date.now() + 3_000).toISOString();
    const staged = await stagedFixture(expiresAt);
    const rehydrated = requireStagedRehydration(await imports.rehydrateStagedInput(
      { ownerUserId },
      staged.stagedInput,
      { leaseOwner: "b2c-expired-interactive", leaseSeconds: 30 },
    ));

    await waitForDatabaseExpiry(expiresAt);
    expect(await withTransaction(
      pool,
      (client) => imports.prepareStagedCleanup(client, rehydrated),
    )).toEqual({ outcome: "lease_lost" });
    await expect(pool.query<{ lifecycle: string; status: string }>(
      `SELECT operation.lifecycle,staged.status
         FROM durable_filesystem_operations operation
         JOIN portable_staged_inputs staged ON staged.filesystem_operation_id=operation.id
        WHERE operation.id=$1`,
      [staged.operation.operationId]
    )).resolves.toMatchObject({ rows: [{ lifecycle: "finalized", status: "staged" }] });
  });

  it("atomically prepares and acknowledges both rows, including rollback and idempotent acknowledgement", async () => {
    const staged = await stagedFixture();
    const rehydrated = requireStagedRehydration(await imports.rehydrateStagedInput(
      { ownerUserId },
      staged.stagedInput,
      { leaseOwner: "b2c-atomic", leaseSeconds: 30 },
    ));

    await expect(withTransaction(pool, async (client) => {
      expect(await imports.prepareStagedCleanup(client, rehydrated))
        .toMatchObject({ outcome: "cleanup_required" });
      throw new Error("rollback-prepare");
    })).rejects.toThrow("rollback-prepare");
    await expect(pool.query<{ lifecycle: string; status: string }>(
      `SELECT operation.lifecycle,staged.status
         FROM durable_filesystem_operations operation
         JOIN portable_staged_inputs staged ON staged.filesystem_operation_id=operation.id
        WHERE operation.id=$1`,
      [staged.operation.operationId]
    )).resolves.toMatchObject({ rows: [{ lifecycle: "finalized", status: "staged" }] });

    const preparation = requireStagedPreparation(await withTransaction(
      pool,
      (client) => imports.prepareStagedCleanup(client, rehydrated),
    ));
    await expect(pool.query<{ lifecycle: string; status: string }>(
      `SELECT operation.lifecycle,staged.status
         FROM durable_filesystem_operations operation
         JOIN portable_staged_inputs staged ON staged.filesystem_operation_id=operation.id
        WHERE operation.id=$1`,
      [staged.operation.operationId]
    )).resolves.toMatchObject({ rows: [{ lifecycle: "cleanup_pending", status: "cleanup_pending" }] });

    await expect(withTransaction(pool, async (client) => {
      expect(await imports.acknowledgeStagedCleanup(client, preparation))
        .toEqual({ outcome: "cleaned" });
      throw new Error("rollback-acknowledge");
    })).rejects.toThrow("rollback-acknowledge");
    await expect(pool.query<{ lifecycle: string; status: string }>(
      `SELECT operation.lifecycle,staged.status
         FROM durable_filesystem_operations operation
         JOIN portable_staged_inputs staged ON staged.filesystem_operation_id=operation.id
        WHERE operation.id=$1`,
      [staged.operation.operationId]
    )).resolves.toMatchObject({ rows: [{ lifecycle: "cleanup_pending", status: "cleanup_pending" }] });

    expect(await withTransaction(
      pool,
      (client) => imports.acknowledgeStagedCleanup(client, preparation),
    )).toEqual({ outcome: "cleaned" });
    expect(await withTransaction(
      pool,
      (client) => imports.acknowledgeStagedCleanup(client, preparation),
    )).toEqual({ outcome: "already_cleaned" });
    await expect(pool.query<{ lifecycle: string; status: string }>(
      `SELECT operation.lifecycle,staged.status
         FROM durable_filesystem_operations operation
         JOIN portable_staged_inputs staged ON staged.filesystem_operation_id=operation.id
        WHERE operation.id=$1`,
      [staged.operation.operationId]
    )).resolves.toMatchObject({ rows: [{ lifecycle: "cleaned", status: "cleaned" }] });
  });

  it("rejects descriptor, operation, claim, and export-scope substitutions before mutation", async () => {
    const staged = await stagedFixture();
    const stagedRehydration = requireStagedRehydration(await imports.rehydrateStagedInput(
      { ownerUserId },
      staged.stagedInput,
      { leaseOwner: "b2c-substitution", leaseSeconds: 30 },
    ));
    const forgedDescriptor = {
      ...stagedRehydration,
      descriptor: {
        ...stagedRehydration.descriptor,
        identity: { ...stagedRehydration.descriptor.identity, changeToken: "forged-change" }
      }
    } as PrivatePortableStagedRehydration;
    const forgedOperation = {
      ...stagedRehydration,
      operation: {
        ...stagedRehydration.operation,
        operationId: crypto.randomUUID()
      }
    } as PrivatePortableStagedRehydration;
    const forgedWork = {
      ...stagedRehydration,
      claim: { ...stagedRehydration.claim, workVersion: stagedRehydration.claim.workVersion - 1 }
    } as PrivatePortableStagedRehydration;
    const forgedLease = {
      ...stagedRehydration,
      claim: { ...stagedRehydration.claim, leaseId: crypto.randomUUID() }
    } as PrivatePortableStagedRehydration;

    for (const [value, outcome] of [
      [forgedDescriptor, "stale"],
      [forgedOperation, "stale"],
      [forgedWork, "stale"],
      [forgedLease, "lease_lost"]
    ] as const) {
      expect(await withTransaction(
        pool,
        (client) => imports.prepareStagedCleanup(client, value),
      )).toEqual({ outcome });
    }

    const exported = await exportFixture();
    const exportRehydration = requireExportRehydration(await imports.rehydrateExportArtifact(
      exported.scope,
      exported.retrieval,
      { leaseOwner: "b2c-export-substitution", leaseSeconds: 30 },
    ));
    const forgedScope = {
      ...exportRehydration,
      identity: {
        ...exportRehydration.identity,
        exportScope: { ...exported.scope, worldVersionId: crypto.randomUUID() }
      }
    } as PrivatePortableExportRehydration;
    expect(await withTransaction(
      pool,
      (client) => imports.prepareExportCleanup(client, forgedScope),
    )).toEqual({ outcome: "stale" });

    await expect(pool.query<{ staged_status: string; export_status: string }>(
      `SELECT staged.status AS staged_status,artifact.status AS export_status
         FROM portable_staged_inputs staged
         CROSS JOIN portable_export_artifacts artifact
        WHERE staged.filesystem_operation_id=$1 AND artifact.filesystem_operation_id=$2`,
      [staged.operation.operationId, exported.operation.operationId]
    )).resolves.toMatchObject({ rows: [{ staged_status: "staged", export_status: "ready" }] });
  });

  it("allows only one concurrent interactive cleanup preparation winner", async () => {
    const staged = await stagedFixture();
    const rehydrated = requireStagedRehydration(await imports.rehydrateStagedInput(
      { ownerUserId },
      staged.stagedInput,
      { leaseOwner: "b2c-race", leaseSeconds: 30 },
    ));
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      const winner = await imports.prepareStagedCleanup(first, rehydrated);
      const competitorPromise = imports.prepareStagedCleanup(second, rehydrated);
      await first.query("COMMIT");
      const competitor = await competitorPromise;
      await second.query("COMMIT");
      expect(winner).toMatchObject({ outcome: "cleanup_required" });
      expect(competitor).toEqual({ outcome: "stale" });
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it("uses database time after a row-lock wait to reject an expired cleanup claim", async () => {
    const staged = await stagedFixture();
    const rehydrated = requireStagedRehydration(await imports.rehydrateStagedInput(
      { ownerUserId },
      staged.stagedInput,
      { leaseOwner: "b2c-post-lock-expiry", leaseSeconds: 1 },
    ));
    const blocker = await pool.connect();
    const contender = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "UPDATE durable_filesystem_operations SET updated_at=updated_at WHERE id=$1",
        [staged.operation.operationId]
      );
      await contender.query("BEGIN");
      const resultPromise = imports.prepareStagedCleanup(contender, rehydrated);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200));
      await blocker.query("COMMIT");
      expect(await resultPromise).toEqual({ outcome: "lease_lost" });
      await contender.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await contender.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      contender.release();
    }
  });

  it("keeps same-path cleanup and delivery descriptors as distinct immutable identities", async () => {
    const cleanupDescriptor = descriptor("distinct-descriptor");
    const deliveryDescriptor: PrivateStorageDescriptor = {
      ...cleanupDescriptor,
      identity: { ...cleanupDescriptor.identity, changeToken: "post-adoption-change" }
    };
    const attached = await attachedPortable("portable_staging", deliveryDescriptor, cleanupDescriptor);
    const stagedInput = await imports.registerStagedInput({
      ownerUserId,
      filesystemOperationId: attached.operation.operationId,
      operationScopeId: attached.operationScopeId,
      contentHash: deliveryDescriptor.contentHash,
      byteLength: deliveryDescriptor.byteLength,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const rehydrated = requireStagedRehydration(await imports.rehydrateStagedInput(
      { ownerUserId },
      stagedInput,
      { leaseOwner: "b2c-distinct-descriptors", leaseSeconds: 30 },
    ));
    const preparation = requireStagedPreparation(await withTransaction(
      pool,
      (client) => imports.prepareStagedCleanup(client, rehydrated),
    ));
    expect(preparation.descriptors).toEqual([cleanupDescriptor, deliveryDescriptor]);
    expect(preparation.descriptors[0]!.relativePath).toBe(preparation.descriptors[1]!.relativePath);
    expect(preparation.descriptors[0]!.identity.changeToken)
      .not.toBe(preparation.descriptors[1]!.identity.changeToken);
  });

  it("acknowledges an exact export preparation across both durable rows", async () => {
    const exported = await exportFixture();
    const rehydrated = requireExportRehydration(await imports.rehydrateExportArtifact(
      exported.scope,
      exported.retrieval,
      { leaseOwner: "b2c-export-ack", leaseSeconds: 30 },
    ));
    const preparation = requireExportPreparation(await withTransaction(
      pool,
      (client) => imports.prepareExportCleanup(client, rehydrated),
    ));
    expect(await withTransaction(
      pool,
      (client) => imports.acknowledgeExportCleanup(client, preparation),
    )).toEqual({ outcome: "cleaned" });
    await expect(pool.query<{ lifecycle: string; status: string }>(
      `SELECT operation.lifecycle,artifact.status
         FROM durable_filesystem_operations operation
         JOIN portable_export_artifacts artifact ON artifact.filesystem_operation_id=operation.id
        WHERE operation.id=$1`,
      [exported.operation.operationId]
    )).resolves.toMatchObject({ rows: [{ lifecycle: "cleaned", status: "cleaned" }] });
  });

  it("rejects every durable preparation substitution before exact acknowledgement", async () => {
    const staged = await stagedFixture();
    const rehydrated = requireStagedRehydration(await imports.rehydrateStagedInput(
      { ownerUserId },
      staged.stagedInput,
      { leaseOwner: "b2c-ack-substitution", leaseSeconds: 30 },
    ));
    const preparation = requireStagedPreparation(await withTransaction(
      pool,
      (client) => imports.prepareStagedCleanup(client, rehydrated),
    ));
    const forgedDescriptor = {
      ...preparation,
      descriptors: [{
        ...preparation.descriptors[0]!,
        identity: { ...preparation.descriptors[0]!.identity, changeToken: "forged" }
      }, ...preparation.descriptors.slice(1)]
    } as unknown as PrivatePortableStagedCleanupPreparation;
    const forgedIdentity = {
      ...preparation,
      identity: { ...preparation.identity, stagedInputId: crypto.randomUUID() }
    } as PrivatePortableStagedCleanupPreparation;
    const forgedOwner = {
      ...preparation,
      identity: { ...preparation.identity, ownerUserId: foreignOwnerUserId }
    } as PrivatePortableStagedCleanupPreparation;
    const forgedOperation = {
      ...preparation,
      operation: { ...preparation.operation, operationScopeId: "forged-scope" }
    } as PrivatePortableStagedCleanupPreparation;
    const rawScopePreimage = {
      ...preparation,
      operation: { ...preparation.operation, operationScopeId: staged.operationScopeId }
    } as PrivatePortableStagedCleanupPreparation;
    const forgedWork = {
      ...preparation,
      claim: { ...preparation.claim, workVersion: preparation.claim.workVersion - 1 }
    } as PrivatePortableStagedCleanupPreparation;
    const forgedLease = {
      ...preparation,
      claim: { ...preparation.claim, leaseOwner: "foreign-worker" }
    } as PrivatePortableStagedCleanupPreparation;

    for (const [value, outcome] of [
      [forgedDescriptor, "stale"],
      [forgedIdentity, "stale"],
      [forgedOwner, "stale"],
      [forgedOperation, "stale"],
      [rawScopePreimage, "stale"],
      [forgedWork, "stale"],
      [forgedLease, "lease_lost"]
    ] as const) {
      expect(await withTransaction(
        pool,
        (client) => imports.acknowledgeStagedCleanup(client, value),
      )).toEqual({ outcome });
    }
    await expect(pool.query<{ lifecycle: string; status: string }>(
      `SELECT operation.lifecycle,staged.status
         FROM durable_filesystem_operations operation
         JOIN portable_staged_inputs staged ON staged.filesystem_operation_id=operation.id
        WHERE operation.id=$1`,
      [staged.operation.operationId]
    )).resolves.toMatchObject({ rows: [{ lifecycle: "cleanup_pending", status: "cleanup_pending" }] });
  });

  it("requires nonblank workers and positive integral lease durations", async () => {
    const staged = await stagedFixture();
    for (const request of [
      { leaseOwner: "", leaseSeconds: 30 },
      { leaseOwner: "worker", leaseSeconds: 0 },
      { leaseOwner: "worker", leaseSeconds: 1.5 }
    ]) {
      await expect(imports.rehydrateStagedInput(
        { ownerUserId },
        staged.stagedInput,
        request,
      )).rejects.toEqual(new PortableImportRepositoryError("import_invalid", 400));
    }
  });
});
