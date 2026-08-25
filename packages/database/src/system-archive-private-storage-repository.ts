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

function recoveryClaim(row: AuthorityRow): DurableFilesystemRecoveryClaim {
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

async function selectAuthority(
  client: DatabaseClient,
  ownerUserId: string,
  uploadId: string,
  filesystemOperationId: string,
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
      WHERE upload.id=$1
        AND upload.owner_user_id=$2
        AND upload.filesystem_operation_id=$3
        AND upload.status IN ('created','uploading')
        AND upload.expires_at>clock_timestamp()
        AND operation.expires_at>clock_timestamp()
        AND operation.lifecycle IN ('reserved','finalized')
      FOR UPDATE OF operation,upload`,
    [uploadId, ownerUserId, filesystemOperationId],
  );
  const row = selected.rows[0];
  if (!row) throw storageError("System Archive upload storage authority was not found.", 404);
  return row;
}

export function createPostgresSystemArchivePrivateStorageRepository(
  pool: DatabasePool,
): SystemArchivePrivateStorageRepositoryPort {
  const repository: SystemArchivePrivateStorageRepositoryPort = {
    async withUploadLock(input, work) {
      if (!Number.isSafeInteger(input.leaseSeconds)
        || input.leaseSeconds < 1
        || input.leaseSeconds > 300
        || !input.leaseOwner.trim()) {
        throw new Error("system_archive_storage_lease_invalid");
      }
      const client = await pool.connect();
      const lockKey = `infinite-quest-nexus:system-archive-upload:${input.filesystemOperationId}`;
      let locked = false;
      try {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lockKey]);
        locked = true;
        await client.query("BEGIN");
        let row = await selectAuthority(
          client,
          input.ownerUserId,
          input.uploadId,
          input.filesystemOperationId,
        );
        let authority: SystemArchiveUploadStorageAuthority;
        if (row.lifecycle === "finalized") {
          if (row.staged_input_id === null) throw new Error("system_archive_staged_authority_missing");
          authority = Object.freeze({
            state: "staged" as const,
            stagedInputId: row.staged_input_id,
            descriptor: descriptor(row),
          });
        } else {
          const renewed = await client.query<AuthorityRow>(
            `UPDATE durable_filesystem_operations operation
                SET lease_id=gen_random_uuid(),lease_owner=$2,
                    work_version=operation.work_version+1,
                    lease_expires_at=clock_timestamp()+make_interval(secs=>$3),
                    updated_at=clock_timestamp()
              WHERE operation.id=$1
                AND operation.lifecycle='reserved'
                AND (operation.lease_owner=$2 OR operation.lease_expires_at<=clock_timestamp())
              RETURNING operation.id AS operation_id,operation.owner_user_id,
                        operation.operation_scope_hash,operation.purpose,operation.lifecycle,
                        operation.expires_at AS operation_expires_at,operation.lease_id,
                        operation.lease_owner,operation.work_version,operation.lease_expires_at,
                        $4::text AS relative_path,$5::text AS device_id,$6::text AS file_id,
                        NULL::uuid AS staged_input_id,NULL::text AS descriptor_change_token,
                        NULL::text AS descriptor_content_hash,NULL::bigint AS descriptor_byte_length`,
            [row.operation_id, input.leaseOwner, input.leaseSeconds,
              row.relative_path, row.device_id, row.file_id],
          );
          const renewedRow = renewed.rows[0];
          if (!renewedRow) {
            throw storageError("System Archive upload storage is busy.", 409);
          }
          row = renewedRow;
          authority = Object.freeze({
            state: "assembling" as const,
            operation: reservedOperation(row),
            claim: recoveryClaim(row),
            relativePath: row.relative_path,
            identity: Object.freeze({ deviceId: row.device_id, fileId: row.file_id }),
          });
        }
        await client.query("COMMIT");
        return await work(authority);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        if (locked) {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]).catch(() => undefined);
        }
        client.release();
      }
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

    async completedUpload(ownerUserId, uploadId) {
      const result = await pool.query<AuthorityRow>(
        `SELECT operation.id AS operation_id,operation.owner_user_id,
                operation.operation_scope_hash,operation.purpose,operation.lifecycle,
                operation.expires_at AS operation_expires_at,operation.lease_id,
                operation.lease_owner,operation.work_version,operation.lease_expires_at,
                prewrite.relative_path,prewrite.device_id,prewrite.file_id,
                staged.id AS staged_input_id,descriptor.change_token AS descriptor_change_token,
                descriptor.content_hash AS descriptor_content_hash,
                descriptor.byte_length AS descriptor_byte_length
           FROM system_archive_uploads upload
           JOIN portable_staged_inputs staged
             ON staged.id=upload.staged_input_id
            AND staged.owner_user_id=upload.owner_user_id
            AND staged.filesystem_operation_id=upload.filesystem_operation_id
           JOIN durable_filesystem_operations operation
             ON operation.id=staged.filesystem_operation_id
            AND operation.owner_user_id=staged.owner_user_id
            AND operation.lifecycle='finalized'
           JOIN durable_filesystem_descriptors descriptor ON descriptor.operation_id=operation.id
           JOIN durable_filesystem_prewrite_nodes prewrite ON prewrite.operation_id=operation.id
          WHERE upload.id=$1 AND upload.owner_user_id=$2 AND upload.status='completed'
            AND upload.expires_at>clock_timestamp()
            AND staged.status='staged' AND staged.expires_at>clock_timestamp()
            AND operation.expires_at>clock_timestamp()`,
        [uploadId, ownerUserId],
      );
      const row = result.rows[0];
      if (!row || row.staged_input_id === null) return null;
      return Object.freeze({ stagedInputId: row.staged_input_id, descriptor: descriptor(row) });
    },
  };
  return Object.freeze(repository);
}
