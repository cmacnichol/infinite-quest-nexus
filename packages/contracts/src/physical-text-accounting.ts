import { z } from "zod";

const observedTokensSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const coverageSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Bounded owner-facing ledger projection; no prompt, route, or request identity. */
export const physicalTextAccountingSchema = z.object({
  attemptCount: coverageSchema,
  completedCount: coverageSchema,
  observedUsage: z.object({
    inputTokens: observedTokensSchema,
    outputTokens: observedTokensSchema,
    totalTokens: observedTokensSchema
  }).strict(),
  usageCoverage: z.object({
    inputTokens: coverageSchema,
    outputTokens: coverageSchema,
    totalTokens: coverageSchema
  }).strict(),
  reportedCosts: z.array(z.object({
    amount: z.string().max(64).regex(/^\d+(?:\.\d+)?$/u),
    currency: z.string().regex(/^[A-Z]{3}$/u)
  }).strict()).max(1_000)
}).strict();

export type PhysicalTextAccounting = z.infer<typeof physicalTextAccountingSchema>;
