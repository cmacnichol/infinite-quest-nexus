import type {
  ClaimedIllustrationWorkerJob,
  IllustrationWorkerJobFamily,
  IllustrationWorkerJobScope,
  IllustrationWorkerJobTransition,
  IllustrationWorkerPromptResolution,
  IllustrationWorkerRequest,
  IllustrationWorkerRetry,
  IllustrationWorkerStateMachinePort
} from "../../../packages/application/src/index.js";
import { withTransaction, type DatabasePool } from "../../../packages/database/src/pool.js";

type IllustrationWorkerLanes = Readonly<{
  prompt(request: IllustrationWorkerRequest): Promise<boolean>;
  resolution(request: IllustrationWorkerRequest): Promise<boolean>;
  image(request: IllustrationWorkerRequest): Promise<boolean>;
}>;

type ClaimedRow = Readonly<{
  id: string;
  owner_user_id: string;
  campaign_id: string | null;
  turn_id: string | null;
  world_id: string | null;
  attempts: number;
  max_attempts: number;
}>;

type FamilyBinding = Readonly<{
  table: "illustration_prompt_jobs" | "illustration_resolution_jobs" | "image_jobs";
  activeStatus: "refining" | "matching" | "generating";
  claimableWhere: string;
  claimOrder: string;
  incrementAttempts: string;
  allowedTransitions: readonly IllustrationWorkerJobTransition["status"][];
  projection: string;
}>;

const FAMILY_BINDINGS: Readonly<Record<IllustrationWorkerJobFamily, FamilyBinding>> = {
  prompt: {
    table: "illustration_prompt_jobs",
    activeStatus: "refining",
    claimableWhere: "(status IN ('queued', 'recoverable') AND next_attempt_at <= now()) OR (status = 'refining' AND lease_expires_at < now())",
    claimOrder: "created_at",
    incrementAttempts: "1",
    allowedTransitions: ["completed", "recoverable", "failed", "cancelled"],
    projection: "id, owner_user_id, campaign_id, turn_id, NULL::uuid AS world_id, attempts, max_attempts"
  },
  resolution: {
    table: "illustration_resolution_jobs",
    activeStatus: "matching",
    claimableWhere: "(status IN ('queued', 'recoverable') AND next_attempt_at <= now()) OR (status = 'matching' AND lease_expires_at < now())",
    claimOrder: "created_at ASC",
    incrementAttempts: "1",
    allowedTransitions: ["completed", "recoverable", "failed", "cancelled"],
    projection: "id, owner_user_id, campaign_id, turn_id, NULL::uuid AS world_id, attempts, max_attempts"
  },
  image: {
    table: "image_jobs",
    activeStatus: "generating",
    claimableWhere: "(status = 'queued' AND next_attempt_at <= now()) OR (status = 'provider_pending' AND next_poll_at <= now()) OR (status IN ('generating', 'downloading') AND lease_expires_at < now())",
    claimOrder: "COALESCE(next_poll_at, next_attempt_at), created_at",
    incrementAttempts: "CASE WHEN remote_job_id IS NULL THEN 1 ELSE 0 END",
    allowedTransitions: ["generating", "provider_pending", "downloading", "completed", "recoverable", "failed", "cancelled"],
    projection: "id, owner_user_id, campaign_id, turn_id, world_id, attempts, max_attempts"
  }
};

function binding(family: IllustrationWorkerJobFamily): FamilyBinding {
  return FAMILY_BINDINGS[family];
}

function claimed(
  row: ClaimedRow | undefined,
  family: IllustrationWorkerJobFamily,
  request: IllustrationWorkerRequest,
): ClaimedIllustrationWorkerJob | null {
  if (!row) return null;
  return {
    jobId: row.id,
    ownerUserId: row.owner_user_id,
    workerId: request.workerId,
    leaseSeconds: request.leaseSeconds,
    family,
    campaignId: row.campaign_id,
    turnId: row.turn_id,
    worldId: row.world_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts
  };
}

function terminal(status: IllustrationWorkerJobTransition["status"]): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
}

function transitionCompletionAssignment(family: IllustrationWorkerJobFamily): string {
  return family === "resolution"
    ? "completed_at = CASE WHEN $6 THEN now() ELSE NULL END,"
    : "completed_at = CASE WHEN $6 THEN now() ELSE completed_at END,";
}

function transitionFailureAssignments(family: IllustrationWorkerJobFamily): string {
  if (family === "resolution") {
    return "reason_code = CASE WHEN $5::jsonb ? 'code' THEN $5::jsonb->>'code' ELSE reason_code END,";
  }
  if (family === "image") {
    return `provider_result_metadata = COALESCE(provider_result_metadata, '{}'::jsonb) || $5::jsonb,
            error_code = CASE WHEN $5::jsonb ? 'code' THEN $5::jsonb->>'code' ELSE error_code END,
            error_message = CASE WHEN $5::jsonb ? 'message' THEN left($5::jsonb->>'message', 4000) ELSE error_message END,`;
  }
  return `error_code = CASE WHEN $5::jsonb ? 'code' THEN $5::jsonb->>'code' ELSE error_code END,
            error_message = CASE WHEN $5::jsonb ? 'message' THEN left($5::jsonb->>'message', 4000) ELSE error_message END,`;
}

function retryFailureAssignments(family: IllustrationWorkerJobFamily): string {
  if (family === "resolution") return "reason_code = $5,";
  return "error_code = $5, error_message = left($6, 4000),";
}

async function claimNext(
  pool: DatabasePool,
  family: IllustrationWorkerJobFamily,
  request: IllustrationWorkerRequest,
): Promise<ClaimedIllustrationWorkerJob | null> {
  const current = binding(family);
  return withTransaction(pool, async (client) => {
    const result = await client.query<ClaimedRow>(
      `WITH candidate AS (
         SELECT id FROM ${current.table}
          WHERE ${current.claimableWhere}
          ORDER BY ${current.claimOrder}
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE ${current.table} jobs
         SET status = $1,
             attempts = attempts + ${current.incrementAttempts},
             lease_owner = $2,
             lease_expires_at = now() + ($3::text || ' seconds')::interval,
              updated_at = now()${family === "resolution" ? ",\n              reason_code = NULL" : ""}
         FROM candidate
        WHERE jobs.id = candidate.id
       RETURNING ${current.projection}`,
      [current.activeStatus, request.workerId, request.leaseSeconds],
    );
    return claimed(result.rows[0], family, request);
  });
}

async function loadClaimed(
  pool: DatabasePool,
  scope: IllustrationWorkerJobScope,
): Promise<ClaimedIllustrationWorkerJob | null> {
  const current = binding(scope.family);
  const result = await pool.query<ClaimedRow>(
    `SELECT ${current.projection}
       FROM ${current.table}
      WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3 AND status = $4
        AND lease_expires_at >= now()`,
    [scope.jobId, scope.ownerUserId, scope.workerId, current.activeStatus],
  );
  return claimed(result.rows[0], scope.family, scope);
}

async function heartbeat(
  pool: DatabasePool,
  scope: IllustrationWorkerJobScope,
): Promise<boolean> {
  const current = binding(scope.family);
  const result = await pool.query(
    `UPDATE ${current.table}
        SET lease_expires_at = now() + ($4::text || ' seconds')::interval, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3 AND status = $5
        AND lease_expires_at >= now()`,
    [scope.jobId, scope.ownerUserId, scope.workerId, scope.leaseSeconds, current.activeStatus],
  );
  return result.rowCount === 1;
}

async function transition(
  pool: DatabasePool,
  scope: IllustrationWorkerJobScope,
  next: IllustrationWorkerJobTransition,
): Promise<boolean> {
  const current = binding(scope.family);
  if (!current.allowedTransitions.includes(next.status)) return false;
  const result = await pool.query(
    `UPDATE ${current.table}
        SET status = $4,
            ${transitionFailureAssignments(scope.family)}
            ${transitionCompletionAssignment(scope.family)}
            lease_owner = CASE WHEN $6 THEN NULL ELSE lease_owner END,
            lease_expires_at = CASE WHEN $6 THEN NULL ELSE lease_expires_at END,
            updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3 AND status = $7
        AND lease_expires_at >= now()`,
    [
      scope.jobId,
      scope.ownerUserId,
      scope.workerId,
      next.status,
      JSON.stringify(next.metadata ?? {}),
      terminal(next.status),
      current.activeStatus
    ],
  );
  return result.rowCount === 1;
}

async function retry(
  pool: DatabasePool,
  scope: IllustrationWorkerJobScope,
  next: IllustrationWorkerRetry,
): Promise<boolean> {
  const current = binding(scope.family);
  const result = await pool.query(
    `UPDATE ${current.table}
        SET status = 'queued',
            next_attempt_at = COALESCE($4::timestamptz, now() + interval '15 seconds'),
            ${retryFailureAssignments(scope.family)}
            completed_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3 AND status IN ($7, 'recoverable')
        AND lease_expires_at >= now()`,
    [scope.jobId, scope.ownerUserId, scope.workerId, next.retryAt ?? null, next.code, next.message, current.activeStatus],
  );
  return result.rowCount === 1;
}

async function resolvePrompt(
  pool: DatabasePool,
  scope: IllustrationWorkerJobScope,
): Promise<IllustrationWorkerPromptResolution | null> {
  const current = binding(scope.family);
  const source = scope.family === "prompt"
    ? `SELECT COALESCE(NULLIF(segments.resolved_prompt, ''), segments.direct_prompt, '') AS prompt,
              jobs.provider_profile_id, jobs.requested_model
         FROM illustration_prompt_jobs jobs
         JOIN turn_illustration_segments segments
           ON segments.id = jobs.segment_id AND segments.owner_user_id = jobs.owner_user_id`
    : scope.family === "resolution"
      ? `SELECT COALESCE(NULLIF(segments.resolved_prompt, ''), NULLIF(turns.image_prompt, ''), '') AS prompt,
                NULL::uuid AS provider_profile_id, NULL::text AS requested_model
           FROM illustration_resolution_jobs jobs
           LEFT JOIN turn_illustration_segments segments
             ON segments.id = jobs.segment_id AND segments.owner_user_id = jobs.owner_user_id
           LEFT JOIN turns ON turns.id = jobs.turn_id AND turns.owner_user_id = jobs.owner_user_id`
      : `SELECT jobs.prompt, jobs.provider_profile_id, jobs.requested_model FROM image_jobs jobs`;
  const result = await pool.query<{
    prompt: string;
    provider_profile_id: string | null;
    requested_model: string | null;
  }>(
    `${source}
      WHERE jobs.id = $1 AND jobs.owner_user_id = $2 AND jobs.lease_owner = $3 AND jobs.status = $4
        AND jobs.lease_expires_at >= now()`,
    [scope.jobId, scope.ownerUserId, scope.workerId, current.activeStatus],
  );
  const row = result.rows[0];
  return row
    ? { prompt: row.prompt, providerProfileId: row.provider_profile_id, model: row.requested_model }
    : null;
}

/**
 * Concrete runtime binding for all illustration worker state operations.
 * Handler lanes remain the live 14a3 execution path; this adapter gives the
 * application surface fenced, owner-scoped database behavior without an API
 * service dependency or a deferred throwing placeholder.
 */
export function createIllustrationWorkerStateMachine(
  pool: DatabasePool,
  lanes: IllustrationWorkerLanes,
): IllustrationWorkerStateMachinePort {
  return {
    claimNextPromptJob: (request) => claimNext(pool, "prompt", request),
    claimNextResolutionJob: (request) => claimNext(pool, "resolution", request),
    claimNextImageJob: (request) => claimNext(pool, "image", request),
    loadClaimedJob: (scope) => loadClaimed(pool, scope),
    heartbeatClaim: (scope) => heartbeat(pool, scope),
    transitionClaim: (scope, next) => transition(pool, scope, next),
    scheduleRetry: (scope, next) => retry(pool, scope, next),
    resolvePrompt: (scope) => resolvePrompt(pool, scope),
    runPromptHandler: lanes.prompt,
    runResolutionHandler: lanes.resolution,
    runImageHandler: lanes.image
  };
}
