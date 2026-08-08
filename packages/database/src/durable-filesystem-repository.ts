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
  PrivateFilesystemDeliveryGrant,
  PrivateFilesystemDeliveryGrantRequest,
  PrivatePublicationCleanupPreparation,
  PrivatePublicationPreparation,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation
} from "../../application/src/assets/private-storage-lifecycle.js";
import type {
  PrivateFilesystemCandidateAttachment,
  PrivateFilesystemCandidatePersistencePort,
  PrivateFilesystemDeliveryGrantPersistencePort,
  PrivateFilesystemDeliveryGrantRedemption
} from "../../application/src/assets/private-filesystem-repository.js";
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

type CandidateAuthorityRow = DescriptorRow & Readonly<{
  candidate_token_hash: string;
  operation_id: string;
  owner_user_id: string;
  purpose: DurableFilesystemPurpose;
  resource_kind: "asset" | "portable";
  asset_id: string | null;
  operation_scope_hash: string | null;
  lifecycle: "issued" | "attached" | "expired" | "revoked";
  expires_at: Date;
}>;

type DeliveryGrantRow = Readonly<{
  grant_token_hash: string;
  candidate_token_hash: string;
  operation_id: string;
  owner_user_id: string;
  purpose: DurableFilesystemPurpose;
  resource_kind: "asset" | "portable";
  asset_id: string | null;
  operation_scope_hash: string | null;
  lifecycle: "issued" | "redeemed" | "expired" | "revoked";
  expires_at: Date;
}>;

export interface PostgresDurableFilesystemRepository
  extends PrivateFilesystemCandidatePersistencePort,
  PrivateFilesystemDeliveryGrantPersistencePort {
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

function scopeMatches(
  row: Pick<OperationRow, "owner_user_id" | "resource_kind" | "asset_id" | "operation_scope_hash">,
  scope: DurableFilesystemScope,
): boolean {
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

function descriptorMatches(row: DescriptorRow, value: PrivateStorageDescriptor): boolean {
  return row.relative_path === value.relativePath
    && row.device_id === value.identity.deviceId
    && row.file_id === value.identity.fileId
    && row.change_token === value.identity.changeToken
    && row.content_hash === value.contentHash
    && Number(row.byte_length) === value.byteLength;
}

function candidateMatchesAttachment(
  row: CandidateAuthorityRow,
  attachment: PrivateFilesystemCandidateAttachment,
): boolean {
  return row.operation_id === attachment.operation.operationId
    && row.purpose === attachment.operation.purpose
    && scopeMatches(row, attachment.operation)
    && row.expires_at.toISOString() === attachment.operation.expiresAt
    && descriptorMatches(row, attachment.descriptor);
}

function candidateMatchesDeliveryRequest(
  row: CandidateAuthorityRow,
  request: PrivateFilesystemDeliveryGrantRequest,
): boolean {
  return row.operation_id === request.operation.operationId
    && row.purpose === request.operation.purpose
    && scopeMatches(row, request.operation)
    && descriptorMatches(row, request.descriptor);
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

async function candidateByHash(
  client: DatabaseClient,
  candidate: AssetPublicationCandidate,
  lock = false,
): Promise<CandidateAuthorityRow | null> {
  const selected = await client.query<CandidateAuthorityRow>(
    `SELECT candidate_token_hash,operation_id,owner_user_id,purpose,resource_kind,
            asset_id,operation_scope_hash,relative_path,device_id,file_id,change_token,
            content_hash,byte_length::text,lifecycle,expires_at
       FROM durable_filesystem_candidate_authorities
      WHERE candidate_token_hash=$1${lock ? " FOR UPDATE" : ""}`,
    [sha256(candidate)]
  );
  return selected.rows[0] ?? null;
}

async function candidateByOperation(
  client: DatabaseClient,
  operationId: string,
  lock = false,
): Promise<CandidateAuthorityRow | null> {
  const selected = await client.query<CandidateAuthorityRow>(
    `SELECT candidate_token_hash,operation_id,owner_user_id,purpose,resource_kind,
            asset_id,operation_scope_hash,relative_path,device_id,file_id,change_token,
            content_hash,byte_length::text,lifecycle,expires_at
       FROM durable_filesystem_candidate_authorities
      WHERE operation_id=$1${lock ? " FOR UPDATE" : ""}`,
    [operationId]
  );
  return selected.rows[0] ?? null;
}

function cleanupDescriptorsByPath(
  cleanup: readonly DescriptorRow[],
  delivery: readonly DescriptorRow[],
): DescriptorRow[] {
  const deliveryByPath = new Map(delivery.map((value) => [value.relative_path, value]));
  const selected: DescriptorRow[] = [];
  const seen = new Set<string>();
  for (const value of [...cleanup, ...delivery]) {
    if (seen.has(value.relative_path)) continue;
    seen.add(value.relative_path);
    selected.push(deliveryByPath.get(value.relative_path) ?? value);
  }
  return selected;
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

async function operationAuthorityIsFresh(client: DatabaseClient, row: OperationRow): Promise<boolean> {
  const selected = await client.query<{ fresh: boolean }>(
    "SELECT now() < $1::timestamptz AND now() < $2::timestamptz AS fresh",
    [row.lease_expires_at, row.expires_at]
  );
  return selected.rows[0]?.fresh === true;
}

async function candidateIsFresh(client: DatabaseClient, row: CandidateAuthorityRow): Promise<boolean> {
  const selected = await client.query<{ fresh: boolean }>(
    "SELECT now() < $1::timestamptz AS fresh",
    [row.expires_at]
  );
  return selected.rows[0]?.fresh === true;
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
          AND filesystem_operation_id=$3`,
      [row.asset_id, row.owner_user_id, row.id]
    );
    return Boolean(original.rowCount);
  }
  if (row.purpose === "asset_derivative") {
    const derivative = await client.query(
      `SELECT 1 FROM asset_derivatives
        WHERE source_asset_id=$1 AND owner_user_id=$2
          AND filesystem_operation_id=$3
        LIMIT 1`,
      [row.asset_id, row.owner_user_id, row.id]
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

  const persistCandidateWithClient = async (
    client: DatabaseClient,
    attachment: PrivateFilesystemCandidateAttachment,
  ): Promise<void> => {
    const row = await operationById(client, attachment.operation.operationId, true);
    if (!row
      || !operationMatches(row, attachment.operation)
      || row.lifecycle !== "reserved"
      || row.expires_at.toISOString() !== attachment.operation.expiresAt
      || claimIdentityClassification(row, attachment.claim) !== "valid"
      || !await operationAuthorityIsFresh(client, row)) {
      throw new Error("durable_filesystem_candidate_invalid");
    }

    const deliveries = await descriptorRows(client, row.id, "delivery");
    if (deliveries.length === 0) {
      await insertDescriptor(client, row.id, row.owner_user_id, "delivery", 0, attachment.descriptor);
    } else if (deliveries.length !== 1 || !descriptorMatches(deliveries[0]!, attachment.descriptor)) {
      throw new Error("durable_filesystem_candidate_mismatch");
    }

    const existing = await candidateByOperation(client, row.id, true);
    if (existing) {
      if (existing.candidate_token_hash === sha256(attachment.candidate)
        && existing.lifecycle === "issued"
        && candidateMatchesAttachment(existing, attachment)) return;
      throw new Error("durable_filesystem_candidate_already_persisted");
    }

    await client.query(
      `INSERT INTO durable_filesystem_candidate_authorities (
         candidate_token_hash,operation_id,owner_user_id,purpose,resource_kind,
         asset_id,operation_scope_hash,relative_path,device_id,file_id,change_token,
         content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        sha256(attachment.candidate),
        row.id,
        row.owner_user_id,
        row.purpose,
        row.resource_kind,
        row.asset_id,
        row.operation_scope_hash,
        ...descriptorValues(attachment.descriptor),
        row.expires_at
      ]
    );
  };

  const persistCandidate: PrivateFilesystemCandidatePersistencePort["persistCandidate"] = async (
    attachment,
  ) => withTransaction(pool, (client) => persistCandidateWithClient(client, attachment));

  const redeemCandidate: PrivateFilesystemCandidatePersistencePort["redeemCandidate"] = async (
    attachment,
  ) => withTransaction(pool, async (client) => {
    const row = await operationById(client, attachment.operation.operationId, true);
    if (!row
      || !operationMatches(row, attachment.operation)
      || row.lifecycle !== "reserved"
      || row.expires_at.toISOString() !== attachment.operation.expiresAt
      || claimIdentityClassification(row, attachment.claim) !== "valid"
      || !await operationAuthorityIsFresh(client, row)) return null;
    const candidate = await candidateByHash(client, attachment.candidate, true);
    if (!candidate
      || candidate.lifecycle !== "issued"
      || !candidateMatchesAttachment(candidate, attachment)
      || !await candidateIsFresh(client, candidate)) return null;
    return descriptor(candidate);
  });

  const attachCandidateWithClient = async (
    client: DatabaseClient,
    attachment: PrivateFilesystemCandidateAttachment,
    requireExactDomainBinding: boolean,
  ): Promise<DurableFilesystemAttachResult> => {
    const row = await operationById(client, attachment.operation.operationId, true);
    if (!row
      || !operationMatches(row, attachment.operation)
      || row.lifecycle !== "reserved"
      || row.expires_at.toISOString() !== attachment.operation.expiresAt
      || claimIdentityClassification(row, attachment.claim) !== "valid"
      || !await operationAuthorityIsFresh(client, row)) return { outcome: "stale" };
    const candidate = await candidateByHash(client, attachment.candidate, true);
    if (!candidate
      || candidate.lifecycle !== "issued"
      || !candidateMatchesAttachment(candidate, attachment)
      || !await candidateIsFresh(client, candidate)) return { outcome: "candidate_mismatch" };

    const deliveries = await descriptorRows(client, row.id, "delivery");
    const cleanup = await descriptorRows(client, row.id, "cleanup");
    if (deliveries.length !== 1
      || !descriptorMatches(deliveries[0]!, attachment.descriptor)
      || (requireExactDomainBinding && !await operationHasDomainReference(client, row))) {
      return { outcome: "candidate_mismatch" };
    }
    const paths = [...cleanup, ...deliveries].map((item) => item.relative_path);
    await lockPhysicalPaths(client, paths);
    if (await cleanupPathFenced(client, row.id, paths)) return { outcome: "stale" };

    const locator = randomToken();
    const updated = await client.query<OperationRow>(
      `UPDATE durable_filesystem_operations
          SET lifecycle='attached',candidate_token_hash=$3,locator_token_hash=$4,
              attached_at=now(),updated_at=now()
        WHERE id=$1 AND owner_user_id=$2 AND lifecycle='reserved'
          AND work_version=$5 AND lease_id=$6 AND lease_owner=$7
          AND date_trunc('milliseconds',lease_expires_at)=$8::timestamptz
          AND lease_expires_at > now() AND expires_at > now()
        RETURNING ${operationColumns("durable_filesystem_operations")}`,
      [
        row.id,
        row.owner_user_id,
        candidate.candidate_token_hash,
        sha256(locator),
        attachment.claim.workVersion,
        attachment.claim.leaseId,
        attachment.claim.leaseOwner,
        attachment.claim.leaseExpiresAt
      ]
    );
    const attached = updated.rows[0];
    if (!attached) return { outcome: "stale" };
    const attachedCandidate = await client.query(
      `UPDATE durable_filesystem_candidate_authorities
          SET lifecycle='attached',updated_at=now()
        WHERE candidate_token_hash=$1 AND operation_id=$2
          AND owner_user_id=$3 AND purpose=$4 AND lifecycle='issued'
          AND expires_at > now()
        RETURNING candidate_token_hash`,
      [candidate.candidate_token_hash, row.id, row.owner_user_id, row.purpose]
    );
    if (attachedCandidate.rowCount !== 1) {
      throw new Error("durable_filesystem_candidate_attach_failed");
    }
    return {
      outcome: "attached",
      operation: attachedOperation(attached),
      locator: locator as DatabaseIssuedStorageLocator,
      claim: recoveryClaim(attached)
    } satisfies DurableFilesystemAttachResult;
  };

  const attachCandidate: PrivateFilesystemCandidatePersistencePort["attachCandidate"] = async (
    database,
    attachment,
  ) => attachCandidateWithClient(await requireCallerTransaction(database), attachment, true);

  const issuePublicationCandidate = async (
    reservation: ReservedFilesystemOperation,
    preparation: PrivatePublicationPreparation,
  ): Promise<AssetPublicationCandidate> => withTransaction(pool, async (client) => {
    const row = await operationById(client, reservation.operationId, true);
    if (!row || !operationMatches(row, reservation) || row.lifecycle !== "reserved"
      || row.expires_at.toISOString() !== reservation.expiresAt
      || !await operationAuthorityIsFresh(client, row)) {
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
    return randomToken() as AssetPublicationCandidate;
  });

  const completePublicationCandidate = async (
    reservation: ReservedFilesystemOperation,
    candidate: AssetPublicationCandidate,
    value: PrivateStorageDescriptor,
  ): Promise<void> => withTransaction(pool, async (client) => {
    const row = await operationById(client, reservation.operationId, true);
    if (!row || !operationMatches(row, reservation) || row.lifecycle !== "reserved"
      || row.expires_at.toISOString() !== reservation.expiresAt
      || !await operationAuthorityIsFresh(client, row)) {
      throw new Error("durable_filesystem_candidate_invalid");
    }
    const cleanup = await descriptorRows(client, row.id, "cleanup");
    const prepared = cleanup.find((item) => item.relative_path === value.relativePath);
    if (!prepared
      || prepared.device_id !== value.identity.deviceId
      || prepared.file_id !== value.identity.fileId
      || prepared.content_hash !== value.contentHash
      || Number(prepared.byte_length) !== value.byteLength) {
      throw new Error("durable_filesystem_candidate_mismatch");
    }
    await insertDescriptor(client, row.id, row.owner_user_id, "delivery", 0, value);
    await persistCandidateWithClient(client, {
      operation: reservation,
      candidate,
      descriptor: value,
      claim: recoveryClaim(row)
    } as PrivateFilesystemCandidateAttachment);
  });

  const attach: DurableFilesystemJournalPort["attach"] = async (database, reservation, candidate) => {
    const client = await requireCallerTransaction(database);
    const row = await operationById(client, reservation.operationId, true);
    if (!row || !operationMatches(row, reservation) || row.lifecycle !== "reserved") return { outcome: "stale" };
    const persisted = await candidateByHash(client, candidate, true);
    if (!persisted) return { outcome: "candidate_mismatch" };
    return attachCandidateWithClient(client, {
      operation: reservation,
      candidate,
      descriptor: descriptor(persisted),
      claim: recoveryClaim(row)
    } as PrivateFilesystemCandidateAttachment, false);
  };

  const issueDeliveryGrant: PrivateFilesystemDeliveryGrantPersistencePort["issueDeliveryGrant"] = async (
    request,
  ) => withTransaction(pool, async (client) => {
    const row = await operationById(client, request.operation.operationId, true);
    if (!row
      || !operationMatches(row, request.operation)
      || row.lifecycle !== "finalized") {
      throw new Error("durable_filesystem_delivery_grant_invalid");
    }
    const candidate = await candidateByHash(client, request.candidate, true);
    if (!candidate
      || candidate.lifecycle !== "attached"
      || row.candidate_token_hash !== candidate.candidate_token_hash
      || !candidateMatchesDeliveryRequest(candidate, request)
      || !await candidateIsFresh(client, candidate)) {
      throw new Error("durable_filesystem_delivery_grant_invalid");
    }
    const deliveries = await descriptorRows(client, row.id, "delivery");
    if (deliveries.length !== 1 || !descriptorMatches(deliveries[0]!, request.descriptor)) {
      throw new Error("durable_filesystem_delivery_grant_invalid");
    }

    const grant = randomToken() as PrivateFilesystemDeliveryGrant;
    await client.query(
      `INSERT INTO private_filesystem_delivery_grants (
         grant_token_hash,candidate_token_hash,operation_id,owner_user_id,purpose,
         resource_kind,asset_id,operation_scope_hash,expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        sha256(grant),
        candidate.candidate_token_hash,
        row.id,
        row.owner_user_id,
        row.purpose,
        row.resource_kind,
        row.asset_id,
        row.operation_scope_hash,
        request.expiresAt
      ]
    );
    return grant;
  });

  const redeemDeliveryGrant: PrivateFilesystemDeliveryGrantPersistencePort["redeemDeliveryGrant"] = async (
    redemption: PrivateFilesystemDeliveryGrantRedemption,
  ) => withTransaction(pool, async (client) => {
    const { request } = redemption;
    const row = await operationById(client, request.operation.operationId, true);
    if (!row
      || !operationMatches(row, request.operation)
      || row.lifecycle !== "finalized") return null;
    const candidate = await candidateByHash(client, request.candidate, true);
    if (!candidate
      || candidate.lifecycle !== "attached"
      || row.candidate_token_hash !== candidate.candidate_token_hash
      || !candidateMatchesDeliveryRequest(candidate, request)
      || !await candidateIsFresh(client, candidate)) return null;
    const selected = await client.query<DeliveryGrantRow>(
      `SELECT grant_token_hash,candidate_token_hash,operation_id,owner_user_id,purpose,
              resource_kind,asset_id,operation_scope_hash,lifecycle,expires_at
         FROM private_filesystem_delivery_grants
        WHERE grant_token_hash=$1
        FOR UPDATE`,
      [sha256(redemption.grant)]
    );
    const grant = selected.rows[0];
    if (!grant
      || grant.lifecycle !== "issued"
      || grant.candidate_token_hash !== candidate.candidate_token_hash
      || grant.operation_id !== row.id
      || grant.owner_user_id !== row.owner_user_id
      || grant.purpose !== row.purpose
      || grant.resource_kind !== row.resource_kind
      || grant.asset_id !== row.asset_id
      || grant.operation_scope_hash !== row.operation_scope_hash
      || grant.expires_at.toISOString() !== request.expiresAt) return null;
    const deliveries = await descriptorRows(client, row.id, "delivery");
    if (deliveries.length !== 1 || !descriptorMatches(deliveries[0]!, request.descriptor)) return null;

    const redeemed = await client.query(
      `UPDATE private_filesystem_delivery_grants
          SET lifecycle='redeemed',redeemed_at=now(),updated_at=now()
        WHERE grant_token_hash=$1 AND lifecycle='issued' AND expires_at > now()
        RETURNING grant_token_hash`,
      [grant.grant_token_hash]
    );
    return redeemed.rowCount === 1 ? descriptor(deliveries[0]!) : null;
  });

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
    const cleanup = await descriptorRows(client, row.id, "cleanup");
    const delivery = await descriptorRows(client, row.id, "delivery");
    const rows = cleanupDescriptorsByPath(cleanup, delivery);
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
    persistCandidate,
    redeemCandidate,
    attachCandidate,
    issueDeliveryGrant,
    redeemDeliveryGrant,
    issuePublicationCandidate,
    completePublicationCandidate,
    preparePublicationCleanup,
    redeemStorageLocator
  };
}
