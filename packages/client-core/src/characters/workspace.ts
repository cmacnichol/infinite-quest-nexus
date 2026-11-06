import type { CastCharacter, CharacterFilter } from "@infinite-quest/contracts";

/** Accepted-turn window behind the Recent filter when a server does not report one. */
export const DEFAULT_RECENT_WINDOW_TURNS = 10;

export function recentFilterLabel(windowTurns: number | undefined): string {
  return `Recent · last ${windowTurns ?? DEFAULT_RECENT_WINDOW_TURNS} turns`;
}

/** Established observation or textual mention inside the window ending at the captured boundary. */
export function isRecentCharacter(person: Pick<CastCharacter, "lastObservedTurn" | "lastMentionedTurn">, boundaryTurn: number,
  windowTurns = DEFAULT_RECENT_WINDOW_TURNS): boolean {
  const latest = Math.max(person.lastObservedTurn, person.lastMentionedTurn ?? 0);
  return latest > 0 && latest >= Math.max(1, boundaryTurn - (windowTurns - 1));
}

/**
 * Filters derivable from roster rows alone, for servers that predate scoped filtering.
 * Review and conflict filters need server-side evidence, so they match nothing locally.
 * Ignored characters appear only under Ignored.
 */
export function matchesLocalCharacterFilter(person: CastCharacter, filter: CharacterFilter, boundaryTurn: number,
  windowTurns = DEFAULT_RECENT_WINDOW_TURNS): boolean {
  if (filter === "ignored") return person.ignored;
  if (person.ignored) return false;
  switch (filter) {
    case "main": return person.origin.kind === "protagonist";
    case "pinned": return person.pinned;
    case "recent": return isRecentCharacter(person, boundaryTurn, windowTurns);
    case "needs_review": case "conflicts": return false;
    default: return true;
  }
}

/** Short provenance label shared by both roster renderers. */
export function characterProvenanceLabel(person: Pick<CastCharacter, "origin">): string {
  return person.origin.kind === "protagonist" ? "Main character" : person.origin.kind === "manual" ? "Added by you" : "Discovered";
}
