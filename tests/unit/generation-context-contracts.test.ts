import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as context from "../../packages/application/src/memory/generation-context.js";
import { campaignRuntimeStateContentSchema, characterProfileSchema, sha256Hex } from "../../packages/contracts/src/index.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const hash = "a".repeat(64);
const baseIdentity = {
  operationKind: "append", expectedTurnNumber: 2, baseTurnNumber: 1,
  campaignActiveTurnNumber: 1, campaignStateRevision: 3, stateEditRevision: 2,
  narrationCorrectionRevision: null, baseTurnId: uuid, stateFingerprint: hash, narrationFingerprint: hash
};
const continuity = campaignRuntimeStateContentSchema.parse({
  continuitySummary: "", scratchpad: "", canonicalFacts: [], openThreads: [],
  trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: []
});
const authority = {
  rules: ["The tide follows the moon."], worldCanon: { rules: "The tide follows the moon." },
  selectedCharacterId: null, currentContinuity: continuity, scratchpad: "", openThreads: [],
  canonicalFacts: [], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [],
  latestTurn: { action: "Wait.", narration: "The tide falls." }
};
const characterAuthority = { source: "campaign_profile", name: "Rowan", characterText: "", profile: characterProfileSchema.parse({ story: { keyRelationships: "Keeps watch with Mira." } }) };

describe("canonical private generation context", () => {
  it("requires explicit cast fences in v4 and leaves frozen v3 identities unchanged", () => {
    const v3 = { ...baseIdentity, version: "generation-base-v3", characterProfileRevision: 0, characterProfileFingerprint: hash };
    const v4 = { ...v3, version: "generation-base-v4", castRevision: 4, castTimelineRevision: 2,
      castFingerprint: hash, castCoverageStartTurn: 1, castTrackedThroughTurn: 1 };
    expect(context.readGenerationBaseIdentity(v4)).toEqual(v4);
    expect(context.readGenerationBaseIdentity(v3)).toEqual(v3);
    expect(context.isGenerationBaseIdentityV3(context.readGenerationBaseIdentity(v4))).toBe(false);
    for (const field of ["castRevision", "castTimelineRevision", "castFingerprint", "castCoverageStartTurn", "castTrackedThroughTurn"]) {
      const incomplete: Record<string, unknown> = { ...v4 }; delete incomplete[field];
      expect(context.generationBaseIdentitySchema.safeParse(incomplete).success).toBe(false);
    }
    expect(context.generationBaseIdentityV3Schema.safeParse(v4).success).toBe(false);
  });
  it("requires the captured cast to match the v4 base and rejects adding cast authority to old jobs", () => {
    const castSnapshot = { version: "cast-context-v1", scope: { ownerUserId: uuid, campaignId: uuid }, worldVersionId: uuid,
      revision: 2, boundary: { turnNumber: 1, timelineRevision: 0 }, characters: [], details: [],
      coverageStartTurn: 1, trackedThroughTurn: 1, discoveryStatus: "current" };
    const v4 = { ...baseIdentity, version: "generation-base-v4", characterProfileRevision: 0, characterProfileFingerprint: hash,
      castRevision: 2, castTimelineRevision: 0, castFingerprint: sha256Hex(context.canonicalEvidenceJson(castSnapshot)),
      castCoverageStartTurn: 1, castTrackedThroughTurn: 1 };
    const value = { baseIdentity: v4, authority: { ...authority, characterAuthority, castSnapshot }, candidates: [] };
    expect(context.memoryGenerationAuthorityContextSchema.parse(value)).toEqual(value);
    expect(context.memoryGenerationAuthorityContextSchema.safeParse({ ...value, authority }).success).toBe(false);
    expect(context.memoryGenerationAuthorityContextSchema.safeParse({ ...value, authority: { ...value.authority,
      castSnapshot: { ...castSnapshot, revision: 3 } } }).success).toBe(false);
    expect(context.memoryGenerationAuthorityContextSchema.safeParse({ ...value, baseIdentity }).success).toBe(false);
  });
  it("retains the complete baseline fields and explicitly reads legacy identities", () => {
    const baseline = context.memoryGenerationAuthorityContextSchema.parse(JSON.parse(JSON.stringify({ authority, candidates: [], baseIdentity })));
    expect(baseline).toEqual({ authority, candidates: [], baseIdentity });
    expect(baseline).not.toHaveProperty("chronicleSelectionDiagnostics");
    expect(context.readLegacyGenerationBaseIdentity(baseIdentity)).toEqual(baseIdentity);
    expect(context.generationContextSnapshotSchema.safeParse({ version: "current-continuity-v3", ownerUserId: uuid, campaignId: uuid, worldVersionId: uuid, baseIdentity, protectedAuthority: authority, candidates: [] }).success).toBe(false);
  });

  it("retains only content-free private v5 selection diagnostics", () => {
    const diagnostics = {
      maximumParents: 64, maximumParentsPerTurn: 8, maximumParentTokens: 48_000,
      selectedParentTokens: 12_400, tokenLimitParentsRemoved: 3,
      candidatePoolLimit: 2_000, candidatePoolCandidatesRemoved: 1,
      stopReason: "candidate_pool_limit" as const
    };
    expect(context.generationChronicleSelectionDiagnosticsSchema.parse(diagnostics)).toEqual(diagnostics);
    expect(context.generationChronicleSelectionDiagnosticsSchema.safeParse({ ...diagnostics, candidateId: uuid }).success).toBe(false);
    const value = { authority, candidates: [], baseIdentity, chronicleSelectionDiagnostics: diagnostics };
    expect(context.memoryGenerationAuthorityContextSchema.parse(value)).toEqual(value);
  });

  it("accepts only the fixed content-free v5 history coverage diagnostic vocabulary", () => {
    const diagnostic = {
      version: "history-coverage-diagnostics-v1",
      limits: { contextTokens: 32_000, writerInputTokens: 31_000, reviewerInputTokens: 30_000,
        recentWindowTurns: 11, candidatePoolLimit: 2_000, protectedFactMeasurements: 64 },
      candidates: { sourceCount: 6, selectedCount: 3, omittedCount: 3, selectedEstimateTokens: 1_240,
        serializerGuardExcludedCount: 1, batchedTrialCount: 2, candidatePoolCandidatesRemoved: 1,
        stopReason: "candidate_pool_limit", fallbackReason: "none", duplicateExcluded: 2,
        sourceValidationFailureCount: 1, sourceValidationExcluded: 1 },
      ledger: { capturedCount: 5, sentCount: 2, omittedCount: 3, coveredByRecentCount: 1,
        sourceExcludedCount: 4, unreadThroughTurn: null, budgetTokens: 2_000, measurementTrialCount: null },
      facts: { sourceCount: 4, sentCount: 2, omittedCount: 2, sourceOmittedCount: 3,
        budgetTokens: 1_200, measurementLimit: 64, measurementLimitHit: true, unexaminedCount: 1,
        sourceCoverage: { candidateRows: 7, sourceBytes: 400_000, sourceLimitReached: false,
          oversizedCandidateCount: 1, futureSourceCount: 1, withheldCandidateCount: 2 } },
      recents: { capturedCount: 3, sentCount: 2, targetCount: 3, firstGapReason: null },
      finalTokens: { context: 3_000, writerRequest: 4_000, reviewerRequest: 2_000 }
    } as const;
    expect(context.historyCoverageDiagnosticsSchema.parse(diagnostic)).toEqual(diagnostic);
    for (const hostile of [
      { ...diagnostic, arbitrary: "no" },
      { ...diagnostic, candidates: { ...diagnostic.candidates, candidateId: uuid } },
      { ...diagnostic, candidates: { ...diagnostic.candidates, omittedCount: undefined } },
      { ...diagnostic, ledger: { ...diagnostic.ledger, direction: "PRIVATE_DIRECTION_CANARY" } },
      { ...diagnostic, facts: { ...diagnostic.facts, error: "PRIVATE_ERROR_CANARY" } },
      { ...diagnostic, candidates: { ...diagnostic.candidates, stopReason: "unbounded" } }
    ]) expect(context.historyCoverageDiagnosticsSchema.safeParse(hostile).success).toBe(false);
  });

  it("accepts only complete protected-fact authority records and an explicit omission count", () => {
    const protectedFact = { id: uuid, turnNumber: 0, content: "The corrected harbor remains sealed." };
    const value = { authority: { ...authority, protectedFacts: [protectedFact], protectedFactsOmitted: 2,
      protectedFactsCoverage: { candidateRows: 3, sourceBytes: 400_292, sourceLimitReached: false,
        oversizedCandidateCount: 1, futureSourceCount: 1, withheldCandidateCount: 2 } }, candidates: [], baseIdentity };
    expect(context.memoryGenerationAuthorityContextSchema.parse(value)).toEqual(value);
    expect(context.memoryGenerationAuthorityContextSchema.safeParse({ ...value, authority: { ...value.authority,
      protectedFacts: [{ ...protectedFact, content: "" }] } }).success).toBe(false);
  });

  it("requires every old dependency and the new profile fence in v3", () => {
    const newBase = { ...baseIdentity, version: "generation-base-v3", characterProfileRevision: 0, characterProfileFingerprint: hash };
    expect(context.generationBaseIdentityV3Schema.parse(newBase)).toEqual(newBase);
    expect(context.readGenerationBaseIdentity(newBase)).toEqual(newBase);
    for (const key of Object.keys(newBase)) {
      const missing = { ...newBase };
      delete missing[key as keyof typeof missing];
      expect(context.generationBaseIdentityV3Schema.safeParse(missing).success, key).toBe(false);
    }
    expect(() => context.readLegacyGenerationBaseIdentity(newBase)).toThrow();
  });

  it("keeps historical recent-window bytes absent while admitting only the frozen eleven-turn identity", () => {
    const v3 = { ...baseIdentity, version: "generation-base-v3" as const, characterProfileRevision: 0, characterProfileFingerprint: hash };
    const v4 = { ...v3, version: "generation-base-v4" as const, castRevision: 4, castTimelineRevision: 2,
      castFingerprint: hash, castCoverageStartTurn: 1, castTrackedThroughTurn: 1 };
    expect(context.generationBaseIdentityV3Schema.parse(v3)).toEqual(v3);
    expect(context.generationBaseIdentityV4Schema.parse(v4)).toEqual(v4);
    expect(context.generationBaseIdentityV3Schema.parse(v3)).not.toHaveProperty("recentWindowTurns");
    for (const identity of [v3, v4]) {
      const captured = { ...identity, recentWindowTurns: 11, recentWindowFingerprint: hash };
      expect(context.generationBaseIdentitySchema.parse(captured)).toEqual(captured);
      expect(context.generationBaseIdentitySchema.safeParse({ ...identity, recentWindowTurns: 11 }).success).toBe(false);
      expect(context.generationBaseIdentitySchema.safeParse({ ...identity, recentWindowTurns: 10, recentWindowFingerprint: hash }).success).toBe(false);
    }
  });
});

describe("source-bound evidence manifest", () => {
  const sourceDocument = continuity;
  const input = { source: { kind: "state_edit", id: uuid, revision: "2", turnNumber: 1 }, sourcePath: "/openThreads", semanticRole: "corrected_state", normalizationVersion: "fiction-safe-json-v1", form: "complete", spans: [], canonicalFactId: null, rank: 0, selectionGroup: "protected" } as const;
  function evidence() { return context.createStoryEvidence(input, sourceDocument); }
  function manifest() {
    const entry = evidence();
    const body = { version: "generation-evidence-v1" as const, attemptId: uuid, producingRequestHash: hash, entries: [entry], requiredReviewEvidenceIds: [entry.id] };
    return { ...body, manifestHash: context.generationEvidenceManifestHash(body) };
  }

  it("serializes intentional empty correction values using actual runtime schema paths", () => {
    const entry = evidence();
    expect(entry.content).toBe("[]");
    expect(context.storyEvidenceSchema.parse(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
    expect(context.generationEvidenceManifestSchema.parse(JSON.parse(JSON.stringify(manifest())))).toEqual(manifest());
    expect(context.generationContextSnapshotSchema.parse({ version: "current-continuity-v3", ownerUserId: uuid, campaignId: uuid, worldVersionId: uuid, baseIdentity: { ...baseIdentity, version: "generation-base-v3", characterProfileRevision: 0, characterProfileFingerprint: hash }, protectedAuthority: { ...authority, characterAuthority }, candidates: [entry], manifest: manifest() }).protectedAuthority.currentContinuity.openThreads).toEqual([]);
  });

  it("keeps complete character authority on the common seam but requires capture for v3", () => {
    const snapshot = { version: "current-continuity-v3", ownerUserId: uuid, campaignId: uuid, worldVersionId: uuid, baseIdentity: { ...baseIdentity, version: "generation-base-v3", characterProfileRevision: 0, characterProfileFingerprint: hash }, protectedAuthority: { ...authority, characterAuthority }, candidates: [], manifest: manifest() };
    expect(context.generationContextSnapshotSchema.parse(snapshot).protectedAuthority.characterAuthority?.profile?.story.keyRelationships).toBe("Keeps watch with Mira.");
    expect(context.generationContextSnapshotSchema.safeParse({ ...snapshot, protectedAuthority: authority }).success).toBe(false);
  });

  it("verifies serialized evidence against its exact source before accepting source-dependent claims", () => {
    const entry = evidence();
    expect(context.readStoryEvidenceFromSource(JSON.parse(JSON.stringify(entry)), sourceDocument)).toEqual(entry);
    expect(() => context.readStoryEvidenceFromSource({ ...entry, content: "{}" }, sourceDocument)).toThrow();
    expect(() => context.readStoryEvidenceFromSource(entry, { ...sourceDocument, openThreads: ["Changed"] })).toThrow();
  });

  it("binds identities to source changes, paths, roles, revisions and spans, not rank or key order", () => {
    const entry = evidence();
    expect(context.createStoryEvidence(input, Object.fromEntries(Object.entries(continuity).reverse())).id).toBe(entry.id);
    expect(context.createStoryEvidence({ ...input, rank: 9 }, continuity).id).toBe(entry.id);
    for (const changed of [
      context.createStoryEvidence(input, { ...continuity, openThreads: ["Find the quay."] }),
      context.createStoryEvidence({ ...input, sourcePath: "/scratchpad" }, continuity),
      context.createStoryEvidence({ ...input, source: { ...input.source, revision: "3" } }, continuity),
      context.createStoryEvidence({ ...input, semanticRole: "current_continuity" }, continuity)
    ]) expect(changed.id).not.toBe(entry.id);
    const narration = { narration: "A bell rings. The tide falls." };
    const excerpt = context.createStoryEvidence({ ...input, source: { ...input.source, kind: "turn" }, sourcePath: "/narration", semanticRole: "accepted_narration", selectionGroup: "retrieved", form: "excerpt", spans: [{ start: 0, end: 13 }, { start: 14, end: 29 }] }, narration);
    expect(excerpt.content).toBe("A bell rings.\n[…]\nThe tide falls.");
    expect(context.storyEvidenceSchema.safeParse({ ...excerpt, spans: [{ start: 14, end: 29 }, { start: 0, end: 13 }] }).success).toBe(false);
    expect(context.storyEvidenceSchema.safeParse({ ...excerpt, spans: [{ start: 0, end: 30 }] }).success).toBe(false);
  });

  it("rejects invalid pointers, inherited properties, excerpts of facts and tampered identity", () => {
    for (const sourcePath of ["/missing", "/openThreads/0", "/__proto__", "/scratchpad/~2", "../scratchpad"]) {
      expect(() => context.createStoryEvidence({ ...input, sourcePath }, continuity)).toThrow();
    }
    expect(context.storyEvidenceSchema.safeParse({ ...evidence(), canonicalFactId: uuid }).success).toBe(false);
    expect(context.storyEvidenceSchema.safeParse({ ...evidence(), id: "forged" }).success).toBe(false);
  });

  it("never excerpts a protected field even under an excerpt-capable policy", () => {
    expect(() => context.createStoryEvidence({ ...input, sourcePath: "/continuitySummary", form: "excerpt", spans: [{ start: 0, end: 4 }] }, { ...continuity, continuitySummary: "The tide falls." })).toThrow();
  });

  it("hashes the manifest without its hash and rejects duplicate IDs, unknown requirements and tampering", () => {
    const value = manifest();
    expect(context.generationEvidenceManifestHash(value)).toBe(value.manifestHash);
    for (const changed of [{ ...value, entries: [evidence(), evidence()] }, { ...value, requiredReviewEvidenceIds: ["absent"] }, { ...value, requiredReviewEvidenceIds: [evidence().id, evidence().id] }, { ...value, producingRequestHash: "b".repeat(64) }]) {
      expect(context.generationEvidenceManifestSchema.safeParse(changed).success).toBe(false);
    }
    const second = context.createStoryEvidence({ ...input, sourcePath: "/scratchpad" }, continuity);
    const reordered = { ...value, entries: [second, evidence()] };
    expect(context.generationEvidenceManifestHash(reordered)).not.toBe(context.generationEvidenceManifestHash({ ...reordered, entries: [...reordered.entries].reverse() }));
    expect(reordered.entries.map((entry) => entry.id)).toEqual([second.id, evidence().id]);
  });
});

it.each(["", "abc", "é 🌊", "\ud800", "\udc00", "a\ud800b"])("hashes UTF-8 like Node without an async boundary: %j", (value) => {
  expect(sha256Hex(value)).toBe(createHash("sha256").update(value).digest("hex"));
});
