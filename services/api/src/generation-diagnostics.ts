import { logger as applicationLogger } from "../../../packages/logger/src/index.js";

export const TURN_GENERATION_STALL_INTERVAL_MS = 30_000;

export type TurnGenerationPhase =
  | "provider_loading"
  | "input_preparation"
  | "context_retrieval"
  | "orchestration_loading"
  | "rpg_assessment"
  | "before_event_evaluation"
  | "prompt_preparation"
  | "streaming_illustration_setup"
  | "story_generation"
  | "story_validation"
  | "story_recovery"
  | "scene_coverage_validation"
  | "scene_coverage_rewrite"
  | "after_event_evaluation"
  | "event_extension"
  | "turn_commit";

export type TurnGenerationDiagnosticContext = {
  generationJobId: string;
  campaignId: string;
  providerProfileId: string;
  expectedTurnNumber: number;
  operationKind: string;
  jobAttempt: number;
  workerId: string;
};

type DiagnosticLogger = Pick<typeof applicationLogger, "info" | "warn" | "error">;

export type TurnGenerationPhaseOptions = {
  logger: DiagnosticLogger;
  context: TurnGenerationDiagnosticContext;
  phase: TurnGenerationPhase;
  generationStartedAt: number;
  stallIntervalMs?: number;
  now?: () => number;
};

function safeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = String((error as { code?: unknown }).code || "");
  return /^[a-z][a-z0-9_]{0,63}$/i.test(code) ? code : "unclassified_error";
}

export async function runTurnGenerationPhase<T>(
  options: TurnGenerationPhaseOptions,
  operation: () => Promise<T>
): Promise<T> {
  const now = options.now ?? Date.now;
  const intervalMs = options.stallIntervalMs ?? TURN_GENERATION_STALL_INTERVAL_MS;
  const phaseStartedAt = now();
  const base = { ...options.context, phase: options.phase };
  options.logger.info({
    event: "turn_generation_phase_started",
    ...base,
    totalDurationMs: phaseStartedAt - options.generationStartedAt
  });
  const stallTimer = setInterval(() => {
    const current = now();
    options.logger.warn({
      event: "turn_generation_phase_stalled",
      ...base,
      durationMs: current - phaseStartedAt,
      totalDurationMs: current - options.generationStartedAt
    });
  }, intervalMs);
  stallTimer.unref?.();
  try {
    const result = await operation();
    const completedAt = now();
    options.logger.info({
      event: "turn_generation_phase_completed",
      ...base,
      durationMs: completedAt - phaseStartedAt,
      totalDurationMs: completedAt - options.generationStartedAt
    });
    return result;
  } catch (error) {
    const failedAt = now();
    const errorCode = safeErrorCode(error);
    options.logger.error({
      event: "turn_generation_phase_failed",
      ...base,
      errorName: error instanceof Error ? error.name : "Error",
      ...(errorCode ? { errorCode } : {}),
      durationMs: failedAt - phaseStartedAt,
      totalDurationMs: failedAt - options.generationStartedAt
    });
    throw error;
  } finally {
    clearInterval(stallTimer);
  }
}
