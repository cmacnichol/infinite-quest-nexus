import { describe, expect, it } from "vitest";
import { summarizeValidationOutcomes } from "../../packages/application/src/generation/outcome-metrics.js";

describe("generation validation outcome metrics", () => {
  it("counts only the earliest primary response as first-pass validation", () => {
    const result = summarizeValidationOutcomes(
      [{ jobId: "a", status: "completed" }, { jobId: "b", status: "failed" }],
      [
        { jobId: "a", attemptNumber: 1, operation: "initial", outcome: "invalid" },
        { jobId: "a", attemptNumber: 2, operation: "repair", outcome: "valid" },
        { jobId: "a", attemptNumber: 3, operation: "initial", outcome: "valid" }
      ]
    );

    expect(result).toEqual({
      jobs: 2,
      completedJobs: 1,
      jobsWithInitialResponse: 1,
      initialValid: 0,
      initialInvalid: 1,
      initialUnknown: 0,
      repairResponses: 1,
      validRepairResponses: 1,
      preflightUnavailable: 0,
      missingPrimaryResponse: 0,
      refusedResponses: 0,
      transportFailures: 0,
      primaryCalls: 2,
      acceptedJobs: 1,
      discardedJobs: 0,
      cancelledJobs: 0
    });
  });

  it("does not make an incomplete initial attempt look valid after a repair", () => {
    const result = summarizeValidationOutcomes(
      [{ jobId: "timeout", status: "cancelled" }, { jobId: "review", status: "active" }],
      [
        { jobId: "timeout", attemptNumber: 1, operation: "initial", outcome: "unknown" },
        { jobId: "timeout", attemptNumber: 2, operation: "repair", outcome: "valid" },
        { jobId: "review", attemptNumber: 3, operation: "initial", outcome: "invalid" }
      ]
    );

    expect(result).toMatchObject({
      jobsWithInitialResponse: 1,
      initialValid: 0,
      initialInvalid: 1,
      initialUnknown: 1,
      repairResponses: 1,
      validRepairResponses: 1
    });
  });

  it("deduplicates identical observations and rejects conflicting duplicate attempts", () => {
    const duplicate = { jobId: "a", attemptNumber: 1, operation: "initial" as const, outcome: "valid" as const };
    expect(summarizeValidationOutcomes([{ jobId: "a", status: "completed" }], [duplicate, duplicate]))
      .toMatchObject({ jobsWithInitialResponse: 1, initialValid: 1 });

    expect(() => summarizeValidationOutcomes([{ jobId: "a", status: "completed" }], [
      duplicate,
      { ...duplicate, outcome: "invalid" }
    ])).toThrow("Conflicting observations for job a attempt 1");
  });

  it("keeps the earliest primary denominator while reporting response-contract outcomes separately", () => {
    const result = summarizeValidationOutcomes(
      [
        { jobId: "strict-valid", status: "completed" },
        { jobId: "strict-repaired", status: "completed" },
        { jobId: "required-preflight", status: "failed" },
        { jobId: "missing", status: "failed" },
        { jobId: "refused", status: "failed" },
        { jobId: "transport", status: "failed" },
        { jobId: "discarded", status: "discarded" },
        { jobId: "cancelled", status: "cancelled" }
      ],
      [
        { jobId: "strict-valid", attemptNumber: 1, operation: "initial", outcome: "valid", primaryCall: true },
        { jobId: "strict-repaired", attemptNumber: 1, operation: "initial", outcome: "invalid", primaryCall: true },
        { jobId: "strict-repaired", attemptNumber: 2, operation: "repair", outcome: "valid", primaryCall: false },
        { jobId: "required-preflight", attemptNumber: 0, operation: "preflight", outcome: "unknown", preflightUnavailable: true },
        { jobId: "missing", attemptNumber: 1, operation: "initial", outcome: "unknown", primaryCall: true, responseState: "missing" },
        { jobId: "refused", attemptNumber: 1, operation: "initial", outcome: "unknown", primaryCall: true, responseState: "refused" },
        { jobId: "transport", attemptNumber: 1, operation: "initial", outcome: "unknown", primaryCall: true, responseState: "transport" }
      ]
    );

    expect(result).toMatchObject({
      jobs: 8,
      jobsWithInitialResponse: 2,
      initialValid: 1,
      initialInvalid: 1,
      initialUnknown: 3,
      preflightUnavailable: 1,
      missingPrimaryResponse: 1,
      refusedResponses: 1,
      transportFailures: 1,
      primaryCalls: 5,
      acceptedJobs: 2,
      discardedJobs: 1,
      cancelledJobs: 1,
      validRepairResponses: 1
    });
  });
});
