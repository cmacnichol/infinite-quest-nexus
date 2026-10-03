import { CONTINUITY_REVIEW_PROMPT_CATALOG, PROMPT_TEMPLATE_CATALOG } from "../../packages/contracts/src/prompt-library.js";
import { prepareContinuityReview, estimateContinuityReviewPlanningTokens } from "../../services/runtime/src/story-continuity-review-adapter.js";
import { storyTurnOutputSchema } from "../../packages/contracts/src/story-prompt.js";
import { describe, expect, it } from "vitest";
import { planGenerationPromptContext } from "../../services/runtime/src/generation-context-planner.js";
import { storyMemoryPolicySchema, defaultStoryMemoryPolicy } from "../../packages/contracts/src/story-memory-policy.js";
import { HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION } from "../../packages/contracts/src/story-prompt.js";
import { estimateStoryTokens, estimatedInputSafetyAllowanceTokens, serializeProviderRequest } from "../../packages/story-engine/src/index.js";
import { getProviderOutputSchema } from "../../packages/story-engine/src/provider-output-schema.js";
import { sha256 } from "../../packages/domain/src/index.js";
import { bindManifestToProducingRequest } from "../../packages/application/src/memory/continuity-review-checkpoint.js";
import { castGenerationSnapshotFingerprint } from "../../packages/contracts/src/campaign-cast-context.js";
import { sentCanonicalFactIds } from "../../services/runtime/src/generation-executor-adapter.js";
import { historyCoverageDiagnosticsSchema, type GenerationContextCandidate } from "../../packages/application/src/memory/generation-context.js";
import type { MemoryGenerationAuthorityContext } from "../../packages/application/src/index.js";
  function plannerContext(
    characterAuthority: unknown,
    version: "legacy" | "v3" = "v3",
    canonicalFacts: MemoryGenerationAuthorityContext["authority"]["currentContinuity"]["canonicalFacts"] = [],
    candidates: readonly GenerationContextCandidate[] = []
  ): MemoryGenerationAuthorityContext {
    const baseIdentity = version === "v3"
      ? { version: "generation-base-v3", operationKind: "append", expectedTurnNumber: 1, baseTurnNumber: 0, campaignActiveTurnNumber: 0, campaignStateRevision: 1, stateEditRevision: null, narrationCorrectionRevision: null, baseTurnId: null, stateFingerprint: "a".repeat(64), narrationFingerprint: null, characterProfileRevision: 1, characterProfileFingerprint: "b".repeat(64) }
      : { operationKind: "append", expectedTurnNumber: 1, baseTurnNumber: 0, campaignActiveTurnNumber: 0, campaignStateRevision: 1, stateEditRevision: null, narrationCorrectionRevision: null, baseTurnId: null, stateFingerprint: "a".repeat(64), narrationFingerprint: null };
    return {
      authority: {
        rules: ["World rule."], worldCanon: { title: "World" }, selectedCharacterId: "mira",
        ...(version === "v3" ? { characterAuthority } : {}),
        currentContinuity: { continuitySummary: "", scratchpad: "", canonicalFacts, openThreads: [], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [] },
        scratchpad: "", openThreads: [], canonicalFacts: [], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [], latestTurn: null
      }, candidates, baseIdentity
    } as MemoryGenerationAuthorityContext;
  }

  function plannerProvider() {
    return { id: "provider", providerType: "openai_compatible", model: "model", contextWindowTokens: 100_000, maxOutputTokens: 100, temperature: 0, requestTimeoutMs: 1_000, configuration: {} } as never;
  }

function recentContext() {
  const context: any = plannerContext(null);
  context.baseIdentity.baseTurnNumber = 4;
  context.baseIdentity.baseTurnId = "latest";
  context.authority.latestTurn = { action: "Wait", narration: "Latest scene", inputMode: "action" };
  context.recentTurns = [2, 3].map((n) => ({ turnId: `turn-${n}`, turnNumber: n, inputMode: "scene", action: `Intent ${n}`, narration: `Outcome ${n}`, narrationCorrectionRevision: 0, sourceHash: sha256(`source-${n}`) }));
  return context;
}
function run(context: any, limit = 32_000) {
  return planGenerationPromptContext(context, plannerProvider(), "System", "Continue", [], { profile: "brief", minWords: 100, maxWords: 120 }, "scene", limit, limit - 100, "attempt", "story_memory", defaultStoryMemoryPolicy("r2"));
}
describe("layered generation context planner", () => {
  it("serializes v5 layers in stable wire order through the provider body", () => {
    const context: any = recentContext();
    context.baseIdentity.baseTurnNumber = 4;
    context.authority.latestTurn = { action: "Prior action", narration: "Current scene marker", inputMode: "scene" };
    context.authority.characterAuthority = { name: "Mira", profile: { identity: { aliases: [] } } };
    context.authority.storyLedger = { entries: [
      { turnId: "ledger-1", turnNumber: 1, inputMode: "action", direction: "Older intent marker" },
      { turnId: "ledger-2", turnNumber: 2, inputMode: "action", direction: "Newer intent marker" }
    ], omittedThroughTurn: null };
    const castId = "33333333-3333-4333-8333-333333333333";
    const castSnapshot = { version: "cast-context-v1", scope: { ownerUserId: castId, campaignId: castId }, worldVersionId: castId,
      revision: 1, boundary: { turnNumber: 4, timelineRevision: 0 }, coverageStartTurn: null, trackedThroughTurn: null, discoveryStatus: "pending",
      characters: [{ id: castId, name: "Mara", aliases: ["The Watcher"], origin: { kind: "manual" }, profile: {},
        pinned: true, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 0 }],
      details: [{ characterId: castId, observations: [], overrides: [{ field: "appearance.description", value: "green eyes",
        evidence: { kind: "user", editId: castId, effectiveTurnNumber: 0 } }] }] };
    context.authority.castSnapshot = castSnapshot;
    Object.assign(context.baseIdentity, { version: "generation-base-v4", castRevision: 1, castTimelineRevision: 0,
      castFingerprint: castGenerationSnapshotFingerprint(castSnapshot), castCoverageStartTurn: null, castTrackedThroughTurn: null });
    context.authority.protectedFacts = [
      { id: "11111111-1111-4111-8111-111111111111", turnNumber: 1, content: "Older protected fact marker" },
      { id: "22222222-2222-4222-8222-222222222222", turnNumber: 2, content: "Newer protected fact marker" }
    ];
    context.authority.currentContinuity = { continuitySummary: "Continuity marker", scratchpad: "", canonicalFacts: [], openThreads: [], trackers: [] };
    context.authority.worldReferenceSource = { worldVersionId: "world-v1", worldContent: { entities: [], relationships: [] } };
    context.candidates = [
      { id: "chronicle-1", turnId: "chronicle-turn-1", ordinal: 1, kind: "turn_fiction", content: "Older Chronicle marker", tokenEstimate: 5, rank: 1 },
      { id: "chronicle-2", turnId: "chronicle-turn-2", ordinal: 2, kind: "turn_fiction", content: "Newer Chronicle marker", tokenEstimate: 5, rank: 2 }
    ];
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Visit The Watcher", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 100_000, 99_900, "attempt", "story_memory",
      defaultStoryMemoryPolicy("r2"), undefined, undefined, undefined, HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    const body = JSON.parse(serializeProviderRequest(plannerProvider(), { systemPrompt: "System", input: result.storyInput }).body);
    const userContent = JSON.parse(body.messages.find((message: { role: string }) => message.role === "user").content);
    const sent = userContent.authoritative_context;

    expect(Object.keys(sent)).toEqual([
      "authoritativeRules", "worldCanon", "selectedCharacterId", "selectedCharacterAuthority", "cast", "worldReferences",
      "currentContinuity", "protectedFacts", "protectedFactsOmitted", "storyLedger", "chronicle", "recentTurns", "currentScene"
    ]);
    expect(sent.storyLedger.entries.map((entry: { turnNumber: number }) => entry.turnNumber)).toEqual([1, 2]);
    expect(sent.protectedFacts.map((fact: { turnNumber: number }) => fact.turnNumber)).toEqual([1, 2]);
    expect(sent.chronicle.map((entry: { ordinal: number }) => entry.ordinal)).toEqual([1, 2]);
    expect(sent.recentTurns.map((entry: { turnNumber: number }) => entry.turnNumber)).toEqual([2, 3]);
    expect(sent.currentScene.narration).toBe("Current scene marker");
    expect(userContent.current_turn_input).toEqual({ mode: "scene", text: "Visit The Watcher" });
    expect(body.messages.findIndex((message: { role: string }) => message.role === "user")).toBeGreaterThan(0);
  });

  it("keeps empty optional v5 layers before the final scene and current input", () => {
    const context: any = plannerContext(null);
    context.authority.storyLedger = { entries: [], omittedThroughTurn: null };
    context.authority.protectedFacts = [];
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Empty-layer input", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 100_000, 99_900, "attempt", "story_memory",
      defaultStoryMemoryPolicy("r2"), undefined, undefined, undefined, HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    const body = JSON.parse(serializeProviderRequest(plannerProvider(), { systemPrompt: "System", input: result.storyInput }).body);
    const userContent = JSON.parse(body.messages.find((message: { role: string }) => message.role === "user").content);
    const sent = userContent.authoritative_context;

    expect(sent.protectedFacts).toEqual([]);
    expect(sent.storyLedger.entries).toEqual([]);
    expect(sent.chronicle).toEqual([]);
    expect(sent.recentTurns).toEqual([]);
    expect(Object.keys(sent).at(-1)).toBe("currentScene");
    expect(userContent.current_turn_input).toEqual({ mode: "scene", text: "Empty-layer input" });
  });

  it("projects v5 history coverage from final sent layers and separates validation failures from sent candidates", () => {
    const context: any = recentContext();
    context.authority.storyLedger = { version: "story-ledger-v1", omittedThroughTurn: 1,
      coverage: { unreadThroughTurn: 1, missingTurnCount: 1, filteredDirectionCount: 2, oversizedDirectionCount: 3, loadedRows: 6 },
      entries: [
        { turnId: "ledger-one", turnNumber: 1, inputMode: "action", direction: "Old private intent." },
        { turnId: "turn-2", turnNumber: 2, inputMode: "action", direction: "Duplicate recent intent." }
      ] };
    context.authority.protectedFacts = [{ id: "11111111-1111-4111-8111-111111111111", turnNumber: 1, content: "Complete private fact." }];
    context.authority.protectedFactsOmitted = 2;
    context.authority.protectedFactsCoverage = { candidateRows: 3, sourceBytes: 72, sourceLimitReached: false,
      oversizedCandidateCount: 0, futureSourceCount: 1, withheldCandidateCount: 1 };
    context.candidates = [{ id: "opaque-source-canary", turnId: "opaque-turn-canary", ordinal: 1, kind: "turn_fiction", content: "Private candidate evidence.", tokenEstimate: 7, rank: 1,
      sourceValidationFailed: true, narrativeSource: { normalizationVersion: "story-fiction-source-v1", sourceHash: "f".repeat(64), spans: [{ start: 0, end: 10 }] } }];
    context.chronicleSelectionDiagnostics = { candidatePoolLimit: 2_000, candidatePoolCandidatesRemoved: 4,
      selectedParentTokens: 12, stopReason: "candidate_pool_limit" };
    context.chronicleRetrieval = { fallbackCode: "chunk_index_not_ready" };
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Continue", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 32_000, 31_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r2"), excerptPolicy: "verified_spans_v1" }), undefined, undefined, undefined,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    const diagnostic = historyCoverageDiagnosticsSchema.parse((result.layerDiagnostics as any).history);

    expect(diagnostic).toMatchObject({
      limits: { contextTokens: 32_000, writerInputTokens: 31_900, candidatePoolLimit: 2_000, protectedFactMeasurements: null },
      candidates: { selectedCount: 1, selectedEstimateTokens: 7, candidatePoolCandidatesRemoved: 4,
        stopReason: "candidate_pool_limit", fallbackReason: "chunk_index_not_ready",
        sourceValidationFailureCount: 1, sourceValidationExcluded: 0 },
      ledger: { capturedCount: 2, sentCount: 1, omittedCount: 1, coveredByRecentCount: 1, sourceExcludedCount: 6 },
      facts: { sourceCount: 1, sentCount: 1, omittedCount: 0, sourceOmittedCount: 2,
        measurementLimit: null, measurementLimitHit: false, unexaminedCount: 0 },
      recents: { capturedCount: 2, sentCount: 2, targetCount: 3 },
      finalTokens: { context: result.contextPlan.contextTokens, writerRequest: result.contextPlan.requestTokens, reviewerRequest: null }
    });
    expect(result.sourceManifest!.entries.filter((entry) => entry.selectionGroup === "retrieved" && entry.source.id === "opaque-turn-canary")).toHaveLength(1);
    expect(JSON.stringify(diagnostic)).not.toMatch(/ledger-one|turn-2|Complete private fact|opaque-source-canary|opaque-turn-canary|Private/);
  });

  it("retains a retrieved fact omitted from protected allocation", () => {
    const context: any = recentContext();
    const olderFact = { id: "00000001-1111-4111-8111-111111111111", turnNumber: 1,
      content: "The sealed gate opens with the brass key." };
    context.authority.protectedFacts = [olderFact, ...Array.from({ length: 40 }, (_, index) => ({
      id: `${String(index + 2).padStart(8, "0")}-1111-4111-8111-111111111111`,
      turnNumber: index + 2,
      content: `Protected campaign detail ${index + 2}. ${"The keeper records the harbor tide. ".repeat(7)}`
    }))];
    context.candidates = [{ id: olderFact.id, turnId: "fact-turn-1", ordinal: 1, kind: "canonical_fact",
      content: olderFact.content, tokenEstimate: 12, rank: 0 }];
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Use the brass key at the gate", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 8_000, 7_900,
      "attempt", "story_memory", defaultStoryMemoryPolicy("r2"), undefined, undefined, undefined,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);

    expect(result.promptContext.protectedFacts?.some((fact) => fact.id === olderFact.id)).toBe(false);
    expect(result.promptContext.chronicle.some((candidate: { id: string }) => candidate.id === olderFact.id)).toBe(true);
    expect(result.storyInput.split(olderFact.content)).toHaveLength(2);
    expect(result.layerDiagnostics.omitted).toContainEqual({ id: `protected-fact:${olderFact.id}`, reason: "context_limit" });
    expect(result.layerDiagnostics.omitted).not.toContainEqual({ id: olderFact.id, reason: "duplicate_source" });
    const manifestFactIds = result.sourceManifest!.entries.flatMap((entry) => entry.canonicalFactId ? [entry.canonicalFactId] : []).sort();
    expect(sentCanonicalFactIds(result.contextPlan.serializedRequest).sort()).toEqual(manifestFactIds);
  });

  it("retains retrieved evidence when an older fact is absent from the protected source pool", () => {
    const fact = { id: "00000001-1111-4111-8111-111111111111", turnNumber: 1,
      content: "The sealed gate opens with the brass key." };
    const otherProtectedFacts = Array.from({ length: 40 }, (_, index) => ({
      id: `${String(index + 2).padStart(8, "0")}-1111-4111-8111-111111111111`,
      turnNumber: index + 2,
      content: `Protected campaign detail ${index + 2}. ${"The keeper records the harbor tide. ".repeat(7)}`
    }));
    const results = [otherProtectedFacts, [fact, ...otherProtectedFacts]].map((protectedFacts) => {
      const context: any = recentContext();
      context.authority.protectedFacts = protectedFacts;
      context.candidates = [{ id: fact.id, turnId: "fact-turn-1", ordinal: 1, kind: "canonical_fact",
        content: fact.content, tokenEstimate: 12, rank: 0 }];
      return planGenerationPromptContext(context, plannerProvider(), "System", "Use the brass key at the gate", [],
        { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 8_000, 7_900,
        "attempt", "story_memory", defaultStoryMemoryPolicy("r2"), undefined, undefined, undefined,
        HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    });

    expect(results.map((result) => result.promptContext.chronicle.map((candidate: { id: string }) => candidate.id))).toEqual([[fact.id], [fact.id]]);
    expect(results.every((result) => result.storyInput.split(fact.content).length === 2)).toBe(true);
  });

  it("deduplicates a fact actually sent as protected authority", () => {
    const fact = { id: "11111111-1111-4111-8111-111111111111", turnNumber: 2,
      content: "The sealed gate opens with the brass key." };
    const context: any = recentContext();
    context.authority.protectedFacts = [fact];
    context.candidates = [{ id: fact.id, turnId: "fact-turn-2", ordinal: 2, kind: "canonical_fact",
      content: fact.content, tokenEstimate: 12, rank: 0 }];
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Use the brass key at the gate", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 32_000, 31_900,
      "attempt", "story_memory", defaultStoryMemoryPolicy("r2"), undefined, undefined, undefined,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);

    expect(result.promptContext.protectedFacts?.map((entry) => entry.id)).toEqual([fact.id]);
    expect(result.promptContext.chronicle).toEqual([]);
    expect(result.storyInput.split(fact.content)).toHaveLength(2);
    expect(result.layerDiagnostics.omitted).toContainEqual({ id: fact.id, reason: "duplicate_source" });
    expect(sentCanonicalFactIds(result.contextPlan.serializedRequest)).toContain(fact.id);
  });

  it("deduplicates a fact actually sent in current continuity", () => {
    const fact = { id: "11111111-1111-4111-8111-111111111111", content: "The sealed gate opens with the brass key." };
    const context: any = recentContext();
    context.authority.currentContinuity.canonicalFacts = [fact];
    context.candidates = [{ id: fact.id, turnId: "fact-turn-2", ordinal: 2, kind: "canonical_fact",
      content: fact.content, tokenEstimate: 12, rank: 0 }];
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Use the brass key at the gate", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 32_000, 31_900,
      "attempt", "story_memory", defaultStoryMemoryPolicy("r2"), undefined, undefined, undefined,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);

    expect(result.promptContext.currentContinuity.canonicalFacts).toEqual([fact]);
    expect(result.promptContext.chronicle).toEqual([]);
    expect(result.layerDiagnostics.omitted).toContainEqual({ id: fact.id, reason: "duplicate_source" });
    expect(sentCanonicalFactIds(result.contextPlan.serializedRequest)).toContain(fact.id);
  });

  it("does not classify a different verified fact source as duplicate by ID alone", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const protectedFact = { id, turnNumber: 2, content: "The sealed gate opens with the brass key." };
    const retrievedContent = "The brass key was forged beneath the old harbor.";
    const context: any = recentContext();
    context.authority.protectedFacts = [protectedFact];
    context.candidates = [{ id, turnId: "fact-turn-1", ordinal: 1, kind: "canonical_fact",
      content: retrievedContent, tokenEstimate: 12, rank: 0 }];
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Use the brass key at the gate", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 32_000, 31_900,
      "attempt", "story_memory", defaultStoryMemoryPolicy("r2"), undefined, undefined, undefined,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);

    expect(result.promptContext.protectedFacts).toEqual([protectedFact]);
    expect(result.promptContext.chronicle.map((candidate: { content: string }) => candidate.content)).toEqual([retrievedContent]);
    expect(result.layerDiagnostics.omitted).not.toContainEqual({ id, reason: "duplicate_source" });
  });

  it("retains a Chronicle fact when the selected protected fact set is empty", () => {
    const fact = { id: "11111111-1111-4111-8111-111111111111", turnNumber: 1,
      content: "The sealed gate opens with the brass key." };
    const context: any = recentContext();
    context.authority.protectedFacts = [{ ...fact, content: "The D20 roll lands on the table." }];
    context.candidates = [{ id: fact.id, turnId: "fact-turn-1", ordinal: 1, kind: "canonical_fact",
      content: "The sealed gate opens with the brass key.", tokenEstimate: 12, rank: 0 }];
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Use the brass key at the gate", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 8_000, 7_900,
      "attempt", "story_memory", defaultStoryMemoryPolicy("r2"), undefined, undefined, undefined,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);

    expect(result.promptContext.protectedFacts).toEqual([]);
    expect(result.promptContext.chronicle.map((candidate: { id: string }) => candidate.id)).toEqual([fact.id]);
    expect(result.layerDiagnostics.omitted).not.toContainEqual({ id: fact.id, reason: "duplicate_source" });
  });

  it("plans an empty Chronicle candidate set with protected facts", () => {
    const context: any = recentContext();
    const fact = { id: "11111111-1111-4111-8111-111111111111", turnNumber: 2, content: "The sealed gate opens with the brass key." };
    context.authority.protectedFacts = [fact];
    context.candidates = [];
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Continue", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 32_000, 31_900,
      "attempt", "story_memory", defaultStoryMemoryPolicy("r2"), undefined, undefined, undefined,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);

    expect(result.promptContext.protectedFacts).toEqual([fact]);
    expect(result.promptContext.chronicle).toEqual([]);
  });

  it.each([
    { id: "00000001-1111-4111-8111-111111111111", turnNumber: 4, turnId: "latest", ordinal: 4, label: "latest" },
    { id: "00000002-1111-4111-8111-111111111111", turnNumber: 3, turnId: "turn-3", ordinal: 3, label: "selected predecessor" }
  ])("keeps an omitted canonical fact from the $label turn while suppressing its narration duplicate", (factSource) => {
    const fact = { ...factSource, content: `The ${factSource.label} turn established the brass key.` };
    const context: any = recentContext();
    context.authority.protectedFacts = [fact, ...Array.from({ length: 40 }, (_, index) => ({
      id: `${String(index + 3).padStart(8, "0")}-1111-4111-8111-111111111111`, turnNumber: index + 5,
      content: `Protected campaign detail ${index + 5}. ${"The keeper records the harbor tide. ".repeat(7)}`
    }))];
    context.candidates = [
      { id: fact.id, turnId: fact.turnId, ordinal: fact.ordinal, kind: "canonical_fact", content: fact.content, tokenEstimate: 12, rank: 0 },
      { id: `${factSource.label}-narration`, turnId: fact.turnId, ordinal: fact.ordinal, kind: "turn_fiction",
        content: `Duplicate ${factSource.label} narration.`, tokenEstimate: 5, rank: 1 }
    ];
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Continue the story", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 8_000, 7_900,
      "attempt", "story_memory", defaultStoryMemoryPolicy("r2"), undefined, undefined, undefined,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);

    expect(result.promptContext.protectedFacts?.some((entry) => entry.id === fact.id)).toBe(false);
    expect(result.promptContext.chronicle.map((candidate: { id: string }) => candidate.id)).toEqual([fact.id]);
    expect(result.storyInput).not.toContain(`Duplicate ${factSource.label} narration.`);
  });

  it("keeps fact candidate order stable and leaves the non-history frozen policy unchanged", () => {
    const context: any = recentContext();
    const first = { id: "11111111-1111-4111-8111-111111111111", turnNumber: 1, content: "First retrieved fact." };
    const second = { id: "22222222-2222-4222-8222-222222222222", turnNumber: 2, content: "Second retrieved fact." };
    context.candidates = [
      { id: second.id, turnId: "fact-turn-2", ordinal: 2, kind: "canonical_fact", content: second.content, tokenEstimate: 5, rank: 2 },
      { id: first.id, turnId: "fact-turn-1", ordinal: 1, kind: "canonical_fact", content: first.content, tokenEstimate: 5, rank: 1 }
    ];
    const makePlan = () => planGenerationPromptContext(context, plannerProvider(), "System", "Continue", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 32_000, 31_900,
      "attempt", "story_memory", defaultStoryMemoryPolicy("r2"), undefined, undefined, undefined,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    const firstPlan = makePlan();
    expect(makePlan().promptContext.chronicle.map((candidate: { id: string }) => candidate.id))
      .toEqual(firstPlan.promptContext.chronicle.map((candidate: { id: string }) => candidate.id));
    expect(firstPlan.promptContext.chronicle.map((candidate: { id: string }) => candidate.id)).toEqual([second.id, first.id]);

    const legacy = plannerContext(null, "v3", [{ id: first.id, content: first.content }], [{
      id: first.id, turnId: "fact-turn-1", ordinal: 1, kind: "canonical_fact", content: first.content, tokenEstimate: 5, rank: 1
    }]);
    const legacyPlan = planGenerationPromptContext(legacy, plannerProvider(), "System", "Continue", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 32_000, 31_900,
      "attempt", "story_memory", defaultStoryMemoryPolicy("r2"));
    expect(legacyPlan.promptContext.chronicle).toEqual([]);
    expect(legacyPlan.layerDiagnostics.omitted).toContainEqual({ id: first.id, reason: "duplicate_source" });
  });

  it("retains a whole narration fallback but withholds an unverified canonical-fact source", () => {
    const context: any = recentContext();
    context.candidates = [
      { id: "whole-narration-fallback", turnId: "turn-narration", ordinal: 1, kind: "turn_fiction", content: "The lantern remained lit.", tokenEstimate: 6, rank: 1,
        sourceValidationFailed: true, narrativeSource: { normalizationVersion: "story-fiction-source-v1", sourceHash: "f".repeat(64), spans: [{ start: 0, end: 10 }] } },
      { id: "unverified-supersession", turnId: null, ordinal: 1, kind: "canonical_fact", content: "The earlier lantern fact was superseded.", tokenEstimate: 8, rank: 2,
        sourceValidationFailed: true }
    ];
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r2"), excerptPolicy: "verified_spans_v1" });
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Continue", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 32_000, 31_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", policy, undefined, undefined, undefined,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    const diagnostic = historyCoverageDiagnosticsSchema.parse((result.layerDiagnostics as any).history);

    expect(result.promptContext.chronicle.map((candidate) => candidate.id)).toEqual(["whole-narration-fallback"]);
    expect(result.sourceManifest!.entries.filter((entry) => entry.selectionGroup === "retrieved").map((entry) => entry.source.id))
      .toEqual(["turn-narration"]);
    expect(result.storyInput).not.toContain("earlier lantern fact was superseded");
    expect(diagnostic.candidates).toMatchObject({ selectedCount: 1, sourceValidationFailureCount: 2, sourceValidationExcluded: 1 });
  });

  it("fits the final review with a full 48000-token output reserve by pruning optional history before generation", () => {
    const context: any = plannerContext(null);
    context.candidates = Array.from({ length: 20 }, (_, i) => ({ id: `history-${i}`, turnId: null, ordinal: i, kind: "turn_fiction",
      content: "The harbor keeper records the tide. ".repeat(1500), tokenEstimate: 17500, rank: i }));
    const provider = { ...plannerProvider() as any, contextWindowTokens: 163_840, maxOutputTokens: 48_000 };
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r3"), continuityReview: "enforce" });
    const prompts = { version: 2, templates: Object.fromEntries(Object.entries(PROMPT_TEMPLATE_CATALOG).map(([key, value]) => [key, { content: value.defaultContent, hash: sha256(value.defaultContent), source: "shipped" }])),
      continuityReview: Object.fromEntries(Object.entries(CONTINUITY_REVIEW_PROMPT_CATALOG).map(([key, value]) => [key, { content: value.defaultContent, hash: sha256(value.defaultContent), source: "shipped", protocolIdentity: value.protocolIdentity }])) };
    const reviewArgs = (manifest: NonNullable<ReturnType<typeof run>["sourceManifest"]>) => ({ provider, manifest, producingRequestHash: manifest.producingRequestHash,
      promptSnapshot: prompts, reviewMode: "enforce" as const, direction: "Wait" });
    const args = [context, provider, "System", "Wait", [] as string[], { profile: "extended", minWords: 1200, maxWords: 2000 }, "scene", 128_000, 115_840,
      "22222222-2222-4222-8222-222222222222", "story_memory", policy, undefined] as const;
    const baseline = planGenerationPromptContext(...args);
    const planned = planGenerationPromptContext(...args, (manifest) => estimateContinuityReviewPlanningTokens({ ...reviewArgs(manifest), candidateOutputTokens: 48_000 }));
    expect(planned.promptContext.chronicle.length).toBeLessThan(baseline.promptContext.chronicle.length);
    const draft = storyTurnOutputSchema.parse({ narration: "The keeper waits beside the harbor. ".repeat(500), choices: ["Wait", "Go", "Look", "Listen"], custom_action_suggestion: "Wait", scratchpad: "",
      tracker_updates: [], image_prompt: "Harbor", continuity_summary: "The keeper waits.", open_threads: [], canonical_facts: [], canonical_fact_updates: [], superseded_facts: [] });
    const finalReview = prepareContinuityReview({ ...reviewArgs(planned.sourceManifest!), draft });
    expect(finalReview.requestTokens + finalReview.safetyAllowanceTokens + 48_000).toBeLessThanOrEqual(163_840);
    expect(JSON.parse(finalReview.body).max_tokens).toBe(48_000);
  });

  it("packs recent and world evidence together when review headroom is tighter", () => {
    const context = recentContext();
    context.recentTurns = [context.recentTurns[1]];
    context.authority.worldReferenceSource = {
      worldVersionId: "11111111-1111-4111-8111-111111111111",
      worldContent: { entities: [{ id: "relay", name: "Sable Relay", description: "The Sable Relay remembers every oath." }] }
    };
    const reviewInputTokens = (manifest: NonNullable<ReturnType<typeof run>["sourceManifest"]>) =>
      24_000 + (manifest.entries.some((entry) => entry.selectionGroup === "recent") ? 1200 : 0)
        + (manifest.entries.some((entry) => entry.semanticRole === "world_reference") ? 1200 : 0);
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Ask the Sable Relay about its oath.", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 32_000, 31_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", defaultStoryMemoryPolicy("r3"), undefined, reviewInputTokens);
    const reviewTokens = reviewInputTokens(result.sourceManifest!);
    expect(reviewTokens + estimatedInputSafetyAllowanceTokens(reviewTokens)).toBeLessThanOrEqual(31_900);
    expect(result.layerDiagnostics.omitted.length).toBeGreaterThan(0);
  });
  it("retains the smaller arg15 reviewer limit when a frozen v5 policy occupies arg16", () => {
    const context = recentContext();
    context.candidates = [{ id: "history", turnId: null, ordinal: 1, kind: "turn_fiction", content: "Useful history. ".repeat(900), tokenEstimate: 3600, rank: 1 }];
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r3"), continuityReview: "enforce" });
    const reviewCost = (manifest: NonNullable<ReturnType<typeof run>["sourceManifest"]>) =>
      20_000 + manifest.entries.filter((entry) => entry.selectionGroup === "retrieved").length * 20_000;
    const plan = (reviewLimit: number) => planGenerationPromptContext(context, plannerProvider(), "System", "Wait", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 32_000, 31_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", policy, undefined, reviewCost, reviewLimit, HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);

    expect(plan(60_000).promptContext.chronicle).toHaveLength(1);
    expect(plan(30_000).promptContext.chronicle).toHaveLength(0);
    expect(plan(31_900).promptContext.chronicle).toHaveLength(0);
    expect(() => plan(12_000)).toThrow(/context_budget_exceeded/);
  });

  it("sends v5 ledger directions as player intent with final projection pointers only", () => {
    const context: any = recentContext();
    context.authority.storyLedger = { version: "story-ledger-v1", omittedThroughTurn: 1,
      coverage: { unreadThroughTurn: 1, missingTurnCount: 2, filteredDirectionCount: 3, oversizedDirectionCount: 4, loadedRows: 5 }, entries: [
      { turnId: "ledger-2", turnNumber: 2, inputMode: "action", direction: "Ask the keeper about the sealed gate." },
      { turnId: "ledger-3", turnNumber: 3, inputMode: "scene", direction: "Continue." }
    ] };
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Wait", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 32_000, 31_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", defaultStoryMemoryPolicy("r3"), undefined, undefined, undefined,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);

    expect(result.promptContext.storyLedger!.entries.map((entry: { turnId: string }) => entry.turnId)).toEqual(["ledger-2", "ledger-3"]);
    expect(result.promptContext.storyLedger!.coverage).toEqual(context.authority.storyLedger.coverage);
    expect(result.storyInput).toContain("storyLedger records earlier player intent, not proof of events.");
    const evidence = result.sourceManifest!.entries.filter((entry) => entry.selectionGroup === "ledger");
    expect(evidence).toHaveLength(2);
    expect(evidence.every((entry) => entry.semanticRole === "player_intent" && /^\/storyLedger\/entries\/\d+\/direction$/u.test(entry.sourcePath))).toBe(true);
    expect(() => bindManifestToProducingRequest(result.sourceManifest!, result.contextPlan.serializedRequest)).not.toThrow();
  });

  it.each(["generation-base-v3", "generation-base-v4"] as const)("keeps %s prompt bytes when optional history fields are injected outside v5", (version) => {
    const context: any = plannerContext(null);
    if (version === "generation-base-v4") Object.assign(context.baseIdentity, {
      version, castRevision: 0, castTimelineRevision: 0, castFingerprint: "c".repeat(64), castCoverageStartTurn: null, castTrackedThroughTurn: null
    });
    const baseline = planGenerationPromptContext(context, plannerProvider(), "System", "Wait", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "action", 32_000, 31_900, "attempt", "story_memory", defaultStoryMemoryPolicy("r2"));
    context.authority.storyLedger = { version: "story-ledger-v1", omittedThroughTurn: 1,
      coverage: { unreadThroughTurn: 1, missingTurnCount: 2, filteredDirectionCount: 3, oversizedDirectionCount: 4, loadedRows: 5 },
      entries: [{ turnId: "ledger-injected", turnNumber: 1, inputMode: "action", direction: "Injected intent." }] };
    context.authority.protectedFacts = [{ id: "10000000-0000-4000-8000-000000000001", turnNumber: 1, content: "Injected protected fact." }];
    context.authority.protectedFactsCoverage = { candidateRows: 1, sourceBytes: 24, sourceLimitReached: false,
      withheldCandidateCount: 0, futureSourceCount: 0, oversizedCandidateCount: 0 };
    const injected = planGenerationPromptContext(context, plannerProvider(), "System", "Wait", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "action", 32_000, 31_900, "attempt", "story_memory", defaultStoryMemoryPolicy("r2"));

    expect(injected.storyInput).toBe(baseline.storyInput);
    expect(injected.contextPlan.serializedRequest).toBe(baseline.contextPlan.serializedRequest);
    expect(injected.promptContext).not.toHaveProperty("storyLedger");
    expect(injected.promptContext).not.toHaveProperty("protectedFacts");
    expect(injected.contextPlan.serializedRequest).not.toContain("protectedFacts");
  });

  it("reserves a measured newest ledger suffix with bounded writer and reviewer trials", () => {
    const context: any = recentContext();
    context.authority.storyLedger = { version: "story-ledger-v1", omittedThroughTurn: null,
      coverage: { unreadThroughTurn: null, missingTurnCount: 0, filteredDirectionCount: 0, oversizedDirectionCount: 0, loadedRows: 512 },
      entries: Array.from({ length: 512 }, (_, index) => ({
        turnId: `ledger-${index + 1}`, turnNumber: index + 1, inputMode: "action", direction: `Ask about marker ${index + 1}. `.repeat(8)
      })) };
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r3"), continuityReview: "enforce" });
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Wait", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 32_000, 31_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", policy, undefined,
      (manifest) => estimateStoryTokens(JSON.stringify({ reviewer: true, manifest })), 31_900,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    const reservation = (result.layerDiagnostics as any).ledgerReservation;

    expect(result.promptContext.storyLedger!.entries.length).toBeGreaterThan(0);
    expect(result.promptContext.storyLedger!.entries.length).toBeLessThan(512);
    expect(result.promptContext.storyLedger!.entries[0]!.turnNumber).toBe(512 - result.promptContext.storyLedger!.entries.length + 1);
    expect(reservation).toMatchObject({ measurementTrialCount: expect.any(Number), writerSerializationCount: expect.any(Number), reviewerSerializationCount: expect.any(Number) });
    expect(reservation.measurementTrialCount).toBeLessThanOrEqual(12);
    expect(reservation.writerSerializationCount).toBe(reservation.measurementTrialCount * 2);
    expect(reservation.reviewerSerializationCount).toBe(reservation.measurementTrialCount);
    expect(reservation.elapsedMilliseconds).toBeGreaterThanOrEqual(0);
    process.stderr.write(`${JSON.stringify({ historyLedgerReservationMetrics: { sourceEntries: 512, selectedEntries: result.promptContext.storyLedger!.entries.length,
      measurementTrials: reservation.measurementTrialCount, writerSerializations: reservation.writerSerializationCount,
      reviewerSerializations: reservation.reviewerSerializationCount, elapsedMilliseconds: Math.round(reservation.elapsedMilliseconds * 100) / 100 } })}\n`);
  }, 20_000);

  it("uses available context for 910 facts and drops oldest facts only when the request is full", () => {
    const context: any = recentContext();
    context.authority.protectedFacts = Array.from({ length: 910 }, (_, index) => ({
      id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      turnNumber: index + 1, content: `The harbor bell ${index + 1} remains silent.`
    }));
    context.authority.currentContinuity.canonicalFacts = context.authority.protectedFacts.map(({ id, content }: { id: string; content: string }) => ({ id, content }));
    const plan = (limit: number) => planGenerationPromptContext(context, plannerProvider(), "System", "Wait", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", limit, limit - 100,
      "22222222-2222-4222-8222-222222222222", "story_memory", defaultStoryMemoryPolicy("r3"), undefined, undefined, undefined,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    const roomy = plan(80_000);
    expect(roomy.promptContext.protectedFacts).toHaveLength(910);
    const tight = plan(8_000);
    const selected = tight.promptContext.protectedFacts ?? [];
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(910);
    expect(selected).toEqual(context.authority.protectedFacts.slice(-selected.length));
    expect(tight.contextPlan.contextTokens).toBeLessThanOrEqual(8_000);
    expect(tight.contextPlan.requestTokens + tight.contextPlan.safetyAllowanceTokens).toBeLessThanOrEqual(7_900);
    expect((tight.layerDiagnostics as any).factReservation).toMatchObject({ measurementLimitHit: false, unexaminedFactCount: 0 });
    expect(context.authority.protectedFacts).toHaveLength(910);
  }, 30_000);

  it("fits facts against independent writer and reviewer limits", () => {
    const context: any = recentContext();
    context.authority.protectedFacts = [{ id: "90000000-0000-4000-8000-000000000001", turnNumber: 1, content: "The harbor remains closed." }];
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r3"), continuityReview: "enforce" });
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Wait", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 8_000, 7_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", policy, undefined,
      (manifest) => 1_000 + manifest.entries.filter((entry) => entry.semanticRole === "canonical_fact").length * 20_000,
      100_000, HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    expect(result.promptContext.protectedFacts).toEqual(context.authority.protectedFacts);
    expect(result.contextPlan.requestTokens + result.contextPlan.safetyAllowanceTokens).toBeLessThanOrEqual(7_900);
    expect(result.contextPlan.additionalRequestTokens).toBeLessThanOrEqual(100_000);
  });

  it("budgets current facts without source IDs without dropping or inventing authority", () => {
    const context: any = recentContext();
    const facts = Array.from({ length: 910 }, (_, index) => ({ id: null, content: `Imported harbor fact ${index}: the bell remains silent.` }));
    context.authority.currentContinuity.canonicalFacts = facts;
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Wait", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 8_000, 7_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", defaultStoryMemoryPolicy("r3"), undefined, undefined, undefined,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    const selected = (result.promptContext.currentContinuity as any).canonicalFacts;
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(910);
    expect(selected).toEqual(facts.slice(-selected.length));
    expect(sentCanonicalFactIds(result.contextPlan.serializedRequest)).toEqual([]);
    expect(context.authority.currentContinuity.canonicalFacts).toHaveLength(910);
    expect(result.contextPlan.contextTokens).toBeLessThanOrEqual(8_000);
    expect(result.contextPlan.requestTokens + result.contextPlan.safetyAllowanceTokens).toBeLessThanOrEqual(7_900);
  }, 30_000);

  it("reserves complete verified facts against the shared headroom and binds only selected IDs", () => {
    const context: any = recentContext();
    context.authority.protectedFacts = [
      { id: "10000000-0000-4000-8000-000000000001", turnNumber: 1, content: "The oldest complete harbor fact remains visible. ".repeat(2) },
      { id: "10000000-0000-4000-8000-000000000002", turnNumber: 2, content: "The oversized middle fact remains whole. ".repeat(2_000) },
      { id: "10000000-0000-4000-8000-000000000003", turnNumber: 3, content: "The newest complete harbor fact remains visible. ".repeat(2) },
      { id: "10000000-0000-4000-8000-000000000004", turnNumber: 4, content: "The roll of 19 decides the harbor crossing." }
    ];
    context.authority.storyLedger = { version: "story-ledger-v1", omittedThroughTurn: null,
      entries: [{ turnId: "ledger-fact-boundary", turnNumber: 1, inputMode: "action", direction: "Ask about the protected harbor facts." }] };
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r3"), continuityReview: "enforce" });
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Wait", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 8_000, 7_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", policy, undefined,
      (manifest) => estimateStoryTokens(JSON.stringify({ reviewer: true, manifest })), 7_900,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    const selected = result.promptContext.protectedFacts as readonly { id: string; content: string }[];
    const factEvidence = result.sourceManifest!.entries.filter((entry) => entry.selectionGroup === "protected" && entry.canonicalFactId);

    expect(selected.map((fact) => fact.id)).toEqual([
      "10000000-0000-4000-8000-000000000003"
    ]);
    expect(selected.every((fact) => fact.content.length < 4_000)).toBe(true);
    expect(factEvidence.map((entry) => entry.canonicalFactId)).toEqual(selected.map((fact) => fact.id));
    expect(factEvidence.every((entry) => entry.form === "complete" && /^\/protectedFacts\/\d+\/content$/u.test(entry.sourcePath))).toBe(true);
    expect(sentCanonicalFactIds(result.contextPlan.serializedRequest)).toEqual(expect.arrayContaining(selected.map((fact) => fact.id)));
    expect(sentCanonicalFactIds(result.contextPlan.serializedRequest)).not.toContain("10000000-0000-4000-8000-000000000002");
    expect(sentCanonicalFactIds(result.contextPlan.serializedRequest)).not.toContain("10000000-0000-4000-8000-000000000004");
    expect(result.promptContext.protectedFactsOmitted).toBe(3);
    expect(result.promptContext.storyLedger!.entries).toHaveLength(1);
    expect((result.layerDiagnostics as any).factReservation).toMatchObject({
      originalHeadroomTokens: (result.layerDiagnostics as any).ledgerReservation.originalHeadroomTokens,
      factBudgetTokens: (result.layerDiagnostics as any).ledgerReservation.factBudgetTokens,
      measurementTrialCount: expect.any(Number), writerSerializationCount: expect.any(Number), reviewerSerializationCount: expect.any(Number),
      measurementLimitHit: false, unexaminedFactCount: 0
    });
    expect((result.layerDiagnostics as any).ledgerReservation.originalHeadroomTokens)
      .toBe((result.layerDiagnostics as any).factReservation.originalHeadroomTokens);
  }, 20_000);

  it("drops older facts before newer facts, including when the newest whole fact cannot fit", () => {
    const records = [
      { id: "40000000-0000-4000-8000-000000000001", content: "First small fact. ".repeat(4) },
      { id: "40000000-0000-4000-8000-000000000002", content: "Oversized fact. ".repeat(20_000) },
      { id: "40000000-0000-4000-8000-000000000003", content: "Second small fact. ".repeat(4) },
      { id: "40000000-0000-4000-8000-000000000004", content: "Third small fact. ".repeat(4) }
    ];
    const permutations = (values: typeof records): typeof records[] => values.length < 2 ? [values] : values.flatMap((value, index) =>
      permutations(values.filter((_, candidateIndex) => candidateIndex !== index)).map((rest) => [value, ...rest]));
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r3"), continuityReview: "enforce" });

    for (const ordered of permutations(records)) {
      const context: any = recentContext();
      context.authority.protectedFacts = ordered.map((fact, index) => ({ ...fact, turnNumber: index + 1 }));
      const result = planGenerationPromptContext(context, plannerProvider(), "System", "Wait", [],
        { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 16_000, 15_900,
        "22222222-2222-4222-8222-222222222222", "story_memory", policy, undefined,
        (manifest) => estimateStoryTokens(JSON.stringify({ reviewer: true, manifest })), 15_900,
        HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
      const expected = ordered.slice(ordered.findIndex((fact) => fact.id === records[1]!.id) + 1).map((fact) => fact.id);
      expect((result.promptContext.protectedFacts ?? []).map((fact: { id: string }) => fact.id)).toEqual(expected);
      expect(sentCanonicalFactIds(result.contextPlan.serializedRequest)).toEqual(expected);
      expect((result.layerDiagnostics as any).factReservation).toMatchObject({ measurementLimitHit: false, unexaminedFactCount: 0 });
    }
  }, 20_000);

  it("measures every supported protected fact with the real reviewer serializer in a large envelope", () => {
    const context: any = recentContext();
    context.authority.protectedFacts = Array.from({ length: 512 }, (_, index) => ({
      id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      turnNumber: index + 1,
      content: `Protected fact ${index + 1}: ${"the harbor bell remains silent ".repeat(55)}`
    }));
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r3"), continuityReview: "enforce" });
    const provider = { ...plannerProvider() as any, contextWindowTokens: 4_000_000, maxOutputTokens: 100 };
    const prompts = { version: 2, templates: Object.fromEntries(Object.entries(PROMPT_TEMPLATE_CATALOG).map(([key, value]) => [key, { content: value.defaultContent, hash: sha256(value.defaultContent), source: "shipped" }])),
      continuityReview: Object.fromEntries(Object.entries(CONTINUITY_REVIEW_PROMPT_CATALOG).map(([key, value]) => [key, { content: value.defaultContent, hash: sha256(value.defaultContent), source: "shipped", protocolIdentity: value.protocolIdentity }])) };
    const result = planGenerationPromptContext(context, provider, "System", "Wait", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 4_000_000, 3_999_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", policy, undefined,
      (manifest) => estimateContinuityReviewPlanningTokens({ provider, manifest, producingRequestHash: manifest.producingRequestHash,
        promptSnapshot: prompts, reviewMode: "enforce", direction: "Wait", candidateOutputTokens: 100 }), 3_999_900,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    const reservation = (result.layerDiagnostics as any).factReservation;

    expect(reservation).toMatchObject({ sourceFactCount: 512, measurementTrialCount: 1 });
    expect(Buffer.byteLength(JSON.stringify(context.authority.protectedFacts), "utf8")).toBeLessThan(1_000_000);
    expect(reservation.selectedFactCount).toBe(512);
    expect(reservation.writerSerializationCount).toBe(2);
    expect(reservation.reviewerSerializationCount).toBe(1);
    expect(reservation.elapsedMilliseconds).toBeGreaterThanOrEqual(0);
    process.stderr.write(`${JSON.stringify({ protectedFactReservationMetrics: { sourceFacts: reservation.sourceFactCount,
      selectedFacts: reservation.selectedFactCount, measurementTrials: reservation.measurementTrialCount,
      writerSerializations: reservation.writerSerializationCount, reviewerSerializations: reservation.reviewerSerializationCount,
      elapsedMilliseconds: Math.round(reservation.elapsedMilliseconds * 100) / 100 } })}\n`);
  }, 30_000);

  it("measures a many-fact partial fit with the real reviewer serializer", () => {
    const context: any = recentContext();
    context.authority.protectedFacts = Array.from({ length: 512 }, (_, index) => ({
      id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      turnNumber: index + 1,
      content: `Protected partial fact ${index + 1}: ${"the harbor bell remains silent ".repeat(55)}`
    }));
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r3"), continuityReview: "enforce" });
    const provider = { ...plannerProvider() as any, contextWindowTokens: 250_000, maxOutputTokens: 100 };
    const prompts = { version: 2, templates: Object.fromEntries(Object.entries(PROMPT_TEMPLATE_CATALOG).map(([key, value]) => [key, { content: value.defaultContent, hash: sha256(value.defaultContent), source: "shipped" }])),
      continuityReview: Object.fromEntries(Object.entries(CONTINUITY_REVIEW_PROMPT_CATALOG).map(([key, value]) => [key, { content: value.defaultContent, hash: sha256(value.defaultContent), source: "shipped", protocolIdentity: value.protocolIdentity }])) };
    const result = planGenerationPromptContext(context, provider, "System", "Wait", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 250_000, 249_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", policy, undefined,
      (manifest) => estimateContinuityReviewPlanningTokens({ provider, manifest, producingRequestHash: manifest.producingRequestHash,
        promptSnapshot: prompts, reviewMode: "enforce", direction: "Wait", candidateOutputTokens: 100 }), 249_900,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    const reservation = (result.layerDiagnostics as any).factReservation;

    expect(reservation.sourceFactCount).toBe(512);
    expect(reservation.selectedFactCount).toBeGreaterThan(0);
    expect(reservation.selectedFactCount).toBeLessThan(512);
    expect(reservation.measurementTrialCount).toBeLessThanOrEqual(1 + Math.ceil(Math.log2(reservation.sourceFactCount)));
    expect(reservation.writerSerializationCount).toBe(reservation.measurementTrialCount * 2);
    expect(reservation.reviewerSerializationCount).toBe(reservation.measurementTrialCount);
    expect(reservation.measurementLimitHit).toBe(false);
    expect(reservation.unexaminedFactCount).toBe(0);
    expect(sentCanonicalFactIds(result.contextPlan.serializedRequest)).toEqual((result.promptContext.protectedFacts ?? []).map((fact: { id: string }) => fact.id));
    process.stderr.write(`${JSON.stringify({ protectedFactPartialReservationMetrics: { sourceFacts: reservation.sourceFactCount,
      selectedFacts: reservation.selectedFactCount, measurementTrials: reservation.measurementTrialCount,
      writerSerializations: reservation.writerSerializationCount, reviewerSerializations: reservation.reviewerSerializationCount,
      measurementLimitHit: reservation.measurementLimitHit, unexaminedFactCount: reservation.unexaminedFactCount,
      elapsedMilliseconds: Math.round(reservation.elapsedMilliseconds * 100) / 100 } })}\n`);
  }, 60_000);

  it("keeps ledger intent when the matching recent turn is not actually reserved", () => {
    const context: any = recentContext();
    context.recentTurns[0].narration = "Too large to reserve. ".repeat(5_000);
    context.authority.storyLedger = { version: "story-ledger-v1", omittedThroughTurn: 1,
      coverage: { unreadThroughTurn: 1, missingTurnCount: 0, filteredDirectionCount: 0, oversizedDirectionCount: 0, loadedRows: 2 },
      entries: [
        { turnId: "turn-2", turnNumber: 2, inputMode: "action", direction: "Ask the keeper about the lantern." },
        { turnId: "turn-3", turnNumber: 3, inputMode: "action", direction: "Wait for the tide." }
      ] };
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Continue", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 8_000, 7_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", defaultStoryMemoryPolicy("r2"), undefined, undefined, undefined,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);

    expect(result.promptContext.recentTurns!.map((entry: { sourceId: string }) => entry.sourceId)).toEqual(["turn-3"]);
    expect(result.promptContext.storyLedger!.entries.map((entry: { turnId: string }) => entry.turnId)).toContain("turn-2");
  });

  it("keeps feasible large mandatory authority within a smaller reviewer cap by omitting ledger history", () => {
    const context: any = recentContext();
    context.authority.rules = ["The sealed gate remains closed. ".repeat(1_200)];
    context.authority.storyLedger = { version: "story-ledger-v1", omittedThroughTurn: null,
      coverage: { unreadThroughTurn: null, missingTurnCount: 0, filteredDirectionCount: 0, oversizedDirectionCount: 0, loadedRows: 3 },
      entries: [1, 2, 3].map((turnNumber) => ({ turnId: `ledger-${turnNumber}`, turnNumber, inputMode: "action", direction: "Search the quay for the silver seal. ".repeat(20) })) };
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r3"), continuityReview: "enforce" });
    const reviewCost = (manifest: NonNullable<ReturnType<typeof run>["sourceManifest"]>) => 10_000 + manifest.entries.filter((entry) => entry.selectionGroup === "ledger").length * 1_000;
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Wait", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 32_000, 31_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", policy, undefined, reviewCost, 13_030,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);

    expect(result.storyInput).toContain("The sealed gate remains closed.");
    expect(result.promptContext.storyLedger!.entries).toEqual([]);
    expect(result.contextPlan.additionalRequestTokens + estimatedInputSafetyAllowanceTokens(result.contextPlan.additionalRequestTokens)).toBeLessThanOrEqual(13_030);
  });

  it("does not measure continuity review when the frozen policy disables it", () => {
    let reviewMeasurements = 0;
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r3"), continuityReview: "off" });
    const result = planGenerationPromptContext(recentContext(), plannerProvider(), "System", "Continue", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 32_000, 31_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", policy, undefined, () => { reviewMeasurements++; return 100_000; });
    expect(reviewMeasurements).toBe(0);
    expect(result.promptContext.recentTurns).toHaveLength(2);
  });
  it("ignores a supplied reviewer limit in v5 when policy review is disabled", () => {
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r3"), continuityReview: "off" });
    expect(() => planGenerationPromptContext(recentContext(), plannerProvider(), "System", "Continue", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "scene", 32_000, 31_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", policy, undefined, () => 100_000, 1,
      HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION)).not.toThrow();
  });
  it.each(["action", "scene"] as const)("sends bounded cast corrections with exact evidence in %s mode", (mode) => {
    const context: any = plannerContext({ source: "none", name: "", characterText: "", profile: null });
    const characterId = "11111111-1111-4111-8111-111111111111";
    const cast = { version: "cast-context-v1", scope: { ownerUserId: characterId, campaignId: characterId }, worldVersionId: characterId,
      revision: 1, boundary: { turnNumber: 0, timelineRevision: 0 }, coverageStartTurn: null, trackedThroughTurn: null, discoveryStatus: "pending",
      characters: [{ id: characterId, name: "Mara", aliases: ["The Watcher"], origin: { kind: "manual" }, profile: {},
        pinned: false, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 0 }],
      details: [{ characterId, observations: [], overrides: [{ field: "appearance.description", value: "green eyes",
        evidence: { kind: "user", editId: characterId, effectiveTurnNumber: 0 } }] }] };
    context.authority.castSnapshot = cast;
    Object.assign(context.baseIdentity, { version: "generation-base-v4", castRevision: 1, castTimelineRevision: 0,
      castFingerprint: castGenerationSnapshotFingerprint(cast), castCoverageStartTurn: null, castTrackedThroughTurn: null });
    const planned = planGenerationPromptContext(context, plannerProvider(), "System", "Visit The Watcher", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, mode, 32_000, 31_900, characterId, "story_memory", defaultStoryMemoryPolicy("r1"));
    expect(planned.storyInput).toContain("green eyes");
    const castEntries = planned.sourceManifest!.entries.filter((entry) => entry.source.kind === "cast");
    expect(castEntries.some((entry) => entry.semanticRole === "corrected_state" && entry.content.includes("green eyes"))).toBe(true);
    expect(() => bindManifestToProducingRequest(planned.sourceManifest!, planned.contextPlan.serializedRequest)).not.toThrow();
    expect(() => bindManifestToProducingRequest(planned.sourceManifest!, planned.contextPlan.serializedRequest.replace("green eyes", "blue eyes"))).toThrow();
    expect(planned.contextPlan.requestTokens + planned.contextPlan.safetyAllowanceTokens).toBeLessThanOrEqual(31_900);
    expect(planned.layerDiagnostics.cast?.allocatedTokens).toBeLessThanOrEqual(3000);
    const oldContext = { ...context, authority: { ...context.authority, castSnapshot: undefined },
      baseIdentity: { ...context.baseIdentity, version: "generation-base-v3" } };
    const oldPlan = planGenerationPromptContext(oldContext, plannerProvider(), "System", "Visit The Watcher", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, mode, 32_000, 31_900, characterId, "story_memory", defaultStoryMemoryPolicy("r1"));
    expect(oldPlan.storyInput).not.toContain("green eyes");
    expect(planned.contextPlan.requestTokens + planned.contextPlan.safetyAllowanceTokens
      - oldPlan.contextPlan.requestTokens - oldPlan.contextPlan.safetyAllowanceTokens).toBeLessThanOrEqual(planned.layerDiagnostics.cast!.allocatedTokens);
    expect(castEntries.every((entry) => planned.sourceManifest!.requiredReviewEvidenceIds.includes(entry.id))).toBe(true);
    cast.details[0]!.overrides[0]!.value = "A long complete correction. ".repeat(70);
    context.baseIdentity.castFingerprint = castGenerationSnapshotFingerprint(cast);
    const oversized = planGenerationPromptContext(context, plannerProvider(), "System", "Visit The Watcher", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, mode, 5000, 4900, characterId, "story_memory", defaultStoryMemoryPolicy("r1"));
    expect(oversized.storyInput).not.toContain("A long complete correction.");
    expect(oversized.layerDiagnostics.cast!.omittedFieldCount).toBe(1);
    expect(oversized.contextPlan.requestTokens + oversized.contextPlan.safetyAllowanceTokens).toBeLessThanOrEqual(4900);
    expect(oversized.sourceManifest!.entries.some((entry) => entry.source.kind === "cast" && entry.semanticRole === "corrected_state")).toBe(false);
    context.authority.castSnapshot = { ...cast, details: [{ ...cast.details[0], overrides: [], observations: [{
      id: characterId, characterId, field: "story.role", value: "harbor keeper", mode: "fact", speakerCharacterId: null,
      supersedesObservationId: null, evidence: { kind: "world", worldVersionId: characterId, sourcePath: "/entities/0" }
    }] }] };
    context.baseIdentity.castFingerprint = castGenerationSnapshotFingerprint(context.authority.castSnapshot);
    const worldCast = planGenerationPromptContext(context, plannerProvider(), "System", "Visit The Watcher", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, mode, 32_000, 31_900, characterId, "story_memory", defaultStoryMemoryPolicy("r1"));
    expect(worldCast.sourceManifest!.entries.some((entry) => entry.source.kind === "cast" && entry.semanticRole === "world_reference" && entry.content.includes("harbor keeper"))).toBe(true);
  });
  it.each([false, true])("packs against the final schema request and streaming envelope (%s)", (streaming) => {
    const context: any = plannerContext(null);
    context.candidates = [{ id: "history", turnId: null, ordinal: 1, kind: "canonical_fact", content: "The harbor remains closed. ".repeat(150), tokenEstimate: 1000, rank: 1 }];
    const provider = { ...plannerProvider() as any, baseUrl: "", providerType: "openrouter" as const };
    const schema = getProviderOutputSchema("story");
    const responseContract = { version: 1, mode: "json_schema", operation: "story", streaming,
      schemaVersion: schema.version, schemaHash: schema.schemaHash, schemaName: schema.name, schema: schema.schema,
      providerRoutingSlugs: ["provider/region"] as string[], routeConfigHash: "b".repeat(64), adapterProtocol: "text-schema-adapter-v1", forbidFormatFallback: true } as const;
    const serialize = (input: string) => serializeProviderRequest(provider, {
      systemPrompt: "System", input, responseContract, ...(streaming ? { onChunk: () => undefined } : {})
    }).body;
    const args = [context, provider, "System", "Continue", [] as string[], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000] as const;
    const baseline = planGenerationPromptContext(...args, 100_000);
    const inputLimit = baseline.contextPlan.requestTokens + estimatedInputSafetyAllowanceTokens(baseline.contextPlan.requestTokens) + 10;
    const finalTokens = estimateStoryTokens(serialize(baseline.storyInput));
    expect(finalTokens + estimatedInputSafetyAllowanceTokens(finalTokens)).toBeGreaterThan(inputLimit);

    const planned = planGenerationPromptContext(...args, inputLimit, "22222222-2222-4222-8222-222222222222", "legacy", undefined, serialize);
    expect(planned.promptContext.chronicle).toEqual([]);
    expect(planned.contextPlan.serializedRequest).toBe(serialize(planned.storyInput));
    expect(planned.contextPlan.requestTokens + planned.contextPlan.safetyAllowanceTokens).toBeLessThanOrEqual(inputLimit);
    expect(() => bindManifestToProducingRequest(planned.sourceManifest!, serialize(planned.storyInput))).not.toThrow();
  });
  it("binds selected entity and relationship evidence to the exact provider request", () => {
    const context: any = plannerContext(null);
    context.authority.worldReferenceSource = {
      worldVersionId: "11111111-1111-4111-8111-111111111111",
      worldContent: {
        entities: [
          { id: "relay", name: "Sable Relay", description: "The Sable Relay remembers every oath." },
          { id: "keeper", name: "Relay Keeper", description: "The keeper maintains its lens." }
        ],
        relationships: [{ id: "relay-keeper", from: "relay", to: "keeper", description: "The keeper answers the Sable Relay after dusk." }]
      }
    };
    const planned = planGenerationPromptContext(context, plannerProvider(), "System", "Ask the Sable Relay and its keeper about their oath.", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "action", 32_000, 31_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", defaultStoryMemoryPolicy("r3"));

    expect(planned.promptContext.worldReferences).toHaveLength(3);
    expect(() => bindManifestToProducingRequest(planned.sourceManifest!, planned.contextPlan.serializedRequest)).not.toThrow();
  });
  it("rejects altered, omitted, foreign, and path-mismatched selected world references", () => {
    const context: any = plannerContext(null);
    context.authority.worldReferenceSource = {
      worldVersionId: "11111111-1111-4111-8111-111111111111",
      worldContent: { entities: [{ id: "relay", name: "Sable Relay", description: "The Sable Relay remembers every oath." }] }
    };
    const planned = planGenerationPromptContext(context, plannerProvider(), "System", "Ask the Sable Relay about its oath.", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "action", 32_000, 31_900,
      "22222222-2222-4222-8222-222222222222", "story_memory", defaultStoryMemoryPolicy("r3"));
    const tamperedRequest = (mutate: (references: any[]) => any[]) => {
      const request = JSON.parse(planned.contextPlan.serializedRequest);
      const message = request.messages.find((candidate: { role: string }) => candidate.role === "user");
      const input = JSON.parse(message.content);
      input.authoritative_context.worldReferences = mutate(input.authoritative_context.worldReferences);
      message.content = JSON.stringify(input);
      return JSON.stringify(request);
    };
    const rejects = (mutate: (references: any[]) => any[]) => expect(() =>
      bindManifestToProducingRequest(planned.sourceManifest!, tamperedRequest(mutate))
    ).toThrow(/does not retain selected source evidence/);

    rejects((references) => references.map((reference) => ({ ...reference, content: "altered" })));
    rejects(() => []);
    rejects((references) => references.map((reference) => ({ ...reference, sourceId: "world:foreign" })));
    rejects((references) => references.map((reference) => ({ ...reference, sourcePath: "/entities/99" })));
  });
  it("preserves extraction legacy wire bytes", () => {
    const planned = planGenerationPromptContext(plannerContext(null, "legacy"), plannerProvider(), "System", "Wait.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000);
    expect(sha256(planned.storyInput)).toBe("7616377f003629171820c545b1dc4918262bb3978754a7df0af362a7318054b5");
    expect(planned.contextPlan.serializedRequest).toBe(serializeProviderRequest({ ...plannerProvider() as any, baseUrl: "" }, { systemPrompt: "System", input: planned.storyInput }).body);
  });
  it("reserves contiguous recent turns, labels intent, renders chronologically and deduplicates retrieved turns", () => {
    const context = recentContext();
    context.candidates = [2, 3, 4].map((n) => ({ id: `copy-${n}`, turnId: n === 4 ? "latest" : `turn-${n}`, ordinal: n, kind: "turn_fiction", content: "Duplicate history", tokenEstimate: 4, rank: 1 }));
    const result = run(context);
    expect(result.promptContext.recentTurns!.map((t: any) => t.turnNumber)).toEqual([2, 3]);
    expect(result.promptContext.recentTurns![0]).toMatchObject({ intent: "Intent 2", acceptedNarration: "Outcome 2" });
    expect(result.promptContext.chronicle).toEqual([]);
    expect(result.layerDiagnostics.recent).toEqual({ target: 3, included: 3, firstGapReason: null });
    expect(result.sourceManifest?.entries.filter((e) => e.selectionGroup === "recent")).toHaveLength(4);
  });
  it("stops at a missing immediate predecessor", () => {
    const context = recentContext(); context.recentTurns = [context.recentTurns[0]];
    expect(run(context).layerDiagnostics.recent).toEqual({ target: 3, included: 1, firstGapReason: "recent_gap" });
    expect(run(context).promptContext.recentTurns).toEqual([]);
  });
  it("omits a whole oversized predecessor and lends its reservation to other history", () => {
    const context = recentContext(); context.recentTurns[1].narration = "Unbroken history. ".repeat(5000);
    context.candidates = [{ id: "old", turnId: "old", ordinal: 1, kind: "turn_fiction", content: "Old useful evidence.", tokenEstimate: 5, rank: 1 }];
    const result = run(context, 8000);
    expect(result.promptContext.recentTurns).toEqual([]);
    expect(result.layerDiagnostics.recent.firstGapReason).toBe("context_limit");
    expect(result.promptContext.chronicle.map((c) => c.id)).toEqual(["old"]);
  });
  it("classifies immutable overview rather than serializing unknown world objects", () => {
    const context = recentContext();
    context.authority.worldCanon = { title: "Harbor", premise: "The tide is rising.", entities: [{ internal: "WORLD_INTERNAL_CANARY" }], internal: "PRIVATE_WORLD_TEXT" };
    expect(run(context).storyInput).toContain("The tide is rising.");
    expect(run(context).storyInput).not.toMatch(/WORLD_INTERNAL_CANARY|PRIVATE_WORLD_TEXT/);
  });
  it("never excerpts canonical facts or trusts stale narrative hashes", () => {
    const context = recentContext();
    const content = "A complete remembered fact. ".repeat(3000);
    context.candidates = ["canonical_fact", "turn_fiction"].map((kind, index) => ({ id: `source-${index}`, turnId: null, ordinal: 1, kind, content, tokenEstimate: 10000, rank: index,
      narrativeSource: { normalizationVersion: "story-fiction-source-v1", sourceHash: "f".repeat(64), spans: [{ start: 0, end: 20 }] } }));
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r2"), excerptPolicy: "verified_spans_v1" });
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Continue", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 8000, 7900, undefined, "story_memory", policy);
    expect(result.promptContext.chronicle).toEqual([]);
    expect(result.layerDiagnostics.sourceValidationFailures).toBe(1);
    expect(result.layerDiagnostics.excerptsPartial).toBe(0);
  });
  it("keeps a certified narration whole when the complete record is economical", () => {
    const context = recentContext();
    const content = `${"Old scenery. ".repeat(24)}The lantern is lit. ${"More scenery. ".repeat(24)}`.trim();
    const start = content.indexOf("The lantern");
    context.candidates = [{ id: "economical", turnId: "old", ordinal: 1, kind: "turn_fiction", content, tokenEstimate: 200, rank: 1,
      narrativeSource: { normalizationVersion: "story-fiction-source-v1", sourceHash: sha256(content), spans: [{ start, end: start + "The lantern is lit.".length }] } }];
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r2"), excerptPolicy: "verified_spans_v1" });
    const result = planGenerationPromptContext(context, plannerProvider(), "System", "Find lantern", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 32_000, 31_900, undefined, "story_memory", policy);
    expect(result.promptContext.chronicle[0]).toMatchObject({ id: "economical", content });
    expect(result.promptContext.chronicle[0]?.evidenceForm).toBeUndefined();
  });
  it("retries an omitted whole parent as a certified excerpt and retains fact deduplication", () => {
    const context = recentContext(); context.recentTurns = [];
    const fact = { id: "11111111-1111-4111-8111-111111111111", content: "The keeper holds the sealed gate key." };
    context.authority.currentContinuity.canonicalFacts = [fact];
    const content = `${"Old scenery. ".repeat(90)}The sapphire is hidden. Its hiding place is unknown to Vale. ${"More scenery. ".repeat(90)}`.trim();
    context.candidates = [
      { id: fact.id, turnId: "fact-turn-1", ordinal: 1, kind: "canonical_fact", content: fact.content, tokenEstimate: 10, rank: 0 },
      { id: "middle", turnId: "old", ordinal: 1, kind: "turn_fiction", content, tokenEstimate: 900, rank: 1,
        narrativeSource: { normalizationVersion: "story-fiction-source-v1", sourceHash: sha256(content), spans: [{ start: content.indexOf("The sapphire"), end: content.indexOf("The sapphire") + 22 }] } }
    ];
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r2"), excerptPolicy: "verified_spans_v1" });
    const capturedRequests: { input: string; body: string }[] = [];
    const serializeRequest = (input: string) => {
      const body = serializeProviderRequest({ ...plannerProvider() as any, baseUrl: "" }, { systemPrompt: "System", input }).body;
      capturedRequests.push({ input, body });
      return body;
    };
    const plan = () => planGenerationPromptContext(context, plannerProvider(), "System", "Find sapphire", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "action", 8_000, 7_900,
      undefined, "story_memory", policy, serializeRequest);
    const initiallyRetained = plan();
    expect(initiallyRetained.promptContext.chronicle[0]).toMatchObject({ id: "middle", content });
    let result = initiallyRetained;
    let retrySummary = "";
    for (let words = 0; words < 4500; words += 20) {
      retrySummary = "History ".repeat(words);
      context.authority.currentContinuity.continuitySummary = retrySummary;
      try { result = plan(); } catch { break; }
      if (result.promptContext.chronicle[0]?.evidenceForm === "excerpt") break;
    }

    const retryIterationRequests = capturedRequests.filter((request) => request.input.includes(retrySummary));
    const fullParentRequestIndex = retryIterationRequests.findIndex((request) => request.body.includes(content));
    const excerptRequestIndex = retryIterationRequests.findIndex((request) => !request.body.includes(content)
      && request.body.includes("The sapphire is hidden."));
    expect(result.promptContext.chronicle[0]?.evidenceForm).toBe("excerpt");
    expect(fullParentRequestIndex).toBeGreaterThanOrEqual(0);
    expect(excerptRequestIndex).toBeGreaterThan(fullParentRequestIndex);
    expect(retryIterationRequests.at(-1)?.body).toBe(result.contextPlan.serializedRequest);
    expect(result.promptContext.currentContinuity.canonicalFacts).toEqual([fact]);
    expect(result.promptContext.chronicle.map((candidate) => candidate.id)).toEqual(["middle"]);
    expect(result.layerDiagnostics.omitted).toContainEqual({ id: fact.id, reason: "duplicate_source" });
    expect(result.storyInput.split(fact.content)).toHaveLength(2);
    expect(result.contextPlan.serializedRequest.split(fact.content)).toHaveLength(2);
    expect(result.storyInput).toContain("The sapphire is hidden.");
  });
  it("keeps selected fact deduplication during history-coverage early excerpt selection", () => {
    const context = recentContext(); context.recentTurns = [];
    const protectedFact = { id: "11111111-1111-4111-8111-111111111111", turnNumber: 1, content: "The keeper holds the sealed gate key." };
    const content = `${"Old scenery. ".repeat(200)}The sapphire is hidden. Its hiding place is unknown to Vale. ${"More scenery. ".repeat(200)}`.trim();
    context.authority.protectedFacts = [protectedFact];
    context.candidates = [
      { id: protectedFact.id, turnId: "fact-turn-1", ordinal: 1, kind: "canonical_fact", content: protectedFact.content, tokenEstimate: 10, rank: 0 },
      { id: "middle", turnId: "old", ordinal: 1, kind: "turn_fiction", content, tokenEstimate: 1800, rank: 1,
        narrativeSource: { normalizationVersion: "story-fiction-source-v1", sourceHash: sha256(content), spans: [{ start: content.indexOf("The sapphire"), end: content.indexOf("The sapphire") + 22 }] } }
    ];
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r2"), excerptPolicy: "verified_spans_v1" });
    const plan = () => planGenerationPromptContext(context, plannerProvider(), "System", "Find sapphire", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "action", 8_000, 7_900,
      "attempt", "story_memory", policy, undefined, undefined, undefined, HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION);
    let result = plan();
    for (let words = 0; words <= 2_000; words += 5) {
      context.authority.currentContinuity.continuitySummary = "History ".repeat(words);
      try { result = plan(); } catch { break; }
      if (result.promptContext.chronicle.find((candidate) => candidate.id === "middle")?.evidenceForm === "excerpt") break;
    }

    expect(result.promptContext.chronicle.map((candidate) => candidate.id)).toEqual(["middle"]);
    expect(result.promptContext.chronicle[0]?.evidenceForm).toBe("excerpt");
    expect(result.promptContext.protectedFacts).toEqual([protectedFact]);
    expect(result.layerDiagnostics.omitted).toContainEqual({ id: protectedFact.id, reason: "duplicate_source" });
    expect(sentCanonicalFactIds(result.contextPlan.serializedRequest)).toContain(protectedFact.id);
    expect(result.storyInput).toContain("The sapphire is hidden.");
  });
  it("reports safe component estimates on protected overflow without exposing profile text", () => {
    const context = recentContext();
    context.authority.characterAuthority = { source: "campaign_profile", name: "PrivateName", characterText: "PrivateHistory ".repeat(2000), profile: null };
    try { run(context, 100); throw new Error("Expected overflow"); }
    catch (error: any) {
      expect(error.code).toBe("context_budget_exceeded");
      expect(error.protectedComponents.character_profile).toBeGreaterThan(100);
      expect(JSON.stringify(error.protectedComponents)).not.toMatch(/PrivateName|PrivateHistory/);
    }
  });
  it.each([8000, 32000, 128000, 1000000])("measures deterministic exact bodies at %i tokens", (limit) => {
    const context = recentContext();
    context.authority.currentContinuity.openThreads = Array.from({ length: 500 }, (_, i) => `門 ${i}`);
    context.candidates = [{ id: "summary", turnId: null, ordinal: 1, kind: "campaign_summary", content: "Large summary. ".repeat(limit), tokenEstimate: limit, rank: 1 }];
    const first = run(context, limit); const second = run(context, limit);
    expect(first).toEqual(second);
    expect(first.contextPlan.requestTokens).toBe(estimateStoryTokens(first.contextPlan.serializedRequest));
    expect(first.contextPlan.requestTokens + first.contextPlan.safetyAllowanceTokens).toBeLessThanOrEqual(limit - 100);
    expect(first.contextPlan.serializedRequest).toBe(serializeProviderRequest({ ...plannerProvider() as any, baseUrl: "" }, { systemPrompt: "System", input: first.storyInput }).body);
  });
});
