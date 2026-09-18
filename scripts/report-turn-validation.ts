import { fileURLToPath } from "node:url";
import { generationPolicySnapshotSchema } from "../packages/contracts/src/campaign-generation-policy.js";
import { sha256Hex } from "../packages/contracts/src/hash.js";
import { summarizeValidationOutcomes, type JobOutcome, type ValidationObservation } from "../packages/application/src/generation/outcome-metrics.js";
import { projectGenerationFailureDiagnostic } from "../packages/contracts/src/generation-review.js";
import { storyMemoryPolicySnapshotSchema } from "../packages/contracts/src/story-memory-policy.js";
import { storyPromptCompatibilityIdentity } from "../packages/contracts/src/story-prompt.js";
import { generationExecutionProtocolIdentity } from "../packages/story-engine/src/index.js";

export type TurnValidationReportOptions = Readonly<{
  limit: number;
  since: string | null;
  format: "json" | "markdown";
}>;

type QueryClient = Readonly<{ query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> }>;
type JobRow = Readonly<{ id: string; status: JobOutcome["status"]; createdAt: string; promptProtocol: string | null; requestedModel: string; errorCode: string | null; failureDiagnostic: unknown; contextOptions: Record<string, unknown> | null; generationPolicy: Record<string, unknown> | null; storyPromptCompatibility: unknown }>;
type AttemptRow = Readonly<{ jobId: string; attemptNumber: number; recoveryKind: string; providerResponseId: string | null; completedAt: string | null; hasOutput: boolean; validationErrors: unknown; requestMetadata: Record<string, unknown> | null; responseMetadata: Record<string, unknown> | null }>;

function reportLabel(value: unknown): string {
  const label = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u.test(label) ? label : "unknown";
}

type ProtocolCohortIdentity = Readonly<{ promptProtocol: string; executionProtocolHash: string }>;
type CohortLabels = Readonly<ProtocolCohortIdentity & {
  configuredModel: string;
  playMode: string;
  reviewMode: string;
  contextBucket: string;
}>;

function legacyPromptLibraryLabel(executionProtocol: string, generationPolicy: unknown): string | null {
  const match = /^(prompt-library-v1-[a-f0-9]{16})(?:\|([a-f0-9]{64}))?$/u.exec(executionProtocol);
  if (!match) return null;
  if (generationPolicy === null || generationPolicy === undefined) return match[2] ? null : match[1]!;
  const policy = generationPolicySnapshotSchema.safeParse(generationPolicy);
  if (!policy.success) return null;
  try {
    return generationExecutionProtocolIdentity(match[1]!, policy.data) === executionProtocol ? match[1]! : null;
  } catch {
    return null;
  }
}

function hasStoryPromptCompatibilityProof(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  return Object.keys(proof).length === 2
    && proof.protocolIdentity === storyPromptCompatibilityIdentity()
    && typeof proof.templateHash === "string"
    && /^[a-f0-9]{64}$/u.test(proof.templateHash);
}

function protocolCohortIdentity(
  executionProtocol: unknown,
  storyMemoryPolicy: unknown,
  generationPolicy: unknown,
  storyPromptCompatibility: unknown
): ProtocolCohortIdentity {
  const identity = typeof executionProtocol === "string" ? executionProtocol : "";
  if (!identity || identity.length > 512) return { promptProtocol: "unknown", executionProtocolHash: "unknown" };
  const frozenMemoryPolicy = storyMemoryPolicySnapshotSchema.safeParse(storyMemoryPolicy);
  if (frozenMemoryPolicy.success) {
    if (!/^story-memory-v1\|[A-Za-z0-9._|-]{1,500}$/u.test(identity)) {
      return { promptProtocol: "unknown", executionProtocolHash: "unknown" };
    }
    return {
      promptProtocol: reportLabel(frozenMemoryPolicy.data.promptProtocol),
      executionProtocolHash: sha256Hex(identity)
    };
  }
  const storyPromptPrefix = `story-prompt-v1|${storyPromptCompatibilityIdentity()}|`;
  if (identity.startsWith(storyPromptPrefix)) {
    const legacyLabel = hasStoryPromptCompatibilityProof(storyPromptCompatibility)
      ? legacyPromptLibraryLabel(identity.slice(storyPromptPrefix.length), generationPolicy)
      : null;
    return legacyLabel
      ? { promptProtocol: "story-v16-fact-wire-distinction", executionProtocolHash: sha256Hex(identity) }
      : { promptProtocol: "unknown", executionProtocolHash: "unknown" };
  }
  const legacyLabel = legacyPromptLibraryLabel(identity, generationPolicy);
  if (legacyLabel) return { promptProtocol: legacyLabel, executionProtocolHash: sha256Hex(identity) };
  return { promptProtocol: "unknown", executionProtocolHash: "unknown" };
}

export function parseTurnValidationReportOptions(args: readonly string[]): TurnValidationReportOptions {
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const limitText = value("--limit") ?? "50";
  if (!/^\d+$/u.test(limitText)) throw new Error("--limit must be an integer between 1 and 1000");
  const limit = Number(limitText);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("--limit must be between 1 and 1000");
  const since = value("--since") ?? null;
  if (since !== null && (!/^\d{4}-\d{2}-\d{2}T.*Z$/u.test(since) || Number.isNaN(Date.parse(since)))) {
    throw new Error("--since must be a UTC timestamp");
  }
  const format = value("--format") ?? "markdown";
  if (format !== "json" && format !== "markdown") throw new Error("--format must be json or markdown");
  return { limit, since, format };
}

function observationFrom(row: AttemptRow): ValidationObservation {
  const errors = Array.isArray(row.validationErrors) ? row.validationErrors : null;
  return {
    jobId: row.jobId,
    attemptNumber: row.attemptNumber,
    operation: row.recoveryKind === "initial" ? "initial" : "repair",
    outcome: !row.completedAt || !row.hasOutput || !errors ? "unknown" : errors.length ? "invalid" : "valid"
  };
}

function cohort(row: JobRow, configuredModel: string, protocol: ProtocolCohortIdentity): CohortLabels {
  const policy = row.generationPolicy ?? {};
  const context = row.contextOptions ?? {};
  const budget = typeof context.budgetTokens === "number" ? context.budgetTokens : null;
  const memoryPolicy = typeof context.storyMemoryPolicy === "object" && context.storyMemoryPolicy !== null
    ? context.storyMemoryPolicy as Record<string, unknown>
    : null;
  const policyMetadata = memoryPolicy && typeof memoryPolicy.policy === "object" && memoryPolicy.policy !== null
    ? memoryPolicy.policy as Record<string, unknown>
    : null;
  return {
    ...protocol,
    configuredModel,
    playMode: reportLabel(policy.playMode),
    reviewMode: reportLabel(policyMetadata?.continuityReview),
    contextBucket: budget === null ? "unknown" : budget < 32_000 ? "under-32k" : budget < 128_000 ? "32k-127k" : "128k-plus"
  };
}

export async function readTurnValidationReport(client: QueryClient, options: TurnValidationReportOptions) {
  await client.query("BEGIN READ ONLY");
  try {
    const jobs = await client.query<JobRow>(
      `SELECT id, status, created_at AS "createdAt", prompt_protocol_version AS "promptProtocol", requested_model AS "requestedModel",
              error_code AS "errorCode", orchestration_private->'lastFailureDiagnostic' AS "failureDiagnostic",
              context_options AS "contextOptions", generation_policy AS "generationPolicy",
              prompt_snapshot->'storyPromptCompatibility' AS "storyPromptCompatibility"
         FROM generation_jobs
        WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
        ORDER BY created_at DESC LIMIT $2`,
      [options.since, options.limit]
    );
    const ids = jobs.rows.map((row) => row.id);
    const attempts = ids.length === 0 ? { rows: [] as AttemptRow[] } : await client.query<AttemptRow>(
      `SELECT generation_job_id AS "jobId", attempt_number AS "attemptNumber", recovery_kind AS "recoveryKind",
              provider_response_id AS "providerResponseId", completed_at AS "completedAt",
              (raw_output IS NOT NULL AND length(raw_output) > 0) AS "hasOutput",
              validation_errors AS "validationErrors", request_metadata AS "requestMetadata", response_metadata AS "responseMetadata"
         FROM generation_attempts WHERE generation_job_id = ANY($1::uuid[]) ORDER BY generation_job_id, attempt_number`, [ids]
    );
    const metrics = summarizeValidationOutcomes(jobs.rows.map((row) => ({ jobId: row.id, status: row.status })), attempts.rows.map(observationFrom));
    const actualModels = new Map<string, string>();
    const frozenInitialModels = new Map<string, { attemptNumber: number; model: string }>();
    for (const attempt of attempts.rows) {
      const model = attempt.responseMetadata?.modelInstanceId;
      if (!actualModels.has(attempt.jobId) && typeof model === "string" && model.trim()) actualModels.set(attempt.jobId, model);
      const initialModel = attempt.requestMetadata?.model;
      const priorInitial = frozenInitialModels.get(attempt.jobId);
      if (attempt.recoveryKind === "initial" && typeof initialModel === "string" && initialModel.trim()
          && (!priorInitial || attempt.attemptNumber < priorInitial.attemptNumber)) {
        frozenInitialModels.set(attempt.jobId, { attemptNumber: attempt.attemptNumber, model: initialModel });
      }
    }
    const observations = attempts.rows.map(observationFrom);
    const initialByJob = new Map<string, ValidationObservation>();
    for (const observation of observations) if (observation.operation === "initial"
      && (!initialByJob.has(observation.jobId) || observation.attemptNumber < initialByJob.get(observation.jobId)!.attemptNumber)) initialByJob.set(observation.jobId, observation);
    const cohortGroups = new Map<string, { labels: CohortLabels; jobs: JobOutcome[]; observations: ValidationObservation[] }>();
    const protocolByJob = new Map(jobs.rows.map((job) => [job.id, protocolCohortIdentity(
      job.promptProtocol,
      job.contextOptions?.storyMemoryPolicy,
      job.generationPolicy,
      job.storyPromptCompatibility
    )]));
    for (const job of jobs.rows) {
      const requestedModel = reportLabel(job.requestedModel);
      const configuredModel = requestedModel === "unknown"
        ? reportLabel(frozenInitialModels.get(job.id)?.model)
        : requestedModel;
      const labels = cohort(job, configuredModel, protocolByJob.get(job.id)!);
      const key = JSON.stringify(labels);
      const group = cohortGroups.get(key) ?? { labels, jobs: [], observations: [] };
      group.jobs.push({ jobId: job.id, status: job.status });
      group.observations.push(...observations.filter((observation) => observation.jobId === job.id));
      cohortGroups.set(key, group);
    }
    return {
      window: { since: options.since, limit: options.limit, reportedAt: new Date().toISOString() },
      buildIdentity: process.env.GIT_SHA ?? process.env.BUILD_SHA ?? "unknown",
      metrics,
      outcomes: jobs.rows.map((row) => {
        const failureDiagnostic = projectGenerationFailureDiagnostic(row.failureDiagnostic);
        const requestedModel = reportLabel(row.requestedModel);
        const configuredModel = requestedModel === "unknown"
          ? reportLabel(frozenInitialModels.get(row.id)?.model)
          : requestedModel;
        const protocol = protocolByJob.get(row.id)!;
        return { jobId: row.id, finalStatus: row.status,
        initialOutcome: initialByJob.get(row.id)?.outcome ?? "unknown",
        finalErrorCode: failureDiagnostic?.code ?? (row.errorCode ? "generation_failed" : "unknown"),
        failureDiagnostic,
        configuredModel, actualReturnedModel: reportLabel(actualModels.get(row.id)), ...protocol };
      }),
      cohorts: [...cohortGroups.values()].map((group) => ({ ...group.labels,
        metrics: summarizeValidationOutcomes(group.jobs, group.observations) }))
    };
  } finally {
    await client.query("ROLLBACK");
  }
}

function markdown(report: Awaited<ReturnType<typeof readTurnValidationReport>>): string {
  const m = report.metrics;
  const percent = (numerator: number, denominator: number) => denominator === 0 ? "n/a (0/0)" : `${(numerator / denominator * 100).toFixed(1)}% (${numerator}/${denominator})`;
  return ["# Turn validation report", "", `UTC since: ${report.window.since ?? "unbounded latest window"}`, `Jobs: ${m.jobs}`, `Completed: ${percent(m.completedJobs, m.jobs)}`,
    `Initial valid: ${percent(m.initialValid, m.jobsWithInitialResponse)}`, `Initial invalid: ${percent(m.initialInvalid, m.jobsWithInitialResponse)}`,
    `Initial unknown: ${m.initialUnknown}`, `Valid repairs: ${percent(m.validRepairResponses, m.repairResponses)}`, "", "Cohort labels are frozen job metadata; unknown labels are retained as unknown."].join("\n") + "\n";
}

export async function main(): Promise<void> {
  const options = parseTurnValidationReportOptions(process.argv.slice(2));
  // Runtime configuration historically falls back to argv[2] for service
  // entrypoints. This standalone CLI owns that value so report flags cannot
  // be misread as a service role.
  process.env.APP_ROLE ??= "all";
  const [{ loadRuntimeConfig }, { createDatabasePool }] = await Promise.all([
    import("../packages/database/src/config.js"), import("../packages/database/src/pool.js")
  ]);
  const pool = createDatabasePool(loadRuntimeConfig().databaseUrl, 1);
  const client = await pool.connect();
  try {
    const report = await readTurnValidationReport(client, options);
    process.stdout.write(options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : markdown(report));
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
