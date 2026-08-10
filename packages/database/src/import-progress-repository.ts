import { createHash } from "node:crypto";
import {
  importProgressQuerySchema,
  importProgressResponseSchema,
  type ImportProgressReport
} from "@infinite-quest/contracts";
import type {
  ImportProgressCompletion,
  ImportProgressFailure,
  ImportProgressProcessingUpdate,
  ImportProgressScope,
  ImportProgressStorePort
} from "../../application/src/imports/progress.js";
import type { DatabasePool } from "./pool.js";

const RETENTION_INTERVAL = "24 hours";

type ProgressRow = Readonly<{
  status: "processing" | "completed" | "failed";
  phase: string;
  progress_percent: number;
  message: string;
  world_id: string | null;
  world_version_id: string | null;
  duplicate: boolean | null;
  error_message: string | null;
}>;

function lookup(scope: ImportProgressScope): Readonly<{ ownerUserId: string; keyHash: string }> {
  const key = importProgressQuerySchema.parse({ key: scope.key }).key;
  if (!scope.owner.ownerUserId.trim()) throw new Error("owner_scope_required");
  return Object.freeze({
    ownerUserId: scope.owner.ownerUserId,
    keyHash: createHash("sha256").update(key).digest("hex")
  });
}

function processing(update: ImportProgressProcessingUpdate): ImportProgressReport {
  return importProgressResponseSchema.parse({ status: "processing", ...update });
}

function completion(value: ImportProgressCompletion): ImportProgressReport {
  return importProgressResponseSchema.parse({
    status: "completed",
    progressPercent: 100,
    ...value
  });
}

function failure(value: ImportProgressFailure): ImportProgressReport {
  return importProgressResponseSchema.parse({
    status: "failed",
    progressPercent: 100,
    ...value
  });
}

function projection(row: ProgressRow): ImportProgressReport {
  return importProgressResponseSchema.parse({
    status: row.status,
    phase: row.phase,
    progressPercent: row.progress_percent,
    message: row.message,
    ...(row.world_id === null ? {} : { worldId: row.world_id }),
    ...(row.world_version_id === null ? {} : { worldVersionId: row.world_version_id }),
    ...(row.duplicate === null ? {} : { duplicate: row.duplicate }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message })
  });
}

export function createPostgresImportProgressRepository(pool: DatabasePool): ImportProgressStorePort {
  const repository: ImportProgressStorePort = {
    async begin(scope, update) {
      const identity = lookup(scope);
      const value = processing(update);
      await pool.query("DELETE FROM import_progress_status WHERE expires_at <= clock_timestamp()");
      await pool.query(
        `INSERT INTO import_progress_status (
           owner_user_id,lookup_key_hash,status,phase,progress_percent,message,expires_at
         ) VALUES ($1,$2,'processing',$3,$4,$5,clock_timestamp()+($6::text)::interval)
         ON CONFLICT (owner_user_id,lookup_key_hash) DO UPDATE SET
           status='processing',phase=EXCLUDED.phase,progress_percent=EXCLUDED.progress_percent,
           message=EXCLUDED.message,world_id=NULL,world_version_id=NULL,duplicate=NULL,
           error_message=NULL,expires_at=EXCLUDED.expires_at,updated_at=clock_timestamp()`,
        [
          identity.ownerUserId,
          identity.keyHash,
          value.phase,
          value.progressPercent,
          value.message,
          RETENTION_INTERVAL
        ],
      );
    },

    async update(scope, update) {
      const identity = lookup(scope);
      const value = processing(update);
      const updated = await pool.query(
        `UPDATE import_progress_status
            SET phase=$3,progress_percent=$4,message=$5,
                expires_at=clock_timestamp()+($6::text)::interval,updated_at=clock_timestamp()
          WHERE owner_user_id=$1 AND lookup_key_hash=$2 AND status='processing'
            AND expires_at > clock_timestamp() AND progress_percent <= $4`,
        [identity.ownerUserId, identity.keyHash, value.phase, value.progressPercent, value.message, RETENTION_INTERVAL],
      );
      if (updated.rowCount !== 1) throw new Error("import_progress_update_unavailable");
    },

    async complete(scope, input) {
      const identity = lookup(scope);
      const value = completion(input);
      const updated = await pool.query(
        `UPDATE import_progress_status
            SET status='completed',phase=$3,progress_percent=100,message=$4,
                world_id=$5,world_version_id=$6,duplicate=$7,error_message=NULL,
                expires_at=clock_timestamp()+($8::text)::interval,updated_at=clock_timestamp()
          WHERE owner_user_id=$1 AND lookup_key_hash=$2 AND status='processing'
            AND expires_at > clock_timestamp()`,
        [
          identity.ownerUserId,
          identity.keyHash,
          value.phase,
          value.message,
          value.worldId ?? null,
          value.worldVersionId ?? null,
          value.duplicate ?? null,
          RETENTION_INTERVAL
        ],
      );
      if (updated.rowCount !== 1) throw new Error("import_progress_completion_unavailable");
    },

    async fail(scope, input) {
      const identity = lookup(scope);
      const value = failure(input);
      const updated = await pool.query(
        `UPDATE import_progress_status
            SET status='failed',phase=$3,progress_percent=100,message=$4,error_message=$5,
                world_id=NULL,world_version_id=NULL,duplicate=NULL,
                expires_at=clock_timestamp()+($6::text)::interval,updated_at=clock_timestamp()
          WHERE owner_user_id=$1 AND lookup_key_hash=$2 AND status='processing'
            AND expires_at > clock_timestamp()`,
        [identity.ownerUserId, identity.keyHash, value.phase, value.message, value.errorMessage, RETENTION_INTERVAL],
      );
      if (updated.rowCount !== 1) throw new Error("import_progress_failure_unavailable");
    },

    async read(scope) {
      const identity = lookup(scope);
      const selected = await pool.query<ProgressRow>(
        `SELECT status,phase,progress_percent,message,world_id,world_version_id,duplicate,error_message
           FROM import_progress_status
          WHERE owner_user_id=$1 AND lookup_key_hash=$2 AND expires_at > clock_timestamp()`,
        [identity.ownerUserId, identity.keyHash],
      );
      const row = selected.rows[0];
      return row === undefined ? null : projection(row);
    }
  };
  return Object.freeze(repository);
}
