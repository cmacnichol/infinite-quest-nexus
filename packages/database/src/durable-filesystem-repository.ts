import { createHash, randomBytes } from "node:crypto";
import type {
  AssetPublicationCandidate,
  AttachedFilesystemOperation,
  DatabaseIssuedStorageLocator,
  DurableFilesystemAttachResult,
  DurableFilesystemCleanupCompletionResult,
  DurableFilesystemCleanupRequest,
  DurableFilesystemCleanupResult,
  DurableFilesystemFinalizeResult,
  DurableFilesystemJournalPort,
  DurableFilesystemOperationId,
  DurableFilesystemPurpose,
  DurableFilesystemRecoveryClaim,
  DurableFilesystemRecoveryRecord,
  DurableFilesystemRecoveryRequest,
  DurableFilesystemReserveRequest,
  DurableFilesystemReserveResult,
  DurableFilesystemScope,
  DurableFilesystemTransactionContext,
  PrivatePublicationCleanupPreparation,
  PrivatePublicationPreparation,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation
} from "../../application/src/assets/private-storage-lifecycle.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

type OperationLifecycle = "reserved" | "attached" | "finalized" | "cleanup_pending" | "cleaned";

type OperationRow = Readonly<{
  id: string;
  owner_user_id: string;
  operation_token_hash: string;
  purpose: DurableFilesystemPurpose;
  resource_kind: "asset" | "portable";
  asset_id: string | null;
  operation_scope_hash: string | null;
  lifecycle: OperationLifecycle;
  candidate_token_hash: string | null;
  locator_token_hash: string | null;
  lease_id: string;
  lease_owner: string;
  work_version: number;
  lease_expires_at: Date;
  expires_at: Date;
}>;

type DescriptorRow = Readonly<{
  relative_path: string;
  device_id: string;
  file_id: string;
  change_token: string;
  content_hash: string;
  byte_length: string;
}>;

type CandidateAuthority = Readonly<{
  operationId: string;
  tokenHash: string;
}>;

export interface PostgresDurableFilesystemRepository {
  journal: DurableFilesystemJournalPort;
  issuePublicationCandidate(
    reservation: ReservedFilesystemOperation,
    preparation: PrivatePublicationPreparation,
  ): Promise<AssetPublicationCandidate>;
  completePublicationCandidate(
    reservation: ReservedFilesystemOperation,
    candidate: AssetPublicationCandidate,
    descriptor: PrivateStorageDescriptor,
  ): Promise<void>;
  preparePublicationCleanup(
    operation: ReservedFilesystemOperation | AttachedFilesystemOperation,
    claim: DurableFilesystemRecoveryClaim,
  ): Promise<PrivatePublicationCleanupPreparation>;
  redeemStorageLocator(
    scope: DurableFilesystemScope,
    locator: DatabaseIssuedStorageLocator,
  ): Promise<PrivateStorageDescriptor | null>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function operationColumns(alias = "operation"): string {
  return `${alias}.id,${alias}.owner_user_id,${alias}.operation_token_hash,${alias}.purpose,
    ${alias}.resource_kind,${alias}.asset_id,${alias}.operation_scope_hash,${alias}.lifecycle,
    ${alias}.candidate_token_hash,${alias}.locator_token_hash,${alias}.lease_id,
    ${alias}.lease_owner,${alias}.work_version,${alias}.lease_expires_at,${alias}.expires_at`;
}

function scopeMatches(row: OperationRow, scope: DurableFilesystemScope): boolean {
  if (row.owner_user_id !== scope.ownerUserId || row.resource_kind !== scope.resourceKind) return false;
  return scope.resourceKind === "asset"
    ? row.asset_id === scope.assetId
    : row.operation_scope_hash === scope.operationScopeId
      || row.operation_scope_hash === sha256(scope.operationScopeId);
}

function operationMatches(
  row: OperationRow,
  operation: ReservedFilesystemOperation | AttachedFilesystemOperation,
): boolean {
  return row.id === operation.operationId
    && row.purpose === operation.purpose
    && scopeMatches(row, operation);
}

function operationScope(row: OperationRow): DurableFilesystemScope {
  if (row.resource_kind === "asset" && row.asset_id !== null) {
    return { resourceKind: "asset", ownerUserId: row.owner_user_id, assetId: row.asset_id };
  }
  if (row.resource_kind === "portable" && row.operation_scope_hash !== null) {
    // The portable scope is deliberately opaque at rest. Recovery needs a
    // stable database-derived scope value, not the caller's original secret.
    return {
      resourceKind: "portable",
      ownerUserId: row.owner_user_id,
      operationScopeId: row.operation_scope_hash
    };
  }
  throw new Error("durable_filesystem_operation_invalid");
}

function reservedOperation(row: OperationRow): ReservedFilesystemOperation {
  return {
    ...operationScope(row),
    operationId: row.id as DurableFilesystemOperationId,
    purpose: row.purpose,
    expiresAt: row.expires_at.toISOString()
  } as ReservedFilesystemOperation;
}

function attachedOperation(row: OperationRow): AttachedFilesystemOperation {
  return {
    ...operationScope(row),
    operationId: row.id as DurableFilesystemOperationId,
    purpose: row.purpose
  } as AttachedFilesystemOperation;
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

function descriptor(row: DescriptorRow): PrivateStorageDescriptor {
  return {
    relativePath: row.relative_path,
    identity: {
      deviceId: row.device_id,
      fileId: row.file_id,
      changeToken: row.change_token
    },
    contentHash: row.content_hash,
    byteLength: Number(row.byte_length)
  };
}

function descriptorValues(value: PrivateStorageDescriptor): readonly unknown[] {
  return [
    value.relativePath,
    value.identity.deviceId,
    value.identity.fileId,
    value.identity.changeToken,
    value.contentHash,
    value.byteLength
  ];
}

async function requireCallerTransaction(database: DurableFilesystemTransactionContext): Promise<DatabaseClient> {
  const client = database as Partial<DatabaseClient>;
  if (typeof client.query !== "function") throw new Error("durable_filesystem_transaction_unavailable");
  try {
    await client.query("SAVEPOINT durable_filesystem_repository_context");
    await client.query("RELEASE SAVEPOINT durable_filesystem_repository_context");
  } catch {
    throw new Error("durable_filesystem_transaction_unavailable");
  }
  return client as DatabaseClient;
}

function pathLockKey(relativePath: string): string {
  return `infinite-quest-nexus:asset-path:${relativePath}`;
}

async function lockPhysicalPaths(client: DatabaseClient, relativePaths: readonly string[]): Promise<void> {
  const sorted = [...new Set(relativePaths)].sort();
  for (const relativePath of sorted) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [pathLockKey(relativePath)]
    );
  }
}

async function operationById(client: DatabaseClient, operationId: string, lock = false): Promise<OperationRow | null> {
  const selected = await client.query<OperationRow>(
    `SELECT ${operationColumns()} FROM durable_filesystem_operations operation
      WHERE operation.id=$1${lock ? " FOR UPDATE" : ""}`,
    [operationId]
  );
  return selected.rows[0] ?? null;
}

async function descriptorRows(
  client: DatabaseClient,
  operationId: string,
  role: "delivery" | "cleanup",
): Promise<DescriptorRow[]> {
  const selected = await client.query<DescriptorRow>(
    `SELECT relative_path,device_id,file_id,change_token,content_hash,byte_length::text
       FROM durable_filesystem_descriptors
      WHERE operation_id=$1 AND descriptor_role=$2
      ORDER BY ordinal`,
    [operationId, role]
  );
  return selected.rows;
}

async function insertDescriptor(
  client: DatabaseClient,
  operationId: string,
  ownerUserId: string,
  role: "delivery" | "cleanup",
  ordinal: number,
  value: PrivateStorageDescriptor,
): Promise<void> {
  await client.query(
    `INSERT INTO durable_filesystem_descriptors (
       operation_id,owner_user_id,descriptor_role,ordinal,relative_path,
       device_id,file_id,change_token,content_hash,byte_length
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [operationId, ownerUserId, role, ordinal, ...descriptorValues(value)]
  );
}

function claimIdentityClassification(
  row: OperationRow,
  claim: DurableFilesystemRecoveryClaim,
): "valid" | "stale" | "lease_lost" {
  if (row.work_version !== claim.workVersion || row.id !== claim.operationId) return "stale";
  if (row.lease_id !== claim.leaseId
    || row.lease_owner !== claim.leaseOwner
    || row.lease_expires_at.toISOString() !== claim.leaseExpiresAt) return "lease_lost";
  return "valid";
}

function claimClassification(row: OperationRow, claim: DurableFilesystemRecoveryClaim): "valid" | "stale" | "lease_lost" {
  const identity = claimIdentityClassification(row, claim);
  if (identity !== "valid") return identity;
  if (row.lease_expires_at.getTime() <= Date.now()) return "lease_lost";
  return "valid";
}

async function globallyReferenced(client: DatabaseClient, relativePath: string): Promise<boolean> {
  const selected = await client.query(
    `SELECT 1 FROM assets WHERE storage_driver='filesystem' AND storage_path=$1
     UNION ALL
     SELECT 1 FROM asset_derivatives WHERE storage_driver='filesystem' AND storage_path=$1
     LIMIT 1`,
    [relativePath]
  );
  return Boolean(selected.rowCount);
}

async function operationHasDomainReference(client: DatabaseClient, row: OperationRow): Promise<boolean> {
  const delivery = await descriptorRows(client, row.id, "delivery");
  const deliveryPath = delivery[0]?.relative_path;
  if (!deliveryPath) return false;
  if (row.purpose === "asset_original") {
    const original = await client.query(
      `SELECT 1 FROM assets
        WHERE id=$1 AND owner_user_id=$2
          AND storage_driver='filesystem' AND storage_path=$3`,
      [row.asset_id, row.owner_user_id, deliveryPath]
    );
    return Boolean(original.rowCount);
  }
  if (row.purpose === "asset_derivative") {
    const derivative = await client.query(
      `SELECT 1 FROM asset_derivatives
        WHERE source_asset_id=$1 AND owner_user_id=$2
          AND storage_driver='filesystem' AND storage_path=$3
        LIMIT 1`,
      [row.asset_id, row.owner_user_id, deliveryPath]
    );
    return Boolean(derivative.rowCount);
  }
  const table = row.purpose === "portable_staging"
    ? "portable_staged_inputs"
    : "portable_export_artifacts";
  const portable = await client.query(
    `SELECT 1 FROM ${table}
      WHERE filesystem_operation_id=$1 AND owner_user_id=$2
      LIMIT 1`,
    [row.id, row.owner_user_id]
  );
  return Boolean(portable.rowCount);
}

async function cleanupPathFenced(
  client: DatabaseClient,
  operationId: string,
  relativePaths: readonly string[],
): Promise<boolean> {
  if (relativePaths.length === 0) return false;
  const selected = await client.query(
    `SELECT 1
       FROM durable_filesystem_operations cleanup_operation
       JOIN durable_filesystem_descriptors cleanup_descriptor
         ON cleanup_descriptor.operation_id=cleanup_operation.id
        AND cleanup_descriptor.owner_user_id=cleanup_operation.owner_user_id
        AND cleanup_descriptor.descriptor_role='cleanup'
      WHERE cleanup_operation.id <> $1
        AND cleanup_operation.lifecycle='cleanup_pending'
        AND cleanup_descriptor.relative_path=ANY($2::text[])
      LIMIT 1`,
    [operationId, [...new Set(relativePaths)]]
  );
  return Boolean(selected.rowCount);
}

export function createPostgresDurableFilesystemRepository(
  pool: DatabasePool,
): PostgresDurableFilesystemRepository {
  const candidateAuthorities = new Map<string, CandidateAuthority>();

  const reserve: DurableFilesystemJournalPort["reserve"] = async (scope, request) => {
    const operationToken = randomToken();
    const inserted = await pool.query<OperationRow>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,operation_scope_hash,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,gen_random_uuid(),$7,LEAST($8::timestamptz,now()+interval '5 minutes'),$8)
       RETURNING ${operationColumns("durable_filesystem_operations")}`,
      [
        scope.ownerUserId,
        sha256(operationToken),
        request.purpose,
        scope.resourceKind,
        scope.resourceKind === "asset" ? scope.assetId : null,
        scope.resourceKind === "portable" ? sha256(scope.operationScopeId) : null,
        request.leaseOwner,
        request.expiresAt
      ]
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("durable_filesystem_reservation_failed");
    candidateAuthorities.set(row.id, { operationId: row.id, tokenHash: sha256(operationToken) });
    return {
      operation: {
        ...scope,
        operationId: row.id as DurableFilesystemOperationId,
        purpose: row.purpose,
        expiresAt: row.expires_at.toISOString()
      } as ReservedFilesystemOperation,
      claim: recoveryClaim(row)
    } satisfies DurableFilesystemReserveResult;
  };

  const issuePublicationCandidate = async (
    reservation: ReservedFilesystemOperation,
    preparation: PrivatePublicationPreparation,
  ): Promise<AssetPublicationCandidate> => withTransaction(pool, async (client) => {
    const row = await operationById(client, reservation.operationId, true);
    const authority = candidateAuthorities.get(reservation.operationId);
    if (!row || !operationMatches(row, reservation) || row.lifecycle !== "reserved"
      || !authority || authority.operationId !== row.id || authority.tokenHash !== row.operation_token_hash) {
      throw new Error("durable_filesystem_reservation_stale");
    }
    if (!preparation.cleanupDescriptors.some(
      (value) => value.relativePath === preparation.deliveryRelativePath,
    )) {
      throw new Error("durable_filesystem_publication_invalid");
    }
    const existing = await descriptorRows(client, row.id, "cleanup");
    if (existing.length !== 0) throw new Error("durable_filesystem_candidate_already_issued");
    for (const [ordinal, value] of preparation.cleanupDescriptors.entries()) {
      await insertDescriptor(client, row.id, row.owner_user_id, "cleanup", ordinal, value);
    }
    const candidate = randomToken();
    candidateAuthorities.set(candidate, { operationId: row.id, tokenHash: sha256(candidate) });
    return candidate as AssetPublicationCandidate;
  });

  const completePublicationCandidate = async (
    reservation: ReservedFilesystemOperation,
    candidate: AssetPublicationCandidate,
    value: PrivateStorageDescriptor,
  ): Promise<void> => withTransaction(pool, async (client) => {
    const row = await operationById(client, reservation.operationId, true);
    const authority = candidateAuthorities.get(candidate);
    if (!row || !operationMatches(row, reservation) || row.lifecycle !== "reserved"
      || !authority || authority.operationId !== row.id) {
      throw new Error("durable_filesystem_candidate_invalid");
    }
    const cleanup = await descriptorRows(client, row.id, "cleanup");
    const prepared = cleanup.find((item) => item.relative_path === value.relativePath);
    if (!prepared
      || prepared.device_id !== value.identity.deviceId
      || prepared.file_id !== value.identity.fileId
      || prepared.change_token !== value.identity.changeToken
      || prepared.content_hash !== value.contentHash
      || Number(prepared.byte_length) !== value.byteLength) {
      throw new Error("durable_filesystem_candidate_mismatch");
    }
    await insertDescriptor(client, row.id, row.owner_user_id, "delivery", 0, value);
  });

  const attach: DurableFilesystemJournalPort["attach"] = async (database, reservation, candidate) => {
    const client = await requireCallerTransaction(database);
    const authority = candidateAuthorities.get(candidate);
    if (!authority || authority.operationId !== reservation.operationId) return { outcome: "candidate_mismatch" };
    const row = await operationById(client, reservation.operationId, true);
    if (!row || !operationMatches(row, reservation) || row.lifecycle !== "reserved") return { outcome: "stale" };
    const deliveries = await descriptorRows(client, row.id, "delivery");
    const cleanup = await descriptorRows(client, row.id, "cleanup");
    if (deliveries.length !== 1) return { outcome: "candidate_mismatch" };
    const paths = [...cleanup, ...deliveries].map((item) => item.relative_path);
    await lockPhysicalPaths(client, paths);
    if (await cleanupPathFenced(client, row.id, paths)) return { outcome: "stale" };
    const locator = randomToken();
    const updated = await client.query<OperationRow>(
      `UPDATE durable_filesystem_operations
          SET lifecycle='attached',candidate_token_hash=$3,locator_token_hash=$4,
              attached_at=now(),updated_at=now()
        WHERE id=$1 AND owner_user_id=$2 AND lifecycle='reserved'
        RETURNING ${operationColumns("durable_filesystem_operations")}`,
      [row.id, row.owner_user_id, authority.tokenHash, sha256(locator)]
    );
    const attached = updated.rows[0];
    if (!attached) return { outcome: "stale" };
    candidateAuthorities.delete(candidate);
    candidateAuthorities.delete(row.id);
    return {
      outcome: "attached",
      operation: attachedOperation(attached),
      locator: locator as DatabaseIssuedStorageLocator,
      claim: recoveryClaim(attached)
    } satisfies DurableFilesystemAttachResult;
  };

  const finalizeAfterCommit: DurableFilesystemJournalPort["finalizeAfterCommit"] = async (operation, claim) => withTransaction(
    pool,
    async (client): Promise<DurableFilesystemFinalizeResult> => {
      const row = await operationById(client, operation.operationId, true);
      if (!row || !operationMatches(row, operation) || row.work_version !== claim.workVersion) return { outcome: "stale" };
      const identity = claimIdentityClassification(row, claim);
      if (identity !== "valid") return { outcome: identity };
      if (row.lifecycle === "finalized") return { outcome: "already_finalized" };
      if (row.lease_expires_at.getTime() <= Date.now()) return { outcome: "lease_lost" };
      if (row.lifecycle !== "attached") return { outcome: "stale" };
      await client.query(
        `UPDATE durable_filesystem_operations
            SET lifecycle='finalized',finalized_at=now(),updated_at=now()
          WHERE id=$1 AND owner_user_id=$2 AND lifecycle='attached'`,
        [row.id, row.owner_user_id]
      );
      return { outcome: "finalized" };
    },
  );

  const markCleanup: DurableFilesystemJournalPort["markCleanup"] = async (
    operation,
    claim,
    request: DurableFilesystemCleanupRequest,
  ): Promise<DurableFilesystemCleanupResult> => withTransaction(pool, async (client) => {
    const row = await operationById(client, operation.operationId, true);
    if (!row || !operationMatches(row, operation) || row.work_version !== claim.workVersion) return { outcome: "stale" };
    const identity = claimIdentityClassification(row, claim);
    if (identity !== "valid") return { outcome: identity };
    if (row.lifecycle === "cleaned") return { outcome: "already_cleaned" };
    if (row.lease_expires_at.getTime() <= Date.now()) return { outcome: "lease_lost" };
    if (row.lifecycle === "cleanup_pending") return { outcome: "cleanup_pending" };
    if (!(["reserved", "attached", "finalized"] as OperationLifecycle[]).includes(row.lifecycle)) {
      return { outcome: "stale" };
    }
    await client.query(
      `UPDATE durable_filesystem_operations
          SET lifecycle='cleanup_pending',cleanup_requested_at=now(),diagnostic_code=$3,updated_at=now()
        WHERE id=$1 AND owner_user_id=$2`,
      [row.id, row.owner_user_id, request.diagnosticCode ?? null]
    );
    return { outcome: "cleanup_pending" };
  });

  const completeCleanup: DurableFilesystemJournalPort["completeCleanup"] = async (
    operation,
    claim,
  ): Promise<DurableFilesystemCleanupCompletionResult> => withTransaction(pool, async (client) => {
    const row = await operationById(client, operation.operationId, true);
    if (!row || !operationMatches(row, operation) || row.work_version !== claim.workVersion) return { outcome: "stale" };
    const identity = claimIdentityClassification(row, claim);
    if (identity !== "valid") return { outcome: identity };
    if (row.lifecycle === "cleaned") return { outcome: "already_cleaned" };
    if (row.lease_expires_at.getTime() <= Date.now()) return { outcome: "lease_lost" };
    if (row.lifecycle !== "cleanup_pending") return { outcome: "stale" };
    await client.query(
      `UPDATE durable_filesystem_operations
          SET lifecycle='cleaned',cleaned_at=now(),updated_at=now()
        WHERE id=$1 AND owner_user_id=$2 AND lifecycle='cleanup_pending'`,
      [row.id, row.owner_user_id]
    );
    return { outcome: "cleaned" };
  });

  const recover = async (
    request: DurableFilesystemRecoveryRequest,
  ): Promise<readonly DurableFilesystemRecoveryRecord[]> => withTransaction(pool, async (client) => {
    const claimed = await client.query<OperationRow>(
      `WITH candidates AS (
         SELECT id FROM durable_filesystem_operations
          WHERE lifecycle IN ('reserved','attached','cleanup_pending')
            AND (lease_expires_at <= now() OR expires_at <= now())
          ORDER BY created_at,id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE durable_filesystem_operations operation
          SET lease_id=gen_random_uuid(),lease_owner=$2,work_version=operation.work_version+1,
              lease_expires_at=now()+($3::text || ' seconds')::interval,updated_at=now()
         FROM candidates
        WHERE operation.id=candidates.id
       RETURNING ${operationColumns("operation")}`,
      [request.limit, request.leaseOwner, request.leaseSeconds]
    );
    const records: DurableFilesystemRecoveryRecord[] = [];
    for (const row of claimed.rows) {
      const delivery = await descriptorRows(client, row.id, "delivery");
      const cleanup = await descriptorRows(client, row.id, "cleanup");
      await lockPhysicalPaths(client, [...delivery, ...cleanup].map((item) => item.relative_path));
      const action = row.lifecycle === "attached" && await operationHasDomainReference(client, row)
        ? "finalize"
        : "cleanup";
      const operation = row.candidate_token_hash === null
        ? reservedOperation(row)
        : attachedOperation(row);
      records.push(action === "finalize"
        ? { action, operation: attachedOperation(row), claim: recoveryClaim(row) }
        : { action, operation, claim: recoveryClaim(row) });
    }
    return records;
  });

  const preparePublicationCleanup = async (
    operation: ReservedFilesystemOperation | AttachedFilesystemOperation,
    claim: DurableFilesystemRecoveryClaim,
  ): Promise<PrivatePublicationCleanupPreparation> => withTransaction(pool, async (client) => {
    const row = await operationById(client, operation.operationId, true);
    if (!row || !operationMatches(row, operation) || row.work_version !== claim.workVersion) return { outcome: "stale" };
    const identity = claimIdentityClassification(row, claim);
    if (identity !== "valid") return { outcome: identity };
    if (row.lifecycle === "cleaned") return { outcome: "already_cleaned" };
    if (row.lease_expires_at.getTime() <= Date.now()) return { outcome: "lease_lost" };
    if (row.lifecycle !== "cleanup_pending") return { outcome: "stale" };
    const rows = await descriptorRows(client, row.id, "cleanup");
    await lockPhysicalPaths(client, rows.map((item) => item.relative_path));
    const retained = new Set<string>();
    for (const value of rows) {
      if (await globallyReferenced(client, value.relative_path)) retained.add(value.relative_path);
    }
    return {
      outcome: "cleanup_required",
      descriptors: rows.filter((value) => !retained.has(value.relative_path)).map(descriptor)
    };
  });

  const redeemStorageLocator = async (
    scope: DurableFilesystemScope,
    locator: DatabaseIssuedStorageLocator,
  ): Promise<PrivateStorageDescriptor | null> => {
    const selected = await pool.query<OperationRow & DescriptorRow>(
      `SELECT ${operationColumns()},descriptor.relative_path,descriptor.device_id,descriptor.file_id,
              descriptor.change_token,descriptor.content_hash,descriptor.byte_length::text
         FROM durable_filesystem_operations operation
         JOIN durable_filesystem_descriptors descriptor
           ON descriptor.operation_id=operation.id AND descriptor.owner_user_id=operation.owner_user_id
          AND descriptor.descriptor_role='delivery'
        WHERE operation.owner_user_id=$1 AND operation.locator_token_hash=$2
          AND operation.lifecycle='finalized'`,
      [scope.ownerUserId, sha256(locator)]
    );
    const row = selected.rows[0];
    return row && scopeMatches(row, scope) ? descriptor(row) : null;
  };

  return {
    journal: { reserve, attach, finalizeAfterCommit, markCleanup, completeCleanup, recover },
    issuePublicationCandidate,
    completePublicationCandidate,
    preparePublicationCleanup,
    redeemStorageLocator
  };
}
