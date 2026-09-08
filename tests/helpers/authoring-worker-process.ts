import { createHash } from "node:crypto";
import { createDatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresAuthoringRepository } from "../../packages/database/src/authoring-job-repository.js";
import { createProviderNetworkPolicy } from "../../packages/security/src/provider-network-policy.js";
import { createProviderTransport } from "../../packages/story-engine/src/provider-transport.js";
import { createRuntimeAuthoringWorkerApplication } from "../../services/runtime/src/authoring-composition.js";
import { createWorkerProviderApplicationComposition } from "../../services/runtime/src/provider-application-composition.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const credentialSecret = process.env.AUTHORING_PROCESS_CREDENTIAL_SECRET;
const limit = Number.parseInt(process.env.AUTHORING_PROCESS_LIMIT ?? "1", 10);
const crashAfterCheckpoint = process.env.AUTHORING_PROCESS_CRASH_AFTER_CHECKPOINT === "true";
const diagnosticsEnabled = process.env.AUTHORING_PROCESS_DIAGNOSTICS === "true";

type SafeOutcome = "no_claim" | "claimed_then_null" | "failed" | "checkpoint_lost" | "checkpointed";
type SafeOutcomeRecord = Readonly<{
  outcome: SafeOutcome;
  jobId?: string;
  stageId?: string;
  generation?: number;
  failureCode?: string;
  failureStage?: string;
  claimCandidates?: readonly Readonly<{
    jobId: string;
    jobStatus: string;
    reviewGeneration: number;
    stageKey: string;
    generation: number;
    stageStatus: string;
    sourceReviewGeneration: number | null;
    due: boolean;
    observedAt: unknown;
    nextAttemptAt: unknown;
    startedAt: unknown;
    completedAt: unknown;
    secondsUntilDue: number;
    leaseLive: boolean | null;
    parentGenerations: unknown;
  }>[];
  /** A completed claim transaction cannot prove whether another transaction was skipped. */
  skipLockedContention?: "not_observable_after_claim";
}>;

if (!databaseUrl || !credentialSecret || !Number.isSafeInteger(limit) || limit < 1 || limit > 16) {
  throw new Error("Authoring worker process test configuration is invalid.");
}

const pool = createDatabasePool(databaseUrl, 4);
const transport = createProviderTransport({
  policy: createProviderNetworkPolicy({ allowlist: ["127.0.0.0/8"] })
});

try {
  const providers = createWorkerProviderApplicationComposition(pool, {
    credentialSecret,
    transport
  });
  const repository = createPostgresAuthoringRepository(pool);
  let claimed: Awaited<ReturnType<typeof repository.claim>> | undefined;
  let checkpointed: boolean | undefined;
  let failed = false;
  let failure: { code?: string; stage?: string } | undefined;
  const resetDiagnostic = () => {
    claimed = undefined;
    checkpointed = undefined;
    failed = false;
    failure = undefined;
  };
  const diagnosticRepository = diagnosticsEnabled ? {
    ...repository,
    claim: async (...args: Parameters<typeof repository.claim>) => {
      const next = await repository.claim(...args);
      claimed = next;
      return next;
    },
    checkpoint: async (...args: Parameters<typeof repository.checkpoint>) => {
      const committed = await repository.checkpoint(...args);
      checkpointed = committed;
      return committed;
    },
    fail: async (...args: Parameters<typeof repository.fail>) => {
      failed = true;
      const candidate = args[1];
      failure = typeof candidate === "object" && candidate !== null
        ? {
            ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
            ...(typeof candidate.stage === "string" ? { stage: candidate.stage } : {})
          }
        : undefined;
      return repository.fail(...args);
    }
  } : repository;
  const repositoryForProcess = process.env.AUTHORING_PROCESS_CRASH_BEFORE_CHECKPOINT === "true" || crashAfterCheckpoint ? {
    ...diagnosticRepository,
    checkpoint: async (claim: Parameters<typeof repository.checkpoint>[0], output: Parameters<typeof repository.checkpoint>[1]) => {
      if (process.env.AUTHORING_PROCESS_CRASH_BEFORE_CHECKPOINT === "true") {
        // The real HTTP provider has returned and runtime validation succeeded.
        // Exit without running checkpoint SQL, failure handling, or pool cleanup.
        process.exit(86);
      }
      const committed = await diagnosticRepository.checkpoint(claim, output);
      // The real transaction committed, but the worker's checkpoint call and
      // runNext have not returned. Do not report completion or run cleanup.
      if (committed && crashAfterCheckpoint) process.exit(87);
      return committed;
    }
  } : diagnosticRepository;
  const authoring = createRuntimeAuthoringWorkerApplication({
    pool,
    ...(diagnosticsEnabled || process.env.AUTHORING_PROCESS_CRASH_BEFORE_CHECKPOINT === "true" || crashAfterCheckpoint ? { repository: repositoryForProcess } : {}),
    providers: providers.worldGeneration,
    sha256: (value) => createHash("sha256").update(value).digest("hex")
  });
  let completed = 0;
  const runs: boolean[] = [];
  const outcomes: SafeOutcomeRecord[] = [];
  const safeClaimCandidates = async () => {
    const candidates = await pool.query<{
      job_id: string;
      job_status: string;
      review_generation: number;
      stage_key: string;
      generation: number;
      stage_status: string;
      source_review_generation: number | null;
      due: boolean;
      observed_at: unknown;
      next_attempt_at: unknown;
      started_at: unknown;
      completed_at: unknown;
      seconds_until_due: number;
      lease_live: boolean | null;
      parent_generations: unknown;
    }>(`SELECT jobs.id AS job_id,jobs.status AS job_status,jobs.review_generation,
                 stages.stage_key,stages.generation,stages.status AS stage_status,stages.source_review_generation,
                 stages.next_attempt_at <= clock_timestamp() AS due,
                 clock_timestamp() AS observed_at,stages.next_attempt_at,stages.started_at,stages.completed_at,
                 EXTRACT(epoch FROM (stages.next_attempt_at-clock_timestamp())) AS seconds_until_due,
                 CASE WHEN stages.lease_expires_at IS NULL THEN NULL ELSE stages.lease_expires_at > clock_timestamp() END AS lease_live,
                 stages.parent_generations
            FROM authoring_jobs jobs
            JOIN authoring_job_stages stages ON stages.job_id=jobs.id AND stages.owner_user_id=jobs.owner_user_id
           WHERE jobs.kind='story_source' AND jobs.status IN ('queued','running') AND jobs.expires_at > clock_timestamp()
             AND stages.generation=(SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id=stages.job_id AND current.stage_key=stages.stage_key)
           ORDER BY jobs.created_at,jobs.id,stages.next_attempt_at,stages.stage_key`);
    return candidates.rows.map((candidate) => ({
      jobId: candidate.job_id, jobStatus: candidate.job_status, reviewGeneration: candidate.review_generation,
      stageKey: candidate.stage_key, generation: candidate.generation, stageStatus: candidate.stage_status,
      sourceReviewGeneration: candidate.source_review_generation, due: candidate.due, leaseLive: candidate.lease_live,
      observedAt: candidate.observed_at, nextAttemptAt: candidate.next_attempt_at, startedAt: candidate.started_at,
      completedAt: candidate.completed_at, secondsUntilDue: candidate.seconds_until_due,
      parentGenerations: candidate.parent_generations
    }));
  };
  for (let index = 0; index < limit; index += 1) {
    resetDiagnostic();
    const ran = await authoring.runNext({ workerId: `authoring-process-${process.pid}`, leaseSeconds: 30 });
    runs.push(ran);
    if (diagnosticsEnabled) {
      const outcome: SafeOutcome = !claimed
        ? "no_claim"
        : failed
          ? "failed"
          : checkpointed === true
            ? "checkpointed"
            : checkpointed === false
              ? "checkpoint_lost"
              : "claimed_then_null";
      outcomes.push({
        outcome,
        ...(claimed ? { jobId: claimed.jobId, stageId: claimed.stageId, generation: claimed.stageGeneration } : {}),
        ...(failure?.code ? { failureCode: failure.code } : {}),
        ...(failure?.stage ? { failureStage: failure.stage } : {}),
        ...(!claimed ? { claimCandidates: await safeClaimCandidates(), skipLockedContention: "not_observable_after_claim" as const } : {})
      });
    }
    if (!ran) break;
    completed += 1;
  }
  process.stdout.write(`${JSON.stringify({ completed, runs, ...(diagnosticsEnabled ? { outcomes } : {}) })}\n`);
} finally {
  await transport.close();
  await pool.end();
}
