import { describe, expect, it } from "vitest";
import {
  ContextBudgetError,
  assertOutputFeasible,
  planContext
} from "../../packages/story-engine/src/context-budget.js";

const stringify = (value: unknown) => JSON.stringify(value);
const count = (value: string) => value.length;

describe("context budget planning", () => {
  it("fails before serialization when protected context alone exceeds its ceiling", () => {
    expect(() => planContext({
      blocks: [{ id: "latest", revision: "1", content: "x".repeat(100), protected: true, priority: 0, ordinal: 1 }],
      contextLimit: 50,
      inputLimit: 1_000,
      count,
      serializeContext: stringify,
      serializeRequest: (context) => JSON.stringify({ context })
    })).toThrowError(/context_budget_exceeded/);
  });

  it("deduplicates identical revisions, rejects conflicting revisions, and packs optional records stably", () => {
    const plan = planContext({
      blocks: [
        { id: "late", revision: "1", content: "late", protected: false, priority: 1, ordinal: 2 },
        { id: "early", revision: "1", content: "early", protected: false, priority: 1, ordinal: 1 },
        { id: "protected", revision: "1", content: "rule", protected: true, priority: 99, ordinal: 0 },
        { id: "early", revision: "1", content: "early", protected: false, priority: 1, ordinal: 1 },
        { id: "oversized", revision: "1", content: "z".repeat(500), protected: false, priority: 0, ordinal: 3 }
      ],
      contextLimit: 350,
      inputLimit: 500,
      count,
      serializeContext: stringify,
      serializeRequest: (context) => JSON.stringify({ context })
    });

    expect(plan.selected.map((block) => block.id)).toEqual(["protected", "early", "late"]);
    expect(plan.omitted).toEqual([{ id: "oversized", revision: "1", reason: "context_limit" }]);

    expect(() => planContext({
      blocks: [
        { id: "same", revision: "1", content: "first", protected: false, priority: 0, ordinal: 1 },
        { id: "same", revision: "1", content: "second", protected: false, priority: 0, ordinal: 1 }
      ],
      contextLimit: 100,
      inputLimit: 100,
      count,
      serializeContext: stringify,
      serializeRequest: (context) => JSON.stringify({ context })
    })).toThrow(ContextBudgetError);
  });

  it("enforces the final request ceiling including immutable request framing once", () => {
    expect(() => planContext({
      blocks: [{ id: "latest", revision: "1", content: "ok", protected: true, priority: 0, ordinal: 1 }],
      contextLimit: 100,
      inputLimit: 20,
      safetyAllowanceTokens: 4,
      count,
      serializeContext: stringify,
      serializeRequest: (context) => JSON.stringify({ context, instructions: "immutable instruction framing" })
    })).toThrowError(/context_budget_exceeded/);
  });

  it("keeps a small request small under a large configured ceiling", () => {
    const plan = planContext({
      blocks: [{ id: "latest", revision: "1", content: "small", protected: true, priority: 0, ordinal: 1 }],
      contextLimit: 1_000_000,
      inputLimit: 1_000_000,
      count,
      serializeContext: stringify,
      serializeRequest: (context) => JSON.stringify({ context })
    });

    expect(plan.contextTokens).toBeLessThan(100);
    expect(plan.requestTokens).toBeLessThan(200);
  });

  it("reports token and extension-narration feasibility independently before transport", () => {
    try {
      assertOutputFeasible({
        inputTokens: 80,
        contextWindowTokens: 100,
        outputReserveTokens: 30,
        count,
        serializeOutput: stringify,
        output: { narration: "new", scratchpad: "", continuity_summary: "", canonical_facts: [], canonical_fact_updates: [], open_threads: [] }
      });
      throw new Error("Expected token feasibility to fail.");
    } catch (error) {
      expect(error).toMatchObject({ code: "context_budget_exceeded" });
    }

    try {
      assertOutputFeasible({
        inputTokens: 1,
        contextWindowTokens: 1_000,
        outputReserveTokens: 500,
        count,
        serializeOutput: stringify,
        output: { narration: "preserved", scratchpad: "unchanged", continuity_summary: "unchanged", canonical_facts: [], canonical_fact_updates: [], open_threads: [] },
        extension: { preservedNarration: "preserved narration", appendedNarration: "x", narrationCharacterLimit: 10 }
      });
      throw new Error("Expected extension narration feasibility to fail.");
    } catch (error) {
      expect(error).toMatchObject({ code: "extension_narration_limit_exceeded" });
    }
  });
});
