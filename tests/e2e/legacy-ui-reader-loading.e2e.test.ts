import { expect, test, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";
import type { LegacyUiFixture } from "./helpers/legacy-ui-fixtures.types.js";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";
import { generationJobSnapshotSchema, generationResultSchema, illustrationConfigResponseSchema } from "../../packages/contracts/src/index.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const imageConfig = illustrationConfigResponseSchema.parse({
  enabled: true,
  sourcePolicy: "generate_only",
  matchingScope: "campaign",
  confidenceProfile: "balanced",
  repetitionWindow: 0,
  providerProfileId: null,
  model: "synthetic-image-model",
  size: "1024x1024",
  aspectRatio: "1:1",
  quality: "standard",
  outputFormat: "png",
  maxAttempts: 1,
  segmentWordCount: 120,
  imagesPerSegment: 1,
  segmentPromptMode: "direct",
  refinementPrompt: "Synthetic browser fixture.",
  defaultRefinementPrompt: "Synthetic browser fixture.",
  updatedAt: "2026-10-03T12:00:00.000Z"
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function campaignId(fixture: LegacyUiFixture, index = 0): string {
  const campaign = fixture.campaigns[index];
  if (!campaign) throw new Error(`Campaign fixture ${index} is missing.`);
  return String(campaign.id);
}

function apiPath(id: string, suffix: string): string {
  return `/api/v1/campaigns/${id}/${suffix}`;
}

async function prepareStoryPage(page: Page, campaignIds: readonly string[]): Promise<void> {
  const html = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  for (const id of campaignIds) {
    await page.route(`**/story/${id}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  }
}

async function holdGet(page: Page, path: string) {
  const started = deferred<void>();
  const release = deferred<void>();
  let requests = 0;
  await page.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    if (request.method() === "GET" && new URL(request.url()).pathname === path) {
      requests += 1;
      started.resolve(undefined);
      await release.promise;
    }
    await route.fallback();
  });
  return { started: started.promise, release: () => release.resolve(undefined), requests: () => requests };
}

async function installCampaignBResponses(page: Page, fixture: LegacyUiFixture, index = 1): Promise<void> {
  const id = campaignId(fixture, index);
  const campaign = fixture.campaigns[index];
  if (!campaign) throw new Error(`Campaign fixture ${index} is missing.`);
  const turns = fixture.turns.map((turn) => ({ ...turn }));
  const syncCampaign = fixture.syncStatus.campaign as Record<string, unknown>;
  const syncTurns = fixture.syncStatus.turns as Record<string, unknown>;
  const syncStatus = {
    ...fixture.syncStatus,
    campaign: { ...syncCampaign, id, title: String(campaign.title), activeTurnNumber: turns.length },
    turns: { ...syncTurns, campaignId: id, turns }
  };
  const runtimeState = { ...fixture.runtimeState, campaignId: id, activeTurnNumber: turns.length, viewedTurnNumber: turns.length, revision: 2, continuitySummary: "Current campaign B summary." };
  const emptySegments = { segments: [] };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fallback();
    const url = new URL(request.url());
    if (url.pathname === apiPath(id, "sync-status")) return route.fulfill({ json: syncStatus });
    if (url.pathname === apiPath(id, "state") || url.pathname === apiPath(id, "state/inspection")) return route.fulfill({ json: runtimeState });
    if (url.pathname === apiPath(id, "turns")) return route.fulfill({ json: { campaignId: id, turns, nextCursor: null } });
    if (url.pathname === apiPath(id, "story-memory")) return route.fulfill({ json: { level: "off", reviewMode: "off", availableLevels: ["off"] } });
    if (url.pathname === apiPath(id, "illustration-config")) return route.fulfill({ json: { ...imageConfig, enabled: false, sourcePolicy: "off" } });
    if (url.pathname === apiPath(id, "illustration-segments")) return route.fulfill({ json: emptySegments });
    if (url.pathname === apiPath(id, "image-jobs")) return route.fulfill({ json: { jobs: [] } });
    return route.fallback();
  });
}

test("blocked_image_does_not_block_narration_or_the_accepted_turn_count", async ({ page }, testInfo) => {
  const fixture = legacyUiFixture({ turnCount: 2, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  const requests: string[] = [];
  page.on("request", (request) => { requests.push(new URL(request.url()).pathname); });
  const id = campaignId(fixture);
  const configGate = await holdGet(page, apiPath(id, "illustration-config"));
  const sceneNarration = String(fixture.turns[1]?.narration);
  try {
    await prepareStoryPage(page, [id]);
    await page.goto(`${origin}/story/${id}`);
    await configGate.started;
    await expect(page.locator("#scene-2 .scene-narration")).toContainText(sceneNarration);
    await expect(page.locator("#storyTitle")).toHaveText("Fixture Campaign 1");
    await expect(page.locator("#readerTurnCount")).toHaveText("Turn 2 of 2");
    await expect(page.locator("#btnPrev")).toBeEnabled();
    await expect(page.locator("#btnNext")).toBeDisabled();
    const stateIndex = requests.indexOf(apiPath(id, "state"));
    const configIndex = requests.indexOf(apiPath(id, "illustration-config"));
    expect(stateIndex).toBeGreaterThanOrEqual(0);
    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(stateIndex).toBeLessThan(configIndex);
    const desktopPath = testInfo.outputPath("t27-images-pending-desktop.png");
    await page.screenshot({ path: desktopPath, fullPage: true });
    await testInfo.attach("desktop-reading-with-images-pending", { path: desktopPath, contentType: "image/png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#scene-2 .scene-narration")).toBeVisible();
    const narrowPath = testInfo.outputPath("t27-images-pending-narrow.png");
    await page.screenshot({ path: narrowPath, fullPage: true });
    await testInfo.attach("narrow-reading-with-images-pending", { path: narrowPath, contentType: "image/png" });
  } finally {
    configGate.release();
  }
});

test("image_failure_keeps_story_and_does_not_write_campaign_state", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const instrumentation = await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  let segmentReads = 0;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === apiPath(id, "illustration-config")) {
      await route.fulfill({ json: imageConfig });
      return;
    }
    if (request.method() === "GET" && path === apiPath(id, "illustration-segments")) {
      segmentReads += 1;
      if (segmentReads === 1) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic illustration read failure" }) });
      } else {
        await route.fulfill({ json: { segments: [] } });
      }
      return;
    }
    await route.fallback();
  });
  await prepareStoryPage(page, [id]);
  await page.goto(`${origin}/story/${id}`);

  await expect(page.locator("#scene-1 .scene-narration")).toContainText("synthetic station remains quiet");
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 1 of 1");
  await expect(page.locator("#storyIllustrationPanel [role=status]")).toContainText("Illustration status could not be loaded");
  expect(segmentReads).toBe(1);
  await page.locator('#storyIllustrationPanel [data-action="refresh-illustrations"]').click();
  await expect(page.locator("#storyIllustrationPanel [role=status]")).toHaveCount(0);
  expect(segmentReads).toBe(2);
  await expect(page.locator("#scene-1 .scene-narration")).toContainText("synthetic station remains quiet");
  expect(instrumentation.writes.filter((write) => write.path === apiPath(id, "state"))).toEqual([]);
  expect(instrumentation.writes.filter((write) => write.path === apiPath(id, "generations"))).toEqual([]);
});

test("a_failed_illustration_config_read_does_not_clear_accepted_narration", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const instrumentation = await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    if (request.method() === "GET" && new URL(request.url()).pathname === apiPath(id, "illustration-config")) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic image configuration failure" }) });
      return;
    }
    await route.fallback();
  });
  await prepareStoryPage(page, [id]);
  await page.goto(`${origin}/story/${id}`);

  await expect(page.locator("#scene-1 .scene-narration")).toContainText("synthetic station remains quiet");
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 1 of 1");
  expect(instrumentation.writes.filter((write) => write.method !== "GET" && write.method !== "HEAD")).toEqual([]);
});

test("pending_generation_remains_locked_while_optional_image_data_is_blocked", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const pending = quietLeafApiPayloads({ pendingGeneration: true }).syncStatus.pendingGeneration;
  fixture.syncStatus.pendingGeneration = pending;
  const api = await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const configGate = await holdGet(page, apiPath(id, "illustration-config"));
  try {
    await prepareStoryPage(page, [id]);
    await page.goto(`${origin}/story/${id}`);
    await configGate.started;
    await expect(page.locator("#scene-1 .scene-narration")).toBeVisible();
    await expect(page.locator("#btnTakeAction")).toBeDisabled();
    await expect(page.locator("#freeAction")).toBeDisabled();
    await expect(page.locator("#btnRetry")).toBeDisabled();
    configGate.release();
    await expect(page.locator("#readerTurnCount")).toHaveText("Turn 1 of 1");
    await expect(page.locator("#btnTakeAction")).toBeDisabled();
    expect(api.writes.filter((write) => write.method !== "GET")).toEqual([]);
  } finally {
    configGate.release();
  }
});

test("late_campaign_a_runtime_completion_cannot_replace_campaign_b", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 2 });
  fixture.runtimeState.revision = 999;
  fixture.runtimeState.continuitySummary = "Retired campaign A summary.";
  await installLegacyUiFixture(page, fixture);
  const idA = campaignId(fixture, 0);
  const idB = campaignId(fixture, 1);
  const runtimeGate = await holdGet(page, apiPath(idA, "state"));
  await installCampaignBResponses(page, fixture);
  await prepareStoryPage(page, [idA, idB]);

  await page.goto(`${origin}/story/${idA}`);
  await runtimeGate.started;
  await page.evaluate((nextId) => {
    window.history.replaceState(null, "", `/story/${nextId}`);
    document.dispatchEvent(new Event("DOMContentLoaded"));
  }, idB);
  await expect(page.locator("#storyTitle")).toHaveText("Fixture Campaign 2");
  await expect(page.locator("#scene-1 .scene-narration")).toBeVisible();
  await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
  // The fixture re-enters initialization in this document; dispatch the existing
  // editor action directly so duplicate navigation bindings do not toggle its menu twice.
  await page.locator("#btnOpenEditState").dispatchEvent("click");
  await expect(page.locator("#editStateDialog")).toBeVisible();
  await expect(page.locator("#editStateMeta")).toContainText("revision 2");
  await expect(page.locator("#editStateContinuitySummary")).toHaveValue("Current campaign B summary.");
  const lateRuntime = page.waitForResponse((response) => new URL(response.url()).pathname === apiPath(idA, "state"));
  runtimeGate.release();
  await (await lateRuntime).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator("#editStateMeta")).toContainText("revision 2");
  await expect(page.locator("#editStateMeta")).not.toContainText("Reload before saving");
  await expect(page.locator("#editStateContinuitySummary")).toHaveValue("Current campaign B summary.");
  await expect(page.locator("#storyTitle")).toHaveText("Fixture Campaign 2");
  await expect(page.locator("#scene-1 .scene-narration")).toContainText("synthetic station remains quiet");
});

test("late_campaign_a_image_completion_cannot_replace_campaign_b", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 2 });
  await installLegacyUiFixture(page, fixture);
  const idA = campaignId(fixture, 0);
  const idB = campaignId(fixture, 1);
  await page.route("**/api/v1/**", async (route) => {
    if (route.request().method() === "GET" && new URL(route.request().url()).pathname === apiPath(idA, "illustration-config")) {
      return route.fulfill({ json: imageConfig });
    }
    return route.fallback();
  });
  const imageGate = await holdGet(page, apiPath(idA, "illustration-config"));
  await installCampaignBResponses(page, fixture);
  await prepareStoryPage(page, [idA, idB]);

  await page.goto(`${origin}/story/${idA}`);
  await imageGate.started;
  await page.evaluate((nextId) => {
    window.history.replaceState(null, "", `/story/${nextId}`);
    document.dispatchEvent(new Event("DOMContentLoaded"));
  }, idB);
  await expect(page.locator("#storyTitle")).toHaveText("Fixture Campaign 2");
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 1 of 1");
  await expect(page.locator("#storyIllustrationPanel")).toBeHidden();
  const lateImage = page.waitForResponse((response) => new URL(response.url()).pathname === apiPath(idA, "illustration-config"));
  imageGate.release();
  const lateImageResponse = await lateImage;
  expect(await lateImageResponse.json()).toMatchObject({ enabled: true, sourcePolicy: "generate_only" });
  await lateImageResponse.finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator("#storyTitle")).toHaveText("Fixture Campaign 2");
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 1 of 1");
  await expect(page.locator("#storyIllustrationPanel")).toBeHidden();
  await expect(page.locator("#scene-1 .scene-narration")).toContainText("synthetic station remains quiet");
});

test("accepted_turn_count_stays_coherent_while_sync_and_images_are_delayed", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 6, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const configGate = await holdGet(page, apiPath(id, "illustration-config"));
  const syncGate = deferred<void>();
  const resyncStarted = deferred<void>();
  let syncReads = 0;
  const submissions: unknown[] = [];
  const jobId = "55555555-5555-4555-8555-555555555555";
  const turnId = "99999999-9999-4999-8999-999999999997";
  const timestamp = "2026-10-03T12:00:00.000Z";
  const job = {
    id: jobId, campaignId: id, expectedTurnNumber: 7, action: "Meet the keeper.",
    requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit",
    operationKind: "append", replacementTurnId: null, attempts: 1, resultTurnId: turnId,
    errorCode: null, errorMessage: null, createdAt: timestamp, updatedAt: timestamp, status: "completed"
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === apiPath(id, "generations")) {
      submissions.push(request.postDataJSON());
      return route.fulfill({ status: 202, json: { id: jobId, status: "queued", duplicate: false, operationKind: "append", replacementTurnId: null } });
    }
    if (request.method() === "GET" && path === apiPath(id, "sync-status") && ++syncReads > 1) {
      resyncStarted.resolve(undefined);
      await syncGate.promise;
      return route.fulfill({ json: fixture.syncStatus });
    }
    if (path === `/api/v1/generation-jobs/${jobId}/stream`) return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (path === `/api/v1/generation-jobs/${jobId}`) return route.fulfill({ json: generationJobSnapshotSchema.parse({ ...job, partialNarration: null }) });
    if (path === `/api/v1/generation-jobs/${jobId}/result`) return route.fulfill({ json: generationResultSchema.parse({
      ...job, turnNumber: 7, inputMode: "action", narration: "The keeper opens the lantern room.",
      choices: [], customActionSuggestion: "", imagePrompt: "", acceptedAt: timestamp,
      chronicleRetrieval: null, modelMetadata: null, mechanics: null, stateSnapshot: {}, reportedCost: null
    }) });
    return route.fallback();
  });
  try {
    await prepareStoryPage(page, [id]);
    await page.goto(`${origin}/story/${id}`);
    await configGate.started;
    await expect(page.locator("#readerTurnCount")).toHaveText("Turn 6 of 6");
    await page.locator("#freeAction").fill("Meet the keeper.");
    await page.locator("#btnTakeAction").click();
    await resyncStarted.promise;
    await expect(page.locator("#scene-7 .scene-narration")).toContainText("The keeper opens the lantern room.");
    await expect(page.locator("#readerTurnCount")).toHaveText("Turn 7 of 7");
    await expect(page.locator("#storyArea .scene[data-turn-number]")).toHaveCount(1);
    expect(submissions).toHaveLength(1);
    syncGate.resolve(undefined);
    await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
    await expect(page.locator("#readerTurnCount")).toHaveText("Turn 7 of 7");
    expect(submissions).toHaveLength(1);
  } finally {
    configGate.release();
    syncGate.resolve(undefined);
  }
});
