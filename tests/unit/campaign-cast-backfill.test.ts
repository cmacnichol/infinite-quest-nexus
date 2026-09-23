import { describe, expect, it } from "vitest";
import { castBackfillRequestSchema, castBackfillProgressSchema, castBackfillPreviewSchema } from "../../packages/contracts/src/campaign-cast-backfill.js";
import { validateCastBackfillRange } from "../../packages/application/src/campaign-cast/backfill.js";

const request = { fromTurn: 3, throughTurn: 8, expectedBoundary: { turnNumber: 10, timelineRevision: 0 }, idempotencyKey: "history-scan-0001" };
describe("campaign cast backfill contracts", () => {
  it("keeps preview counts within the selected history and excludes private admission", () => {
    const preview = { fromTurn: 3, throughTurn: 8, boundary: request.expectedBoundary, turnCount: 6,
      estimatedChunkRequests: 6, completedChunkReceipts: 0, completedTurns: 0, manualScanTurns: [],
      providerProfileId: "10000000-0000-4000-8000-000000000001", selection: { kind: "model", modelId: "fixture" } };
    expect(castBackfillPreviewSchema.parse(preview)).toEqual(preview);
    for (const changes of [{ turnCount: 7 }, { completedTurns: 7 }, { manualScanTurns: [2] },
      { manualScanTurns: [3, 3] }, { completedTurns: 6, manualScanTurns: [3] }, { execution: { credentials: "private" } }]) {
      expect(castBackfillPreviewSchema.safeParse({ ...preview, ...changes }).success).toBe(false);
    }
  });
  it("accepts a positive inclusive range with an explicit boundary and start key", () => {
    expect(castBackfillRequestSchema.parse(request)).toEqual(request);
  });
  it("rejects reversed, absent, fractional and future turn ranges", () => {
    for (const changes of [{ fromTurn: 8, throughTurn: 3 }, { fromTurn: 0 }, { fromTurn: 2.5 }, { throughTurn: 11 }]) {
      expect(castBackfillRequestSchema.safeParse({ ...request, ...changes }).success).toBe(false);
    }
    expect(castBackfillRequestSchema.safeParse({ ...request, idempotencyKey: "" }).success).toBe(false);
    expect(castBackfillRequestSchema.safeParse({ ...request, providerCredentials: "untrusted" }).success).toBe(false);
  });
  it("allows honest partial progress and unresolved identity decisions", () => {
    const progress = { id: "10000000-0000-4000-8000-000000000001", fromTurn: 3, throughTurn: 8,
      completeTurns: 2, failedTurns: 1, pendingReviewCount: 7, status: "paused" };
    expect(castBackfillProgressSchema.parse(progress)).toEqual(progress);
    expect(castBackfillProgressSchema.parse({ ...progress, status: "cancelled" }).completeTurns).toBe(2);
  });
  it("rejects impossible progress and a falsely complete range", () => {
    const progress = { id: "10000000-0000-4000-8000-000000000001", fromTurn: 3, throughTurn: 8,
      completeTurns: 2, failedTurns: 1, pendingReviewCount: 0, status: "running" };
    expect(castBackfillProgressSchema.safeParse({ ...progress, completeTurns: 6 }).success).toBe(false);
    expect(castBackfillProgressSchema.safeParse({ ...progress, status: "complete" }).success).toBe(false);
    expect(castBackfillProgressSchema.safeParse({ ...progress, completeTurns: 6, failedTurns: 0, status: "complete" }).success).toBe(true);
  });
  it("identifies the failed turn for explicit recovery without accepting an out-of-range turn", () => {
    const progress = { id: "10000000-0000-4000-8000-000000000001", fromTurn: 3, throughTurn: 8,
      completeTurns: 2, failedTurns: 1, pendingReviewCount: 0, firstFailedTurn: 5, status: "failed" };
    expect(castBackfillProgressSchema.safeParse(progress).success).toBe(true);
    expect(castBackfillProgressSchema.safeParse({ ...progress, firstFailedTurn: 9 }).success).toBe(false);
    expect(castBackfillProgressSchema.safeParse({ ...progress, failedTurns: 0 }).success).toBe(false);
  });
});

describe("accepted-history scan range policy", () => {
  const input = { request, boundary: request.expectedBoundary, coverageStartTurn: null,
    trackedThroughTurn: null, acceptedTurnNumbers: [3, 4, 5, 6, 7, 8] };
  it("allows initial selected coverage without claiming earlier history", () => {
    expect(validateCastBackfillRange(input)).toEqual({ turnCount: 6 });
  });
  it("rejects stale turn or timeline boundaries", () => {
    for (const boundary of [{ turnNumber: 9, timelineRevision: 0 }, { turnNumber: 10, timelineRevision: 1 }]) {
      expect(() => validateCastBackfillRange({ ...input, boundary })).toThrow("cast_stale_boundary");
    }
  });
  it("rejects missing, duplicate, or out-of-range accepted sources", () => {
    for (const acceptedTurnNumbers of [[3, 4, 6, 7, 8], [3, 4, 4, 6, 7, 8], [2, 4, 5, 6, 7, 8]]) {
      expect(() => validateCastBackfillRange({ ...input, acceptedTurnNumbers })).toThrow("cast_history_gap");
    }
  });
  it("allows adjacent and overlapping ranges but rejects disjoint coverage", () => {
    expect(validateCastBackfillRange({ ...input, coverageStartTurn: 9, trackedThroughTurn: 10 })).toEqual({ turnCount: 6 });
    expect(validateCastBackfillRange({ ...input, coverageStartTurn: 1, trackedThroughTurn: 4 })).toEqual({ turnCount: 6 });
    expect(() => validateCastBackfillRange({ ...input, coverageStartTurn: 10, trackedThroughTurn: 10 })).toThrow("cast_disjoint_coverage");
    expect(() => validateCastBackfillRange({ ...input, coverageStartTurn: 1, trackedThroughTurn: 1 })).toThrow("cast_disjoint_coverage");
  });
  it("requires adjacency to an enrolled but not yet processed forward boundary", () => {
    expect(validateCastBackfillRange({ ...input, coverageStartTurn: 9, trackedThroughTurn: 8 })).toEqual({ turnCount: 6 });
    expect(() => validateCastBackfillRange({ ...input, coverageStartTurn: 10, trackedThroughTurn: 9 })).toThrow("cast_disjoint_coverage");
  });
});
