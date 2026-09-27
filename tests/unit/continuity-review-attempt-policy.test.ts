import { describe, expect, it } from "vitest";
import { nextContinuityReviewAction } from "../../packages/application/src/memory/continuity-review-attempt-policy.js";

const technical = (failure: "output_limit" | "invalid_output" | "provider_timeout" | "provider_failed" | "context_budget_exceeded" | "evidence_unavailable") => ({
  kind: "technical_failure" as const, failure
});

describe("continuity review attempt policy", () => {
  it("dispatches the single configured fallback after a primary output limit", () => {
    expect(nextContinuityReviewAction({ maximumAutomaticFallbacks: 1, hasFallback: true, attempts: [
      { route: "primary", status: "completed", outcome: technical("output_limit") }
    ] })).toEqual({ kind: "dispatch-fallback", ordinal: 2 });
  });

  it("pauses after both reviewer routes have technical failures", () => {
    expect(nextContinuityReviewAction({ maximumAutomaticFallbacks: 1, hasFallback: true, attempts: [
      { route: "primary", status: "completed", outcome: technical("provider_timeout") },
      { route: "fallback", status: "completed", outcome: technical("invalid_output") }
    ] })).toEqual({ kind: "pause-for-decision" });
  });

  it.each(["provider_timeout", "invalid_output", "provider_failed"] as const)("uses fallback once for %s", (failure) => {
    expect(nextContinuityReviewAction({ maximumAutomaticFallbacks: 1, hasFallback: true, attempts: [
      { route: "primary", status: "completed", outcome: technical(failure) }
    ] })).toEqual({ kind: "dispatch-fallback", ordinal: 2 });
  });

  it("accepts semantic verdicts and never routes them through fallback", () => {
    expect(nextContinuityReviewAction({ maximumAutomaticFallbacks: 1, hasFallback: true, attempts: [
      { route: "primary", status: "completed", outcome: { kind: "semantic_verdict" as const } }
    ] })).toEqual({ kind: "accept-review-result" });
  });

  it.each(["context_budget_exceeded", "evidence_unavailable"] as const)("does not dispatch for %s", (failure) => {
    expect(nextContinuityReviewAction({ maximumAutomaticFallbacks: 1, hasFallback: true, attempts: [
      { route: "primary", status: "completed", outcome: technical(failure) }
    ] })).toEqual({ kind: "pause-for-decision" });
  });

  it("does not reissue a reserved or dispatched call", () => {
    for (const status of ["reserved", "dispatched"] as const) {
      expect(nextContinuityReviewAction({ maximumAutomaticFallbacks: 1, hasFallback: true, attempts: [
        { route: "primary", status, outcome: null }
      ] })).toEqual({ kind: "pause-for-decision" });
    }
  });
});
