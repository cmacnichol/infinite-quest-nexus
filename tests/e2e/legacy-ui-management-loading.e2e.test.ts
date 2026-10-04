import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";
import type { LegacyUiFixture, LegacyUiRouteInstrumentation } from "./helpers/legacy-ui-fixtures.types.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const t26EvidenceDirectory = ".superpowers/sdd/legacy-ui-2026-10-03/evidence";
const optionalSectionReads = [
  "story-memory",
  "memory/metrics",
  "cost-summary",
  "memory/embedding-config",
  "illustration-config",
  "image-jobs",
  "memory/context-preview"
] as const;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function campaign(fixture: LegacyUiFixture, index = 0): Record<string, unknown> {
  const selected = fixture.campaigns[index];
  if (!selected) throw new Error(`Campaign fixture ${index} is missing.`);
  return selected;
}

function campaignId(fixture: LegacyUiFixture, index = 0): string {
  return String(campaign(fixture, index).id);
}

function pathFor(id: string, suffix: string): string {
  return `/api/v1/campaigns/${id}/${suffix}`;
}

function reads(api: LegacyUiRouteInstrumentation, path: string) {
  return api.requests.filter((request) => request.method === "GET" && request.path === path);
}

async function selectCampaign(page: Page, fixture: LegacyUiFixture, index = 0): Promise<void> {
  const selected = campaign(fixture, index);
  const id = String(selected.id);
  await expect(page.locator(`#campaignList [data-campaign-id="${id}"]`)).toBeVisible();
  await page.locator(`#campaignList [data-campaign-id="${id}"]`).click();
  await expect(page.locator("#campaignTitle")).toHaveValue(String(selected.title));
  await expect(page.locator("#campaignWorldVersion")).toHaveValue(String(selected.worldVersionId));
  await expect(page.locator("#saveCampaign")).toBeEnabled();
}

async function expectCampaignSectionBodies(page: Page, section: "chronicle" | "illustrations", visible: boolean): Promise<void> {
  const panel = section === "chronicle" ? "Chronicle" : "Illustrations";
  const bodies = page.locator(`#campaignPanel${panel} [data-campaign-section-body="${section}"]`);
  const count = await bodies.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    if (visible) await expect(bodies.nth(index)).toBeVisible();
    else await expect(bodies.nth(index)).toBeHidden();
  }
}

async function installCampaignWorkspace(page: Page, campaignCount = 1) {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount });
  const api = await installLegacyUiFixture(page, fixture);
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await selectCampaign(page, fixture);
  return { fixture, api };
}

async function gateGetPath(page: Page, path: string) {
  const started = deferred<void>();
  const release = deferred<void>();
  let starts = 0;
  await page.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    if (request.method() === "GET" && new URL(request.url()).pathname === path) {
      starts += 1;
      started.resolve(undefined);
      await release.promise;
    }
    await route.fallback();
  });
  return {
    started: started.promise,
    release: () => release.resolve(undefined),
    starts: () => starts
  };
}

function storyMemoryResponse(level: string) {
  return { level, reviewMode: "off", availableLevels: ["off", "standard", "enhanced", "max"] };
}

function chronicleMetricsResponse(memoryCount: number) {
  return {
    turns: 1,
    estimatedCompleteHistoryTokens: 120,
    memoryCount,
    embeddedMemories: 0,
    semanticHealth: { indexedMemories: 0, jobStatus: "idle" }
  };
}

function embeddingConfigResponse(documentPrefix: string) {
  return {
    enabled: false,
    retrievalImplementation: "legacy_hybrid",
    retrievalShadowEnabled: false,
    model: null,
    documentPrefix,
    queryPrefix: `${documentPrefix} query`,
    batchSize: 1
  };
}

function illustrationConfigResponse(segmentWordCount: number) {
  return {
    enabled: true,
    sourcePolicy: "library_only",
    matchingScope: "world",
    confidenceProfile: "balanced",
    repetitionWindow: 5,
    providerProfileId: null,
    model: `synthetic-model-${segmentWordCount}`,
    size: "1024x1024",
    aspectRatio: "1:1",
    quality: "auto",
    outputFormat: "png",
    maxAttempts: 3,
    segmentWordCount,
    imagesPerSegment: 1,
    segmentPromptMode: "direct",
    refinementPrompt: "Synthetic UI regression prompt.",
    defaultRefinementPrompt: "Synthetic UI regression prompt.",
    updatedAt: "2026-10-03T12:00:00.000Z"
  };
}

async function captureT26Screenshot(page: Page, filename: string) {
  mkdirSync(t26EvidenceDirectory, { recursive: true });
  await page.screenshot({ path: join(t26EvidenceDirectory, filename), fullPage: false });
}

async function campaignSectionRoute(page: Page, id: string, suffix: string, handler: (route: Route) => Promise<void>) {
  const path = pathFor(id, suffix);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    if (request.method() === "GET" && new URL(request.url()).pathname === path) return handler(route);
    await route.fallback();
  });
}

test("advanced_requests_are_absent_until_open_and_context_preview_is_explicit", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const api = await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const ownedPaths = optionalSectionReads.map((suffix) => pathFor(id, suffix));
  const observedOptionalStarts: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && ownedPaths.includes(path)) observedOptionalStarts.push(path);
    await route.fallback();
  });

  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await selectCampaign(page, fixture);
  expect(observedOptionalStarts).toEqual([]);

  await page.locator("#campaignTabChronicle").click();
  const previewPath = pathFor(id, "memory/context-preview");
  expect(reads(api, previewPath)).toHaveLength(0);
  await page.locator("#budgetTokens").fill("65536");
  await page.locator("#compression").selectOption("compact");
  await page.locator("#memoryQuery").fill("station clock");

  let previewUrl = "";
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    if (request.method() === "GET" && new URL(request.url()).pathname === previewPath) previewUrl = request.url();
    await route.fallback();
  });
  await expect(page.locator("#budgetTokens").evaluate((input: HTMLInputElement) => input.validity.stepMismatch)).resolves.toBe(false);
  await page.locator("#previewContext").click();
  await expect.poll(() => reads(api, previewPath).length).toBe(1);
  const query = new URL(previewUrl).searchParams;
  expect(query.get("budgetTokens")).toBe("65536");
  expect(query.get("compression")).toBe("compact");
  expect(query.get("query")).toBe("station clock");
});

test("reopening_an_in_flight_section_coalesces_and_success_is_cached", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const api = await installLegacyUiFixture(page, fixture);
  const path = pathFor(campaignId(fixture), "story-memory");
  const gate = await gateGetPath(page, path);

  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await selectCampaign(page, fixture);
  await page.locator("#campaignTabStory").click();
  await gate.started;
  await page.locator("#campaignTabStory").click();
  expect(gate.starts()).toBe(1);
  gate.release();
  await expect(page.locator("#campaignStoryMemoryStatus")).toContainText("Saved level: off");
  expect(reads(api, path)).toHaveLength(1);

  await page.locator("#campaignTabOverview").click();
  await page.locator("#campaignTabStory").click();
  expect(gate.starts()).toBe(1);
  expect(reads(api, path)).toHaveLength(1);
});

test("a_failed_section_read_can_be_retried_by_reopening_its_tab", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const api = await installLegacyUiFixture(page, fixture);
  const path = pathFor(campaignId(fixture), "story-memory");
  let attempts = 0;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    if (request.method() === "GET" && new URL(request.url()).pathname === path) {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic Story Memory read failure" }) });
        return;
      }
    }
    await route.fallback();
  });

  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await selectCampaign(page, fixture);
  await page.locator("#campaignTabStory").click();
  await expect(page.locator("#campaignStoryMemoryStatus")).toContainText("Story Memory settings are unavailable");
  await page.locator("#campaignTabOverview").click();
  await page.locator("#campaignTabStory").click();
  await expect(page.locator("#campaignStoryMemoryStatus")).toContainText("Saved level: off");
  expect(attempts).toBe(2);
  expect(reads(api, path)).toHaveLength(1);
  await expect(page.locator("#campaignStatusMessage")).not.toContainText("Synthetic Story Memory read failure");
});

test("overview_remains_usable_while_opened_chronicle_reads_and_preview_are_blocked", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const api = await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const metricsGate = await gateGetPath(page, pathFor(id, "memory/metrics"));
  const previewGate = await gateGetPath(page, pathFor(id, "memory/context-preview"));
  await page.setViewportSize({ width: 1280, height: 800 });

  try {
    await page.goto(`${origin}/nexus/index.html#campaigns`);
    await selectCampaign(page, fixture);
    await captureT26Screenshot(page, "T26-overview-first-1280x800.png");
    await page.locator("#campaignTabChronicle").click();
    await metricsGate.started;
    await expect(page.locator("#budgetTokens").evaluate((input: HTMLInputElement) => input.validity.stepMismatch)).resolves.toBe(false);
    await page.locator("#previewContext").click();
    await previewGate.started;
    await page.setViewportSize({ width: 390, height: 844 });
    await captureT26Screenshot(page, "T26-chronicle-pending-390x844.png");

    await page.locator("#campaignTabOverview").click();
    await page.locator("#campaignTitle").fill("Saved while Chronicle is pending");
    await page.locator("#saveCampaign").click();
    await expect(page.locator("#campaignSaveStatus")).toHaveAttribute("data-state", "saved");
    expect(api.writes.some((write) => write.method === "PATCH" && write.path === `/api/v1/campaigns/${id}`)).toBe(true);
    await expect(page.locator("#campaignTitle")).toHaveValue("Saved while Chronicle is pending");
  } finally {
    metricsGate.release();
    previewGate.release();
  }
});

test("current_section_world_and_preview_errors_hide_private_bodies_and_keep_explicit_retries", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 2 });
  await installLegacyUiFixture(page, fixture);
  const idA = campaignId(fixture, 0);
  const idB = campaignId(fixture, 1);
  const worldPath = `/api/v1/worlds/${String(campaign(fixture, 1).worldId)}`;
  let worldDetailReads = 0;
  let metricsAttempts = 0;
  let previewAttempts = 0;
  const previewQueries: string[] = [];
  const previewResponse = {
    selectedCompression: "balanced",
    retrieval: { mode: "hybrid" },
    budget: { estimatedSelectedTokens: 120, configuredTokens: 32_000, truncated: false },
    scopes: { chronicle: [] }
  };

  await page.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    if (request.method() === "GET" && new URL(request.url()).pathname === worldPath) {
      worldDetailReads += 1;
      if (worldDetailReads === 2) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "PRIVATE_WORLD_BODY_CANARY", correlationId: "private/reference" })
        });
        return;
      }
    }
    await route.fallback();
  });
  await campaignSectionRoute(page, idB, "memory/metrics", async (route) => {
    metricsAttempts += 1;
    if (metricsAttempts === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({
        message: "PRIVATE_CHRONICLE_BODY_CANARY", correlationId: "chronicle-safe-321"
      }) });
      return;
    }
    if (metricsAttempts === 2) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({
        message: "PRIVATE_CHRONICLE_RETRY_CANARY", correlationId: "private/reference"
      }) });
      return;
    }
    await route.fulfill({ json: chronicleMetricsResponse(29) });
  });
  await campaignSectionRoute(page, idB, "memory/embedding-config", async (route) => {
    await route.fulfill({ json: embeddingConfigResponse("B-current-document-prefix") });
  });
  await campaignSectionRoute(page, idB, "memory/context-preview", async (route) => {
    previewAttempts += 1;
    previewQueries.push(new URL(route.request().url()).searchParams.get("query") || "");
    if (previewAttempts === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({
        message: "PRIVATE_PREVIEW_BODY_CANARY", correlationId: "preview-safe-456"
      }) });
      return;
    }
    await route.fulfill({ json: previewResponse });
  });

  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await selectCampaign(page, fixture, 0);
  await page.locator(`#campaignList [data-campaign-id="${idB}"]`).click();
  await expect(page.locator("#memoryTitle")).toHaveText(String(campaign(fixture, 1).title));
  const campaignStatus = page.locator("#campaignStatusMessage");
  await expect(campaignStatus).toContainText("Campaign selected, but its world details could not be loaded.");
  await expect(campaignStatus).not.toContainText("PRIVATE_WORLD_BODY_CANARY");
  await expect(campaignStatus).not.toContainText("private/reference");
  await expect(page.locator("#migrateCampaign")).toBeDisabled();

  const sectionFeedback = page.locator('#campaignPanelChronicle [data-campaign-section-feedback="chronicle"]');
  await page.locator("#campaignTabChronicle").click();
  await expect(sectionFeedback).toContainText("Chronicle could not be loaded.");
  await expect(sectionFeedback).toContainText("Reference: chronicle-safe-321.");
  await expect(sectionFeedback).not.toContainText("PRIVATE_CHRONICLE_BODY_CANARY");
  await expectCampaignSectionBodies(page, "chronicle", false);
  await expect.poll(() => metricsAttempts).toBe(1);

  await page.locator('#campaignPanelChronicle [data-action="retry-campaign-section"]').click();
  await expect(sectionFeedback).toContainText("Chronicle could not be loaded.");
  await expect(sectionFeedback).not.toContainText("PRIVATE_CHRONICLE_RETRY_CANARY");
  await expect(sectionFeedback).not.toContainText("private/reference");
  await expectCampaignSectionBodies(page, "chronicle", false);
  await expect.poll(() => metricsAttempts).toBe(2);
  await page.locator('#campaignPanelChronicle [data-action="retry-campaign-section"]').click();
  await expectCampaignSectionBodies(page, "chronicle", true);
  await expect.poll(() => metricsAttempts).toBe(3);

  expect(previewAttempts).toBe(0);
  await page.locator("#memoryQuery").fill("clock tower");
  await page.locator("#previewContext").click();
  const previewSummary = page.locator("#contextSummary");
  await expect(previewSummary).toHaveText("Context preview unavailable. Reference: preview-safe-456.");
  await expect(previewSummary).not.toContainText("PRIVATE_PREVIEW_BODY_CANARY");
  expect(previewAttempts).toBe(1);
  await expect(page.locator("#previewContext")).toBeEnabled();

  await page.locator("#previewContext").click();
  await expect(previewSummary).toContainText("balanced compression selected");
  await expect.poll(() => previewAttempts).toBe(2);
  expect(previewQueries).toEqual(["clock tower", "clock tower"]);
  expect(idA).not.toBe(idB);
});

test("late_story_memory_success_from_campaign_a_does_not_replace_campaign_b", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 2 });
  await installLegacyUiFixture(page, fixture);
  const idA = campaignId(fixture, 0);
  const idB = campaignId(fixture, 1);
  const aStarted = deferred<void>();
  const aFinished = deferred<void>();
  const releaseA = deferred<void>();
  let aReads = 0;
  let bReads = 0;
  await campaignSectionRoute(page, idA, "story-memory", async (route) => {
    aReads += 1;
    aStarted.resolve(undefined);
    await releaseA.promise;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(storyMemoryResponse("max")) });
    aFinished.resolve(undefined);
  });
  await campaignSectionRoute(page, idB, "story-memory", async (route) => {
    bReads += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(storyMemoryResponse("off")) });
  });

  try {
    await page.goto(`${origin}/nexus/index.html#campaigns`);
    await selectCampaign(page, fixture, 0);
    await page.locator("#campaignTabStory").click();
    await aStarted.promise;
    await page.locator(`#campaignList [data-campaign-id="${idB}"]`).click();
    await expect(page.locator("#campaignTitle")).toHaveValue(String(campaign(fixture, 1).title));
    await page.locator("#campaignTabOverview").click();
    await page.locator("#campaignTabStory").click();
    await expect(page.locator("#campaignStoryMemoryLevel")).toHaveValue("off");
    releaseA.resolve(undefined);
    await aFinished.promise;
    await expect(page.locator("#campaignStoryMemoryLevel")).toHaveValue("off");
    await expect(page.locator("#memoryTitle")).toHaveText(String(campaign(fixture, 1).title));
    expect(aReads).toBe(1);
    expect(bReads).toBe(1);
  } finally {
    releaseA.resolve(undefined);
  }
});

test("late_story_memory_error_from_campaign_a_does_not_replace_campaign_b_feedback", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 2 });
  await installLegacyUiFixture(page, fixture);
  const idA = campaignId(fixture, 0);
  const idB = campaignId(fixture, 1);
  const aStarted = deferred<void>();
  const aFinished = deferred<void>();
  const releaseA = deferred<void>();
  let aReads = 0;
  let bReads = 0;
  await campaignSectionRoute(page, idA, "story-memory", async (route) => {
    aReads += 1;
    aStarted.resolve(undefined);
    await releaseA.promise;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "A private stale panel error" }) });
    aFinished.resolve(undefined);
  });
  await campaignSectionRoute(page, idB, "story-memory", async (route) => {
    bReads += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(storyMemoryResponse("standard")) });
  });

  try {
    await page.goto(`${origin}/nexus/index.html#campaigns`);
    await selectCampaign(page, fixture, 0);
    await page.locator("#campaignTabStory").click();
    await aStarted.promise;
    await page.locator(`#campaignList [data-campaign-id="${idB}"]`).click();
    await expect(page.locator("#campaignTitle")).toHaveValue(String(campaign(fixture, 1).title));
    await page.locator("#campaignTabOverview").click();
    await page.locator("#campaignTabStory").click();
    await expect(page.locator("#campaignStoryMemoryLevel")).toHaveValue("standard");
    releaseA.resolve(undefined);
    await aFinished.promise;
    await expect(page.locator("#campaignStoryMemoryLevel")).toHaveValue("standard");
    await expect(page.locator("#campaignStoryMemoryStatus")).not.toContainText("A private stale panel error");
    await expect(page.locator("#campaignStatusMessage")).not.toContainText("A private stale panel error");
    expect(aReads).toBe(1);
    expect(bReads).toBe(1);
  } finally {
    releaseA.resolve(undefined);
  }
});

test("hides_chronicle_a_while_chronicle_b_fails_then_reveals_only_b_after_retry", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 2 });
  await installLegacyUiFixture(page, fixture);
  const idA = campaignId(fixture, 0);
  const idB = campaignId(fixture, 1);
  const bMetricsStarted = deferred<void>();
  const releaseFirstBMetrics = deferred<void>();
  let aMetricsReads = 0;
  let bMetricsAttempts = 0;

  await campaignSectionRoute(page, idA, "memory/metrics", async (route) => {
    aMetricsReads += 1;
    await route.fulfill({ json: chronicleMetricsResponse(17) });
  });
  await campaignSectionRoute(page, idA, "memory/embedding-config", async (route) => {
    await route.fulfill({ json: embeddingConfigResponse("A-private-document-prefix") });
  });
  await campaignSectionRoute(page, idB, "memory/metrics", async (route) => {
    bMetricsAttempts += 1;
    if (bMetricsAttempts === 1) {
      bMetricsStarted.resolve(undefined);
      await releaseFirstBMetrics.promise;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic B Chronicle failure" }) });
      return;
    }
    await route.fulfill({ json: chronicleMetricsResponse(29) });
  });
  await campaignSectionRoute(page, idB, "memory/embedding-config", async (route) => {
    await route.fulfill({ json: embeddingConfigResponse("B-current-document-prefix") });
  });

  try {
    await page.goto(`${origin}/nexus/index.html#campaigns`);
    await selectCampaign(page, fixture, 0);
    await page.locator("#campaignTabChronicle").click();
    await expect(page.locator("#embeddingDocumentPrefix")).toHaveValue("A-private-document-prefix");
    await expectCampaignSectionBodies(page, "chronicle", true);

    await page.locator(`#campaignList [data-campaign-id="${idB}"]`).click();
    await bMetricsStarted.promise;
    await expect(page.locator("#memoryTitle")).toHaveText(String(campaign(fixture, 1).title));
    await expectCampaignSectionBodies(page, "chronicle", false);
    await expect(page.locator("#campaignPanelChronicle [data-campaign-section-feedback]")).toContainText("Loading Chronicle");

    releaseFirstBMetrics.resolve(undefined);
    await expect(page.locator("#campaignPanelChronicle [data-campaign-section-feedback]")).toContainText("Chronicle could not be loaded");
    await expectCampaignSectionBodies(page, "chronicle", false);
    await page.locator('#campaignPanelChronicle [data-action="retry-campaign-section"]').click();
    await expectCampaignSectionBodies(page, "chronicle", true);
    await expect(page.locator("#embeddingDocumentPrefix")).toHaveValue("B-current-document-prefix");
    await expect(page.locator("#memoryMetrics")).toContainText("29");
    await expect(page.locator("#embeddingDocumentPrefix")).not.toHaveValue("A-private-document-prefix");
    expect(aMetricsReads).toBe(1);
    expect(bMetricsAttempts).toBe(2);
  } finally {
    releaseFirstBMetrics.resolve(undefined);
  }
});

test("hides_illustration_a_while_illustrations_b_fails_then_reveals_only_b_after_retry", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 2 });
  await installLegacyUiFixture(page, fixture);
  const idA = campaignId(fixture, 0);
  const idB = campaignId(fixture, 1);
  const bConfigStarted = deferred<void>();
  const releaseFirstBConfig = deferred<void>();
  let aConfigReads = 0;
  let bConfigAttempts = 0;

  await campaignSectionRoute(page, idA, "illustration-config", async (route) => {
    aConfigReads += 1;
    await route.fulfill({ json: illustrationConfigResponse(321) });
  });
  await campaignSectionRoute(page, idB, "illustration-config", async (route) => {
    bConfigAttempts += 1;
    if (bConfigAttempts === 1) {
      bConfigStarted.resolve(undefined);
      await releaseFirstBConfig.promise;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic B illustration failure" }) });
      return;
    }
    await route.fulfill({ json: illustrationConfigResponse(654) });
  });
  await campaignSectionRoute(page, idB, "image-jobs", async (route) => {
    await route.fulfill({ json: { jobs: [] } });
  });
  await campaignSectionRoute(page, idB, "illustration-segments", async (route) => {
    await route.fulfill({ json: { segments: [] } });
  });

  try {
    await page.goto(`${origin}/nexus/index.html#campaigns`);
    await selectCampaign(page, fixture, 0);
    await page.locator("#campaignTabIllustrations").click();
    await expect(page.locator("#illustrationSegmentWordCount")).toHaveValue("321");
    await expectCampaignSectionBodies(page, "illustrations", true);

    await page.locator(`#campaignList [data-campaign-id="${idB}"]`).click();
    await bConfigStarted.promise;
    await expect(page.locator("#memoryTitle")).toHaveText(String(campaign(fixture, 1).title));
    await expectCampaignSectionBodies(page, "illustrations", false);
    await expect(page.locator("#campaignPanelIllustrations [data-campaign-section-feedback]")).toContainText("Loading Illustrations");

    releaseFirstBConfig.resolve(undefined);
    await expect(page.locator("#campaignPanelIllustrations [data-campaign-section-feedback]")).toContainText("Illustrations could not be loaded");
    await expectCampaignSectionBodies(page, "illustrations", false);
    await page.locator('#campaignPanelIllustrations [data-action="retry-campaign-section"]').click();
    await expectCampaignSectionBodies(page, "illustrations", true);
    await expect(page.locator("#illustrationSegmentWordCount")).toHaveValue("654");
    expect(aConfigReads).toBe(1);
    expect(bConfigAttempts).toBe(2);
  } finally {
    releaseFirstBConfig.resolve(undefined);
  }
});

test("keeps_advanced_values_hidden_across_empty_selection_before_loading_campaign_b", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 2 });
  await installLegacyUiFixture(page, fixture);
  const idA = campaignId(fixture, 0);
  const idB = campaignId(fixture, 1);
  const bMetricsStarted = deferred<void>();
  const releaseBMetrics = deferred<void>();
  let listReads = 0;
  await page.route("**/api/v1/campaigns", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    listReads += 1;
    if (listReads === 2) {
      await route.fulfill({ json: { campaigns: [] } });
      return;
    }
    if (listReads === 3) {
      await route.fulfill({ json: { campaigns: [campaign(fixture, 1)] } });
      return;
    }
    await route.fallback();
  });
  await campaignSectionRoute(page, idA, "memory/metrics", async (route) => {
    await route.fulfill({ json: chronicleMetricsResponse(17) });
  });
  await campaignSectionRoute(page, idA, "memory/embedding-config", async (route) => {
    await route.fulfill({ json: embeddingConfigResponse("A-private-document-prefix") });
  });
  await campaignSectionRoute(page, idB, "memory/metrics", async (route) => {
    bMetricsStarted.resolve(undefined);
    await releaseBMetrics.promise;
    await route.fulfill({ json: chronicleMetricsResponse(29) });
  });
  await campaignSectionRoute(page, idB, "memory/embedding-config", async (route) => {
    await route.fulfill({ json: embeddingConfigResponse("B-current-document-prefix") });
  });

  try {
    await page.goto(`${origin}/nexus/index.html#campaigns`);
    await selectCampaign(page, fixture, 0);
    await page.locator("#campaignTabChronicle").click();
    await expect(page.locator("#embeddingDocumentPrefix")).toHaveValue("A-private-document-prefix");
    await expectCampaignSectionBodies(page, "chronicle", true);

    await page.locator("#refreshCampaigns").click();
    await expect(page.locator("#memoryTitle")).toHaveText("Select a campaign");
    await expectCampaignSectionBodies(page, "chronicle", false);

    await page.locator("#refreshCampaigns").click();
    await selectCampaign(page, fixture, 1);
    await expect(page.locator("#memoryTitle")).toHaveText(String(campaign(fixture, 1).title));
    await expectCampaignSectionBodies(page, "chronicle", false);
    await page.locator("#campaignTabChronicle").click();
    await bMetricsStarted.promise;
    await expect(page.locator("#embeddingDocumentPrefix")).toHaveValue("B-current-document-prefix");
    await expectCampaignSectionBodies(page, "chronicle", false);
    await expect(page.locator("#campaignPanelChronicle [data-campaign-section-feedback]")).toContainText("Loading Chronicle");

    releaseBMetrics.resolve(undefined);
    await expectCampaignSectionBodies(page, "chronicle", true);
    await expect(page.locator("#embeddingDocumentPrefix")).toHaveValue("B-current-document-prefix");
    await expect(page.locator("#memoryMetrics")).toContainText("29");
    expect(listReads).toBe(3);
  } finally {
    releaseBMetrics.resolve(undefined);
  }
});

test("successful_story_memory_save_invalidates_only_its_section", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const api = await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const storyPath = pathFor(id, "story-memory");
  let storyReads = 0;
  let storyWrites = 0;
  let savedLevel = "off";
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    if (new URL(request.url()).pathname === storyPath && request.method() === "GET") {
      storyReads += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(storyMemoryResponse(savedLevel)) });
      return;
    }
    if (new URL(request.url()).pathname === storyPath && request.method() === "PUT") {
      storyWrites += 1;
      const input = request.postDataJSON() as { level: string };
      savedLevel = input.level;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(storyMemoryResponse(savedLevel)) });
      return;
    }
    await route.fallback();
  });

  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await selectCampaign(page, fixture);
  await page.locator("#campaignTabChronicle").click();
  await expect.poll(() => reads(api, pathFor(id, "memory/metrics")).length).toBe(1);
  await page.locator("#campaignTabStory").click();
  await expect(page.locator("#campaignStoryMemoryLevel")).toHaveValue("off");
  await page.locator("#campaignStoryMemoryLevel").selectOption("standard");
  await expect(page.locator("#campaignStoryMemoryStatus")).toContainText("Saved level: standard");
  await expect.poll(() => storyReads).toBe(1);

  await page.locator("#campaignTabChronicle").click();
  await expect.poll(() => reads(api, pathFor(id, "memory/metrics")).length).toBe(1);
  await page.locator("#campaignTabStory").click();
  await expect(page.locator("#campaignStoryMemoryLevel")).toHaveValue("standard");
  expect(storyReads).toBe(2);
  expect(storyWrites).toBe(1);
  expect(reads(api, pathFor(id, "memory/metrics"))).toHaveLength(1);
});

test("overview_save_preserves_nondefault_story_metadata_before_story_tab_opens", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const selected = campaign(fixture);
  Object.assign(selected, {
    textProviderProfileId: "10000000-0000-4000-8000-000000000384",
    turnControlStyle: "flexible_scene",
    storyLengthProfile: "extended",
    storyContextBudgetTokens: 64_000
  });
  const api = await installLegacyUiFixture(page, fixture);

  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await selectCampaign(page, fixture);
  await expect(page.locator("#campaignTabOverview")).toHaveAttribute("aria-selected", "true");
  await page.locator("#campaignTitle").fill("Overview title saved");
  await page.locator("#saveCampaign").click();
  await expect(page.locator("#campaignSaveStatus")).toHaveAttribute("data-state", "saved");

  const save = api.writes.find((write) => write.method === "PATCH" && write.path === `/api/v1/campaigns/${campaignId(fixture)}`);
  expect(save?.body).toMatchObject({
    title: "Overview title saved",
    textProviderProfileId: "10000000-0000-4000-8000-000000000384",
    turnControlStyle: "flexible_scene",
    storyLengthProfile: "extended",
    storyContextBudgetTokens: 64_000
  });
  expect(reads(api, pathFor(campaignId(fixture), "story-memory"))).toHaveLength(0);
});

test("late_section_data_keeps_newer_unsaved_overview_edits", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const api = await installLegacyUiFixture(page, fixture);
  const id = campaignId(fixture);
  const metricsPath = pathFor(id, "memory/metrics");
  const metricsGate = await gateGetPath(page, metricsPath);

  try {
    await page.goto(`${origin}/nexus/index.html#campaigns`);
    await selectCampaign(page, fixture);
    await page.locator("#campaignTabChronicle").click();
    await metricsGate.started;
    await page.locator("#campaignTabOverview").click();
    await page.locator("#campaignTitle").fill("Newer local title");
    metricsGate.release();
    await expect.poll(() => reads(api, metricsPath)[0]?.finishedAt).toBeDefined();
    await expect(page.locator("#campaignTitle")).toHaveValue("Newer local title");
    await expect(page.locator("#campaignSaveStatus")).toHaveAttribute("data-state", "unsaved");
    expect(api.writes.some((write) => write.method === "PATCH" && write.path === `/api/v1/campaigns/${id}`)).toBe(false);
  } finally {
    metricsGate.release();
  }
});
