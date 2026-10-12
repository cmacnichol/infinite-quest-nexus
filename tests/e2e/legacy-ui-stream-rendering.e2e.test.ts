import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import {
  generationEnqueueResponseSchema,
  generationJobSnapshotSchema,
  generationResultSchema,
  generationStreamSnapshotSchema,
  type GenerationStreamSnapshot
} from "../../packages/contracts/src/index.js";
import { legacyUiFixture, installLegacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const jobId = "55555555-5555-4555-8555-555555555555";
const resultTurnId = "88888888-8888-4888-8888-888888888888";
const timestamp = "2026-10-03T12:00:00.000Z";

interface StreamFixtureControl {
  sourceCount(): number;
  emit(snapshot: unknown): void;
  emitTo(sourceIndex: number, snapshot: unknown): void;
  forceLateTo(sourceIndex: number, snapshot: unknown): void;
  resetWriteCount(): void;
  writeCount(): number;
  instrumentationReady(): boolean;
  previewTextAtCommit(): string | null;
  frameWasPendingAtPreviewRemoval(): boolean;
  holdNextAnimationFrame(): void;
  hasHeldAnimationFrame(): boolean;
  releaseHeldAnimationFrame(): boolean;
}

declare global {
  interface Window {
    __storyStreamFixture?: StreamFixtureControl;
  }
}

interface StreamHarness {
  readonly campaignId: string;
  readonly secondCampaignId: string;
  readonly expectedTurnNumber: number;
  readonly jobId: string;
  readonly resultTurnId: string;
  readonly acceptedNarration: string;
  readonly writes: Array<{ method: string; path: string; body: unknown }>;
  readonly waitForResultRequest: Promise<void>;
  readonly activateRecoverable: () => void;
  readonly previewTextAtCommit: () => Promise<string | null>;
  readonly frameWasPendingAtPreviewRemoval: () => Promise<boolean>;
  readonly releaseResult: () => void;
}

async function installStreamHarness(
  page: Page,
  turnCount = 1,
  acceptedNarration = "A synthetic lantern glows beside the quiet station.",
  holdResult = false
): Promise<StreamHarness> {
  const fixture = legacyUiFixture({ turnCount, worldCount: 1, campaignCount: 2 });
  const writes: StreamHarness["writes"] = [];
  let resultRequestStarted!: () => void;
  const waitForResultRequest = new Promise<void>(resolve => { resultRequestStarted = resolve; });
  let releaseResult!: () => void;
  const resultReleased = new Promise<void>(resolve => { releaseResult = resolve; });
  let durableRecoveryActive = false;
  const campaignId = fixture.campaignId;
  const secondCampaign = fixture.campaigns[1];
  const secondCampaignId = String(secondCampaign?.id);
  const secondCampaignTurns = fixture.turns.map((turn, index) => ({
    ...turn,
    id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    narration: `Campaign B synthetic scene ${Number(turn.turnNumber)} remains visible after A changes.`
  }));

  await installLegacyUiFixture(page, fixture);
  await page.addInitScript(() => {
    let domWrites = 0;
    const sources: Array<{
      onmessage: ((event: MessageEvent<string>) => void) | null;
      onerror: ((event: Event) => void) | null;
      closed: boolean;
      lastHandler: ((event: MessageEvent<string>) => void) | null;
      emit(snapshot: unknown): void;
    }> = [];
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    let heldAnimationFrame: FrameRequestCallback | null = null;
    let previewTextAtCommit: string | null = null;
    let framePendingAtPreviewRemoval = false;
    const capturePreviewAtCommit = (element: Element) => {
      if (element.id !== "streamingPreviewCard") return;
      const narration = element.querySelector(".streaming-narration");
      if (!narration) return;
      const copy = narration.cloneNode(true) as HTMLElement;
      copy.querySelector(".streaming-cursor")?.remove();
      previewTextAtCommit = copy.textContent;
      framePendingAtPreviewRemoval = heldAnimationFrame !== null;
    };
    const originalRemove = Element.prototype.remove;
    Element.prototype.remove = function () {
      capturePreviewAtCommit(this);
      return originalRemove.call(this);
    };
    const originalReplaceWith = Element.prototype.replaceWith;
    Element.prototype.replaceWith = function (...nodes: Array<Node | string>) {
      capturePreviewAtCommit(this);
      return originalReplaceWith.apply(this, nodes);
    };

    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    const instrumentationReady = Boolean(descriptor?.get && descriptor.set);
    if (descriptor?.get && descriptor.set) {
      Object.defineProperty(Element.prototype, "innerHTML", {
        configurable: descriptor.configurable ?? false,
        enumerable: descriptor.enumerable ?? false,
        get() { return descriptor.get?.call(this) ?? ""; },
        set(value: string) {
          if (this instanceof Element && this.matches(".streaming-narration")) domWrites += 1;
          descriptor.set?.call(this, value);
        }
      });
    }

    class SyntheticEventSource {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      closed = false;
      lastHandler: ((event: MessageEvent<string>) => void) | null = null;

      constructor(_url: string | URL) {
        sources.push(this);
      }

      emit(snapshot: unknown) {
        if (this.closed || !this.onmessage) return;
        this.lastHandler = this.onmessage;
        this.onmessage(new MessageEvent("message", { data: JSON.stringify(snapshot) }));
      }

      close() { this.closed = true; }
    }

    window.EventSource = SyntheticEventSource as unknown as typeof EventSource;
    window.__storyStreamFixture = {
      sourceCount: () => sources.length,
      emit(snapshot) { sources.at(-1)?.emit(snapshot); },
      emitTo(sourceIndex, snapshot) { sources[sourceIndex]?.emit(snapshot); },
      forceLateTo(sourceIndex, snapshot) {
        const savedHandler = sources[sourceIndex]?.lastHandler;
        savedHandler?.(new MessageEvent("message", { data: JSON.stringify(snapshot) }));
      },
      resetWriteCount: () => { domWrites = 0; },
      writeCount: () => domWrites,
      instrumentationReady: () => instrumentationReady,
      previewTextAtCommit: () => previewTextAtCommit,
      frameWasPendingAtPreviewRemoval: () => framePendingAtPreviewRemoval,
      holdNextAnimationFrame() {
        heldAnimationFrame = null;
        window.requestAnimationFrame = callback => {
          if (!heldAnimationFrame) {
            heldAnimationFrame = callback;
            return -1;
          }
          return nativeRequestAnimationFrame(callback);
        };
      },
      hasHeldAnimationFrame: () => heldAnimationFrame !== null,
      releaseHeldAnimationFrame() {
        window.requestAnimationFrame = nativeRequestAnimationFrame;
        const callback = heldAnimationFrame;
        heldAnimationFrame = null;
        callback?.(performance.now());
        return callback !== null;
      }
    };
  });

  await page.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() !== "GET" && request.method() !== "HEAD") {
      let body: unknown = request.postData() ?? null;
      try { body = request.postDataJSON(); } catch { /* Keep any non-JSON mutation visible in the test record. */ }
      writes.push({ method: request.method(), path, body });
    }
    const respond = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body)
    });

    if (request.method() === "POST" && path === `/api/v1/campaigns/${campaignId}/generations`) {
      return respond(generationEnqueueResponseSchema.parse({
        id: jobId,
        status: "queued",
        duplicate: false,
        operationKind: "append",
        replacementTurnId: null
      }), 202);
    }
    if (request.method() === "GET" && path === `/api/v1/campaigns/${campaignId}/sync-status`) {
      const recovery = durableRecoveryActive ? generationJobSnapshotSchema.parse({
        id: jobId,
        campaignId,
        expectedTurnNumber: turnCount + 1,
        action: "Follow the quiet platform lights.",
        requestedInputMode: "action",
        resolvedInputMode: "action",
        inputModeSource: "explicit",
        operationKind: "append",
        replacementTurnId: null,
        attempts: 2,
        resultTurnId: null,
        errorCode: "generation_failed",
        errorMessage: "Generation could not be completed.",
        diagnostic: {
          code: "context_evidence_omitted",
          operation: "story_generation",
          action: "adjust_context"
        },
        createdAt: timestamp,
        updatedAt: timestamp,
        partialNarration: "The synthetic lantern still glows before the stream fails.",
        status: "recoverable"
      }) : null;
      return respond({ ...fixture.syncStatus, generationRecovery: recovery });
    }
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${jobId}`) {
      return respond(generationJobSnapshotSchema.parse({
        id: jobId,
        campaignId,
        expectedTurnNumber: turnCount + 1,
        action: "Follow the quiet platform lights.",
        requestedInputMode: "action",
        resolvedInputMode: "action",
        inputModeSource: "explicit",
        operationKind: "append",
        replacementTurnId: null,
        attempts: durableRecoveryActive ? 2 : 1,
        resultTurnId: null,
        errorCode: durableRecoveryActive ? "generation_failed" : null,
        errorMessage: durableRecoveryActive ? "Generation could not be completed." : null,
        ...(durableRecoveryActive ? { diagnostic: {
          code: "context_evidence_omitted",
          operation: "story_generation",
          action: "adjust_context"
        } } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
        partialNarration: null,
        status: durableRecoveryActive ? "recoverable" : "generating"
      }));
    }
    if (request.method() === "GET" && path === `/api/v1/generation-jobs/${jobId}/result`) {
      resultRequestStarted();
      if (holdResult) await resultReleased;
      return respond(generationResultSchema.parse({
        id: jobId,
        status: "completed",
        campaignId,
        expectedTurnNumber: turnCount + 1,
        resultTurnId,
        errorCode: null,
        errorMessage: null,
        turnNumber: turnCount + 1,
        action: "Follow the quiet platform lights.",
        inputMode: "action",
        inputModeSource: "explicit",
        narration: acceptedNarration,
        choices: ["Wait by the station clock."],
        customActionSuggestion: "",
        imagePrompt: "",
        chronicleRetrieval: null,
        modelMetadata: null,
        mechanics: null,
        acceptedAt: timestamp,
        stateSnapshot: {},
        reportedCost: null
      }));
    }

    if (request.method() === "GET" && path === `/api/v1/campaigns/${secondCampaignId}/sync-status`) {
      const syncCampaign = fixture.syncStatus.campaign as Record<string, unknown>;
      return respond({
        ...fixture.syncStatus,
        campaign: { ...syncCampaign, id: secondCampaignId, title: "Fixture Campaign B" },
        turns: { campaignId: secondCampaignId, turns: secondCampaignTurns, nextCursor: null }
      });
    }
    if (request.method() === "GET" && path === `/api/v1/campaigns/${secondCampaignId}/state`) {
      return respond({ ...fixture.runtimeState, campaignId: secondCampaignId });
    }
    return route.fallback();
  });

  const html = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}/story/${campaignId}`);
  await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
  await expect(page.locator("#freeAction")).toBeVisible();
  await page.locator("#freeAction").fill("Follow the quiet platform lights.");
  await page.locator("#btnTakeAction").click();
  await expect.poll(() => page.evaluate(() => window.__storyStreamFixture?.sourceCount() ?? 0)).toBe(1);

  return {
    campaignId,
    secondCampaignId,
    expectedTurnNumber: turnCount + 1,
    jobId,
    resultTurnId,
    acceptedNarration,
    writes,
    waitForResultRequest,
    activateRecoverable: () => { durableRecoveryActive = true; },
    previewTextAtCommit: () => page.evaluate(() => window.__storyStreamFixture?.previewTextAtCommit() ?? null),
    frameWasPendingAtPreviewRemoval: () => page.evaluate(() => window.__storyStreamFixture?.frameWasPendingAtPreviewRemoval() ?? false),
    releaseResult
  };
}

function streamSnapshot(
  harness: StreamHarness,
  partialNarration: string,
  status: GenerationStreamSnapshot["status"] = "generating"
): GenerationStreamSnapshot {
  return generationStreamSnapshotSchema.parse({
    id: harness.jobId,
    campaignId: harness.campaignId,
    expectedTurnNumber: harness.expectedTurnNumber,
    action: "Follow the quiet platform lights.",
    status,
    attempts: status === "recoverable" ? 2 : 1,
    partialNarration,
    resultTurnId: status === "completed" ? harness.resultTurnId : null,
    errorCode: status === "failed" || status === "recoverable" ? "generation_failed" : null,
    errorMessage: status === "failed" || status === "recoverable" ? "Generation could not be completed." : null,
    diagnostic: status === "recoverable" ? {
      code: "context_evidence_omitted",
      operation: "story_generation",
      action: "adjust_context"
    } : null,
    operationKind: "append",
    replacementTurnId: null
  });
}

async function emitSnapshot(page: Page, snapshot: GenerationStreamSnapshot): Promise<void> {
  await page.evaluate(frame => window.__storyStreamFixture?.emit(frame), snapshot);
}

async function waitTwoFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

function expectOnlyGenerationSubmission(harness: StreamHarness): void {
  expect(harness.writes.map(write => `${write.method} ${write.path}`)).toEqual([
    `POST /api/v1/campaigns/${harness.campaignId}/generations`
  ]);
  expect(harness.writes[0]?.body).toMatchObject({ action: "Follow the quiet platform lights." });
}

async function attachStreamScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("rapid cumulative snapshots batch narration DOM writes to one scheduled render", async ({ page }, testInfo) => {
  const harness = await installStreamHarness(page);
  await page.evaluate(() => window.__storyStreamFixture?.resetWriteCount());
  const snapshots = Array.from({ length: 100 }, (_, index) => streamSnapshot(
    harness,
    Array.from({ length: index + 1 }, (_, sentence) => `Synthetic sentence ${sentence + 1}.`).join(" ")
  ));
  await page.evaluate(frames => {
    for (const frame of frames) window.__storyStreamFixture?.emit(frame);
  }, snapshots);
  await waitTwoFrames(page);

  const profile = await page.evaluate(() => ({
    scenario: "100 cumulative contract-valid snapshots emitted synchronously through mocked EventSource",
    measuredOperation: "innerHTML setter calls on .streaming-narration only",
    eventSourceCount: window.__storyStreamFixture?.sourceCount() ?? 0,
    instrumentationReady: window.__storyStreamFixture?.instrumentationReady() ?? false,
    narrationDomWrites: window.__storyStreamFixture?.writeCount() ?? -1,
    activeNarrationText: document.querySelector(".streaming-narration")?.textContent ?? ""
  }));
  const profilePath = testInfo.outputPath("stream-dom-write-profile.json");
  await writeFile(profilePath, JSON.stringify(profile, null, 2), "utf8");
  await testInfo.attach("stream-dom-write-profile", { path: profilePath, contentType: "application/json" });
  await attachStreamScreenshot(page, testInfo, "streaming-partial.png");

  expect(profile.instrumentationReady).toBe(true);
  expect(profile.eventSourceCount).toBe(1);
  expect(profile.activeNarrationText).toContain("Synthetic sentence 100.");
  expect(profile.narrationDomWrites).toBeLessThanOrEqual(1);
  expectOnlyGenerationSubmission(harness);
});

test("the final stream snapshot is flushed exactly before accepted narration replaces its preview", async ({ page }, testInfo) => {
  const finalText = "The final synthetic sentence is delivered immediately before acceptance.";
  const harness = await installStreamHarness(page, 1, finalText, true);
  await emitSnapshot(page, streamSnapshot(harness, "An earlier cumulative snapshot."));
  await waitTwoFrames(page);
  await page.evaluate(() => window.__storyStreamFixture?.holdNextAnimationFrame());
  await emitSnapshot(page, streamSnapshot(harness, finalText, "completed"));
  try {
    await harness.waitForResultRequest;
    await expect(page.locator(".streaming-narration")).toContainText("An earlier cumulative snapshot.");
    await expect(page.locator(".streaming-narration")).not.toContainText(finalText);
    await expect.poll(() => page.evaluate(() => window.__storyStreamFixture?.hasHeldAnimationFrame() ?? false)).toBe(true);
  } finally {
    harness.releaseResult();
  }

  const accepted = page.locator(`#scene-2 .narration`);
  await expect(accepted).toContainText(finalText);
  const previewTextAtCommit = await harness.previewTextAtCommit();
  const frameWasPendingAtPreviewRemoval = await harness.frameWasPendingAtPreviewRemoval();
  expect(previewTextAtCommit).toBe(finalText);
  expect(frameWasPendingAtPreviewRemoval).toBe(true);
  await testInfo.attach("final-flush-before-accept-observation", {
    body: JSON.stringify({
      previewTextAtCommit,
      rendererFrameWasPendingAtPreviewRemoval: frameWasPendingAtPreviewRemoval
    }, null, 2),
    contentType: "application/json"
  });
  await attachStreamScreenshot(page, testInfo, "streaming-final-accepted.png");
  await page.evaluate(() => window.__storyStreamFixture?.releaseHeldAnimationFrame());
  await waitTwoFrames(page);
  await expect(page.locator("#streamingPreviewCard")).toHaveCount(0);
  await expect(accepted).toContainText(finalText);
  expectOnlyGenerationSubmission(harness);
});

test("streaming displays hostile and incomplete markup as text without creating executable nodes", async ({ page }) => {
  const harness = await installStreamHarness(page);
  const hostile = `<img src=x onerror="window.__streamXssExecuted=true"> <script>window.__streamXssExecuted=true</script> <strong>unfinished`;
  await emitSnapshot(page, streamSnapshot(harness, hostile));

  const narration = page.locator(".streaming-narration");
  await expect(narration).toContainText(hostile);
  await expect(narration.locator("img, script, strong")).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __streamXssExecuted?: boolean }).__streamXssExecuted)).toBeUndefined();
  expectOnlyGenerationSubmission(harness);
});

test("manual wheel scrolling pauses auto-follow until the reader resumes it", async ({ page }, testInfo) => {
  const harness = await installStreamHarness(page, 40);
  const longPassage = Array.from({ length: 45 }, (_, index) => `Synthetic paragraph ${index + 1} extends the same live narration beyond the viewport.`).join("\n");
  await emitSnapshot(page, streamSnapshot(harness, longPassage));
  const followButton = page.getByRole("button", { name: "Resume following live narration", exact: true });
  await expect(followButton).toBeHidden();
  const beforeManualWheel = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 700);
  await expect(followButton).toBeVisible();
  const pausedScrollY = await page.evaluate(() => window.scrollY);
  expect(pausedScrollY).toBeGreaterThan(beforeManualWheel);

  const pausedUpdate = `${longPassage}\nA later update arrives while manual reading is paused.`;
  await emitSnapshot(page, streamSnapshot(harness, pausedUpdate));
  await expect(page.locator(".streaming-narration")).toContainText("manual reading is paused");
  await waitTwoFrames(page);
  expect(await page.evaluate(() => window.scrollY)).toBe(pausedScrollY);

  await followButton.click();
  await expect(followButton).toBeHidden();
  await emitSnapshot(page, streamSnapshot(harness, `${pausedUpdate}\nFollowing resumes for this synthetic update.`));
  await expect(page.locator(".streaming-narration")).toContainText("Following resumes");
  await waitTwoFrames(page);
  const followedCursor = await page.locator(".streaming-cursor").evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight };
  });
  expect(followedCursor.top).toBeLessThan(followedCursor.viewportHeight);
  expect(followedCursor.bottom).toBeGreaterThanOrEqual(0);
  await attachStreamScreenshot(page, testInfo, "streaming-manual-follow.png");
  expectOnlyGenerationSubmission(harness);
});

test("an unrecoverable stream keeps the prior accepted scene and explicit recovery controls", async ({ page }, testInfo) => {
  const harness = await installStreamHarness(page);
  const lastNarration = "The synthetic lantern still glows before the stream fails.";
  await emitSnapshot(page, streamSnapshot(harness, lastNarration));
  harness.activateRecoverable();
  await emitSnapshot(page, streamSnapshot(harness, lastNarration, "recoverable"));

  await expect(page.locator("#generationRecoveryPanel")).toBeVisible();
  await expect(page.locator("#btnRetryGeneration")).toBeVisible();
  const retainedPrompt = await page.evaluate(campaignId => {
    const key = `infiniteQuestFailedAppendPrompt:v1:${encodeURIComponent(campaignId)}`;
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw) as unknown;
  }, harness.campaignId);
  expect(retainedPrompt).toMatchObject({
    campaignId: harness.campaignId,
    expectedTurnNumber: 2,
    generationId: harness.jobId,
    action: "Follow the quiet platform lights."
  });
  await expect(page.locator("#streamingPreviewCard")).toHaveCount(0);
  await expect(page.locator("#scene-1 .narration")).toContainText("The synthetic station remains quiet in scene 1");
  await expect(page.locator("#scene-1 .narration")).not.toContainText(lastNarration);
  await attachStreamScreenshot(page, testInfo, "streaming-terminal-recovery.png");
  expectOnlyGenerationSubmission(harness);
});

test("a late campaign A stream callback cannot paint over same-document campaign B", async ({ page }, testInfo) => {
  const harness = await installStreamHarness(page);
  const queuedA = streamSnapshot(harness, "A-only late synthetic narration.");
  await page.evaluate(() => window.__storyStreamFixture?.resetWriteCount());
  await page.evaluate(() => window.__storyStreamFixture?.holdNextAnimationFrame());
  await emitSnapshot(page, queuedA);
  const frameWasPendingForA = await page.evaluate(() => window.__storyStreamFixture?.hasHeldAnimationFrame() ?? false);
  const narrationBeforeCampaignChange = await page.locator(".streaming-narration").textContent();
  const narrationWritesBeforeCampaignChange = await page.evaluate(() => window.__storyStreamFixture?.writeCount() ?? -1);
  expect(frameWasPendingForA).toBe(true);
  expect(narrationBeforeCampaignChange).not.toContain("A-only late synthetic narration.");
  expect(narrationWritesBeforeCampaignChange).toBe(0);

  await page.evaluate(id => {
    window.history.replaceState(null, "", `/story/${id}`);
    document.dispatchEvent(new Event("DOMContentLoaded"));
  }, harness.secondCampaignId);
  await expect(page.locator("#storyTitle")).toHaveText("Fixture Campaign B");
  await page.evaluate(() => window.__storyStreamFixture?.releaseHeldAnimationFrame());
  await page.evaluate(frame => window.__storyStreamFixture?.forceLateTo(0, frame), queuedA);
  await waitTwoFrames(page);

  const campaignBScene = page.locator("#scene-1");
  await expect(campaignBScene.locator(".narration")).toContainText("Campaign B synthetic scene 1 remains visible after A changes.");
  await expect(campaignBScene).toHaveAttribute("data-turn-id", "20000000-0000-4000-8000-000000000001");
  await expect(page.locator(".streaming-narration")).toHaveCount(0);
  await expect(page.getByText("A-only late synthetic narration.", { exact: false })).toHaveCount(0);
  await testInfo.attach("campaign-change-buffer-observation", {
    body: JSON.stringify({ rendererFrameWasPendingBeforeCampaignChange: frameWasPendingForA }, null, 2),
    contentType: "application/json"
  });
  expectOnlyGenerationSubmission(harness);
});
