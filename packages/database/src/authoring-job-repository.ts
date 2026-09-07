import {
  authoringFailureSchema,
  authoringExecutionSnapshotSchema,
  authoringJobListItemSchema,
  authoringStageOutputSchema,
  authoringJobViewSchema,
  parseAuthoringCommandForJob,
  type AuthoringReview,
  normalizeAuthoringSubmitForAdmission,
  authoringSubmitSchema,
  authoringTargetSchema,
  type AuthoringExecutionSnapshot,
  type AuthoringFailure,
  type AuthoringJobListItem,
  type AuthoringJobView,
  type AuthoringStageOutput,
  type AuthoringSubmit
} from "../../contracts/src/authoring.js";
import { randomUUID } from "node:crypto";
import { playableCharacterSchema, type WorldContent } from "../../contracts/src/world-library.js";
import type {
  AuthoringClaim,
  AuthoringExecutionRepository,
  AuthoringTargetPort
} from "../../application/src/authoring/ports.js";
import { AuthoringRepositoryError } from "../../application/src/authoring/types.js";
import type { OwnerScope } from "../../application/src/generation/types.js";
import { retryAuthoringStage, type AuthoringStageLifecycle } from "../../domain/src/authoring-jobs.js";
import { projectAuthoringFailure, validateGeneratedCharacter, validateGeneratedWorldFiction } from "../../domain/src/authoring-output.js";
import { assembleGeneratedWorldContent } from "../../domain/src/generated-world-assembly.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "./pool.js";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_LEASE_SECONDS = 3_600;
const PAGE_SIZE = 20;

type JobRow = {
  id: string;
  ownerUserId: string;
  kind: unknown;
  target: unknown;
  input: unknown;
  requestHash: string;
  idempotencyKey: string;
  status: unknown;
  revision: number;
  executionGeneration: number;
  executionSnapshot: unknown;
  reviewedContent: unknown;
  reviewGeneration: number;
  expiresAt: unknown;
  createdAt: unknown;
};
type JobListRow = Pick<JobRow, "id" | "kind" | "target" | "status" | "revision" | "expiresAt" | "createdAt">;

type StageRow = {
  id: string;
  jobId: string;
  ownerUserId: string;
  stageKey: string;
  generation: number;
  parentGenerations: unknown;
  status: unknown;
  attemptCount: number;
  retryCount: number;
  leaseToken: string | null;
  leaseExpiresAt: unknown;
  output: unknown;
  failure: unknown;
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  throw new Error("Authoring repository returned an invalid timestamp.");
}

function leaseSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LEASE_SECONDS) {
    throw new RangeError(`Authoring lease seconds must be an integer from 1 to ${MAX_LEASE_SECONDS}.`);
  }
  return value;
}

function requestHash(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError("Authoring request hash must be a SHA-256 hex digest.");
  return value;
}

function validateStageOutput(stageKey: string, value: unknown): AuthoringStageOutput {
  const output = authoringStageOutputSchema.parse(value);
  if (stageKey === "world" && output.kind !== "outline") throw new TypeError("The world stage requires an outline output.");
  if (stageKey.startsWith("character:") && output.kind !== "character") throw new TypeError("A character stage requires a character output.");
  if (stageKey.startsWith("character:") && output.kind === "character") {
    const expectedId = stageKey.slice("character:".length);
    if (expectedId !== "initial" && output.character.id !== expectedId) throw new TypeError("The character output does not match its assigned stage identity.");
  }
  if (stageKey !== "world" && !stageKey.startsWith("character:")) throw new TypeError("Unknown durable authoring stage key.");
  if (output.kind === "character") {
    validateGeneratedCharacter(output.character, "creative");
  } else {
    validateGeneratedWorldFiction(output.outline);
    for (const seed of output.outline.seeds) {
      validateGeneratedWorldFiction({
        title: seed.name,
        genre: seed.role,
        tone: seed.concept,
        backgroundStory: seed.narrativeHook,
        premise: seed.concept,
        firstAction: seed.narrativeHook
      });
    }
  }
  return output;
}

function stageKey(input: AuthoringSubmit): string {
  if (input.kind === "world_concept") return "world";
  const targetCharacterId = input.target.kind === "world_draft" ? input.target.characterId : undefined;
  // Called only after inserting a new job. Keep application identity in the stage,
  // because public characterId denotes an existing roster member to edit.
  return `character:${input.characterId ?? targetCharacterId ?? randomUUID()}`;
}

function isDiscardedInput(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).discarded === true;
}

function jobView(job: JobRow, stages: StageRow[]): AuthoringJobView {
  if (isDiscardedInput(job.input)) throw new AuthoringRepositoryError("not_found");
  const input = authoringSubmitSchema.parse(job.input);
  const target = authoringTargetSchema.parse(job.target);
  const parsedStages = stages.map((stage) => {
    if (stage.output !== null && stage.output !== undefined) validateStageOutput(stage.stageKey, stage.output);
    const value = {
      id: stage.id,
      key: stage.stageKey,
      generation: stage.generation,
      status: stage.status,
      attemptCount: stage.attemptCount,
      ...(stage.failure === null || stage.failure === undefined ? {} : { failure: projectAuthoringFailure(authoringFailureSchema.parse(stage.failure)) })
    };
    return value;
  });
  const currentStages = parsedStages.filter((stage) => !parsedStages.some((other) => other.key === stage.key && other.generation > stage.generation));
  const activeStages = currentStages.filter((stage) => stage.status !== "cancelled");
  const allValidated = activeStages.length > 0 && activeStages.every((stage) => stage.status === "validated");
  const result = job.kind === "world_concept" ? partialWorldResult(stages) : undefined;
  return authoringJobViewSchema.parse({
    id: job.id,
    kind: job.kind,
    revision: job.revision,
    status: job.status,
    target,
    stages: parsedStages,
    expiresAt: timestamp(job.expiresAt),
    canApply: job.status === "awaiting_review" || job.status === "recoverable",
    incomplete: !allValidated,
    request: input,
    ...(result === undefined ? {} : { result }),
    ...(job.reviewedContent === null || job.reviewedContent === undefined ? {} : { reviewedContent: job.reviewedContent })
  });
}

/** Build a reviewable preview solely from validated active stages; it never fills missing characters. */
function partialWorldResult(stages: readonly StageRow[]): WorldContent | undefined {
  const current = currentStagesForRows(stages).filter((stage) => stage.status !== "cancelled");
  const outlineStage = current.find((stage) => stage.stageKey === "world" && stage.status === "validated");
  if (!outlineStage?.output) return undefined;
  const outline = validateStageOutput("world", outlineStage.output);
  if (outline.kind !== "outline") return undefined;
  const characterIds = new Set(outline.outline.seeds.map((seed) => seed.id));
  const playableCharacters = current
    .filter((stage) => stage.stageKey.startsWith("character:") && stage.status === "validated" && stage.output !== null)
    .map((stage) => validateStageOutput(stage.stageKey, stage.output))
    .flatMap((output) => output.kind === "character" && characterIds.has(output.character.id) ? [output.character] : []);
  return assembleGeneratedWorldContent({
    outline: outline.outline,
    playableCharacters,
    importedFrom: "authoring-proposal"
  });
}

function currentStagesForRows(rows: readonly StageRow[]): StageRow[] {
  return rows.filter((stage) => !rows.some((other) => other.stageKey === stage.stageKey && other.generation > stage.generation));
}

function listItem(job: JobRow, stages: StageRow[]): AuthoringJobListItem {
  const view = jobView(job, stages);
  const { request: _request, result: _result, reviewedContent: _reviewedContent, ...item } = view;
  return authoringJobListItemSchema.parse(item);
}

function decodeListCursor(cursor?: string): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== "string" || Number.isNaN(Date.parse(parsed.createdAt)) || typeof parsed.id !== "string") throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch { throw new TypeError("Invalid authoring job list cursor."); }
}

function encodeListCursor(createdAt: unknown, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: timestamp(createdAt), id })).toString("base64url");
}

function metadataListItem(job: JobListRow, stages: StageRow[]): AuthoringJobListItem {
  const views = stages.map((stage) => ({ id: stage.id, key: stage.stageKey, generation: stage.generation, status: stage.status, attemptCount: stage.attemptCount, ...(stage.failure === null || stage.failure === undefined ? {} : { failure: projectAuthoringFailure(authoringFailureSchema.parse(stage.failure)) }) }));
  const current = views.filter((stage) => !views.some((other) => other.key === stage.key && other.generation > stage.generation) && stage.status !== "cancelled");
  return authoringJobListItemSchema.parse({ id: job.id, kind: job.kind, revision: job.revision, status: job.status, target: authoringTargetSchema.parse(job.target), stages: views, expiresAt: timestamp(job.expiresAt), canApply: job.status === "awaiting_review" || job.status === "recoverable", incomplete: !(current.length > 0 && current.every((stage) => stage.status === "validated")) });
}

const JOB_SELECT = `
  id, owner_user_id AS "ownerUserId", kind, target, input,
  request_hash AS "requestHash", idempotency_key AS "idempotencyKey", status,
  revision, execution_generation AS "executionGeneration",
  execution_snapshot AS "executionSnapshot", reviewed_content AS "reviewedContent",
  review_generation AS "reviewGeneration", expires_at AS "expiresAt", created_at AS "createdAt"`;
const JOB_LIST_SELECT = `id, kind, target, status, revision, expires_at AS "expiresAt", to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"`;

const STAGE_SELECT = `
  id, job_id AS "jobId", owner_user_id AS "ownerUserId", stage_key AS "stageKey",
  generation, parent_generations AS "parentGenerations", status,
  attempt_count AS "attemptCount", retry_count AS "retryCount",
  lease_token AS "leaseToken", lease_expires_at AS "leaseExpiresAt", output, failure`;

const STAGE_RETURNING = `
  stages.id, stages.job_id AS "jobId", stages.owner_user_id AS "ownerUserId", stages.stage_key AS "stageKey",
  stages.generation, stages.parent_generations AS "parentGenerations", stages.status,
  stages.attempt_count AS "attemptCount", stages.retry_count AS "retryCount",
  stages.lease_token AS "leaseToken", stages.lease_expires_at AS "leaseExpiresAt", stages.output, stages.failure`;

export function createPostgresAuthoringRepository(pool: DatabasePool): AuthoringExecutionRepository {
  async function loadStages(jobIds: readonly string[]): Promise<Map<string, StageRow[]>> {
    const byJob = new Map<string, StageRow[]>();
    if (!jobIds.length) return byJob;
    const result = await pool.query<StageRow>(
      `SELECT ${STAGE_SELECT} FROM authoring_job_stages
        WHERE job_id = ANY($1::uuid[]) ORDER BY stage_key, generation`,
      [jobIds]
    );
    for (const stage of result.rows) {
      const current = byJob.get(stage.jobId) ?? [];
      current.push(stage);
      byJob.set(stage.jobId, current);
    }
    return byJob;
  }

  async function readOne(scope: OwnerScope, jobId: string): Promise<AuthoringJobView | null> {
    const jobs = await pool.query<JobRow>(
      `SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1 AND owner_user_id = $2`,
      [jobId, scope.ownerUserId]
    );
    const job = jobs.rows[0];
    if (!job || isDiscardedInput(job.input)) return null;
    const stages = await loadStages([job.id]);
    return jobView(job, stages.get(job.id) ?? []);
  }

  async function assertDraftTarget(client: DatabaseClient, scope: OwnerScope, target: { worldId: string; expectedRevision: number; characterId?: string | undefined }): Promise<void> {
    const draft = await client.query<{ revision: number; content: unknown }>(
      `SELECT wd.revision, wd.content FROM worlds w
        JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
       WHERE w.id = $1 AND w.owner_user_id = $2 AND w.status <> 'archived'
       FOR KEY SHARE OF w, wd`,
      [target.worldId, scope.ownerUserId]
    );
    const current = draft.rows[0];
    if (!current) throw new AuthoringRepositoryError("not_found");
    if (current.revision !== target.expectedRevision) throw new AuthoringRepositoryError("revision_conflict");
    if (target.characterId !== undefined) {
      const matches = await client.query(
        `SELECT 1 FROM jsonb_array_elements(COALESCE($1::jsonb->'playableCharacters', '[]'::jsonb)) character
          WHERE character->>'id' = $2`,
        [json(current.content), target.characterId]
      );
      if (matches.rowCount !== 1) throw new AuthoringRepositoryError("not_found");
    }
  }

  function claimParameters(claim: AuthoringClaim): unknown[] {
    return [
      claim.stageId, claim.jobId, claim.ownerUserId, claim.jobGeneration,
      claim.stageGeneration, claim.leaseToken
    ];
  }

  async function parentsAreValidated(client: DatabaseClient, jobId: string, rawParents: unknown): Promise<boolean> {
    if (!rawParents || typeof rawParents !== "object" || Array.isArray(rawParents)) return false;
    const entries = Object.entries(rawParents as Record<string, unknown>);
    if (entries.some(([, generation]) => !Number.isInteger(generation) || (generation as number) < 1)) return false;
    for (const [key, generation] of entries) {
      const parent = await client.query<{ status: string }>(
        `SELECT status FROM authoring_job_stages
          WHERE job_id = $1 AND stage_key = $2 AND generation = $3
            AND generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = authoring_job_stages.job_id AND current.stage_key = authoring_job_stages.stage_key)`,
        [jobId, key, generation]
      );
      if (parent.rows[0]?.status !== "validated") return false;
    }
    return true;
  }

  async function stageIsCurrent(client: DatabaseClient, stage: StageRow): Promise<boolean> {
    const latest = await client.query<{ generation: number }>(
      `SELECT max(generation)::int AS generation FROM authoring_job_stages WHERE job_id = $1 AND stage_key = $2`,
      [stage.jobId, stage.stageKey]
    );
    return latest.rows[0]?.generation === stage.generation;
  }

  async function withCurrentClaim<T>(claim: AuthoringClaim, work: (client: DatabaseClient, job: JobRow, stage: StageRow) => Promise<T>): Promise<T | null> {
    return withTransaction(pool, async (client) => {
      const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [claim.jobId, claim.ownerUserId]);
      const job = jobs.rows[0];
      if (!job || job.executionGeneration !== claim.jobGeneration || job.status !== "running") return null;
      const stages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE id = $1 AND job_id = $2 AND owner_user_id = $3 FOR UPDATE`, [claim.stageId, claim.jobId, claim.ownerUserId]);
      const stage = stages.rows[0];
      if (!stage || stage.generation !== claim.stageGeneration || stage.status !== "running" || stage.leaseToken !== claim.leaseToken) return null;
      const lease = await client.query("SELECT 1 FROM authoring_job_stages WHERE id = $1 AND lease_expires_at > clock_timestamp()", [stage.id]);
      if (lease.rowCount !== 1 || !(await stageIsCurrent(client, stage)) || !(await parentsAreValidated(client, stage.jobId, stage.parentGenerations))) return null;
      return work(client, job, stage);
    });
  }

  async function completeCurrentStages(client: DatabaseClient, jobId: string): Promise<boolean> {
    const stages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages stages WHERE stages.job_id = $1 AND stages.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = stages.job_id AND current.stage_key = stages.stage_key)`, [jobId]);
    const active = stages.rows.filter((stage) => stage.status !== "cancelled");
    if (active.length === 0) return false;
    for (const stage of active) {
      if (stage.status !== "validated" || !await parentsAreValidated(client, jobId, stage.parentGenerations)) return false;
    }
    return true;
  }

  /**
   * The world checkpoint and its active child roster share the claim transaction.
   * Regeneration placeholders from P2.3 are retained only when their assigned
   * application identities still occur in the newly accepted outline.
   */
  async function reconcileOutlineChildren(client: DatabaseClient, job: JobRow, stage: StageRow, output: AuthoringStageOutput): Promise<void> {
    if (output.kind !== "outline") return;
    const desired = new Set(output.outline.seeds.map((seed) => `character:${seed.id}`));
    if (desired.size !== output.outline.seeds.length) throw new TypeError("The durable outline requires unique assigned character identities.");
    // Legacy synchronous-compatible fixtures can carry no seed roster. They do
    // not declare a replacement roster, so preserve already-created children.
    if (desired.size === 0) return;
    const all = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE job_id = $1 AND stage_key LIKE 'character:%' FOR UPDATE`, [job.id]);
    const current = currentStagesForRows(all.rows);
    const hasCurrentParent = (candidate: StageRow) => {
      const parents = candidate.parentGenerations as Record<string, unknown>;
      return Number(parents.world) === stage.generation;
    };
    for (const key of desired) {
      const existing = current.find((candidate) => candidate.stageKey === key && hasCurrentParent(candidate));
      if (existing) continue;
      const generations = all.rows.filter((candidate) => candidate.stageKey === key).map((candidate) => candidate.generation);
      const generation = generations.length ? Math.max(...generations) + 1 : 1;
      await client.query(
        `INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, generation, parent_generations, status, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', clock_timestamp())`,
        [job.id, job.ownerUserId, key, generation, json({ world: stage.generation })]
      );
    }
    const obsolete = current.filter((candidate) => candidate.stageKey.startsWith("character:") && hasCurrentParent(candidate) && !desired.has(candidate.stageKey) && ["queued", "running", "recoverable"].includes(String(candidate.status)));
    if (obsolete.length) {
      await client.query(
        `UPDATE authoring_job_stages
            SET status = 'cancelled', lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
          WHERE id = ANY($1::uuid[])`,
        [obsolete.map((candidate) => candidate.id)]
      );
    }
  }

  async function lockedView(client: DatabaseClient, jobId: string): Promise<AuthoringJobView> {
    const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1`, [jobId]);
    const job = jobs.rows[0];
    if (!job || isDiscardedInput(job.input)) throw new AuthoringRepositoryError("not_found");
    const stages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE job_id = $1 ORDER BY stage_key, generation`, [jobId]);
    return jobView(job, stages.rows);
  }

  function currentStages(rows: readonly StageRow[]): StageRow[] {
    return rows.filter((stage) => !rows.some((other) => other.stageKey === stage.stageKey && other.generation > stage.generation));
  }

  function commandJob(job: JobRow, expectedRevision: number): void {
    if (isDiscardedInput(job.input)) throw new AuthoringRepositoryError("not_found");
    if (job.revision !== expectedRevision) throw new AuthoringRepositoryError("revision_conflict");
  }

  async function requireUnexpired(client: DatabaseClient, jobId: string): Promise<void> {
    const active = await client.query("SELECT 1 FROM authoring_jobs WHERE id = $1 AND expires_at > clock_timestamp()", [jobId]);
    if (active.rowCount !== 1) throw new AuthoringRepositoryError("invalid_state");
  }

  return {
    async findIdempotency(scope, idempotencyKey) {
      const existing = await pool.query<JobRow>(
        `SELECT ${JOB_SELECT} FROM authoring_jobs WHERE owner_user_id = $1 AND idempotency_key = $2`,
        [scope.ownerUserId, idempotencyKey]
      );
      const job = existing.rows[0];
      if (!job) return null;
      if (isDiscardedInput(job.input)) return { requestHash: job.requestHash, job: null };
      const stages = await loadStages([job.id]);
      return { requestHash: job.requestHash, job: jobView(job, stages.get(job.id) ?? []) };
    },
    async submit(scope, rawInput, rawHash) {
      const input = normalizeAuthoringSubmitForAdmission(authoringSubmitSchema.parse(rawInput));
      const hash = requestHash(rawHash);
      const encoded = json(input);
      if (Buffer.byteLength(encoded, "utf8") > MAX_INPUT_BYTES) {
        throw new RangeError("Authoring input exceeds the 2 MiB durable submission limit.");
      }
      const job = await withTransaction(pool, async (client) => {
        const existing = await client.query<JobRow>(
          `SELECT ${JOB_SELECT} FROM authoring_jobs WHERE owner_user_id = $1 AND idempotency_key = $2 FOR UPDATE`,
          [scope.ownerUserId, input.idempotencyKey]
        );
        const replay = existing.rows[0];
        if (replay) {
          if (replay.requestHash !== hash) throw new AuthoringRepositoryError("idempotency_conflict");
          if (isDiscardedInput(replay.input)) throw new AuthoringRepositoryError("invalid_state");
          return replay;
        }
        if (input.target.kind === "world_draft") await assertDraftTarget(client, scope, input.target);
        const inserted = await client.query<JobRow>(
          `INSERT INTO authoring_jobs (owner_user_id, kind, target, input, request_hash, idempotency_key)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
           ON CONFLICT (owner_user_id, idempotency_key) DO NOTHING
           RETURNING ${JOB_SELECT}`,
          [scope.ownerUserId, input.kind, json(input.target), encoded, hash, input.idempotencyKey]
        );
        const created = inserted.rows[0];
        if (created) {
          await client.query(
            `INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key)
             VALUES ($1, $2, $3)`,
            [created.id, scope.ownerUserId, stageKey(input)]
          );
          return created;
        }
        const concurrent = await client.query<JobRow>(
          `SELECT ${JOB_SELECT} FROM authoring_jobs WHERE owner_user_id = $1 AND idempotency_key = $2`,
          [scope.ownerUserId, input.idempotencyKey]
        );
        const raced = concurrent.rows[0];
        if (!raced) throw new Error("Authoring idempotency replay was not readable.");
        if (raced.requestHash !== hash) throw new AuthoringRepositoryError("idempotency_conflict");
        if (isDiscardedInput(raced.input)) throw new AuthoringRepositoryError("invalid_state");
        return raced;
      });
      const stages = await loadStages([job.id]);
      return jobView(job, stages.get(job.id) ?? []);
    },

    read: readOne,

    async list(scope, cursor) {
      const after = decodeListCursor(cursor);
      const jobs = await pool.query<JobListRow>(
        `SELECT ${JOB_LIST_SELECT} FROM authoring_jobs
          WHERE owner_user_id = $1
            AND input <> '{"discarded":true}'::jsonb
            AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz OR (created_at = $2::timestamptz AND id < $3::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $4`,
        [scope.ownerUserId, after?.createdAt ?? null, after?.id ?? null, PAGE_SIZE + 1]
      );
      const page = jobs.rows.slice(0, PAGE_SIZE);
      const stageRows = page.length ? await pool.query<StageRow>(`SELECT id, job_id AS "jobId", owner_user_id AS "ownerUserId", stage_key AS "stageKey", generation, '{}'::jsonb AS "parentGenerations", status, attempt_count AS "attemptCount", retry_count AS "retryCount", NULL::uuid AS "leaseToken", NULL::timestamptz AS "leaseExpiresAt", NULL::jsonb AS output, failure FROM authoring_job_stages WHERE job_id = ANY($1::uuid[]) ORDER BY stage_key, generation`, [page.map((job) => job.id)]) : { rows: [] as StageRow[] };
      const stages = new Map<string, StageRow[]>();
      for (const stage of stageRows.rows) stages.set(stage.jobId, [...(stages.get(stage.jobId) ?? []), stage]);
      const tail = page.at(-1);
      const next = jobs.rows.length > PAGE_SIZE && tail ? encodeListCursor(tail.createdAt, tail.id) : undefined;
      return { jobs: page.map((job) => metadataListItem(job, stages.get(job.id) ?? [])), ...(next ? { nextCursor: next } : {}) };
    },

    async review(scope, jobId, rawInput) {
      return withTransaction(pool, async (client) => {
        const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [jobId, scope.ownerUserId]);
        const job = jobs.rows[0];
        if (!job || isDiscardedInput(job.input)) throw new AuthoringRepositoryError("not_found");
        await requireUnexpired(client, job.id);
        const target = authoringTargetSchema.parse(job.target);
        const input = parseAuthoringCommandForJob({ kind: job.kind as never, target }, "review", rawInput) as AuthoringReview;
        commandJob(job, input.expectedRevision);
        if (!["queued", "running", "awaiting_review", "recoverable"].includes(job.status as string)) throw new AuthoringRepositoryError("invalid_state");
        if ((job.status === "queued" || job.status === "running") && job.reviewedContent === null && input.selectedStageIds.length === 0) throw new AuthoringRepositoryError("invalid_state");
        const request = authoringSubmitSchema.parse(job.input);
        const stages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE job_id = $1 FOR UPDATE`, [job.id]);
        const current = currentStages(stages.rows);
        const characterId = job.kind === "character" && request.kind === "character"
          ? (target.kind === "world_draft" ? target.characterId ?? request.characterId : request.characterId)
            ?? current.find((stage) => stage.stageKey.startsWith("character:"))?.stageKey.slice("character:".length)
          : undefined;
        if (characterId !== undefined && playableCharacterSchema.parse(input.content).id !== characterId) throw new AuthoringRepositoryError("invalid_state");
        const selected = new Set(input.selectedStageIds);
        if (selected.size !== input.selectedStageIds.length || [...selected].some((id) => current.find((stage) => stage.id === id)?.status !== "validated")) {
          throw new AuthoringRepositoryError("invalid_state");
        }
        await client.query(
          `UPDATE authoring_jobs SET reviewed_content = $2::jsonb, review_generation = review_generation + 1,
             revision = revision + 1, last_activity_at = clock_timestamp(), expires_at = clock_timestamp() + interval '7 days', updated_at = clock_timestamp()
           WHERE id = $1`,
          [job.id, json(input.content)]
        );
        return lockedView(client, job.id);
      });
    },

    async retry(scope, jobId, stageId, expectedRevision) {
      return withTransaction(pool, async (client) => {
        const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [jobId, scope.ownerUserId]);
        const job = jobs.rows[0];
        if (!job) throw new AuthoringRepositoryError("not_found");
        await requireUnexpired(client, job.id);
        commandJob(job, expectedRevision);
        if (job.status !== "awaiting_review" && job.status !== "recoverable") throw new AuthoringRepositoryError("invalid_state");
        const stages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE job_id = $1 AND owner_user_id = $2 FOR UPDATE`, [job.id, scope.ownerUserId]);
        const current = currentStages(stages.rows);
        const source = current.find((stage) => stage.id === stageId);
        if (!source) throw new AuthoringRepositoryError("not_found");
        const idsByKey = new Map(current.map((stage) => [stage.stageKey, stage.id]));
        const lifecycle: AuthoringStageLifecycle[] = current.map((stage) => ({
          id: stage.id,
          key: stage.stageKey,
          generation: stage.generation,
          status: stage.status as AuthoringStageLifecycle["status"],
          attemptCount: stage.attemptCount,
          ...(stage.output === null || stage.output === undefined ? {} : { output: stage.output }),
          explicitRetryGenerations: stage.retryCount,
          dependsOn: Object.keys(stage.parentGenerations as Record<string, unknown>).flatMap((key) => {
            const id = idsByKey.get(key);
            return id === undefined ? [] : [id];
          }),
          parentGenerations: stage.parentGenerations as Record<string, number>
        }));
        let next: AuthoringStageLifecycle[];
        try { next = retryAuthoringStage(lifecycle, stageId, { allowValidated: true }); }
        catch { throw new AuthoringRepositoryError("invalid_state"); }
        for (const replacement of next) {
          const prior = lifecycle.find((stage) => stage.id === replacement.id)!;
          if (replacement.generation === prior.generation) continue;
          const original = current.find((stage) => stage.id === replacement.id)!;
          if (original.status === "running") {
            await client.query("UPDATE authoring_job_stages SET status = 'cancelled', lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp() WHERE id = $1", [original.id]);
          }
          await client.query(
            `INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, generation, parent_generations, status, attempt_count, retry_count, next_attempt_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', 0, $6, clock_timestamp())`,
            [job.id, scope.ownerUserId, replacement.key, replacement.generation, json(replacement.parentGenerations ?? {}), replacement.explicitRetryGenerations ?? original.retryCount]
          );
        }
        await client.query(
          `UPDATE authoring_jobs SET status = 'queued', revision = revision + 1,
             last_activity_at = clock_timestamp(), expires_at = clock_timestamp() + interval '7 days', updated_at = clock_timestamp()
           WHERE id = $1`,
          [job.id]
        );
        return lockedView(client, job.id);
      });
    },

    async cancel(scope, jobId, expectedRevision) {
      return withTransaction(pool, async (client) => {
        const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [jobId, scope.ownerUserId]);
        const job = jobs.rows[0];
        if (!job || isDiscardedInput(job.input)) throw new AuthoringRepositoryError("not_found");
        await requireUnexpired(client, job.id);
        if (job.status === "cancelled" && (expectedRevision === job.revision || expectedRevision === job.revision - 1)) return lockedView(client, job.id);
        commandJob(job, expectedRevision);
        if (["failed", "applied", "expired"].includes(job.status as string)) throw new AuthoringRepositoryError("invalid_state");
        await client.query(`SELECT id FROM authoring_job_stages WHERE job_id = $1 FOR UPDATE`, [job.id]);
        await client.query(
          `UPDATE authoring_job_stages SET status = 'cancelled', lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
            WHERE job_id = $1 AND generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = authoring_job_stages.job_id AND current.stage_key = authoring_job_stages.stage_key)
              AND status IN ('queued', 'running', 'recoverable')`,
          [job.id]
        );
        await client.query("UPDATE authoring_jobs SET status = 'cancelled', revision = revision + 1, execution_generation = execution_generation + 1, updated_at = clock_timestamp() WHERE id = $1", [job.id]);
        return lockedView(client, job.id);
      });
    },

    async discard(scope, jobId, expectedRevision) {
      await withTransaction(pool, async (client) => {
        const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [jobId, scope.ownerUserId]);
        const job = jobs.rows[0];
        if (!job) throw new AuthoringRepositoryError("not_found");
        await requireUnexpired(client, job.id);
        if (isDiscardedInput(job.input) && (expectedRevision === job.revision || expectedRevision === job.revision - 1)) return;
        commandJob(job, expectedRevision);
        if (job.status === "applied") throw new AuthoringRepositoryError("invalid_state");
        await client.query(`SELECT id FROM authoring_job_stages WHERE job_id = $1 FOR UPDATE`, [job.id]);
        await client.query(
          `UPDATE authoring_job_stages SET status = CASE WHEN status = 'running' THEN 'cancelled' ELSE status END,
             lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, output = NULL, failure = NULL, updated_at = clock_timestamp()
           WHERE job_id = $1`,
          [job.id]
        );
        await client.query(
          `UPDATE authoring_jobs SET input = '{"discarded":true}'::jsonb, reviewed_content = NULL, execution_snapshot = NULL,
             status = 'cancelled', revision = revision + 1, execution_generation = execution_generation + 1, updated_at = clock_timestamp()
           WHERE id = $1`,
          [job.id]
        );
      });
    },

    async claim(workerId, requestedLeaseSeconds) {
      const seconds = leaseSeconds(requestedLeaseSeconds);
      if (!workerId.trim()) throw new TypeError("Authoring worker ID is required.");
      const claim = await withTransaction(pool, async (client) => {
        const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs jobs WHERE jobs.status IN ('queued','running') AND jobs.expires_at > clock_timestamp() AND EXISTS (SELECT 1 FROM authoring_job_stages stages WHERE stages.job_id = jobs.id AND stages.owner_user_id = jobs.owner_user_id AND stages.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = stages.job_id AND current.stage_key = stages.stage_key) AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(stages.parent_generations) dependency LEFT JOIN authoring_job_stages parent ON parent.job_id = stages.job_id AND parent.stage_key = dependency.key AND parent.generation = dependency.value::int AND parent.status = 'validated' AND parent.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = parent.job_id AND current.stage_key = parent.stage_key) WHERE parent.id IS NULL) AND (stages.status = 'queued' AND stages.next_attempt_at <= clock_timestamp() OR stages.status = 'running' AND stages.lease_expires_at <= clock_timestamp() AND stages.attempt_count <= 3)) ORDER BY jobs.created_at, jobs.id FOR UPDATE SKIP LOCKED LIMIT 1`);
        const job = jobs.rows[0];
        if (!job) return null;
        const stages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages stages WHERE stages.job_id = $1 AND stages.owner_user_id = $2 AND stages.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = stages.job_id AND current.stage_key = stages.stage_key) AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(stages.parent_generations) dependency LEFT JOIN authoring_job_stages parent ON parent.job_id = stages.job_id AND parent.stage_key = dependency.key AND parent.generation = dependency.value::int AND parent.status = 'validated' AND parent.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = parent.job_id AND current.stage_key = parent.stage_key) WHERE parent.id IS NULL) AND ((stages.status = 'queued' AND stages.next_attempt_at <= clock_timestamp()) OR (stages.status = 'running' AND stages.lease_expires_at <= clock_timestamp() AND stages.attempt_count <= 3)) ORDER BY stages.next_attempt_at, stages.created_at, stages.id FOR UPDATE SKIP LOCKED LIMIT 1`, [job.id, job.ownerUserId]);
        const stage = stages.rows[0];
        if (!stage || !(await parentsAreValidated(client, job.id, stage.parentGenerations))) return null;
        await client.query("UPDATE authoring_job_stages SET status = 'running', attempt_count = attempt_count + 1, lease_token = gen_random_uuid(), lease_owner = $2, lease_expires_at = clock_timestamp() + make_interval(secs => $3::int), started_at = COALESCE(started_at, clock_timestamp()), updated_at = clock_timestamp() WHERE id = $1", [stage.id, workerId, seconds]);
        const row = (await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages WHERE id = $1`, [stage.id])).rows[0]!;
        await client.query("UPDATE authoring_jobs SET status = 'running', last_activity_at = clock_timestamp(), expires_at = clock_timestamp() + interval '7 days', updated_at = clock_timestamp() WHERE id = $1", [job.id]);
        return { jobId: job.id, stageId: row.id, ownerUserId: job.ownerUserId, jobGeneration: job.executionGeneration, stageGeneration: row.generation, leaseToken: row.leaseToken!, leaseExpiresAt: timestamp(row.leaseExpiresAt) };
      });
      if (claim) return claim;
      await withTransaction(pool, async (client) => {
        const jobs = await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM authoring_jobs jobs WHERE jobs.status = 'running' AND EXISTS (SELECT 1 FROM authoring_job_stages stages WHERE stages.job_id = jobs.id AND stages.status = 'running' AND stages.lease_expires_at <= clock_timestamp() AND stages.attempt_count > 3 AND stages.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = stages.job_id AND current.stage_key = stages.stage_key)) ORDER BY jobs.created_at, jobs.id FOR UPDATE SKIP LOCKED LIMIT 1`);
        const job = jobs.rows[0];
        if (!job) return;
        const stages = await client.query<StageRow>(`SELECT ${STAGE_SELECT} FROM authoring_job_stages stages WHERE job_id = $1 AND status = 'running' AND lease_expires_at <= clock_timestamp() AND attempt_count > 3 AND generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = stages.job_id AND current.stage_key = stages.stage_key) ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1`, [job.id]);
        const stage = stages.rows[0];
        if (!stage) return;
        await client.query("UPDATE authoring_job_stages SET status = 'recoverable', lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, failure = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1", [stage.id, json(projectAuthoringFailure({ code: "authoring_retry_exhausted", stage: stage.stageKey === "world" ? "world" : "character", retryable: false, issues: [] }))]);
        await client.query("UPDATE authoring_jobs SET status = 'recoverable', updated_at = clock_timestamp() WHERE id = $1", [job.id]);
      });
      return null;
    },

    async heartbeat(claim, requestedLeaseSeconds) {
      const seconds = leaseSeconds(requestedLeaseSeconds);
      return (await withCurrentClaim(claim, async (client, _job, stage) => (await client.query("UPDATE authoring_job_stages SET lease_expires_at = clock_timestamp() + make_interval(secs => $2::int), updated_at = clock_timestamp() WHERE id = $1 AND lease_expires_at > clock_timestamp()", [stage.id, seconds])).rowCount === 1)) ?? false;
    },

    async checkpoint(claim, rawOutput) {
      const parsedOutput = authoringStageOutputSchema.parse(rawOutput);
      return (await withCurrentClaim(claim, async (client, job, stage) => {
        const output = validateStageOutput(stage.stageKey, parsedOutput);
        const updated = await client.query("UPDATE authoring_job_stages SET status = 'validated', output = $2::jsonb, failure = NULL, lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, completed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1 AND lease_expires_at > clock_timestamp()", [stage.id, json(output)]);
        if (updated.rowCount !== 1) return false;
        await reconcileOutlineChildren(client, job, stage, output);
        const complete = await completeCurrentStages(client, job.id);
        await client.query("UPDATE authoring_jobs SET status = $2, last_activity_at = clock_timestamp(), expires_at = clock_timestamp() + interval '7 days', updated_at = clock_timestamp() WHERE id = $1", [job.id, complete ? "awaiting_review" : "running"]);
        return true;
      })) ?? false;
    },

    async fail(claim, rawFailure) {
      const failure = projectAuthoringFailure(authoringFailureSchema.parse(rawFailure));
      return (await withCurrentClaim(claim, async (client, job, stage) => {
        const retainsPartialWorld = stage.stageKey.startsWith("character:") && (await client.query(
          `SELECT 1 FROM authoring_job_stages world
            WHERE world.job_id = $1 AND world.stage_key = 'world' AND world.status = 'validated'
              AND world.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = world.job_id AND current.stage_key = 'world')`,
          [job.id]
        )).rowCount === 1;
        const stageStatus = failure.retryable ? "recoverable" : "failed";
        const jobStatus = failure.retryable || retainsPartialWorld ? "recoverable" : "failed";
        const updated = await client.query("UPDATE authoring_job_stages SET status = $2, failure = $3::jsonb, lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, completed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1 AND lease_expires_at > clock_timestamp()", [stage.id, stageStatus, json(failure)]);
        if (updated.rowCount !== 1) return false;
        await client.query("UPDATE authoring_jobs SET status = $2, last_activity_at = clock_timestamp(), expires_at = clock_timestamp() + interval '7 days', updated_at = clock_timestamp() WHERE id = $1", [job.id, jobStatus]);
        return true;
      })) ?? false;
    },

    async readClaimInput(claim) {
      return (await withCurrentClaim(claim, async (_client, job) => authoringSubmitSchema.parse(job.input))) ?? null;
    },

    async initializeExecutionSnapshot(claim, rawSnapshot) {
      const snapshot = authoringExecutionSnapshotSchema.parse(rawSnapshot);
      return (await withCurrentClaim(claim, async (client, job) => {
        const result = await client.query<{ executionSnapshot: unknown }>("UPDATE authoring_jobs SET execution_snapshot = COALESCE(execution_snapshot, $2::jsonb), updated_at = clock_timestamp() WHERE id = $1 AND EXISTS (SELECT 1 FROM authoring_job_stages WHERE id = $3 AND lease_expires_at > clock_timestamp()) RETURNING execution_snapshot AS \"executionSnapshot\"", [job.id, json(snapshot), claim.stageId]);
        if (!result.rows[0]) return null;
        return authoringExecutionSnapshotSchema.parse(result.rows[0].executionSnapshot);
      })) ?? null;
    },

    async loadClaim(claim) {
      return (await withCurrentClaim(claim, async (client, job, stage) => {
      if (job.executionSnapshot === null || job.executionSnapshot === undefined) return null;
      const parents = await client.query<{ stageKey: string; output: unknown }>(
        `SELECT parent.stage_key AS "stageKey", parent.output FROM authoring_job_stages child
          JOIN LATERAL jsonb_each_text(child.parent_generations) dependency ON true
          JOIN authoring_job_stages parent
            ON parent.job_id = child.job_id AND parent.stage_key = dependency.key
           AND parent.generation = dependency.value::int AND parent.status = 'validated'
         WHERE child.id = $1 ORDER BY parent.stage_key, parent.generation`,
        [stage.id]
      );
      return {
        input: authoringSubmitSchema.parse(job.input),
        snapshot: authoringExecutionSnapshotSchema.parse(job.executionSnapshot),
        stageKey: stage.stageKey,
        parentOutputs: parents.rows.map((parent) => validateStageOutput(parent.stageKey, parent.output))
      };
      })) ?? null;
    }
  };
}

/** Owner/revision-scoped draft validation used before first enqueue. It has no publishing capability. */
export function createPostgresAuthoringTargetPort(pool: DatabasePool): AuthoringTargetPort {
  return {
    assertCurrent: async (scope, target) => withTransaction(pool, async (client) => {
      const draft = await client.query<{ revision: number; content: unknown }>(
        `SELECT wd.revision, wd.content FROM worlds w
          JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
         WHERE w.id = $1 AND w.owner_user_id = $2 AND w.status <> 'archived'
         FOR KEY SHARE OF w, wd`,
        [target.worldId, scope.ownerUserId]
      );
      const current = draft.rows[0];
      if (!current) throw new AuthoringRepositoryError("not_found");
      if (current.revision !== target.expectedRevision) throw new AuthoringRepositoryError("revision_conflict");
      if (target.characterId !== undefined) {
        const matches = await client.query(
          `SELECT 1 FROM jsonb_array_elements(COALESCE($1::jsonb->'playableCharacters', '[]'::jsonb)) character
            WHERE character->>'id' = $2`,
          [json(current.content), target.characterId]
        );
        if (matches.rowCount !== 1) throw new AuthoringRepositoryError("not_found");
      }
    })
  };
}
