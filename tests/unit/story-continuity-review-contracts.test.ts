import { describe, expect, it } from "vitest";
import * as review from "../../packages/contracts/src/story-continuity-review.js";
import { z } from "../../packages/contracts/src/index.js";

const hash = "a".repeat(64);
const location = { path: "/narration", start: 0, end: 4, quote: "Tide" };
const contradiction = { kind: "contradiction", category: "location", severity: "contradiction", basis: { kind: "source", evidenceId: hash, quote: "Quay" }, output: location, explanation: "The locations conflict." };
const omission = { kind: "omission", category: "thread_loss", severity: "warning", expectedEvidenceIds: [hash], outputPath: "/open_threads", explanation: "The unresolved thread is absent." };

describe("field-addressed review contracts", () => {
  it("preserves nonblocking omission warnings on a scoped pass without allowing contradictions", () => {
    const warningPass = { version: "story-continuity-review-v1", verdict: "pass", findings: [omission] };
    expect(review.continuityReviewSchema.parse(JSON.parse(JSON.stringify(warningPass)))).toEqual(warningPass);
    expect(review.continuityReviewSchema.safeParse({ ...warningPass, findings: [omission, contradiction] }).success).toBe(false);
    expect(review.continuityReviewSchema.safeParse({ ...warningPass, verdict: "conflict" }).success).toBe(false);
  });
  it("shares one exact source versus candidate reference union", () => {
    expect(review.reviewEvidenceReferenceSchema.parse(contradiction.basis)).toEqual(contradiction.basis);
    expect(review.reviewEvidenceReferenceSchema.parse({ kind: "candidate", draftHash: hash, location })).toEqual({ kind: "candidate", draftHash: hash, location });
    for (const value of [{ kind: "source", evidenceId: hash }, { kind: "candidate", draftHash: hash, path: "/narration" }, { kind: "source", evidenceId: hash, quote: "", location }]) expect(review.reviewEvidenceReferenceSchema.safeParse(value).success).toBe(false);
  });
  it("admits serialized omission without a fabricated quotation and enforces location bounds", () => {
    expect(review.continuityFindingSchema.parse(JSON.parse(JSON.stringify(omission)))).toEqual(omission);
    expect(review.continuityFindingSchema.safeParse({ ...omission, quote: "missing" }).success).toBe(false);
    for (const output of [{ ...location, end: 0 }, { ...location, end: 3 }, { ...location, start: -1 }, { ...location, quote: "x".repeat(1001) }, { ...location, path: "/bad~2" }]) expect(review.continuityFindingSchema.safeParse({ ...contradiction, output }).success).toBe(false);
    expect(review.continuityReviewSchema.safeParse({ version: "story-continuity-review-v1", verdict: "pass", findings: [contradiction] }).success).toBe(false);
    expect(review.continuityReviewSchema.safeParse({ version: "story-continuity-review-v1", verdict: "conflict", findings: [omission] }).success).toBe(false);
    expect(review.continuityReviewSchema.safeParse({ version: "story-continuity-review-v1", verdict: "uncertain", findings: Array(21).fill(omission) }).success).toBe(false);
    expect(review.continuityReviewSchema.safeParse({ version: "story-continuity-review-v1", verdict: "conflict", findings: Array(20).fill({ ...contradiction, explanation: "x".repeat(1000) }) }).success).toBe(false);
  });
});

describe("v3 checkpoint envelope", () => {
  // Payload ownership stays with the executor. This schema is deliberately strict,
  // proving the generic seam validates a complete payload without dropping fields.
  const payload = z.object({ version: z.literal(2), requestBody: z.string(), story: z.object({ narration: z.string(), open_threads: z.array(z.string()) }).strict() }).strict();
  const old = { version: 2, requestBody: "{\"input\":\"Tide\"}", story: { narration: "Tide", open_threads: [] } };
  const metadata = { contextProtocol: "current-continuity-v3", outputProtocol: "story-output-v2", memoryPolicyHash: hash, evidenceManifestHash: hash };
  it("keeps the full executor payload and explicitly routes legacy v2", () => {
    const envelope = { version: 3, metadata, checkpoint: old };
    expect(review.createStoryContinuityCheckpointV3Schema(payload).parse(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);
    expect(review.readStoryContinuityCheckpoint(old, payload)).toEqual({ kind: "legacy_v2", checkpoint: old });
    expect(review.readStoryContinuityCheckpoint(envelope, payload)).toEqual({ kind: "v3", envelope });
    for (const value of [{ ...envelope, checkpoint: { version: 2 } }, { ...envelope, version: 4 }, { ...old, version: 1 }, { ...envelope, metadata: { ...metadata, outputProtocol: "story-output-v3" } }]) expect(() => review.readStoryContinuityCheckpoint(value, payload)).toThrow(/discard.*reenqueue/i);
  });
  it("rejects incoherent review status", () => {
    expect(review.storyContinuityCheckpointMetadataV3Schema.safeParse({ ...metadata, review: { status: "pending", result: { version: "story-continuity-review-v1", verdict: "pass", findings: [] } } }).success).toBe(false);
    expect(review.storyContinuityCheckpointMetadataV3Schema.safeParse({ ...metadata, review: { status: "completed", result: null } }).success).toBe(false);
  });
});
