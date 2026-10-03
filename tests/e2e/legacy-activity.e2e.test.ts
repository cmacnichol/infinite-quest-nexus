import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Route } from "@playwright/test";
import { generationJobSnapshotSchema, campaignSyncStatusSchema, activityEventSchema, activityPageSchema, ACTIVITY_DIAGNOSTIC_MESSAGES, providerListResponseSchema, type ActivityEvent } from "../../packages/contracts/src/index.js";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";
const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const nextOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? "43174"}`;
const fixture = quietLeafApiPayloads();
const campaignId = fixture.campaignId;
const campaignB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const jobId = "55555555-5555-4555-8555-555555555555";
const timestamp = "2026-10-03T12:34:56.000Z";
const providers = providerListResponseSchema.parse({ providers: [{ id: jobId, name: "Fixture text", providerType: "openai_compatible", providerRole: "text", baseUrl: "http://fixture.test/v1", defaultModel: "fixture", contextWindowTokens: 32000, maxOutputTokens: 4096, temperature: 0.7, requestTimeoutMs: 60000, configuration: {}, enabled: true, isDefault: true, healthStatus: "healthy", consecutiveFailures: 0, lastHealthCheckAt: null, lastHealthError: null, hasApiKey: false, createdAt: timestamp, updatedAt: timestamp }] });
function event(sequence: number, patch: Record<string, unknown> = {}): ActivityEvent {
  return activityEventSchema.parse({ version: 1, eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`, sequence: String(sequence), occurredAt: timestamp, publishedAt: timestamp,
    campaignId, source: "generation", kind: "generation.failed", severity: "error", status: "failed", jobId, generationJobId: jobId, segmentId: null, turnId: null, turnNumber: 2, attemptNumber: 1,
    diagnostic: { code: "provider_request_timeout", message: ACTIVITY_DIAGNOSTIC_MESSAGES.provider_request_timeout, phase: "generating", correlationId: "fixture:failure", httpStatus: 504 }, ...patch });
}
const coverage = { capturedSince: timestamp, retentionDays: 30, oldestAvailableSequence: "1", latestPublishedSequence: "3", pendingPublication: false, incomplete: false, resetRequired: false };
function pageOf(events: ActivityEvent[], hasMore = false) { return activityPageSchema.parse({ version: 1, events, nextBefore: "older", nextAfter: "latest", hasMore, coverage: { ...coverage, latestPublishedSequence: events.reduce((max, value) => BigInt(value.sequence) > BigInt(max) ? value.sequence : max, "3") } }); }
async function install(page: Page, options: { storageDenied?: boolean; review?: boolean; delaySession?: boolean } = {}) {
  const errors: string[] = []; const writes: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED/u.test(message.text())) errors.push(message.text()); });
  let events = [event(3), event(2, { kind: "generation.retry_queued", status: "queued", attemptNumber: 2, severity: "info", diagnostic: null })];
  let offlineFeed = false; let offlineApi = false; let unsupported = false; let malformed = false; let deny = false; let sessions = 0; let syncs = 0; let activityReads = 0; let pending = false; let hold = options.delaySession ?? false; let delayedActivity: Route | null = null; let holdActivity = false; let resetNext = false; let holdConfig = false; let delayedConfig: Route | null = null;
  let releaseSession!: () => void; let sessionGate = new Promise<void>(resolve => { releaseSession = resolve; });
  if (options.storageDenied) await page.addInitScript(() => { Object.defineProperty(window, "indexedDB", { get() { throw new DOMException("Denied", "SecurityError"); } }); });
  const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`${origin}/story/*`, route => route.fulfill({ contentType: "text/html", body: html }));
  await page.route("**/vendor/photoswipe/photoswipe.css", route => route.fulfill({ contentType: "text/css", body: "" }));
  await page.route("**/nexus/src/legacy-client-entry.ts", route => route.fulfill({ contentType: "application/javascript", body: `import {createStoryPlayerComposition} from '/nexus/src/composition.ts'; import {startStoryPlayer} from '/nexus/src/story.js'; const composition=createStoryPlayerComposition(); window.__activity=composition.activity; window.__workflow=composition.workflow; startStoryPlayer(composition);` }));
  await page.route("**/nexus/src/story.js", async route => { const response = await route.fetch(); const source = await response.text(); await route.fulfill({ response, body: source.replace("return initialization;", "window.__loadCampaign = loadCampaign; window.__observeActivity = observeActivity; window.__observeGenerationRun = observeGenerationRun; window.__runGeneration = runGeneration; window.__resumePendingGeneration = resumePendingGeneration; window.__rematch = findAnotherLibraryMatch; window.__renderSceneImageJob = renderSceneImageJob; window.__state = state; window.__illustrationApi = illustrationApi; return initialization;") }); });
  const send = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
  const review = { version: 1, reviewId: "77777777-7777-4777-8777-777777777777", revision: 1, state: "pending", stage: "continuity", candidateScope: "final", reasons: ["review_unavailable"], canKeep: true, canRetry: true };
  const recovery = { id: jobId, status: "recoverable", operationKind: "append", replacementTurnId: null, expectedTurnNumber: 2, attempts: 1, errorCode: "generation_failed", errorMessage: "Generation could not be completed.", diagnostic: { code: "context_evidence_omitted", operation: "story_generation", action: "adjust_context" }, resultTurnId: null, review };
  if (options.review) campaignSyncStatusSchema.parse({ ...fixture.syncStatus, generationRecovery: recovery });
  await page.route("**/api/v1/**", async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (request.method() !== "GET") writes.push(path);
    if (offlineApi) return route.abort("internetdisconnected");
    if (path === "/api/v1/session") { sessions++; if (hold) await sessionGate; return send(route, fixture.session); }
    if (path.endsWith("/sync-status")) {
      syncs++; if (deny) return send(route, { error: "not_found" }, 404);
      const selected = path.split("/")[4]!;
      return send(route, { ...fixture.syncStatus, campaign: { ...fixture.syncStatus.campaign, id: selected, title: selected === campaignB ? "Second campaign" : "Fixture Story" }, pendingGeneration: pending && selected === campaignId ? { id: jobId, status: "generating", action: "Fixture pending action", expectedTurnNumber: 2, createdAt: timestamp, updatedAt: timestamp, operationKind: "append", replacementTurnId: null } : null, generationRecovery: options.review ? recovery : null, turns: { ...fixture.turns, campaignId: selected } });
    }
    if (path.endsWith("/activity")) {
      activityReads++;
      if (holdActivity && path.includes(campaignId)) { delayedActivity = route; return; }
      if (unsupported) return send(route, { error: "not_found" }, 404);
      if (malformed) return send(route, { private: "PRIVATE_CANARY" });
      if (offlineFeed) return route.abort("internetdisconnected");
      if (resetNext && url.searchParams.has("after")) { resetNext = false; return send(route, { ...pageOf([]), coverage: { ...coverage, oldestAvailableSequence: "3", resetRequired: true } }); }
      const selected = path.split("/")[4]!;
      const selection = events.map(value => ({ ...value, campaignId: selected, jobId: selected === campaignB ? campaignB : value.jobId }));
      return send(route, url.searchParams.has("before") ? pageOf([event(1)], false) : url.searchParams.has("after") ? pageOf([], false) : pageOf(selection, true));
    }
    if (path === "/api/v1/meta") return send(route, { application: { name: "Infinite Quest Nexus", version: "test", commit: null, builtAt: null }, capabilities: { systemArchive: false } });
    if (path === "/api/v1/providers") return send(route, providers);
    if (path === "/api/v1/campaigns") return send(route, fixture.campaigns);
    if (path === "/api/v1/worlds") return send(route, fixture.worlds);
    if (path.endsWith("/state") || path.endsWith("/state/inspection")) return send(route, { ...fixture.runtimeState, campaignId: path.split("/")[4] });
    if (path.endsWith("/turns")) return send(route, fixture.turns);
    if (path.endsWith("/story-memory")) return send(route, { level: "off", reviewMode: "off", availableLevels: ["off"] });
    if (path.endsWith("/illustration-config")) { if (holdConfig && path.includes(campaignId)) { delayedConfig = route; return; } return send(route, fixture.illustrationConfig); }
    if (path.endsWith("/illustration-segments")) return send(route, fixture.illustrationSegments);
    if (path.endsWith("/image-jobs")) return send(route, { jobs: [] });
    if (path === `/api/v1/generation-jobs/${jobId}`) return send(route, { ...recovery, campaignId, action: "PRIVATE_ACTION_CANARY", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit", partialNarration: null, createdAt: timestamp, updatedAt: timestamp });
    if (path.endsWith("/review")) return send(route, { error: "Review unavailable PRIVATE_CANARY" }, 503);
    return send(route, { error: "No fixture" }, 404);
  });
  return { errors, writes, pending: (value: boolean) => { pending = value; }, activityReads: () => activityReads, holdConfig: () => { holdConfig = true; }, delayedConfig: () => delayedConfig, releaseConfig: async () => { holdConfig = false; if (delayedConfig) await send(delayedConfig, { error: "PRIVATE_CANARY" }, 503); }, reset: () => { resetNext = true; }, offlineApi: (value: boolean) => { offlineApi = value; }, events: (value: ActivityEvent[]) => { events = value; }, offline: (value: boolean) => { offlineFeed = value; }, unsupported: (value = true) => { unsupported = value; }, malformed: () => { malformed = true; }, deny: () => { deny = true; }, sessions: () => sessions, syncs: () => syncs, holdSession: () => { hold = true; sessionGate = new Promise<void>(resolve => { releaseSession = resolve; }); }, releaseSession: () => { hold = false; releaseSession(); }, holdActivity: () => { holdActivity = true; }, delayed: () => delayedActivity, releaseActivity: async () => { holdActivity = false; if (delayedActivity) await send(delayedActivity, pageOf([event(99, { diagnostic: { code: "request_failed", message: ACTIVITY_DIAGNOSTIC_MESSAGES.request_failed, correlationId: "late:A" } })])); } };
}
async function open(page: Page) {
  await page.goto(`${origin}/story/${campaignId}`); await expect(page).toHaveTitle("Fixture Story — Infinite Quest");
  await page.locator("#btnOpenActivityLog").evaluate((button: HTMLElement) => button.click());
  await expect(page.locator("#activityLogDialog")).toBeVisible();
  await expect(page.locator("#activityLogList")).toContainText("Generation");
}
async function refresh(page: Page) { await page.locator("#btnActivityRefresh").click(); }
for (const width of [1440, 390]) {
  test(`legacy activity ${width} renders specific failure, safe selected diagnostics and preserves focus/scroll`, async ({ page }) => {
    const api = await install(page); await page.setViewportSize({ width, height: 844 }); await open(page);
    const group = page.locator('.activity-log-entry[data-group^="generation:"]').first(); await group.locator("summary").click();
    await expect(group).toContainText("provider_request_timeout"); await expect(group).toContainText("Attempt: 2"); await expect(group).toContainText("Correlation: fixture:failure");
    await group.locator('input[type="checkbox"]').check();
    const downloadPromise = page.waitForEvent("download"); await page.locator("#btnDownloadActivityLog").click(); const download = await downloadPromise;
    const text = await readFile((await download.path())!, "utf8"); const exported = JSON.parse(text); expect(exported.entries).toHaveLength(2); expect(text).not.toContain("PRIVATE_CANARY"); expect(exported.loadedOnly).toBe(true);
    await group.locator("summary").focus();
    await page.locator("#activityLogDialog .dialog-scroll").evaluate(node => { node.scrollTop = 50; });
    const scrollBefore = await page.locator("#activityLogDialog .dialog-scroll").evaluate(node => node.scrollTop);
    await page.evaluate(async () => { await (window as any).__activity.refresh(); });
    expect(await page.locator("#activityLogDialog .dialog-scroll").evaluate(node => node.scrollTop)).toBe(scrollBefore);
    await expect(group).toHaveAttribute("open", ""); await expect(group.locator("summary")).toBeFocused();
    if (width === 390) await group.locator("pre").first().evaluate(node => node.scrollIntoView({ block: "start" }));
    const doneBounds = await page.locator("#btnCloseActivityLog").boundingBox();
    expect(doneBounds).not.toBeNull(); expect(doneBounds!.y).toBeGreaterThanOrEqual(0); expect(doneBounds!.y + doneBounds!.height).toBeLessThanOrEqual(844);
    await page.screenshot({ path: `docs/review/assets/legacy-activity/error-details-${width}.png`, fullPage: false });
    await page.keyboard.press("Escape"); await expect(page.locator("#activityLogDialog")).not.toBeVisible(); expect(api.errors).toEqual([]); expect(api.writes).toEqual([]);
  });
  test(`legacy activity ${width} cached delayed reconnect and image failure preserve accepted story`, async ({ page }) => {
    const api = await install(page); await page.setViewportSize({ width, height: 844 }); await open(page);
    api.events([event(4, { kind: "generation.completed", status: "completed", severity: "success", diagnostic: null }), event(5, { source: "image", kind: "image.failed", jobId: campaignB, status: "failed", diagnostic: { code: "image_failed", message: ACTIVITY_DIAGNOSTIC_MESSAGES.image_failed } })]);
    await page.evaluate(async () => { await (window as any).__activity.returnToLatest(); });
    await expect(page.locator("#activityLogList")).toContainText("Illustration");
    await page.locator("#activityLogFilter").selectOption("illustrations"); await page.locator(".activity-log-entry summary").click();
    await expect(page.locator("#activityLogList")).toContainText("image_failed");
    await page.screenshot({ path: `docs/review/assets/legacy-activity/image-failure-${width}.png`, fullPage: false });
    await page.locator("#activityLogFilter").selectOption("all"); api.offline(true); await refresh(page);
    await expect(page.locator("#activityLogNotices")).toContainText("History may be delayed"); await expect(page.locator("#activityLogNotices")).toContainText("Showing cached activity");
    await page.screenshot({ path: `docs/review/assets/legacy-activity/cache-reconnect-${width}.png`, fullPage: false });
    api.offline(false); await refresh(page); await expect(page.locator("#activityLogNotices")).not.toContainText("History may be delayed");
    await page.keyboard.press("Escape"); await expect(page.locator("#scene-1")).toContainText("The platform is quiet"); expect(api.writes).toEqual([]); expect(api.errors).toEqual([]);
  });
}
test("reload and same-context tabs share hide watermarks while background completion remains authoritative", async ({ page, context }) => {
  const api = await install(page); await open(page); await page.locator("#btnClearActivityLog").click(); await expect(page.locator("#activityLogList .activity-log-entry")).toHaveCount(0);
  await page.reload(); await page.locator("#btnOpenActivityLog").evaluate((button: HTMLElement) => button.click()); await expect(page.locator("#btnClearActivityLog")).toHaveText("Show previous activity");
  const tab = await context.newPage(); await install(tab); await tab.goto(`${origin}/story/${campaignId}`); await expect(tab).toHaveTitle("Fixture Story \u2014 Infinite Quest"); await tab.locator("#btnOpenActivityLog").evaluate((button: HTMLElement) => button.click()); await expect(tab.locator("#btnClearActivityLog")).toHaveText("Show previous activity");
  await page.locator("#btnClearActivityLog").click(); await expect(tab.locator("#activityLogList")).toContainText("Generation");
  api.events([event(6, { kind: "generation.completed", status: "completed", severity: "success", diagnostic: null })]); await page.evaluate(async () => { await (window as any).__activity.returnToLatest(); });
  await expect(page.locator("#activityLogList")).toContainText("completed"); await expect(tab.locator("#activityLogList")).toContainText("completed"); expect(api.errors).toEqual([]);
});
test("older/latest, loaded search, clipboard rejection and malformed feed use independent controls", async ({ page }) => {
  const api = await install(page); await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("PRIVATE_CANARY")) } }); }); await open(page);
  await page.locator("#btnActivityOlder").click(); await expect(page.locator("#btnActivityLatest")).toBeVisible();
  await page.locator("#activityLogSearch").fill("missing-job"); await expect(page.locator("#activityLogEmpty")).toContainText("matches these filters");
  await page.locator("#activityLogSearch").fill("provider_request_timeout"); await page.locator("#btnCopyActivityLog").click(); await expect(page.locator("#activityLogStatus")).toContainText("Clipboard unavailable");
  await page.locator("#btnActivityLatest").click(); await expect(page.locator("#btnActivityLatest")).toBeHidden();
  api.malformed(); await refresh(page); await expect(page.locator("#activityLogNotices")).toContainText("History may be delayed"); await expect(page.locator("#activityLogNotices")).not.toContainText("does not support"); await expect(page.locator("#activityLogDialog")).not.toContainText("PRIVATE_CANARY"); expect(api.errors).toEqual([]);
});
test("cached rows stay hidden until fresh session and campaign access and denial revokes them", async ({ page }) => {
  const api = await install(page); await open(page); api.deny(); await page.reload();
  await page.locator("#btnOpenActivityLog").evaluate((button: HTMLElement) => button.click()); await expect(page.locator("#activityLogList .activity-log-entry")).toHaveCount(0); await expect(page.locator("#activityLogNotices")).toContainText("Identity and campaign access");
});
test("delayed campaign A activity cannot render after campaign B activation", async ({ page }) => {
  const api = await install(page); await open(page); api.holdActivity();
  await page.evaluate(() => { void (window as any).__activity.returnToLatest(); }); await expect.poll(() => api.delayed() !== null).toBe(true);
  await page.evaluate(async id => { await (window as any).__loadCampaign(id); }, campaignB);
  await expect(page).toHaveTitle("Second campaign — Infinite Quest"); await api.releaseActivity();
  expect(await page.evaluate(() => (window as any).__activity.getState().events.every((entry: any) => entry.campaignId === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))).toBe(true);
  await expect(page.locator("#activityLogDialog")).not.toContainText("late:A");
  expect(await page.evaluate(() => (window as any).__activity.getState().scope.campaignId)).toBe(campaignB); expect(api.errors).toEqual([]);
});
test("older-server fallback rechecks access; storage denial remains independent of Story", async ({ page }) => {
  const api = await install(page, { storageDenied: true }); api.unsupported(); await page.goto(`${origin}/story/${campaignId}`); await expect(page).toHaveTitle("Fixture Story — Infinite Quest");
  await page.locator("#btnOpenActivityLog").evaluate((button: HTMLElement) => button.click()); await expect(page.locator("#activityLogNotices")).toContainText("does not support"); await expect(page.locator("#activityLogNotices")).toContainText("Local history storage unavailable");
  expect(api.sessions()).toBeGreaterThan(2); expect(api.syncs()).toBeGreaterThan(1); await page.keyboard.press("Escape"); await expect(page.locator("#btnTakeAction")).toBeEnabled(); expect(api.errors).toEqual([]);
});
test("cold reload stays identity-gated offline and reconnect verifies before cache display", async ({ page, context }) => {
  const api = await install(page); await open(page); api.offlineApi(true);
  await page.addInitScript(() => { (window as any).__activityOnline = false; Object.defineProperty(navigator, "onLine", { get: () => (window as any).__activityOnline }); });
  await page.reload();
  await page.locator("#btnOpenActivityLog").evaluate((button: HTMLElement) => button.click()); await expect(page.locator("#activityLogList .activity-log-entry")).toHaveCount(0);
  await expect(page.locator("#activityLogNotices")).toContainText("Identity and campaign access");
  api.offlineApi(false); await page.evaluate(() => { (window as any).__activityOnline = true; window.dispatchEvent(new Event("online")); }); await expect(page.locator("#activityLogList")).toContainText("Generation");
});
test("review activity opens fresh current recovery without automatically sending a decision", async ({ page }) => {
  const api = await install(page, { review: true }); api.events([event(3, { kind: "generation.review_required", status: "recoverable", severity: "warning", diagnostic: { code: "review_required", message: ACTIVITY_DIAGNOSTIC_MESSAGES.review_required } })]); await open(page);
  await page.locator('.activity-log-entry[data-group^="generation:"] summary').click(); const before = api.syncs();
  await page.getByRole("button", { name: "View current recovery options" }).click(); await expect(page.locator("#activityLogDialog")).toBeHidden(); await expect(page.locator("#generationRecoveryPanel")).toBeVisible(); expect(api.syncs()).toBeGreaterThan(before); expect(api.writes).toEqual([]);
});
test("browser monitor/result observations never override server-confirmed success or leak exception/action details", async ({ page }) => {
  const api = await install(page); api.events([event(3, { kind: "generation.completed", status: "completed", severity: "success", diagnostic: null })]); await open(page);
  const snapshot = generationJobSnapshotSchema.parse({ id: jobId, campaignId, status: "completed", operationKind: "append", replacementTurnId: null, expectedTurnNumber: 1, attempts: 1, errorCode: null, errorMessage: null, resultTurnId: fixture.turns.turns[0]!.id, action: "PRIVATE_ACTION_CANARY", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit", partialNarration: null, createdAt: timestamp, updatedAt: timestamp });
  await page.evaluate(async snapshot => {
    const run = { jobId: snapshot.id, async *watch() {
      yield { type: "degraded", reason: "transport_unavailable", consecutiveFailures: 3 };
      yield { type: "status", snapshot };
      yield { type: "result_unavailable", jobId: snapshot.id, error: new Error("PRIVATE_CANARY") };
    } };
    await (window as any).__observeGenerationRun(run, "PRIVATE_ACTION_CANARY");
  }, snapshot);
  await expect(page.locator("#activityLogList")).toContainText("This browser"); await page.locator("#activityLogFilter").selectOption("browser");
  for (const summary of await page.locator(".activity-log-entry summary").all()) await summary.click();
  await expect(page.locator("#activityLogList")).toContainText("does not establish that generation failed"); await expect(page.locator("#activityLogList")).toContainText("completed result could not be loaded");
  await page.locator("#activityLogFilter").selectOption("generation"); await expect(page.locator("#activityLogList")).toContainText("completed"); await expect(page.locator("#activityLogDialog")).not.toContainText("PRIVATE_CANARY"); expect(api.errors).toEqual([]);
});
test("replacement Story route coexists with legacy Activity", async ({ page }) => {
  const api = await install(page); await page.goto(`${nextOrigin}/app/story/${campaignId}`); await expect(page.getByRole("article").first()).toContainText("The platform is quiet"); expect(api.writes).toEqual([]);
});

test("a delayed fresh session never exposes cached entries before verification", async ({ page }) => {
  const api = await install(page); await open(page); api.holdSession(); await page.reload();
  await expect(page.locator("#activityLogNotices")).toContainText("Identity and campaign access");
  await expect(page.locator("#activityLogList .activity-log-entry")).toHaveCount(0);
  api.releaseSession(); await expect(page).toHaveTitle("Fixture Story \u2014 Infinite Quest");
  await page.locator("#btnOpenActivityLog").evaluate((button: HTMLElement) => button.click()); await expect(page.locator("#activityLogList")).toContainText("Generation"); expect(api.errors).toEqual([]);
});
test("a stale retention cursor reloads the bounded latest page and explains the gap", async ({ page }) => {
  const api = await install(page); await open(page); api.reset(); await refresh(page);
  await expect(page.locator("#activityLogNotices")).toContainText("History gap after retention expiry"); await expect(page.locator("#activityLogList")).toContainText("Generation"); expect(api.errors).toEqual([]);
});

test("a confirmed job failure never creates a synthetic submission failure; transport rejection does", async ({ page }) => {
  await install(page); await open(page);
  const snapshot = generationJobSnapshotSchema.parse({ id: jobId, campaignId, status: "failed", operationKind: "append", replacementTurnId: null, expectedTurnNumber: 2, attempts: 1, errorCode: "generation_failed", errorMessage: "Generation could not be completed.", resultTurnId: null, action: "PRIVATE_ACTION_CANARY", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit", partialNarration: null, createdAt: timestamp, updatedAt: timestamp });
  await page.evaluate(async snapshot => {
    (window as any).__workflow.submit = async () => ({ jobId: snapshot.id, async *watch() { yield { type: "status", snapshot }; yield { type: "settled", outcome: "failed", error: new Error("PRIVATE_CANARY") }; } });
    await (window as any).__runGeneration("PRIVATE_ACTION_CANARY");
  }, snapshot);
  expect(await page.evaluate(() => (window as any).__activity.getState().observations.some((entry: any) => entry.kind === "browser.submission_failed"))).toBe(false);
  await page.evaluate(async () => { (window as any).__workflow.submit = async () => { throw new Error("PRIVATE_CANARY"); }; await (window as any).__runGeneration("PRIVATE_ACTION_CANARY"); });
  await expect.poll(() => page.evaluate(() => (window as any).__activity.getState().observations.some((entry: any) => entry.kind === "browser.submission_failed"))).toBe(true);
  await expect(page.locator("#activityLogDialog")).not.toContainText("PRIVATE_CANARY");
});

test("a late campaign A illustration error cannot write diagnostics or state into campaign B", async ({ page }) => {
  const api = await install(page); await open(page); api.holdConfig(); await page.evaluate(id => { void (window as any).__loadCampaign(id); }, campaignId);
  await expect.poll(() => api.delayedConfig() !== null).toBe(true); await page.evaluate(async id => { await (window as any).__loadCampaign(id); }, campaignB);
  await api.releaseConfig(); await expect(page).toHaveTitle("Second campaign \u2014 Infinite Quest");
  expect(await page.evaluate(() => (window as any).__activity.getState().observations.some((entry: any) => entry.kind === "browser.illustration_command_failed"))).toBe(false);
  await expect(page.locator("#activityLogDialog")).not.toContainText("PRIVATE_CANARY"); expect(api.errors).toEqual([]);
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`late ${outcome} of campaign A submission preserves campaign B generation`, async ({ page }) => {
    const api = await install(page); await open(page);
    await page.evaluate(() => {
      const w = window as any;
      w.__workflow.submit = () => new Promise((resolve, reject) => { w.__resolveA = resolve; w.__rejectA = reject; });
      w.__oldSubmission = w.__runGeneration("A private draft");
    });
    await page.evaluate(async id => { await (window as any).__loadCampaign(id); }, campaignB);
    await page.evaluate(() => {
      const w = window as any;
      w.__workflow.submit = () => new Promise(resolve => { w.__resolveB = resolve; });
      w.__newSubmission = w.__runGeneration("B current draft"); w.__bAbort = w.__state.abortController;
    });
    await page.evaluate(async ({ outcome, jobId }) => {
      const w = window as any;
      if (outcome === "reject") w.__rejectA(Object.assign(new Error("PRIVATE_A_FAILURE"), { pendingGeneration: { id: jobId, action: "A draft" } }));
      else w.__resolveA({ jobId, async *watch() { throw new Error("stale watcher must not start"); } });
      await w.__oldSubmission;
    }, { outcome, jobId });
    expect(await page.evaluate(() => { const w = window as any; return w.__state.abortController === w.__bAbort; })).toBe(true);
    await expect(page.locator("#generationProgress")).not.toHaveClass(/hidden/u);
    expect(await page.evaluate(id => (window as any).__state.pendingGeneration?.id === id, jobId)).toBe(false);
    expect(await page.evaluate(() => (window as any).__activity.getState().observations.some((entry: any) => entry.kind === "browser.submission_failed"))).toBe(false);
    await expect(page.locator("body")).not.toContainText("PRIVATE_A_FAILURE"); expect(api.errors).toEqual([]);
  });
}

test("stale resume and rematch responses cannot start campaign B monitors", async ({ page }) => {
  const api = await install(page); await open(page);
  await page.evaluate(jobId => {
    const w = window as any; w.__state.pendingGeneration = { id: jobId }; w.__watchCalls = 0; w.__resolutionCalls = 0;
    w.__workflow.resume = () => new Promise(resolve => { w.__resumeRelease = () => resolve({ jobId, async *watch() { w.__watchCalls++; } }); });
    w.__illustrationApi.rematch = () => new Promise(resolve => { w.__rematchRelease = resolve; });
    w.__illustrationApi.resolution = async () => { w.__resolutionCalls++; return { status: "failed" }; };
    w.__resumePromise = w.__resumePendingGeneration(); w.__rematchPromise = w.__rematch("A-turn");
  }, jobId);
  await page.evaluate(async id => { await (window as any).__loadCampaign(id); }, campaignB);
  await page.evaluate(async () => { const w = window as any; w.__resumeRelease(); w.__rematchRelease(); await Promise.all([w.__resumePromise, w.__rematchPromise]); });
  expect(await page.evaluate(() => [(window as any).__watchCalls, (window as any).__resolutionCalls])).toEqual([0, 0]);
  expect(await page.evaluate(id => (window as any).__state.generationRun?.jobId === id, jobId)).toBe(false);
  expect(await page.evaluate(() => (window as any).__activity.getState().observations.some((entry: any) => entry.turnId === "A-turn"))).toBe(false);
  expect(api.errors).toEqual([]);
});

test("successful illustration retry renders queued job and resumes polling without false failure", async ({ page }) => {
  const api = await install(page); await open(page); await page.keyboard.press("Escape");
  await page.evaluate(jobId => {
    const w = window as any; w.__retryCalls = 0; w.__pollCalls = 0; w.__state.illustrationConfig = { ...w.__state.illustrationConfig, enabled: true, sourcePolicy: "generated" };
    const turn = w.__state.turns[w.__state.turns.length - 1]; w.__state.viewTurnNumber = turn.turnNumber; const failed = { id: jobId, turnId: turn.id || turn.turnId, status: "failed", errorMessage: "Illustration generation did not complete." };
    w.__illustrationApi.retryImageJob = async () => { w.__retryCalls++; return { ...failed, status: "queued" }; };
    w.__illustrationApi.imageJobs = async () => { w.__pollCalls++; return { jobs: [] }; };
    document.getElementById("storyIllustrationPanel")!.classList.remove("hidden"); w.__renderSceneImageJob(failed);
  }, jobId);
  await page.getByRole("button", { name: "Retry illustration", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pollCalls)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__retryCalls)).toBe(1);
  expect(await page.evaluate(() => (window as any).__activity.getState().observations.some((entry: any) => entry.kind === "browser.illustration_command_failed"))).toBe(false);
  await expect(page.locator("body")).not.toContainText("Illustration retry failed"); expect(api.errors).toEqual([]);
});

test("successful Undo persists exactly one safe observation through campaign reload and document reload", async ({ page }) => {
  const api = await install(page); await open(page);
  await page.route("**/api/v1/campaigns/*/rewind", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ campaignId, activeTurnNumber: 0, discardedTurnCount: 1, stateSnapshot: {} }) }));
  page.on("dialog", dialog => dialog.accept());
  await page.keyboard.press("Escape");
  const before = api.syncs();
  await page.locator("#btnUndo").click();
  await expect.poll(() => api.syncs()).toBeGreaterThan(before);
  await expect.poll(() => page.evaluate(() => (window as any).__activity.getState().observations.filter((entry: any) => entry.kind === "browser.undo_result").length)).toBe(1);
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).__activity?.getState().observations.filter((entry: any) => entry.kind === "browser.undo_result").length)).toBe(1);
  const entries = await page.evaluate(() => (window as any).__activity.getState().observations.filter((entry: any) => entry.kind === "browser.undo_result"));
  expect(entries[0]).toMatchObject({ campaignId, severity: "info", diagnostic: null });
  expect(JSON.stringify(entries)).not.toContain("PRIVATE_CANARY"); expect(api.errors).toEqual([]);
});

test("persisted lifecycle revalidates before cache display across cycles and permanently cleans up", async ({ page }) => {
  const api = await install(page); await open(page);
  for (let cycle = 0; cycle < 2; cycle++) {
    api.holdSession(); const sessions = api.sessions();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await expect(page.locator("#activityLogList .activity-log-entry")).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect.poll(() => api.sessions()).toBeGreaterThan(sessions);
    await expect(page.locator("#activityLogList .activity-log-entry")).toHaveCount(0);
    api.releaseSession(); await expect(page.locator("#activityLogList")).toContainText("Generation");
    await expect.poll(() => page.evaluate(() => (window as any).__activity.getState().syncing)).toBe(false);
    const before = api.activityReads(); await refresh(page);
    await expect.poll(() => page.evaluate(() => (window as any).__activity.getState().syncing)).toBe(false);
    expect(api.activityReads()).toBe(before + 1);
  }
  api.deny();
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
  await expect(page.locator("#activityLogList .activity-log-entry")).toHaveCount(0);
  await expect(page.locator("#activityLogNotices")).toContainText("Identity and campaign access");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
  const sessions = api.sessions();
  await page.evaluate(async id => { window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); await (window as any).__activity.open({ apiBase: location.origin, ownerUserId: id, campaignId: id }); await (window as any).__activity.refresh(); }, campaignId);
  expect(api.sessions()).toBe(sessions);
  expect(await page.evaluate(() => (window as any).__activity.getState().scope)).toBeNull(); expect(api.errors).toEqual([]);
});

test("native Back restores Activity when Chromium admits the document to BFCache", async ({ page }) => {
  const api = await install(page); await open(page);
  await page.evaluate(() => {
    (window as any).__bfcacheMarker = true;
    window.addEventListener("pageshow", event => { (window as any).__nativePersisted = event.persisted; });
  });
  await page.route(`${origin}/bfcache-away`, route => route.fulfill({ contentType: "text/html", body: "<html><title>Away</title><body>Away</body></html>" }));
  await page.goto(`${origin}/bfcache-away`); await page.goBack();
  const admitted = await page.evaluate(() => Boolean((window as any).__bfcacheMarker && (window as any).__nativePersisted));
  test.skip(!admitted, "Chromium did not admit this routed automation document to BFCache; persisted lifecycle is separately simulated.");
  await expect(page.locator("#activityLogList")).toContainText("Generation");
  const before = api.activityReads(); await refresh(page);
  await expect.poll(() => api.activityReads()).toBeGreaterThan(before); expect(api.errors).toEqual([]);
});


test("persisted restore resumes one pending watcher and reconciles completion without submitting", async ({ page }) => {
  const api = await install(page); await open(page); api.pending(true);
  const result = { ...fixture.turns.turns[0]!, campaignId, turnNumber: 2, resultTurnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", narration: "The restored watcher reveals the accepted scene." };
  await page.evaluate(({ jobId, result }) => {
    const w = window as any; w.__resumeCalls = 0; w.__watchCalls = 0;
    const completion = new Promise<void>(resolve => { w.__completeRestored = resolve; });
    w.__workflow.resume = async () => { w.__resumeCalls++; return { jobId, async *watch() { w.__watchCalls++; await completion; yield { type: "settled", outcome: "completed", result }; } }; };
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  }, { jobId, result });
  await expect.poll(() => page.evaluate(() => [(window as any).__resumeCalls, (window as any).__watchCalls])).toEqual([1, 1]);
  await expect(page.locator("#btnUndo")).toBeDisabled();
  api.pending(false);
  await page.route(`**/api/v1/campaigns/${campaignId}/sync-status`, route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...fixture.syncStatus, campaign: { ...fixture.syncStatus.campaign, activeTurnNumber: 2 }, pendingGeneration: null, turns: { ...fixture.turns, turns: [...fixture.turns.turns, { ...result, id: result.resultTurnId }] } }) }));
  await page.evaluate(() => (window as any).__completeRestored());
  await expect(page.locator("#scene-2")).toContainText(result.narration);
  await expect(page.locator("#btnUndo")).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as any).__state.pendingGeneration)).toBeNull();
  expect(await page.evaluate(() => [(window as any).__resumeCalls, (window as any).__watchCalls])).toEqual([1, 1]);
  expect(api.writes).toEqual([]); expect(api.errors).toEqual([]);
});

for (const safety of ["campaign switch", "access denial"] as const) {
  test(`persisted pending restoration cannot attach after ${safety}`, async ({ page }) => {
    const api = await install(page); await open(page); api.pending(true);
    await page.evaluate(() => { const w = window as any; w.__resumeCalls = 0; w.__workflow.resume = async () => { w.__resumeCalls++; return null; }; });
    if (safety === "campaign switch") api.holdSession(); else api.deny();
    await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
    if (safety === "campaign switch") {
      await page.evaluate(id => { (window as any).__switchPromise = (window as any).__loadCampaign(id); }, campaignB);
      api.releaseSession(); await page.evaluate(() => (window as any).__switchPromise);
      await expect(page).toHaveTitle("Second campaign — Infinite Quest");
    } else await expect(page.locator("body")).toContainText("Error loading campaign");
    expect(await page.evaluate(() => (window as any).__resumeCalls)).toBe(0);
    expect(api.writes).toEqual([]); expect(api.errors).toEqual([]);
  });
}
