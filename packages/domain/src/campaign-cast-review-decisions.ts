import { createHash } from "node:crypto";
import { normalizeCastAlias } from "../../contracts/src/campaign-cast.js";
import type { CastDiscoveryCandidate, CastDiscoverySource } from "../../contracts/src/campaign-cast-discovery.js";

export type ReviewTarget = { kind: "identity"; proposal: CastDiscoveryCandidate }
  | { kind: "detail"; proposal: CastDiscoveryCandidate; observation: CastDiscoveryCandidate["observations"][number] };

/** Canonical source and target used for collision-safe comparison, independently of their hash. */
export function canonicalReviewTarget(source: CastDiscoverySource, target: ReviewTarget): string {
  const evidence = (item: { paragraphId: string; quote: string }) => [item.paragraphId, item.quote];
  const proposal = target.proposal;
  const identity = [normalizeCastAlias(proposal.name), [...new Set(proposal.aliases.map(normalizeCastAlias))].sort(),
    proposal.existingCharacterId, proposal.identityEvidence.map(evidence).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)];
  const payload = target.kind === "identity" ? ["identity", identity]
    : ["detail", identity, target.observation.field, target.observation.value, target.observation.mode,
      target.observation.speakerCharacterId, ...evidence(target.observation)];
  return JSON.stringify(["cast-review-v2", source.scope.ownerUserId, source.scope.campaignId,
    source.turnId, source.narrationRevision, source.sourceHash, payload]);
}

/** Stable across candidate/job IDs and timeline revisions; retained-source validity is checked separately. */
export function reviewTargetFingerprint(source: CastDiscoverySource, target: ReviewTarget): string {
  return createHash("sha256").update(canonicalReviewTarget(source, target)).digest("hex");
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
