import type { DatabasePool } from "../../../packages/database/src/pool.js";

export type WorldGenerationProgressStatus = "processing" | "completed" | "failed";

export type WorldGenerationProgress = {
  status: WorldGenerationProgressStatus;
  phase: string;
  progressPercent: number;
  message: string;
  errorMessage?: string;
};

type WorldGenerationProgressRow = {
  status: WorldGenerationProgressStatus;
  phase: string;
  progress_percent: number;
  message: string;
  error_message: string | null;
};

const PROCESSING_EXPIRY = "30 minutes";
const TERMINAL_EXPIRY = "5 minutes";

function expiryInterval(status: WorldGenerationProgressStatus): string {
  return status === "processing" ? PROCESSING_EXPIRY : TERMINAL_EXPIRY;
}

function toProgress(row: WorldGenerationProgressRow): WorldGenerationProgress {
  return {
    status: row.status,
    phase: row.phase,
    progressPercent: Number(row.progress_percent),
    message: row.message,
    ...(row.error_message ? { errorMessage: row.error_message } : {})
  };
}

export async function createWorldGenerationProgress(pool: DatabasePool, ownerUserId: string, progressKey: string): Promise<void> {
  await pool.query(
    `INSERT INTO world_generation_progress (progress_key, owner_user_id, status, phase, progress_percent, message, expires_at)
     VALUES ($1, $2, 'processing', 'queued', 0, '', now() + $3::interval)
     ON CONFLICT (progress_key) DO NOTHING`,
    [progressKey, ownerUserId, PROCESSING_EXPIRY]
  );
}

export async function updateWorldGenerationProgress(
  pool: DatabasePool,
  ownerUserId: string,
  progressKey: string,
  progress: WorldGenerationProgress
): Promise<void> {
  await pool.query(
    `UPDATE world_generation_progress
        SET status = $3,
            phase = $4,
            progress_percent = $5,
            message = $6,
            error_message = $7,
            updated_at = now(),
            expires_at = now() + $8::interval
      WHERE progress_key = $1 AND owner_user_id = $2 AND expires_at > now()`,
    [
      progressKey,
      ownerUserId,
      progress.status,
      progress.phase,
      progress.progressPercent,
      progress.message,
      progress.errorMessage ?? null,
      expiryInterval(progress.status)
    ]
  );
}

export async function getWorldGenerationProgress(
  pool: DatabasePool,
  ownerUserId: string,
  progressKey: string
): Promise<WorldGenerationProgress | null> {
  const result = await pool.query<WorldGenerationProgressRow>(
    `SELECT status, phase, progress_percent, message, error_message
       FROM world_generation_progress
      WHERE progress_key = $1 AND owner_user_id = $2 AND expires_at > now()`,
    [progressKey, ownerUserId]
  );
  const row = result.rows[0];
  return row ? toProgress(row) : null;
}

export async function deleteExpiredWorldGenerationProgress(pool: DatabasePool): Promise<number> {
  const result = await pool.query(
    "DELETE FROM world_generation_progress WHERE expires_at <= now()"
  );
  return result.rowCount ?? 0;
}
