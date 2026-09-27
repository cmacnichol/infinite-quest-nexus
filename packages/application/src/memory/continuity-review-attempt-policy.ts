/**
 * Selects the next reviewer action from durable attempts only.  A reservation
 * without a completed outcome is deliberately terminal for automatic work:
 * another worker cannot know whether the provider received the request.
 */
export type ContinuityReviewAttemptRoute = "primary" | "fallback";
export type ContinuityReviewAttemptStatus = "reserved" | "dispatched" | "completed";
export type ContinuityReviewAttemptOutcome = Readonly<{
  kind: "semantic_verdict" | "technical_failure";
  failure?: "output_limit" | "invalid_output" | "provider_timeout" | "provider_failed" | "context_budget_exceeded" | "evidence_unavailable";
}>;
export type ContinuityReviewAttempt = Readonly<{
  route: ContinuityReviewAttemptRoute;
  status: ContinuityReviewAttemptStatus;
  outcome: ContinuityReviewAttemptOutcome | null;
}>;
export type ContinuityReviewNextAction =
  | Readonly<{ kind: "dispatch-primary"; ordinal: 1 }>
  | Readonly<{ kind: "dispatch-fallback"; ordinal: 2 }>
  | Readonly<{ kind: "accept-review-result" }>
  | Readonly<{ kind: "pause-for-decision" }>;

const fallbackEligible = new Set(["output_limit", "invalid_output", "provider_timeout", "provider_failed"]);

export function nextContinuityReviewAction(input: Readonly<{
  maximumAutomaticFallbacks: 0 | 1;
  hasFallback: boolean;
  fallbackPreparationFailed?: boolean;
  attempts: readonly ContinuityReviewAttempt[];
}>): ContinuityReviewNextAction {
  const latest = input.attempts.at(-1);
  if (!latest) return { kind: "dispatch-primary", ordinal: 1 };
  if (latest.status !== "completed" || !latest.outcome) return { kind: "pause-for-decision" };
  if (latest.outcome.kind === "semantic_verdict") return { kind: "accept-review-result" };
  if (!input.fallbackPreparationFailed && latest.route === "primary" && input.maximumAutomaticFallbacks === 1 && input.hasFallback
    && fallbackEligible.has(latest.outcome.failure ?? "")) {
    return { kind: "dispatch-fallback", ordinal: 2 };
  }
  return { kind: "pause-for-decision" };
}
