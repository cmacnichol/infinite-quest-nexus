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
