import { describe, expect, it } from "vitest";
import { continuityReviewCheckpointSchema, assertContinuityReviewCommit, reviewBindingHash } from "../../packages/application/src/memory/continuity-review-checkpoint.js";
const binding = { draftHash: "a".repeat(64), producingRequestHash: "b".repeat(64), manifestHash: "c".repeat(64), providerConfigurationHash: "d".repeat(64), promptHash: "e".repeat(64), promptProtocol: "story-continuity-review-v1" as const, policyHash: "f".repeat(64) };
const checkpoint = { version: 1, mode: "enforce", binding, bindingHash: reviewBindingHash(binding), status: "completed", verdict: "pass", reviewRequestHash: "0".repeat(64), result: { version: "story-continuity-review-v1", verdict: "pass", findings: [] } };
describe("durable continuity review checkpoint", () => {
  it("requires the completed bound pass for enforcing commits", () => {
    expect(() => assertContinuityReviewCommit("enforce", checkpoint, binding)).not.toThrow();
    expect(() => assertContinuityReviewCommit("enforce", { ...checkpoint, status: "dispatched", result: null, verdict: "unavailable" }, binding)).toThrow();
    expect(() => assertContinuityReviewCommit("enforce", checkpoint, { ...binding, draftHash: "1".repeat(64) })).toThrow();
    expect(() => assertContinuityReviewCommit("enforce", undefined, binding)).toThrow();
  });
  it("permits observed unavailability without calling it a pass, and rejects malformed identities", () => {
    expect(() => assertContinuityReviewCommit("observe", { ...checkpoint, mode: "observe", verdict: "unavailable", result: null }, binding)).not.toThrow();
    expect(continuityReviewCheckpointSchema.safeParse({ ...checkpoint, reviewRequestHash: null }).success).toBe(false);
    expect(continuityReviewCheckpointSchema.safeParse({ ...checkpoint, bindingHash: "2".repeat(64) }).success).toBe(false);
    expect(() => assertContinuityReviewCommit("off", undefined, binding)).not.toThrow();
  });
});
