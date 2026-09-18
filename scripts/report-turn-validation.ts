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
type JobRow = Readonly<{ id: string; status: JobOutcome["status"]; createdAt: string; promptProtocol: string | null; requestedModel: string; errorCode: string | null; failureDiagnostic: unknown; failureDiagnosticCode: string | null; queuedPolicy: string | null; operationClosureVersion: string | null; contextOptions: Record<string, unknown> | null; generationPolicy: Record<string, unknown> | null; storyPromptCompatibility: unknown }>;
type AttemptRow = Readonly<{ jobId: string; attemptNumber: number; recoveryKind: string; completedAt: string | null; hasOutput: boolean; hasProviderResponseId: boolean; validationErrorCount: number | null; requestModel: string | null; responseModel: string | null }>;
type ContractLedgerRow = Readonly<{ jobId: string; invocationOrdinal: number; policy: string | null; mode: string | null; schemaVersion: string | null; schemaHash: string | null; invocationKey: string | null; operation: string | null; requestedModel: string | null; returnedModel: string | null; returnedRoute: string | null; status: string | null; diagnosticCode: string | null; failureRecorded: boolean; dispatchedAt: string | null; completedAt: string | null; latencyMs: number | null; costMicrounits: number | null }>;

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
  policy: string;
  effectiveMode: string;
  schemaVersion: string;
  schemaHash: string;
  operation: string;
  requestedModel: string;
  returnedModel: string;
  returnedRoute: string;
  contractProtocol: string;
  operationClosureVersion: string;
  streaming: string;
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

function observationFrom(row: AttemptRow, legacy: boolean): ValidationObservation {
  return {
    jobId: row.jobId,
    attemptNumber: row.attemptNumber,
    operation: row.recoveryKind === "initial" ? "initial" : "repair",
    outcome: !row.completedAt || !row.hasOutput || row.validationErrorCount === null ? "unknown" : row.validationErrorCount ? "invalid" : "valid",
    primaryCall: legacy && row.recoveryKind === "initial" && (row.completedAt !== null || row.hasOutput || row.hasProviderResponseId)
  };
}

function selectedPrimaryAttempt(attempts: readonly AttemptRow[], jobId: string): AttemptRow | undefined {
  return attempts.filter((attempt) => attempt.jobId === jobId && attempt.recoveryKind === "initial")
    .sort((left, right) => left.attemptNumber - right.attemptNumber)[0];
}

function attemptRequestModel(row: AttemptRow): string | null {
  return row.requestModel;
}

function attemptResponseModel(row: AttemptRow): string | null {
  return row.responseModel;
}

function selectedPrimaryLedger(ledger: readonly ContractLedgerRow[], jobId: string): ContractLedgerRow | undefined {
  return ledger.filter((entry) => entry.jobId === jobId && (entry.operation === "story_generation" || entry.operation === "story_recovery"))
    .sort((left, right) => left.invocationOrdinal - right.invocationOrdinal)[0];
}

function ledgerObservation(entry: ContractLedgerRow): ValidationObservation | undefined {
  if (!(entry.operation === "story_generation" || entry.operation === "story_recovery")
    || !(entry.status === "dispatched" || entry.status === "completed")) return undefined;
  const responseState = entry.diagnosticCode === "provider_refusal" ? "refused"
    : entry.status === "dispatched" || entry.completedAt === null || entry.failureRecorded ? "missing" : undefined;
  return { jobId: entry.jobId, attemptNumber: 1_000_000 + entry.invocationOrdinal, operation: "preflight", outcome: "unknown", primaryCall: true,
    ...(responseState ? { responseState } : {}) };
}

function preflightObservation(job: JobRow, ledger: readonly ContractLedgerRow[]): ValidationObservation | undefined {
  const unavailable = job.queuedPolicy === "required" && (job.errorCode === "response_contract_unavailable"
    || job.errorCode === "response_contract_unsupported_adapter");
  return unavailable ? { jobId: job.id, attemptNumber: 0, operation: "preflight", outcome: "unknown", preflightUnavailable: true } : undefined;
}

function cohort(row: JobRow, configuredModel: string, protocol: ProtocolCohortIdentity, ledger: ContractLedgerRow | undefined): CohortLabels {
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
    contextBucket: budget === null ? "unknown" : budget < 32_000 ? "under-32k" : budget < 128_000 ? "32k-127k" : "128k-plus",
    policy: reportLabel(ledger?.policy ?? row.queuedPolicy ?? "legacy"),
    effectiveMode: reportLabel(ledger?.mode ?? (row.queuedPolicy ? null : "legacy")),
    schemaVersion: reportLabel(ledger?.schemaVersion),
    schemaHash: reportLabel(ledger?.schemaHash),
    operation: reportLabel(ledger?.operation),
    requestedModel: reportLabel(ledger?.requestedModel ?? configuredModel),
    returnedModel: reportLabel(ledger?.returnedModel),
    returnedRoute: reportLabel(ledger?.returnedRoute),
    contractProtocol: "unknown",
    operationClosureVersion: reportLabel(row.operationClosureVersion),
    streaming: ledger?.invocationKey?.endsWith(":stream") ? "stream" : ledger ? "nonstream" : "unknown"
  };
}

export async function readTurnValidationReport(client: QueryClient, options: TurnValidationReportOptions) {
  await client.query("BEGIN READ ONLY");
  try {
    const jobs = await client.query<JobRow>(
      `SELECT id, status, created_at AS "createdAt", CASE WHEN length(prompt_protocol_version) <= 512 THEN prompt_protocol_version END AS "promptProtocol", CASE WHEN length(requested_model) <= 512 THEN requested_model END AS "requestedModel",
              error_code AS "errorCode",
              jsonb_build_object('version', orchestration_private #> '{lastFailureDiagnostic,version}', 'category', orchestration_private #> '{lastFailureDiagnostic,category}',
                'code', orchestration_private #> '{lastFailureDiagnostic,code}', 'phase', orchestration_private #> '{lastFailureDiagnostic,phase}',
                'attemptNumber', orchestration_private #> '{lastFailureDiagnostic,attemptNumber}', 'occurredAt', orchestration_private #> '{lastFailureDiagnostic,occurredAt}') AS "failureDiagnostic",
              orchestration_private #>> '{queuedResponsePolicy,policy}' AS "queuedPolicy",
              orchestration_private #>> '{queuedResponsePolicy,operationClosureVersion}' AS "operationClosureVersion",
              orchestration_private #>> '{lastFailureDiagnostic,code}' AS "failureDiagnosticCode",
              context_options AS "contextOptions", generation_policy AS "generationPolicy",
              prompt_snapshot->'storyPromptCompatibility' AS "storyPromptCompatibility"
         FROM generation_jobs
        WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
        ORDER BY created_at DESC LIMIT $2`,
      [options.since, options.limit]
    );
    const ids = jobs.rows.map((row) => row.id);
    const attemptLimit = options.limit * 24;
    const attemptQuery = ids.length === 0 ? { rows: [] as AttemptRow[] } : await client.query<AttemptRow>(
      `SELECT generation_job_id AS "jobId", attempt_number AS "attemptNumber", recovery_kind AS "recoveryKind", completed_at AS "completedAt",
              (raw_output IS NOT NULL AND length(raw_output) > 0) AS "hasOutput",
              (provider_response_id IS NOT NULL) AS "hasProviderResponseId",
              CASE WHEN jsonb_typeof(validation_errors) = 'array' THEN jsonb_array_length(validation_errors) ELSE NULL END AS "validationErrorCount",
              CASE WHEN length(request_metadata->>'model') <= 512 THEN request_metadata->>'model' END AS "requestModel",
              CASE WHEN length(response_metadata->>'modelInstanceId') <= 256 THEN response_metadata->>'modelInstanceId' END AS "responseModel"
         FROM generation_attempts WHERE generation_job_id = ANY($1::uuid[]) ORDER BY generation_job_id, attempt_number LIMIT $2`, [ids, attemptLimit + 1]
    );
    const attemptsTruncated = attemptQuery.rows.length > attemptLimit;
    const attempts = { rows: attemptQuery.rows.slice(0, attemptLimit) };
    const ledger = await client.query<ContractLedgerRow>(
      `SELECT job.id AS "jobId", entries.ordinality AS "invocationOrdinal",
              CASE WHEN length(entries.entry #>> '{request,mode}') <= 32 THEN entries.entry #>> '{request,mode}' END AS "mode",
              CASE WHEN length(entries.entry #>> '{request,schemaVersion}') <= 200 THEN entries.entry #>> '{request,schemaVersion}' END AS "schemaVersion",
              CASE WHEN entries.entry #>> '{request,schemaHash}' ~ '^[a-f0-9]{64}$' THEN entries.entry #>> '{request,schemaHash}' END AS "schemaHash",
              CASE WHEN length(entries.entry->>'invocationKey') <= 64 THEN entries.entry->>'invocationKey' END AS "invocationKey",
              CASE WHEN length(entries.entry->>'operation') <= 64 THEN entries.entry->>'operation' END AS "operation",
              CASE WHEN length(entries.entry #>> '{request,requestedModel}') <= 512 THEN entries.entry #>> '{request,requestedModel}' END AS "requestedModel",
              CASE WHEN length(entries.entry #>> '{response,returnedModel}') <= 256 THEN entries.entry #>> '{response,returnedModel}' END AS "returnedModel",
              CASE WHEN length(entries.entry #>> '{response,returnedProviderRoute}') <= 256 THEN entries.entry #>> '{response,returnedProviderRoute}' END AS "returnedRoute",
              CASE WHEN length(entries.entry->>'status') <= 16 THEN entries.entry->>'status' END AS "status",
              CASE WHEN length(entries.entry #>> '{response,diagnosticCode}') <= 80 THEN entries.entry #>> '{response,diagnosticCode}' END AS "diagnosticCode",
              (failures.failure IS NOT NULL) AS "failureRecorded", entries.entry->>'dispatchedAt' AS "dispatchedAt",
              entries.entry->>'completedAt' AS "completedAt", NULL::integer AS "latencyMs", NULL::bigint AS "costMicrounits",
              job.orchestration_private #>> '{queuedResponsePolicy,policy}' AS "policy"
         FROM generation_jobs job CROSS JOIN LATERAL (
           SELECT entry, ordinality
             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(job.orchestration_private->'responseContractInvocations') = 'array'
               THEN job.orchestration_private->'responseContractInvocations' ELSE '[]'::jsonb END) WITH ORDINALITY AS source(entry, ordinality)
            LIMIT 24
         ) AS entries
         LEFT JOIN LATERAL (
           SELECT failure
             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(job.orchestration_private->'preparedResponseFailures') = 'array'
               THEN job.orchestration_private->'preparedResponseFailures' ELSE '[]'::jsonb END) AS source(failure)
            WHERE failure->>'invocationId' = entries.entry->>'id' AND failure->>'version' = '1'
            LIMIT 1
         ) AS failures ON true
        WHERE job.id = ANY($1::uuid[])`, [ids]
    );
    const observations = [
      ...attempts.rows.map((attempt) => observationFrom(attempt, jobs.rows.find((job) => job.id === attempt.jobId)?.queuedPolicy === null || jobs.rows.find((job) => job.id === attempt.jobId)?.queuedPolicy === undefined)),
      ...jobs.rows.map((job) => preflightObservation(job, ledger.rows)).filter((value): value is ValidationObservation => Boolean(value)),
      ...ledger.rows.map((entry) => ledgerObservation(entry)).filter((value): value is ValidationObservation => Boolean(value))
    ];
    const metrics = summarizeValidationOutcomes(jobs.rows.map((row) => ({ jobId: row.id, status: row.status })), observations);
    const jobsWithPersistedTransportDiagnostic = jobs.rows.filter((job) => {
      const diagnostic = projectGenerationFailureDiagnostic(job.failureDiagnostic);
      return diagnostic?.code === "provider_transport_error" || diagnostic?.code === "provider_request_timeout";
    }).length;
    const frozenInitialModels = new Map<string, { attemptNumber: number; model: string }>();
    for (const attempt of attempts.rows) {
      const initialModel = attemptRequestModel(attempt);
      const priorInitial = frozenInitialModels.get(attempt.jobId);
      if (attempt.recoveryKind === "initial" && typeof initialModel === "string" && initialModel.trim()
          && (!priorInitial || attempt.attemptNumber < priorInitial.attemptNumber)) {
        frozenInitialModels.set(attempt.jobId, { attemptNumber: attempt.attemptNumber, model: initialModel });
      }
    }
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
      const labels = cohort(job, configuredModel, protocolByJob.get(job.id)!, selectedPrimaryLedger(ledger.rows, job.id));
      const key = JSON.stringify(labels);
      const group = cohortGroups.get(key) ?? { labels, jobs: [], observations: [] };
      group.jobs.push({ jobId: job.id, status: job.status });
      group.observations.push(...observations.filter((observation) => observation.jobId === job.id));
      cohortGroups.set(key, group);
    }
    return {
      window: { since: options.since, limit: options.limit, reportedAt: new Date().toISOString(), attemptsTruncated },
      buildIdentity: reportLabel(process.env.NEXUS_BUILD_COMMIT ?? process.env.GIT_SHA ?? process.env.BUILD_SHA),
      transportFailureClassification: "unavailable" as const,
      jobsWithPersistedTransportDiagnostic,
      metrics,
      outcomes: jobs.rows.map((row) => {
        const failureDiagnostic = projectGenerationFailureDiagnostic(row.failureDiagnostic);
        const requestedModel = reportLabel(row.requestedModel);
        const configuredModel = requestedModel === "unknown"
          ? reportLabel(frozenInitialModels.get(row.id)?.model)
          : requestedModel;
        const protocol = protocolByJob.get(row.id)!;
        const primaryLedger = selectedPrimaryLedger(ledger.rows, row.id);
        const primaryAttempt = selectedPrimaryAttempt(attempts.rows, row.id);
        return { jobId: row.id, finalStatus: row.status,
        initialOutcome: initialByJob.get(row.id)?.outcome ?? "unknown",
        finalErrorCode: failureDiagnostic?.code ?? (row.errorCode ? "generation_failed" : "unknown"),
        failureDiagnostic,
        configuredModel,
        actualReturnedModel: reportLabel(primaryLedger?.returnedModel ?? (row.queuedPolicy ? null : primaryAttempt ? attemptResponseModel(primaryAttempt) : null)),
        actualReturnedRoute: reportLabel(primaryLedger?.returnedRoute),
        observedLatencyMs: primaryLedger?.latencyMs ?? "unknown",
        observedCostMicrounits: primaryLedger?.costMicrounits ?? "unknown",
        preflightUnavailable: preflightObservation(row, ledger.rows)?.preflightUnavailable === true,
        ...protocol };
      }),
      cohorts: [...cohortGroups.values()].map((group) => ({ ...group.labels,
        metrics: summarizeValidationOutcomes(group.jobs, group.observations) }))
    };
  } finally {
    await client.query("ROLLBACK");
  }
}

export function formatTurnValidationMarkdown(report: Awaited<ReturnType<typeof readTurnValidationReport>>): string {
  const m = report.metrics;
  const percent = (numerator: number, denominator: number) => denominator === 0 ? "n/a (0/0)" : `${(numerator / denominator * 100).toFixed(1)}% (${numerator}/${denominator})`;
  const cohortRows = report.cohorts.slice(0, 50).map((cohort) => `| ${cohort.policy} | ${cohort.effectiveMode} | ${cohort.streaming} | ${cohort.operation} | ${cohort.requestedModel} | ${cohort.returnedModel} | ${cohort.metrics.jobs} |`);
  return ["# Turn validation report", "", `UTC since: ${report.window.since ?? "unbounded latest window"}`, `Jobs: ${m.jobs}`, `Completed: ${percent(m.completedJobs, m.jobs)}`,
    `Earliest initial application-valid: ${percent(m.initialValid, m.jobsWithInitialResponse)}`, `Earliest initial application-invalid: ${percent(m.initialInvalid, m.jobsWithInitialResponse)}`,
    `Initial unknown: ${m.initialUnknown}`, `Primary calls: ${m.primaryCalls}`, `Preflight unavailable: ${m.preflightUnavailable}`,
    `Missing primary response: ${m.missingPrimaryResponse}`, `Refused responses: ${m.refusedResponses}`, `Per-invocation transport failures: ${report.transportFailureClassification === "unavailable" ? "unavailable (no per-invocation durable evidence)" : m.transportFailures}`,
    `Jobs with persisted transport/timeout diagnostic: ${report.jobsWithPersistedTransportDiagnostic}/${m.jobs}`,
    `Accepted: ${m.acceptedJobs}`, `Discarded: ${m.discardedJobs}`, `Cancelled: ${m.cancelledJobs}`, `Valid repairs: ${percent(m.validRepairResponses, m.repairResponses)}`,
    "", "## Bounded cohorts", "", "| Policy | Mode | Streaming | Operation | Requested model | Observed model | Jobs |", "| --- | --- | --- | --- | --- | --- | --- |", ...cohortRows,
    ...(report.cohorts.length > 50 ? ["", `Cohorts truncated: showing 50 of ${report.cohorts.length}.`] : []),
    ...(report.window.attemptsTruncated ? ["", "Attempt rows truncated at the bounded report limit; counters may be incomplete."] : []), "", "Initial results are application-validation observations, not proof of provider schema enforcement or narrative quality. Cohort labels are frozen job metadata; unknown labels are retained as unknown."].join("\n") + "\n";
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
    process.stdout.write(options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : formatTurnValidationMarkdown(report));
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
