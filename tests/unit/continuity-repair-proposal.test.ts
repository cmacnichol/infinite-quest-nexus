import { describe, expect, it } from "vitest";
import { buildContinuityRepairProposal, proposalRevisionIsStale } from "../../scripts/lib/continuity-repair-proposal.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const ownerUserId = "22222222-2222-4222-8222-222222222222";

function source(overrides: Record<string, unknown> = {}) {
  return {
    campaignId,
    ownerUserId,
    worldVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    baseRevision: 7,
    baseTurnNumber: 3,
    activeTurnNumber: 3,
    currentState: { continuitySummary: "", openThreads: [], canonicalFacts: [], scratchpad: "", trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [] },
    acceptedSnapshots: [{ turnId: "33333333-3333-4333-8333-333333333333", turnNumber: 2, snapshot: { canonicalFacts: [{ id: "44444444-4444-4444-8444-444444444444", content: "The lighthouse key is silver." }] } }],
    effectiveNarrations: [{ turnId: "33333333-3333-4333-8333-333333333333", turnNumber: 2, correctionRevision: 1, text: "The lighthouse key is silver." }],
    stateEdits: [],
    ...overrides
  };
}

describe("continuity repair proposal", () => {
  it("emits a source-linked canonical-fact proposal with the exact revision-checked state API action", () => {
    const proposal = buildContinuityRepairProposal(source());
    expect(proposal.proposals).toEqual([expect.objectContaining({
      status: "proposed", proposedValue: "The lighthouse key is silver.", source: expect.objectContaining({ kind: "accepted_snapshot", turnNumber: 2 }),
      apply: expect.objectContaining({ method: "PATCH", path: `/api/v1/campaigns/${campaignId}/state`, body: expect.objectContaining({ expectedRevision: 7, expectedTurnNumber: 3, canonicalFacts: [{ id: null, content: "The lighthouse key is silver." }] }) })
    })]);
    expect(proposal.effectiveNarrations).toEqual([expect.objectContaining({ correctionRevision: 1 })]);
    expect(proposal.proposals[0]).toMatchObject({ narrationEvidence: [{ turnNumber: 2, quote: "The lighthouse key is silver." }] });
  });

  it("vetoes restoration when a later explicit correction intentionally makes canonical facts empty", () => {
    const proposal = buildContinuityRepairProposal(source({
      stateEdits: [{ id: "55555555-5555-4555-8555-555555555555", revision: 8, effectiveTurnNumber: 3, snapshot: { canonicalFacts: [] } }]
    }));
    expect(proposal.proposals).toEqual([]);
    expect(proposal.vetoes).toEqual([expect.objectContaining({ reason: "later_explicit_empty_correction" })]);
  });

  it("respects nonempty correction deletion and orders corrections by effective turn", () => {
    const later = buildContinuityRepairProposal(source({ stateEdits: [{ id: "later", revision: 2, effectiveTurnNumber: 3, snapshot: { canonicalFacts: [{ id: null, content: "An unrelated surviving fact." }] } }] }));
    expect(later.proposals.some((item) => item.proposedValue === "The lighthouse key is silver.")).toBe(false);
    const earlier = buildContinuityRepairProposal(source({ stateEdits: [{ id: "earlier", revision: 9999, effectiveTurnNumber: 1, snapshot: { canonicalFacts: [] } }] }));
    expect(earlier.proposals).toHaveLength(1);
  });
  it("does not restore a snapshot fact contradicted by a corrected source narration", () => {
    const proposal = buildContinuityRepairProposal(source({ effectiveNarrations: [{ turnId: "33333333-3333-4333-8333-333333333333", turnNumber: 2, correctionRevision: 2, text: "The key is brass now." }] }));
    expect(proposal.proposals).toEqual([]);
    expect(proposal.unrecoverable).toEqual([expect.objectContaining({ reason: "corrected_source_requires_review" })]);
  });

  it("vetoes a retained fact whose projection records it as superseded or deleted", () => {
    const proposal = buildContinuityRepairProposal(source({ retiredFactIds: ["44444444-4444-4444-8444-444444444444"] }));
    expect(proposal.proposals).toEqual([]);
    expect(proposal.vetoes).toEqual([expect.objectContaining({ reason: "superseded_or_deleted_fact" })]);
  });

  it("marks conflicting retained snapshots ambiguous instead of selecting a value", () => {
    const proposal = buildContinuityRepairProposal(source({
      acceptedSnapshots: [
        { turnId: "33333333-3333-4333-8333-333333333333", turnNumber: 1, snapshot: { canonicalFacts: [{ id: "44444444-4444-4444-8444-444444444444", content: "The key is silver." }] } },
        { turnId: "66666666-6666-4666-8666-666666666666", turnNumber: 2, snapshot: { canonicalFacts: [{ id: "44444444-4444-4444-8444-444444444444", content: "The key is brass." }] } }
      ]
    }));
    expect(proposal.proposals).toEqual([]);
    expect(proposal.unrecoverable).toEqual([expect.objectContaining({ reason: "ambiguous_retained_evidence" })]);
  });

  it("records lost requested evidence as unrecoverable without inventing a proposal", () => {
    const proposal = buildContinuityRepairProposal({ ...source(), missingSources: [{ reference: "turn 1 snapshot was purged" }] });
    expect(proposal.proposals).toEqual([expect.any(Object)]);
    expect(proposal.unrecoverable).toEqual([expect.objectContaining({ reason: "retained_source_unavailable" })]);
  });

  it("uses a retained explicit correction as the source when it is newer than the accepted snapshot", () => {
    const proposal = buildContinuityRepairProposal(source({
      stateEdits: [{ id: "55555555-5555-4555-8555-555555555555", revision: 6, effectiveTurnNumber: 2, snapshot: { canonicalFacts: [{ id: "44444444-4444-4444-8444-444444444444", content: "The lighthouse key is moon glass." }] } }]
    }));
    expect(proposal.proposals[0]).toMatchObject({ proposedValue: "The lighthouse key is moon glass.", source: { kind: "state_edit", revision: 6 } });
  });

  it("keeps a stale artifact guarded at the base revision and has no apply mode", () => {
    const proposal = buildContinuityRepairProposal(source());
    expect(proposal.revisionGuard).toMatchObject({ campaignId, expectedRevision: 7, expectedTurnNumber: 3, baseTurnNumber: 3 });
    expect(JSON.stringify(proposal)).not.toMatch(/applyMode|automaticApply/i);
  });

  it("rejects a later state or narration correction revision before a reviewer could apply a proposal", () => {
    const proposal = buildContinuityRepairProposal(source());
    expect(proposalRevisionIsStale(proposal, { stateRevision: 8, narrationCorrectionRevisions: [{ turnId: "33333333-3333-4333-8333-333333333333", correctionRevision: 1 }] })).toBe(true);
    expect(proposalRevisionIsStale(proposal, { stateRevision: 7, narrationCorrectionRevisions: [{ turnId: "33333333-3333-4333-8333-333333333333", correctionRevision: 2 }] })).toBe(true);
    expect(proposalRevisionIsStale(proposal, { stateRevision: 7, narrationCorrectionRevisions: [{ turnId: "33333333-3333-4333-8333-333333333333", correctionRevision: 1 }] })).toBe(false);
  });
});
