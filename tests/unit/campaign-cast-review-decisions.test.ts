import { describe, expect, it } from "vitest";
import { reviewDecisionRequestSchema } from "../../packages/contracts/src/campaign-cast-review-decisions.js";
import { activeReviewDismissals, reviewTargetFingerprint } from "../../packages/domain/src/campaign-cast-review-decisions.js";
import type { CastDiscoveryCandidate, CastDiscoverySource } from "../../packages/contracts/src/campaign-cast-discovery.js";

const uuid = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const source: CastDiscoverySource = { scope: { ownerUserId: uuid, campaignId: uuid }, turnId: uuid, turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), timelineRevision: 0, paragraphs: [{ id: "p", text: "Text" }] };
const proposal: CastDiscoveryCandidate = { localKey: "job-one", name: "Ada", aliases: ["A", "The Ada"], existingCharacterId: null, identityEvidence: [{ paragraphId: "p", quote: "Ada" }], observations: [{ paragraphId: "p", quote: "Ada", field: "story.role", value: "Captain", mode: "fact", speakerCharacterId: null }] };
const base = { expectedCastRevision: 0, expectedBoundary: { turnNumber: 1, timelineRevision: 0 }, expectedReviewRevision: 0, sourceHash: "a".repeat(64), idempotencyKey: uuid };

describe("source-scoped review decisions", () => {
  it("validates strict requests and original observation indexes", () => {
    expect(reviewDecisionRequestSchema.safeParse({ ...base, action: "dismiss_detail", observationIndex: 0 }).success).toBe(true);
    expect(reviewDecisionRequestSchema.safeParse({ ...base, action: "dismiss_detail", observationIndex: 20 }).success).toBe(false);
    expect(reviewDecisionRequestSchema.safeParse({ ...base, action: "dismiss_detail", observationIndex: -1 }).success).toBe(false);
    expect(reviewDecisionRequestSchema.safeParse({ ...base, action: "dismiss_identity", extra: true }).success).toBe(false);
  });
  it("ignores transient keys and alias order for the same identity", () => {
    const original = reviewTargetFingerprint(source, { kind: "identity", proposal });
    expect(reviewTargetFingerprint(source, { kind: "identity", proposal: { ...proposal, localKey: other, aliases: [...proposal.aliases].reverse() } })).toBe(original);
    expect(reviewTargetFingerprint({ ...source, sourceHash: "b".repeat(64) }, { kind: "identity", proposal })).not.toBe(original);
  });
  it("restores only the referenced dismissal", () => {
    const decisions = [
      { id: "a", action: "dismiss" as const, restoresDecisionId: null },
      { id: "b", action: "dismiss" as const, restoresDecisionId: null },
      { id: "c", action: "restore" as const, restoresDecisionId: "a" }
    ];
    expect(activeReviewDismissals(decisions).map(item => item.id)).toEqual(["b"]);
  });
  it("retains value whitespace and speaker in detail fingerprints", () => {
    const observation = proposal.observations[0]!;
    const original = reviewTargetFingerprint(source, { kind: "detail", observation });
    expect(reviewTargetFingerprint(source, { kind: "detail", observation: { ...observation, value: "Captain " } })).not.toBe(original);
    expect(reviewTargetFingerprint(source, { kind: "detail", observation: { ...observation, speakerCharacterId: other } })).not.toBe(original);
  });
});
