import type { CastCandidateList } from "@infinite-quest/contracts";

type Candidate = CastCandidateList["candidates"][number];
type Detail = NonNullable<Candidate["details"]>[number];
type Entry = { candidate: Candidate; detail: Detail };
export type ReviewItem = { kind: "identity"; candidate: Candidate } | { kind: "detail"; characterId: string; field: string; entries: Entry[] };
export function buildReviewQueue(matches: Candidate[], details: Candidate[]): ReviewItem[] {
  const queue: ReviewItem[] = matches.filter(candidate => !candidate.resolvedCharacterId).map(candidate => ({ kind: "identity", candidate }));
  const groups = new Map<string, Extract<ReviewItem, { kind: "detail" }>>();
  for (const candidate of details) if (candidate.resolvedCharacterId) for (const detail of candidate.details ?? []) {
    const key = JSON.stringify([candidate.resolvedCharacterId, detail.field]);
    let group = groups.get(key);
    if (!group) { group = { kind: "detail", characterId: candidate.resolvedCharacterId, field: detail.field, entries: [] }; groups.set(key, group); queue.push(group); }
    group.entries.push({ candidate, detail });
  }
  for (const group of groups.values()) group.entries.sort((a, b) => a.candidate.source.turnNumber - b.candidate.source.turnNumber);
  return queue;
}
