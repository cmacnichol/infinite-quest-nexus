import type { AuthoringJobView } from "../../../packages/contracts/src/authoring";
import { worldContentSchema, type WorldContent } from "../../../packages/contracts/src/world-library";

/** Reconstruct only owner-loaded, explicitly reviewed character proposals, in memory. */
export function reviewedCharacterParent(job: AuthoringJobView): WorldContent {
  if (job.kind !== "character" || !job.request || !job.reviewedContent || ["cancelled", "expired", "failed", "applied"].includes(job.status)) throw new Error("Reviewed character proposal unavailable.");
  const parent = structuredClone(job.request.content);
  const candidate = structuredClone(job.reviewedContent);
  const selectedId = job.request.characterId ?? (job.target.kind === "world_draft" ? job.target.characterId : undefined);
  if (selectedId) {
    const index = parent.playableCharacters.findIndex(character => character.id === selectedId);
    if (index < 0 || candidate.id !== selectedId) throw new Error("Character identity changed.");
    parent.playableCharacters[index] = candidate;
  } else {
    if (candidate.id !== job.result?.id || parent.playableCharacters.some(character => character.id === candidate.id)) throw new Error("Character identity changed.");
    parent.playableCharacters.push(candidate);
  }
  return worldContentSchema.parse(parent);
}
