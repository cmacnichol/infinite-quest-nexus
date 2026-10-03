import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

declare global {
  interface Window {
    __legacyUiLongTasks?: number[];
    __legacyUiLifecycleLongTasks?: Array<{ durationMs: number; startTime: number }>;
    __legacyUiInducedLongTaskStartedAt?: number;
    __legacyUiNativeLongTaskSupported?: boolean;
    __legacyUiDelayedResult?: { status: number; body: unknown };
  }
}

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const historyTurnCounts = [0, 1, 50, 317, 2000] as const;

async function installStoryDocument(page: Page, campaignId: string): Promise<void> {
  const html = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
}

async function captureDesktopAndMobile(page: Page, testInfo: TestInfo, stem: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: testInfo.outputPath(`${stem}-1280x800.png`), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath(`${stem}-390x844.png`), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
}

function verifiedGitMetadata(): { commit: string | null; dirty: boolean | null; error?: string } {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
    return { commit, dirty };
  } catch (error) {
    return { commit: null, dirty: null, error: error instanceof Error ? error.message : String(error) };
  }
}

test("deterministic fixtures cover the agreed cardinalities without private canaries", () => {
  for (const turnCount of historyTurnCounts) {
    const fixture = legacyUiFixture({ turnCount, worldCount: 2, campaignCount: 3 });
    expect(fixture.turns).toHaveLength(turnCount);
    expect(fixture.worlds).toHaveLength(2);
    expect(fixture.campaigns).toHaveLength(3);
    const serialized = JSON.stringify(fixture);
    expect(serialized).not.toMatch(/PRIVATE-CANARY-|HIDDEN-MECHANIC-CANARY-|SCRATCHPAD-CANARY-/u);
    expect(serialized).toContain("synthetic");
  }
});

test("legacy dashboard and Story baseline records requests, zero writes, history timing and rendered counts", async ({ page }, testInfo) => {
  const fixture = legacyUiFixture({ turnCount: 317, worldCount: 3, campaignCount: 2 });
  const instrumentation = await installLegacyUiFixture(page, fixture);
  await page.setViewportSize({ width: 1280, height: 800 });
  const externalRequests: string[] = [];
  const longTasks: number[] = [];
  page.on("request", request => {
    if (new URL(request.url()).origin !== origin && request.url().startsWith("http")) externalRequests.push(request.url());
  });
  await page.addInitScript(() => {
    const target = window as typeof window & { __legacyUiLongTasks?: number[] };
    target.__legacyUiLongTasks = [];
    if ("PerformanceObserver" in window) {
      try {
        target.__legacyUiNativeLongTaskSupported = PerformanceObserver.supportedEntryTypes.includes("longtask");
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) target.__legacyUiLongTasks?.push(entry.duration);
        }).observe({ type: "longtask", buffered: true });
      } catch { /* Long task timing is optional in unsupported browser builds. */ }
    }
  });

  await page.goto(`${origin}/nexus/index.html`);
  await expect(page.locator("#dashboardWorlds")).toContainText("Fixture World 1");
  await expect(page.locator("#dashboardCampaigns")).toContainText("Fixture Campaign 1");
  const dashboardDomNodes = await page.locator("body *").count();
  await captureDesktopAndMobile(page, testInfo, "dashboard");

  await page.goto(`${origin}/nexus/index.html#world-library`);
  await page.getByRole("button", { name: "New world", exact: true }).click();
  await expect(page.locator("#worldAuthorDialog")).toBeVisible();
  await captureDesktopAndMobile(page, testInfo, "world-author");
  await page.locator('[data-tab-target="world-author-mechanics"]').click();
  await page.getByRole("button", { name: "+ Add character", exact: true }).click();
  await expect(page.locator("#characterDialog")).toBeVisible();
  await captureDesktopAndMobile(page, testInfo, "character-editor");
  await page.locator("#cancelCharacter").click();
  await page.locator("#cancelWorldAuthor").click();

  await page.locator("#worldManagementCarousel").getByText("Fixture World 1", { exact: true }).click();
  await page.locator("#createCampaignModalBtn").click();
  await expect(page.locator("#createCampaignDialog")).toBeVisible();
  await captureDesktopAndMobile(page, testInfo, "campaign-creation");
  await page.locator("#cancelCreateCampaign").click();

  await installStoryDocument(page, fixture.campaignId);
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#storyTitle")).toHaveText("Fixture Campaign 1");
  const storyDomNodes = await page.locator("body *").count();
  await captureDesktopAndMobile(page, testInfo, "story-reader");

  const historyOpenStarted = performance.now();
  await page.locator("#turnPill").click();
  await expect(page.locator("#turnHistoryDialog")).toBeVisible();
  await expect(page.locator("#turnHistoryModalList .history-card")).toHaveCount(317);
  const historyOpenMs = performance.now() - historyOpenStarted;
  await expect(page.locator("#turnHistoryDialog")).toBeVisible();
  const historyDomNodes = await page.locator("body *").count();
  await captureDesktopAndMobile(page, testInfo, "story-history");
  const navigationStarted = performance.now();
  await page.locator("#turnHistoryModalList .history-card").first().click();
  await page.locator("#btnTurnHistoryJump").click();
  await expect(page.locator("#viewPill")).toContainText("1");
  const historyNavigationMs = performance.now() - navigationStarted;
  longTasks.push(...await page.evaluate(() => (window as typeof window & { __legacyUiLongTasks?: number[] }).__legacyUiLongTasks ?? []));

  expect(instrumentation.writes).toEqual([]);
  expect(instrumentation.requests.length).toBeGreaterThan(0);
  expect(instrumentation.requests.every(request => request.finishedAt !== undefined)).toBe(true);
  expect(externalRequests).toEqual([]);
  const baseline = {
    git: verifiedGitMetadata(),
    buildMode: "Vite development server; deterministic API routes",
    fixture: { turnCount: 317, worldCount: 3, campaignCount: 2 },
    requests: instrumentation.requests,
    writes: instrumentation.writes.length,
    domCounts: { dashboard: dashboardDomNodes, story: storyDomNodes, history: historyDomNodes },
    historyOpenMs,
    historyNavigationMs,
    longTasks,
    nativeLongTaskSupported: await page.evaluate(() => (window as typeof window & { __legacyUiNativeLongTaskSupported?: boolean }).__legacyUiNativeLongTaskSupported ?? false),
    apiResponseBytes: instrumentation.requests.reduce((sum, request) => sum + request.responseBytes, 0)
  };
  await testInfo.attach("legacy-ui-baseline.json", { body: JSON.stringify(baseline, null, 2), contentType: "application/json" });
  expect(dashboardDomNodes).toBeGreaterThan(0);
  expect(storyDomNodes).toBeGreaterThan(0);
  expect(historyDomNodes).toBeGreaterThan(0);
  expect(Number.isFinite(historyOpenMs)).toBe(true);
});

test("route instrumentation holds delays, applies method-specific failures, and captures writes", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const instrumentation = await installLegacyUiFixture(page, fixture, {
    delays: { "/api/v1/instrumentation-delay": 1, "GET /api/v1/instrumentation-delay": 30_000 },
    failures: { "/api/v1/instrumentation-failure": 418, "GET /api/v1/instrumentation-failure": 503 }
  });
  await page.goto(`${origin}/nexus/index.html`);
  expect(instrumentation.writes).toEqual([]);

  await page.evaluate(() => {
    void fetch("/api/v1/instrumentation-delay").then(async response => {
      window.__legacyUiDelayedResult = { status: response.status, body: await response.json() };
    });
  });
  await expect.poll(() => instrumentation.requests.find(request => request.path === "/api/v1/instrumentation-delay")).toBeDefined();
  const delayedRequest = instrumentation.requests.find(request => request.path === "/api/v1/instrumentation-delay")!;
  expect(delayedRequest.configuredDelayMs).toBe(30_000);
  expect(delayedRequest.finishedAt).toBeUndefined();
  await page.waitForTimeout(40);
  expect(delayedRequest.finishedAt).toBeUndefined();
  instrumentation.releaseDelayedRoute();
  await expect.poll(() => delayedRequest.finishedAt).toBeDefined();
  expect(delayedRequest.delayReleaseKind).toBe("explicit");
  expect(delayedRequest.delayReleasedAt).toBeGreaterThan(delayedRequest.startedAt);
  expect(await page.evaluate(() => window.__legacyUiDelayedResult?.status)).toBe(200);

  const failureStatus = await page.evaluate(async () => (await fetch("/api/v1/instrumentation-failure")).status);
  const failureRequest = instrumentation.requests.find(request => request.path === "/api/v1/instrumentation-failure")!;
  expect(failureStatus).toBe(503);
  expect(failureRequest.status).toBe(503);

  const writeBody = { synthetic: true, action: "fixture-only" };
  const writeStatus = await page.evaluate(async body => (await fetch("/api/v1/instrumentation-write", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })).status, writeBody);
  expect(writeStatus).toBe(200);
  expect(instrumentation.writes).toEqual([{ method: "POST", path: "/api/v1/instrumentation-write", body: writeBody }]);
  const writeRequest = instrumentation.requests.find(request => request.path === "/api/v1/instrumentation-write")!;
  expect(writeRequest.method).toBe("POST");
  expect(writeRequest.requestBytes).toBeGreaterThan(0);
  expect(writeRequest.status).toBe(200);
});

test("long-task measurements are collected before each document is replaced", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.__legacyUiLifecycleLongTasks = [];
    if ("PerformanceObserver" in window) {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          window.__legacyUiLifecycleLongTasks?.push({ durationMs: entry.duration, startTime: entry.startTime });
        }
      }).observe({ type: "longtask", buffered: true });
    }
  });
  const collected: Array<{ phase: string; durationMs: number; startTime: number | null }> = [];
  const syntheticFallbackPhases: string[] = [];
  const nativeSupportByPhase: Record<string, boolean> = {};
  const collectBeforeReplacement = async (phase: string) => {
    const nativeSupported = await page.evaluate(() => "PerformanceObserver" in window
      && PerformanceObserver.supportedEntryTypes.includes("longtask"));
    nativeSupportByPhase[phase] = nativeSupported;
    await page.evaluate(() => { window.__legacyUiLifecycleLongTasks = []; });
    await page.evaluate(() => new Promise<void>(resolve => {
      setTimeout(() => {
        window.__legacyUiInducedLongTaskStartedAt = performance.now();
        const startedAt = performance.now();
        while (performance.now() - startedAt < 70) { /* Induce one measurable timer-task long task. */ }
        resolve();
      }, 0);
    }));
    const inducedStartedAt = await page.evaluate(() => window.__legacyUiInducedLongTaskStartedAt ?? null);
    if (nativeSupported) {
      expect(inducedStartedAt).not.toBeNull();
      const taskStartedAt = inducedStartedAt ?? 0;
      await page.waitForFunction(startedAt => window.__legacyUiLifecycleLongTasks?.some(entry => entry.durationMs >= 50
        && entry.startTime >= startedAt && entry.startTime <= startedAt + 20) ?? false, taskStartedAt, { timeout: 2_000 });
    }
    const durations = await page.evaluate(() => {
      const result = [...(window.__legacyUiLifecycleLongTasks ?? [])];
      window.__legacyUiLifecycleLongTasks = [];
      return result;
    });
    if (!nativeSupported) {
      syntheticFallbackPhases.push(phase);
      durations.push({ durationMs: 71, startTime: -1 });
    } else {
      const taskStartedAt = inducedStartedAt ?? 0;
      expect(durations.some(entry => entry.durationMs >= 50 && entry.startTime >= taskStartedAt && entry.startTime <= taskStartedAt + 20)).toBe(true);
    }
    collected.push(...durations.map(entry => ({ phase, durationMs: entry.durationMs, startTime: entry.startTime < 0 ? null : entry.startTime })));
  };

  await page.goto(`${origin}/nexus/index.html`);
  await collectBeforeReplacement("dashboard");
  await page.route("**/benchmark-document", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Second measurement document</title>" }));
  await page.goto(`${origin}/benchmark-document`);
  await collectBeforeReplacement("second-document");
  expect(collected.map(entry => entry.phase)).toEqual(expect.arrayContaining(["dashboard", "second-document"]));
  expect(collected.every(entry => entry.durationMs >= 50)).toBe(true);
  expect(syntheticFallbackPhases.every(phase => nativeSupportByPhase[phase] === false)).toBe(true);
  const lifecycleEvidence = {
    source: "bounded native observer polling after an induced task when supported; deterministic synthetic entries only for unsupported documents",
    nativeSupportByPhase,
    syntheticFallbackPhases,
    entries: collected
  };
  const lifecyclePath = testInfo.outputPath("long-task-lifecycle.json");
  await writeFile(lifecyclePath, JSON.stringify(lifecycleEvidence, null, 2));
  await testInfo.attach("long-task-lifecycle.json", { path: lifecyclePath, contentType: "application/json" });
});
