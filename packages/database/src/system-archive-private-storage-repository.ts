import { performance } from "node:perf_hooks";
import type {
  DurableFilesystemOperationId,
  DurableFilesystemRecoveryClaim,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation,
} from "../../application/src/assets/private-storage-lifecycle.js";
import type {
  SystemArchivePrivateStorageRepositoryPort,
  SystemArchiveUploadStorageAuthority,
} from "../../application/src/system-archives/private-storage.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";

type AuthorityRow = Readonly<{
  operation_id: string;
  owner_user_id: string;
  operation_scope_hash: string;
  purpose: "portable_staging";
  lifecycle: "reserved" | "finalized";
  operation_expires_at: Date;
  lease_id: string;
  lease_owner: string;
  work_version: number;
  lease_expires_at: Date;
  relative_path: string;
  device_id: string;
  file_id: string;
  staged_input_id: string | null;
  descriptor_change_token: string | null;
  descriptor_content_hash: string | null;
  descriptor_byte_length: string | number | null;
}>;

type RenewedOperationRow = Readonly<{
  operation_id: string;
  operation_expires_at: Date;
  lease_id: string;
  lease_owner: string;
  work_version: number;
  lease_expires_at: Date;
}>;

type LeaseInput = Readonly<{
  ownerUserId: string;
  uploadId: string;
  leaseOwner: string;
  leaseSeconds: number;
  activitySeconds: number;
}>;

type RenewableLease = Readonly<{
  current(): boolean;
  settle(): Promise<DurableFilesystemRecoveryClaim>;
  stop(): Promise<void>;
}>;

const LEASE_SAFETY_MARGIN_MILLISECONDS = 50;

function reservedOperation(row: AuthorityRow): ReservedFilesystemOperation {
  return {
    resourceKind: "portable",
    ownerUserId: row.owner_user_id,
    operationScopeId: row.operation_scope_hash,
    operationId: row.operation_id as DurableFilesystemOperationId,
    purpose: row.purpose,
    expiresAt: row.operation_expires_at.toISOString(),
  } as ReservedFilesystemOperation;
}

function recoveryClaim(
  row: Pick<AuthorityRow, "operation_id" | "lease_id" | "lease_owner" | "work_version" | "lease_expires_at">
    | RenewedOperationRow,
): DurableFilesystemRecoveryClaim {
  return {
    operationId: row.operation_id as DurableFilesystemOperationId,
    leaseId: row.lease_id,
    leaseOwner: row.lease_owner,
    workVersion: row.work_version,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
  } as DurableFilesystemRecoveryClaim;
}

function descriptor(row: AuthorityRow): PrivateStorageDescriptor {
  if (row.descriptor_change_token === null
    || row.descriptor_content_hash === null
    || row.descriptor_byte_length === null) {
    throw new Error("system_archive_staged_descriptor_missing");
  }
  return Object.freeze({
    relativePath: row.relative_path,
    identity: Object.freeze({
      deviceId: row.device_id,
      fileId: row.file_id,
      changeToken: row.descriptor_change_token,
    }),
    contentHash: row.descriptor_content_hash,
    byteLength: Number(row.descriptor_byte_length),
  });
}

function storageError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function validateLeaseInput(input: LeaseInput): void {
  if (!Number.isSafeInteger(input.leaseSeconds)
    || input.leaseSeconds < 1
    || input.leaseSeconds > 300
    || !Number.isSafeInteger(input.activitySeconds)
    || input.activitySeconds < input.leaseSeconds
    || input.activitySeconds > 604_800
    || !input.leaseOwner.trim()) {
    throw new Error("system_archive_storage_lease_invalid");
  }
}

async function selectAuthority(
  client: DatabaseClient,
  input: LeaseInput,
  filesystemOperationId: string | null,
  completed: boolean,
): Promise<AuthorityRow> {
  const selected = await client.query<AuthorityRow>(
    `SELECT operation.id AS operation_id,operation.owner_user_id,
            operation.operation_scope_hash,operation.purpose,operation.lifecycle,
            operation.expires_at AS operation_expires_at,operation.lease_id,
            operation.lease_owner,operation.work_version,operation.lease_expires_at,
            prewrite.relative_path,prewrite.device_id,prewrite.file_id,
            staged.id AS staged_input_id,descriptor.change_token AS descriptor_change_token,
            descriptor.content_hash AS descriptor_content_hash,
            descriptor.byte_length AS descriptor_byte_length
       FROM system_archive_uploads upload
       JOIN durable_filesystem_operations operation
         ON operation.id=upload.filesystem_operation_id
        AND operation.owner_user_id=upload.owner_user_id
        AND operation.purpose='portable_staging'
        AND operation.resource_kind='portable'
       JOIN durable_filesystem_prewrite_nodes prewrite
         ON prewrite.operation_id=operation.id
        AND prewrite.owner_user_id=operation.owner_user_id
        AND prewrite.purpose=operation.purpose
        AND prewrite.authority_state='identity_bound'
       LEFT JOIN portable_staged_inputs staged
         ON staged.filesystem_operation_id=operation.id
        AND staged.owner_user_id=operation.owner_user_id
        AND staged.status='staged'
       LEFT JOIN durable_filesystem_descriptors descriptor
         ON descriptor.operation_id=operation.id
        AND descriptor.descriptor_role='delivery'
      WHERE upload.id=$1
        AND upload.owner_user_id=$2
        AND ($3::uuid IS NULL OR upload.filesystem_operation_id=$3)
        AND (($4::boolean AND upload.status='completed')
          OR (NOT $4::boolean AND upload.status IN ('created','uploading')))
        AND upload.expires_at>clock_timestamp()
        AND (($4::boolean AND operation.lifecycle='finalized')
          OR (NOT $4::boolean AND operation.lifecycle IN ('reserved','finalized')))
        AND (NOT $4::boolean OR (
          staged.id=upload.staged_input_id
          AND staged.expires_at>clock_timestamp()
        ))
      FOR UPDATE OF operation,upload`,
    [input.uploadId, input.ownerUserId, filesystemOperationId, completed],
  );
  const row = selected.rows[0];
  if (!row) throw storageError("System Archive upload storage authority was not found.", 404);
  return row;
}

async function acquireLease(
  client: DatabaseClient,
  input: LeaseInput,
  row: AuthorityRow,
): Promise<AuthorityRow> {
  const renewed = await client.query<RenewedOperationRow>(
    `UPDATE durable_filesystem_operations operation
        SET lease_id=gen_random_uuid(),lease_owner=$2,
            work_version=operation.work_version+1,
            lease_expires_at=clock_timestamp()+make_interval(secs=>$3),
            expires_at=clock_timestamp()+make_interval(secs=>$4),
            updated_at=clock_timestamp()
      WHERE operation.id=$1
        AND operation.lifecycle IN ('reserved','finalized')
        AND (operation.lease_owner=$2 OR operation.lease_expires_at<=clock_timestamp())
      RETURNING operation.id AS operation_id,operation.expires_at AS operation_expires_at,
                operation.lease_id,operation.lease_owner,operation.work_version,
                operation.lease_expires_at`,
    [row.operation_id, input.leaseOwner, input.leaseSeconds, input.activitySeconds],
  );
  const renewedRow = renewed.rows[0];
  if (!renewedRow) throw storageError("System Archive upload storage is busy.", 409);
  const upload = await client.query(
    `UPDATE system_archive_uploads
        SET expires_at=$3,updated_at=clock_timestamp()
      WHERE id=$1 AND owner_user_id=$2
        AND status IN ('created','uploading','completed')`,
    [input.uploadId, input.ownerUserId, renewedRow.operation_expires_at],
  );
  if (upload.rowCount !== 1) throw new Error("system_archive_storage_upload_renewal_lost");
  const staged = await client.query(
    `UPDATE portable_staged_inputs staged
        SET expires_at=GREATEST(staged.expires_at,$3),updated_at=clock_timestamp()
       FROM system_archive_uploads upload
      WHERE upload.id=$1 AND upload.owner_user_id=$2
        AND upload.status='completed' AND upload.staged_input_id=staged.id
        AND staged.owner_user_id=upload.owner_user_id
        AND staged.filesystem_operation_id=upload.filesystem_operation_id
        AND staged.status='staged'`,
    [input.uploadId, input.ownerUserId, renewedRow.operation_expires_at],
  );
  if (row.staged_input_id !== null && staged.rowCount !== 1) {
    throw new Error("system_archive_storage_staged_renewal_lost");
  }
  return Object.freeze({
    ...row,
    operation_expires_at: renewedRow.operation_expires_at,
    lease_id: renewedRow.lease_id,
    lease_owner: renewedRow.lease_owner,
    work_version: renewedRow.work_version,
    lease_expires_at: renewedRow.lease_expires_at,
  });
}

function startRenewableLease(
  client: DatabaseClient,
  input: LeaseInput,
  initial: AuthorityRow,
): RenewableLease {
  let claim = recoveryClaim(initial);
  let current = true;
  let stopped = false;
  let deadline = performance.now()
    + input.leaseSeconds * 1_000
    - LEASE_SAFETY_MARGIN_MILLISECONDS;
  let inFlight: Promise<void> = Promise.resolve();

  const heartbeat = async (): Promise<void> => {
    if (stopped || !current) return;
    const requestedAt = performance.now();
    try {
      await client.query("BEGIN");
      const upload = await client.query<{ expires_at: Date }>(
        `UPDATE system_archive_uploads
            SET expires_at=clock_timestamp()+make_interval(secs=>$3),
                updated_at=clock_timestamp()
          WHERE id=$1 AND owner_user_id=$2
            AND status IN ('created','uploading','completed')
            AND expires_at>clock_timestamp()
          RETURNING expires_at`,
        [input.uploadId, input.ownerUserId, input.activitySeconds],
      );
      const uploadExpiry = upload.rows[0]?.expires_at;
      if (!uploadExpiry) throw new Error("system_archive_storage_lease_lost");
      const renewed = await client.query<RenewedOperationRow>(
        `UPDATE durable_filesystem_operations operation
            SET lease_expires_at=clock_timestamp()+make_interval(secs=>$6),
                expires_at=$7,
                updated_at=clock_timestamp()
          WHERE operation.id=$1 AND operation.owner_user_id=$2
            AND operation.lease_id=$3 AND operation.lease_owner=$4
            AND operation.work_version=$5
            AND operation.lifecycle IN ('reserved','attached','finalized')
            AND operation.lease_expires_at>clock_timestamp()
          RETURNING operation.id AS operation_id,operation.expires_at AS operation_expires_at,
                    operation.lease_id,operation.lease_owner,operation.work_version,
                    operation.lease_expires_at`,
        [claim.operationId, input.ownerUserId, claim.leaseId, claim.leaseOwner,
          claim.workVersion, input.leaseSeconds, uploadExpiry],
      );
      const row = renewed.rows[0];
      if (!row) throw new Error("system_archive_storage_lease_lost");
      const staged = await client.query(
        `UPDATE portable_staged_inputs staged
            SET expires_at=GREATEST(staged.expires_at,$3),updated_at=clock_timestamp()
           FROM system_archive_uploads upload
          WHERE upload.id=$1 AND upload.owner_user_id=$2
            AND upload.status='completed' AND upload.staged_input_id=staged.id
            AND staged.owner_user_id=upload.owner_user_id
            AND staged.filesystem_operation_id=upload.filesystem_operation_id
            AND staged.status='staged'`,
        [input.uploadId, input.ownerUserId, row.operation_expires_at],
      );
      if (initial.staged_input_id !== null && staged.rowCount !== 1) {
        throw new Error("system_archive_storage_staged_renewal_lost");
      }
      await client.query("COMMIT");
      claim = recoveryClaim(row);
      deadline = requestedAt
        + input.leaseSeconds * 1_000
        - LEASE_SAFETY_MARGIN_MILLISECONDS;
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      current = false;
    }
  };
  const interval = setInterval(() => {
    inFlight = inFlight.then(heartbeat, heartbeat);
  }, Math.max(50, Math.floor(input.leaseSeconds * 1_000 / 3)));
  interval.unref();

  const stop = async (): Promise<void> => {
    if (!stopped) {
      stopped = true;
      clearInterval(interval);
    }
    await inFlight;
  };
  return Object.freeze({
    current: () => current && performance.now() < deadline,
    async settle() {
      await stop();
      if (!current || performance.now() >= deadline) {
        throw new Error("system_archive_storage_lease_lost");
      }
      return claim;
    },
    stop,
  });
}

async function releaseLease(
  client: DatabaseClient,
  ownerUserId: string,
  claim: DurableFilesystemRecoveryClaim,
): Promise<void> {
  const released = await client.query(
    `UPDATE durable_filesystem_operations operation
        SET lease_expires_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE operation.id=$1 AND operation.owner_user_id=$2
        AND operation.lease_id=$3 AND operation.lease_owner=$4
        AND operation.work_version=$5
        AND operation.lifecycle IN ('reserved','finalized')`,
    [claim.operationId, ownerUserId, claim.leaseId, claim.leaseOwner, claim.workVersion],
  );
  if (released.rowCount !== 1) throw new Error("system_archive_storage_lease_lost");
}

export function createPostgresSystemArchivePrivateStorageRepository(
  pool: DatabasePool,
): SystemArchivePrivateStorageRepositoryPort {
  const withAuthority = async <Result>(
    input: LeaseInput,
    filesystemOperationId: string | null,
    completed: boolean,
    work: (authority: SystemArchiveUploadStorageAuthority) => Promise<Result>,
  ): Promise<Result> => {
    validateLeaseInput(input);
    const client = await pool.connect();
    const lockKey = `infinite-quest-nexus:system-archive-upload:${input.uploadId}`;
    let locked = false;
    let lease: RenewableLease | undefined;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lockKey]);
      locked = true;
      await client.query("BEGIN");
      const selected = await selectAuthority(client, input, filesystemOperationId, completed);
      const row = await acquireLease(client, input, selected);
      await client.query("COMMIT");
      lease = startRenewableLease(client, input, row);
      const common = {
        leaseCurrent: () => lease!.current(),
        settleLease: () => lease!.settle(),
      };
      let authority: SystemArchiveUploadStorageAuthority;
      if (row.lifecycle === "finalized") {
        if (row.staged_input_id === null) throw new Error("system_archive_staged_authority_missing");
        authority = Object.freeze({
          state: "staged" as const,
          stagedInputId: row.staged_input_id,
          descriptor: descriptor(row),
          ...common,
        });
      } else {
        authority = Object.freeze({
          state: "assembling" as const,
          operation: reservedOperation(row),
          claim: recoveryClaim(row),
          relativePath: row.relative_path,
          identity: Object.freeze({ deviceId: row.device_id, fileId: row.file_id }),
          ...common,
        });
      }
      const result = await work(authority);
      if (!lease.current()) throw new Error("system_archive_storage_lease_lost");
      const claim = await lease.settle();
      await releaseLease(client, input.ownerUserId, claim);
      return result;
    } catch (error) {
      await lease?.stop().catch(() => undefined);
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await lease?.stop().catch(() => undefined);
      if (locked) {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]).catch(() => undefined);
      }
      client.release();
    }
  };

  const repository: SystemArchivePrivateStorageRepositoryPort = {
    withUploadLock(input, work) {
      return withAuthority(input, input.filesystemOperationId, false, work);
    },

    withCompletedUploadLock(input, work) {
      return withAuthority(input, null, true, async (authority) => {
        if (authority.state !== "staged") throw new Error("system_archive_staged_authority_missing");
        return work(authority);
      });
    },

    async stagedInputIdForOperation(ownerUserId, filesystemOperationId) {
      const result = await pool.query<{ id: string }>(
        `SELECT id FROM portable_staged_inputs
          WHERE owner_user_id=$1 AND filesystem_operation_id=$2 AND status='staged'`,
        [ownerUserId, filesystemOperationId],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error("system_archive_staged_authority_missing");
      return id;
    },
  };
  return Object.freeze(repository);
}
