import { castBackfillRequestSchema, type CastBackfillRequest, type CastBoundary } from "@infinite-quest/contracts";
import type { CastScope, CastBackfillPreview, CastBackfillProgress, CastBackfillRetry } from "@infinite-quest/contracts";

export interface CastBackfillApplication {
  enabled: boolean;
  preview(scope: CastScope, request: CastBackfillRequest): Promise<CastBackfillPreview>;
  start(scope: CastScope, request: CastBackfillRequest): Promise<CastBackfillProgress>;
  latest(scope: CastScope): Promise<CastBackfillProgress | null>;
  get(scope: CastScope, id: string): Promise<CastBackfillProgress>;
  control(scope: CastScope, id: string, action: "pause" | "resume" | "cancel"): Promise<CastBackfillProgress>;
  retry(scope: CastScope, id: string, request: CastBackfillRetry): Promise<CastBackfillProgress>;
}

export function validateCastBackfillRange(input: {
  request: CastBackfillRequest;
  boundary: CastBoundary;
  coverageStartTurn: number | null;
  trackedThroughTurn: number | null;
  acceptedTurnNumbers: readonly number[];
}): { turnCount: number } {
  const request = castBackfillRequestSchema.parse(input.request);
  if (request.expectedBoundary.turnNumber !== input.boundary.turnNumber
    || request.expectedBoundary.timelineRevision !== input.boundary.timelineRevision) {
    throw new Error("cast_stale_boundary");
  }
  const turnCount = request.throughTurn - request.fromTurn + 1;
  const turns = [...input.acceptedTurnNumbers].sort((left, right) => left - right);
  if (turns.length !== turnCount || turns.some((value, index) => value !== request.fromTurn + index)) {
    throw new Error("cast_history_gap");
  }
  if (input.coverageStartTurn !== null) {
    const through = input.trackedThroughTurn ?? input.coverageStartTurn - 1;
    if (request.throughTurn < input.coverageStartTurn - 1 || request.fromTurn > through + 1) {
      throw new Error("cast_disjoint_coverage");
    }
  }
  return { turnCount };
}
