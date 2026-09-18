import { fileURLToPath } from "node:url";
import { summarizeValidationOutcomes, type JobOutcome, type ValidationObservation } from "../packages/application/src/generation/outcome-metrics.js";

export type TurnValidationReportOptions = Readonly<{
  limit: number;
  since: string | null;
  format: "json" | "markdown";
}>;

type QueryClient = Readonly<{ query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> }>;
type JobRow = Readonly<{ id: string; status: JobOutcome["status"]; createdAt: string; promptProtocol: string | null; requestedModel: string; contextOptions: Record<string, unknown> | null; generationPolicy: Record<string, unknown> | null }>;
type AttemptRow = Readonly<{ jobId: string; attemptNumber: number; recoveryKind: string; providerResponseId: string | null; validationErrors: unknown; responseMetadata: Record<string, unknown> | null }>;

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
  const outputLimited = row.responseMetadata?.outputLimited === true;
  return {
    jobId: row.jobId,
    attemptNumber: row.attemptNumber,
    operation: row.recoveryKind === "initial" ? "initial" : "repair",
    outcome: !row.providerResponseId || !errors || outputLimited ? "unknown" : errors.length ? "invalid" : "valid"
  };
}

function cohort(row: JobRow): Record<string, string> {
  const policy = row.generationPolicy ?? {};
  const context = row.contextOptions ?? {};
  const budget = typeof context.budgetTokens === "number" ? context.budgetTokens : null;
  return {
    promptProtocol: row.promptProtocol ?? "unknown",
    configuredModel: row.requestedModel || "unknown",
    playMode: typeof policy.playMode === "string" ? policy.playMode : "unknown",
    reviewMode: typeof context.storyMemoryPolicy === "object" && context.storyMemoryPolicy !== null
      && typeof (context.storyMemoryPolicy as Record<string, unknown>).policy === "object"
      ? String(((context.storyMemoryPolicy as Record<string, unknown>).policy as Record<string, unknown>).continuityReview ?? "unknown") : "unknown",
    contextBucket: budget === null ? "unknown" : budget < 32_000 ? "under-32k" : budget < 128_000 ? "32k-127k" : "128k-plus"
  };
}

export async function readTurnValidationReport(client: QueryClient, options: TurnValidationReportOptions) {
  await client.query("BEGIN READ ONLY");
  try {
    const jobs = await client.query<JobRow>(
      `SELECT id, status, created_at AS "createdAt", prompt_protocol_version AS "promptProtocol", requested_model AS "requestedModel",
              context_options AS "contextOptions", generation_policy AS "generationPolicy"
         FROM generation_jobs
        WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
        ORDER BY created_at DESC LIMIT $2`,
      [options.since, options.limit]
    );
    const ids = jobs.rows.map((row) => row.id);
    const attempts = ids.length === 0 ? { rows: [] as AttemptRow[] } : await client.query<AttemptRow>(
      `SELECT generation_job_id AS "jobId", attempt_number AS "attemptNumber", recovery_kind AS "recoveryKind",
              provider_response_id AS "providerResponseId", validation_errors AS "validationErrors", response_metadata AS "responseMetadata"
         FROM generation_attempts WHERE generation_job_id = ANY($1::uuid[]) ORDER BY generation_job_id, attempt_number`, [ids]
    );
    const metrics = summarizeValidationOutcomes(jobs.rows.map((row) => ({ jobId: row.id, status: row.status })), attempts.rows.map(observationFrom));
    const actualModels = new Map<string, string>();
    for (const attempt of attempts.rows) {
      const model = attempt.responseMetadata?.modelInstanceId;
      if (!actualModels.has(attempt.jobId) && typeof model === "string" && model.trim()) actualModels.set(attempt.jobId, model);
    }
    return {
      window: { since: options.since, limit: options.limit, reportedAt: new Date().toISOString() },
      buildIdentity: process.env.GIT_SHA ?? process.env.BUILD_SHA ?? "unknown",
      metrics,
      cohorts: jobs.rows.map((row) => ({ jobId: row.id, ...cohort(row), actualReturnedModel: actualModels.get(row.id) ?? "unknown" }))
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
