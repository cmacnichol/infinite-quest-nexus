import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";

const legacyOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const webNextOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? "43174"}`;
const jobId = "55555555-5555-4555-8555-555555555555";

type Surface = "legacy" | "web-next";
type Outcome = "failed" | "review" | "completed";

interface Fixture {
  readonly fixture: ReturnType<typeof quietLeafApiPayloads>;
  readonly writes: Array<{ path: string; body: Record<string, unknown> }>;
  readonly errors: string[];
  readonly unhandledApiRoutes: string[];
  outcome: Outcome | null;
}

function routeFor(surface: Surface, campaignId: string): string {
  return surface === "legacy" ? `${legacyOrigin}/story/${campaignId}` : `${webNextOrigin}/app/story/${campaignId}`;
}

function selectors(surface: Surface) {
  return {
    draft: surface === "legacy" ? "#freeAction" : "[data-story-draft]",
    submit: surface === "legacy" ? "#btnTakeAction" : "[data-action='continue-story']",
    discard: surface === "legacy" ? "#btnDiscardGenerationRecovery" : "[data-action='discard-generation']",
    recovery: surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]"
  };
}

async function installFixture(page: Page): Promise<Fixture> {
  const fixture = quietLeafApiPayloads({ turnControlStyle: "flexible_action" });
  const writes: Fixture["writes"] = [];
  const errors: string[] = [];
  const unhandledApiRoutes: string[] = [];
  const state: Fixture = { fixture, writes, errors, unhandledApiRoutes, outcome: null };
  await page.addInitScript(() => {
    Object.defineProperty(window, "EventSource", { configurable: true, value: undefined });
  });
  // The legacy shell references PhotoSwipe even though these retention flows
  // never open an illustration. Keep that known static dependency quiet while
  // treating every API route as an explicit fixture contract below.
  await page.route("**/vendor/photoswipe/photoswipe.css", route => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  const timestamp = "2026-09-18T00:00:00.000Z";
  const base = {
    id: jobId, campaignId: fixture.campaignId, expectedTurnNumber: 2, action: "", requestedInputMode: "scene",
    resolvedInputMode: "scene", inputModeSource: "explicit", operationKind: "append", replacementTurnId: null,
    attempts: 1, resultTurnId: null, errorCode: "generation_failed", errorMessage: "Generation could not be completed.",
    createdAt: timestamp, updatedAt: timestamp, partialNarration: null
  };
  const failed = () => ({ ...base, status: "failed" });
  const review = () => ({ ...base, status: "recoverable", review: {
    version: 1, reviewId: "66666666-6666-4666-8666-666666666666", revision: 1, state: "pending",
    stage: "continuity", candidateScope: "final", reasons: ["narrative_conflict"], canKeep: true, canRetry: true
  } });
  const completed = () => ({ ...base, status: "completed", resultTurnId: "88888888-8888-4888-8888-888888888888", errorCode: null, errorMessage: null });
  const acceptedTurn = () => ({
    id: "88888888-8888-4888-8888-888888888888", turnNumber: 2, action: base.action, inputMode: "scene" as const,
    inputModeSource: "explicit" as const, narration: "Accepted fixture turn.", choices: [], customActionSuggestion: "", imagePrompt: "",
    imageUrl: null, acceptedAt: timestamp, chronicleRetrieval: null, reportedCost: null
  });
  const turns = () => state.outcome === "completed"
    ? { ...fixture.turns, turns: [...fixture.turns.turns, acceptedTurn()] }
    : fixture.turns;
  const sync = () => ({
    ...fixture.syncStatus,
    campaign: { ...fixture.syncStatus.campaign, activeTurnNumber: state.outcome === "completed" ? 2 : fixture.syncStatus.campaign.activeTurnNumber },
    activeTurnNumber: state.outcome === "completed" ? 2 : fixture.syncStatus.activeTurnNumber,
    turns: turns(),
    pendingGeneration: null,
    generationRecovery: state.outcome === "failed" ? failed() : state.outcome === "review" ? review() : null
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("response", response => {
    if (response.status() === 404 && !new URL(response.url()).pathname.startsWith("/api/v1/")) errors.push(`404 ${new URL(response.url()).pathname}`);
  });
  await page.route("**/api/v1/**", async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "GET" && path === "/api/v1/session") return respond(fixture.session);
    if (request.method() === "GET" && path === "/api/v1/meta") return respond({ application: { name: "Infinite Quest Nexus", version: "test", commit: null, builtAt: null }, capabilities: { systemArchive: false } });
    if (request.method() === "GET" && path === "/api/v1/providers") return respond({ providers: [{ id: "77777777-7777-4777-8777-777777777777", name: "Fixture text provider", providerType: "openai_compatible", providerRole: "text" }] });
    if (request.method() === "GET" && path === "/api/v1/campaigns") return respond(fixture.campaigns);
    if (request.method() === "GET" && path === "/api/v1/worlds") return respond(fixture.worlds);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${fixture.campaignId}/sync-status`) return respond(sync());
    if (request.method() === "GET" && path === `/api/v1/campaigns/${fixture.campaignId}/turns`) return respond(turns());
    if (request.method() === "GET" && (path === `/api/v1/campaigns/${fixture.campaignId}/state` || path === `/api/v1/campaigns/${fixture.campaignId}/state/inspection`)) return respond(fixture.runtimeState);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${fixture.campaignId}/story-memory`) return respond({ level: "off", reviewMode: "off", availableLevels: ["off"] });
    if (request.method() === "GET" && path === `/api/v1/campaigns/${fixture.campaignId}/character-profile`) return respond({ campaignId: fixture.campaignId, revision: 1, name: "", profile: {}, storedProfile: null, inheritedFromSnapshot: false, legacyCharacterText: "", rpgStats: [], defaultTriggers: [] });
    if (request.method() === "GET" && path === `/api/v1/campaigns/${fixture.campaignId}/illustration-config`) return respond(fixture.illustrationConfig);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${fixture.campaignId}/illustration-segments`) return respond(fixture.illustrationSegments);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${fixture.campaignId}/image-jobs`) return respond({ jobs: [] });
    if (request.method() === "GET" && path === "/api/v1/turns/88888888-8888-4888-8888-888888888888/illustration-resolution") return respond({
      id: "99999999-9999-4999-8999-999999999999", campaignId: fixture.campaignId, turnId: "88888888-8888-4888-8888-888888888888",
      sourcePolicy: "library_only", matchingScope: "campaign", confidenceProfile: "strict", status: "no_match", selectedAssetId: null,
      selectedScore: null, resolvedThreshold: null, algorithmVersion: "fixture-v1", imageJobId: null, reasonCode: null,
      createdAt: timestamp, updatedAt: timestamp, completedAt: timestamp, candidates: []
    });
    if (request.method() === "POST" && path === `/api/v1/campaigns/${fixture.campaignId}/generations`) {
      const body = request.postDataJSON() as Record<string, unknown>; writes.push({ path, body });
      base.action = String(body.action); base.requestedInputMode = String(body.requestedInputMode); base.resolvedInputMode = String(body.resolvedInputMode);
      state.outcome = String(body.action).includes("review") ? "review" : String(body.action).includes("success") ? "completed" : "failed";
      return respond({ id: jobId, status: "queued", duplicate: false, operationKind: "append", replacementTurnId: null }, 202);
    }
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${jobId}/stream`) {
      const snapshot = state.outcome === "review" ? review() : state.outcome === "completed" ? completed() : failed();
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify(snapshot)}\n\n` });
    }
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${jobId}`) return respond(state.outcome === "review" ? review() : state.outcome === "completed" ? completed() : failed());
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${jobId}/review`) return respond({ ...review().review, narration: "Candidate", choices: [], findings: [], retryDescription: "Retry", retryFailure: null, omittedFindingCount: 0 });
    if (request.method() === "POST" && path === `/api/v1/generation-jobs/${jobId}/discard`) { state.outcome = null; return respond({ id: jobId, status: "discarded", duplicate: false, operationKind: "append", replacementTurnId: null }, 202); }
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${jobId}/result`) return respond({ ...completed(), turnNumber: 2, inputMode: "scene", inputModeSource: "explicit", narration: "Accepted fixture turn.", choices: [], customActionSuggestion: "", imagePrompt: "", chronicleRetrieval: null, modelMetadata: null, mechanics: null, acceptedAt: timestamp, stateSnapshot: {}, reportedCost: null });
    unhandledApiRoutes.push(`${request.method()} ${path}`);
    return respond({ error: `Missing fixture route: ${request.method()} ${path}` }, 404);
  });
  return state;
}

async function gotoStory(page: Page, surface: Surface, fixture: Fixture) {
  if (surface === "legacy") {
    const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
    await page.route(`**/story/${fixture.fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
  }
  await page.goto(routeFor(surface, fixture.fixture.campaignId));
  await expect(page.locator(selectors(surface).draft)).toBeVisible();
}

for (const surface of ["legacy", "web-next"] as const) {
  test(`${surface} restores an entered failed append prompt and preserves the selected mode for one explicit resubmission`, async ({ page }) => {
    const api = await installFixture(page); const ui = selectors(surface);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoStory(page, surface, api);
    if (surface === "legacy") await page.locator("[data-turn-input-mode='scene']").check();
    else await page.locator("[data-input-mode='scene']").click();
    await page.locator(ui.draft).fill("Follow the blue lantern.");
    await page.locator(ui.submit).click();
    await expect.poll(() => api.writes.length).toBe(1);
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((key) => key.includes("FailedAppendPrompt")))).toBe(true);
    await expect(page.locator(ui.draft)).toHaveValue("Follow the blue lantern.");
    await page.reload();
    await expect(page.locator(ui.draft)).toHaveValue("Follow the blue lantern.");
    await expect(page.locator(ui.recovery)).toBeVisible();
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0]!.body).toMatchObject({ action: "Follow the blue lantern.", requestedInputMode: "scene", resolvedInputMode: "scene" });
    await page.screenshot({ path: `docs/review/assets/failed-turn-prompt-retention/${surface}-failed-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `docs/review/assets/failed-turn-prompt-retention/${surface}-failed-390.png`, fullPage: true });
    if (surface === "legacy") await expect(page.locator("[data-turn-input-mode='scene']")).toBeChecked();
    else await expect(page.locator("[data-input-mode='scene']")).toHaveAttribute("aria-checked", "true");
    await page.locator(ui.discard).click();
    await expect(page.locator(ui.recovery)).toBeHidden();
    await page.locator(ui.submit).click();
    await expect.poll(() => api.writes.length).toBe(2);
    expect(api.writes[1]!.body).toMatchObject({ action: "Follow the blue lantern.", requestedInputMode: "scene", resolvedInputMode: "scene" });
    expect(api.unhandledApiRoutes).toEqual([]);
    expect(api.errors).toEqual([]);
  });

  test(`${surface} waits for explicit discard before restoring a review draft and forgets it after a newer draft reload`, async ({ page }) => {
    const api = await installFixture(page); const ui = selectors(surface);
    await gotoStory(page, surface, api);
    await page.locator(ui.draft).fill("Send this for review.");
    await page.locator(ui.submit).click();
    await expect.poll(() => api.writes.length).toBe(1);
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((key) => key.includes("FailedAppendPrompt")))).toBe(true);
    await expect(page.locator(ui.recovery)).toBeVisible();
    await page.reload();
    await expect(page.locator(ui.recovery)).toBeVisible();
    await expect(page.locator(ui.draft)).toHaveValue("");
    expect(api.writes).toHaveLength(1);
    await page.locator(ui.discard).click();
    await expect(page.locator(ui.draft)).toHaveValue("Send this for review.");
    await page.locator(ui.draft).fill("A newer manual draft.");
    await page.reload();
    await expect(page.locator(ui.draft)).not.toHaveValue("Send this for review.");
    expect(api.writes).toHaveLength(1);
    expect(api.unhandledApiRoutes).toEqual([]);
    expect(api.errors).toEqual([]);
  });

  test(`${surface} clears completed prompts without a restored ghost`, async ({ page }) => {
    const api = await installFixture(page); const ui = selectors(surface);
    await gotoStory(page, surface, api);
    await page.locator(ui.draft).fill("Finish with success.");
    await page.locator(ui.submit).click();
    await expect(page.getByText("Accepted fixture turn.", { exact: true }).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((key) => key.includes("FailedAppendPrompt")))).toBe(false);
    await expect(page.locator(ui.draft)).toHaveValue("");
    await page.reload();
    await expect(page.getByText("Accepted fixture turn.", { exact: true }).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((key) => key.includes("FailedAppendPrompt")))).toBe(false);
    await expect(page.locator(ui.draft)).toHaveValue("");
    expect(api.unhandledApiRoutes).toEqual([]);
    expect(api.errors).toEqual([]);
  });
}
