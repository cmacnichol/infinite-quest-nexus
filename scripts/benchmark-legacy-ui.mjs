import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "@playwright/test";
import { installLegacyUiFixture, legacyUiFixture } from "../tests/e2e/helpers/legacy-ui-fixtures.ts";

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
    const staticAssetBytes = [];
    const longTasks = [];
    page.on("pageerror", error => runtimeErrors.push(error.message));
    page.on("request", request => {
      if (request.url().startsWith("http") && new URL(request.url()).origin !== origin) externalRequests.push(request.url());
    });
    page.on("response", async response => {
      if (response.url().startsWith(`${origin}/`) && !new URL(response.url()).pathname.startsWith("/api/")) {
        try { staticAssetBytes.push((await response.body()).byteLength); } catch { /* Navigation responses can end before body collection. */ }
      }
    });
    await page.addInitScript(() => {
      window.__legacyUiLongTasks = [];
      if ("PerformanceObserver" in window) {
        try {
          new PerformanceObserver(list => {
            for (const entry of list.getEntries()) window.__legacyUiLongTasks?.push(entry.duration);
          }).observe({ type: "longtask", buffered: true });
        } catch { /* Long task entries are optional in Chromium builds. */ }
      }
    });
    const storyHtml = (await (await import("node:fs/promises")).readFile(path.join(repoRoot, "apps/web/public/story.html"), "utf8"))
      .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
    await page.route(`**/story/${fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: storyHtml }));

    await page.goto(`${origin}/nexus/index.html`);
    await page.locator("#dashboardWorlds").getByText("Fixture World 1", { exact: true }).waitFor({ state: "visible" });
    const dashboardDomNodes = await page.locator("body *").count();
    const staticBytesAfterDashboard = staticAssetBytes.reduce((sum, bytes) => sum + bytes, 0);
    await page.goto(`${origin}/story/${fixture.campaignId}`);
    await page.waitForFunction(() => document.querySelector("#storyTitle")?.textContent === "Fixture Campaign 1"
      && document.querySelector("#turnPill")?.textContent === "Turn 317"
      && document.querySelector("#busyPill")?.textContent === "Ready");
    await waitForRequestsToSettle(instrumentation.requests);
    const storyDomNodes = await page.locator("body *").count();
    const staticBytesCold = staticAssetBytes.reduce((sum, bytes) => sum + bytes, 0) - staticBytesAfterDashboard;
    const started = performance.now();
    const historyClick = page.locator("#turnPill").click();
    await page.locator("#turnHistoryDialog").waitFor({ state: "visible" });
    instrumentation.releaseDelayedRoute();
    await historyClick;
    await page.waitForFunction(() => document.querySelectorAll("#turnHistoryModalList .history-card").length === 317);
    await waitForRequestsToSettle(instrumentation.requests);
    const historyOpenMs = performance.now() - started;
    const historyDomNodes = await page.locator("body *").count();
    const navigationStarted = performance.now();
    await page.locator("#turnHistoryModalList .history-card").first().click();
    await page.locator("#btnTurnHistoryJump").click();
    await page.locator("#turnHistoryDialog").waitFor({ state: "hidden" });
    const historyNavigationMs = performance.now() - navigationStarted;
    const delayedTurnRequests = instrumentation.requests.filter(request => request.path === `/api/v1/campaigns/${fixture.campaignId}/turns`);
    await waitForRequestsToSettle(instrumentation.requests);
    const requestCount = instrumentation.requests.length;
    const apiResponseBytes = instrumentation.requests.reduce((sum, request) => sum + request.responseBytes, 0);
    await page.reload();
    const warmAssetBytes = staticAssetBytes.reduce((sum, bytes) => sum + bytes, 0) - staticBytesAfterDashboard - staticBytesCold;
    longTasks.push(...await page.evaluate(() => window.__legacyUiLongTasks ?? []));
    const record = {
      historyOpenMs,
      historyNavigationMs,
      dashboardDomNodes,
      storyDomNodes,
      historyDomNodes,
      requestCount,
      apiResponseBytes,
      coldAssetBytes: staticBytesAfterDashboard + staticBytesCold,
      warmAssetBytes,
      writeCount: instrumentation.writes.length,
      longTasks,
      delayedTurnRequestCount: delayedTurnRequests.length,
      runtimeErrors,
      externalRequests
    };
    if (record.writeCount || runtimeErrors.length || externalRequests.length || delayedTurnRequests.length === 0) {
      throw new Error(`Synthetic browser sample failed its guard: ${JSON.stringify(record)}`);
    }
    if (index >= warmups) samples.push(record);
    await context.close();
  }

  const commit = await gitValue(["rev-parse", "HEAD"]);
  const dirty = (await gitValue(["status", "--porcelain"])).length > 0;
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
    longTasks: { observed: samples.flatMap(sample => sample.longTasks).length, durationsMs: samples.flatMap(sample => sample.longTasks) },
    zeroWrites: samples.every(sample => sample.writeCount === 0),
    noExternalRequests: samples.every(sample => sample.externalRequests.length === 0),
    noRuntimeErrors: samples.every(sample => sample.runtimeErrors.length === 0),
    delayedRouteObservedEverySample: samples.every(sample => sample.delayedTurnRequestCount > 0),
    timingNote: "Browser timing is recorded evidence for this local Vite/mock-route profile, not an absolute assertion or PostgreSQL/provider measurement."
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser?.close();
  server.kill();
}
