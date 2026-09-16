import { describe, expect, it } from "vitest";
import { planGenerationPromptContext } from "../../services/runtime/src/generation-context-planner.js";
import { storyMemoryPolicySchema, defaultStoryMemoryPolicy } from "../../packages/contracts/src/story-memory-policy.js";
import { estimateStoryTokens, serializeProviderRequest } from "../../packages/story-engine/src/index.js";
import { sha256 } from "../../packages/domain/src/index.js";
import { bindManifestToProducingRequest } from "../../packages/application/src/memory/continuity-review-checkpoint.js";
  function plannerContext(characterAuthority: unknown, version: "legacy" | "v3" = "v3") {
    const baseIdentity = version === "v3"
      ? { version: "generation-base-v3", operationKind: "append", expectedTurnNumber: 1, baseTurnNumber: 0, campaignActiveTurnNumber: 0, campaignStateRevision: 1, stateEditRevision: null, narrationCorrectionRevision: null, baseTurnId: null, stateFingerprint: "a".repeat(64), narrationFingerprint: null, characterProfileRevision: 1, characterProfileFingerprint: "b".repeat(64) }
      : { operationKind: "append", expectedTurnNumber: 1, baseTurnNumber: 0, campaignActiveTurnNumber: 0, campaignStateRevision: 1, stateEditRevision: null, narrationCorrectionRevision: null, baseTurnId: null, stateFingerprint: "a".repeat(64), narrationFingerprint: null };
    return {
      authority: {
        rules: ["World rule."], worldCanon: { title: "World" }, selectedCharacterId: "mira",
        ...(version === "v3" ? { characterAuthority } : {}),
        currentContinuity: { continuitySummary: "", scratchpad: "", canonicalFacts: [], openThreads: [], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [] },
        scratchpad: "", openThreads: [], canonicalFacts: [], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [], latestTurn: null
      }, candidates: [], baseIdentity
    } as never;
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
  it("falls back to certified excerpt when an economical whole parent loses to protected authority", () => {
    const context = recentContext(); context.recentTurns = [];
    const content = `${"Old scenery. ".repeat(90)}The sapphire is hidden. Its hiding place is unknown to Vale. ${"More scenery. ".repeat(90)}`.trim();
    context.candidates = [{ id: "middle", turnId: "old", ordinal: 1, kind: "turn_fiction", content, tokenEstimate: 900, rank: 1,
      narrativeSource: { normalizationVersion: "story-fiction-source-v1", sourceHash: sha256(content), spans: [{ start: content.indexOf("The sapphire"), end: content.indexOf("The sapphire") + 22 }] } }];
    const policy = storyMemoryPolicySchema.parse({ ...defaultStoryMemoryPolicy("r2"), excerptPolicy: "verified_spans_v1" });
    const plan = () => planGenerationPromptContext(context, plannerProvider(), "System", "Find sapphire", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 8000, 7900, undefined, "story_memory", policy);
    let result = plan();
    for (let words = 0; words < 4500; words += 20) {
      context.authority.currentContinuity.continuitySummary = "History ".repeat(words);
      try { result = plan(); } catch { break; }
      if (result.promptContext.chronicle[0]?.evidenceForm === "excerpt") break;
    }
    expect(result.promptContext.chronicle[0]?.evidenceForm).toBe("excerpt");
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
