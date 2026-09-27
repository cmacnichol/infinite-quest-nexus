import { estimateTokens, stableStringify } from "./text.js";
import { isSourceBoundary, normalizeStoryEvidenceSource } from "./story-evidence-spans.js";

export type StoryLedgerSourceTurn = Readonly<{ turnId: string; turnNumber: number; inputMode: "action" | "scene"; action: string }>;
export type StoryLedgerEntry = Readonly<Omit<StoryLedgerSourceTurn, "action"> & { direction: string }>;
export type StoryLedger = Readonly<{ version: "story-ledger-v1"; entries: readonly StoryLedgerEntry[]; omittedThroughTurn: number | null }>;
export type ProtectedFact = Readonly<{ id: string; turnNumber: number; content: string }>;

function trimAtSafeBoundary(value: string, maximumCharacters: number): string {
  if (value.length <= maximumCharacters) return value;
  const ellipsis = "…";
  let end = Math.max(0, maximumCharacters - ellipsis.length);
  while (end > 0 && !isSourceBoundary(value, end)) end--;
  const wordBoundary = value.lastIndexOf(" ", end - 1);
  if (wordBoundary > Math.floor(end / 2)) end = wordBoundary;
  return `${value.slice(0, end).trimEnd()}${ellipsis}`;
}

/** Produces a bounded, fiction-safe description of what the player attempted. */
export function ledgerDirectionExcerpt(text: string, maximumCharacters: number): string {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 1) return "";
  return trimAtSafeBoundary(normalizeStoryEvidenceSource(text), maximumCharacters);
}

function ledgerTokens(entries: readonly StoryLedgerEntry[], omittedThroughTurn: number | null): number {
  return estimateTokens(stableStringify({ version: "story-ledger-v1", entries, omittedThroughTurn }));
}

export function selectStoryLedger(turns: readonly StoryLedgerSourceTurn[], options: Readonly<{ budgetTokens: number; directionCharacters: number }>): StoryLedger {
  const ordered = [...turns].sort((left, right) => left.turnNumber - right.turnNumber || left.turnId.localeCompare(right.turnId));
  const safe = ordered.map((turn) => ({ turn, direction: ledgerDirectionExcerpt(turn.action, options.directionCharacters) }));
  const selected: StoryLedgerEntry[] = [];
  let omittedThroughTurn: number | null = null;
  for (const candidate of safe.slice().reverse()) {
    if (!candidate.direction) { omittedThroughTurn = Math.max(omittedThroughTurn ?? 0, candidate.turn.turnNumber); continue; }
    const trial = [{ turnId: candidate.turn.turnId, turnNumber: candidate.turn.turnNumber, inputMode: candidate.turn.inputMode, direction: candidate.direction }, ...selected];
    const nextOmitted = omittedThroughTurn ?? (selected.length ? candidate.turn.turnNumber - 1 : null);
    if (!Number.isFinite(options.budgetTokens) || options.budgetTokens < 0 || ledgerTokens(trial, nextOmitted) > options.budgetTokens) { omittedThroughTurn = Math.max(omittedThroughTurn ?? 0, candidate.turn.turnNumber); break; }
    selected.unshift(trial[0]!);
  }
  const selectedIds = new Set(selected.map((entry) => entry.turnId));
  const absent = safe.filter(({ turn }) => !selectedIds.has(turn.turnId)).map(({ turn }) => turn.turnNumber);
  return { version: "story-ledger-v1", entries: selected, omittedThroughTurn: absent.length ? Math.max(...absent) : null };
}

export function selectProtectedFacts(facts: readonly ProtectedFact[], budgetTokens: number): Readonly<{ facts: readonly ProtectedFact[]; omittedCount: number }> {
  let available = Number.isFinite(budgetTokens) ? Math.max(0, Math.floor(budgetTokens)) : 0;
  const included = new Set<number>();
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const fact = facts[index]!;
    const cost = Math.max(1, estimateTokens(fact.content));
    if (cost <= available) { included.add(index); available -= cost; }
  }
  const selected = facts.filter((_, index) => included.has(index));
  return { facts: selected, omittedCount: facts.length - selected.length };
}
