import { estimateTokens, stableStringify } from "../../../domain/src/index.js";
import { isSourceBoundary, normalizeStoryEvidenceSource } from "../../../domain/src/story-evidence-spans.js";
import { z } from "@infinite-quest/contracts";

export type StoryLedgerSourceTurn = Readonly<{
  turnId: string;
  turnNumber: number;
  inputMode: "action" | "scene";
  action: string;
}>;

export type StoryLedgerEntry = Readonly<Omit<StoryLedgerSourceTurn, "action"> & { direction: string }>;

export type StoryLedger = Readonly<{
  version: "story-ledger-v1";
  entries: readonly StoryLedgerEntry[];
  omittedThroughTurn: number | null;
  coverage?: StoryLedgerCoverage;
}>;

export type StoryLedgerCoverage = Readonly<{
  unreadThroughTurn: number | null;
  missingTurnCount: number;
  filteredDirectionCount: number;
  oversizedDirectionCount: number;
  loadedRows: number;
}>;

export const storyLedgerEntrySchema = z.object({
  turnId: z.string().min(1), turnNumber: z.number().int().min(1), inputMode: z.enum(["action", "scene"]), direction: z.string().min(1).max(480)
}).strict();
export const storyLedgerSchema = z.object({
  version: z.literal("story-ledger-v1"), entries: z.array(storyLedgerEntrySchema), omittedThroughTurn: z.number().int().min(1).nullable(),
  coverage: z.object({ unreadThroughTurn: z.number().int().min(1).nullable(), missingTurnCount: z.number().int().nonnegative(),
    filteredDirectionCount: z.number().int().nonnegative(), oversizedDirectionCount: z.number().int().nonnegative(), loadedRows: z.number().int().nonnegative() }).strict().optional()
}).strict();

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
  const normalized = normalizeStoryEvidenceSource(text);
  return trimAtSafeBoundary(normalized, maximumCharacters);
}

function ledgerTokens(entries: readonly StoryLedgerEntry[], omittedThroughTurn: number | null): number {
  return estimateTokens(stableStringify({ version: "story-ledger-v1", entries, omittedThroughTurn }));
}

/**
 * Selects a chronological suffix of safe directions. It deliberately records
 * intent only: no narration, event, or canonical-fact identity can enter this projection.
 */
export function selectStoryLedger(
  turns: readonly StoryLedgerSourceTurn[],
  options: Readonly<{ budgetTokens: number; directionCharacters: number }>
): StoryLedger {
  const ordered = [...turns].sort((left, right) => left.turnNumber - right.turnNumber || left.turnId.localeCompare(right.turnId));
  const safe = ordered.map((turn) => ({ turn, direction: ledgerDirectionExcerpt(turn.action, options.directionCharacters) }));
  const newestFirst = safe.slice().reverse();
  const selected: StoryLedgerEntry[] = [];
  let omittedThroughTurn: number | null = null;
  for (const candidate of newestFirst) {
    if (!candidate.direction) {
      omittedThroughTurn = Math.max(omittedThroughTurn ?? 0, candidate.turn.turnNumber);
      continue;
    }
    const trial = [{ turnId: candidate.turn.turnId, turnNumber: candidate.turn.turnNumber, inputMode: candidate.turn.inputMode, direction: candidate.direction }, ...selected];
    const nextOmitted = omittedThroughTurn ?? (selected.length ? candidate.turn.turnNumber - 1 : null);
    if (!Number.isFinite(options.budgetTokens) || options.budgetTokens < 0 || ledgerTokens(trial, nextOmitted) > options.budgetTokens) {
      omittedThroughTurn = Math.max(omittedThroughTurn ?? 0, candidate.turn.turnNumber);
      break;
    }
    selected.unshift(trial[0]!);
  }
  const selectedIds = new Set(selected.map((entry) => entry.turnId));
  const absent = safe.filter(({ turn }) => !selectedIds.has(turn.turnId)).map(({ turn }) => turn.turnNumber);
  return { version: "story-ledger-v1", entries: selected, omittedThroughTurn: absent.length ? Math.max(...absent) : null };
}
