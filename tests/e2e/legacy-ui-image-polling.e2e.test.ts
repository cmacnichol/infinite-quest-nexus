import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  generationJobSnapshotSchema,
  generationResultSchema,
  illustrationConfigResponseSchema,
  illustrationSegmentSchema,
  imageJobResponseSchema
} from "../../packages/contracts/src/index.js";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";
import type { LegacyUiFixture } from "./helpers/legacy-ui-fixtures.types.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const timestamp = "2026-10-03T12:00:00.000Z";
const enabledConfig = illustrationConfigResponseSchema.parse({
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
  maxAttempts: 3,
  segmentWordCount: 120,
  imagesPerSegment: 1,
  segmentPromptMode: "direct",
  refinementPrompt: "Synthetic fixture prompt.",
  defaultRefinementPrompt: "Synthetic fixture prompt.",
  updatedAt: timestamp
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

function campaignPath(id: string, suffix: string): string {
  return `/api/v1/campaigns/${id}/${suffix}`;
}

async function prepareStoryPage(page: Page, campaignIds: readonly string[]): Promise<void> {
  const html = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  for (const id of campaignIds) {
    await page.route(`**/story/${id}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  }
}

function makeImageJob(fixture: LegacyUiFixture, status: string) {
  const turn = fixture.turns.at(-1);
  if (!turn) throw new Error("An image-job fixture needs an accepted turn.");
  return imageJobResponseSchema.parse({
    id: "55555555-5555-4555-8555-555555555551",
    campaignId: fixture.campaignId,
    turnId: turn.id,
    worldId: fixture.worldId,
    targetType: "turn_illustration",
    segmentId: null,
    generationJobId: null,
    imageCount: 1,
    providerProfileId: null,
    model: "synthetic-image-model",
    status,
    attempts: status === "failed" ? 3 : 1,
    maxAttempts: 3,
    size: "1024x1024",
    aspectRatio: "1:1",
    quality: "standard",
    outputFormat: "png",
    assetId: null,
    assetUrl: "",
    providerType: "synthetic",
    generationRevision: 1,
    remoteJobId: null,
    providerStatus: status === "generating" ? "rendering" : null,
    providerProgress: status === "generating" ? 37 : null,
    providerQueuePosition: null,
    providerEtaAt: null,
    submittedAt: timestamp,
    lastPolledAt: timestamp,
    nextPollAt: null,
    generationDeadline: null,
    errorCode: status === "failed" ? "synthetic_image_failure" : null,
    errorMessage: status === "failed" ? "Synthetic image job failed." : null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null
  });
}

function makeImageSegment(fixture: LegacyUiFixture, imageUrl = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=") {
  const turn = fixture.turns.at(-1);
  if (!turn) throw new Error("An illustration-segment fixture needs an accepted turn.");
  const text = String(turn.narration);
  return illustrationSegmentSchema.parse({
    setId: "66666666-6666-4666-8666-666666666661",
    turnId: turn.id,
    setStatus: "completed",
    segmentWordCount: 120,
    imagesPerSegment: 1,
    promptMode: "direct",
    id: "66666666-6666-4666-8666-666666666662",
    ordinal: 0,
    startOffset: 0,
    endOffset: text.length,
    startWord: 0,
    endWord: text.trim().split(/\s+/u).length,
    text,
    status: "completed",
    promptSource: "direct",
    directPrompt: "A synthetic quiet station.",
    resolvedPrompt: "A synthetic quiet station.",
    variants: [{
      assetId: "77777777-7777-4777-8777-777777777771",
      url: imageUrl,
      variantIndex: 0,
      prompt: "A synthetic quiet station.",
      providerType: "synthetic",
      model: "synthetic-image-model",
      createdAt: timestamp,
      selectionReason: null,
      matchScore: null,
      matchThreshold: null,
      matchingAlgorithm: null
    }],
    imageJobId: null,
    imageJobStatus: null,
    providerStatus: null,
    providerProgress: null,
    errorMessage: null,
    promptJobStatus: "completed"
  });
}

test("single_initial_poll", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const relevantRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === campaignPath(id, "illustration-config")
      || path === campaignPath(id, "illustration-segments")
      || path === campaignPath(id, "image-jobs")) relevantRequests.push(path);
  });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === campaignPath(id, "illustration-config")) return route.fulfill({ json: enabledConfig });
    if (path === campaignPath(id, "illustration-segments")) return route.fulfill({ json: { segments: [] } });
    if (path === campaignPath(id, "image-jobs")) return route.fulfill({ json: { jobs: [] } });
    return route.fallback();
  });
  await page.clock.install();
  await prepareStoryPage(page, [id]);
  await page.goto(`${origin}/story/${id}`);
  await expect(page.locator("#scene-1 .scene-narration")).toContainText("synthetic station remains quiet");
  await expect.poll(() => relevantRequests.filter((path) => path === campaignPath(id, "image-jobs")).length).toBe(1);
  expect(relevantRequests.filter((path) => path === campaignPath(id, "illustration-config"))).toHaveLength(1);
  expect(relevantRequests.filter((path) => path === campaignPath(id, "illustration-segments"))).toHaveLength(1);

});

test("no_idle_polling", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const jobsReads: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === campaignPath(id, "illustration-config")) return route.fulfill({ json: enabledConfig });
    if (path === campaignPath(id, "illustration-segments")) return route.fulfill({ json: { segments: [] } });
    if (path === campaignPath(id, "image-jobs")) {
      jobsReads.push(path);
      return route.fulfill({ json: { jobs: [] } });
    }
    return route.fallback();
  });
  await page.clock.install();
  await prepareStoryPage(page, [id]);
  await page.goto(`${origin}/story/${id}`);
  await expect.poll(() => jobsReads.length).toBe(1);
  await page.clock.runFor(15_000);
  expect(jobsReads).toHaveLength(1);
});

test("pending_jobs_keep_the_five_second_poll_cadence", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const pending = makeImageJob(fixture, "generating");
  let jobsReads = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === campaignPath(id, "illustration-config")) return route.fulfill({ json: enabledConfig });
    if (path === campaignPath(id, "illustration-segments")) return route.fulfill({ json: { segments: [] } });
    if (path === campaignPath(id, "image-jobs")) {
      jobsReads += 1;
      return route.fulfill({ json: { jobs: [pending] } });
    }
    return route.fallback();
  });
  await page.clock.install();
  await prepareStoryPage(page, [id]);
  await page.goto(`${origin}/story/${id}`);
  await expect.poll(() => jobsReads).toBe(1);
  await page.clock.runFor(4_999);
  expect(jobsReads).toBe(1);
  await page.clock.runFor(1);
  await expect.poll(() => jobsReads).toBe(2);
  await page.clock.runFor(5_000);
  await expect.poll(() => jobsReads).toBe(3);
});

test("an_explicit_refresh_shares_the_inflight_image_job_poll", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const pending = makeImageJob(fixture, "generating");
  const started = deferred<void>();
  const release = deferred<void>();
  let configReads = 0;
  let segmentReads = 0;
  let jobsReads = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === campaignPath(id, "illustration-config")) {
      configReads += 1;
      return route.fulfill({ json: enabledConfig });
    }
    if (path === campaignPath(id, "illustration-segments")) {
      segmentReads += 1;
      return route.fulfill({ json: { segments: [] } });
    }
    if (path === campaignPath(id, "image-jobs")) {
      jobsReads += 1;
      if (jobsReads === 1) {
        started.resolve(undefined);
        await release.promise;
      }
      return route.fulfill({ json: { jobs: [pending] } });
    }
    return route.fallback();
  });
  await page.clock.install();
  await prepareStoryPage(page, [id]);
  await page.goto(`${origin}/story/${id}`);
  await started.promise;
  const refreshConfigResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === campaignPath(id, "illustration-config")
    && response.request().method() === "GET");
  const refreshSegmentsResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === campaignPath(id, "illustration-segments")
    && response.request().method() === "GET");
  await page.locator("#storyIllustrationPanel [data-action='refresh-illustrations']").click();
  const [refreshConfigResponse, refreshSegmentsResponse] = await Promise.all([
    refreshConfigResponsePromise,
    refreshSegmentsResponsePromise
  ]);
  await Promise.all([refreshConfigResponse.finished(), refreshSegmentsResponse.finished()]);
  await expect.poll(() => configReads).toBe(2);
  await expect.poll(() => segmentReads).toBe(2);
  await expect(page.locator("#storyIllustrationPanel")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(jobsReads).toBe(1);
  release.resolve(undefined);
  await expect.poll(() => page.locator("#storyIllustrationContent .image-job-status").count()).toBe(1);
  await page.clock.runFor(5_000);
  await expect.poll(() => jobsReads).toBe(2);
});

test("pending_segments_keep_polling_until_they_become_terminal", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const pendingSegment = illustrationSegmentSchema.parse({
    ...makeImageSegment(fixture),
    setStatus: "generating",
    status: "generating",
    imageJobStatus: "generating",
    providerStatus: "rendering",
    providerProgress: 38
  });
  const completeSegment = makeImageSegment(fixture);
  let segmentReads = 0;
  let jobsReads = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === campaignPath(id, "illustration-config")) return route.fulfill({ json: enabledConfig });
    if (path === campaignPath(id, "illustration-segments")) {
      segmentReads += 1;
      return route.fulfill({ json: { segments: [segmentReads === 1 ? pendingSegment : completeSegment] } });
    }
    if (path === campaignPath(id, "image-jobs")) {
      jobsReads += 1;
      return route.fulfill({ json: { jobs: [] } });
    }
    return route.fallback();
  });
  await page.clock.install();
  await prepareStoryPage(page, [id]);
  await page.goto(`${origin}/story/${id}`);
  await expect.poll(() => segmentReads).toBe(1);
  const secondJobsResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === campaignPath(id, "image-jobs"));
  const secondSegmentsResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === campaignPath(id, "illustration-segments"));
  await page.clock.runFor(5_000);
  const [secondJobsResponse, secondSegmentsResponse] = await Promise.all([
    secondJobsResponsePromise,
    secondSegmentsResponsePromise
  ]);
  await Promise.all([secondJobsResponse.finished(), secondSegmentsResponse.finished()]);
  await expect.poll(() => segmentReads).toBe(2);
  await expect.poll(() => jobsReads).toBe(2);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.clock.runFor(10_000);
  expect(segmentReads).toBe(2);
  expect(jobsReads).toBe(2);
});

test("changed_public_image_fields_update_progress_and_the_selected_variant", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const firstSegment = makeImageSegment(fixture);
  const replacementSegment = makeImageSegment(fixture, "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAADAkQBADs=");
  const firstJob = makeImageJob(fixture, "generating");
  const updatedJob = imageJobResponseSchema.parse({ ...firstJob, providerProgress: 76 });
  let segmentReads = 0;
  let jobsReads = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === campaignPath(id, "illustration-config")) return route.fulfill({ json: enabledConfig });
    if (path === campaignPath(id, "illustration-segments")) {
      segmentReads += 1;
      return route.fulfill({ json: { segments: [segmentReads === 1 ? firstSegment : replacementSegment] } });
    }
    if (path === campaignPath(id, "image-jobs")) {
      jobsReads += 1;
      return route.fulfill({ json: { jobs: [jobsReads === 1 ? firstJob : updatedJob] } });
    }
    return route.fallback();
  });
  await page.clock.install();
  await prepareStoryPage(page, [id]);
  await page.goto(`${origin}/story/${id}`);
  await expect(page.locator("#storyIllustrationContent .image-job-status")).toContainText("37%");
  await expect(page.locator("#storyIllustrationContent .segment-illustration-card img"))
    .toHaveAttribute("src", firstSegment.variants[0]!.url);
  await expect.poll(() => jobsReads).toBe(1);
  const secondJobsResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === campaignPath(id, "image-jobs"));
  const secondSegmentsResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === campaignPath(id, "illustration-segments"));
  await page.clock.runFor(5_000);
  const [secondJobsResponse, secondSegmentsResponse] = await Promise.all([
    secondJobsResponsePromise,
    secondSegmentsResponsePromise
  ]);
  await Promise.all([secondJobsResponse.finished(), secondSegmentsResponse.finished()]);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator("#storyIllustrationContent .image-job-status")).toContainText("76%");
  await expect(page.locator("#storyIllustrationContent .segment-illustration-card img"))
    .toHaveAttribute("src", "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAADAkQBADs=");
});

test("switch_cancels_old_loop", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 2 });
  await installLegacyUiFixture(page, fixture);
  const idA = campaignId(fixture, 0);
  const idB = campaignId(fixture, 1);
  const turnA = fixture.turns[0];
  if (!turnA) throw new Error("Campaign A needs an accepted turn.");
  const turnB = { ...turnA, id: "88888888-8888-4888-8888-888888888881", narration: "Campaign B owns a different accepted station scene." };
  const turns = [turnB];
  const pendingA = imageJobResponseSchema.parse({
    ...makeImageJob(fixture, "generating"),
    turnId: turnA.id,
    providerStatus: "A_ONLY_IMAGE_MARKER"
  });
  const campaignB = fixture.campaigns[1];
  if (!campaignB) throw new Error("Campaign B fixture is missing.");
  const syncCampaign = fixture.syncStatus.campaign as Record<string, unknown>;
  const syncTurns = fixture.syncStatus.turns as Record<string, unknown>;
  const syncStatusB = {
    ...fixture.syncStatus,
    campaign: { ...syncCampaign, id: idB, title: String(campaignB.title), activeTurnNumber: turns.length },
    turns: { ...syncTurns, campaignId: idB, turns }
  };
  const runtimeStateB = { ...fixture.runtimeState, campaignId: idB, activeTurnNumber: turns.length, viewedTurnNumber: turns.length, revision: 2 };
  let releaseA!: () => void;
  const lateAReply = new Promise<void>((resolve) => { releaseA = resolve; });
  let aJobsStarted!: () => void;
  const aJobsStartedPromise = new Promise<void>((resolve) => { aJobsStarted = resolve; });
  let aJobsCompleted!: () => void;
  const aJobsCompletedPromise = new Promise<void>((resolve) => { aJobsCompleted = resolve; });
  let aJobsReads = 0;
  let aSegmentReads = 0;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === campaignPath(idA, "illustration-config")) return route.fulfill({ json: enabledConfig });
    if (path === campaignPath(idA, "illustration-segments")) {
      aSegmentReads += 1;
      return route.fulfill({ json: { segments: [] } });
    }
    if (path === campaignPath(idA, "image-jobs")) {
      aJobsReads += 1;
      if (aJobsReads === 1) return route.fulfill({ json: { jobs: [pendingA] } });
      aJobsStarted();
      await lateAReply;
      await route.fulfill({ json: { jobs: [pendingA] } });
      aJobsCompleted();
      return;
    }
    if (path === campaignPath(idB, "sync-status")) return route.fulfill({ json: syncStatusB });
    if (path === campaignPath(idB, "state") || path === campaignPath(idB, "state/inspection")) return route.fulfill({ json: runtimeStateB });
    if (path === campaignPath(idB, "turns")) return route.fulfill({ json: { campaignId: idB, turns, nextCursor: null } });
    if (path === campaignPath(idB, "story-memory")) return route.fulfill({ json: { level: "off", reviewMode: "off", availableLevels: ["off"] } });
    if (path === campaignPath(idB, "illustration-config")) return route.fulfill({ json: enabledConfig });
    if (path === campaignPath(idB, "illustration-segments")) return route.fulfill({ json: { segments: [] } });
    if (path === campaignPath(idB, "image-jobs")) return route.fulfill({ json: { jobs: [] } });
    return route.fallback();
  });
  await page.clock.install();
  await prepareStoryPage(page, [idA, idB]);
  await page.goto(`${origin}/story/${idA}`);
  await expect(page.locator("#storyIllustrationContent .image-job-status")).toBeVisible();
  await expect.poll(() => aJobsReads).toBe(1);
  const lateAResponsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === campaignPath(idA, "image-jobs"));
  await page.clock.runFor(5_000);
  await aJobsStartedPromise;
  await page.evaluate((nextId) => {
    window.history.replaceState(null, "", `/story/${nextId}`);
    document.dispatchEvent(new Event("DOMContentLoaded"));
  }, idB);
  await expect(page.locator("#storyTitle")).toHaveText(String(campaignB.title));
  await expect(page.locator("#scene-1 .scene-narration")).toContainText("Campaign B owns a different accepted station scene.");
  releaseA();
  const lateAResponse = await lateAResponsePromise;
  await lateAResponse.finished();
  await aJobsCompletedPromise;
  await page.clock.runFor(10_000);
  expect(aJobsReads).toBe(2);
  expect(aSegmentReads).toBe(1);
  await expect(page.locator("#storyTitle")).toHaveText(String(campaignB.title));
  await expect(page.locator("#scene-1 .scene-narration")).toContainText("Campaign B owns a different accepted station scene.");
  await expect(page.locator("#scene-1 .image-job-status")).toHaveCount(0);
  await expect(page.locator("#activityLogList")).not.toContainText("A_ONLY_IMAGE_MARKER");
});

test("unchanged_segments_do_not_rebuild", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const pending = makeImageJob(fixture, "generating");
  const segment = makeImageSegment(fixture);
  let jobsReads = 0;
  let segmentReads = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === campaignPath(id, "image-jobs")) jobsReads += 1;
    if (request.method() === "GET" && path === campaignPath(id, "illustration-segments")) segmentReads += 1;
  });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === campaignPath(id, "illustration-config")) return route.fulfill({ json: enabledConfig });
    if (path === campaignPath(id, "illustration-segments")) return route.fulfill({ json: { segments: [segment] } });
    if (path === campaignPath(id, "image-jobs")) return route.fulfill({ json: { jobs: [pending] } });
    return route.fallback();
  });
  await page.clock.install();
  await prepareStoryPage(page, [id]);
  await page.goto(`${origin}/story/${id}`);
  const image = page.locator("#storyIllustrationContent .segment-illustration-card img");
  await expect(image).toHaveAttribute("src", "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=");
  await expect(page.locator("#storyIllustrationContent .image-job-status")).toBeVisible();
  await expect.poll(() => jobsReads).toBe(1);
  const sameImageAfterPoll = page.evaluate(() => {
    const image = document.querySelector("#storyIllustrationContent .segment-illustration-card img");
    if (!image) throw new Error("The synthetic illustration did not render.");
    (window as Window & { __t29ImageNode?: Element }).__t29ImageNode = image;
  });
  await sameImageAfterPoll;
  const secondJobsResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === campaignPath(id, "image-jobs"));
  const secondSegmentsResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === campaignPath(id, "illustration-segments"));
  await page.clock.runFor(5_000);
  const [secondJobsResponse, secondSegmentsResponse] = await Promise.all([
    secondJobsResponsePromise,
    secondSegmentsResponsePromise
  ]);
  await Promise.all([secondJobsResponse.finished(), secondSegmentsResponse.finished()]);
  await expect.poll(() => jobsReads).toBe(2);
  await expect.poll(() => segmentReads).toBe(2);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const sameImageNode = await page.evaluate(() => {
    return document.querySelector("#storyIllustrationContent .segment-illustration-card img")
      === (window as Window & { __t29ImageNode?: Element }).__t29ImageNode;
  });
  expect(sameImageNode).toBe(true);
});

test("unchanged_completed_turn_images_do_not_rebuild_the_illustration_rail", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const turnImageUrl = "https://images.example/accepted-turn.png";
  await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const completed = imageJobResponseSchema.parse({
    ...makeImageJob(fixture, "completed"),
    assetUrl: turnImageUrl,
    completedAt: timestamp
  });
  const pending = imageJobResponseSchema.parse({
    ...makeImageJob(fixture, "generating"),
    id: "55555555-5555-4555-8555-555555555552"
  });
  const segment = makeImageSegment(fixture);
  let jobsReads = 0;
  let segmentReads = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === campaignPath(id, "illustration-config")) return route.fulfill({ json: enabledConfig });
    if (path === campaignPath(id, "illustration-segments")) {
      segmentReads += 1;
      return route.fulfill({ json: { segments: [segment] } });
    }
    if (path === campaignPath(id, "image-jobs")) {
      jobsReads += 1;
      return route.fulfill({ json: { jobs: [completed, pending] } });
    }
    return route.fallback();
  });
  await page.clock.install();
  await prepareStoryPage(page, [id]);
  await page.goto(`${origin}/story/${id}`);
  const image = page.locator("#storyIllustrationContent .segment-illustration-card img");
  await expect(image).toHaveAttribute("src", "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=");
  await expect.poll(() => jobsReads).toBe(1);
  await page.evaluate(() => {
    const image = document.querySelector("#storyIllustrationContent .segment-illustration-card img");
    if (!image) throw new Error("The synthetic illustration did not render.");
    (window as Window & { __t29CompletedImageNode?: Element }).__t29CompletedImageNode = image;
  });
  const secondJobsResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === campaignPath(id, "image-jobs"));
  const secondSegmentsResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === campaignPath(id, "illustration-segments"));
  await page.clock.runFor(5_000);
  const [secondJobsResponse, secondSegmentsResponse] = await Promise.all([
    secondJobsResponsePromise,
    secondSegmentsResponsePromise
  ]);
  await Promise.all([secondJobsResponse.finished(), secondSegmentsResponse.finished()]);
  await expect.poll(() => jobsReads).toBe(2);
  await expect.poll(() => segmentReads).toBe(2);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const sameImageNode = await page.evaluate(() => document.querySelector("#storyIllustrationContent .segment-illustration-card img")
    === (window as Window & { __t29CompletedImageNode?: Element }).__t29CompletedImageNode);
  expect(sameImageNode).toBe(true);
});

test("timestamp_only_job_updates_keep_status_and_retry_nodes", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const failedJob = makeImageJob(fixture, "failed");
  const pendingSegment = illustrationSegmentSchema.parse({
    ...makeImageSegment(fixture),
    status: "generating"
  });
  let jobsReads = 0;
  let segmentReads = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === campaignPath(id, "illustration-config")) return route.fulfill({ json: enabledConfig });
    if (path === campaignPath(id, "illustration-segments")) {
      segmentReads += 1;
      return route.fulfill({ json: { segments: [pendingSegment] } });
    }
    if (path === campaignPath(id, "image-jobs")) {
      jobsReads += 1;
      const polledAt = new Date(Date.UTC(2026, 9, 3, 12, 0, jobsReads)).toISOString();
      const timestampedJob = imageJobResponseSchema.parse({
        ...failedJob,
        lastPolledAt: polledAt,
        updatedAt: polledAt
      });
      return route.fulfill({ json: { jobs: [timestampedJob] } });
    }
    return route.fallback();
  });
  await page.clock.install();
  await prepareStoryPage(page, [id]);
  await page.goto(`${origin}/story/${id}`);
  const status = page.locator("#storyIllustrationContent .image-job-status");
  await expect(status).toBeVisible();
  const retry = status.getByRole("button", { name: "Retry illustration" });
  await expect(retry).toBeVisible();
  await expect.poll(() => jobsReads).toBe(1);
  await page.evaluate(() => {
    const status = document.querySelector("#storyIllustrationContent .image-job-status");
    const label = status?.querySelector("p");
    const retry = status?.querySelector("button");
    if (!status || !label || !retry) throw new Error("The failed image job did not render its retry state.");
    (window as Window & { __t29TimestampStableStatus?: { status: Element; label: Element; retry: Element } })
      .__t29TimestampStableStatus = { status, label, retry };
  });
  const secondJobsResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === campaignPath(id, "image-jobs"));
  const secondSegmentsResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === campaignPath(id, "illustration-segments"));
  await page.clock.runFor(5_000);
  const [secondJobsResponse, secondSegmentsResponse] = await Promise.all([
    secondJobsResponsePromise,
    secondSegmentsResponsePromise
  ]);
  await Promise.all([secondJobsResponse.finished(), secondSegmentsResponse.finished()]);
  await expect.poll(() => jobsReads).toBe(2);
  await expect.poll(() => segmentReads).toBe(2);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const retainedNodes = await page.evaluate(() => {
    const prior = (window as Window & { __t29TimestampStableStatus?: { status: Element; label: Element; retry: Element } })
      .__t29TimestampStableStatus;
    return {
      status: document.querySelector("#storyIllustrationContent .image-job-status") === prior?.status,
      label: document.querySelector("#storyIllustrationContent .image-job-status p") === prior?.label,
      retry: document.querySelector("#storyIllustrationContent .image-job-status button") === prior?.retry
    };
  });
  expect(retainedNodes).toEqual({ status: true, label: true, retry: true });
});

test("image_failure_does_not_block_acceptance", async ({ page }, testInfo) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const timestamp = "2026-10-03T12:00:00.000Z";
  const generationJobId = "55555555-5555-4555-8555-555555555552";
  const resultTurnId = "99999999-9999-4999-8999-999999999997";
  const generationJob = {
    id: generationJobId,
    campaignId: id,
    expectedTurnNumber: 2,
    action: "Look beyond the station clock.",
    requestedInputMode: "action",
    resolvedInputMode: "action",
    inputModeSource: "explicit",
    operationKind: "append",
    replacementTurnId: null,
    attempts: 1,
    resultTurnId,
    errorCode: null,
    errorMessage: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "completed"
  };
  const syncGate = deferred<void>();
  const resyncStarted = deferred<void>();
  let syncReads = 0;
  const posts: string[] = [];
  const generationWrites: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(new URL(request.url()).pathname);
  });
  let imageFailureResponseObserved = false;
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === campaignPath(id, "illustration-config") && response.status() === 503) {
      imageFailureResponseObserved = true;
    }
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === campaignPath(id, "illustration-config")) {
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic image status unavailable." }) });
    }
    if (request.method() === "POST" && path === campaignPath(id, "generations")) {
      generationWrites.push(request.postDataJSON());
      return route.fulfill({ status: 202, json: { id: generationJobId, status: "queued", duplicate: false, operationKind: "append", replacementTurnId: null } });
    }
    if (request.method() === "GET" && path === campaignPath(id, "sync-status") && ++syncReads > 1) {
      resyncStarted.resolve(undefined);
      await syncGate.promise;
      return route.fulfill({ json: fixture.syncStatus });
    }
    if (path === `/api/v1/generation-jobs/${generationJobId}/stream`) return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (path === `/api/v1/generation-jobs/${generationJobId}`) {
      return route.fulfill({ json: generationJobSnapshotSchema.parse({ ...generationJob, partialNarration: null }) });
    }
    if (path === `/api/v1/generation-jobs/${generationJobId}/result`) {
      return route.fulfill({ json: generationResultSchema.parse({
        ...generationJob,
        turnNumber: 2,
        inputMode: "action",
        narration: "A second accepted scene follows the station clock into the quiet archive.",
        choices: [],
        customActionSuggestion: "",
        imagePrompt: "",
        acceptedAt: timestamp,
        chronicleRetrieval: null,
        modelMetadata: null,
        mechanics: null,
        stateSnapshot: {},
        reportedCost: null
      }) });
    }
    return route.fallback();
  });
  try {
    await prepareStoryPage(page, [id]);
    await page.goto(`${origin}/story/${id}`);
    await expect(page.locator("#scene-1 .scene-narration")).toContainText("synthetic station remains quiet");
    await expect(page.locator("#readerTurnCount")).toHaveText("Turn 1 of 1");
    await expect(page.locator("#storyIllustrationPanel [role=status]")).toContainText("Illustration status could not be loaded");
    await page.locator("#freeAction").fill("Look beyond the station clock.");
    await page.locator("#btnTakeAction").click();
    await resyncStarted.promise;
    await expect(page.locator("#scene-2 .scene-narration")).toContainText("A second accepted scene follows the station clock");
    await expect(page.locator("#readerTurnCount")).toHaveText("Turn 2 of 2");
    expect(generationWrites).toHaveLength(1);
    expect(posts).toEqual([campaignPath(id, "generations")]);
    expect(imageFailureResponseObserved).toBe(true);
    syncGate.resolve(undefined);
    await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
    await expect(page.locator("#readerTurnCount")).toHaveText("Turn 2 of 2");
    await expect(page.locator("#freeAction")).toHaveValue("");
    const screenshot = testInfo.outputPath("t29-accepted-story-with-image-failure.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach("accepted-story-remains-readable-while-image-status-fails", { path: screenshot, contentType: "image/png" });
  } finally {
    syncGate.resolve(undefined);
  }
});

test("retry_only_image_job", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const failed = makeImageJob(fixture, "failed");
  const queued = imageJobResponseSchema.parse({ ...failed, status: "queued", attempts: 4, errorCode: null, errorMessage: null });
  const requests: Array<{ method: string; path: string }> = [];
  page.on("request", (request) => requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === campaignPath(id, "illustration-config")) return route.fulfill({ json: enabledConfig });
    if (path === campaignPath(id, "illustration-segments")) return route.fulfill({ json: { segments: [] } });
    if (path === campaignPath(id, "image-jobs")) return route.fulfill({ json: { jobs: [failed] } });
    if (request.method() === "POST" && path === `/api/v1/image-jobs/${failed.id}/retry`) return route.fulfill({ json: queued });
    return route.fallback();
  });
  await prepareStoryPage(page, [id]);
  await page.goto(`${origin}/story/${id}`);
  await expect(page.getByRole("button", { name: "Retry illustration" })).toBeVisible();
  await page.getByRole("button", { name: "Retry illustration" }).click();
  await expect.poll(() => requests.filter((request) => request.method === "POST").length).toBe(1);
  expect(requests.filter((request) => request.method === "POST")).toEqual([
    { method: "POST", path: `/api/v1/image-jobs/${failed.id}/retry` }
  ]);
  await expect(page.locator("#scene-1 .scene-narration")).toContainText("synthetic station remains quiet");
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 1 of 1");
});
