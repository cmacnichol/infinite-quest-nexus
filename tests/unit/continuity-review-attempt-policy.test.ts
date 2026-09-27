import { describe, expect, it } from "vitest";
import { nextContinuityReviewAction } from "../../packages/application/src/memory/continuity-review-attempt-policy.js";
import { continuityReviewCheckpointSchema, reviewBindingHash } from "../../packages/application/src/memory/continuity-review-checkpoint.js";

const technical = (failure: "output_limit" | "invalid_output" | "provider_timeout" | "provider_failed" | "context_budget_exceeded" | "evidence_unavailable") => ({
  kind: "technical_failure" as const, failure
});
const hash = "a".repeat(64);
const binding = {
  draftHash: hash, producingRequestHash: hash, manifestHash: hash, auxiliaryRequestHashes: [], providerConfigurationHash: hash,
  promptHash: hash, promptProtocol: "story-continuity-review-v1" as const, policyHash: hash, reviewerExecutionSnapshotHash: hash
};
const unreconciledReservation = () => ({
  version: 2 as const, mode: "enforce" as const, binding, bindingHash: reviewBindingHash(binding), status: "completed" as const,
  verdict: "unavailable" as const, reviewRequestHash: hash, result: null, unavailableReason: "provider_failed" as const,
  outcome: { version: 2 as const, kind: "technical_failure" as const, failure: "provider_failed" as const, providerMetadata: null },
  attempts: [{ ordinal: 1 as const, route: "primary" as const, routePlanHash: hash, requestHash: hash,
    responseReference: null, reservationStatus: "dispatched" as const, outcome: null }]
});

describe("continuity review attempt policy", () => {
  it("dispatches the single configured fallback after a primary output limit", () => {
    expect(nextContinuityReviewAction({ maximumAutomaticFallbacks: 1, hasFallback: true, attempts: [
      { route: "primary", status: "completed", outcome: technical("output_limit") }
    ] })).toEqual({ kind: "dispatch-fallback", ordinal: 2 });
  });

  it("does not redispatch a fallback whose request could not be prepared", () => {
    expect(nextContinuityReviewAction({ maximumAutomaticFallbacks: 1, hasFallback: true, fallbackPreparationFailed: true, attempts: [
      { route: "primary", status: "completed", outcome: technical("output_limit") }
    ] })).toEqual({ kind: "pause-for-decision" });
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

  it("permits only a technical unresolved dispatch and keeps it out of automatic routing", () => {
    const checkpoint = unreconciledReservation();
    expect(continuityReviewCheckpointSchema.safeParse(checkpoint).success).toBe(true);
    expect(nextContinuityReviewAction({ maximumAutomaticFallbacks: 1, hasFallback: true,
      attempts: checkpoint.attempts.map((attempt) => ({ route: attempt.route, status: attempt.reservationStatus, outcome: attempt.outcome }))
    })).toEqual({ kind: "pause-for-decision" });
    expect(continuityReviewCheckpointSchema.safeParse({ ...checkpoint,
      outcome: { version: 2, kind: "semantic_verdict", review: { version: "story-continuity-review-v1", verdict: "pass", findings: [] } }
    }).success).toBe(false);
    expect(continuityReviewCheckpointSchema.safeParse({ ...checkpoint, attempts: [{ ...checkpoint.attempts[0], reservationStatus: "completed" }] }).success).toBe(false);
  });
});
