import { createHash } from "node:crypto";
import { normalizeCastAlias } from "../../contracts/src/campaign-cast.js";
import type { CastDiscoveryCandidate, CastDiscoverySource } from "../../contracts/src/campaign-cast-discovery.js";

export type ReviewTarget = { kind: "identity"; proposal: CastDiscoveryCandidate }
  | { kind: "detail"; observation: CastDiscoveryCandidate["observations"][number] };

/** Stable across candidate/job IDs and timeline revisions; retained-source validity is checked separately. */
export function reviewTargetFingerprint(source: CastDiscoverySource, target: ReviewTarget): string {
  const evidence = (item: { paragraphId: string; quote: string }) => [item.paragraphId, item.quote];
  const payload = target.kind === "identity"
    ? ["identity", normalizeCastAlias(target.proposal.name), [...new Set(target.proposal.aliases.map(normalizeCastAlias))].sort(),
      target.proposal.existingCharacterId, target.proposal.identityEvidence.map(evidence).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)]
    : ["detail", target.observation.field, target.observation.value, target.observation.mode,
      target.observation.speakerCharacterId, ...evidence(target.observation)];
  return createHash("sha256").update(JSON.stringify(["cast-review-v1", source.scope.ownerUserId, source.scope.campaignId,
    source.turnId, source.narrationRevision, source.sourceHash, payload])).digest("hex");
}

/** Fold in sequence order; restores only cancel the dismissal they reference. */
export function activeReviewDismissals<T extends { id: string; action: "dismiss" | "restore"; restoresDecisionId: string | null }>(decisions: readonly T[]): T[] {
  const active = new Map<string, T>();
  for (const decision of decisions) {
    if (decision.action === "dismiss") active.set(decision.id, decision);
    else if (decision.restoresDecisionId) active.delete(decision.restoresDecisionId);
  }
  return [...active.values()];
}
