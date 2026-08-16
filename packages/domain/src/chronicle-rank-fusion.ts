import type { ChronicleMemoryKind } from "./chronicle-chunking.js";
import type { ChronicleQueryKind } from "./chronicle-query-plan.js";

export type ChronicleRankSignal =
  | "semantic"
  | "full_text"
  | "entity"
  | "recency"
  | "chronology"
  | "importance"
  | "kind"
  | "temporal";

export type ChronicleRankCandidate = Readonly<{
  candidateId: string;
  parentMemoryId: string;
  parentTurnId: string | null;
  parentOrdinal: number;
  memoryKind: ChronicleMemoryKind;
  activeFact: boolean;
}>;

export type ChronicleRankInput = Readonly<{
  signal: ChronicleRankSignal;
  variant: ChronicleQueryKind;
  candidates: readonly ChronicleRankCandidate[];
}>;

export type ChronicleRankFusionWeights = Readonly<{
  signals?: Partial<Readonly<Record<ChronicleRankSignal, number>>>;
  variants?: Partial<Readonly<Record<ChronicleQueryKind, number>>>;
}>;

export type ChronicleRankFusionProfile = Readonly<{
  rrfK: number;
  weights: ChronicleRankFusionWeights;
}>;

export type ChronicleRankContribution = Readonly<{
  signal: ChronicleRankSignal;
  variant: ChronicleQueryKind;
  rank: number;
  weight: number;
  score: number;
}>;

export type FusedChronicleCandidate = ChronicleRankCandidate & Readonly<{
  score: number;
  contributions: readonly ChronicleRankContribution[];
}>;

function finiteWeight(value: number | undefined): number {
  return value === undefined ? 1 : Number.isFinite(value) && value >= 0 ? value : 0;
}

function eligible(candidate: ChronicleRankCandidate): boolean {
  return candidate.memoryKind !== "canonical_fact" || candidate.activeFact;
}

/** Weighted reciprocal-rank fusion over pre-authorized, independently ranked lists. */
export function fuseChronicleRanks(
  inputs: readonly ChronicleRankInput[],
  profile: ChronicleRankFusionProfile
): readonly FusedChronicleCandidate[] {
  if (!Number.isFinite(profile.rrfK) || profile.rrfK < 0) {
    throw new Error("Chronicle reciprocal-rank constant must be a non-negative number.");
  }
  const fused = new Map<string, {
    candidate: ChronicleRankCandidate;
    score: number;
    contributions: ChronicleRankContribution[];
  }>();
  for (const input of inputs) {
    const weight = finiteWeight(profile.weights.signals?.[input.signal])
      * finiteWeight(profile.weights.variants?.[input.variant]);
    if (weight === 0) continue;
    const seen = new Set<string>();
    let rank = 0;
    for (const candidate of input.candidates) {
      if (!eligible(candidate) || seen.has(candidate.candidateId)) continue;
      seen.add(candidate.candidateId);
      rank += 1;
      const score = weight / (profile.rrfK + rank);
      const existing = fused.get(candidate.candidateId) ?? { candidate, score: 0, contributions: [] };
      existing.score += score;
      existing.contributions.push({ signal: input.signal, variant: input.variant, rank, weight, score });
      fused.set(candidate.candidateId, existing);
    }
  }
  return Object.freeze([...fused.values()]
    .map(({ candidate, score, contributions }) => Object.freeze({
      ...candidate,
      score,
      contributions: Object.freeze([...contributions].sort((left, right) => (
        left.signal.localeCompare(right.signal)
        || left.variant.localeCompare(right.variant)
        || left.rank - right.rank
      )))
    }))
    .sort((left, right) => right.score - left.score
      || left.parentMemoryId.localeCompare(right.parentMemoryId)
      || left.candidateId.localeCompare(right.candidateId)));
}
