import { describe, expect, it } from "vitest";
import type { ReaderHistoryResponse } from "@infinite-quest/contracts";
import {
  beginStoryHistorySearch,
  beginStoryHistorySearchPage,
  createStoryHistorySearchState,
  normalizeStoryHistorySearchQuery,
  settleStoryHistorySearch,
  validateStoryHistoryJumpTarget
} from "../../../packages/client-core/src/story-history-search.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const otherCampaignId = "22222222-2222-4222-8222-222222222222";
const acceptedAt = "2026-10-03T12:34:56.000Z";

function response(query: string, turnNumbers: readonly number[], nextCursor: string | null = null): ReaderHistoryResponse {
  return {
    campaignId,
    items: turnNumbers.map(turnNumber => ({
      id: `00000000-0000-4000-8000-${String(turnNumber).padStart(12, "0")}`,
      turnNumber,
      acceptedAt,
      excerpt: `${query} result for ${turnNumber}`
    })),
    nextCursor
  };
}

describe("story history search policy", () => {
  it("uses the shared trim and length contract without changing internal whitespace or truncating", () => {
    expect(normalizeStoryHistorySearchQuery("  platform   phrase \n")).toEqual({
      query: "platform   phrase",
      valid: true
    });
    expect(normalizeStoryHistorySearchQuery("x".repeat(201))).toEqual({
      query: "x".repeat(201),
      valid: false
    });
    expect(normalizeStoryHistorySearchQuery("  ")).toEqual({ query: "", valid: true });
  });

  it("resets opaque cursors when the normalized query, campaign, or load epoch changes", () => {
    const initial = beginStoryHistorySearch(createStoryHistorySearchState(), { campaignId, loadEpoch: 4 }, "alpha");
    expect(initial.request).not.toBeNull();
    const firstPage = settleStoryHistorySearch(initial.state, initial.request!, {
      type: "success",
      response: response("alpha", [12], "opaque-alpha-next")
    });

    const queryChanged = beginStoryHistorySearch(firstPage, { campaignId, loadEpoch: 4 }, "beta");
    expect(queryChanged.request?.query).toBe("beta");
    expect(queryChanged.request?.before).toBeNull();
    expect(queryChanged.request?.queryEpoch).toBeGreaterThan(initial.request!.queryEpoch);
    expect(queryChanged.state.items).toEqual([]);

    const campaignChanged = beginStoryHistorySearch(firstPage, { campaignId: otherCampaignId, loadEpoch: 4 }, "alpha");
    expect(campaignChanged.request?.campaignId).toBe(otherCampaignId);
    expect(campaignChanged.request?.before).toBeNull();
    expect(campaignChanged.state.items).toEqual([]);

    const loadChanged = beginStoryHistorySearch(firstPage, { campaignId, loadEpoch: 5 }, "alpha");
    expect(loadChanged.request?.loadEpoch).toBe(5);
    expect(loadChanged.request?.before).toBeNull();
    expect(loadChanged.state.items).toEqual([]);
  });

  it("uses fresh request identities for More and retries while More replaces rather than accumulates pages", () => {
    const first = beginStoryHistorySearch(createStoryHistorySearchState(), { campaignId, loadEpoch: 1 }, "alpha");
    const firstPage = settleStoryHistorySearch(first.state, first.request!, {
      type: "success",
      response: response("alpha", [12], "opaque-cursor-A")
    });
    const more = beginStoryHistorySearchPage(firstPage, "more");
    expect(more.request?.before).toBe("opaque-cursor-A");
    expect(more.request?.requestId).toBeGreaterThan(first.request!.requestId);
    expect(more.request?.queryEpoch).toBe(first.request!.queryEpoch);

    const pageTwo = settleStoryHistorySearch(more.state, more.request!, {
      type: "success",
      response: response("alpha", [11], "opaque-cursor-B")
    });
    expect(pageTwo.items.map(item => item.turnNumber)).toEqual([11]);
    const failedMore = beginStoryHistorySearchPage(pageTwo, "more");
    const failedState = settleStoryHistorySearch(failedMore.state, failedMore.request!, { type: "request-error" });
    expect(failedState.status).toBe("error");
    expect(failedState.errorKind).toBe("request");
    expect(failedState.items.map(item => item.turnNumber)).toEqual([11]);

    const retry = beginStoryHistorySearchPage(failedState, "retry");
    expect(retry.request?.before).toBe("opaque-cursor-B");
    expect(retry.request?.requestId).toBeGreaterThan(failedMore.request!.requestId);
  });

  it("retries conflicts from the first page without reusing a stale cursor", () => {
    const first = beginStoryHistorySearch(createStoryHistorySearchState(), { campaignId, loadEpoch: 1 }, "alpha");
    const initial = settleStoryHistorySearch(first.state, first.request!, {
      type: "success",
      response: response("alpha", [12], "stale-cursor")
    });
    const more = beginStoryHistorySearchPage(initial, "more");
    const conflict = settleStoryHistorySearch(more.state, more.request!, { type: "conflict" });
    expect(conflict.status).toBe("error");
    expect(conflict.errorKind).toBe("conflict");
    expect(conflict.items.map(item => item.turnNumber)).toEqual([12]);

    const retry = beginStoryHistorySearchPage(conflict, "retry");
    expect(retry.request?.before).toBeNull();
    expect(retry.request?.requestId).toBeGreaterThan(more.request!.requestId);
  });

  it("distinguishes an empty success from retryable transport and bounded protocol failures", () => {
    const emptyRequest = beginStoryHistorySearch(createStoryHistorySearchState(), { campaignId, loadEpoch: 1 }, "none");
    const empty = settleStoryHistorySearch(emptyRequest.state, emptyRequest.request!, {
      type: "success",
      response: response("none", [])
    });
    expect(empty.status).toBe("empty");
    expect(empty.errorKind).toBeNull();
    expect(empty.items).toEqual([]);

    const failedRequest = beginStoryHistorySearch(emptyRequest.state, { campaignId, loadEpoch: 1 }, "network");
    const failed = settleStoryHistorySearch(failedRequest.state, failedRequest.request!, { type: "request-error" });
    expect(failed.status).toBe("error");
    expect(failed.errorKind).toBe("request");

    const mismatchRequest = beginStoryHistorySearch(emptyRequest.state, { campaignId, loadEpoch: 1 }, "wrong-scope");
    const mismatched = settleStoryHistorySearch(mismatchRequest.state, mismatchRequest.request!, {
      type: "success",
      response: { ...response("wrong-scope", []), campaignId: otherCampaignId }
    });
    expect(mismatched.status).toBe("error");
    expect(mismatched.errorKind).toBe("scope");
    expect(mismatched.items).toEqual([]);

    const oversizedRequest = beginStoryHistorySearch(emptyRequest.state, { campaignId, loadEpoch: 1 }, "oversized");
    const oversized = settleStoryHistorySearch(oversizedRequest.state, oversizedRequest.request!, {
      type: "success",
      response: response("oversized", Array.from({ length: 51 }, (_, index) => index + 1))
    });
    expect(oversized.status).toBe("error");
    expect(oversized.errorKind).toBe("protocol");
    expect(oversized.items).toEqual([]);
  });

  it("ignores stale success and stale error after a request is replaced or search is cleared and reopened", () => {
    const first = beginStoryHistorySearch(createStoryHistorySearchState(), { campaignId, loadEpoch: 9 }, "same query");
    const newer = beginStoryHistorySearch(first.state, { campaignId, loadEpoch: 9 }, "new query");
    const newerState = settleStoryHistorySearch(newer.state, newer.request!, {
      type: "success",
      response: response("new query", [13])
    });
    expect(settleStoryHistorySearch(newerState, first.request!, {
      type: "success",
      response: response("same query", [12])
    })).toBe(newerState);
    expect(settleStoryHistorySearch(newerState, first.request!, { type: "request-error" })).toBe(newerState);

    const pending = beginStoryHistorySearch(newerState, { campaignId, loadEpoch: 9 }, "same query");
    const cleared = beginStoryHistorySearch(pending.state, { campaignId, loadEpoch: 9 }, "");
    const reopened = beginStoryHistorySearch(cleared.state, { campaignId, loadEpoch: 9 }, "same query");
    expect(reopened.request?.requestId).toBeGreaterThan(pending.request!.requestId);
    expect(settleStoryHistorySearch(reopened.state, pending.request!, {
      type: "success",
      response: response("same query", [12])
    })).toBe(reopened.state);

    const resetFirst = beginStoryHistorySearch(createStoryHistorySearchState(), { campaignId, loadEpoch: 9 }, "first query");
    const resetSecond = beginStoryHistorySearch(resetFirst.state, { campaignId, loadEpoch: 9 }, "second query");
    const resetController = beginStoryHistorySearch(resetSecond.state, { campaignId, loadEpoch: 9 }, "same query");
    expect(resetController.request?.requestId).toBe(pending.request?.requestId);
    expect(resetController.request).not.toBe(pending.request);
    expect(settleStoryHistorySearch(resetController.state, pending.request!, {
      type: "success",
      response: response("same query", [12])
    })).toBe(resetController.state);
  });

  it("accepts only a positive integer jump within the known latest accepted turn", () => {
    expect(validateStoryHistoryJumpTarget("1", 317)).toEqual({ valid: true, turnNumber: 1 });
    expect(validateStoryHistoryJumpTarget(" 317 ", 317)).toEqual({ valid: true, turnNumber: 317 });
    for (const value of ["", "0", "-1", "1.5", "3e2", "318", "9007199254740992"]) {
      expect(validateStoryHistoryJumpTarget(value, 317).valid).toBe(false);
    }
  });
});
