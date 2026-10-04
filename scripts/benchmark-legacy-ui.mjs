import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "@playwright/test";
import { installLegacyUiFixture, legacyUiFixture } from "../tests/e2e/helpers/legacy-ui-fixtures.ts";
import { isQualifyingNativeLongTask } from "../tests/e2e/helpers/legacy-ui-long-tasks.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173");
const origin = `http://127.0.0.1:${port}`;
const warmups = Number(process.env.LEGACY_UI_BENCHMARK_WARMUPS ?? 5);
const sampleCount = Number(process.env.LEGACY_UI_BENCHMARK_SAMPLES ?? 30);
const fixtureCounts = { turnCount: 317, worldCount: 3, campaignCount: 2 };

if (!Number.isSafeInteger(warmups) || warmups < 0 || !Number.isSafeInteger(sampleCount) || sampleCount < 1) {
  throw new RangeError("Warmups must be non-negative and samples must be positive integers.");
}

async function waitForServer(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Legacy Vite server exited with ${child.exitCode}.`);
    try {
      const response = await fetch(`${origin}/nexus/index.html`);
      if (response.ok) return;
    } catch { /* The development server is still starting. */ }
    await sleep(250);
  }
  throw new Error("Legacy Vite server did not become ready within 30 seconds.");
}

async function waitForRequestsToSettle(requests) {
  const deadline = Date.now() + 5_000;
  let previousCount = -1;
  let stableChecks = 0;
  while (Date.now() < deadline) {
    const settled = requests.every(request => request.finishedAt !== undefined);
    if (settled && requests.length === previousCount) stableChecks += 1;
    else stableChecks = 0;
    if (stableChecks >= 3) return;
    previousCount = requests.length;
    await sleep(50);
  }
  throw new Error("Mock API requests did not settle within five seconds.");
}

async function waitForPendingRequest(requests, path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const request = requests.find(candidate => candidate.path === path && candidate.finishedAt === undefined);
    if (request) return request;
    await sleep(5);
  }
  throw new Error(`Expected delayed mock request was not observed: ${path}`);
}

async function waitForHistoryPageChange(page, previousPage) {
  await page.waitForFunction(previous => JSON.stringify(Array.from(document.querySelectorAll("#turnHistoryModalList .history-card"))
    .map(card => Number(card.dataset.turnNumber))) !== JSON.stringify(previous), previousPage, { timeout: 10_000 });
}

async function waitForAssetReads(pendingReads, failures) {
  while (pendingReads.size > 0) await Promise.all([...pendingReads]);
  if (failures.length) throw new Error(`Static response-body collection failed: ${JSON.stringify(failures)}`);
}

async function collectDocumentLongTasks(page, phase, phases) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const durationsMs = await page.evaluate(() => {
    const entries = [...(window.__legacyUiLongTasks ?? [])];
    window.__legacyUiLongTasks = [];
    return entries;
  });
  phases[phase].push(...durationsMs.filter(isQualifyingNativeLongTask).map(entry => entry.durationMs));
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)];
}

function summarize(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const standardDeviation = Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length);
  return {
    mean: Number(mean.toFixed(2)),
    standardDeviation: Number(standardDeviation.toFixed(2)),
    coefficientOfVariationPercent: Number((mean === 0 ? 0 : standardDeviation / mean * 100).toFixed(2)),
    p50: Number(percentile(values, 0.5).toFixed(2)),
    p95: Number(percentile(values, 0.95).toFixed(2)),
    min: Number(Math.min(...values).toFixed(2)),
    max: Number(Math.max(...values).toFixed(2))
  };
}

async function gitValue(args) {
  const child = spawn("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", value => { output += value; });
  const [code] = await once(child, "close");
  if (code !== 0) return "unknown";
  return output.trim();
}

const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "vite.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: path.join(repoRoot, "apps/web"),
  stdio: "ignore",
  windowsHide: true
});

let browser;
try {
  await waitForServer(server);
  browser = await chromium.launch({ headless: true });
  const samples = [];
  for (let index = 0; index < warmups + sampleCount; index += 1) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const fixture = legacyUiFixture(fixtureCounts);
    const instrumentation = await installLegacyUiFixture(page, fixture, {
      delays: { [`/api/v1/campaigns/${fixture.campaignId}/turns`]: 20 }
    });
    const runtimeErrors = [];
    const externalRequests = [];
    const staticAssetEvidence = [];
    const pendingAssetReads = new Set();
    const assetReadFailures = [];
    const longTasksByPhase = { dashboard: [], story: [], history: [], warmReload: [] };
    let assetPhase = "dashboard";
    page.on("pageerror", error => runtimeErrors.push(error.message));
    page.on("request", request => {
      if (request.url().startsWith("http") && new URL(request.url()).origin !== origin) externalRequests.push(request.url());
    });
    page.on("response", response => {
      if (response.url().startsWith(`${origin}/`) && !new URL(response.url()).pathname.startsWith("/api/")) {
        const evidence = { phase: assetPhase, path: new URL(response.url()).pathname, resourceType: response.request().resourceType(), bytes: null };
        const pending = response.body().then(body => { evidence.bytes = body.byteLength; }).catch(error => {
          assetReadFailures.push({ path: evidence.path, message: error instanceof Error ? error.message : String(error) });
        });
        staticAssetEvidence.push(evidence);
        pendingAssetReads.add(pending);
        void pending.finally(() => pendingAssetReads.delete(pending));
      }
    });
    await page.addInitScript(() => {
      window.__legacyUiLongTasks = [];
      if ("PerformanceObserver" in window) {
        try {
          new PerformanceObserver(list => {
            for (const entry of list.getEntries()) window.__legacyUiLongTasks?.push({ durationMs: entry.duration, startTime: entry.startTime });
          }).observe({ type: "longtask", buffered: true });
        } catch { /* Long task entries are optional in Chromium builds. */ }
      }
    });
    const storyHtml = (await readFile(path.join(repoRoot, "apps/web/public/story.html"), "utf8"))
      .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
    await page.route(`**/story/${fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: storyHtml }));

    await page.goto(`${origin}/nexus/index.html`);
    const nativeLongTaskSupported = await page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes("longtask"));
    await page.locator("#dashboardWorlds").getByText("Fixture World 1", { exact: true }).waitFor({ state: "visible" });
    await waitForAssetReads(pendingAssetReads, assetReadFailures);
    const dashboardDomNodes = await page.locator("body *").count();
    const dashboardAssetEvidenceCount = staticAssetEvidence.length;
    await collectDocumentLongTasks(page, "dashboard", longTasksByPhase);
    assetPhase = "story";
    await page.goto(`${origin}/story/${fixture.campaignId}`);
    await page.waitForFunction(() => document.querySelector("#storyTitle")?.textContent === "Fixture Campaign 1"
      && document.querySelector("#turnPill")?.textContent === "Turn 317"
      && document.querySelector("#busyPill")?.textContent === "Ready");
    await waitForRequestsToSettle(instrumentation.requests);
    await waitForAssetReads(pendingAssetReads, assetReadFailures);
    const storyDomNodes = await page.locator("body *").count();
    const coldAssetEvidenceCount = staticAssetEvidence.length;
    const dashboardAssetBytes = staticAssetEvidence.slice(0, dashboardAssetEvidenceCount).reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
    const coldAssetBytes = staticAssetEvidence.slice(dashboardAssetEvidenceCount, coldAssetEvidenceCount).reduce((sum, entry) => sum + (entry.bytes ?? 0), dashboardAssetBytes);
    await collectDocumentLongTasks(page, "story", longTasksByPhase);
    const historyEndpoint = `/api/v1/campaigns/${fixture.campaignId}/turns`;
    const historyOpenRequestIndex = instrumentation.requests.length;
    const historyOpenStarted = performance.now();
    await page.locator("#turnPill").click();
    await page.locator("#turnHistoryDialog").waitFor({ state: "visible" });
    await page.locator("#turnHistoryModalList .history-card").first().waitFor({ state: "visible" });
    const historyOpenMs = performance.now() - historyOpenStarted;
    const historyOpenRequests = instrumentation.requests.slice(historyOpenRequestIndex);
    const historyOpenResponseBytes = historyOpenRequests.reduce((sum, request) => sum + request.responseBytes, 0);
    if (historyOpenRequests.some(request => request.path === historyEndpoint)) {
      throw new Error(`Opening bounded History unexpectedly fetched a page: ${JSON.stringify(historyOpenRequests)}`);
    }
    const historyOpenCardCount = await page.locator("#turnHistoryModalList .history-card").count();
    if (historyOpenCardCount > 50) throw new Error(`History opened with ${historyOpenCardCount} cards.`);
    const historyDomNodes = await page.locator("body *").count();
    await collectDocumentLongTasks(page, "history", longTasksByPhase);
    await waitForRequestsToSettle(instrumentation.requests);
    await waitForAssetReads(pendingAssetReads, assetReadFailures);

    const historyPagingRequestIndex = instrumentation.requests.length;
    const historyPagingStarted = performance.now();
    const older = page.locator("#btnTurnHistoryOlder");
    const maxOlderClicks = Math.ceil(fixtureCounts.turnCount / 49) + 2;
    let olderClicks = 0;
    while (!(await page.locator('#turnHistoryModalList [data-turn-number="1"]').count())) {
      if (olderClicks >= maxOlderClicks) throw new Error(`Turn 1 did not become visible within ${maxOlderClicks} Older clicks.`);
      if (!(await older.isEnabled())) throw new Error("Older paging ended before Turn 1 became visible.");
      const previousPage = await page.locator("#turnHistoryModalList .history-card").evaluateAll(cards =>
        cards.map(card => Number(card.dataset.turnNumber))
      );
      await older.click();
      const delayedTurnRequest = await waitForPendingRequest(instrumentation.requests, historyEndpoint);
      if (delayedTurnRequest.configuredDelayMs !== 20 || delayedTurnRequest.finishedAt !== undefined) {
        throw new Error(`Configured explicit-page delay was not held: ${JSON.stringify(delayedTurnRequest)}`);
      }
      instrumentation.releaseDelayedRoute();
      await waitForHistoryPageChange(page, previousPage);
      olderClicks += 1;
      const visibleCards = await page.locator("#turnHistoryModalList .history-card, #turnHistoryPreviewCard .history-card").count();
      if (visibleCards > 50) throw new Error(`Explicit history paging rendered ${visibleCards} cards.`);
    }
    await page.locator('#turnHistoryModalList [data-turn-number="1"]').waitFor({ state: "visible" });
    if (await older.isEnabled()) throw new Error("Older remained enabled after Turn 1 became visible.");
    const historyPagingMs = performance.now() - historyPagingStarted;
    const historyPagingRequests = instrumentation.requests.slice(historyPagingRequestIndex);
    const historyPagingTurnRequests = historyPagingRequests.filter(request => request.path === historyEndpoint);
    const historyPagingResponseBytes = historyPagingRequests.reduce((sum, request) => sum + request.responseBytes, 0);
    if (historyPagingTurnRequests.length === 0) throw new Error("Explicit Older paging made no history requests.");
    await waitForRequestsToSettle(instrumentation.requests);
    await waitForAssetReads(pendingAssetReads, assetReadFailures);

    const navigationStarted = performance.now();
    await page.locator('#turnHistoryModalList [data-turn-number="1"]').click();
    await page.locator("#btnTurnHistoryJump").click();
    await page.locator("#turnHistoryDialog").waitFor({ state: "hidden" });
    const historyNavigationMs = performance.now() - navigationStarted;
    const delayedTurnRequests = instrumentation.requests.filter(request => request.path === historyEndpoint);
    await waitForRequestsToSettle(instrumentation.requests);
    const requestCount = instrumentation.requests.length;
    const apiResponseBytes = instrumentation.requests.reduce((sum, request) => sum + request.responseBytes, 0);
    const beforeWarmReloadAssetEvidenceCount = staticAssetEvidence.length;
    assetPhase = "warmReload";
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#storyTitle")?.textContent === "Fixture Campaign 1"
      && document.querySelector("#busyPill")?.textContent === "Ready");
    await waitForAssetReads(pendingAssetReads, assetReadFailures);
    const warmAssetBytes = staticAssetEvidence.slice(beforeWarmReloadAssetEvidenceCount).reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
    await collectDocumentLongTasks(page, "warmReload", longTasksByPhase);
    const record = {
      historyOpenMs,
      historyOpenRequestCount: historyOpenRequests.length,
      historyOpenCardCount,
      historyOpenResponseBytes,
      historyPagingMs,
      historyPagingClicks: olderClicks,
      historyPagingRequestCount: historyPagingRequests.length,
      historyPagingTurnRequestCount: historyPagingTurnRequests.length,
      historyPagingResponseBytes,
      historyNavigationMs,
      dashboardDomNodes,
      storyDomNodes,
      historyDomNodes,
      requestCount,
      apiResponseBytes,
      coldAssetBytes,
      warmAssetBytes,
      writeCount: instrumentation.writes.length,
      nativeLongTaskSupported,
      longTasksByPhase,
      delayedTurnRequestCount: delayedTurnRequests.length,
      delayedRouteEvidence: delayedTurnRequests.map(request => ({ method: request.method, path: request.path, configuredDelayMs: request.configuredDelayMs, delayReleaseKind: request.delayReleaseKind, releasedAfterMs: request.delayReleasedAt === undefined ? null : request.delayReleasedAt - request.startedAt })),
      requestEvidence: instrumentation.requests.map(request => ({ method: request.method, path: request.path, requestBytes: request.requestBytes, responseBytes: request.responseBytes, status: request.status })),
      assetEvidence: staticAssetEvidence,
      assetReadFailures,
      runtimeErrors,
      externalRequests
    };
    if (record.writeCount || runtimeErrors.length || externalRequests.length || delayedTurnRequests.length === 0
      || delayedTurnRequests.some(request => request.configuredDelayMs !== 20)
      || !delayedTurnRequests.some(request => request.delayReleaseKind === "explicit")
      || assetReadFailures.length || staticAssetEvidence.some(asset => asset.bytes === null)) {
      throw new Error(`Synthetic browser sample failed its guard: ${JSON.stringify(record)}`);
    }
    if (index >= warmups) samples.push(record);
    await context.close();
  }

  const commit = await gitValue(["rev-parse", "HEAD"]);
  const dirtyOutput = await gitValue(["status", "--porcelain"]);
  const dirty = dirtyOutput === "unknown" ? null : dirtyOutput.length > 0;
  const report = {
    generatedAt: new Date().toISOString(),
    commit,
    dirty,
    buildMode: "Vite development server with deterministic synthetic API routes",
    fixture: fixtureCounts,
    warmups,
    samples: sampleCount,
    historyOpenMs: summarize(samples.map(sample => sample.historyOpenMs)),
    historyNavigationMs: summarize(samples.map(sample => sample.historyNavigationMs)),
    requestCount: summarize(samples.map(sample => sample.requestCount)),
    apiResponseBytes: summarize(samples.map(sample => sample.apiResponseBytes)),
    coldAssetBytes: summarize(samples.map(sample => sample.coldAssetBytes)),
    warmAssetBytes: summarize(samples.map(sample => sample.warmAssetBytes)),
    domCounts: {
      dashboard: summarize(samples.map(sample => sample.dashboardDomNodes)),
      story: summarize(samples.map(sample => sample.storyDomNodes)),
      history: summarize(samples.map(sample => sample.historyDomNodes))
    },
    longTasksByPhase: Object.fromEntries(Object.keys(samples[0].longTasksByPhase).map(phase => [phase, {
      nativeObserverSupported: samples.every(sample => sample.nativeLongTaskSupported),
      observed: samples.every(sample => sample.nativeLongTaskSupported)
        ? samples.flatMap(sample => sample.longTasksByPhase[phase]).length
        : null,
      durationsMs: samples.every(sample => sample.nativeLongTaskSupported)
        ? samples.flatMap(sample => sample.longTasksByPhase[phase])
        : null
    }])),
    zeroWrites: samples.every(sample => sample.writeCount === 0),
    noExternalRequests: samples.every(sample => sample.externalRequests.length === 0),
    noRuntimeErrors: samples.every(sample => sample.runtimeErrors.length === 0),
    delayedRouteHeldAndExplicitlyReleasedDuringHistoryEverySample: samples.every(sample => sample.delayedRouteEvidence.some(route => route.configuredDelayMs === 20 && route.delayReleaseKind === "explicit")),
    assetBodyReadFailures: samples.reduce((sum, sample) => sum + sample.assetReadFailures.length, 0),
    sampleResults: samples,
    timingNote: "Browser timing is recorded evidence for this local Vite/mock-route profile, not an absolute assertion or PostgreSQL/provider measurement."
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser?.close();
  server.kill();
}
