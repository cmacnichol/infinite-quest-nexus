import type { AuthoringJobStatus, AuthoringStageStatus } from "../../contracts/src/authoring.js";

const JOB_TRANSITIONS: Readonly<Record<AuthoringJobStatus, readonly AuthoringJobStatus[]>> = {
  queued: ["running", "cancel_requested", "cancelled", "expired"],
  running: ["awaiting_review", "recoverable", "failed", "cancel_requested", "cancelled", "expired"],
  awaiting_review: ["queued", "recoverable", "cancel_requested", "cancelled", "applied", "expired"],
  recoverable: ["queued", "running", "awaiting_review", "failed", "cancel_requested", "cancelled", "applied", "expired"],
  failed: [],
  cancel_requested: ["cancelled", "expired"],
  cancelled: [],
  applied: [],
  expired: []
};

export const MAX_AUTOMATIC_STAGE_LEASE_RECOVERIES = 3;
export const MAX_EXPLICIT_STAGE_RETRY_GENERATIONS = 3;

export interface AuthoringStageLifecycle {
  id: string;
  key: string;
  generation: number;
  status: AuthoringStageStatus;
  attemptCount: number;
  output?: unknown;
  explicitRetryGenerations?: number;
  dependsOn?: readonly string[];
  parentGenerations?: Readonly<Record<string, number>>;
  historicalOutputs?: readonly AuthoringStageHistoricalOutput[];
}

export interface AuthoringStageHistoricalOutput {
  generation: number;
  output: unknown;
  supersededByGeneration: number;
}

export function canTransitionAuthoringJob(from: AuthoringJobStatus, to: AuthoringJobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function canReviewAuthoringJob(status: AuthoringJobStatus): boolean {
  return status === "queued" || status === "running" || status === "awaiting_review" || status === "recoverable";
}

export function canApplyAuthoringJob(status: AuthoringJobStatus): boolean {
  return status === "awaiting_review" || status === "recoverable";
}

export function canRecoverAuthoringStageLease(recoveryCount: number): boolean {
  return recoveryCount >= 0 && recoveryCount < MAX_AUTOMATIC_STAGE_LEASE_RECOVERIES;
}

export function canRetryAuthoringStage(explicitRetryGenerations: number): boolean {
  return explicitRetryGenerations >= 0 && explicitRetryGenerations < MAX_EXPLICIT_STAGE_RETRY_GENERATIONS;
}

export function isAuthoringStageApplyEligible(stage: AuthoringStageLifecycle): boolean {
  return stage.status === "validated";
}

function dependentStageIds(stages: readonly AuthoringStageLifecycle[], stageId: string): Set<string> {
  const invalidated = new Set([stageId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of stages) {
      if (!invalidated.has(stage.id) && stage.dependsOn?.some((dependency) => invalidated.has(dependency))) {
        invalidated.add(stage.id);
        changed = true;
      }
    }
  }
  return invalidated;
}

/**
 * Retries a failed stage, or explicitly regenerates a validated stage. Regenerating
 * a stage invalidates only its transitive dependents; their persisted prior outputs
 * stay reviewable as superseded data and cannot be selected for application.
 */
export function retryAuthoringStage(
  stages: readonly AuthoringStageLifecycle[],
  stageId: string,
  options: Readonly<{ allowValidated?: boolean }> = {}
): AuthoringStageLifecycle[] {
  const target = stages.find((stage) => stage.id === stageId);
  if (!target) throw new Error("Authoring stage was not found.");
  if (target.status === "validated" && options.allowValidated !== true) {
    throw new Error("A validated stage can be retried only when regeneration was explicitly selected.");
  }
  if (target.status !== "failed" && target.status !== "recoverable" && target.status !== "validated") {
    throw new Error("Only failed or recoverable stages may be retried; a validated stage requires explicit regeneration.");
  }
  const retries = target.explicitRetryGenerations ?? 0;
  if (!canRetryAuthoringStage(retries)) throw new Error("This stage has exhausted its explicit retry generations.");

  const invalidated = dependentStageIds(stages, stageId);
  const nextGeneration = target.generation + 1;
  return stages.map((stage) => {
    if (stage.id === stageId) {
      const historicalOutputs = stage.output === undefined
        ? stage.historicalOutputs
        : [...(stage.historicalOutputs ?? []), { generation: stage.generation, output: stage.output, supersededByGeneration: nextGeneration }];
      return {
        id: stage.id,
        key: stage.key,
        generation: nextGeneration,
        status: "queued",
        attemptCount: 0,
        explicitRetryGenerations: retries + 1,
        ...(stage.dependsOn === undefined ? {} : { dependsOn: stage.dependsOn }),
        ...(stage.parentGenerations === undefined ? {} : { parentGenerations: stage.parentGenerations }),
        ...(historicalOutputs === undefined ? {} : { historicalOutputs })
      };
    }
    if (invalidated.has(stage.id)) {
      const historicalOutputs = stage.output === undefined
        ? stage.historicalOutputs
        : [...(stage.historicalOutputs ?? []), { generation: stage.generation, output: stage.output, supersededByGeneration: nextGeneration }];
      return {
        id: stage.id,
        key: stage.key,
        generation: stage.generation + 1,
        status: "queued",
        attemptCount: 0,
        ...(stage.explicitRetryGenerations === undefined ? {} : { explicitRetryGenerations: stage.explicitRetryGenerations }),
        ...(stage.dependsOn === undefined ? {} : { dependsOn: stage.dependsOn }),
        parentGenerations: { ...(stage.parentGenerations ?? {}), [target.key]: nextGeneration },
        ...(historicalOutputs === undefined ? {} : { historicalOutputs })
      };
    }
    return stage;
  });
}
