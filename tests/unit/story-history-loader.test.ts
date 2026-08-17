import { describe, expect, it, vi } from "vitest";
import {
  loadCompleteStoryHistory,
  mergeStoryTurnPages
} from "../../apps/web/src/story-history-loader.js";

const turns = (first: number, last: number) => Array.from(
  { length: last - first + 1 },
  (_, offset) => ({
    id: `turn-${first + offset}`,
    turnNumber: first + offset,
    narration: `Narration ${first + offset}`
  })
);

describe("legacy Story complete-history loader", () => {
  it("drains every cursor sequentially and returns turns 1 through 100", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({
        campaignId: "campaign-1",
        turns: turns(21, 50),
        nextCursor: "before-21"
      })
      .mockResolvedValueOnce({
        campaignId: "campaign-1",
        turns: turns(1, 20),
        nextCursor: null
      });
    const progress: number[] = [];

    const result = await loadCompleteStoryHistory({
      campaignId: "campaign-1",
      turns: turns(51, 100),
      nextCursor: "before-51",
      fetchPage,
      onProgress: ({ loadedTurnCount }) => progress.push(loadedTurnCount)
    });

    expect(fetchPage.mock.calls).toEqual([
      [{ before: "before-51", limit: 200 }],
      [{ before: "before-21", limit: 200 }]
    ]);
    expect(result.nextCursor).toBeNull();
    expect(result.turns.map((turn) => turn.turnNumber)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1)
    );
    expect(progress).toEqual([80, 100]);
  });

  it("does not mutate the original window when a later page fails", async () => {
    const initialTurns = turns(51, 100);
    const originalIds = initialTurns.map((turn) => turn.id);
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ campaignId: "campaign-1", turns: turns(21, 50), nextCursor: "before-21" })
      .mockRejectedValueOnce(new Error("page unavailable"));

    await expect(loadCompleteStoryHistory({
      campaignId: "campaign-1",
      turns: initialTurns,
      nextCursor: "before-51",
      fetchPage
    })).rejects.toThrow("page unavailable");
    expect(initialTurns.map((turn) => turn.id)).toEqual(originalIds);
    expect(initialTurns).toHaveLength(50);
  });

  it("rejects campaign mismatch, cursor loops, and conflicting turn identity", async () => {
    await expect(loadCompleteStoryHistory({
      campaignId: "campaign-1",
      turns: turns(51, 100),
      nextCursor: "before-51",
      fetchPage: async () => ({ campaignId: "campaign-2", turns: turns(1, 50), nextCursor: null })
    })).rejects.toThrow("campaign-2");

    await expect(loadCompleteStoryHistory({
      campaignId: "campaign-1",
      turns: turns(51, 100),
      nextCursor: "before-51",
      fetchPage: async () => ({ campaignId: "campaign-1", turns: turns(1, 50), nextCursor: "before-51" })
    })).rejects.toThrow("before-51");

    expect(() => mergeStoryTurnPages(
      [{ id: "turn-51", turnNumber: 51 }],
      [{ id: "different-id", turnNumber: 51 }]
    )).toThrow("turn number 51");
    expect(() => mergeStoryTurnPages(
      [{ id: "turn-51", turnNumber: 51 }],
      [{ id: "turn-51", turnNumber: 50 }]
    )).toThrow("turn-51");
  });

  it("deduplicates an identical boundary turn without replacing the richer existing object", () => {
    const existing = [{ id: "turn-51", turnNumber: 51, narration: "rich" }];
    const merged = mergeStoryTurnPages(existing, [{ id: "turn-51", turnNumber: 51 }]);
    expect(merged).toEqual(existing);
    expect(merged).not.toBe(existing);
  });
});
