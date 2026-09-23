import { z } from "zod";
import { castBoundarySchema, castWriteBase } from "./campaign-cast.js";
import { textModelSelectionSchema } from "./provider-selection.js";

const turn = z.number().int().positive();
const count = z.number().int().nonnegative();
export const castBackfillRetrySchema = z.object({ ...castWriteBase, turnNumber: turn }).strict();
export type CastBackfillRetry = z.infer<typeof castBackfillRetrySchema>;
export const castBackfillPreviewSchema = z.object({
  fromTurn: turn, throughTurn: turn, boundary: castBoundarySchema, turnCount: turn,
  estimatedChunkRequests: count, completedChunkReceipts: count, completedTurns: count,
  manualScanTurns: z.array(turn), providerProfileId: z.uuid(), selection: textModelSelectionSchema
}).strict().refine(value => value.throughTurn <= value.boundary.turnNumber
  && value.turnCount === value.throughTurn - value.fromTurn + 1
  && value.completedTurns + value.manualScanTurns.length <= value.turnCount
  && new Set(value.manualScanTurns).size === value.manualScanTurns.length
  && value.manualScanTurns.every(number => number >= value.fromTurn && number <= value.throughTurn),
"Preview counts must describe the selected accepted range.");
export type CastBackfillPreview = z.infer<typeof castBackfillPreviewSchema>;
export const castBackfillRequestSchema = z.object({
  fromTurn: turn, throughTurn: turn, expectedBoundary: castBoundarySchema,
  idempotencyKey: z.string().trim().min(1).max(200)
}).strict().refine((value) => value.fromTurn <= value.throughTurn, "The scan range must be ordered.")
  .refine((value) => value.throughTurn <= value.expectedBoundary.turnNumber, "The scan range cannot exceed the expected campaign boundary.");

export const castBackfillProgressSchema = z.object({
  id: z.uuid(), fromTurn: turn, throughTurn: turn,
  completeTurns: count, failedTurns: count, pendingReviewCount: count,
  firstFailedTurn: turn.nullable().optional(),
  status: z.enum(["queued", "running", "paused", "complete", "failed", "cancelled"])
}).strict().superRefine((value, context) => {
  const total = value.throughTurn - value.fromTurn + 1;
  if (value.firstFailedTurn !== undefined && (value.firstFailedTurn === null ? value.failedTurns !== 0
    : value.failedTurns === 0 || value.firstFailedTurn < value.fromTurn || value.firstFailedTurn > value.throughTurn)) {
    context.addIssue({ code: "custom", path: ["firstFailedTurn"], message: "The failed turn must belong to the selected range and match failure progress." });
  }
  if (total < 1) context.addIssue({ code: "custom", path: ["throughTurn"], message: "The scan range must be ordered." });
  if (value.completeTurns + value.failedTurns > total) {
    context.addIssue({ code: "custom", path: ["completeTurns"], message: "Processed turns cannot exceed the scan range." });
  }
  if (value.status === "complete" && (value.completeTurns !== total || value.failedTurns !== 0)) {
    context.addIssue({ code: "custom", path: ["status"], message: "A complete scan must account for every turn without failures." });
  }
});

export type CastBackfillRequest = z.infer<typeof castBackfillRequestSchema>;
export type CastBackfillProgress = z.infer<typeof castBackfillProgressSchema>;
