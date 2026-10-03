import { z } from "zod";
import { turnSummarySchema } from "./client-api.js";

export const readerTurnNumberSchema = z.coerce.number().int().positive();

export const readerTurnResponseSchema = z.object({
  campaignId: z.uuid(),
  turn: turnSummarySchema
});

export type ReaderTurnResponse = z.infer<typeof readerTurnResponseSchema>;
