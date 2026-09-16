import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sentCanonicalFactIds } from "../../services/runtime/src/generation-executor-adapter.js";
import {
  storyContinuityCandidateOutput,
  storyContinuitySourceOracle
} from "../fixtures/story-continuity/scenarios.js";

describe("story continuity baseline fixtures", () => {
  it("keeps F1-F5 source oracles separate from deterministic candidate output", () => {
    const sources = [
      storyContinuitySourceOracle.f1WorldSiblingLore.entitySnippet,
      storyContinuitySourceOracle.f1WorldSiblingLore.relationshipSnippet,
      storyContinuitySourceOracle.f2EditedCharacter.snippet,
      storyContinuitySourceOracle.f3StructuredOnlyFact.snippet,
      storyContinuitySourceOracle.f4LateDirectionBeat.actionSnippet,
      storyContinuitySourceOracle.f4LateDirectionBeat.candidateSnippet,
      storyContinuitySourceOracle.f5OldExactFact.snippet
    ];
    const candidate = JSON.stringify(storyContinuityCandidateOutput);

    expect(new Set(sources)).toHaveLength(sources.length);
    expect(sources.every((source) => !candidate.includes(source))).toBe(true);
  });

  it("uses only synthetic stable identifiers for positive and negative provenance", () => {
    const ids = [
      storyContinuitySourceOracle.f1WorldSiblingLore.id,
      storyContinuitySourceOracle.f2EditedCharacter.id,
      storyContinuitySourceOracle.f3StructuredOnlyFact.id,
      storyContinuitySourceOracle.f4LateDirectionBeat.id,
      storyContinuitySourceOracle.f5OldExactFact.id,
      storyContinuitySourceOracle.correctedNarration.id,
      storyContinuitySourceOracle.intentionalEmptyCorrection.id,
      storyContinuitySourceOracle.negative.wrongOwnerId,
      storyContinuitySourceOracle.negative.wrongWorldVersionId,
      storyContinuitySourceOracle.negative.rejectedDraftFactId,
      storyContinuitySourceOracle.negative.omittedFactId
    ];

    expect(new Set(ids)).toHaveLength(ids.length);
    expect(ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u.test(id))).toBe(true);
  });

  it("makes a raw payload hash observable without placing payload text in the oracle", () => {
    const body = JSON.stringify({ sourceIds: [storyContinuitySourceOracle.f3StructuredOnlyFact.id] });
    const payloadHash = createHash("sha256").update(body).digest("hex");

    expect(payloadHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(storyContinuitySourceOracle)).not.toContain(body);
  });

  it("preserves an intentionally empty correction as complete source authority", () => {
    expect(storyContinuitySourceOracle.intentionalEmptyCorrection).toMatchObject({
      continuitySummary: "",
      openThreads: [],
      canonicalFacts: [],
      scratchpad: ""
    });
  });

  it("excludes a rejected-draft UUID from the provider body authority sent to commit", () => {
    const request = JSON.stringify({
      input: `${JSON.stringify({ authoritative_context: {
        currentContinuity: { canonicalFacts: [{
          id: storyContinuitySourceOracle.f3StructuredOnlyFact.id,
          content: storyContinuitySourceOracle.f3StructuredOnlyFact.snippet
        }] }
      } })}\n\nREJECTED RESPONSE TO REWRITE:\n${JSON.stringify({
        canonical_fact_updates: [{ supersedes_fact_ids: [storyContinuitySourceOracle.negative.rejectedDraftFactId] }]
      })}\n\nRECOVERY REQUIREMENT:\nGenerate from protected authority.`
    });

    expect(sentCanonicalFactIds(request)).toEqual([storyContinuitySourceOracle.f3StructuredOnlyFact.id]);
  });

  it("excludes an omitted canonical-fact UUID from untyped provider history sent to commit", () => {
    const request = JSON.stringify({
      messages: [{
        role: "user",
        content: JSON.stringify({ authoritative_context: {
          currentContinuity: { canonicalFacts: [{
            id: storyContinuitySourceOracle.f3StructuredOnlyFact.id,
            content: storyContinuitySourceOracle.f3StructuredOnlyFact.snippet
          }] },
          chronicle: [{
            id: "turn-history",
            kind: "turn_fiction",
            content: `Untrusted history names ${storyContinuitySourceOracle.negative.omittedFactId}.`
          }]
        } })
      }]
    });

    expect(sentCanonicalFactIds(request)).toEqual([storyContinuitySourceOracle.f3StructuredOnlyFact.id]);
  });
});
