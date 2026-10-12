import { mkdir, readFile } from "node:fs/promises";
import { expect, test, type Page, type Route } from "@playwright/test";
import { campaignSyncStatusSchema, generationJobSnapshotSchema, generationResultSchema, generationReviewDetailSchema } from "../../packages/contracts/src/index.js";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const campaignId = "11111111-1111-4111-8111-111111111111";
const previousCampaignId = "22222222-2222-4222-8222-222222222222";
const worldId = "33333333-3333-4333-8333-333333333333";
const screenshots = ".superpowers/sdd/legacy-ui-2026-10-03/evidence/screenshots";

async function installStoryDocument(page: Page) {
  const html = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${campaignId}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
}

async function installApi(page: Page, statusCode: number) {
  let syncRequests = 0;
  await page.addInitScript(({ rememberedId }) => {
    localStorage.setItem("infiniteQuestLastCampaignId", rememberedId);
  }, { rememberedId: previousCampaignId });
  await page.route("**/api/v1/**", async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/session") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: { id: previousCampaignId, displayName: "Fixture owner", settings: { autoSubmitTurnChoices: false, continuousReading: false } }, authentication: "deferred" })
      });
      return;
    }
    if (url.pathname === "/api/v1/providers") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ providers: [{ id: "44444444-4444-4444-8444-444444444444", name: "Fixture text", providerType: "openai_compatible", providerRole: "text", enabled: true, isDefault: true }] }) });
      return;
    }
    if (url.pathname.endsWith("/sync-status")) {
      syncRequests += 1;
      await route.fulfill({ status: statusCode, contentType: "application/json", body: JSON.stringify({}) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });
  return { syncRequests: () => syncRequests };
}

function dashboardCampaign(id: string, title: string, status: "active" | "archived", updatedAt: string) {
  return {
    id, title, status, updatedAt, createdAt: updatedAt, activeTurnNumber: 1,
    worldId, worldTitle: "Synthetic World", worldVersionId: "44444444-4444-4444-8444-444444444444",
    worldVersionNumber: 1, latestWorldVersionNumber: 1, worldUpdateAvailable: false,
    selectedCharacterId: null, selectedCharacterName: null, storyLengthProfile: "standard",
    storyContextBudgetTokens: 32000, turnControlStyle: "flexible_action", textProviderProfileId: null,
    imageProviderProfileId: null, costInformation: []
  };
}

async function installDashboardApi(page: Page, campaignList: ReturnType<typeof dashboardCampaign>[], options: { failOnce?: boolean; delayList?: boolean } = {}) {
  let campaignRequests = 0;
  let releaseList!: () => void;
  const listReleased = new Promise<void>((resolve) => { releaseList = resolve; });
  await page.addInitScript((rememberedId) => {
    localStorage.setItem("infiniteQuestLastCampaignId", rememberedId);
    localStorage.setItem("infiniteQuestStoryDraft:preserve", "draft-preserved");
    localStorage.setItem("infiniteQuestReaderPreference:preserve", "preference-preserved");
  }, "stale-remembered-id");
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/campaigns" && route.request().method() === "GET") {
      campaignRequests += 1;
      if (options.delayList && campaignRequests === 1) {
        await listReleased;
      }
      if (options.failOnce && campaignRequests === 1) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({}) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ campaigns: campaignList }) });
      return;
    }
    if (url.pathname === "/api/v1/worlds") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ worlds: [] }) });
      return;
    }
    if (url.pathname.endsWith("/state")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeTurnNumber: 1, revision: 1 }) });
      return;
    }
    if (url.pathname.startsWith("/api/v1/worlds/")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ versions: [{ id: "44444444-4444-4444-8444-444444444444", versionNumber: 1 }] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });
  return { campaignRequests: () => campaignRequests, releaseList };
}

test("failed Story load preserves the prior resume ID and offers not-found recovery without campaign content", async ({ page }) => {
  const api = await installApi(page, 404);
  await installStoryDocument(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/story/${campaignId}`);

  await expect(page.locator("#storyLoadRecovery")).toBeVisible();
  await expect(page.locator("#storyLoadRecovery")).toContainText("Campaign not found");
  await expect(page.locator("#storyLoadRecovery a")).toHaveAttribute("href", "/nexus/#campaigns");
  await expect(page.locator("#storyLoadRetry")).toBeHidden();
  await expect(page.locator("#storyArea .turn")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("infiniteQuestLastCampaignId"))).toBe(previousCampaignId);
  expect(api.syncRequests()).toBe(1);

  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/t06-story-not-found.png`, fullPage: true });
});

test("403 Story load is shown as an access problem rather than a deleted campaign", async ({ page }) => {
  await installApi(page, 403);
  await installStoryDocument(page);
  await page.goto(`${origin}/story/${campaignId}`);

  await expect(page.locator("#storyLoadRecovery")).toBeVisible();
  await expect(page.locator("#storyLoadRecovery")).toContainText("don't have access");
  await expect(page.locator("#storyLoadRecovery")).not.toContainText("not found");
  await expect(page.locator("#storyLoadRecovery a")).toHaveAttribute("href", "/nexus/#campaigns");
});

test("network failure keeps Story recovery visible and retries the scoped load", async ({ page }) => {
  const api = await installApi(page, 503);
  await installStoryDocument(page);
  await page.goto(`${origin}/story/${campaignId}`);

  await expect(page.locator("#storyLoadRecovery")).toBeVisible();
  await expect(page.locator("#storyLoadRecovery")).toContainText("could not be loaded");
  await expect(page.locator("#storyLoadRetry")).toBeVisible();
  await page.locator("#storyLoadRetry").click();
  await expect.poll(() => api.syncRequests()).toBe(2);
  await expect(page.locator("#storyLoadRecovery")).toBeVisible();
  await expect(page.locator("#storyArea .turn")).toHaveCount(0);
});

test("successful Story retry resumes the pending generation and renders its accepted result without submitting another turn", async ({ page }) => {
  const payloads = quietLeafApiPayloads({ pendingGeneration: true });
  const pending = payloads.syncStatus.pendingGeneration!;
  const turn = {
    ...payloads.turns.turns[0]!,
    id: "77777777-7777-4777-8777-777777777777",
    turnNumber: 2,
    narration: "The recovered fixture turn appears after retry without refreshing the page."
  };
  const completed = generationJobSnapshotSchema.parse({
    ...pending,
    campaignId: payloads.campaignId,
    status: "completed",
    attempts: 1,
    resultTurnId: turn.id,
    requestedInputMode: "action",
    resolvedInputMode: "action",
    inputModeSource: "explicit",
    errorCode: null,
    errorMessage: null,
    partialNarration: null
  });
  const result = generationResultSchema.parse({
    ...turn,
    ...completed,
    turnNumber: 2,
    narration: turn.narration,
    modelMetadata: null,
    mechanics: null,
    stateSnapshot: {},
    reportedCost: null
  });
  const reads: string[] = [];
  const writes: string[] = [];
  const pageErrors: string[] = [];
  let syncRequests = 0;
  let jobPolls = 0;
  let resultLoaded = false;
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${path}`);
      return route.abort();
    }
    reads.push(path);
    if (path === "/api/v1/session") return respond(payloads.session);
    if (path === "/api/v1/providers") return respond({ providers: [{ id: "88888888-8888-4888-8888-888888888888", name: "Fixture text", providerType: "openai_compatible", providerRole: "text", enabled: true, isDefault: true }] });
    if (path.endsWith("/sync-status")) {
      syncRequests += 1;
      if (syncRequests === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({}) });
      return respond(resultLoaded ? {
        ...payloads.syncStatus,
        pendingGeneration: null,
        campaign: { ...payloads.syncStatus.campaign, activeTurnNumber: 2 },
        turns: { ...payloads.turns, turns: [...payloads.turns.turns, turn] }
      } : payloads.syncStatus);
    }
    if (path.endsWith("/turns")) return respond({ ...payloads.turns, turns: resultLoaded ? [...payloads.turns.turns, turn] : payloads.turns.turns });
    if (path.endsWith("/state") || path.endsWith("/state/inspection")) return respond(payloads.runtimeState);
    if (path.endsWith("/illustration-config")) return respond(payloads.illustrationConfig);
    if (path.endsWith("/illustration-segments")) return respond(payloads.illustrationSegments);
    if (path.endsWith("/image-jobs")) return respond({ jobs: [] });
    if (path === `/api/v1/generation-jobs/${pending.id}/stream`) return route.fulfill({
      contentType: "text/event-stream", body: 'data: {"invalid":true}\n\n'
    });
    if (path === `/api/v1/generation-jobs/${pending.id}`) {
      jobPolls += 1;
      return respond(jobPolls === 1 ? { invalid: true } : completed);
    }
    if (path === `/api/v1/generation-jobs/${pending.id}/result`) {
      resultLoaded = true;
      return respond(result);
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"Unavailable in fixture"}' });
  });
  await installStoryDocument(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/story/${campaignId}`);

  await expect(page.locator("#storyLoadRecovery")).toBeVisible();
  await expect(page.locator("#storyLoadRetry")).toBeEnabled();
  await page.locator("#storyLoadRetry").click();

  await expect(page.getByText(turn.narration, { exact: true })).toBeVisible();
  await expect(page.locator("#storyLoadRecovery")).toBeHidden();
  await expect(page.locator("#freeAction")).toBeEnabled();
  expect(syncRequests).toBeGreaterThanOrEqual(2);
  expect(reads.filter(path => path === `/api/v1/generation-jobs/${pending.id}/stream`)).toHaveLength(1);
  expect(reads).toContain(`/api/v1/generation-jobs/${pending.id}`);
  expect(reads).toContain(`/api/v1/generation-jobs/${pending.id}/result`);
  expect(reads).toContain(`/api/v1/campaigns/${campaignId}/image-jobs`);
  expect(jobPolls).toBeGreaterThanOrEqual(2);
  expect(writes).toEqual([]);
  expect(pageErrors).toEqual([]);

  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/t06-fix1-story-retry-resumed.png`, fullPage: true });
});

test("successful Story retry keeps an empty recoverable campaign at its explicit review choice", async ({ page }) => {
  const payloads = quietLeafApiPayloads();
  const jobId = "55555555-5555-4555-8555-555555555555";
  const reviewId = "66666666-6666-4666-8666-666666666666";
  const review = {
    version: 1 as const, reviewId, revision: 1, state: "pending" as const,
    stage: "continuity" as const, candidateScope: "final" as const,
    reasons: ["narrative_conflict"] as const, canKeep: true, canRetry: true
  };
  const recovery = {
    id: jobId, status: "recoverable" as const, operationKind: "append" as const,
    replacementTurnId: null, expectedTurnNumber: 1, attempts: 1,
    errorCode: "generation_failed", errorMessage: "Generation could not be completed.",
    diagnostic: { code: "context_evidence_omitted" as const, operation: "story_generation" as const, action: "adjust_context" as const },
    resultTurnId: null, review
  };
  const syncStatus = campaignSyncStatusSchema.parse({
    ...payloads.syncStatus,
    campaign: { ...payloads.syncStatus.campaign, activeTurnNumber: 0 },
    activeTurnNumber: 0,
    pendingGeneration: null,
    generationRecovery: recovery,
    turns: { campaignId, nextCursor: null, turns: [] }
  });
  const recoverySnapshot = generationJobSnapshotSchema.parse({
    ...recovery, campaignId, action: "Begin the fixture story.", requestedInputMode: "action",
    resolvedInputMode: "action", inputModeSource: "opening_action", partialNarration: null,
    createdAt: "2026-10-03T12:00:00.000Z", updatedAt: "2026-10-03T12:00:00.000Z"
  });
  const reviewDetail = generationReviewDetailSchema.parse({
    ...review,
    narration: "A synthetic recovered candidate remains available for your review.",
    choices: ["Keep the candidate", "Choose another direction"],
    findings: [{ code: "narrative_conflict", message: "The candidate needs your review." }],
    retryDescription: "Retry this generation stage.", retryFailure: null, omittedFindingCount: 0
  });
  const reads: string[] = [];
  const writes: string[] = [];
  let syncRequests = 0;
  let releaseRetrySync!: () => void;
  const retrySyncReleased = new Promise<void>(resolve => { releaseRetrySync = resolve; });
  page.on("pageerror", error => writes.push(`pageerror ${error.message}`));
  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${path}`);
      return route.abort();
    }
    reads.push(path);
    if (path === "/api/v1/session") return respond(payloads.session);
    if (path === "/api/v1/providers") return respond({ providers: [{ id: "88888888-8888-4888-8888-888888888888", name: "Fixture text", providerType: "openai_compatible", providerRole: "text", enabled: true, isDefault: true }] });
    if (path.endsWith("/sync-status")) {
      syncRequests += 1;
      if (syncRequests === 1) return respond({}, 503);
      if (syncRequests === 2) await retrySyncReleased;
      return respond(syncStatus);
    }
    if (path.endsWith("/state") || path.endsWith("/state/inspection")) return respond({ ...payloads.runtimeState, activeTurnNumber: 0, viewedTurnNumber: null });
    if (path.endsWith("/illustration-config")) return respond(payloads.illustrationConfig);
    if (path.endsWith("/illustration-segments")) return respond(payloads.illustrationSegments);
    if (path.endsWith("/image-jobs")) return respond({ jobs: [] });
    if (path === `/api/v1/generation-jobs/${jobId}`) return respond(recoverySnapshot);
    if (path === `/api/v1/generation-jobs/${jobId}/review`) return respond(reviewDetail);
    return respond({});
  });
  await installStoryDocument(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/story/${campaignId}`);
  await expect(page.locator("#storyLoadRecovery")).toBeVisible();
  await page.locator("#storyLoadRetry").evaluate(button => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect.poll(() => syncRequests).toBe(2);
  releaseRetrySync();

  await expect(page.locator("#generationReviewPanel")).toBeVisible();
  await expect(page.locator("#generationReviewHeading")).toContainText("needs your review");
  await expect(page.locator("#btnKeepGenerationReview")).toBeVisible();
  await expect(page.locator("#btnRetryGenerationReview")).toBeVisible();
  expect(syncRequests).toBeGreaterThanOrEqual(2);
  expect(reads).toContain(`/api/v1/generation-jobs/${jobId}/review`);
  expect(reads).not.toContain(`/api/v1/generation-jobs/${jobId}/stream`);
  expect(writes).toEqual([]);
  await expect(page.locator("#storyArea .turn")).toHaveCount(0);

  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/t06-fix1-story-retry-review-choice.png`, fullPage: true });
});

test("dashboard validates stale resume IDs and chooses the newest active campaign after the list loads", async ({ page }) => {
  const campaigns = [
    dashboardCampaign("archived-newest", "Archived Story", "archived", "2026-10-02T00:00:00.000Z"),
    dashboardCampaign("active-old", "Older Active Story", "active", "2026-09-01T00:00:00.000Z"),
    dashboardCampaign("active-new", "Newest Active Story", "active", "2026-10-01T00:00:00.000Z")
  ];
  const api = await installDashboardApi(page, campaigns, { delayList: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/nexus/index.html`);

  await expect(page.locator("#dashboardStoryLink")).toHaveAttribute("href", "/nexus/#campaigns");
  await api.releaseList();
  await expect(page.locator("#dashboardStoryLink")).toHaveAttribute("href", "/story/active-new");
  await expect(page.locator("#storyViewLink")).toHaveAttribute("href", "/story/active-new");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("infiniteQuestLastCampaignId"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("infiniteQuestStoryDraft:preserve"))).toBe("draft-preserved");
  expect(await page.evaluate(() => localStorage.getItem("infiniteQuestReaderPreference:preserve"))).toBe("preference-preserved");
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/t06-dashboard-resume-target.png`, fullPage: true });
});

test("dashboard permits an archived campaign after an explicit Campaigns selection", async ({ page }) => {
  const campaigns = [
    dashboardCampaign("archived-explicit", "Archived Story", "archived", "2026-10-02T00:00:00.000Z"),
    dashboardCampaign("active-default", "Active Story", "active", "2026-10-01T00:00:00.000Z")
  ];
  await installDashboardApi(page, campaigns);
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await expect(page.locator("#managementInteractiveRoot")).not.toHaveAttribute("inert", "");
  await expect(page.locator('#campaignList [data-campaign-id="active-default"]')).toBeVisible();
  await page.locator("#managementCampaignStatus").selectOption("archived");
  await expect(page.locator('#campaignList [data-campaign-id="archived-explicit"]')).toBeVisible();
  await page.locator('#campaignList [data-campaign-id="archived-explicit"]').click();
  await expect(page.locator("#storyViewLink")).toHaveAttribute("href", "/story/archived-explicit");
});

test("dashboard disables resume with no campaigns and retries a failed campaign-list request", async ({ page }) => {
  const api = await installDashboardApi(page, [], { failOnce: true });
  await page.goto(`${origin}/nexus/index.html`);

  await expect(page.locator("#dashboardStoryLink")).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#dashboardCampaigns")).toContainText("could not be loaded");
  await page.locator("#campaignLoadRetry").click();
  await expect.poll(() => api.campaignRequests()).toBe(2);
  await expect(page.locator("#dashboardCampaigns")).toContainText("No campaigns yet");
  await expect(page.locator("#dashboardStoryLink")).toHaveAttribute("href", "/nexus/#campaigns");
});
