import { describe, expect, it } from "vitest";
import { buildContinuityReviewInput, validateContinuityReview } from "../../packages/story-engine/src/continuity-review.js";
import { sha256, stableStringify } from "../../packages/domain/src/text.js";
import { storyTurnOutputSchema } from "../../packages/contracts/src/story-prompt.js";
const draft = storyTurnOutputSchema.parse({ narration: "Mira waits at the quay.", choices: ["Wait", "Look", "Listen", "Leave"], custom_action_suggestion: "Wait", image_prompt: "A quiet quay.", continuity_summary: "Mira waits at the quay.", open_threads: [], canonical_facts: [], canonical_fact_updates: [], superseded_facts: [], tracker_updates: [], scratchpad: "private reasoning" });
const source = { id: sha256("source"), content: "Mira is at the lighthouse.", required: true, role: "current_continuity" };
const build = (changes = {}) => buildContinuityReviewInput({ evidence: [source], requiredEvidenceIds: [source.id], direction: "Wait.", draft, ...changes });
const pass = { version: "story-continuity-review-v1", verdict: "pass", findings: [] };
const conflict = (basis: unknown, output = { path: "/narration", start: 0, end: draft.narration.length, quote: draft.narration }) => ({ version: "story-continuity-review-v1", verdict: "conflict", findings: [{ kind: "contradiction", category: "location", severity: "contradiction", basis, output, explanation: "The supplied current location conflicts with this passage." }] });
describe("evidence-grounded continuity review", () => {
  it("binds the full draft but projects only classified fiction fields", () => {
    const input = build();
    expect(input.draft).not.toHaveProperty("scratchpad");
    expect(JSON.stringify(input)).not.toContain("private reasoning");
    expect(input.draftHash).toBe(sha256(stableStringify(draft)));
    expect(input.excluded.scratchpad).toBe(1);
    expect(input.draft.choices).toEqual(draft.choices);
  });
  it.each(["wrong_name", "relationship", "chronology", "object_state", "requested_retcon"])("accepts exact conflict evidence addressability for %s without claiming model precision", () => {
    const input = build();
    expect(validateContinuityReview(input, conflict({ kind: "source", evidenceId: source.id, quote: source.content })).verdict).toBe("conflict");
  });
  it("turns vanished source, bad quote, bad offsets, invented field or draft namespace into uncertainty", () => {
    const input = build();
    for (const basis of [{ kind: "source", evidenceId: "f".repeat(64), quote: source.content }, { kind: "source", evidenceId: source.id, quote: "invented" }, { kind: "candidate", draftHash: "f".repeat(64), location: { path: "/narration", start: 0, end: 4, quote: "Mira" } }]) {
      expect(validateContinuityReview(input, conflict(basis)).verdict).toBe("uncertain");
    }
    expect(validateContinuityReview(input, conflict({ kind: "source", evidenceId: source.id, quote: source.content }, { path: "/scratchpad", start: 0, end: 4, quote: "Mira" })).verdict).toBe("uncertain");
  });
  it("accepts scoped pass with deliberately unselected history but rejects missing required evidence", () => {
    expect(validateContinuityReview(build(), pass).verdict).toBe("pass");
    expect(validateContinuityReview(build({ requiredEvidenceIds: [source.id, "f".repeat(64)] }), pass).verdict).toBe("uncertain");
    expect(validateContinuityReview(build({ evidence: [] }), pass).verdict).toBe("uncertain");
  });
  it("allows honest array omission warnings without inventing an absent quotation", () => {
    const review = { ...pass, findings: [{ kind: "omission", category: "thread_loss", severity: "warning", expectedEvidenceIds: [source.id], outputPath: "/open_threads", explanation: "The unresolved thread may have been omitted." }] };
    expect(validateContinuityReview(build(), review)).toMatchObject({ verdict: "pass", findings: [{ kind: "omission" }] });
    expect(validateContinuityReview(build(), { ...review, verdict: "conflict" }).verdict).toBe("uncertain");
  });
  it("addresses replacement summaries and canonical updates in the provisional candidate namespace", () => {
    const input = build({ draft: { ...draft, continuity_summary: "Mira has departed.", canonical_fact_updates: [{ content: "Mira has departed.", supersedes_fact_ids: [] }] } });
    const basis = { kind: "candidate", draftHash: input.draftHash, location: { path: "/narration", start: 0, end: draft.narration.length, quote: draft.narration } };
    for (const path of ["/continuity_summary", "/canonical_fact_updates/0/content"]) {
      expect(validateContinuityReview(input, conflict(basis, { path, start: 0, end: 18, quote: "Mira has departed." })).verdict).toBe("conflict");
    }
  });
  it("does not interpret deliberate empty correction or fictional evolution as missing input", () => {
    for (const narration of ["Mira walks to the quay.", "In a dream, Mira returns to the quay.", "Years earlier, Mira waited at the quay.", 'Vale lied, saying "Mira is at the quay."']) {
      expect(validateContinuityReview(build({ evidence: [{ ...source, content: "" }], draft: { ...draft, narration, continuity_summary: "", open_threads: [] } }), pass).verdict).toBe("pass");
    }
  });
  it("detects changed projection after binding", () => {
    const input = build();
    expect(validateContinuityReview({ ...input, draft: { ...input.draft, narration: "Changed." } }, pass).verdict).toBe("uncertain");
  });
});
