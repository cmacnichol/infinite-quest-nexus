import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const evidenceDirectory = ".superpowers/sdd/legacy-ui-2026-10-03/evidence/T15/search";
const historyControls = {
  search: "#turnHistorySearch",
  clearSearch: "#btnTurnHistorySearchClear",
  searchStatus: "#turnHistorySearchStatus",
  results: "#turnHistorySearchResults",
  result: "[data-history-turn-number]",
  loadMore: "#btnTurnHistorySearchMore",
  jumpNumber: "#turnHistoryJumpNumber",
  jumpExact: "#btnTurnHistoryJumpExact",
  retrySearch: "#btnTurnHistorySearchRetry"
} as const;

interface CapturedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly url: string;
}

interface HistoryItem {
  readonly id: string;
  readonly turnNumber: number;
  readonly acceptedAt: string;
  readonly excerpt: string;
}

function watchRequests(page: Page): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    requests.push({ method: request.method(), pathname: url.pathname, url: request.url() });
  });
  return requests;
}

function searchPath(campaignId: string): string {
  return `/api/v1/campaigns/${campaignId}/reader/history`;
}

function exactTurnPath(campaignId: string, turnNumber: number): string {
  return `/api/v1/campaigns/${campaignId}/reader/turns/${turnNumber}`;
}

function historicalStateRequests(requests: CapturedRequest[], campaignId: string, turnNumber: number): CapturedRequest[] {
  const currentStatePath = `/api/v1/campaigns/${campaignId}/state`;
  return requests.filter(request => {
    const url = new URL(request.url);
    return request.method === "GET"
      && (request.pathname === currentStatePath || request.pathname === `${currentStatePath}/inspection`)
      && url.searchParams.get("turnNumber") === String(turnNumber);
  });
}

function historyItem(turn: Record<string, unknown>, excerpt = String(turn.action ?? turn.narration ?? "")): HistoryItem {
  return {
    id: String(turn.id),
    turnNumber: Number(turn.turnNumber),
    acceptedAt: String(turn.acceptedAt),
    excerpt: excerpt.slice(0, 240)
  };
}

async function prepareStoryPage(page: Page, campaignId: string): Promise<void> {
  const html = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`${origin}/story/${campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
}

async function openHistory(page: Page): Promise<void> {
  await page.locator("[data-story-reader-toolbar]").getByRole("button", { name: "History" }).click();
  await expect(page.locator("#turnHistoryDialog")).toHaveAttribute("open", "");
}

async function enterSearch(page: Page, query: string): Promise<void> {
  await page.locator(historyControls.search).fill(query);
}

function queryRequests(requests: readonly CapturedRequest[], campaignId: string): CapturedRequest[] {
  return requests.filter(request => request.pathname === searchPath(campaignId));
}

function turnRequests(requests: readonly CapturedRequest[], campaignId: string): CapturedRequest[] {
  return requests.filter(request => request.pathname.startsWith(`/api/v1/campaigns/${campaignId}/reader/turns/`));
}

function ledgerPageRequests(requests: readonly CapturedRequest[], campaignId: string): CapturedRequest[] {
  const path = `/api/v1/campaigns/${campaignId}/turns`;
  return requests.filter(request => {
    const url = new URL(request.url);
    return url.pathname === path && url.searchParams.has("before");
  });
}

test("search finds an unloaded old turn in a 317-turn campaign and safely renders literal text", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const oldTurn = fixture.turns[11]!;
  const phrase = "T15-UNLOADED-PLATFORM-CHALK-PHRASE";
  oldTurn.action = `Find the ${phrase}.`;
  oldTurn.narration = `The ${phrase} leads to the quiet station.`;
  const maliciousLookingExcerpt = '<img src=x onerror="window.__t15Executed=true">';
  const requests = watchRequests(page);
  await installLegacyUiFixture(page, fixture);
  await page.addInitScript(() => { (window as typeof window & { __t15Executed?: boolean }).__t15Executed = false; });
  await page.route(`**${searchPath(fixture.campaignId)}**`, async route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("q")).toContain(phrase);
    expect(url.searchParams.get("limit")).toBe("50");
    await route.fulfill({
      contentType: "application/json",
      json: { campaignId: fixture.campaignId, items: [historyItem(oldTurn, maliciousLookingExcerpt)], nextCursor: null }
    });
  });
  await page.route(`**${exactTurnPath(fixture.campaignId, 12)}`, route => route.fulfill({
    contentType: "application/json",
    json: { campaignId: fixture.campaignId, turn: oldTurn }
  }));
  await prepareStoryPage(page, fixture.campaignId);
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await openHistory(page);
  expect(await page.locator("#turnHistoryModalList .history-card").count()).toBeLessThanOrEqual(50);
  expect(ledgerPageRequests(requests, fixture.campaignId)).toHaveLength(0);

  await enterSearch(page, phrase);
  const result = page.locator(`${historyControls.results} ${historyControls.result}[data-history-turn-number="12"]`);
  await expect(result).toBeVisible();
  await expect(result.locator(".history-search-result-excerpt")).toHaveText(maliciousLookingExcerpt);
  expect(await result.locator("img, script, [onerror], [onclick]").count()).toBe(0);
  expect(await page.evaluate(() => (window as typeof window & { __t15Executed?: boolean }).__t15Executed)).toBe(false);
  expect(await page.locator(`${historyControls.results} ${historyControls.result}`).count()).toBeLessThanOrEqual(50);
  expect(ledgerPageRequests(requests, fixture.campaignId)).toHaveLength(0);
  await mkdir(evidenceDirectory, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: `${evidenceDirectory}/unloaded-search-desktop.png`, fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${evidenceDirectory}/unloaded-search-mobile.png`, fullPage: false });

  await result.click();
  await expect.poll(() => turnRequests(requests, fixture.campaignId).length).toBe(1);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 12 of 317");
  await expect(page.locator("#turnHistoryDialog")).not.toHaveAttribute("open", "");
  expect(ledgerPageRequests(requests, fixture.campaignId)).toHaveLength(0);
  await expect(page.locator("#btnReaderHistory")).toBeFocused();
});

test("search on a 2000-turn campaign renders at most one 50-result page", async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = legacyUiFixture({ turnCount: 2000, worldCount: 1, campaignCount: 1 });
  const requests = watchRequests(page);
  await installLegacyUiFixture(page, fixture);
  await page.route(`**${searchPath(fixture.campaignId)}**`, async route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("limit")).toBe("50");
    const items = fixture.turns.slice(0, 50).map(turn => historyItem(turn));
    await route.fulfill({
      contentType: "application/json",
      json: { campaignId: fixture.campaignId, items, nextCursor: "opaque-t15-next" }
    });
  });
  await prepareStoryPage(page, fixture.campaignId);
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#storySyncStatus")).toContainText("Story synced");
  await openHistory(page);
  await enterSearch(page, "synthetic");
  await expect(page.locator(`${historyControls.results} ${historyControls.result}`)).toHaveCount(50);
  expect(await page.locator(`${historyControls.results} ${historyControls.result}`).count()).toBeLessThanOrEqual(50);
  expect(queryRequests(requests, fixture.campaignId)).toHaveLength(1);
  expect(ledgerPageRequests(requests, fixture.campaignId)).toHaveLength(0);
});

test("history search debounces for 250ms and resets its opaque cursor when the query changes", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const requests = watchRequests(page);
  await installLegacyUiFixture(page, fixture);
  await page.route(`**${searchPath(fixture.campaignId)}**`, async route => {
    const url = new URL(route.request().url());
    const before = url.searchParams.get("before");
    const item = historyItem(fixture.turns[before ? 10 : url.searchParams.get("q") === "query beta" ? 12 : 11]!);
    await route.fulfill({
      contentType: "application/json",
      json: { campaignId: fixture.campaignId, items: [item], nextCursor: before ? null : "opaque-query-a-next" }
    });
  });
  await prepareStoryPage(page, fixture.campaignId);
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#storySyncStatus")).toContainText("Story synced");
  await openHistory(page);

  await enterSearch(page, "query alpha");
  await page.waitForTimeout(180);
  expect(queryRequests(requests, fixture.campaignId)).toHaveLength(0);
  await expect.poll(() => queryRequests(requests, fixture.campaignId).length).toBe(1);
  const firstQuery = new URL(queryRequests(requests, fixture.campaignId)[0]!.url);
  expect(firstQuery.searchParams.get("q")).toBe("query alpha");

  await page.locator(historyControls.loadMore).click();
  await expect.poll(() => queryRequests(requests, fixture.campaignId).length).toBe(2);
  const secondQuery = new URL(queryRequests(requests, fixture.campaignId)[1]!.url);
  expect(secondQuery.searchParams.get("before")).toBe("opaque-query-a-next");
  await expect(page.locator(`${historyControls.results} ${historyControls.result}`)).toHaveAttribute("data-history-turn-number", "11");
  await expect(page.locator(`${historyControls.results} ${historyControls.result}`)).toHaveCount(1);

  await enterSearch(page, "query beta");
  await expect.poll(() => queryRequests(requests, fixture.campaignId).length).toBe(3);
  const resetQuery = new URL(queryRequests(requests, fixture.campaignId)[2]!.url);
  expect(resetQuery.searchParams.get("q")).toBe("query beta");
  expect(resetQuery.searchParams.has("before")).toBe(false);
  await expect(page.locator(historyControls.search)).toBeFocused();

  const requestsBeforeClear = queryRequests(requests, fixture.campaignId).length;
  await page.locator(historyControls.clearSearch).click();
  await expect(page.locator(historyControls.search)).toHaveValue("");
  await expect(page.locator(`${historyControls.results} ${historyControls.result}`)).toHaveCount(0);
  expect(queryRequests(requests, fixture.campaignId)).toHaveLength(requestsBeforeClear);
});

test("query replacement aborts old history requests and keeps the newest results displayed", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const requests = watchRequests(page);
  const slowStarted = new Map<string, Promise<void>>();
  const markSlowStarted = new Map<string, () => void>();
  const releaseSlow = new Map<string, () => void>();
  const slowReleased = new Map<string, Promise<void>>();
  const markSlowReleased = new Map<string, () => void>();
  const abortedSlowRequests = new Set<string>();
  const slowRequestFailures = new Map<string, string>();
  page.on("requestfailed", request => {
    const url = new URL(request.url());
    if (url.pathname !== searchPath(fixture.campaignId)) return;
    const query = url.searchParams.get("q") ?? "";
    if (query.startsWith("slow-")) {
      abortedSlowRequests.add(query);
      slowRequestFailures.set(query, request.failure()?.errorText ?? "");
    }
  });
  for (const query of ["slow-success", "slow-error"]) {
    let markStarted!: () => void;
    let release!: () => void;
    let markReleased!: () => void;
    slowStarted.set(query, new Promise<void>(resolve => { markStarted = resolve; }));
    slowReleased.set(query, new Promise<void>(resolve => { markReleased = resolve; }));
    markSlowStarted.set(query, markStarted);
    markSlowReleased.set(query, markReleased);
    const releaseGate = new Promise<void>(resolve => { release = resolve; });
    releaseSlow.set(`${query}:gate`, release);
    slowStarted.set(`${query}:gate`, releaseGate);
  }
  await installLegacyUiFixture(page, fixture);
  await page.route(`**${searchPath(fixture.campaignId)}**`, async route => {
    const query = new URL(route.request().url()).searchParams.get("q") ?? "";
    if (query.startsWith("slow-")) {
      markSlowStarted.get(query)?.();
      await slowStarted.get(`${query}:gate`);
      try {
        if (!abortedSlowRequests.has(query)) {
          const turnNumber = query === "slow-success" ? 12 : 15;
          await route.fulfill({
            contentType: "application/json",
            json: { campaignId: fixture.campaignId, items: [historyItem(fixture.turns[turnNumber - 1]!)], nextCursor: null }
          });
        }
      } finally {
        markSlowReleased.get(query)?.();
      }
      return;
    }
    const turnNumber = query === "newer-success" ? 13 : 14;
    await route.fulfill({
      contentType: "application/json",
      json: { campaignId: fixture.campaignId, items: [historyItem(fixture.turns[turnNumber - 1]!)], nextCursor: null }
    });
  });
  await prepareStoryPage(page, fixture.campaignId);
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#storySyncStatus")).toContainText("Story synced");
  await page.locator("#freeAction").fill("Draft survives replacement of a history request.");
  await openHistory(page);

  try {
    await enterSearch(page, "slow-success");
    await expect.poll(() => queryRequests(requests, fixture.campaignId).some(request => new URL(request.url).searchParams.get("q") === "slow-success")).toBe(true);
    await slowStarted.get("slow-success");
    await enterSearch(page, "newer-success");
    await expect(page.locator(`${historyControls.results} [data-history-turn-number="13"]`)).toBeVisible();
    await expect.poll(() => abortedSlowRequests.has("slow-success")).toBe(true);
    expect(slowRequestFailures.get("slow-success")).toContain("ERR_ABORTED");
    releaseSlow.get("slow-success:gate")?.();
    await slowReleased.get("slow-success");
    await expect(page.locator(`${historyControls.results} ${historyControls.result}`)).toHaveAttribute("data-history-turn-number", "13");
    await expect(page.locator(historyControls.searchStatus)).toHaveAttribute("data-state", "results");
    await expect(page.locator(historyControls.search)).toHaveValue("newer-success");
    await expect(page.locator("#freeAction")).toHaveValue("Draft survives replacement of a history request.");

    await enterSearch(page, "slow-error");
    await expect.poll(() => queryRequests(requests, fixture.campaignId).some(request => new URL(request.url).searchParams.get("q") === "slow-error")).toBe(true);
    await slowStarted.get("slow-error");
    await enterSearch(page, "newer-after-error");
    await expect(page.locator(`${historyControls.results} [data-history-turn-number="14"]`)).toBeVisible();
    await expect.poll(() => abortedSlowRequests.has("slow-error")).toBe(true);
    expect(slowRequestFailures.get("slow-error")).toContain("ERR_ABORTED");
    releaseSlow.get("slow-error:gate")?.();
    await slowReleased.get("slow-error");
    await expect(page.locator(`${historyControls.results} ${historyControls.result}`)).toHaveAttribute("data-history-turn-number", "14");
    await expect(page.locator(historyControls.searchStatus)).toHaveAttribute("data-state", "results");
    await expect(page.locator(historyControls.search)).toHaveValue("newer-after-error");
    await expect(page.locator(historyControls.searchStatus)).not.toContainText("PRIVATE_T15_SEARCH_CANARY");
    await expect(page.locator("#freeAction")).toHaveValue("Draft survives replacement of a history request.");
    expect(ledgerPageRequests(requests, fixture.campaignId)).toHaveLength(0);
  } finally {
    releaseSlow.get("slow-success:gate")?.();
    releaseSlow.get("slow-error:gate")?.();
  }
});

test("exact jump makes one lookup, preserves the composer on success, and rejects invalid numbers without requests", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const requests = watchRequests(page);
  await installLegacyUiFixture(page, fixture);
  await page.route(`**${exactTurnPath(fixture.campaignId, 40)}`, route => route.fulfill({
    contentType: "application/json",
    json: { campaignId: fixture.campaignId, turn: fixture.turns[39] }
  }));
  await prepareStoryPage(page, fixture.campaignId);
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await page.locator("#freeAction").fill("Draft survives an exact history jump.");
  await openHistory(page);

  const jumpNumber = page.locator(historyControls.jumpNumber);
  for (const invalid of ["0", "1.5", "318"]) {
    await jumpNumber.fill(invalid);
    await page.locator(historyControls.jumpExact).click();
    expect(turnRequests(requests, fixture.campaignId)).toHaveLength(0);
    await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  }

  await jumpNumber.fill("40");
  await page.locator(historyControls.jumpExact).click();
  await expect.poll(() => turnRequests(requests, fixture.campaignId).length).toBe(1);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 40 of 317");
  await expect(page.locator("#freeAction")).toHaveValue("Draft survives an exact history jump.");
  expect(ledgerPageRequests(requests, fixture.campaignId)).toHaveLength(0);
  await expect(page.locator("#turnHistoryDialog")).not.toHaveAttribute("open", "");
});

test("search errors and failed exact jumps remain distinct from empty results and retain the draft", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const requests = watchRequests(page);
  await installLegacyUiFixture(page, fixture);
  await page.route(`**${searchPath(fixture.campaignId)}**`, route => {
    const url = new URL(route.request().url());
    const query = url.searchParams.get("q");
    if (query === "empty") return route.fulfill({ contentType: "application/json", json: { campaignId: fixture.campaignId, items: [], nextCursor: null } });
    if (query === "conflict") {
      if (!url.searchParams.has("before")) return route.fulfill({
        contentType: "application/json",
        json: { campaignId: fixture.campaignId, items: [historyItem(fixture.turns[11]!)], nextCursor: "opaque-stale-conflict-cursor" }
      });
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        json: { error: "PRIVATE_T15_CONFLICT_CANARY", message: "private history revision details" }
      });
    }
    return route.abort("failed");
  });
  await page.route(`**${exactTurnPath(fixture.campaignId, 40)}`, route => route.fulfill({
    status: 404,
    contentType: "application/json",
    json: { error: "PRIVATE_T15_MISSING_CANARY", message: "private lookup storage details" }
  }));
  await prepareStoryPage(page, fixture.campaignId);
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await page.locator("#freeAction").fill("Draft remains after history failures.");
  await openHistory(page);

  await enterSearch(page, "empty");
  await expect(page.locator(historyControls.searchStatus)).toContainText("No matching turns");
  await expect(page.locator(historyControls.retrySearch)).toBeHidden();
  const queryCountAfterEmpty = queryRequests(requests, fixture.campaignId).length;

  await enterSearch(page, "conflict");
  await expect(page.locator(`${historyControls.results} ${historyControls.result}`)).toHaveCount(1);
  await page.locator(historyControls.loadMore).click();
  await expect(page.locator(historyControls.searchStatus)).toHaveAttribute("data-state", "error");
  await expect(page.locator(historyControls.searchStatus)).not.toContainText("No matching turns");
  await expect(page.locator(historyControls.searchStatus)).not.toContainText("PRIVATE_T15_CONFLICT_CANARY");
  await expect(page.locator(historyControls.retrySearch)).toBeVisible();
  expect(queryRequests(requests, fixture.campaignId)).toHaveLength(queryCountAfterEmpty + 2);
  await page.locator(historyControls.retrySearch).click();
  await expect.poll(() => queryRequests(requests, fixture.campaignId).length).toBe(queryCountAfterEmpty + 3);
  expect(new URL(queryRequests(requests, fixture.campaignId).at(-1)!.url).searchParams.has("before")).toBe(false);
  await expect(page.locator(historyControls.searchStatus)).toHaveAttribute("data-state", "results");

  await enterSearch(page, "offline");
  await expect(page.locator(historyControls.searchStatus)).toHaveAttribute("data-state", "error");
  await expect(page.locator(historyControls.searchStatus)).not.toContainText("No matching turns");
  await expect(page.locator(historyControls.searchStatus)).not.toContainText("PRIVATE_T15");
  await expect(page.locator(historyControls.retrySearch)).toBeVisible();

  const requestsBeforeOversized = queryRequests(requests, fixture.campaignId).length;
  await enterSearch(page, "x".repeat(201));
  await expect(page.locator(historyControls.searchStatus)).toHaveAttribute("data-state", "invalid");
  expect(queryRequests(requests, fixture.campaignId)).toHaveLength(requestsBeforeOversized);
  await page.locator(historyControls.clearSearch).click();

  await page.locator(historyControls.jumpNumber).fill("40");
  await page.locator(historyControls.jumpExact).click();
  await expect.poll(() => turnRequests(requests, fixture.campaignId).length).toBe(1);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await expect(page.locator("#freeAction")).toHaveValue("Draft remains after history failures.");
  await expect(page.locator("#turnHistoryDialog")).toHaveAttribute("open", "");
  await expect(page.locator("#turnHistoryLoadStatus")).not.toContainText("PRIVATE_T15_MISSING_CANARY");
  expect(ledgerPageRequests(requests, fixture.campaignId)).toHaveLength(0);
});

test("selecting a result does not inspect state; Inspect stays explicit and keyboard focus returns to History", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const requests = watchRequests(page);
  await installLegacyUiFixture(page, fixture);
  await page.route(`**${searchPath(fixture.campaignId)}**`, route => route.fulfill({
    contentType: "application/json",
    json: { campaignId: fixture.campaignId, items: [historyItem(fixture.turns[11]!)], nextCursor: null }
  }));
  await page.route(`**${exactTurnPath(fixture.campaignId, 12)}`, route => route.fulfill({
    contentType: "application/json",
    json: { campaignId: fixture.campaignId, turn: fixture.turns[11] }
  }));
  await prepareStoryPage(page, fixture.campaignId);
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#storySyncStatus")).toContainText("Story synced");
  await openHistory(page);
  await enterSearch(page, "platform");
  const result = page.locator(`${historyControls.results} [data-history-turn-number="12"]`);
  await expect(result).toBeVisible();
  await result.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 12 of 317");
  expect(historicalStateRequests(requests, fixture.campaignId, 12)).toHaveLength(0);

  await openHistory(page);
  await page.locator("#btnTurnHistoryInspect").click();
  await expect.poll(() => historicalStateRequests(requests, fixture.campaignId, 12).length).toBe(1);
  expect(new URL(historicalStateRequests(requests, fixture.campaignId, 12)[0]!.url).searchParams.get("turnNumber")).toBe("12");
  await expect(page.locator("#turnHistoryStatePanel")).toBeVisible();
  await page.locator("#btnTurnHistoryDone").click();
  await expect(page.locator("#turnHistoryDialog")).not.toHaveAttribute("open", "");
  await expect(page.locator("#btnReaderHistory")).toBeFocused();
});

test("a same-number replacement UUID cannot install a stale search summary", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 1, campaignCount: 1 });
  const requests = watchRequests(page);
  await installLegacyUiFixture(page, fixture);
  const staleSummary = fixture.turns[11]!;
  await page.route(`**${searchPath(fixture.campaignId)}**`, route => route.fulfill({
    contentType: "application/json",
    json: { campaignId: fixture.campaignId, items: [historyItem(staleSummary)], nextCursor: null }
  }));
  await page.route(`**${exactTurnPath(fixture.campaignId, 12)}`, route => route.fulfill({
    contentType: "application/json",
    json: { campaignId: fixture.campaignId, turn: { ...staleSummary, id: "99999999-9999-4999-8999-999999999999" } }
  }));
  await prepareStoryPage(page, fixture.campaignId);
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await page.locator("#freeAction").fill("Draft stays on a stale result.");
  await openHistory(page);
  await enterSearch(page, "same-number replacement");

  const result = page.locator(`${historyControls.results} [data-history-turn-number="12"]`);
  await expect(result).toBeVisible();
  await result.click();
  await expect.poll(() => turnRequests(requests, fixture.campaignId).length).toBe(1);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 317 of 317");
  await expect(page.locator("#freeAction")).toHaveValue("Draft stays on a stale result.");
  await expect(page.locator("#turnHistoryDialog")).toHaveAttribute("open", "");
  await expect(page.locator("#turnHistoryJumpStatus")).toHaveAttribute("data-state", "error");
  expect(requests.filter(request => request.pathname.endsWith("/state/inspection"))).toHaveLength(0);
  expect(ledgerPageRequests(requests, fixture.campaignId)).toHaveLength(0);
});
