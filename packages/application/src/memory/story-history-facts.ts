import { z } from "@infinite-quest/contracts";

/** A complete, source-verified fact that may carry supersession authority. */
export type ProtectedFact = Readonly<{
  id: string;
  turnNumber: number;
  content: string;
}>;

/** Content-free accounting for the complete verified fact source. */
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
  candidateRows: z.number().int().min(0),
  sourceBytes: z.number().int().min(0),
  sourceLimitReached: z.boolean(),
  oversizedCandidateCount: z.number().int().min(0),
  futureSourceCount: z.number().int().min(0),
  withheldCandidateCount: z.number().int().min(0)
}).strict();
