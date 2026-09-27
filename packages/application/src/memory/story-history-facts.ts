import { estimateTokens } from "../../../domain/src/text.js";
import { z } from "@infinite-quest/contracts";

/** A complete, source-verified fact that may carry supersession authority. */
export type ProtectedFact = Readonly<{
  id: string;
  turnNumber: number;
  content: string;
}>;

/** Content-free accounting for a deliberately finite verified fact source. */
export type ProtectedFactSourceCoverage = Readonly<{
  candidateRows: number;
  sourceBytes: number;
  sourceLimitReached: boolean;
  oversizedCandidateCount: number;
  futureSourceCount: number;
  withheldCandidateCount: number;
}>;

export const protectedFactSchema = z.object({
  id: z.uuid(),
  turnNumber: z.number().int().min(0),
  content: z.string().min(1).max(4_000)
}).strict();

export const protectedFactSourceCoverageSchema = z.object({
  candidateRows: z.number().int().min(0).max(512),
  sourceBytes: z.number().int().min(0).max(1_000_000),
  sourceLimitReached: z.boolean(),
  oversizedCandidateCount: z.number().int().min(0).max(512),
  futureSourceCount: z.number().int().min(0).max(512),
  withheldCandidateCount: z.number().int().min(0).max(512)
}).strict();

/**
 * The source reader returns facts in source chronology (turn, source index,
 * ID). This selector intentionally preserves that chronology in its output.
 * It scans from the newest record, but a too-large record never prevents a
 * later fitting whole record from being retained.
 */
export function selectProtectedFacts(
  facts: readonly ProtectedFact[],
  budgetTokens: number,
): Readonly<{ facts: readonly ProtectedFact[]; omittedCount: number }> {
  const remaining = Number.isFinite(budgetTokens) ? Math.max(0, Math.floor(budgetTokens)) : 0;
  let available = remaining;
  const included = new Set<number>();
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const fact = facts[index]!;
    const cost = Math.max(1, estimateTokens(fact.content));
    if (cost > available) continue;
    included.add(index);
    available -= cost;
  }
  const selected = facts.filter((_, index) => included.has(index));
  return { facts: selected, omittedCount: facts.length - selected.length };
}
