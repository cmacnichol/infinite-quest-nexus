import { z } from "zod";
import { turnSummarySchema } from "./client-api.js";

export const readerTurnNumberSchema = z.coerce.number().int().positive();

export const readerTurnResponseSchema = z.object({
  campaignId: z.uuid(),
  turn: turnSummarySchema
});

export type ReaderTurnResponse = z.infer<typeof readerTurnResponseSchema>;

export const readerHistoryRequestSchema = z.object({
  q: z.string().trim().max(200).optional().default(""),
  before: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(50)
});

export const readerHistoryItemSchema = z.object({
  id: z.uuid(),
  turnNumber: z.number().int().positive(),
  acceptedAt: z.iso.datetime(),
  excerpt: z.string().max(240)
});

export const readerHistoryResponseSchema = z.object({
  campaignId: z.uuid(),
  items: z.array(readerHistoryItemSchema).max(50),
  nextCursor: z.string().min(1).max(4096).nullable()
});

export type ReaderHistoryRequest = z.infer<typeof readerHistoryRequestSchema>;
export type ReaderHistoryItem = z.infer<typeof readerHistoryItemSchema>;
export type ReaderHistoryResponse = z.infer<typeof readerHistoryResponseSchema>;

export const readerSceneWindowRequestSchema = z.object({
  anchorTurnNumber: readerTurnNumberSchema,
  anchorTurnId: z.uuid(),
  direction: z.enum(["older", "newer"]),
  neighborLimit: z.coerce.number().int().min(1).max(9).optional().default(9),
  historyToken: z.string().min(1).max(4096).optional()
}).strict();

export type ReaderSceneWindowRequestInput = z.input<typeof readerSceneWindowRequestSchema>;
export type ReaderSceneWindowRequest = z.output<typeof readerSceneWindowRequestSchema>;

export const readerSceneWindowResponseSchema = z.object({
  campaignId: z.uuid(),
  anchor: z.object({
    turnNumber: readerTurnNumberSchema,
    id: z.uuid()
  }).strict(),
  direction: z.enum(["older", "newer"]),
  turns: z.array(turnSummarySchema).min(1).max(10),
  hasMore: z.boolean(),
  historyToken: z.string().min(1).max(4096)
}).strict().superRefine((response, context) => {
  const ids = new Set<string>();
  const turnNumbers = new Set<number>();
  for (let index = 0; index < response.turns.length; index += 1) {
    const turn = response.turns[index]!;
    if (ids.has(turn.id)) {
      context.addIssue({ code: "custom", path: ["turns", index, "id"], message: "Turn ids must be unique." });
    }
    if (turnNumbers.has(turn.turnNumber)) {
      context.addIssue({ code: "custom", path: ["turns", index, "turnNumber"], message: "Turn numbers must be unique." });
    }
    if (index > 0 && response.turns[index - 1]!.turnNumber >= turn.turnNumber) {
      context.addIssue({ code: "custom", path: ["turns", index, "turnNumber"], message: "Turns must be in ascending order." });
    }
    ids.add(turn.id);
    turnNumbers.add(turn.turnNumber);
  }

  const anchorTurn = response.direction === "older" ? response.turns.at(-1) : response.turns[0];
  if (anchorTurn?.id !== response.anchor.id || anchorTurn.turnNumber !== response.anchor.turnNumber) {
    context.addIssue({ code: "custom", path: ["turns"], message: "The anchor must be the requested edge turn." });
  }
});

export type ReaderSceneWindowResponse = z.infer<typeof readerSceneWindowResponseSchema>;
