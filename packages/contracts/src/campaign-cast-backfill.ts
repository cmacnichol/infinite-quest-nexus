import { z } from "zod";
import { castBoundarySchema } from "./campaign-cast.js";

const turn = z.number().int().positive();
const count = z.number().int().nonnegative();
export const castBackfillRequestSchema = z.object({
  fromTurn: turn, throughTurn: turn, expectedBoundary: castBoundarySchema,
  idempotencyKey: z.string().trim().min(1).max(200)
}).strict().refine((value) => value.fromTurn <= value.throughTurn, "The scan range must be ordered.")
  .refine((value) => value.throughTurn <= value.expectedBoundary.turnNumber, "The scan range cannot exceed the expected campaign boundary.");

export const castBackfillProgressSchema = z.object({
  id: z.uuid(), fromTurn: turn, throughTurn: turn,
  completeTurns: count, failedTurns: count, pendingReviewCount: count,
  status: z.enum(["queued", "running", "paused", "complete", "failed", "cancelled"])
}).strict().superRefine((value, context) => {
  const total = value.throughTurn - value.fromTurn + 1;
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
