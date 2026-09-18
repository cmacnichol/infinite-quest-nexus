export type ValidationObservation = Readonly<{
  jobId: string;
  attemptNumber: number;
  operation: "initial" | "repair";
  outcome: "valid" | "invalid" | "unknown";
}>;

export type JobOutcome = Readonly<{
  jobId: string;
  status: "completed" | "discarded" | "cancelled" | "failed" | "active";
}>;

export type ValidationMetrics = Readonly<{
  jobs: number;
  completedJobs: number;
  jobsWithInitialResponse: number;
  initialValid: number;
  initialInvalid: number;
  initialUnknown: number;
  repairResponses: number;
  validRepairResponses: number;
}>;

function observationKey(observation: ValidationObservation): string {
  return `${observation.jobId}\u0000${observation.attemptNumber}`;
}

/**
 * Reduces immutable attempt observations without allowing repairs or retries to
 * inflate first-pass validation. The initial observation is selected by the
 * smallest attempt number, never input order.
 */
export function summarizeValidationOutcomes(
  jobs: readonly JobOutcome[],
  observations: readonly ValidationObservation[]
): ValidationMetrics {
  const jobsById = new Map<string, JobOutcome>();
  for (const job of jobs) jobsById.set(job.jobId, job);

  const unique = new Map<string, ValidationObservation>();
  for (const observation of observations) {
    const key = observationKey(observation);
    const existing = unique.get(key);
    if (existing && (existing.operation !== observation.operation || existing.outcome !== observation.outcome)) {
      throw new Error(`Conflicting observations for job ${observation.jobId} attempt ${observation.attemptNumber}`);
    }
    unique.set(key, observation);
  }

  const initialByJob = new Map<string, ValidationObservation>();
  let repairResponses = 0;
  let validRepairResponses = 0;
  for (const observation of unique.values()) {
    if (!jobsById.has(observation.jobId)) continue;
    if (observation.operation === "repair") {
      repairResponses += 1;
      if (observation.outcome === "valid") validRepairResponses += 1;
      continue;
    }
    const initial = initialByJob.get(observation.jobId);
    if (!initial || observation.attemptNumber < initial.attemptNumber) initialByJob.set(observation.jobId, observation);
  }

  let completedJobs = 0;
  for (const job of jobsById.values()) if (job.status === "completed") completedJobs += 1;

  let initialValid = 0;
  let initialInvalid = 0;
  let initialUnknown = 0;
  for (const initial of initialByJob.values()) {
    if (initial.outcome === "valid") initialValid += 1;
    else if (initial.outcome === "invalid") initialInvalid += 1;
    else initialUnknown += 1;
  }
  return {
    jobs: jobsById.size,
    completedJobs,
    jobsWithInitialResponse: initialValid + initialInvalid,
    initialValid,
    initialInvalid,
    initialUnknown,
    repairResponses,
    validRepairResponses
  };
}
