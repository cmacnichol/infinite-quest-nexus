import { createHash, randomBytes } from "node:crypto";
import type { PrivateFilesystemCandidatePersistencePort } from "../../application/src/assets/private-filesystem-repository.js";
import {
  bindPrivatePrewriteCleanupPreparation,
  type PrivatePortableExpiryRecoveryPort,
  type PrivatePrewriteNodeAuthority,
  type PrivatePrewriteTargetAuthority,
  type PrivatePrewriteNodeRepositoryPort
} from "../../application/src/assets/private-secure-storage.js";
import type {
  AttachedFilesystemOperation,
  DurableFilesystemOperationId,
  DurableFilesystemPurpose,
  DurableFilesystemRecoveryClaim,
  DurableFilesystemRecoveryRecord,
  DurableFilesystemTransactionContext,
  ReservedFilesystemOperation
} from "../../application/src/assets/private-storage-lifecycle.js";
import type {
  PrivateAtomicExportIssuanceResult,
  PrivateAtomicPortableIssuancePort,
  PrivateAtomicStagedIssuanceResult,
  PrivatePortableExportIssuance,
  PrivatePortableStagedIssuance
} from "../../application/src/imports/private-portable-authority.js";
import type {
  PortableArchiveExportRetrieval,
  PortableStagedInput
} from "../../application/src/imports/types.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

type OperationLifecycle = "reserved" | "attached" | "finalized" | "cleanup_pending" | "cleaned";

type OperationRow = Readonly<{
  id: string;
  owner_user_id: string;
  purpose: DurableFilesystemPurpose;
  resource_kind: "asset" | "portable";
  asset_id: string | null;
  operation_scope_hash: string | null;
  lifecycle: OperationLifecycle;
  candidate_token_hash: string | null;
  lease_id: string;
  lease_owner: string;
  work_version: number;
  lease_expires_at: Date;
  expires_at: Date;
  created_at: Date;
}>;

type PrewriteRow = Readonly<{
  operation_id: string;
  owner_user_id: string;
  purpose: DurableFilesystemPurpose;
  relative_path: string;
  device_id: string | null;
  file_id: string | null;
  authority_state: "target_only" | "identity_bound" | "quarantined";
}>;

type PortableCandidateRow = OperationRow & Readonly<{
  portable_id: string | null;
  portable_status: string | null;
  portable_expires_at: Date | null;
}>;

export interface PostgresSecureStorageRepository
  extends PrivateAtomicPortableIssuancePort,
  PrivatePrewriteNodeRepositoryPort,
  PrivatePortableExpiryRecoveryPort {}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function operationColumns(alias = "operation"): string {
  return `${alias}.id,${alias}.owner_user_id,${alias}.purpose,${alias}.resource_kind,
    ${alias}.asset_id,${alias}.operation_scope_hash,${alias}.lifecycle,
    ${alias}.candidate_token_hash,${alias}.lease_id,${alias}.lease_owner,
    ${alias}.work_version,${alias}.lease_expires_at,${alias}.expires_at,${alias}.created_at`;
}

async function requireCallerTransaction(
  database: DurableFilesystemTransactionContext,
): Promise<DatabaseClient> {
  const client = database as Partial<DatabaseClient>;
  if (typeof client.query !== "function") throw new Error("secure_storage_transaction_unavailable");
  try {
    await client.query("SAVEPOINT secure_storage_repository_context");
    await client.query("RELEASE SAVEPOINT secure_storage_repository_context");
  } catch {
    throw new Error("secure_storage_transaction_unavailable");
  }
  return client as DatabaseClient;
}

function validateIssuance(
  issuance: PrivatePortableStagedIssuance,
  purpose: "portable_staging" | "portable_export",
): void {
  const { operation, descriptor } = issuance.attachment;
  if (operation.resourceKind !== "portable"
    || operation.purpose !== purpose
    || operation.ownerUserId !== issuance.owner.ownerUserId
    || operation.expiresAt !== issuance.expiresAt
    || operation.operationScopeId.trim().length === 0
    || descriptor.relativePath.trim().length === 0
    || descriptor.contentHash.length !== 64
    || !Number.isSafeInteger(descriptor.byteLength)
    || descriptor.byteLength < 0) {
    throw new Error("secure_storage_issuance_invalid");
  }
}

function recoveryClaim(row: OperationRow): DurableFilesystemRecoveryClaim {
  return {
    operationId: row.id as DurableFilesystemOperationId,
    leaseId: row.lease_id,
    leaseOwner: row.lease_owner,
    workVersion: row.work_version,
    leaseExpiresAt: row.lease_expires_at.toISOString()
  } as DurableFilesystemRecoveryClaim;
}

function reservedOperation(row: OperationRow): ReservedFilesystemOperation {
  if (row.resource_kind === "asset") {
    if (row.asset_id === null) throw new Error("secure_storage_operation_invalid");
    return {
      resourceKind: "asset",
      ownerUserId: row.owner_user_id,
      assetId: row.asset_id,
      operationId: row.id as DurableFilesystemOperationId,
      purpose: row.purpose,
      expiresAt: row.expires_at.toISOString()
    } as ReservedFilesystemOperation;
  }
  if (row.operation_scope_hash === null) throw new Error("secure_storage_operation_invalid");
  return {
    resourceKind: "portable",
    ownerUserId: row.owner_user_id,
    operationScopeId: row.operation_scope_hash,
    operationId: row.id as DurableFilesystemOperationId,
    purpose: row.purpose,
    expiresAt: row.expires_at.toISOString()
  } as ReservedFilesystemOperation;
}

function attachedOperation(row: OperationRow): AttachedFilesystemOperation {
  if (row.resource_kind !== "portable" || row.operation_scope_hash === null) {
    throw new Error("secure_storage_operation_invalid");
  }
  return {
    resourceKind: "portable",
    ownerUserId: row.owner_user_id,
    operationScopeId: row.operation_scope_hash,
    operationId: row.id as DurableFilesystemOperationId,
    purpose: row.purpose
  } as AttachedFilesystemOperation;
}

function operationMatchesRecovery(row: OperationRow, recovery: DurableFilesystemRecoveryRecord): boolean {
  const operation = recovery.operation;
  return recovery.action === "cleanup"
    && row.id === operation.operationId
    && row.owner_user_id === operation.ownerUserId
    && row.resource_kind === operation.resourceKind
    && row.purpose === operation.purpose
    && (operation.resourceKind === "asset"
      || (row.operation_scope_hash !== null
        && operation.operationScopeId === row.operation_scope_hash))
    && row.work_version === recovery.claim.workVersion
    && row.lease_id === recovery.claim.leaseId
    && row.lease_owner === recovery.claim.leaseOwner
    && row.lease_expires_at.toISOString() === recovery.claim.leaseExpiresAt;
}

function pathLockKey(relativePath: string): string {
  return `infinite-quest-nexus:asset-path:${relativePath}`;
}

async function lockPhysicalPaths(client: DatabaseClient, relativePaths: readonly string[]): Promise<void> {
  for (const relativePath of [...new Set(relativePaths)].sort()) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [pathLockKey(relativePath)],
    );
  }
}

export function createPostgresSecureStorageRepository(
  pool: DatabasePool,
  candidates: PrivateFilesystemCandidatePersistencePort,
): PostgresSecureStorageRepository {
  const issueStagedInput = async (
    database: DurableFilesystemTransactionContext,
    issuance: PrivatePortableStagedIssuance,
  ): Promise<PrivateAtomicStagedIssuanceResult> => {
    validateIssuance(issuance, "portable_staging");
    const client = await requireCallerTransaction(database);
    const stagedInput = randomToken() as PortableStagedInput;
    await client.query(
      `INSERT INTO portable_staged_inputs (
         owner_user_id,handle_token_hash,filesystem_operation_id,status,
         content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,'staged',$4,$5,$6)`,
      [
        issuance.owner.ownerUserId,
        sha256(stagedInput),
        issuance.attachment.operation.operationId,
        issuance.attachment.descriptor.contentHash,
        issuance.attachment.descriptor.byteLength,
        issuance.expiresAt
      ],
    );
    const attached = await candidates.attachCandidate(client, issuance.attachment);
    if (attached.outcome !== "attached") {
      throw new Error(`secure_storage_attach_${attached.outcome}`);
    }
    return {
      stagedInput,
      operation: attached.operation,
      claim: attached.claim
    };
  };

  const issueExportRetrieval = async (
    database: DurableFilesystemTransactionContext,
    issuance: PrivatePortableExportIssuance,
  ): Promise<PrivateAtomicExportIssuanceResult> => {
    validateIssuance(issuance, "portable_export");
    const expectedContentType = issuance.exportScope.exportKind === "campaign_zip"
      ? "application/zip"
      : "application/json";
    if (issuance.exportScope.ownerUserId !== issuance.owner.ownerUserId
      || issuance.contentType !== expectedContentType) {
      throw new Error("secure_storage_export_scope_invalid");
    }
    const client = await requireCallerTransaction(database);
    const retrieval = randomToken() as PortableArchiveExportRetrieval;
    await client.query(
      `INSERT INTO portable_export_artifacts (
         owner_user_id,retrieval_token_hash,filesystem_operation_id,export_kind,
         campaign_id,world_id,world_version_id,content_type,content_hash,
         byte_length,status,expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ready',$11)`,
      [
        issuance.owner.ownerUserId,
        sha256(retrieval),
        issuance.attachment.operation.operationId,
        issuance.exportScope.exportKind,
        issuance.exportScope.campaignId,
        issuance.exportScope.worldId,
        issuance.exportScope.worldVersionId,
        issuance.contentType,
        issuance.attachment.descriptor.contentHash,
        issuance.attachment.descriptor.byteLength,
        issuance.expiresAt
      ],
    );
    const attached = await candidates.attachCandidate(client, issuance.attachment);
    if (attached.outcome !== "attached") {
      throw new Error(`secure_storage_attach_${attached.outcome}`);
    }
    return {
      retrieval,
      operation: attached.operation,
      claim: attached.claim
    };
  };

  const recordPrewriteTarget = async (authority: PrivatePrewriteTargetAuthority): Promise<void> => {
    await pool.query(
      `INSERT INTO durable_filesystem_prewrite_nodes (
         operation_id,owner_user_id,purpose,relative_path,authority_state
       ) VALUES ($1,$2,$3,$4,'target_only')`,
      [
        authority.operation.operationId,
        authority.operation.ownerUserId,
        authority.operation.purpose,
        authority.relativePath
      ],
    );
  };

  const recordPrewriteNode = async (authority: PrivatePrewriteNodeAuthority): Promise<void> => {
    const updated = await pool.query(
      `UPDATE durable_filesystem_prewrite_nodes
          SET authority_state='identity_bound',device_id=$5,file_id=$6,
              identity_bound_at=clock_timestamp()
        WHERE operation_id=$1
          AND owner_user_id=$2
          AND purpose=$3
          AND relative_path=$4
          AND authority_state='target_only'
          AND device_id IS NULL
          AND file_id IS NULL`,
      [
        authority.operation.operationId,
        authority.operation.ownerUserId,
        authority.operation.purpose,
        authority.relativePath,
        authority.identity.deviceId,
        authority.identity.fileId
      ],
    );
    if (updated.rowCount !== 1) throw new Error("secure_storage_prewrite_target_mismatch");
  };

  const preparePrewriteCleanup = async (
    database: DurableFilesystemTransactionContext,
    recovery: DurableFilesystemRecoveryRecord,
  ) => {
    const client = await requireCallerTransaction(database);
    const selected = await client.query<OperationRow & PrewriteRow>(
      `SELECT ${operationColumns()},prewrite.operation_id,prewrite.owner_user_id,
              prewrite.purpose,prewrite.relative_path,prewrite.device_id,prewrite.file_id,
              prewrite.authority_state
         FROM durable_filesystem_operations operation
         JOIN durable_filesystem_prewrite_nodes prewrite
           ON prewrite.operation_id=operation.id
          AND prewrite.owner_user_id=operation.owner_user_id
          AND prewrite.purpose=operation.purpose
        WHERE operation.id=$1
        FOR UPDATE OF operation,prewrite`,
      [recovery.operation.operationId],
    );
    const row = selected.rows[0];
    if (!row || !operationMatchesRecovery(row, recovery)) return { outcome: "stale" as const };
    if (row.lifecycle === "cleaned") return { outcome: "already_cleaned" as const };
    if (row.lifecycle !== "cleanup_pending") return { outcome: "stale" as const };
    const now = await client.query<{ current_time: Date }>(
      "SELECT clock_timestamp() AS current_time",
    );
    if (row.lease_expires_at <= now.rows[0]!.current_time) return { outcome: "lease_lost" as const };
    await lockPhysicalPaths(client, [row.relative_path]);
    if (row.authority_state === "quarantined") return { outcome: "quarantined" as const };
    if (row.authority_state === "target_only") {
      const quarantined = await client.query(
        `UPDATE durable_filesystem_prewrite_nodes
            SET authority_state='quarantined',quarantined_at=clock_timestamp(),
                quarantine_reason='identity_not_persisted'
          WHERE operation_id=$1 AND authority_state='target_only'`,
        [row.operation_id],
      );
      if (quarantined.rowCount !== 1) return { outcome: "stale" as const };
      return { outcome: "quarantined" as const };
    }
    if (row.device_id === null || row.file_id === null) return { outcome: "stale" as const };
    return bindPrivatePrewriteCleanupPreparation(
      reservedOperation(row),
      recoveryClaim(row),
      row.relative_path,
      { deviceId: row.device_id, fileId: row.file_id },
    );
  };

  const claimExpiredPortableWork: PrivatePortableExpiryRecoveryPort["claimExpiredPortableWork"] = async (
    request,
  ) => {
    if (request.leaseOwner.trim().length === 0
      || !Number.isInteger(request.leaseSeconds)
      || request.leaseSeconds <= 0
      || !Number.isInteger(request.limit)
      || request.limit <= 0) {
      throw new Error("secure_storage_recovery_request_invalid");
    }
    return withTransaction(pool, async (client) => {
      const selected = await client.query<PortableCandidateRow>(
        `SELECT ${operationColumns()},
                COALESCE(staged.id,artifact.id) AS portable_id,
                COALESCE(staged.status,artifact.status) AS portable_status,
                COALESCE(staged.expires_at,artifact.expires_at) AS portable_expires_at
           FROM durable_filesystem_operations operation
           LEFT JOIN portable_staged_inputs staged
             ON operation.purpose='portable_staging'
            AND staged.filesystem_operation_id=operation.id
           LEFT JOIN portable_export_artifacts artifact
             ON operation.purpose='portable_export'
            AND artifact.filesystem_operation_id=operation.id
          WHERE operation.resource_kind='portable'
            AND operation.lifecycle IN ('reserved','attached','finalized','cleanup_pending')
            AND NOT EXISTS (
              SELECT 1
                FROM system_archive_uploads system_upload
               WHERE system_upload.filesystem_operation_id=operation.id
                 AND system_upload.status IN ('created','uploading','completed')
                 AND system_upload.expires_at>clock_timestamp()
            )
            AND (
              (operation.lifecycle='reserved'
                AND EXISTS (SELECT 1 FROM durable_filesystem_prewrite_nodes prewrite
                             WHERE prewrite.operation_id=operation.id)
                AND (operation.expires_at <= clock_timestamp()
                  OR operation.lease_expires_at <= clock_timestamp()))
              OR
              (operation.lifecycle IN ('attached','finalized')
                AND COALESCE(staged.id,artifact.id) IS NOT NULL
                AND operation.lease_expires_at <= clock_timestamp()
                AND (operation.expires_at <= clock_timestamp()
                  OR COALESCE(staged.expires_at,artifact.expires_at) <= clock_timestamp()))
              OR
              (operation.lifecycle='cleanup_pending'
                AND operation.lease_expires_at <= clock_timestamp()
                AND NOT EXISTS (
                  SELECT 1 FROM durable_filesystem_prewrite_nodes prewrite
                   WHERE prewrite.operation_id=operation.id
                     AND prewrite.authority_state='quarantined'
                ))
            )
          ORDER BY operation.created_at,operation.id
          FOR UPDATE OF operation SKIP LOCKED
          LIMIT $1`,
        [request.limit],
      );

      const records: DurableFilesystemRecoveryRecord[] = [];
      for (const candidate of selected.rows) {
        const paths = await client.query<{ relative_path: string }>(
          `SELECT relative_path FROM durable_filesystem_descriptors WHERE operation_id=$1
           UNION ALL
           SELECT relative_path FROM durable_filesystem_prewrite_nodes WHERE operation_id=$1`,
          [candidate.id],
        );
        await lockPhysicalPaths(client, paths.rows.map((row) => row.relative_path));

        const lockedPortable = candidate.purpose === "portable_staging"
          ? await client.query<{ status: string; expires_at: Date }>(
              "SELECT status,expires_at FROM portable_staged_inputs WHERE filesystem_operation_id=$1 FOR UPDATE",
              [candidate.id],
            )
          : await client.query<{ status: string; expires_at: Date }>(
              "SELECT status,expires_at FROM portable_export_artifacts WHERE filesystem_operation_id=$1 FOR UPDATE",
              [candidate.id],
            );
        const portable = lockedPortable.rows[0] ?? null;
        const activeSystemUpload = await client.query(
          `SELECT id
             FROM system_archive_uploads
            WHERE filesystem_operation_id=$1
              AND status IN ('created','uploading','completed')
              AND expires_at>clock_timestamp()
            FOR UPDATE`,
          [candidate.id],
        );
        if (activeSystemUpload.rowCount !== 0) continue;
        const clock = await client.query<{ current_time: Date }>(
          "SELECT clock_timestamp() AS current_time",
        );
        const currentTime = clock.rows[0]!.current_time;
        const reservedPartial = candidate.lifecycle === "reserved"
          && (candidate.expires_at <= currentTime || candidate.lease_expires_at <= currentTime);
        const pairedExpired = portable !== null
          && candidate.lease_expires_at <= currentTime
          && (candidate.expires_at <= currentTime || portable.expires_at <= currentTime);
        const pendingExpired = candidate.lifecycle === "cleanup_pending"
          && candidate.lease_expires_at <= currentTime;
        if (!(reservedPartial || pairedExpired || pendingExpired)) continue;

        const updated = await client.query<OperationRow>(
          `UPDATE durable_filesystem_operations operation
              SET lifecycle='cleanup_pending',cleanup_requested_at=COALESCE(cleanup_requested_at,clock_timestamp()),
                  lease_id=gen_random_uuid(),lease_owner=$2,work_version=operation.work_version+1,
                  lease_expires_at=clock_timestamp()+make_interval(secs=>$3),updated_at=clock_timestamp()
            WHERE id=$1 AND resource_kind='portable'
              AND lifecycle IN ('reserved','attached','finalized','cleanup_pending')
            RETURNING ${operationColumns("operation")}`,
          [candidate.id, request.leaseOwner, request.leaseSeconds],
        );
        const row = updated.rows[0];
        if (!row) continue;
        if (portable && portable.status !== "cleanup_pending") {
          const table = row.purpose === "portable_staging"
            ? "portable_staged_inputs"
            : "portable_export_artifacts";
          await client.query(
            `UPDATE ${table} SET status='cleanup_pending',updated_at=clock_timestamp()
              WHERE filesystem_operation_id=$1 AND status <> 'cleanup_pending'`,
            [row.id],
          );
        }
        const operation = row.candidate_token_hash === null
          ? reservedOperation(row)
          : attachedOperation(row);
        records.push({
          action: "cleanup",
          operation,
          claim: recoveryClaim(row)
        });
      }
      return records;
    });
  };

  return {
    issueStagedInput,
    issueExportRetrieval,
    recordPrewriteTarget,
    recordPrewriteNode,
    preparePrewriteCleanup,
    claimExpiredPortableWork
  };
}
