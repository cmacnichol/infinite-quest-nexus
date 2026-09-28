import { describe, expect, it } from "vitest";
import { reserveNewestWholeSuffix } from "../../packages/application/src/memory/story-history-reservation.js";
import { estimateTokens } from "../../packages/domain/src/index.js";

type Entry = Readonly<{ turnNumber: number; direction: string }>;

function exactTokens(entries: readonly Entry[]): number {
  return estimateTokens(JSON.stringify({ envelope: "writer-and-reviewer", entries }));
}

function exhaustive(entries: readonly Entry[], budget: number): readonly Entry[] {
  for (let start = 0; start <= entries.length; start++) {
    const suffix = entries.slice(start);
    if (exactTokens(suffix) <= budget) return suffix;
  }
  return [];
}

describe("exact history reservation", () => {
  it("selects the same newest whole suffix as exhaustive exact serialization across budgets", () => {
    const entries = Array.from({ length: 9 }, (_, index) => ({ turnNumber: index + 1, direction: `intent-${index + 1}` }));
    for (let budget = 0; budget <= 200; budget++) {
      const reservation = reserveNewestWholeSuffix({
        entries,
        budgetTokens: budget,
        measureTokens: exactTokens
      });
      expect(reservation.entries).toEqual(exhaustive(entries, budget));
    }
  });

  it("uses bounded exact trials at the 512-entry source limit", () => {
    const entries = Array.from({ length: 512 }, (_, index) => ({ turnNumber: index + 1, direction: `intent-${index + 1}` }));
    const reservation = reserveNewestWholeSuffix({
      entries,
      budgetTokens: 4_000,
      measureTokens: (suffix) => JSON.stringify({ writerWrapper: true, reviewerManifest: true, entries: suffix }).length
    });

    expect(reservation.entries.length).toBeGreaterThan(0);
    expect(reservation.entries.length).toBeLessThan(entries.length);
    expect(reservation.trialCount).toBeLessThanOrEqual(12);
    expect(reservation.elapsedMilliseconds).toBeGreaterThanOrEqual(0);
  });

  it("admits an exact whole-entry fit and rejects the one-token-less boundary", () => {
    const entries = [{ turnNumber: 1, direction: "Open the sealed gate." }];
    const exact = exactTokens(entries);

    expect(reserveNewestWholeSuffix({ entries, budgetTokens: exact,
      measureTokens: exactTokens }).entries).toEqual(entries);
    expect(reserveNewestWholeSuffix({ entries, budgetTokens: exact - 1,
      measureTokens: exactTokens }).entries).toEqual([]);
  });
});
