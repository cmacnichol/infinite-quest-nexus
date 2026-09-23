import { castBackfillRequestSchema, type CastBackfillRequest, type CastBoundary } from "@infinite-quest/contracts";

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
