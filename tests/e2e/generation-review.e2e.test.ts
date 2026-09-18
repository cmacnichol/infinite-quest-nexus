import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  campaignSyncStatusSchema,
  generationJobSnapshotSchema,
  generationReviewDetailSchema
} from "../../packages/contracts/src/index.js";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";

const legacyOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const webNextOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? "43174"}`;
const reviewId = "66666666-6666-4666-8666-666666666666";
const reofferedReviewId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const jobId = "55555555-5555-4555-8555-555555555555";
const unexpectedFixtureRoutes: string[] = [];

test.afterEach(() => {
  expect(unexpectedFixtureRoutes).toEqual([]);
  unexpectedFixtureRoutes.splice(0);
});

interface ReviewFixtureOptions {
  readonly liveStream?: boolean;
  readonly failReviewDetail?: boolean;
  readonly delayReviewDetailMs?: number;
  readonly failFirstResult?: boolean;
  readonly decisionConflict?: boolean;
  readonly sharedState?: { accepted: boolean };
  readonly conflictWhenAccepted?: boolean;
  readonly replaceLatest?: boolean;
  readonly structureReview?: boolean;
}

async function installReviewApi(page: Page, canKeep = true, decisionFails = false, decisionCompletes = false, options: ReviewFixtureOptions = {}) {
  const fixture = quietLeafApiPayloads();
  const operationKind = options.replaceLatest ? "replace_latest" : "append";
  const replacementTurnId = options.replaceLatest ? fixture.turns.turns[0]!.id : null;
  const resultTurnNumber = options.replaceLatest ? 1 : 2;
  const review = { version: 1, reviewId, revision: 1, state: "pending", stage: options.structureReview ? "structure" : "continuity", candidateScope: "final", reasons: [options.structureReview ? "invalid_structure" : canKeep ? "narrative_conflict" : "invalid_choices"], canKeep: options.structureReview ? false : canKeep, canRetry: true };
  const candidateNarration = options.structureReview ? null : "The lighthouse bell answered across the harbor.";
  const candidateChoices = options.structureReview ? [] : ["Follow the bell", "Wait at the quay"];
  const detail = { ...review, narration: candidateNarration, choices: candidateChoices, findings: [{ code: review.reasons[0], message: options.structureReview ? "The provider response has invalid structure." : canKeep ? "The candidate may conflict with established story continuity." : "The candidate choices do not meet the required structure." }], retryDescription: "Retry this generation stage.", retryFailure: null, omittedFindingCount: 0 };
  const decisions: Record<string, unknown>[] = [];
  const writePaths: string[] = [];
  const sharedState = options.sharedState ?? { accepted: false };
  let terminalAction: "cancelled" | "discarded" | null = null;
  let reoffered = false;
  let reviewDetailRequests = 0;
  let settledReviewDetailRequests = 0;
  let resultRequests = 0;
  const acceptedTurn = { ...fixture.turns.turns[0]!, id: "88888888-8888-4888-8888-888888888888", turnNumber: resultTurnNumber, narration: detail.narration!, choices: detail.choices };
  const completedSync = {
    ...fixture.syncStatus,
    campaign: { ...fixture.syncStatus.campaign, activeTurnNumber: resultTurnNumber },
    activeTurnNumber: resultTurnNumber,
    generationRecovery: null,
    turns: { campaignId: fixture.campaignId, nextCursor: null, turns: options.replaceLatest ? [acceptedTurn] : [...fixture.turns.turns, acceptedTurn] }
  };
  const consoleErrors: string[] = [];
  page.on("pageerror", error => consoleErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  const recovery = { id: jobId, status: "recoverable", operationKind, replacementTurnId, expectedTurnNumber: resultTurnNumber, attempts: 1, errorCode: "generation_failed", errorMessage: "Generation could not be completed.", diagnostic: { code: "context_evidence_omitted", operation: "story_generation", action: "adjust_context" }, resultTurnId: null, review };
  const snapshot = { ...recovery, campaignId: fixture.campaignId, action: "Listen for the bell.", requestedInputMode: "scene", resolvedInputMode: "scene", inputModeSource: "explicit", partialNarration: detail.narration, createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" };
  const pending = { id: jobId, status: "generating", operationKind, replacementTurnId, action: snapshot.action, expectedTurnNumber: resultTurnNumber, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt };
  const generatingSnapshot = { ...snapshot, status: "generating", errorCode: null, errorMessage: null, review: undefined };
  const decidedReview = { ...review, revision: 2, state: "decided" };
  const reofferedReview = { ...review, reviewId: reofferedReviewId, revision: 3, state: "pending" };
  const reofferedDetail = { ...detail, ...reofferedReview };
  const reofferedDecidedReview = { ...reofferedReview, revision: 4, state: "decided" };
  const queuedSnapshot = { ...snapshot, status: "queued", errorCode: null, errorMessage: null, review: decidedReview };
  const completedSnapshot = { ...snapshot, status: "completed", errorCode: null, errorMessage: null, review: undefined, resultTurnId: acceptedTurn.id };
  const reofferedSnapshot = { ...snapshot, status: "recoverable", attempts: 2, review: reofferedReview };
  const reofferedQueuedSnapshot = { ...snapshot, status: "queued", attempts: 2, errorCode: null, errorMessage: null, review: reofferedDecidedReview };
  const reofferedCompletedSnapshot = { ...completedSnapshot, attempts: 2 };
  const acceptedResult = {
    id: jobId,
    status: "completed",
    campaignId: fixture.campaignId,
    expectedTurnNumber: resultTurnNumber,
    resultTurnId: acceptedTurn.id,
    errorCode: null,
    errorMessage: null,
    turnNumber: resultTurnNumber,
    action: snapshot.action,
    inputMode: "scene",
    inputModeSource: "explicit",
    narration: detail.narration,
    choices: detail.choices,
    customActionSuggestion: "",
    imagePrompt: "",
    chronicleRetrieval: null,
    modelMetadata: null,
    mechanics: null,
    acceptedAt: snapshot.updatedAt,
    stateSnapshot: {},
    reportedCost: null
  };
  const characterProfile = { campaignId: fixture.campaignId, characterId: "mira-vale", revision: 4, name: "Mira Vale", profile: { story: { role: "Harbor scout", keyRelationships: "Trusts the lighthouse keeper." } }, storedProfile: null, inheritedFromSnapshot: true, legacyCharacterText: "", rpgStats: [], defaultTriggers: [] };
  // Keep the browser double aligned with the public decoder. A malformed
  // response only tests the unavailable fallback, never the review controls.
  campaignSyncStatusSchema.parse({ ...fixture.syncStatus, pendingGeneration: null, generationRecovery: recovery });
  generationJobSnapshotSchema.parse(snapshot);
  generationJobSnapshotSchema.parse(generatingSnapshot);
  generationJobSnapshotSchema.parse(queuedSnapshot);
  generationJobSnapshotSchema.parse(completedSnapshot);
  generationJobSnapshotSchema.parse(reofferedSnapshot);
  generationJobSnapshotSchema.parse(reofferedQueuedSnapshot);
  generationJobSnapshotSchema.parse(reofferedCompletedSnapshot);
  generationReviewDetailSchema.parse(detail);
  await page.route("**/api/v1/**", async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") writePaths.push(`${request.method()} ${path}`);
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "GET" && path === "/api/v1/session") return respond(fixture.session);
    if (request.method() === "GET" && path === "/api/v1/meta") return respond({ application: { name: "Infinite Quest Nexus", version: "test", commit: null, builtAt: null }, capabilities: { systemArchive: false } });
    if (request.method() === "GET" && path === "/api/v1/providers") return respond({ providers: [{
      id: "77777777-7777-4777-8777-777777777777", name: "Fixture text provider", providerType: "openai_compatible", providerRole: "text"
    }] });
    if (request.method() === "GET" && path === "/api/v1/campaigns") return respond(fixture.campaigns);
    if (request.method() === "GET" && path === "/api/v1/worlds") return respond(fixture.worlds);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${fixture.campaignId}/sync-status`) return respond(sharedState.accepted ? completedSync : terminalAction ? { ...fixture.syncStatus, pendingGeneration: null, generationRecovery: null } : options.liveStream ? { ...fixture.syncStatus, pendingGeneration: pending, generationRecovery: null } : { ...fixture.syncStatus, pendingGeneration: null, generationRecovery: recovery });
    if (request.method() === "GET" && path === `/api/v1/campaigns/${fixture.campaignId}/turns`) return respond(sharedState.accepted ? completedSync.turns : fixture.turns);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${fixture.campaignId}/state`) return respond(fixture.runtimeState);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${fixture.campaignId}/state/inspection`) return respond(fixture.runtimeState);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${fixture.campaignId}/story-memory`) return respond({ level: "off", reviewMode: "off", availableLevels: ["off"] });
    if (request.method() === "GET" && path === `/api/v1/campaigns/${fixture.campaignId}/character-profile`) return respond(characterProfile);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${fixture.campaignId}/illustration-config`) return respond(fixture.illustrationConfig);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${fixture.campaignId}/illustration-segments`) return respond(fixture.illustrationSegments);
    if (request.method() === "GET" && path === `/api/v1/campaigns/${fixture.campaignId}/image-jobs`) return respond({ jobs: [] });
    if (request.method() === "GET" && path === `/api/v1/turns/${acceptedTurn.id}/illustration-resolution`) return respond({
      id: "99999999-9999-4999-8999-999999999999",
      campaignId: fixture.campaignId,
      turnId: acceptedTurn.id,
      sourcePolicy: "library_only",
      matchingScope: "world",
      confidenceProfile: "strict",
      status: "no_match",
      selectedAssetId: null,
      selectedScore: null,
      resolvedThreshold: null,
      algorithmVersion: "fixture-v1",
      imageJobId: null,
      reasonCode: null,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      completedAt: snapshot.updatedAt,
      candidates: []
    });
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${jobId}/review`) {
      reviewDetailRequests += 1;
      if (options.delayReviewDetailMs) await new Promise<void>((resolve) => setTimeout(resolve, options.delayReviewDetailMs));
      settledReviewDetailRequests += 1;
      if (options.failReviewDetail) return respond({ error: "Review detail unavailable" }, 503);
      return respond(reoffered ? reofferedDetail : detail);
    }
    if (request.method() === "POST" && path === `/api/v1/generation-jobs/${jobId}/review-decision`) {
      const decision = request.postDataJSON() as { decision?: string };
      decisions.push(decision);
      if (decision.decision === "retry") reoffered = true;
      if (decisionFails) return respond({ error: "Decision unavailable" }, 503);
      if (options.decisionConflict) {
        sharedState.accepted = true;
        return respond({ error: "generation_review_conflict", message: "This review was resolved in another tab." }, 409);
      }
      if (options.conflictWhenAccepted && sharedState.accepted) return respond({ error: "generation_review_conflict", message: "This review was resolved in another tab." }, 409);
      if (decisionCompletes && !options.liveStream) sharedState.accepted = true;
      if (options.conflictWhenAccepted) sharedState.accepted = true;
      return respond({ id: jobId, status: "queued", operationKind, replacementTurnId }, 202);
    }
    if (request.method() === "POST" && (path === `/api/v1/generation-jobs/${jobId}/discard` || path === `/api/v1/generation-jobs/${jobId}/cancel`)) {
      terminalAction = path.endsWith("/discard") ? "discarded" : "cancelled";
      return respond({ id: jobId, status: terminalAction, operationKind, replacementTurnId }, 202);
    }
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${jobId}/stream`) return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify(snapshot)}\n\n` });
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${jobId}/result`) {
      resultRequests += 1;
      if (options.failFirstResult && resultRequests === 1) return respond({ error: "Result temporarily unavailable" }, 503);
      sharedState.accepted = true;
      return respond(acceptedResult);
    }
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${jobId}`) return respond(sharedState.accepted ? completedSnapshot : snapshot);
    unexpectedFixtureRoutes.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Missing review fixture route." }) });
  });
  return { fixture, decisions, writePaths, consoleErrors, get reviewDetailRequests() { return reviewDetailRequests; }, get settledReviewDetailRequests() { return settledReviewDetailRequests; }, get resultRequests() { return resultRequests; }, generatingSnapshot, snapshot, queuedSnapshot, completedSnapshot, reofferedSnapshot, reofferedQueuedSnapshot, reofferedCompletedSnapshot };
}

async function streamedNarration(page: Page, surface: "legacy" | "web-next"): Promise<string> {
  const locator = page.locator(surface === "legacy"
    ? "#streamingPreviewCard .streaming-narration"
    : "[data-story-generation-preview] .story-narration");
  if (await locator.count() === 0) return "";
  return (await locator.allTextContents()).map((text) => text.trim()).filter(Boolean).join(" ");
}

async function acceptedNarration(page: Page, surface: "legacy" | "web-next", turnNumber: number): Promise<string> {
  const locator = surface === "legacy"
    ? page.locator(`#scene-${turnNumber} .scene-narration .narration`)
    : page.locator("[data-story-reader] .story-leaf")
      .filter({ has: page.getByRole("heading", { name: `Turn ${turnNumber}`, exact: true }) })
      .locator(".story-narration");
  await expect(locator.first()).toBeVisible();
  return (await locator.allTextContents()).map((text) => text.trim()).filter(Boolean).join(" ");
}

async function installStagedReviewStream(page: Page, snapshots: { readonly generatingSnapshot: unknown; readonly snapshot: unknown; readonly queuedSnapshot: unknown; readonly completedSnapshot: unknown; readonly reofferedSnapshot: unknown; readonly reofferedQueuedSnapshot: unknown; readonly reofferedCompletedSnapshot: unknown }) {
  await page.addInitScript((frames) => {
    const NativeEventSource = window.EventSource;
    let decisionSaved = false;
    let streamCount = 0;
    let reviewSource: StagedReviewEventSource | null = null;
    const completeAfterDecision = () => {
      decisionSaved = true;
      reviewSource?.emit(frames.queuedSnapshot);
      setTimeout(() => reviewSource?.emit(frames.completedSnapshot), 40);
    };
    (window as Window & { __generationReviewFixtureCompleteAfterDecision?: () => void }).__generationReviewFixtureCompleteAfterDecision = completeAfterDecision;
    (window as Window & { __generationReviewFixtureReofferAfterRetry?: () => void }).__generationReviewFixtureReofferAfterRetry = () => {
      reviewSource?.emit(frames.queuedSnapshot);
      setTimeout(() => reviewSource?.emit(frames.reofferedSnapshot), 30);
    };
    (window as Window & { __generationReviewFixtureCompleteReofferedDecision?: () => void }).__generationReviewFixtureCompleteReofferedDecision = () => {
      reviewSource?.emit(frames.reofferedQueuedSnapshot);
      setTimeout(() => reviewSource?.emit(frames.reofferedCompletedSnapshot), 30);
    };
    class StagedReviewEventSource {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      emit(snapshot: unknown) {
        (window as Window & { __generationReviewFixtureLastSnapshot?: unknown }).__generationReviewFixtureLastSnapshot = snapshot;
        if (!this.closed) this.onmessage?.({ data: JSON.stringify(snapshot) } as MessageEvent<string>);
      }
      constructor(url: string | URL) {
        const pathname = new URL(String(url), window.location.href).pathname;
        if (!pathname.endsWith("/stream")) return new NativeEventSource(url) as unknown as StagedReviewEventSource;
        streamCount += 1;
        (window as Window & { __generationReviewFixtureStreamCount?: number }).__generationReviewFixtureStreamCount = streamCount;
        if (decisionSaved) {
          queueMicrotask(() => this.emit(frames.queuedSnapshot));
          setTimeout(() => this.emit(frames.completedSnapshot), 40);
        } else {
          reviewSource = this;
          queueMicrotask(() => this.emit(frames.generatingSnapshot));
          (window as Window & { __generationReviewFixtureAdvance?: () => void }).__generationReviewFixtureAdvance = () => this.emit(frames.snapshot);
        }
      }
      close() { this.closed = true; }
    }
    window.EventSource = StagedReviewEventSource as unknown as typeof EventSource;
  }, snapshots);
}

for (const surface of ["legacy", "web-next"] as const) {
  test(`${surface} reloads a structure review ahead of context advice and posts only its explicit Retry decision`, async ({ page }) => {
    const api = await installReviewApi(page, false, false, false, { structureReview: true });
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route("**/vendor/photoswipe/photoswipe.css", route => route.fulfill({ contentType: "text/css", body: "" }));
      await page.route(`**/story/${api.fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    const url = surface === "legacy" ? `${legacyOrigin}/story/${api.fixture.campaignId}` : `${webNextOrigin}/app/story/${api.fixture.campaignId}`;
    await page.goto(url);
    const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    const preview = page.locator(surface === "legacy" ? "#streamingPreviewCard" : "[data-story-generation-preview]");
    const acceptedTurns = surface === "legacy"
      ? page.locator("#storyContainer [id^='scene-']")
      : page.getByRole("heading", { name: /^Turn \d+$/u });
    const activeTurn = surface === "legacy"
      ? page.locator("#turnPill")
      : page.getByRole("region", { name: "Story controls", exact: true }).getByText("Active turn 1", { exact: true });
    const turnTwo = surface === "legacy"
      ? page.locator("#scene-2")
      : page.getByRole("heading", { name: "Turn 2", exact: true });
    const acceptedBeforeDecision = await acceptedNarration(page, surface, 1);
    await expect(acceptedTurns).toHaveCount(1);
    await expect(activeTurn).toHaveText(surface === "legacy" ? "Turn 1" : "Active turn 1");
    await expect(turnTwo).toHaveCount(0);
    await expect(recovery).toContainText("invalid structure");
    await expect(recovery).not.toContainText("Context evidence was omitted");
    await expect(recovery.getByRole("button", { name: "Keep this turn", exact: true })).toHaveCount(0);
    await expect(preview).toBeHidden();
    expect(await streamedNarration(page, surface)).toBe("");
    await page.reload();
    await expect(recovery).toContainText("invalid structure");
    await expect(preview).toBeHidden();
    expect(await streamedNarration(page, surface)).toBe("");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: `docs/review/assets/generation-format-recovery/${surface}-structure-review-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `docs/review/assets/generation-format-recovery/${surface}-structure-review-390.png`, fullPage: true });
    const retry = surface === "legacy" ? page.locator("#btnRetryGenerationReview") : recovery.getByRole("button", { name: "Continue with retry", exact: true });
    await retry.click();
    await expect.poll(() => api.decisions).toEqual([{ reviewId, revision: 1, decision: "retry" }]);
    expect(api.writePaths).toEqual([`POST /api/v1/generation-jobs/${jobId}/review-decision`]);
    await expect(preview).toBeHidden();
    expect(await streamedNarration(page, surface)).toBe("");
    expect(await acceptedNarration(page, surface, 1)).toBe(acceptedBeforeDecision);
    await expect(acceptedTurns).toHaveCount(1);
    await expect(activeTurn).toHaveText(surface === "legacy" ? "Turn 1" : "Active turn 1");
    await expect(turnTwo).toHaveCount(0);
    expect(api.writePaths).toEqual([`POST /api/v1/generation-jobs/${jobId}/review-decision`]);
  });

  test(`${surface} renders a saved review and posts only an explicit Keep decision`, async ({ page }) => {
    const api = await installReviewApi(page);
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route("**/vendor/photoswipe/photoswipe.css", route => route.fulfill({ contentType: "text/css", body: "" }));
      await page.route(`**/story/${api.fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${api.fixture.campaignId}` : `${webNextOrigin}/app/story/${api.fixture.campaignId}`);
    const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    await expect(recovery.getByRole("button", { name: "Keep this turn", exact: true })).toBeVisible();
    await expect(recovery.getByRole("button", { name: "Continue with retry", exact: true })).toBeVisible();
    await expect(recovery).toContainText("The lighthouse bell answered across the harbor.");
    const webAwesome = surface === "web-next"
      && await page.locator(".app-shell").getAttribute("data-ui-implementation") === "web-awesome";
    const continuation = surface === "legacy"
      ? page.locator("#btnTakeAction")
      : webAwesome ? page.getByRole("button", { name: "Continue Story", exact: true }) : page.locator("[data-action='continue-story']");
    const acceptedChoice = surface === "legacy"
      ? page.locator("#choiceArea .choice").first()
      : webAwesome ? page.getByRole("button", { name: "Cross the threshold", exact: true }).first() : page.locator("[data-story-choice]").first();
    await expect(continuation).toBeDisabled();
    await expect(acceptedChoice).toBeDisabled();
    const keep = recovery.getByRole("button", { name: "Keep this turn", exact: true });
    await keep.focus();
    await expect(keep).toBeFocused();
    expect(api.decisions).toEqual([]);
    expect(api.writePaths).toEqual([]);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: `docs/review/assets/generation-rejection-review/${surface}-eligible-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `docs/review/assets/generation-rejection-review/${surface}-eligible-390.png`, fullPage: true });
    await keep.click();
    await expect.poll(() => api.decisions).toEqual([{ reviewId, revision: 1, decision: "keep" }]);
    await expect.poll(() => api.writePaths).toEqual([`POST /api/v1/generation-jobs/${jobId}/review-decision`]);
    expect(api.consoleErrors).toEqual([]);
  });

  test(`${surface} explains blocked candidates without a Keep control`, async ({ page }) => {
    const api = await installReviewApi(page, false);
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route("**/vendor/photoswipe/photoswipe.css", route => route.fulfill({ contentType: "text/css", body: "" }));
      await page.route(`**/story/${api.fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${api.fixture.campaignId}` : `${webNextOrigin}/app/story/${api.fixture.campaignId}`);
    const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    await expect(recovery).toContainText("candidate choices do not meet the required structure");
    await expect(recovery.getByRole("button", { name: "Keep this turn", exact: true })).toBeHidden();
    await expect(recovery.getByRole("button", { name: "Discard generation job", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: `docs/review/assets/generation-rejection-review/${surface}-blocked-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `docs/review/assets/generation-rejection-review/${surface}-blocked-390.png`, fullPage: true });
    expect(api.consoleErrors).toEqual([]);
  });

  test(`${surface} rehydrates a pending review on reload without posting a decision`, async ({ page }) => {
    const api = await installReviewApi(page);
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route("**/vendor/photoswipe/photoswipe.css", route => route.fulfill({ contentType: "text/css", body: "" }));
      await page.route(`**/story/${api.fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${api.fixture.campaignId}` : `${webNextOrigin}/app/story/${api.fixture.campaignId}`);
    await page.reload();
    const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    await expect(recovery.getByRole("button", { name: "Keep this turn", exact: true })).toBeVisible();
    await expect(recovery).toContainText("The lighthouse bell answered across the harbor.");
    expect(api.decisions).toEqual([]);
    expect(api.writePaths).toEqual([]);
    expect(api.consoleErrors).toEqual([]);
  });

  test(`${surface} keeps the exact saved narration after Keep and result reload`, async ({ page }) => {
    const api = await installReviewApi(page, true, false, true);
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route("**/vendor/photoswipe/photoswipe.css", route => route.fulfill({ contentType: "text/css", body: "" }));
      await page.route(`**/story/${api.fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${api.fixture.campaignId}` : `${webNextOrigin}/app/story/${api.fixture.campaignId}`);
    const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    await recovery.getByRole("button", { name: "Keep this turn", exact: true }).click();
    await expect.poll(() => api.decisions).toEqual([{ reviewId, revision: 1, decision: "keep" }]);
    await page.reload();
    await expect(page.locator("body")).toContainText("The lighthouse bell answered across the harbor.");
    await expect(recovery).toBeHidden();
    expect(api.writePaths).toEqual([`POST /api/v1/generation-jobs/${jobId}/review-decision`]);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: `docs/review/assets/generation-rejection-review/${surface}-accepted-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `docs/review/assets/generation-rejection-review/${surface}-accepted-390.png`, fullPage: true });
    expect(api.consoleErrors).toEqual([]);
  });

  test(`${surface} streams the saved narration through review, then reloads a lost accepted result without new generation`, async ({ page }) => {
    const api = await installReviewApi(page, true, false, false, { liveStream: true, failFirstResult: true });
    await installStagedReviewStream(page, api);
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route("**/vendor/photoswipe/photoswipe.css", route => route.fulfill({ contentType: "text/css", body: "" }));
      await page.route(`**/story/${api.fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${api.fixture.campaignId}` : `${webNextOrigin}/app/story/${api.fixture.campaignId}`);
    const preview = page.locator(surface === "legacy" ? "#streamingPreviewCard" : "[data-story-generation-preview]");
    await expect(preview).toContainText("The lighthouse bell answered across the harbor.");
    const previewNarration = await streamedNarration(page, surface);
    expect(previewNarration).toBe("The lighthouse bell answered across the harbor.");
    await page.evaluate(() => (window as Window & { __generationReviewFixtureAdvance?: () => void }).__generationReviewFixtureAdvance?.());
    await expect.poll(() => page.evaluate(() => (window as Window & { __generationReviewFixtureLastSnapshot?: { review?: { reviewId?: string } } }).__generationReviewFixtureLastSnapshot?.review?.reviewId)).toBe(reviewId);
    await expect.poll(() => api.reviewDetailRequests).toBeGreaterThan(0);
    const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    const keep = surface === "legacy" ? page.locator("#btnKeepGenerationReview") : recovery.getByRole("button", { name: "Keep this turn", exact: true });
    await expect(keep).toBeVisible();
    await keep.click();
    await expect.poll(() => api.decisions).toEqual([{ reviewId, revision: 1, decision: "keep" }]);
    await expect(keep).toBeEnabled();
    await page.evaluate(() => (window as Window & { __generationReviewFixtureCompleteAfterDecision?: () => void }).__generationReviewFixtureCompleteAfterDecision?.());
    await expect.poll(() => api.resultRequests).toBe(1);
    const reloadResult = surface === "legacy" ? page.locator("#btnRetryGeneration") : recovery.getByRole("button", { name: "Load accepted result", exact: true });
    await expect(reloadResult).toBeVisible();
    expect(api.resultRequests).toBe(1);
    await reloadResult.click();
    await expect(page.locator("body")).toContainText("The lighthouse bell answered across the harbor.");
    expect(await acceptedNarration(page, surface, 2)).toBe(previewNarration);
    await expect(recovery).toBeHidden();
    expect(api.resultRequests).toBe(2);
    expect(api.writePaths).toEqual([`POST /api/v1/generation-jobs/${jobId}/review-decision`]);
    expect(await page.evaluate(() => (window as Window & { __generationReviewFixtureStreamCount?: number }).__generationReviewFixtureStreamCount)).toBe(1);
    expect(api.consoleErrors.filter((message) => !message.includes("503 (Service Unavailable)"))).toEqual([]);
  });

  test(`${surface} retains a full streamed preview when the saved review detail is delayed or unavailable`, async ({ page }) => {
    const api = await installReviewApi(page, true, false, false, { liveStream: true, delayReviewDetailMs: 30, failReviewDetail: true });
    await installStagedReviewStream(page, api);
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route("**/vendor/photoswipe/photoswipe.css", route => route.fulfill({ contentType: "text/css", body: "" }));
      await page.route(`**/story/${api.fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${api.fixture.campaignId}` : `${webNextOrigin}/app/story/${api.fixture.campaignId}`);
    const preview = page.locator(surface === "legacy" ? "#streamingPreviewCard" : "[data-story-generation-preview]");
    await expect(preview).toContainText("The lighthouse bell answered across the harbor.");
    await page.evaluate(() => (window as Window & { __generationReviewFixtureAdvance?: () => void }).__generationReviewFixtureAdvance?.());
    const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    await expect(recovery).toBeVisible();
    await expect(preview).toContainText("The lighthouse bell answered across the harbor.");
    await expect.poll(() => api.reviewDetailRequests).toBeGreaterThan(0);
    await expect.poll(() => api.settledReviewDetailRequests).toBe(1);
    expect(api.decisions).toEqual([]);
    expect(api.writePaths).toEqual([]);
    expect(api.writePaths).toEqual([]);
  });

  test(`${surface} reoffers the original saved narration after an authorized retry worker failure`, async ({ page }) => {
    const api = await installReviewApi(page, true, false, false, { liveStream: true });
    await installStagedReviewStream(page, api);
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route("**/vendor/photoswipe/photoswipe.css", route => route.fulfill({ contentType: "text/css", body: "" }));
      await page.route(`**/story/${api.fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${api.fixture.campaignId}` : `${webNextOrigin}/app/story/${api.fixture.campaignId}`);
    await expect(page.locator(surface === "legacy" ? "#streamingPreviewCard" : "[data-story-generation-preview]")).toContainText("The lighthouse bell answered across the harbor.");
    await page.evaluate(() => (window as Window & { __generationReviewFixtureAdvance?: () => void }).__generationReviewFixtureAdvance?.());
    const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    const retry = surface === "legacy" ? page.locator("#btnRetryGenerationReview") : recovery.getByRole("button", { name: "Continue with retry", exact: true });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect.poll(() => api.decisions).toEqual([{ reviewId, revision: 1, decision: "retry" }]);
    await expect(retry).toBeEnabled();
    await page.evaluate(() => (window as Window & { __generationReviewFixtureReofferAfterRetry?: () => void }).__generationReviewFixtureReofferAfterRetry?.());
    await expect.poll(() => page.evaluate(() => (window as Window & { __generationReviewFixtureLastSnapshot?: { review?: { reviewId?: string } } }).__generationReviewFixtureLastSnapshot?.review?.reviewId)).toBe(reofferedReviewId);
    await expect.poll(() => api.reviewDetailRequests).toBeGreaterThan(1);
    const keep = surface === "legacy" ? page.locator("#btnKeepGenerationReview") : recovery.getByRole("button", { name: "Keep this turn", exact: true });
    await expect(keep).toBeVisible();
    await expect(recovery).toContainText("The lighthouse bell answered across the harbor.");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: `docs/review/assets/generation-rejection-review/${surface}-retry-reoffered-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `docs/review/assets/generation-rejection-review/${surface}-retry-reoffered-390.png`, fullPage: true });
    await keep.click();
    await expect.poll(() => api.decisions).toEqual([
      { reviewId, revision: 1, decision: "retry" },
      { reviewId: reofferedReviewId, revision: 3, decision: "keep" }
    ]);
    await expect(keep).toBeEnabled();
    await page.evaluate(() => (window as Window & { __generationReviewFixtureCompleteReofferedDecision?: () => void }).__generationReviewFixtureCompleteReofferedDecision?.());
    await expect.poll(() => api.resultRequests).toBe(1);
    await expect(page.locator("body")).toContainText("The lighthouse bell answered across the harbor.");
    await expect(recovery).toBeHidden();
    expect(api.writePaths).toEqual([
      `POST /api/v1/generation-jobs/${jobId}/review-decision`,
      `POST /api/v1/generation-jobs/${jobId}/review-decision`
    ]);
  });

  test(`${surface} keeps the saved review visible after an explicit retry decision fails`, async ({ page }) => {
    const api = await installReviewApi(page, true, true);
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route("**/vendor/photoswipe/photoswipe.css", route => route.fulfill({ contentType: "text/css", body: "" }));
      await page.route(`**/story/${api.fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${api.fixture.campaignId}` : `${webNextOrigin}/app/story/${api.fixture.campaignId}`);
    const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    const retry = recovery.getByRole("button", { name: "Continue with retry", exact: true });
    await retry.click();
    await expect.poll(() => api.decisions).toEqual([{ reviewId, revision: 1, decision: "retry" }]);
    await expect(recovery).toContainText("Your decision could not be saved. The turn remains unchanged.");
    await expect(retry).toBeEnabled();
    expect(api.writePaths).toEqual([`POST /api/v1/generation-jobs/${jobId}/review-decision`]);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: `docs/review/assets/generation-rejection-review/${surface}-decision-save-failure-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `docs/review/assets/generation-rejection-review/${surface}-decision-save-failure-390.png`, fullPage: true });
    expect(api.consoleErrors).toEqual(["Failed to load resource: the server responded with a status of 503 (Service Unavailable)"]);
  });

  test(`${surface} refreshes an accepted turn after a stale review decision from another tab`, async ({ page }) => {
    const api = await installReviewApi(page, true, false, false, { decisionConflict: true });
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route("**/vendor/photoswipe/photoswipe.css", route => route.fulfill({ contentType: "text/css", body: "" }));
      await page.route(`**/story/${api.fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${api.fixture.campaignId}` : `${webNextOrigin}/app/story/${api.fixture.campaignId}`);
    const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    const keep = surface === "legacy" ? page.locator("#btnKeepGenerationReview") : recovery.getByRole("button", { name: "Keep this turn", exact: true });
    await keep.click();
    await expect.poll(() => api.decisions).toEqual([{ reviewId, revision: 1, decision: "keep" }]);
    await expect(page.locator("body")).toContainText("The lighthouse bell answered across the harbor.");
    await expect(recovery).toBeHidden();
    expect(api.writePaths).toEqual([`POST /api/v1/generation-jobs/${jobId}/review-decision`]);
  });

  test(`${surface} resolves a stale second-tab decision from the authoritative accepted turn`, async ({ page }) => {
    const sharedState = { accepted: false };
    const other = await page.context().newPage();
    const firstApi = await installReviewApi(page, true, false, false, { sharedState, conflictWhenAccepted: true });
    const secondApi = await installReviewApi(other, true, false, false, { sharedState, conflictWhenAccepted: true });
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      for (const target of [page, other]) {
        await target.route("**/vendor/photoswipe/photoswipe.css", route => route.fulfill({ contentType: "text/css", body: "" }));
        await target.route(`**/story/${firstApi.fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
      }
    }
    const url = surface === "legacy" ? `${legacyOrigin}/story/${firstApi.fixture.campaignId}` : `${webNextOrigin}/app/story/${firstApi.fixture.campaignId}`;
    await Promise.all([page.goto(url), other.goto(url)]);
    const firstRecovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    const secondRecovery = other.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    const firstKeep = surface === "legacy" ? page.locator("#btnKeepGenerationReview") : firstRecovery.getByRole("button", { name: "Keep this turn", exact: true });
    const secondKeep = surface === "legacy" ? other.locator("#btnKeepGenerationReview") : secondRecovery.getByRole("button", { name: "Keep this turn", exact: true });
    await firstKeep.click();
    await expect.poll(() => firstApi.decisions).toEqual([{ reviewId, revision: 1, decision: "keep" }]);
    await page.reload();
    await expect(firstRecovery).toBeHidden();
    await secondKeep.click();
    await expect.poll(() => secondApi.decisions).toEqual([{ reviewId, revision: 1, decision: "keep" }]);
    await expect(secondRecovery).toBeHidden();
    expect(firstApi.writePaths).toEqual([`POST /api/v1/generation-jobs/${jobId}/review-decision`]);
    expect(secondApi.writePaths).toEqual([`POST /api/v1/generation-jobs/${jobId}/review-decision`]);
    await other.close();
  });

  test(`${surface} discards a pending review without changing the accepted turn`, async ({ page }) => {
    const api = await installReviewApi(page);
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route("**/vendor/photoswipe/photoswipe.css", route => route.fulfill({ contentType: "text/css", body: "" }));
      await page.route(`**/story/${api.fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${api.fixture.campaignId}` : `${webNextOrigin}/app/story/${api.fixture.campaignId}`);
    const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    const discard = surface === "legacy" ? page.locator("#btnDiscardGenerationRecovery") : recovery.getByRole("button", { name: "Discard generation job", exact: true });
    await expect(discard).toBeVisible();
    await discard.click();
    await expect(recovery).toBeHidden();
    await expect(page.locator("body")).toContainText("The platform is quiet, with three marked paths ahead.");
    expect(api.writePaths).toEqual([`POST /api/v1/generation-jobs/${jobId}/discard`]);
    expect(api.decisions).toEqual([]);
  });

  test(`${surface} preserves the old accepted turn during a replace-latest review until Keep commits`, async ({ page }) => {
    const api = await installReviewApi(page, true, false, true, { replaceLatest: true });
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route("**/vendor/photoswipe/photoswipe.css", route => route.fulfill({ contentType: "text/css", body: "" }));
      await page.route(`**/story/${api.fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.goto(surface === "legacy" ? `${legacyOrigin}/story/${api.fixture.campaignId}` : `${webNextOrigin}/app/story/${api.fixture.campaignId}`);
    const recovery = page.locator(surface === "legacy" ? "#generationRecoveryPanel" : "[data-story-recovery]");
    await expect(page.locator("body")).toContainText("The platform is quiet, with three marked paths ahead.");
    await expect(recovery).toContainText("The lighthouse bell answered across the harbor.");
    const keep = surface === "legacy" ? page.locator("#btnKeepGenerationReview") : recovery.getByRole("button", { name: "Keep this turn", exact: true });
    await keep.click();
    await expect.poll(() => api.decisions).toEqual([{ reviewId, revision: 1, decision: "keep" }]);
    await page.reload();
    await expect(recovery).toBeHidden();
    await expect(page.locator("body")).toContainText("The lighthouse bell answered across the harbor.");
    expect(api.writePaths).toEqual([`POST /api/v1/generation-jobs/${jobId}/review-decision`]);
  });
}

test("web-next web-awesome renders fenced pending-review Keep and Retry controls", async ({ page }) => {
  test.skip(process.env.TASK7_EXPECT_WEB_AWESOME !== "true", "This bounded assertion runs against the explicit web-awesome Vite server.");
  const api = await installReviewApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${webNextOrigin}/app/story/${api.fixture.campaignId}`);
  await expect(page.locator(".app-shell")).toHaveAttribute("data-ui-implementation", "web-awesome");
  const recovery = page.locator("[data-story-recovery]");
  await expect(recovery.getByRole("button", { name: "Keep this turn", exact: true })).toBeVisible();
  const retry = recovery.getByRole("button", { name: "Continue with retry", exact: true });
  await expect(retry).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue Story", exact: true })).toBeDisabled();
  await retry.click();
  await expect.poll(() => api.decisions).toEqual([{ reviewId, revision: 1, decision: "retry" }]);
  expect(api.writePaths).toEqual([`POST /api/v1/generation-jobs/${jobId}/review-decision`]);
});
