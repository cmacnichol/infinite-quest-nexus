import { describe, expect, it, vi } from "vitest";
import { normalizeSourceDocument } from "../../packages/domain/src/source-authoring.js";
import type { SourceFact } from "../../packages/contracts/src/source-authoring.js";
import { assembleSourceWorldProposal } from "../../packages/domain/src/source-world-proposal.js";
import { createRuntimeSourceAuthoringRequestBudget, RuntimeSourceAuthoringBudgetError } from "../../services/runtime/src/source-authoring-budget.js";
import { createSourceWorldAuthoringAdapter, renderSourceWorldProviderRequest } from "../../services/runtime/src/source-authoring-adapter.js";
import type { RuntimeTextExecution } from "../../services/runtime/src/provider-credential-transport-adapter.js";

const source = normalizeSourceDocument("world.txt", "Iris wears a blue coat.", "source-world-generation");
const citation = { sourceId: source.id, paragraphId: "paragraph:0", start: 0, end: 22, quote: "Iris wears a blue coat" };

function providerResult(content: string) {
  return { content, responseId: "source-world", finishReason: "stop" as const, outputLimited: false, modelInstanceId: "source-model", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, reportedCost: null, rawMetadata: {} };
}

function fact(id: string, value = "blue coat"): SourceFact {
  return { id, kind: "character", subject: "Iris", predicate: "clothing", value, provenance: "stated", citations: [citation] };
}

function selection(acceptedFacts: readonly SourceFact[], selectedCharacterFactIds: readonly string[] = []) {
  return {
    source, boundaryParagraphId: "paragraph:0", acceptedFacts, selectedCharacterFactIds,
    characterIdentityGroups: acceptedFacts.filter((candidate) => candidate.kind === "character").map((candidate) => ({ representativeFactId: candidate.id, factIds: [candidate.id] })),
    mode: "faithful" as const
  };
}

describe("source-world generation", () => {
  it("rejects the complete accepted selection when its actual serialized request exceeds the pinned budget", async () => {
    const acceptedFacts: SourceFact[] = Array.from({ length: 36 }, (_, index) => ({
      id: `fact:rule:${index}`, kind: "rule", subject: `Gate ${index}`, predicate: "rule", value: `Rule ${index} ${"x".repeat(80)}`,
      provenance: "stated", citations: [citation]
    }));
    const execute = vi.fn(async () => providerResult('{"fields":[],"characterFields":[]}'));
    const execution: RuntimeTextExecution = {
      id: "source-profile", name: "Source test", providerRole: "text", providerType: "openai_compatible", model: "source-model",
      contextWindowTokens: 1_000, maxOutputTokens: 100, temperature: 0, requestTimeoutMs: 30_000, configuration: {}, execute
    };
    const budget = createRuntimeSourceAuthoringRequestBudget(execution);
    const input = { selection: selection(acceptedFacts), reviewGeneration: 8, instructions: "Use every reviewed fact." };
    const body = budget.render(renderSourceWorldProviderRequest(input, false, []));

    expect(body).toContain(acceptedFacts[0]!.id);
    expect(body).toContain(acceptedFacts.at(-1)!.id);
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(budget.inputLimit);
    await expect(createSourceWorldAuthoringAdapter({ requestBudget: budget, delay: async () => undefined }).synthesizeSourceWorld(input))
      .rejects.toBeInstanceOf(RuntimeSourceAuthoringBudgetError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("repeats every accepted fact in a repaired source-world request and accepts the repaired closed response", async () => {
    const acceptedFacts = [fact("fact:iris"), { ...fact("fact:iris-hair", "black hair"), predicate: "hair" }];
    const initial = vi.fn(async () => providerResult("not JSON"));
    const repairs: unknown[] = [];
    const repair = vi.fn(async (request) => {
      repairs.push(request);
      return providerResult(JSON.stringify({ fields: [], characterFields: [{ selectedCharacterFactId: acceptedFacts[0]!.id, fields: [{ path: "profile.appearance.clothing", value: "blue coat", supportingFactIds: [acceptedFacts[0]!.id] }] }] }));
    });
    const input = { selection: selection(acceptedFacts, [acceptedFacts[0]!.id]), reviewGeneration: 9, instructions: "Use every reviewed fact." };
    const assembled = await createSourceWorldAuthoringAdapter({ requestBudget: { executeInitial: initial, executeRepair: repair }, delay: async () => undefined }).synthesizeSourceWorld(input);

    expect(initial).toHaveBeenCalledOnce();
    expect(repair).toHaveBeenCalledOnce();
    const repairedFrame = JSON.parse((repairs[0] as { input: string }).input) as { acceptedFacts: Array<{ id: string }> };
    expect(repairedFrame.acceptedFacts.map((candidate) => candidate.id)).toEqual(acceptedFacts.map((candidate) => candidate.id));
    expect(assembled.proposal.playableCharacters[0]?.profile?.appearance).toMatchObject({ clothing: "blue coat", hair: "" });
  });

  it("does not let a same-name identity support another selected character's field", () => {
    const north = fact("fact:iris-north");
    const south = { ...fact("fact:iris-south"), citations: [{ ...citation, start: 5, end: 22, quote: "wears a blue coat" }] };
    const separateIdentities = {
      source, boundaryParagraphId: "paragraph:0", acceptedFacts: [north, south], selectedCharacterFactIds: [north.id, south.id],
      characterIdentityGroups: [{ representativeFactId: north.id, factIds: [north.id] }, { representativeFactId: south.id, factIds: [south.id] }], mode: "faithful" as const
    };
    expect(() => assembleSourceWorldProposal(separateIdentities, {
      fields: [], characterFields: [{ selectedCharacterFactId: north.id, fields: [{ path: "profile.appearance.clothing", value: "blue coat", supportingFactIds: [south.id] }] }]
    })).toThrow(expect.objectContaining({
      reason: "source_world_unsupported_fact",
      path: ["characterFields", 0, "fields", 0, "supportingFactIds"]
    }));
  });
});
