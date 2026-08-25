import {
  systemArchiveJobViewSchema,
  type SystemArchiveJobStatus,
  type SystemArchiveJobView
} from "@infinite-quest/contracts";
import type { OwnerScope } from "../../application/src/generation/types.js";
import type { DatabasePool } from "./pool.js";

type SystemArchiveJobRow = Readonly<{
  id: string;
  owner_user_id: string;
  kind: "export" | "import";
  status: SystemArchiveJobStatus;
  idempotency_key_hash: string;
  staged_input_id: string | null;
  report: unknown | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}>;

export type ClaimedSystemArchiveJob = SystemArchiveJobView & Readonly<{
  ownerUserId: string;
  stagedInputId: string | null;
  leaseOwner: string;
  leaseExpiresAt: string;
}>;

export interface SystemArchiveJobRepository {
  enqueueExport(owner: OwnerScope, idempotencyKeyHash: string): Promise<SystemArchiveJobView>;
  enqueueImport(
    owner: OwnerScope,
    stagedInputId: string,
    idempotencyKeyHash: string
  ): Promise<SystemArchiveJobView>;
  claimNext(workerId: string, leaseSeconds: number): Promise<ClaimedSystemArchiveJob | null>;
  heartbeat(jobId: string, workerId: string, leaseSeconds: number): Promise<boolean>;
  requestCancellation(owner: OwnerScope, jobId: string): Promise<SystemArchiveJobView>;
}

const JOB_COLUMNS = `id,owner_user_id,kind,status,idempotency_key_hash,staged_input_id,
  report,lease_owner,lease_expires_at,created_at,updated_at`;
const CLAIMED_JOB_COLUMNS = `job.id,job.owner_user_id,job.kind,job.status,
  job.idempotency_key_hash,job.staged_input_id,job.report,job.lease_owner,
  job.lease_expires_at,job.created_at,job.updated_at`;

function repositoryError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function requireHash(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw repositoryError(`${name} must be a lowercase SHA-256 hash.`, 400);
  }
}

function requireLease(workerId: string, leaseSeconds: number): void {
  if (!workerId.trim() || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3_600) {
    throw repositoryError("System Archive lease parameters are invalid.", 400);
  }
}

function toView(row: SystemArchiveJobRow): SystemArchiveJobView {
  return systemArchiveJobViewSchema.parse({
    id: row.id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    report: row.report
  });
}

function toClaim(row: SystemArchiveJobRow): ClaimedSystemArchiveJob {
  if (!row.lease_owner || !row.lease_expires_at) {
    throw new Error("Claimed System Archive job did not retain lease evidence.");
  }
  return {
    ...toView(row),
    ownerUserId: row.owner_user_id,
    stagedInputId: row.staged_input_id,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at.toISOString()
  };
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function mapEnqueueError(error: unknown): never {
  const code = postgresCode(error);
  if (code === "23505") throw repositoryError("A conflicting System Archive job is already active.", 409);
  if (code === "23503") throw repositoryError("System Archive staging authority was not found for this owner.", 404);
  throw error;
}

export function createPostgresSystemArchiveJobRepository(pool: DatabasePool): SystemArchiveJobRepository {
  async function enqueue(
    owner: OwnerScope,
    kind: "export" | "import",
    stagedInputId: string | null,
    idempotencyKeyHash: string
  ): Promise<SystemArchiveJobView> {
    requireHash(idempotencyKeyHash, "System Archive idempotency key hash");
    if (!owner.ownerUserId.trim() || (kind === "import" && !stagedInputId?.trim())) {
      throw repositoryError("System Archive job scope is invalid.", 400);
    }
    try {
      const result = await pool.query<SystemArchiveJobRow>(
        `INSERT INTO system_archive_jobs
           (owner_user_id,kind,status,idempotency_key_hash,staged_input_id)
         VALUES ($1,$2,'queued',$3,$4)
         ON CONFLICT (owner_user_id,kind,idempotency_key_hash)
         DO UPDATE SET updated_at=system_archive_jobs.updated_at
         RETURNING ${JOB_COLUMNS}`,
        [owner.ownerUserId, kind, idempotencyKeyHash, stagedInputId]
      );
      const row = result.rows[0];
      if (!row) throw new Error("System Archive enqueue did not return a job.");
      if (row.staged_input_id !== stagedInputId) {
        throw repositoryError("System Archive idempotency key was reused for different staging authority.", 409);
      }
      return toView(row);
    } catch (error) {
      if (typeof error === "object" && error !== null && "statusCode" in error) throw error;
      return mapEnqueueError(error);
    }
  }

  return {
    enqueueExport(owner, idempotencyKeyHash) {
      return enqueue(owner, "export", null, idempotencyKeyHash);
    },

    enqueueImport(owner, stagedInputId, idempotencyKeyHash) {
      return enqueue(owner, "import", stagedInputId, idempotencyKeyHash);
    },

    async claimNext(workerId, leaseSeconds) {
      requireLease(workerId, leaseSeconds);
      const result = await pool.query<SystemArchiveJobRow>(
        `WITH candidate AS (
           SELECT id
             FROM system_archive_jobs
             WHERE status = 'queued'
                OR (status = 'waiting_for_gate' AND lease_owner IS NULL)
                OR (status = 'cancelling' AND lease_owner IS NULL)
               OR (lease_expires_at < clock_timestamp()
                 AND status IN (
                   'capturing','writing','verifying','uploading','validating','revalidating',
                   'importing','authoritative_committed','rebuilding','cancelling'
                 ))
            ORDER BY CASE kind WHEN 'import' THEN 0 ELSE 1 END,created_at,id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE system_archive_jobs job
             SET status=CASE
                  WHEN job.kind='import' AND job.status IN ('queued','waiting_for_gate') THEN 'revalidating'
                  WHEN job.status <> 'queued' THEN job.status
                  WHEN job.kind = 'export' THEN 'capturing'
                  ELSE 'revalidating'
                END,
                lease_owner=$1,
                lease_expires_at=clock_timestamp()+($2::text || ' seconds')::interval,
                updated_at=clock_timestamp()
           FROM candidate
          WHERE job.id=candidate.id
         RETURNING ${CLAIMED_JOB_COLUMNS}`,
        [workerId, leaseSeconds]
      );
      return result.rows[0] ? toClaim(result.rows[0]) : null;
    },

    async heartbeat(jobId, workerId, leaseSeconds) {
      requireLease(workerId, leaseSeconds);
      const result = await pool.query(
        `UPDATE system_archive_jobs
            SET lease_expires_at=clock_timestamp()+($3::text || ' seconds')::interval,
                updated_at=clock_timestamp()
          WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp()
            AND status IN (
              'capturing','writing','verifying','uploading','validating','revalidating',
              'importing','authoritative_committed','rebuilding','cancelling'
            )`,
        [jobId, workerId, leaseSeconds]
      );
      return result.rowCount === 1;
    },

    async requestCancellation(owner, jobId) {
      const result = await pool.query<SystemArchiveJobRow>(
        `UPDATE system_archive_jobs
            SET status='cancelling',
                lease_owner=CASE WHEN lease_expires_at>clock_timestamp() THEN lease_owner ELSE NULL END,
                lease_expires_at=CASE WHEN lease_expires_at>clock_timestamp() THEN lease_expires_at ELSE NULL END,
                updated_at=clock_timestamp()
          WHERE id=$1 AND owner_user_id=$2
            AND (
              (kind='export' AND status IN ('queued','capturing','writing','verifying','cancelling'))
              OR (kind='import' AND status IN (
                'queued','uploading','validating','previewed','revalidating','waiting_for_gate','cancelling'
              ))
            )
         RETURNING ${JOB_COLUMNS}`,
        [jobId, owner.ownerUserId]
      );
      const row = result.rows[0];
      if (row) return toView(row);
      const visible = await pool.query<{ status: SystemArchiveJobStatus }>(
        "SELECT status FROM system_archive_jobs WHERE id=$1 AND owner_user_id=$2",
        [jobId, owner.ownerUserId]
      );
      if (!visible.rows[0]) throw repositoryError("System Archive job was not found.", 404);
      throw repositoryError(`System Archive job cannot be cancelled from ${visible.rows[0].status}.`, 409);
    }
  };
}
