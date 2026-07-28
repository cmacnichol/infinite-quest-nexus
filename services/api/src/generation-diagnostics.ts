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

const SAFE_ERROR_CODES = new Set([
  "active_generation_exists",
  "context_budget_exceeded",
  "context_budget_invalid",
  "generation_cancelled",
  "invalid_json",
  "invalid_schema",
  "lease_lost",
  "mechanics_leak",
  "output_limit",
  "provider_request_timeout",
  "provider_transport_error",
  "replacement_work_active",
  "scene_coverage",
  "stale_campaign",
  "unsafe_turn_input"
]);

function safeErrorCode(error: unknown): string {
  try {
    const code = typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
    if (typeof code === "string") {
      const normalized = code.trim().toLowerCase();
      if (SAFE_ERROR_CODES.has(normalized)) return normalized;
    }
  } catch {
    // Provider-controlled metadata accessors must not replace the original failure.
  }
  return "unclassified_error";
}

function safeErrorName(error: unknown): string {
  try {
    if (error instanceof TypeError) return "TypeError";
    if (error instanceof RangeError) return "RangeError";
    if (error instanceof ReferenceError) return "ReferenceError";
    if (error instanceof SyntaxError) return "SyntaxError";
    if (error instanceof URIError) return "URIError";
    if (error instanceof EvalError) return "EvalError";
  } catch {
    // A proxy can throw during instanceof checks; use the fixed fallback.
  }
  return "Error";
}

function emitDiagnostic(emit: () => void): void {
  try {
    emit();
  } catch {
    // Diagnostics are observational and must not alter generation behavior.
  }
}

export async function runTurnGenerationPhase<T>(
  options: TurnGenerationPhaseOptions,
  operation: () => Promise<T>
): Promise<T> {
  const now = options.now ?? Date.now;
  const intervalMs = options.stallIntervalMs ?? TURN_GENERATION_STALL_INTERVAL_MS;
  const phaseStartedAt = now();
  const base = { ...options.context, phase: options.phase };
  emitDiagnostic(() => options.logger.info({
    event: "turn_generation_phase_started",
    ...base,
    totalDurationMs: phaseStartedAt - options.generationStartedAt
  }));
  const stallTimer = setInterval(() => {
    emitDiagnostic(() => {
      const current = now();
      options.logger.warn({
        event: "turn_generation_phase_stalled",
        ...base,
        durationMs: current - phaseStartedAt,
        totalDurationMs: current - options.generationStartedAt
      });
    });
  }, intervalMs);
  stallTimer.unref?.();
  try {
    const result = await operation();
    const completedAt = now();
    emitDiagnostic(() => options.logger.info({
      event: "turn_generation_phase_completed",
      ...base,
      durationMs: completedAt - phaseStartedAt,
      totalDurationMs: completedAt - options.generationStartedAt
    }));
    return result;
  } catch (error) {
    const failedAt = now();
    const errorCode = safeErrorCode(error);
    emitDiagnostic(() => options.logger.error({
      event: "turn_generation_phase_failed",
      ...base,
      errorName: safeErrorName(error),
      errorCode,
      durationMs: failedAt - phaseStartedAt,
      totalDurationMs: failedAt - options.generationStartedAt
    }));
    throw error;
  } finally {
    clearInterval(stallTimer);
  }
}
