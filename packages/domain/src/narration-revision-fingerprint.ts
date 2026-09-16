import { sha256 } from "./text.js";

/** Stable guard for a complete retained narration revision set. */
export function narrationRevisionFingerprint(revisions: readonly Readonly<{ turnId: string; correctionRevision: number }>[]): string {
  return sha256(JSON.stringify(revisions.map(({ turnId, correctionRevision }) => [turnId, correctionRevision]).sort(([left], [right]) => String(left).localeCompare(String(right)))));
}
