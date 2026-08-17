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
type StoryTurnFixture = ReturnType<typeof turns>[number];

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
    const boundaryTurn = { id: "turn-51", turnNumber: 51 } as unknown as typeof existing[number];
    const merged = mergeStoryTurnPages(existing, [boundaryTurn]);
    expect(merged).toEqual(existing);
    expect(merged).not.toBe(existing);
  });

  it("rejects a page limit other than the bounded default before fetching", async () => {
    const fetchPage = vi.fn();

    await expect(loadCompleteStoryHistory({
      campaignId: "campaign-1",
      turns: turns(1, 1),
      nextCursor: "before-1",
      pageLimit: 201,
      fetchPage
    })).rejects.toThrow("200");
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("rejects malformed page turns and cursors before merging", async () => {
    const missingTurnsPage = {
      campaignId: "campaign-1",
      nextCursor: null
    } as unknown as { campaignId: string; turns: StoryTurnFixture[]; nextCursor: string | null };
    await expect(loadCompleteStoryHistory({
      campaignId: "campaign-1",
      turns: turns(1, 1),
      nextCursor: "before-1",
      fetchPage: async () => missingTurnsPage
    })).rejects.toThrow("turns");

    await expect(loadCompleteStoryHistory({
      campaignId: "campaign-1",
      turns: turns(1, 1),
      nextCursor: "before-1",
      fetchPage: async () => ({ campaignId: "campaign-1", turns: turns(2, 2), nextCursor: "" })
    })).rejects.toThrow("cursor");
  });

  it("rejects missing ids and non-positive or non-integer turn numbers", () => {
    const missingIdTurn = { turnNumber: 1 } as unknown as StoryTurnFixture;
    expect(() => mergeStoryTurnPages([], [missingIdTurn])).toThrow("missing an id");
    expect(() => mergeStoryTurnPages([], [{ id: "turn-0", turnNumber: 0 }])).toThrow("invalid turn number");
    expect(() => mergeStoryTurnPages([], [{ id: "turn-fraction", turnNumber: 1.5 }])).toThrow("invalid turn number");
  });
});
