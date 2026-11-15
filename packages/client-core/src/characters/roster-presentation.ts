import type { CastCharacter, CastDiscoveryStatus } from "@infinite-quest/contracts";
import { characterProvenanceLabel } from "./workspace.js";

export type RosterBadgeKind = "main" | "pinned" | "ignored" | "removed" | "review" | "conflict";
export type RosterBadge = { kind: RosterBadgeKind; label: string };
export type CastAttention = { review: boolean; conflict: boolean; reviewCount?: number; conflictCount?: number };
export type CastRosterRow = { id: string; name: string; summary: string; provenance: string; badges: RosterBadge[]; lastSeen: string };
export type TrackingTone = "ok" | "info" | "warning" | "error";
export type TrackingSummary = { tone: TrackingTone; headline: string; details: string[] };

export function castRosterRow(person: CastCharacter, attention?: CastAttention): CastRosterRow {
  const badges: RosterBadge[] = [];
  if (person.origin.kind === "protagonist") badges.push({ kind: "main", label: "Main" });
  if (person.pinned) badges.push({ kind: "pinned", label: "Pinned" });
  if (person.ignored) badges.push({ kind: "ignored", label: "Ignored" });
  if (person.removed) badges.push({ kind: "removed", label: "Removed" });
  if (attention?.review) badges.push({ kind: "review", label: `Needs review${attention.reviewCount != null ? ` (${attention.reviewCount})` : ""}` });
  if (attention?.conflict) badges.push({ kind: "conflict", label: `Conflict${attention.conflictCount != null ? ` (${attention.conflictCount})` : ""}` });
  const role = person.profile["story.role"];
  const points = Array.from(typeof role === "string" ? role : "");
  return { id: person.id, name: person.name, summary: points.length > 120 ? `${points.slice(0, 120).join("")}…` : points.join(""),
    provenance: characterProvenanceLabel(person), badges, lastSeen: `Last seen turn ${Math.max(person.lastObservedTurn, person.lastMentionedTurn ?? 0)}` };
}

export function trackingSummary(status: CastDiscoveryStatus | null): TrackingSummary {
  if (!status) return { tone: "warning", headline: "Character tracking status is unavailable. Saved characters are still available.", details: [] };
  const states: Record<CastDiscoveryStatus["state"], { tone: TrackingTone; headline: string }> = {
    disabled: { tone: "info", headline: "Automatic character tracking is disabled." },
    not_enrolled: { tone: "info", headline: "Character tracking starts with the next accepted turn." },
    catching_up: { tone: "info", headline: "Character tracking is catching up." },
    failed: { tone: "error", headline: "Character tracking stopped. Your story is saved." },
    complete: { tone: "ok", headline: "Character tracking is up to date." }
  };
  const details: string[] = [];
  if (status.coverageStartTurn !== null) details.push(status.trackedThroughTurn !== null && status.trackedThroughTurn >= status.coverageStartTurn
    ? `Tracked turns ${status.coverageStartTurn}–${status.trackedThroughTurn}. Earlier turns are not included.` : `Tracking starts at turn ${status.coverageStartTurn}.`);
  if (status.unresolvedCount) details.push(status.unresolvedCount === 1 ? "1 character match needs review." : `${status.unresolvedCount} character matches need review.`);
  return { ...states[status.state], details };
}
