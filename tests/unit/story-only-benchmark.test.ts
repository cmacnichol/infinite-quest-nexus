import { describe, expect, it } from "vitest";
import { summarizeStoryOnlyBenchmark } from "../../scripts/benchmark-story-only.js";

describe("story-only benchmark summary", () => {
  it("counts dispatched operations, failures, and distinct operation groups from observed samples", () => {
    const summary = summarizeStoryOnlyBenchmark([
      {
        setupMs: 30,
        durationMs: 0,
        operations: ["story_generation"],
        committed: true,
        failures: 0,
        requestTokens: 120,
        outputTokens: 40,
        providerReportedTokens: 160
      },
      {
        setupMs: 40,
        durationMs: 100,
        operations: ["story_generation", "story_choice_repair"],
        committed: true,
        failures: 1,
        requestTokens: 120,
        outputTokens: 40,
        providerReportedTokens: null
      },
      {
        setupMs: 50,
        durationMs: 100,
        operations: ["story_generation"],
        committed: false,
        failures: 2,
        requestTokens: 120,
        outputTokens: 0,
        providerReportedTokens: 120
      }
    ]);

    expect(summary.setupMs).toEqual({ p50: 40, p95: 50 });
    expect(summary.latencyMs).toEqual({ p50: 100, p95: 100 });
    expect(summary.operationCounts).toEqual({ story_generation: 3, story_choice_repair: 1 });
    expect(summary.failureCount).toBe(3);
    expect(summary.operationGroups).toEqual({
      story_generation: 2,
      "story_generation -> story_choice_repair": 1
    });
    expect(summary.estimatedTokens).toEqual({ request: 360, output: 80 });
    expect(summary.providerReportedTokens).toBeNull();
    expect(summary.committedSamples).toBe(2);
    expect(summary.uncommittedSamples).toBe(1);
  });
});
