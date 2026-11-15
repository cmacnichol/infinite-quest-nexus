import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";
import { tabTo } from "./helpers/keyboard.js";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { chromium, expect, test, type Page, type Route, type Locator } from "@playwright/test";

import { resolve } from "node:path";

const campaignId = "11111111-1111-4111-8111-111111111111";
const worldId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
const protagonistId = "66666666-6666-4666-8666-666666666666";
const candidateId = "88888888-8888-4888-8888-888888888888";
const screenshotRoot = process.env.CAST_SCREENSHOT_ROOT;

async function openTrackingTools(dialog: Locator) {
  const details = dialog.locator(".cast-roster-tools");
  if (await details.count() && !await details.evaluate(el => (el as HTMLDetailsElement).open)) await details.locator("summary").click();
}

async function selectEditorSection(dialog: Locator, id: string) {
  await expect(dialog.locator(".character-workspace")).toBeVisible();
  const selector = dialog.getByRole("combobox", { name: "Section", exact: true });
  if (await selector.isVisible()) await selector.selectOption(id);
  else { const labels: Record<string, string> = { situation: "Current situation", sources: "Sources and history", identity: "Identity", overview: "Overview", personality: "Personality and voice" }; await dialog.getByRole("navigation", { name: "Character sections" }).getByRole("button", { name: new RegExp("^" + labels[id] + " ·") }).click(); }
}

async function openReview(dialog: Locator) {
  if (await dialog.getAttribute("id") === "campaignCastDialog") {
    await dialog.getByRole("button", { name: /^Needs attention(?: \(\d+\))?$/ }).click();
    await expect(dialog.getByText("Loading identity questions…")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Review identity questions and details", exact: true }).click();
  } else await dialog.getByRole("button", { name: "Review character changes", exact: true }).click();
}

async function recoveryWorkspace(page: Page, kind: "forward" | "scan") {
  await page.route("**/cast/workspace-status", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    revision: 0, boundary: { turnNumber: 1, timelineRevision: 0 }, capabilities: { editing: true, discovery: true, autoMatch: true, backfill: true, context: true },
    contextDisabledReason: null, counts: { identities: 0, details: 0, conflicts: 0 },
    tracking: { enabled: true, state: "failed", activeTurnNumber: 1, coverageStartTurn: 1, trackedThroughTurn: 0, unresolvedCount: 0,
      firstGap: { turnNumber: 1, jobId: candidateId, status: "failed", diagnosticCode: "provider_timeout" } },
    recovery: { kind, turnNumber: 1, jobId: candidateId, scanId: kind === "scan" ? candidateId : null, scanStatus: kind === "scan" ? "failed" : null }
  }) }));
}

for (const width of [1280, 390]) test(`legacy previews and controls an explicit history scan at ${width}px`, async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: { text: string; url: string }[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push({ text: message.text(), url: message.location().url }); });
  await page.setViewportSize({ width, height: 1000 });
  await fixture(page);
  let scan: any = null;
  const starts: any[] = [];
  const boundary = { turnNumber: 1, timelineRevision: 0 };
  await page.route("**/cast/scans**", async route => {
    const path = new URL(route.request().url()).pathname;
    const send = (value: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (path.endsWith("/preview")) return send({ fromTurn: 1, throughTurn: 1, boundary, turnCount: 1, estimatedChunkRequests: 1,
      completedChunkReceipts: 0, completedTurns: 0, manualScanTurns: [], providerProfileId: versionId, selection: { kind: "model", modelId: "fixture-model" } });
    if (route.request().method() === "GET") return send({ scan, capabilities: { castBackfill: true } });
    if (path.endsWith("/scans")) {
      starts.push(route.request().postDataJSON());
      scan = { id: candidateId, fromTurn: 1, throughTurn: 1, completeTurns: 0, failedTurns: 0, firstFailedTurn: null, pendingReviewCount: 0, status: "queued" };
    } else scan.status = path.endsWith("/pause") ? "paused" : path.endsWith("/resume") ? "queued" : "cancelled";
    return send(scan);
  });
  await open(page);
  await expect(page).toHaveURL(new RegExp(`/story/${campaignId}$`));
  const dialog = page.locator("#campaignCastDialog");
  await openTrackingTools(dialog);
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/roster-${width}.png` });
  await dialog.getByRole("button", { name: "Scan earlier story", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Start scan", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Preview scan", exact: true }).click();
  await expect(dialog).toContainText("fixture-model");
  await expect(dialog).toContainText("1 estimated request");
  expect(starts).toEqual([]);
  if (screenshotRoot) await page.screenshot({ path: `${screenshotRoot}/scan-preview-${width}.png`, fullPage: true });
  await dialog.getByRole("button", { name: "Start scan", exact: true }).click();
  await expect(dialog).toContainText("0 of 1 turns complete");
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ fromTurn: 1, throughTurn: 1, expectedBoundary: boundary });
  await dialog.getByRole("button", { name: "Pause scan", exact: true }).click();
  await expect(dialog).toContainText("Scan paused");
  await dialog.getByRole("button", { name: "Resume scan", exact: true }).click();
  await expect(dialog).toContainText("Scan queued");
  await dialog.getByRole("button", { name: "Cancel scan", exact: true }).click();
  await expect(dialog).toContainText("Scan cancelled");
  await expect(dialog).toContainText("keeps characters already discovered");
  if (screenshotRoot) await page.screenshot({ path: `${screenshotRoot}/scan-cancelled-${width}.png`, fullPage: true });
  expect(pageErrors).toEqual([]);
  // The isolated Vite fixture does not copy the optional PhotoSwipe stylesheet.
  expect(consoleErrors.filter(error => !(error.url.endsWith("/vendor/photoswipe/photoswipe.css")
    && error.text === "Failed to load resource: the server responded with a status of 404 (Not Found)"))).toEqual([]);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
});

for (const surface of ["legacy", "next"]) test(`history scan updates progress and automatic jobs without refresh on ${surface}`, async ({ page }) => {
  await fixture(page);
  const scan = { id: candidateId, fromTurn: 1, throughTurn: 1, completeTurns: 0, failedTurns: 0, pendingReviewCount: 0, status: "running" };
  const jobs = { queued: 8, runningTurn: 9 as number | null, retryWait: 1, failed: 2, complete: 4 };
  await page.route("**/cast/discovery", route => route.fulfill({ json: {
    enabled: true, activeTurnNumber: 16, coverageStartTurn: 1, trackedThroughTurn: 0, state: "catching_up",
    unresolvedCount: 0, firstGap: null, automaticJobs: jobs
  } }));
  await page.route("**/cast/scans**", route => route.fulfill({ json: route.request().url().endsWith("/scans")
    ? { scan, capabilities: { castBackfill: true } } : scan }));
  if (surface === "legacy") await open(page);
  else {
    await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`);
    await page.locator("[data-campaign-tools] summary").click();
    await page.locator("[data-tool-action='open-characters']").click();
  }
  const dialog = page.locator(surface === "legacy" ? "#campaignCastDialog" : "dialog.characters-workspace");
  await openTrackingTools(dialog);
  await dialog.getByRole("button", { name: "Scan earlier story", exact: true }).click();
  await expect(dialog).toContainText("processing turn 9");
  await expect(dialog).toContainText("8 queued · 1 waiting to retry · 2 failed · 4 complete");
  await expect(dialog).toContainText("Scan running");
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/live-scan-${surface}.png` });
  jobs.runningTurn = null;
  jobs.complete++;
  scan.status = "complete";
  scan.completeTurns = 1;
  await expect(dialog).toContainText("1 of 1 turns complete");
  await expect(dialog).toContainText("no turn running");
  await expect(dialog).toContainText("5 complete");
});

test("legacy retains a failed scan retry key and keeps cancellation available after capability loss", async ({ page }) => {
  const fixtureApi = await fixture(page);
  let enabled = true;
  const scan = { id: candidateId, fromTurn: 1, throughTurn: 1, completeTurns: 0, failedTurns: 1, firstFailedTurn: 1, pendingReviewCount: 2, status: "failed" };
  const retries: any[] = [];
  await page.route("**/cast/scans**", route => {
    const path = new URL(route.request().url()).pathname;
    const send = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (route.request().method() === "GET") return send({ scan, capabilities: { castBackfill: enabled } });
    if (path.endsWith("/retry")) {
      retries.push(route.request().postDataJSON());
      return send({ code: "cast_discovery_unavailable", error: "CampaignCastError", message: "Unavailable", correlationId: "fixture", details: {} }, 503);
    }
    scan.status = "cancelled"; return send(scan);
  });
  await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await openTrackingTools(dialog);
  await dialog.getByRole("button", { name: "Scan earlier story", exact: true }).click();
  await expect(dialog).toContainText("2 character matches need review");
  const retry = dialog.getByRole("button", { name: "Retry turn 1", exact: true });
  await openTrackingTools(dialog);
  await retry.click(); await expect(dialog).toContainText("Could not update the scan");
  await openTrackingTools(dialog);
  await retry.click(); await expect(dialog).toContainText("Could not update the scan");
  expect(retries).toHaveLength(2); expect(retries[0]).toEqual(retries[1]);
  enabled = false;
  fixtureApi.trackingUnavailable();
  await dialog.getByRole("button", { name: "Refresh scan", exact: true }).click();
  await expect(retry).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel scan", exact: true }).click();
  await expect(dialog).toContainText("Scan cancelled");
});

test("legacy discovery retry requires refresh after conflict and respects editing capability loss", async ({ page }) => {
  const api = await fixture(page);
  await recoveryWorkspace(page, "forward");
  let requests = 0;
  await page.route("**/cast/discovery", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    enabled: true, state: "failed", activeTurnNumber: 1, coverageStartTurn: 1, trackedThroughTurn: 0, unresolvedCount: 0,
    firstGap: { turnNumber: 1, jobId: candidateId, status: "failed", diagnosticCode: "provider_failed" }
  }) }));
  await page.route(`**/cast/discovery/${candidateId}/retry`, (route) => {
    requests++;
    return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "cast_revision_conflict",
      error: "CampaignCastError", message: "Conflict", correlationId: "fixture", details: {} }) });
  });
  await open(page);
  const dialog = page.locator("#campaignCastDialog"), retry = dialog.getByRole("button", { name: "Retry character tracking", exact: true });
  await openTrackingTools(dialog);
  await retry.click(); await expect(retry).toBeDisabled();
  await expect(dialog).toContainText("Refresh characters before retrying");
  if (screenshotRoot) await page.screenshot({ path: `${screenshotRoot}/retry-conflict-desktop.png`, fullPage: true });
  await openTrackingTools(dialog);
  await dialog.getByRole("button", { name: "Refresh characters", exact: true }).click(); await expect(retry).toBeEnabled();
  api.disable();
  await openTrackingTools(dialog);
  await dialog.getByRole("button", { name: "Refresh characters", exact: true }).click(); await expect(retry).toBeDisabled();
  expect(requests).toBe(1);
});

test("legacy retries character discovery only and retains the request key after a recovery failure", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await recoveryWorkspace(page, "forward");
  let queued = false;
  const retries: any[] = [], storyWrites: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && !request.url().includes("/cast/")) storyWrites.push(request.url()); });
  await page.route(`**/cast/discovery`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    enabled: true, state: queued ? "catching_up" : "failed", activeTurnNumber: 1, coverageStartTurn: 1, trackedThroughTurn: 0, unresolvedCount: 0,
    firstGap: { turnNumber: 1, jobId: candidateId, status: queued ? "queued" : "failed", diagnosticCode: queued ? null : "admission_unavailable" }
  }) }));
  await page.route(`**/cast/discovery/${candidateId}/retry`, (route) => {
    retries.push(route.request().postDataJSON());
    if (retries.length === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "cast_discovery_unavailable", error: "CampaignCastError", message: "Unavailable", correlationId: "fixture", details: {} }) });
    queued = true;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ jobId: candidateId, retryGeneration: 1 }) });
  });
  await open(page);
  const dialog = page.locator("#campaignCastDialog"), retry = dialog.getByRole("button", { name: "Retry character tracking", exact: true });
  await expect(dialog).toContainText("Your story is saved");
  await openTrackingTools(dialog);
  await retry.click(); await expect(dialog).toContainText("Check the text provider settings");
  if (screenshotRoot) await page.screenshot({ path: `${screenshotRoot}/retry-recovery-390.png`, fullPage: true });
  await openTrackingTools(dialog);
  await retry.click(); await expect(dialog).toContainText("Character tracking is catching up");
  expect(retries).toHaveLength(2); expect(retries[0]).toEqual(retries[1]);
  expect(retries[0]).toMatchObject({ expectedCastRevision: 0, expectedBoundary: { turnNumber: 1, timelineRevision: 0 } });
  expect(storyWrites).toEqual([]);
  await expect(retry).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("#storyArea")).toContainText("Mara waits at the gate");
});

for (const width of [1280, 390]) test(`legacy filters handled identities from matches at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const api = await fixture(page, true);
  await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await openReview(dialog);
  if (width === 390) {
    await dialog.getByLabel("Existing character", { exact: true }).selectOption(protagonistId);
    await dialog.getByRole("button", { name: "Attach to selected character", exact: true }).click();
  } else await dialog.getByRole("button", { name: "Create separate character", exact: true }).click();
  await expect(dialog).toContainText("Proposed: gatekeeper");
  await expect(dialog.getByRole("button", { name: "Create separate character", exact: true })).toHaveCount(0);
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/filtered-matches-${width}.png` });
  expect(api.writes).toHaveLength(1);
});

test("legacy match targets are independent of the roster search", async ({ page }) => {
  await fixture(page);
  await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await dialog.getByLabel("Find a character", { exact: true }).fill("No such character");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  await expect(dialog).toContainText("No characters match this search.");
  await openReview(dialog);
  const select = dialog.getByLabel("Existing character", { exact: true });
  await expect(select.locator(`option[value="${protagonistId}"]`)).toHaveCount(1);
  await select.selectOption(protagonistId);
  await expect(dialog.getByRole("button", { name: "Attach to selected character", exact: true })).toBeEnabled();
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/unfiltered-match-targets.png` });
});

for (const surface of ["legacy", "next"] as const) test(`supporting editor keeps optional controls contextual ${surface}`, async ({ page }) => {
  const api = await fixture(page);
  api.characters.push({ id: candidateId, name: "Mara", aliases: [], origin: { kind: "manual" }, profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 1, lastObservedTurn: 1 });
  if (surface === "legacy") await open(page);
  else {
    await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`);
    await page.locator("[data-campaign-tools] summary").click();
    await page.locator("[data-tool-action='open-characters']").click();
  }
  const dialog = surface === "legacy" ? page.locator("#campaignCastDialog") : page.locator("dialog.characters-workspace");
  await dialog.getByRole("button", { name: "Add character", exact: true }).click();
  await expect(dialog.getByLabel("Role", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("Only a name is required");
  await expect(dialog.getByRole("button", { name: /Use discovered value/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.getByRole("button", { name: "Mara", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit character", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /Use discovered value/ })).toHaveCount(0);
  await expect(dialog).toContainText("Pin prioritizes this character");
  await dialog.getByLabel("Role", { exact: true }).fill("Guide");
  await dialog.getByRole("button", { name: "Use discovered value for role", exact: true }).click();
  await expect(dialog).toContainText("Will use the discovered value after saving.");
  await expect(dialog.getByRole("button", { name: "Use discovered value for role", exact: true })).toHaveCount(0);
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/simplified-supporting-${surface}.png` });
});

test("replacement cast recovers a new character draft after a revision conflict", async ({ page }) => {
  const api = await fixture(page);
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`);
  await page.locator("[data-campaign-tools] summary").click();
  await page.locator("[data-tool-action='open-characters']").click();
  const dialog = page.locator("dialog.characters-workspace");
  await dialog.getByRole("button", { name: "Add character", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("New guide");
  api.conflict();
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await dialog.getByRole("button", { name: "Compare latest", exact: true }).click();
  await expect(dialog).toContainText("Your new character has not been saved.");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("New guide");
  await dialog.getByRole("button", { name: "Reapply my changes", exact: true }).click();
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Edit character", exact: true })).toBeVisible();
  expect(api.characters.filter(person => person.name === "New guide")).toHaveLength(1);
});

async function fixture(page: Page, deferredDetails = false, conflictFixture = false, presetFixture = false, applyFixture = false, seededFixture = false, deepLink = false, eligible = false, reviewFixture = false, observationFixture = false) {
  let stalePreset = presetFixture;
  let liveLock = false;
  let revision = 0, enabled = true, conflict = false, trackingComplete = false, trackingUnavailable = false, pendingMatch = true;
  let reviewDismissed = false; let reviewRevision = 0; let retracted = false; let sourceInvalid = false;
  let resolvedCharacterId: string | undefined;
  const characters: any[] = [{ id: protagonistId, name: "Iven", aliases: [], origin: { kind: "protagonist", selectedCharacterId: null },
    profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 0, lastObservedTurn: 1 }];
  if (conflictFixture) characters.push({ id: candidateId, name: "Mara", aliases: [], origin: { kind: "manual" }, profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 1, lastObservedTurn: 1 });
  if (seededFixture) {
    const person = characters.find(item => item.id === candidateId)!;
    person.originProfile = { seedEventId: protagonistId, worldVersionId: versionId, entityId: "world-scout", rosterName: "Mara", rosterAliases: [], legacyCharacterText: "", profile: { story: { role: "Guide", goals: "Find home" } }, evidence: { kind: "world", worldVersionId: versionId, sourcePath: "/playableCharacters/0" } };
    person.campaignProfile = { story: { role: "Captain", personality: "Patient", goals: "Find home" } };
    person.fieldSources = { "story.role": "campaign_edit", "story.personality": "campaign_edit", "story.goals": "authored" };
  }
  const overrides = new Map<string, Record<string, string>>();
  const writes: any[] = [], profileWrites: any[] = [];
  const campaign = { id: campaignId, title: "Cast fixture", status: "active", activeTurnNumber: 1, createdAt: "2026-09-16T12:00:00.000Z", updatedAt: "2026-09-16T12:00:00.000Z", worldId, worldTitle: "Fixture world",
    worldVersionId: versionId, worldVersionNumber: 1, latestWorldVersionNumber: 1, worldUpdateAvailable: false,
    selectedCharacterId: null, selectedCharacterName: "", characterSnapshot: null, characterProfile: null,
    characterProfileRevision: 0, storyLengthProfile: "standard", storyContextBudgetTokens: 32000,
    turnControlStyle: "flexible_action", textProviderProfileId: null, imageProviderProfileId: null, costInformation: [] };
  const turn = { id: "55555555-5555-4555-8555-555555555555", turnNumber: 1, action: "Look around.", narration: "Mara waits at the gate.",
    inputMode: "action", inputModeSource: "explicit", choices: [], customActionSuggestion: "", imagePrompt: "", imageUrl: null,
    acceptedAt: "2026-09-16T12:00:00.000Z", chronicleRetrieval: null, reportedCost: null };
  const boundary = { turnNumber: 1, timelineRevision: 0 };
  const send = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path.includes("/cast")) {
      const id = path.split("/cast/")[1];
      if (seededFixture && id === `${candidateId}/authored-profile` && request.method() === "POST") {
        const input = request.postDataJSON(); writes.push(input);
        if (conflict) { conflict = false; revision++; return send(route, { code: "cast_revision_conflict" }, 409); }
        const person = characters.find(item => item.id === candidateId)!; revision++; person.revision++;
        return send(route, { character: person, revision, boundary });
      }
      if (presetFixture && id === "from-world" && request.method() === "GET") return send(route, { characters: [{ characterId: "world-scout", name: "Scout", alwaysInContext: true }] });
      if (presetFixture && id === "from-world-preview") return send(route, { worldVersionId: versionId, characterId: "world-scout", eligibleTargets: applyFixture ? [{ id: candidateId, name: "Mara", revision: 0 }] : [], ...(applyFixture && url.searchParams.has("targetCastCharacterId") ? { targetCastCharacterId: candidateId, characterRevision: 0 } : {}), castRevision: revision, boundary, choices: [], changes: [{ path: "identity", old: null, proposed: { name: "Scout", aliases: [] }, effect: "create" }], previewFingerprint: "a".repeat(64) });
      if (presetFixture && id === "from-world" && request.method() === "POST") {
        if (stalePreset) { stalePreset = false; return send(route, { code: "cast_revision_conflict", message: "Changed" }, 409); }
        const person = applyFixture ? characters.find((item) => item.id === candidateId) : { id: candidateId, name: "Scout", aliases: [], profile: {}, origin: { kind: "manual" }, pinned: true, ignored: false, revision: 1, firstObservedTurn: 1, lastObservedTurn: 1 };
        if (!applyFixture) characters.push(person); revision++; return send(route, { character: person, revision, boundary });
      }
      if (id === "context-preview") return send(route, { mode: "estimate", boundary, castRevision: revision, budgetTokens: 500, usedTokens: 25, coverage: { fromTurn: 1, throughTurn: 1, baseTurn: 1, current: true }, selected: [{ characterId: protagonistId, name: "Iven", reason: "pinned" }], omitted: [{ characterId: candidateId, reason: "budget" }], disabledReason: null });
      if (id === "workspace-status") return send(route, { revision, boundary, capabilities: { editing: enabled, discovery: true, autoMatch: true, backfill: true, context: true, ...(reviewFixture ? { reviewDecisions: true, reviewDecisionReadVersion: 1 } : {}), ...(observationFixture ? { observationDecisions: true } : {}) }, contextDisabledReason: null, counts: { identities: pendingMatch ? 1 : 0, details: 0, conflicts: 1 }, tracking: { enabled: true, state: trackingComplete ? "complete" : "catching_up", activeTurnNumber: 1, coverageStartTurn: 1, trackedThroughTurn: trackingComplete ? 1 : 0, unresolvedCount: pendingMatch ? 1 : 0, firstGap: trackingComplete ? null : { turnNumber: 1, jobId: null, status: "missing", diagnosticCode: null } } });
      if (id === "discovery") return trackingUnavailable ? send(route, {}, 503) : send(route, {
        enabled: true, state: trackingComplete ? "complete" : "catching_up", activeTurnNumber: 1,
        coverageStartTurn: 1, trackedThroughTurn: trackingComplete ? 1 : 0, unresolvedCount: pendingMatch ? 1 : 0,
        firstGap: trackingComplete ? null : { turnNumber: 1, jobId: null, status: "missing", diagnosticCode: null } });
      if (reviewFixture && id === "review-decisions") return send(route, { revision, boundary, reviewRevision, nextCursor: null, decisions: reviewDismissed ? [{ decisionId: versionId, candidateId, canRestore: true, source: { scope: { campaignId, ownerUserId: worldId }, turnId: turn.id, turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), timelineRevision: 0, paragraphs: [{ id: "p1", text: turn.narration }] }, target: { kind: "identity", proposal: { localKey: "mara", name: "Mara", aliases: [], existingCharacterId: null, identityEvidence: [{ paragraphId: "p1", quote: turn.narration }], observations: [] } } }] : [] });
      if (reviewFixture && id === `candidates/${candidateId}/review-decisions`) { const input = request.postDataJSON(); writes.push(input); reviewDismissed = input.action !== "restore"; reviewRevision++; return send(route, { decisionId: versionId, candidateId, reviewRevision, revision, boundary, disposition: input.action }); }
      if (id === "candidates") return send(route, { revision, boundary, nextCursor: null, candidates: pendingMatch && !reviewDismissed && !(url.searchParams.get("view") === "matches" && resolvedCharacterId) ? [{ id: candidateId,
        ...(resolvedCharacterId ? { resolvedCharacterId, details: [{ observationIndex: 0, field: "story.role", value: "gatekeeper", quote: turn.narration, reason: "claim_not_fact", sourceHash: "a".repeat(64) }] } : {}),
        reason: "identity_needs_review", ...(reviewFixture ? { reviewRevision, reviewDetails: [] } : {}), proposal: { localKey: "mara", name: "Mara", aliases: [], existingCharacterId: null,
          identityEvidence: [{ paragraphId: "p1", quote: turn.narration }], observations: deferredDetails ? [{ field: "story.role", value: "gatekeeper",
            mode: "fact", speakerCharacterId: null, paragraphId: "p1", quote: turn.narration }] : [] },
        source: { turnId: turn.id, turnNumber: 1, narrationRevision: 0, ...(reviewFixture ? { sourceHash: "a".repeat(64) } : {}) } }] : [] });
      if (id === `candidates/${candidateId}/resolve`) {
        const input = request.postDataJSON(); writes.push(input);
        if (!enabled) return send(route, { code: "cast_editing_disabled" }, 503);
        if (input.expectedCastRevision !== revision) return send(route, { code: "cast_revision_conflict" }, 409);
        revision++; pendingMatch = deferredDetails;
        const person = input.action === "attach" ? characters.find((p) => p.id === input.characterId) : {
          id: crypto.randomUUID(), name: "Mara", aliases: [], profile: {}, origin: { kind: "discovered" },
          pinned: false, ignored: false, revision: 1, firstObservedTurn: 1, lastObservedTurn: 1 };
        if (input.action === "create") characters.push(person);
        resolvedCharacterId = person.id;
        return send(route, { candidateId, character: person, revision, boundary, observationIds: [],
          ...(deferredDetails ? { pendingObservations: [{ index: 0, reason: "claim_not_fact" }] } : {}) });
      }
      if (observationFixture && id?.startsWith(`characters/${candidateId}/observations/`)) {
        const observation = { id: protagonistId, characterId: candidateId, field: "story.role", value: "guide", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId: turn.id, turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", quote: turn.narration } };
        if (id.endsWith("decision-preview")) return send(route, { field: observation.field, currentValue: retracted ? null : "guide", projectedValue: retracted ? "guide" : null, currentConflict: false, projectedConflict: false, source: observation, castRevision: revision, characterRevision: 0, boundary });
        const input = request.postDataJSON(); writes.push(input); retracted = input.action === "retract";
        return send(route, { character: characters.find(c => c.id === candidateId), revision, boundary, observationId: protagonistId, decisionEventId: versionId, disposition: retracted ? "retracted" : "restored" });
      }
      if (request.method() !== "GET") {
        const input = request.postDataJSON(); writes.push(input);
        if (!enabled) return send(route, { code: "cast_editing_disabled" }, 503);
        if (conflict) { conflict = false; revision++; return send(route, { code: "cast_revision_conflict" }, 409); }
        if (input.expectedCastRevision !== revision) return send(route, { code: "cast_revision_conflict" }, 409);
        revision++;
        let person = characters.find((c) => c.id === id);
        if (!person) { person = { id: crypto.randomUUID(), name: input.name, aliases: input.aliases, profile: input.profile,
          origin: { kind: "manual" }, pinned: false, ignored: false, revision: 1, firstObservedTurn: 1, lastObservedTurn: 1 }; characters.push(person); overrides.set(person.id, { ...input.profile }); }
        else {
          for (const key of ["name", "aliases", "pinned", "ignored"]) if (key in input) person[key] = input[key];
          const current = overrides.get(id!) ?? {}; Object.assign(current, input.setOverrides ?? {});
          for (const field of input.clearOverrides ?? []) delete current[field]; overrides.set(id!, current);
          person.profile = { "appearance.description": "blue eyes", ...current }; person.revision++;
        }
        return send(route, { character: person, revision, boundary }, id ? 200 : 201);
      }
      if (id) {
        const person = characters.find((c) => c.id === id);
        if (observationFixture && id === candidateId) return send(route, { character: person, revision, boundary, capabilities: { castEditing: true, castObservationDecisions: true }, observations: sourceInvalid ? [] : [{ id: protagonistId, characterId: candidateId, field: "story.role", value: "guide", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId: turn.id, turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", quote: turn.narration } }], observationDecisionStatus: [{ observationId: protagonistId, state: sourceInvalid ? "read_only" : retracted ? "retracted" : "eligible", retractionEventId: retracted ? versionId : null, reason: sourceInvalid ? "source_invalid" : null }], retractedObservationHistory: sourceInvalid ? [{ id: protagonistId, characterId: candidateId, field: "story.role", value: "guide", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId: turn.id, turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", quote: turn.narration } }] : [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], editorDestination: null });
        if (conflictFixture && id === candidateId) return send(route, { character: person, draftFromStoryEligible: eligible, revision, boundary, capabilities: { castEditing: enabled }, observations: ["guide", "guard"].map((value, index) => ({ id: index ? "77777777-7777-4777-8777-777777777778" : "77777777-7777-4777-8777-777777777777", characterId: id, field: "story.role", value, mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId: turn.id, turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", quote: turn.narration } })), overrides: [], identityEvents: [], unresolvedCandidateIds: [], editorDestination: null });
        return send(route, { character: person, revision, boundary, capabilities: { castEditing: enabled, ...(reviewFixture ? { castLifecycle: false } : {}) }, observations: id === protagonistId ? [] : [{
          id: "77777777-7777-4777-8777-777777777777", characterId: id, field: "story.role", value: "gatekeeper", mode: "claim",
          speakerCharacterId: protagonistId, supersedesObservationId: null,
          evidence: { kind: "turn", turnId: turn.id, turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", quote: turn.narration }
        }],
          overrides: Object.entries(overrides.get(id) ?? {}).map(([field, value]) => ({ field, value, evidence: { kind: "user", editId: protagonistId, effectiveTurnNumber: 1 } })),
          identityEvents: [], unresolvedCandidateIds: [], editorDestination: id === protagonistId ? `/api/v1/campaigns/${campaignId}/character-profile` : null });
      }
      const query = url.searchParams.get("query")?.toLowerCase() ?? "";
      const matches = characters.filter((c) => (url.searchParams.get("filter") !== "conflicts" || c.id === (conflictFixture ? candidateId : protagonistId)) && [c.name, ...c.aliases].some((name: string) => name.toLowerCase().includes(query)));
      const cursor = url.searchParams.get("cursor"), offset = cursor ? matches.findIndex((person) => person.id === cursor) + 1 : 0;
      const page = matches.slice(offset, offset + 2);
      return send(route, { revision, boundary, characters: page, attention: page.filter((person) => person.id === protagonistId).map((person) => ({ characterId: person.id, review: true, conflict: true, reviewCount: 2, conflictCount: 1 })),
        nextCursor: offset + page.length < matches.length ? page.at(-1).id : null, capabilities: { castEditing: enabled, castPresets: presetFixture, ...(observationFixture ? { castObservationDecisions: true } : {}), ...(reviewFixture ? { castReviewDecisions: true, castReviewDecisionReadVersion: 1 } : {}) } });
    }
    if (path === "/api/v1/session") return send(route, { user: { id: worldId, displayName: "Fixture owner", settings: { autoSubmitTurnChoices: true, continuousReading: false, defaultTurnControlStyle: "flexible_action" } }, authentication: "deferred" });
    if (path === "/api/v1/meta") return send(route, { application: { name: "Nexus", version: "test", commit: null, builtAt: null }, capabilities: { castEditing: enabled, systemArchive: false } });
    if (path === "/api/v1/providers") return send(route, { providers: [{ id: versionId, name: "Fixture text", providerType: "openai_compatible", providerRole: "text", enabled: true, isDefault: true }] });
    if (path === "/api/v1/campaigns") return send(route, { campaigns: [campaign] });
    if (path.endsWith("/sync-status")) return send(route, { ...campaign, campaign, world: { id: worldId, title: "Fixture world", versionNumber: 1, genre: "test", tone: "quiet", premise: "Fixture premise", backgroundStory: "", character: "Iven", firstAction: "Look around.", rules: "", playableCharacters: [] }, playerConfig: { selectedCharacterId: null, selectedCharacterName: "", characterSnapshot: null, characterProfile: null, characterProfileRevision: 0, rpgStats: [], trackers: [], eventTriggers: [], useRpgStats: false, suppressEventTriggers: false }, pendingGeneration: liveLock ? { id: candidateId, status: "generating", action: "Look", expectedTurnNumber: 2, createdAt: "2026-09-16T12:00:00.000Z", updatedAt: "2026-09-16T12:00:00.000Z", operationKind: "append", replacementTurnId: null } : null, generationRecovery: null, syncToken: "fixture-1", turnWindowMode: "replace", turns: { campaignId, turns: [turn], nextCursor: null } });
    if (path.endsWith("/turns")) return send(route, { campaignId, turns: [turn], nextCursor: null });
    if (path.endsWith("/state")) return send(route, { campaignId, activeTurnNumber: 1, revision: 1, viewedTurnNumber: 1, isCurrent: true, updatedAt: "2026-09-16T12:00:00.000Z", canonicalFacts: [], openThreads: [], continuitySummary: "", scratchpad: "", rpgStats: [], trackers: [], eventTriggers: [], pendingEventTriggers: [], recordedResolution: null });
    if (path.endsWith("/story-memory")) return send(route, { level: "standard", reviewMode: "observe", availableLevels: ["off", "standard", "enhanced", "max"] });
    if (path.endsWith("/character-profile")) { const input = request.method() === "PUT" ? request.postDataJSON() : null; if (input) { profileWrites.push(input); return send(route, { campaignId, name: input.name, profile: input.profile, revision: 1 }); } return send(route, { campaignId, name: input?.name ?? "Iven", profile: input?.profile ?? {}, revision: input ? 1 : 0,
      characterId: null, storedProfile: null, inheritedFromSnapshot: false, legacyCharacterText: "Iven", rpgStats: [], defaultTriggers: [] }); }
    if (path.endsWith("/memory/metrics")) return send(route, { turns: 1, estimatedCompleteHistoryTokens: 10, memoryCount: 0, embeddedMemories: 0, semanticHealth: { indexedMemories: 0, jobStatus: "idle" } });
    if (path.endsWith("/cost-summary")) return send(route, { hasReportedCosts: false, totals: [] });
    if (path.endsWith("/memory/embedding-config")) return send(route, { enabled: false, retrievalImplementation: "disabled", retrievalShadowEnabled: false, model: null, documentPrefix: null, queryPrefix: null, batchSize: 1 });
    if (path.endsWith("/illustration-config")) return send(route, { enabled: false, sourcePolicy: "off", matchingScope: "world", confidenceProfile: "balanced", repetitionWindow: 5, maxAttempts: 3, segmentWordCount: 500, imagesPerSegment: 1, segmentPromptMode: "direct" });
    if (path.endsWith("/illustrations/segments")) return send(route, { segments: [] });
    if (path.includes("context-preview") && url.searchParams.get("view") === "characters") return send(route, { mode: "estimate", boundary, castRevision: revision, budgetTokens: 500, usedTokens: 25, coverage: { fromTurn: 1, throughTurn: 1, baseTurn: 1, current: true }, selected: [{ characterId: protagonistId, name: "Iven", reason: "pinned" }], omitted: [{ characterId: candidateId, reason: "budget" }], disabledReason: null });
    if (path.includes("context-preview")) return send(route, { selectedCompression: "none", retrieval: { mode: "local" }, budget: { estimatedSelectedTokens: 0, configuredTokens: 32000, truncated: false }, scopes: { chronicle: [] } });
    return send(route, {});
  });
  const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? 43173}/story/${campaignId}*`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? 43173}/story/${campaignId}${deepLink ? `?character=${candidateId}` : ""}`);
  await expect(page.locator("#storyTitle")).toHaveText("Cast fixture");
  return { characters, writes, profileWrites, setInvalidSource: () => { sourceInvalid = true; retracted = true; }, advanceRevision: () => { revision++; }, setLock: (value: boolean) => { liveLock = value; }, conflict: () => { conflict = true; }, disable: () => { enabled = false; },
    publishDiscovery: () => {
      revision++; trackingComplete = true; pendingMatch = false;
      let person = characters.find((character) => character.origin.kind === "discovered");
      if (!person) {
        person = { id: "88888888-8888-4888-8888-888888888888", name: "Mara", aliases: ["The Watcher"],
          origin: { kind: "discovered" }, profile: {}, pinned: false, ignored: false, revision: 0,
          firstObservedTurn: 1, lastObservedTurn: 1 };
        characters.push(person);
      }
      person.revision++;
      person.profile = { "appearance.description": "blue eyes", "story.role": "gatekeeper", ...overrides.get(person.id) };
    },
    finishTracking: () => { trackingComplete = true; }, trackingUnavailable: () => { trackingUnavailable = true; } };
}
async function open(page: Page) {
  await page.getByRole("button", { name: "Setup", exact: true }).click();
  await page.locator("#btnOpenCast").click();
  await expect(page.getByRole("dialog", { name: "Characters", exact: true })).toBeVisible();
}

async function openNexusCampaignCharacters(page: Page) {
  await page.route(`**/worlds/${worldId}`, route => route.fulfill({ json: { versions: [{ id: versionId, versionNumber: 1 }] } }));
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? 43173}/nexus/index.html#campaigns`);
  await page.locator(`#campaignList [data-campaign-id="${campaignId}"]`).click();
  await page.locator("#editCampaignCharacter").click();
}

test("legacy renders completed discovery and preserves edited and ignored characters on refresh", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  const api = await fixture(page); await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await expect(dialog.getByRole("button", { name: "Mara", exact: true })).toHaveCount(0);
  api.publishDiscovery();
  await openTrackingTools(dialog);
  await dialog.getByRole("button", { name: "Refresh characters", exact: true }).click();
  await expect(dialog).toContainText("Character tracking is up to date");
  await dialog.getByRole("button", { name: "Mara", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit character", exact: true }).click();
  await expect(dialog.getByLabel("Appearance", { exact: true })).toHaveValue("blue eyes");
  await dialog.getByLabel("Appearance", { exact: true }).fill("green eyes");
  await dialog.getByLabel("Ignore character", { exact: true }).check();
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await expect.poll(() => api.writes.length).toBe(1);
  api.publishDiscovery();
  await dialog.getByRole("button", { name: "Back to characters", exact: true }).click();
  await expect(dialog).toContainText("Ignored");
  await dialog.getByRole("button", { name: "Mara", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit character", exact: true }).click();
  await expect(dialog.getByLabel("Appearance", { exact: true })).toHaveValue("green eyes");
  await expect(dialog.getByLabel("Ignore character", { exact: true })).toBeChecked();
  expect(api.writes).toHaveLength(1);
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/discovery-refresh-390.png` });
});

for (const width of [1440, 390]) test(`legacy cast add, edit, reset, conflict and capability loss at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const api = await fixture(page); await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await expect(dialog).toContainText("Character tracking is catching up");
  await expect(dialog).toContainText("1 character match needs review");
  await openTrackingTools(dialog);
  await dialog.getByRole("button", { name: "Refresh characters", exact: true }).click();
  await expect(dialog).toContainText("Tracking starts at turn 1");
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/tracking-${width}.png` });
  api.finishTracking();
  await openTrackingTools(dialog);
  await dialog.getByRole("button", { name: "Refresh characters", exact: true }).click();
  await expect(dialog).toContainText("Character tracking is up to date");
  await expect(dialog).toContainText("Tracked turns 1–1");
  await dialog.getByRole("button", { name: "Add character", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Mara");
  await dialog.getByLabel("Aliases (one per line)").fill("The Watcher");
  await dialog.locator("summary").filter({ hasText: /^Appearance$/ }).click();
  await dialog.getByLabel("Appearance", { exact: true }).fill("green eyes");
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await expect.poll(() => api.characters.length).toBe(2);
  await dialog.getByRole("button", { name: "Edit character", exact: true }).click();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Mara");
  await dialog.getByLabel("Appearance", { exact: true }).fill("");
  await dialog.getByLabel("Pin character", { exact: true }).check();
  await dialog.getByLabel("Ignore character", { exact: true }).check();
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await expect.poll(() => api.characters[1].pinned).toBe(true);
  await dialog.getByRole("button", { name: "Edit character", exact: true }).click();
  await expect(dialog.getByLabel("Appearance", { exact: true })).toHaveValue("");
  await dialog.getByRole("button", { name: "Use discovered value for appearance", exact: true }).click();
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit character", exact: true }).click();
  await expect(dialog.getByLabel("Appearance", { exact: true })).toHaveValue("blue eyes");
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/detail-${width}.png` });
  api.conflict();
  await dialog.getByLabel("Name", { exact: true }).fill("Mara Reed");
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Your draft is kept");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Mara Reed");
  await dialog.getByRole("button", { name: "Compare latest", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Latest saved character" })).toBeVisible();
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/conflict-${width}.png` });
  await dialog.getByRole("button", { name: "Reapply my changes", exact: true }).click();
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await expect.poll(() => api.characters[1].name).toBe("Mara Reed");
  await dialog.getByRole("button", { name: "Back to characters", exact: true }).click();
  await dialog.getByLabel("Find a character").fill("Watcher");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Mara Reed", exact: true })).toBeVisible();
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/roster-${width}.png` });
  await dialog.getByRole("button", { name: "Mara Reed", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit character", exact: true }).click();
  api.disable();
  await dialog.getByLabel("Name", { exact: true }).fill("Kept draft");
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await expect(dialog).toContainText("editing is disabled");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Kept draft");
  await expect(dialog.getByRole("button", { name: "Save character", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});
for (const action of ["create", "attach"] as const) test(`legacy cast reviews a source and resolves it by ${action}`, async ({ page }) => {
  await page.setViewportSize({ width: action === "create" ? 1440 : 390, height: 1000 });
  const api = await fixture(page); await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await openReview(dialog);
  await expect(dialog).toContainText("Mara waits at the gate.");
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/review-${action}.png` });
  if (action === "attach") {
    await dialog.getByLabel("Existing character", { exact: true }).selectOption(protagonistId);
    await dialog.getByRole("button", { name: "Attach to selected character", exact: true }).click();
  } else await dialog.getByRole("button", { name: "Create separate character", exact: true }).click();
  await expect(dialog).toContainText("Nothing needs review.");
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0].action).toBe(action);
  expect(api.characters).toHaveLength(action === "create" ? 2 : 1);
});
test("Nexus campaign editor displays a pending match and attaches it to an existing character", async ({ page }, info) => {
  const api = await fixture(page, false, true);
  await openNexusCampaignCharacters(page);
  const dialog = page.locator("#campaignCastDialog");
  await expect(dialog).toContainText("identity matches: 1");
  await dialog.getByRole("button", { name: "Needs attention" }).click();
  await dialog.getByRole("button", { name: "Mara · turn 1" }).click();
  await dialog.getByLabel("Existing character", { exact: true }).selectOption(candidateId);
  await dialog.screenshot({ path: info.outputPath("campaign-match.png") });
  api.setLock(true);
  await dialog.getByRole("button", { name: "Attach to selected character" }).click();
  await expect(dialog).toContainText("Finish or resolve generation");
  expect(api.writes).toHaveLength(0);
  api.setLock(false);
  await dialog.getByRole("button", { name: "Attach to selected character" }).click();
  await expect(dialog).toContainText("Nothing needs review.");
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0]).toMatchObject({ action: "attach", characterId: candidateId });
  expect(api.characters).toHaveLength(2);
});

test("legacy candidate review distinguishes same-name targets and previews their profiles", async ({ page }) => {
  const api = await fixture(page);
  for (const [id, role] of [["99999999-9999-4999-8999-999999999999", "eastern guide"], ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "western guide"]]) {
    api.characters.push({ id, name: "Mara", aliases: [], origin: { kind: "manual" }, profile: { "story.role": role },
      pinned: false, ignored: false, revision: 0, firstObservedTurn: 1, lastObservedTurn: 1 });
  }
  await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await dialog.getByRole("button", { name: "Load more characters", exact: true }).click();
  await openReview(dialog);
  const options = await dialog.getByLabel("Existing character", { exact: true }).locator("option").allTextContents();
  expect(new Set(options).size).toBe(options.length);
  await dialog.getByLabel("Existing character", { exact: true }).selectOption("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  await expect(dialog).toContainText("Role: western guide");
});
test("legacy cast keeps characters available when tracking status fails", async ({ page }) => {
  const api = await fixture(page); api.trackingUnavailable(); await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await expect(dialog).toContainText("Character tracking status is unavailable");
  await expect(dialog.getByRole("button", { name: "Iven", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add character", exact: true })).toBeEnabled();
  expect(api.writes).toEqual([]);
});
test("legacy cast protects unsaved drafts and restores keyboard focus", async ({ page }) => {
  await fixture(page); await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Setup", exact: true })).toBeFocused();
  await open(page);
  await dialog.getByRole("button", { name: "Add character", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Unfinished");
  await page.keyboard.press("Escape");
  const decision = dialog.getByRole("alertdialog", { name: "Unsaved character changes" });
  await expect(decision.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await decision.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Unfinished");
  await page.keyboard.press("Escape");
  await decision.getByRole("button", { name: "Discard changes" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Setup", exact: true })).toBeFocused();
});
test("legacy cast creates separate same-name people after a conflict and links the protagonist editor", async ({ page }) => {
  const api = await fixture(page); await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await dialog.getByRole("button", { name: "Iven", exact: true }).click();
  await expect(dialog).toContainText("This is your main character");
  await dialog.getByRole("button", { name: "Edit main character", exact: true }).click();
  await expect(page.locator("#editCharacterProfileDialog")).toBeVisible();
  await page.locator("#btnCancelEditCharacterProfile").click();
  await expect(dialog.getByRole("button", { name: "Edit main character", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Back to characters", exact: true }).click();
  for (let index = 0; index < 2; index++) {
    await dialog.getByRole("button", { name: "Add character", exact: true }).click();
    await dialog.getByLabel("Name", { exact: true }).fill("Mara");
    if (index === 0) api.conflict();
    await dialog.getByRole("button", { name: "Save character", exact: true }).click();
    if (index === 0) {
      await expect(dialog.getByRole("alert")).toBeVisible();
      await dialog.getByRole("button", { name: "Compare latest", exact: true }).click();
      await expect(dialog).toContainText("Your new character has not been saved");
      await dialog.getByRole("button", { name: "Reapply my changes", exact: true }).click();
      await dialog.getByRole("button", { name: "Save character", exact: true }).click();
    }
    await expect(dialog.getByRole("button", { name: "Edit character", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Back to characters", exact: true }).click();
  }
  await dialog.getByRole("button", { name: "Load more characters", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Mara", exact: true })).toHaveCount(2);
  expect(new Set(api.characters.map((person) => person.id)).size).toBe(3);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload(); await open(page);
  await dialog.getByRole("button", { name: "Load more characters", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Mara", exact: true })).toHaveCount(2);
  await dialog.getByRole("button", { name: "Mara", exact: true }).first().click();
  await dialog.getByText("Sources and edit history", { exact: true }).click();
  await expect(dialog).toContainText("Claim: Role — gatekeeper");
  await dialog.getByRole("button", { name: "Turn 1", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#storyArea")).toContainText("Mara waits at the gate");
});

for (const surface of ["legacy", "next"] as const) for (const width of [1440, 390]) test(`shared character sheet and profile fields ${surface} ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 }); const api = await fixture(page); api.characters.push({ id: candidateId, name: "Mara", aliases: [], origin: { kind: "manual" }, profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 1, lastObservedTurn: 1 });
  if (surface === "legacy") await open(page);
  else {
    await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`);
    await page.locator("[data-campaign-tools] summary").click();
    await page.locator("[data-tool-action='open-characters']").click();
  }
  const dialog = surface === "legacy" ? page.locator("#campaignCastDialog") : page.locator("dialog.characters-workspace");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("conflicts: 1");
  if (surface === "next") await dialog.getByRole("button", { name: "Review conflicts", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Iven", exact: true })).toBeVisible();
  if (surface === "next") await expect(dialog).toContainText("Needs review (2)");
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/roster-${surface}-${width}.png` });
  await openTrackingTools(dialog);
  await dialog.getByRole("button", { name: "Likely included for this input", exact: true }).click();
  await dialog.getByRole("button", { name: "Refresh estimate", exact: true }).click(); await expect(dialog).toContainText("Estimate at turn 1");
  await expect(dialog).toContainText("Estimated usage: 25 of 500 tokens");
  await expect(dialog).toContainText("Included: Iven · pinned");
  await expect(dialog).toContainText("Omitted: Mara · budget");
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/context-${surface}-${width}.png` });
  await dialog.getByRole("button", { name: "Back to characters", exact: true }).click();
  await dialog.getByRole("button", { name: "Iven", exact: true }).click();
  if (surface === "legacy") {
    await expect(dialog).toContainText("Source unavailable");
    await dialog.getByRole("button", { name: "Show empty fields", exact: true }).click();
  }
  await expect(dialog).toContainText("Unknown");
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/sheet-${surface}-${width}.png` });
  await dialog.getByRole("button", { name: "Edit main character", exact: true }).click();
  // The replacement client edits the main character inside the Characters sheet.
  const profile = surface === "legacy" ? page.locator("#editCharacterProfileDialog") : dialog;
  await expect(profile).toBeVisible();
  if (surface === "legacy") await profile.getByText("Names and pronouns (optional)", { exact: true }).click();
  await expect(profile.getByText("Pronouns", { exact: true })).toBeVisible();
  await expect(profile.getByText("Profile JSON", { exact: true })).toHaveCount(0);
  if (screenshotRoot) await profile.screenshot({ path: `${screenshotRoot}/profile-${surface}-${width}.png` });
  await profile.getByLabel("Pronouns", { exact: true }).fill("they/them");
  let releaseSave: (() => void) | undefined;
  if (surface === "next" && width === 1440) {
    const gate = new Promise<void>(resolve => { releaseSave = resolve; });
    await page.route(`**/character-profile`, async route => {
      if (route.request().method() !== "PUT") return route.fallback();
      await gate; return route.fallback();
    });
  }
  await profile.getByRole("button", { name: /Save character profile/i }).click();
  if (releaseSave) {
    await expect(profile.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await expect(profile.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
    await expect(profile.getByLabel("Pronouns", { exact: true })).toBeDisabled();
    releaseSave();
  }
  await expect.poll(() => api.profileWrites.length).toBe(1);
  expect(api.profileWrites[0].profile.identity.pronouns).toBe("they/them");
  if (surface === "next") { await expect(dialog.getByRole("button", { name: "Edit main character", exact: true })).toBeVisible(); await expect(dialog).toContainText("they/them"); }
});

for (const surface of ["legacy", "next", "campaign"] as const) for (const width of [1440, 390]) test(`shared review and undo ${surface} ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const api = await fixture(page, true);
  const supportingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const supporting = { id: supportingId, name: "Iven", aliases: [], origin: { kind: "manual" }, profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 1, lastObservedTurn: 1 };
  api.characters.push(supporting);
  const eventId = "99999999-9999-4999-8999-999999999999", boundary = { turnNumber: 1, timelineRevision: 0 };
  const writes: any[] = []; let detached = false;
  const send = (route: Route, value: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
  await page.route(`**/cast/${protagonistId}`, route => send(route, { revision: 0, boundary, capabilities: { castEditing: true }, character: { id: protagonistId, name: "Iven", aliases: [], origin: { kind: "protagonist", selectedCharacterId: null }, profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 0, lastObservedTurn: 1 }, observations: [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], editorDestination: null, autoMatches: detached ? [] : [{ eventId, characterId: protagonistId, basis: "unique_name", sourceRanges: [{ turnId: "55555555-5555-4555-8555-555555555555", narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", start: 0, end: 4 }], observationIds: [], turnNumber: 1, quote: "Iven is the gatekeeper." }] }));
  await page.route(`**/cast/${protagonistId}/attachments/${eventId}/detach`, route => { writes.push(route.request().postDataJSON()); detached = true; return send(route, { revision: 1, boundary, detachedEventId: eventId, character: { id: protagonistId, name: "Iven", aliases: [], origin: { kind: "protagonist", selectedCharacterId: null }, profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 0, lastObservedTurn: 1 } }); });
  await page.route(`**/cast/${supportingId}`, route => send(route, { revision: 0, boundary, character: supporting, observations: [], overrides: [], autoMatches: [], identityEvents: [], unresolvedCandidateIds: [], editorDestination: null }));
  let remainingDetails = 2; const decisions: any[] = [];
  await page.route("**/cast/candidates?**", route => {
    const url = new URL(route.request().url()); if (url.searchParams.get("view") === "review") return send(route, { revision: 0, boundary, nextCursor: null, candidates: remainingDetails ? [{ id: candidateId, reason: "detail_needs_review", resolvedCharacterId: supportingId, proposal: { localKey: "mara", name: "Mara", aliases: [], existingCharacterId: null, identityEvidence: [{ paragraphId: "p1", quote: "Iven is the gatekeeper." }], observations: [] }, source: { turnId: "55555555-5555-4555-8555-555555555555", turnNumber: 1, narrationRevision: 0 }, details: [{ observationIndex: 2 - remainingDetails, field: "story.role", value: "gatekeeper", quote: "Iven is the gatekeeper.", reason: "unverified", canAcceptObservation: true, allowedActions: remainingDetails === 2 ? ["accept", "dismiss"] : ["dismiss"], sourceHash: "a".repeat(64) }] }] : [] });
    if (url.searchParams.get("view") !== "details") return route.fallback();
    return send(route, { revision: 0, boundary, nextCursor: null, candidates: remainingDetails ? [{ id: candidateId, reason: "detail_needs_review", resolvedCharacterId: supportingId, proposal: { localKey: "mara", name: "Mara", aliases: [], existingCharacterId: null, identityEvidence: [{ paragraphId: "p1", quote: "Iven is the gatekeeper." }], observations: [] }, source: { turnId: "55555555-5555-4555-8555-555555555555", turnNumber: 1, narrationRevision: 0 }, details: [{ observationIndex: 2 - remainingDetails, field: "story.role", value: "gatekeeper", quote: "Iven is the gatekeeper.", reason: "unverified", canAcceptObservation: true, allowedActions: remainingDetails === 2 ? ["accept", "dismiss"] : ["dismiss"], sourceHash: "a".repeat(64) }] }] : [] });
  });
  await page.route(`**/cast/candidates/${candidateId}/details/resolve`, route => { const input = route.request().postDataJSON(); decisions.push(input); remainingDetails--; return send(route, { revision: 0, boundary, character: supporting, candidateId, observationIndex: input.observationIndex, disposition: input.action }); });
  if (surface === "campaign") await openNexusCampaignCharacters(page);
  else if (surface === "legacy") await open(page);
  else { await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`); await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click(); }
  const dialog = surface === "next" ? page.locator("dialog.characters-workspace") : page.locator("#campaignCastDialog");
  await openReview(dialog);
  await expect(dialog).toContainText("gatekeeper");
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/review-${surface}-${width}.png` });
  await dialog.getByRole("button", { name: "Apply and next", exact: true }).click();
  await expect.poll(() => decisions.length).toBe(1);
  await expect(dialog.getByRole("button", { name: "Dismiss detail", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Apply and next", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Keep as override", exact: true })).toHaveCount(0);
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/fixed-field-${surface}-${width}.png` });
  await dialog.getByRole("button", { name: "Dismiss detail", exact: true }).click();
  await expect.poll(() => decisions.length).toBe(2); expect(decisions.map(item => item.action)).toEqual(["accept", "dismiss"]); expect(decisions[0]).not.toHaveProperty("confirmedValue");
  await dialog.getByRole("button", { name: "Back to characters", exact: true }).click();
  if (surface !== "next") await dialog.getByRole("button", { name: "Back to characters", exact: true }).click();
  await dialog.getByRole("button", { name: "Iven", exact: true }).first().click();
  if (surface === "next") { const sources = dialog.locator("details").first(); await sources.locator("summary").click(); await expect(sources).toHaveAttribute("open", ""); await page.waitForTimeout(5500); await expect(sources).toHaveAttribute("open", ""); }
  await dialog.getByRole("button", { name: "Not this character", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1); await expect(dialog.getByRole("button", { name: "Not this character", exact: true })).toHaveCount(0);
});

for (const surface of ["legacy", "next"] as const) test(`character accessibility at 200 percent ${surface}`, async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 500 }); await page.emulateMedia({ reducedMotion: "reduce" }); await fixture(page);
  if (surface === "legacy") await open(page); else { await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`); await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click(); }
  const dialog = surface === "legacy" ? page.locator("#campaignCastDialog") : page.locator("dialog.characters-workspace");
  await expect(dialog.getByRole("button", { name: "Iven", exact: true })).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/zoom-${surface}.png` });
  await dialog.getByRole("button", { name: "Close", exact: true }).click(); await expect(dialog).not.toBeVisible();
  if (surface === "legacy") await expect(page.getByRole("button", { name: "Setup", exact: true })).toBeFocused();
  else await expect(page.locator("[data-campaign-tools] summary")).toBeFocused();
});

for (const surface of ["legacy", "next"] as const) test(`conflict field can be corrected ${surface}`, async ({ page }) => {
  await fixture(page, false, true);
  if (surface === "legacy") await open(page); else { await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`); await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click(); }
  const dialog = surface === "legacy" ? page.locator("#campaignCastDialog") : page.locator("dialog.characters-workspace");
  if (surface === "legacy") {
    await dialog.getByRole("button", { name: /^Needs attention(?: \(\d+\))?$/ }).click();
    await dialog.getByRole("button", { name: "Mara · Role", exact: true }).click();
    await expect(dialog.getByLabel("Role", { exact: true })).toBeFocused();
  } else {
    await dialog.getByRole("button", { name: "Review conflicts", exact: true }).click(); await expect(dialog.getByRole("button", { name: "Mara", exact: true })).toBeVisible(); await expect(dialog.getByRole("button", { name: "Iven", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Mara", exact: true }).click(); await expect(dialog).toContainText("Conflicting observations"); await dialog.getByRole("button", { name: "Edit character", exact: true }).click();
  } await dialog.getByLabel("Role", { exact: true }).fill("guide"); await dialog.getByRole("button", { name: "Save character", exact: true }).click();
});

test("legacy exposes recovery for a failed tracking gap", async ({ page }) => {
  await fixture(page);
  await recoveryWorkspace(page, "scan");
  await page.route("**/cast/discovery", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    enabled: true, state: "failed", activeTurnNumber: 1, coverageStartTurn: 1, trackedThroughTurn: 0, unresolvedCount: 0,
    firstGap: { turnNumber: 1, jobId: candidateId, status: "failed", diagnosticCode: "provider_timeout" }
  }) }));
  await page.route("**/cast/scans**", route => {
    const scan = { id: candidateId, fromTurn: 1, throughTurn: 1, completeTurns: 0, failedTurns: 1, firstFailedTurn: 1, pendingReviewCount: 0, status: "failed" };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(new URL(route.request().url()).pathname.endsWith("/scans") ? { scan, capabilities: { castBackfill: true } } : scan) });
  });
  await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await expect(dialog).toContainText("The text provider timed out.");
  await openTrackingTools(dialog);
  await dialog.getByRole("button", { name: "Open tracking recovery", exact: true }).click();
  await expect(dialog).toContainText("First tracking gap: turn 1");
  await expect(dialog.getByRole("button", { name: "Retry turn 1", exact: true })).toBeEnabled();
  if (screenshotRoot) await page.screenshot({ path: `${screenshotRoot}/tracking-recovery.png`, fullPage: true });
});

for (const surface of ["legacy", "next"] as const) test(`starting another scan from tracking recovery follows the new scan on ${surface}`, async ({ page }) => {
  await fixture(page);
  await recoveryWorkspace(page, "scan");
  const boundary = { turnNumber: 1, timelineRevision: 0 };
  await page.route("**/cast/discovery", route => route.fulfill({ json: {
    enabled: true, state: "failed", activeTurnNumber: 1, coverageStartTurn: 1, trackedThroughTurn: 0, unresolvedCount: 0,
    firstGap: { turnNumber: 1, jobId: candidateId, status: "failed", diagnosticCode: "provider_timeout" }
  } }));
  const old = { id: candidateId, fromTurn: 1, throughTurn: 1, completeTurns: 0, failedTurns: 1, firstFailedTurn: 1, pendingReviewCount: 0, status: "failed" };
  const next = { ...old, id: versionId, failedTurns: 0, firstFailedTurn: null, status: "queued" };
  let latest = old.id;
  await page.route("**/cast/scans**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/preview")) return route.fulfill({ json: { fromTurn: 1, throughTurn: 1, boundary, turnCount: 1,
      estimatedChunkRequests: 1, completedChunkReceipts: 0, completedTurns: 0, manualScanTurns: [],
      providerProfileId: versionId, selection: { kind: "model", modelId: "fixture" } } });
    if (path.endsWith("/scans")) {
      if (route.request().method() === "POST") { latest = next.id; return route.fulfill({ json: next }); }
      return route.fulfill({ json: { scan: latest === old.id ? old : next, capabilities: { castBackfill: true } } });
    }
    const scan = path.includes(old.id) ? old : next;
    if (path.endsWith("/cancel")) scan.status = "cancelled";
    if (path.endsWith("/pause")) scan.status = "paused";
    return route.fulfill({ json: scan });
  });
  if (surface === "legacy") await open(page);
  else {
    await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`);
    await page.locator("[data-campaign-tools] summary").click();
    await page.locator("[data-tool-action='open-characters']").click();
  }
  const dialog = page.locator(surface === "legacy" ? "#campaignCastDialog" : "dialog.characters-workspace");
  const button = (name: string) => dialog.getByRole("button", { name, exact: true });
  await openTrackingTools(dialog);
  await button("Open tracking recovery").click();
  await button("Cancel scan").click();
  await button("Preview scan").click();
  await button("Start scan").click();
  await expect(dialog.getByRole("heading", { name: "Scan queued" })).toBeVisible();
  next.status = "running";
  await button("Refresh scan").click();
  await expect(dialog.getByRole("heading", { name: "Scan running" })).toBeVisible();
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/replacement-scan-${surface}.png` });
  await button("Pause scan").click();
  await expect(dialog.getByRole("heading", { name: "Scan paused" })).toBeVisible();
  await button("Cancel scan").click();
  await expect(dialog.getByRole("heading", { name: "Scan cancelled" })).toBeVisible();
  expect(next.status).toBe("cancelled");
});

for (const kind of ["forward", "scan"] as const) test(`next routes ${kind} recovery to its owner`, async ({ page }) => {
  await fixture(page);
  await recoveryWorkspace(page, kind);
  let retries = 0;
  await page.route(`**/cast/discovery/${candidateId}/retry`, route => { retries++; return route.fulfill({ contentType: "application/json", body: JSON.stringify({ jobId: candidateId, retryGeneration: 1 }) }); });
  await page.route("**/cast/discovery", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ enabled: true, state: "failed", activeTurnNumber: 1, coverageStartTurn: 1, trackedThroughTurn: 0, unresolvedCount: 0, firstGap: { turnNumber: 1, jobId: candidateId, status: "failed", diagnosticCode: "provider_timeout" } }) }));
  await page.route("**/cast/scans**", route => {
    const scan = { id: candidateId, fromTurn: 1, throughTurn: 1, completeTurns: 0, failedTurns: 1, firstFailedTurn: 1, pendingReviewCount: 0, status: "failed" };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(new URL(route.request().url()).pathname.endsWith("/scans") ? { scan, capabilities: { castBackfill: true } } : scan) });
  });
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`);
  await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click();
  const dialog = page.locator("dialog.characters-workspace");
  if (kind === "forward") {
    await expect(dialog.getByRole("button", { name: "Open tracking recovery" })).toHaveCount(0);
  await openTrackingTools(dialog);
    await dialog.getByRole("button", { name: "Retry character tracking" }).click();
    await expect.poll(() => retries).toBe(1);
  } else {
    await expect(dialog.getByRole("button", { name: "Retry character tracking" })).toHaveCount(0);
  await openTrackingTools(dialog);
    await dialog.getByRole("button", { name: "Open tracking recovery" }).click();
    await expect(dialog.getByRole("button", { name: "Retry turn 1" })).toBeEnabled();
    expect(retries).toBe(0);
  }
});

for (const surface of ["legacy", "next"] as const) test(`review paginates and groups evidence without reloading on skip ${surface}`, async ({ page }) => {
  await fixture(page);
  const boundary = { turnNumber: 2, timelineRevision: 0 }, turnId1 = "55555555-5555-4555-8555-555555555555", turnId2 = "77777777-7777-4777-8777-777777777777";
  const secondCandidate = "99999999-9999-4999-8999-999999999999", requests: string[] = [], writes: unknown[] = [];
  const candidate = (id: string, turnNumber: number, turnId: string, quote: string) => ({ id, reason: "detail_needs_review", resolvedCharacterId: protagonistId,
    proposal: { localKey: `person${turnNumber}`, name: "Iven", aliases: [], existingCharacterId: null, identityEvidence: [{ paragraphId: "p1", quote }], observations: [] },
    source: { turnId, turnNumber, narrationRevision: 0 }, details: [{ observationIndex: 0, field: "story.role", value: `guide ${turnNumber}`, quote, reason: "unverified", sourceHash: "a".repeat(64), canAcceptObservation: true }] });
  const send = (route: Route, data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
  await page.route("**/cast/candidates?**", route => { const url = new URL(route.request().url()); requests.push(url.search); const cursor = url.searchParams.get("cursor");
    return send(route, { revision: 0, boundary, nextCursor: cursor ? null : candidateId, candidates: cursor ? [candidate(secondCandidate, 1, turnId1, "Earlier evidence.")] : [candidate(candidateId, 2, turnId2, "Later evidence.")] }); });
  await page.route("**/cast?**", route => { const url = new URL(route.request().url()); if (!url.searchParams.has("expectedRevision")) return route.fallback();
    return send(route, { revision: 0, boundary, nextCursor: null, capabilities: { castEditing: true }, characters: [{ id: protagonistId, name: "Iven", aliases: [], origin: { kind: "protagonist", selectedCharacterId: null }, profile: { "story.role": "watcher" }, pinned: false, ignored: false, revision: 0, firstObservedTurn: 0, lastObservedTurn: 2 }] }); });
  await page.route("**/reader/turns/1**", route => send(route, { campaignId, turn: { id: turnId1, turnNumber: 1, action: "Look", inputMode: "action", inputModeSource: "explicit", narration: "Before. Earlier evidence. After.", choices: [], customActionSuggestion: "", imagePrompt: "", imageUrl: null, acceptedAt: "2026-09-16T12:00:00.000Z", chronicleRetrieval: null, reportedCost: null } }));
  await page.route("**/cast/candidates/**/details/resolve", route => { writes.push(route.request().postDataJSON()); return send(route, {}, 500); });
  if (surface === "legacy") await open(page); else { await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`); await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click(); }
  const dialog = surface === "legacy" ? page.locator("#campaignCastDialog") : page.locator("dialog.characters-workspace");
  await openReview(dialog);
  await expect(dialog).toContainText("1 item remaining"); await expect(dialog).toContainText("Current: watcher");
  const evidence = dialog.locator("section blockquote"); await expect(evidence).toHaveText(["Earlier evidence.", "Later evidence."]);
  const expectedRequests = surface === "legacy" ? 4 : 2;
  expect(requests).toHaveLength(expectedRequests); expect(requests.every(query => new URLSearchParams(query).get("view") === "review")).toBe(true);
  await dialog.getByRole("button", { name: "Source turn 1", exact: true }).click();
  await expect(dialog.locator("mark")).toHaveText("Earlier evidence."); await expect(dialog).toContainText("Before. Earlier evidence. After.");
  await expect(dialog).toContainText("1 item remaining"); await expect(dialog.getByRole("button", { name: "Open full turn in story" })).toBeVisible();
  const count = requests.length; await dialog.getByRole("button", { name: "Skip for now", exact: true }).click();
  await expect(dialog).toContainText("Review complete for this pass."); expect(requests).toHaveLength(count); expect(writes).toHaveLength(0);
});

for (const mode of ["stale", "fallback"] as const) test(`review handles ${mode === "stale" ? "a changed revision" : "an older server"}`, async ({ page }) => {
  await fixture(page); const calls: string[] = [], writes: string[] = [], boundary = { turnNumber: 1, timelineRevision: 0 };
  await page.route("**/cast/candidates?**", route => { const url = new URL(route.request().url()), view = url.searchParams.get("view")!; calls.push(view);
    if (mode === "fallback" && view === "review") return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "invalid_request" }) });
    const cursor = url.searchParams.get("cursor"); return route.fulfill({ contentType: "application/json", body: JSON.stringify({ revision: mode === "stale" && cursor ? 1 : 0, boundary, candidates: [], nextCursor: mode === "stale" && !cursor ? candidateId : null }) }); });
  await page.route("**/cast/candidates/**/resolve", route => { writes.push(route.request().url()); return route.abort(); });
  await open(page); const dialog = page.locator("#campaignCastDialog"); await openReview(dialog);
  if (mode === "stale") { await expect(dialog).toContainText("The story or cast changed. Reload review."); expect(calls.slice(-2)).toEqual(["review", "review"]); }
  else { await expect(dialog).toContainText("Nothing needs review."); expect(calls.slice(-3)).toEqual(["review", "matches", "details"]); }
  expect(writes).toHaveLength(0);
});

test("replacement character tools ignore a scan response after closing and reopening", async ({ page }) => {
  await fixture(page); let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), received = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/cast/scans**", async route => { started(); await gate; return route.fulfill({ contentType: "application/json", body: JSON.stringify({ scan: null, capabilities: { castBackfill: true } }) }); });
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`);
  const openWorkspace = async () => { await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click(); };
  await openWorkspace(); const dialog = page.locator("dialog.characters-workspace");
  await openTrackingTools(dialog);
  await dialog.getByRole("button", { name: "Scan earlier story", exact: true }).click(); await received;
  await page.keyboard.press("Escape"); await expect(dialog).not.toBeVisible(); await openWorkspace();
  await openTrackingTools(dialog);
  await dialog.getByRole("button", { name: "Likely included for this input", exact: true }).click();
  const response = page.waitForResponse(value => value.url().includes("/cast/scans")); release(); await response;
  await expect(dialog.getByRole("heading", { name: "Likely included for this input" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Scan earlier story" })).toHaveCount(0);
});

for (const surface of ["legacy", "next"] as const) for (const suggested of [true, false]) test(`identity review ${suggested ? "preselects a server suggestion" : "leaves an ambiguous match unselected"} ${surface}`, async ({ page }) => {
  const api = await fixture(page); const targetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  api.characters.push({ id: targetId, name: "Mara", aliases: [], origin: { kind: "manual" }, profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 1, lastObservedTurn: 1 });
  const boundary = { turnNumber: 1, timelineRevision: 0 };
  await page.route("**/cast/candidates?**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ revision: 0, boundary, nextCursor: null, candidates: [{ id: candidateId, reason: "identity_needs_review", ...(suggested ? { suggestedCharacterId: targetId } : {}), proposal: { localKey: "mara", name: "Mara", aliases: [], existingCharacterId: null, identityEvidence: [{ paragraphId: "p1", quote: "Mara waits at the gate." }], observations: [] }, source: { turnId: "55555555-5555-4555-8555-555555555555", turnNumber: 1, narrationRevision: 0 } }] }) }));
  if (surface === "legacy") await open(page); else { await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`); await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click(); }
  const dialog = surface === "legacy" ? page.locator("#campaignCastDialog") : page.locator("dialog.characters-workspace");
  await openReview(dialog);
  await expect(dialog.getByLabel("Existing character", { exact: true })).toHaveValue(suggested ? targetId : "");
  if (suggested) await expect(dialog.getByRole("button", { name: "Attach to selected character", exact: true })).toBeEnabled();
  else await expect(dialog.getByRole("button", { name: "Attach to selected character", exact: true })).toBeDisabled();
});
for (const width of [1440, 390]) test(`legacy needs attention routes individual items by keyboard at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await fixture(page, false, true);
  const boundary = { turnNumber: 1, timelineRevision: 0 };
  const source = { turnId: "55555555-5555-4555-8555-555555555555", turnNumber: 1, narrationRevision: 0 };
  const proposal = { localKey: "mara", name: "Mara", aliases: [], existingCharacterId: null, identityEvidence: [{ paragraphId: "p1", quote: "Mara waits at the gate." }], observations: [] };
  const views: string[] = [];
  await page.route("**/cast/workspace-status", route => route.fulfill({ json: {
    revision: 0, boundary, capabilities: { editing: true, discovery: true, autoMatch: true, backfill: true, context: true },
    contextDisabledReason: null, counts: { identities: 1, details: 1, conflicts: 1 },
    tracking: { enabled: true, state: "complete", activeTurnNumber: 1, coverageStartTurn: 1, trackedThroughTurn: 1, unresolvedCount: 2, firstGap: null }
  } }));
  await page.route("**/cast/candidates?**", route => {
    const view = new URL(route.request().url()).searchParams.get("view") || ""; views.push(view);
    return route.fulfill({ json: { revision: 0, boundary, nextCursor: null, candidates: [
      { id: candidateId, reason: "identity_needs_review", proposal, source },
      { id: "99999999-9999-4999-8999-999999999999", reason: "detail_needs_review", resolvedCharacterId: protagonistId, proposal: { ...proposal, name: "Iven" }, source,
        details: [{ observationIndex: 0, field: "story.role", value: "guide", quote: "Mara waits at the gate.", reason: "unverified", sourceHash: "a".repeat(64), canAcceptObservation: true }] }
    ] } });
  });
  await open(page);
  const dialog = page.locator("#campaignCastDialog");
  const attention = dialog.getByRole("button", { name: /^Needs attention(?: \(\d+\))?$/ });
  await attention.focus(); await page.keyboard.press("Enter");
  await expect(dialog.getByRole("heading", { name: "Identity questions (1)" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Withheld details (1)" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Conflicts (1)" })).toBeVisible();
  const identity = dialog.getByRole("button", { name: "Mara · turn 1", exact: true });
  const detail = dialog.getByRole("button", { name: "Iven · Role · turn 1", exact: true });
  const conflict = dialog.getByRole("button", { name: "Mara · Role", exact: true });
  await expect(identity).toBeVisible(); await expect(detail).toBeVisible(); await expect(conflict).toBeVisible();
  expect(await identity.evaluate((element, later) => Boolean(element.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING), await detail.elementHandle())).toBe(true);
  expect(await detail.evaluate((element, later) => Boolean(element.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING), await conflict.elementHandle())).toBe(true);
  await conflict.focus();
  await dialog.screenshot({ path: `test-results/review-assets/unified-character-editor-phase-2/cast-inbox-${width}.png` });
  await identity.focus(); await page.keyboard.press("Enter");
  await expect(dialog).toContainText("Mara waits at the gate.");
  await dialog.getByRole("button", { name: "Back to characters", exact: true }).click();
  await dialog.getByRole("button", { name: "Iven · Role · turn 1", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(dialog).toContainText("Proposed: guide");
  await dialog.getByRole("button", { name: "Back to characters", exact: true }).click();
  await dialog.getByRole("button", { name: "Mara · Role", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByLabel("Role", { exact: true })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Save character", exact: true })).toBeVisible();
  // Three inbox reads plus two targeted review reads, each within its own revision fence.
  expect(views.filter(view => view === "review").length).toBe(5);
});

for (const width of [1440, 390]) for (const [source, expected] of [["snapshot", "World snapshot"], ["initial", "Campaign profile"], ["edited", "Campaign profile"], ["unknown", "Source unavailable"]] as const) test(`legacy main profile identifies ${source} provenance by keyboard at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await fixture(page);
  await page.route("**/character-profile", route => route.fulfill({ json: {
    campaignId, name: "Iven", profile: {}, revision: source === "edited" ? 2 : 0, characterId: null,
    storedProfile: source === "edited" || source === "initial" ? { name: "Iven", profile: {} } : null, inheritedFromSnapshot: source === "snapshot", legacyCharacterText: "Iven", rpgStats: [], defaultTriggers: []
  } }));
  await page.getByRole("button", { name: "Setup", exact: true }).press("Enter");
  await tabTo(page, page.locator("#btnOpenCast"));
  await page.keyboard.press("Enter");
  const dialog = page.locator("#campaignCastDialog");
  await tabTo(page, dialog.getByRole("button", { name: "Iven", exact: true }));
  await page.keyboard.press("Enter");
  await expect(dialog).toContainText(expected);
  const roster = dialog.getByRole("navigation", { name: "Characters" });
  if (width === 390) {
    await tabTo(page, roster.locator("summary"));
    await page.keyboard.press("Enter");
  }
  await expect(roster.getByRole("button", { name: "Iven" })).toHaveAttribute("aria-current", "true");
  const toggle = dialog.getByRole("button", { name: "Show empty fields", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.getByText("Pronouns:", { exact: false })).toHaveCount(0);
  await tabTo(page, toggle);
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Hide empty fields" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByText("Pronouns:", { exact: false })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog.getByText("Pronouns:", { exact: false })).toHaveCount(0);
});

test("supporting character warns on a roster alias without blocking save", async ({ page }) => {
  const api = await fixture(page); api.publishDiscovery(); await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await dialog.getByRole("button", { name: "Add character", exact: true }).click();
  await dialog.locator("#cast-name").fill("the watcher");
  await expect(dialog).toContainText("A character with this name already exists");
  await expect(dialog.locator("#cast-save")).toBeEnabled();
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0]).toMatchObject({ name: "the watcher" });
  await expect(dialog.getByRole("button", { name: "Edit character", exact: true })).toBeVisible();
});

for (const width of [1440, 390]) test(`Add from world refreshes a stale preview at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await fixture(page, false, false, true); await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await dialog.getByRole("button", { name: "Add from world" }).click();
  await dialog.getByLabel("World character").selectOption("world-scout");
  await expect(dialog).toContainText("Campaign identity: Scout");
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/world-add-preview-${width}.png` });
  await dialog.getByRole("button", { name: "Add to campaign" }).click();
  await expect(dialog).toContainText("Review a fresh preview");
  await dialog.getByRole("button", { name: "Refresh preview" }).click();
  await dialog.getByRole("button", { name: "Add to campaign" }).click();
  await expect(dialog).toContainText("Scout");
});

test("Apply world profile requires a fresh preview after a conflict", async ({ page }) => {
  await fixture(page, false, true, true, true); await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await dialog.getByRole("button", { name: "Add from world" }).click();
  await dialog.getByLabel("World character").selectOption("world-scout");
  await dialog.getByRole("button", { name: `Mara · ${candidateId}` }).click();
  await dialog.getByRole("button", { name: "Apply world profile to Mara" }).click();
  await expect(dialog).toContainText("Review a fresh preview");
  await dialog.getByRole("button", { name: "Refresh preview" }).click();
  await dialog.getByRole("button", { name: `Mara · ${candidateId}` }).click();
  await dialog.getByRole("button", { name: "Apply world profile to Mara" }).click();
  await expect(dialog).toContainText("Mara");
});

test("live generation locks character editing and preserves the unsaved draft", async ({ page }) => {
  const api = await fixture(page); await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await dialog.getByRole("button", { name: "Add character", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Draft companion");
  api.setLock(true);
  await expect(dialog.getByLabel("Name", { exact: true })).toBeDisabled({ timeout: 7000 });
  await expect(dialog).toContainText("Finish or resolve");
  api.setLock(false);
  await expect(dialog.getByLabel("Name", { exact: true })).toBeEnabled({ timeout: 7000 });
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Draft companion");
});

for (const surface of ["Story", "Nexus"]) test(`${surface} world profile badges and reset, clear and restore focus`, async ({ page }) => {
  await fixture(page, false, true, false, false, true); if (surface === "Story") await open(page); else await openNexusCampaignCharacters(page);
  const dialog = page.locator("#campaignCastDialog");
  await dialog.getByRole("button", { name: "Mara", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit character", exact: true }).click();
  await expect(dialog).toContainText("Edited for this campaign");
  await expect(dialog).toContainText("Added for this campaign");
  const role = dialog.locator("#cast-story-role");
  await role.locator("..").getByRole("button", { name: "Reset to world value" }).click();
  await expect(role).toHaveValue("Guide"); await expect(role).toBeFocused();
  const personality = dialog.locator("#cast-story-personality");
  await personality.locator("..").getByRole("button", { name: "Clear", exact: true }).click();
  await expect(personality).toHaveValue(""); await expect(personality).toBeFocused();
  if (surface === "Nexus") await selectEditorSection(dialog, "situation");
  const goals = dialog.locator("#cast-story-goals");
  await goals.locator("..").getByRole("button", { name: "Restore authored goals" }).click();
  await expect(goals).toHaveValue("Find home"); await expect(goals).toBeFocused();
});

test("Story opens the character named by the deep link", async ({ page }) => {
  await fixture(page, false, true, false, false, false, true);
  const dialog = page.locator("#campaignCastDialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Mara");
  await expect(dialog.getByRole("button", { name: "Edit character", exact: true })).toBeVisible();
});

for (const surface of ["Story", "Nexus"]) test(`${surface} world profile conflict preserves and reapplies the draft`, async ({ page }) => {
  const api = await fixture(page, false, true, false, false, true); if (surface === "Story") await open(page); else await openNexusCampaignCharacters(page);
  const dialog = page.locator("#campaignCastDialog");
  await dialog.getByRole("button", { name: "Mara", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit character", exact: true }).click();
  await dialog.locator("#cast-story-role").fill("Navigator");
  api.conflict();
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await expect(dialog.locator("#cast-story-role")).toHaveValue("Navigator");
  if (surface === "Nexus") await selectEditorSection(dialog, "sources");
  await dialog.getByRole("button", { name: "Compare latest" }).click();
  await dialog.getByRole("button", { name: "Reapply my changes" }).click();
  await expect(dialog.locator("#cast-story-role")).toHaveValue("Navigator");
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  expect(api.writes.at(-1).set["story.role"]).toBe("Navigator");
});

for (const surface of ["Story", "Nexus"]) for (const seeded of [false, true]) test(`${surface} reviews fenced facts in the ${seeded ? "preset" : "supporting"} editor`, async ({ page }) => {
  if (!seeded) await page.setViewportSize({ width: 390, height: 844 });
  const api = await fixture(page, false, true, false, false, seeded, surface === "Story", true);
  if (surface === "Nexus") { await openNexusCampaignCharacters(page); await page.locator("#campaignCastDialog").getByRole("button", { name: "Mara", exact: true }).click(); }
  const quote = "Mara was raised at the lighthouse.", path = "story.background", value = "raised at the lighthouse";
  const span = { evidenceId: worldId, characterId: candidateId, turnId: versionId, turnNumber: 1, narrationRevision: 0,
    sourceHash: "a".repeat(64), paragraphId: "p1", start: 0, end: quote.length, quote };
  const fence = { path, value, evidence: [span] };
  let previews = 0, rejected = false;
  await page.route("**/draft-preview", async route => {
    previews++;
    expect(route.request().postDataJSON()).toMatchObject({ expectedCastRevision: !seeded && rejected ? 1 : 0, expectedCharacterRevision: 0, direction: "Early years" });
    await route.fulfill({ json: { boundary: { turnNumber: 1, timelineRevision: 0 }, characterRevision: 0,
      proposals: [{ path, value, evidenceIds: [span.evidenceId], draftEvidenceFence: fence },
        ...(seeded ? [{ path: "story.otherGuidance", value: "Let the tide set the mood.", evidenceIds: [] }] : [])],
      evidence: [span], omitted: [{ path: "story.role", reason: "already_observed" }] } });
  });
  await page.route(seeded ? "**/authored-profile" : `**/cast/${candidateId}`, async route => {
    if (route.request().method() === "GET" || rejected) return route.fallback();
    expect(route.request().postDataJSON().draftEvidenceFences).toEqual([fence]); rejected = true;
    if (!seeded) api.advanceRevision();
    return route.fulfill({ status: 409, json: { code: "cast_draft_evidence_changed", message: "Evidence changed" } });
  });
  const dialog = page.locator("#campaignCastDialog");
  await dialog.getByRole("button", { name: "Edit character", exact: true }).click();
  if (surface === "Nexus") await selectEditorSection(dialog, "sources");
  const direction = dialog.getByLabel("Direction (optional)"); await direction.fill("Early years");
  const draft = dialog.getByRole("button", { name: "Draft from story", exact: true });
  if (surface === "Story") { api.setLock(true); await expect(draft).toBeDisabled({ timeout: 8000 }); api.setLock(false); }
  await expect(draft).toBeEnabled({ timeout: 8000 }); await draft.click();
  await expect(dialog.getByText(quote, { exact: true })).toBeVisible(); await expect(dialog.getByRole("button", { name: "Turn 1", exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("Current: Blank", { exact: true }).first()).toBeVisible();
  if (seeded) await expect(dialog.getByText("Creative guidance: Let the tide set the mood.")).toBeVisible();
  await dialog.getByRole("button", { name: "Apply selected suggestions" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/review-assets/unified-character-editor-phase-5/story-draft-${seeded ? "preset" : "supporting"}.png` });
  await dialog.getByRole("button", { name: "Apply selected suggestions" }).click(); expect(api.writes).toEqual([]);
  await expect(dialog.locator("#cast-story-background")).toHaveValue(value);
  await dialog.getByRole("button", { name: "Save character", exact: true }).click(); await expect(dialog).toContainText("Run Draft from story again");
  await expect(dialog.locator("#cast-story-background")).toHaveValue(value); await draft.click();
  if (!seeded) {
    await expect(dialog).toContainText("Compare the latest values below");
    await dialog.getByRole("button", { name: "Reapply my changes" }).click();
    await draft.click();
  }
  await dialog.getByRole("button", { name: "Apply selected suggestions" }).click();
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0].draftEvidenceFences).toEqual([fence]); expect(previews).toBe(2);
  if (seeded) expect(api.writes[0].set["story.otherGuidance"]).toBe("Let the tide set the mood.");
});

for (const eligible of [false, true]) test(`Story keeps manual editing available with ${eligible ? "an offline provider" : "no eligible evidence"}`, async ({ page }) => {
  const api = await fixture(page, false, true, false, false, false, true, eligible);
  let previews = 0;
  await page.route("**/draft-preview", route => {
    previews++; return route.fulfill({ status: 503, json: { code: "cast_discovery_unavailable" } });
  });
  const dialog = page.locator("#campaignCastDialog");
  await dialog.getByRole("button", { name: "Edit character", exact: true }).click();
  const field = dialog.locator("#cast-story-background");
  const disclosure = field.locator("xpath=ancestor::details[1]");
  if (!await field.isVisible()) await disclosure.locator("summary").click();
  await field.fill("Written by hand");
  const draft = dialog.getByRole("button", { name: "Draft from story", exact: true });
  if (eligible) {
    await draft.click(); await expect(dialog).toContainText("Check the campaign text provider");
  } else {
    await expect(draft).toBeDisabled(); await expect(dialog).toContainText("An eligible story citation is required");
  }
  await expect(field).toHaveValue("Written by hand"); expect(api.writes).toEqual([]);
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await expect.poll(() => api.writes.length).toBe(1); expect(api.writes[0].draftEvidenceFences).toBeUndefined();
  expect(previews).toBe(Number(eligible));
});


for (const width of [1280, 390]) test(`lifecycle review, merge, undo, remove and promotion at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await fixture(page, false, true);
  const sourceId = "99999999-9999-4999-8999-999999999999", mergeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const boundary = { turnNumber: 1, timelineRevision: 0 }, writes: any[] = [];
  const undoAliases = [...Array.from({ length: 20 }, (_, index) => "Alias " + (index + 1)), "Harbor guide"];
  let retryUndo = true;
  let revision = 0, removed = false, merged = false, stale = true, delayPreview = false;
  let releasePreview: (() => void) | undefined;
  const previewGate = new Promise<void>(resolve => { releasePreview = resolve; });
  const person = () => ({ id: candidateId, name: "Mara", aliases: [], origin: { kind: "manual" }, profile: { "story.role": "Guide" }, pinned: false, ignored: false, revision, firstObservedTurn: 1, lastObservedTurn: 1, removed, activeMerges: merged ? [{ mergeEventId: mergeId, sourceCharacterId: sourceId, sourceName: "Sera", canUndo: true }] : [] });
  const source = () => ({ id: sourceId, name: "Sera", aliases: [], origin: { kind: "discovered" }, profile: { "story.role": "Guard" }, pinned: false, ignored: false, removed: false, revision: 0, firstObservedTurn: 1, lastObservedTurn: 1 });
  const detail = (character: any) => ({ character, revision, boundary, observations: [], overrides: [], autoMatches: [], identityEvents: [], unresolvedCandidateIds: [], editorDestination: null, capabilities: { castEditing: true, castLifecycle: true } });
  await page.route("**/api/v1/**", async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname, tail = path.split("/cast/")[1];
    const send = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === "/api/v1/worlds") return send({ worlds: [{ id: worldId, title: "Fixture world", status: "active" }] });
    if (path.endsWith("/cast")) {
      const filter = url.searchParams.get("filter"), people = filter === "removed" ? (removed ? [person()] : []) : [person(), ...(merged ? [] : [source()])].filter(item => !item.removed);
      return send({ revision, boundary, characters: people, nextCursor: null, capabilities: { castEditing: true, castLifecycle: true } });
    }
    if (tail === candidateId) return send(detail(person()));
    if (tail === sourceId) return send(detail(source()));
    if (tail === `${candidateId}/merge-preview`) { if (delayPreview) await previewGate; return send({ target: (({ capabilities, ...rest }) => rest)(detail(person())), source: (({ capabilities, ...rest }) => rest)(detail(source())), aliasCandidates: Array.from({ length: 21 }, (_, i) => `Alias ${i + 1}`), fields: [{ path: "story.role", target: "Guide", source: "Guard", choiceRequired: true, defaultChoice: null, allowedChoices: ["target", "source"] }] }); }
    if (tail === `${candidateId}/unmerge-preview`) return send({ target: { ...person(), aliases: undoAliases }, source: source(), revision, boundary, expectedCharacterRevision: revision, expectedSourceCharacterRevision: 0 });
    if (tail === `${candidateId}/promotion-preview`) return send({ worldId, draftRevision: stale ? 1 : 2, characterRevision: revision, castRevision: revision, boundary,
      destinations: [{ path: "name", candidates: [{ sourcePath: "name", value: "Mara" }], tickedByDefault: true, requiredOnAdd: true }, { path: "appearance.otherVisualDetails", candidates: [{ sourcePath: "authored.appearance.otherVisualDetails", value: "Brown coat" }, { sourcePath: "observed.appearance.description", value: "Blue coat" }], tickedByDefault: false, requiredOnAdd: false }, { path: "story.goals", candidates: [{ sourcePath: "observed.story.goals", value: "Find home" }], tickedByDefault: false, requiredOnAdd: false }], matches: [{ characterId: "existing", name: "Mara" }] });
    if (tail && req.method() === "POST") {
      const input = req.postDataJSON(); writes.push({ tail, input });
      if (tail.endsWith("/unmerge") && retryUndo) { retryUndo = false; return send({ code: "unavailable", message: "Try again" }, 503); }
      if (tail.endsWith("/promote")) { if (stale) { stale = false; return send({ code: "cast_promotion_conflict", message: "Changed" }, 409); } return send({ worldId, draftRevision: 3, characterId: input.targetCharacterId ?? "new" }); }
      revision++; if (tail.endsWith("/merge")) merged = true; if (tail.endsWith("/unmerge")) merged = false;
      if (tail.endsWith("/remove")) removed = true; if (tail.endsWith("/restore")) removed = false;
      return send({ character: person(), revision, boundary });
    }
    return route.fallback();
  });
  const root = "test-results/review-assets/unified-character-editor-phase-6"; await mkdir(root, { recursive: true });
  const capture = async (name: string) => page.screenshot({ path: `${root}/${name}-${width}.png` });
  if (width === 390) await openNexusCampaignCharacters(page);
  else await open(page);
  const workspace = page.locator("#campaignCastDialog");
  await workspace.getByRole("button", { name: "Mara", exact: true }).click();
  const mergeButton = workspace.getByRole("button", { name: "Merge with another character" });
  await mergeButton.focus(); await page.keyboard.press("Enter");
  await expect(page.locator("dialog.cast-lifecycle")).toBeVisible();
  await page.keyboard.press("Escape"); await expect(mergeButton).toBeFocused();
  delayPreview = true; await page.keyboard.press("Enter");
  let dialog = page.locator("dialog.cast-lifecycle"); await dialog.getByRole("button", { name: "Sera", exact: true }).click();
  await expect(dialog).toContainText("Loading both characters"); await dialog.getByRole("button", { name: "Cancel" }).click();
  delayPreview = false; releasePreview!(); await expect(dialog).toHaveCount(0); expect(writes).toHaveLength(0);
  if (width === 390) {
    await workspace.getByRole("button", { name: "Back to characters" }).click();
    await workspace.getByRole("button", { name: "Sera", exact: true }).click();
    await mergeButton.click();
    await expect(dialog.getByLabel("Character to keep")).toHaveValue("selected");
    await expect(dialog.getByRole("button", { name: "Mara", exact: true })).toBeVisible();
    await capture("merge-destination");
    await dialog.getByRole("button", { name: "Mara", exact: true }).click();
  } else {
    await mergeButton.click();
    await dialog.getByRole("button", { name: "Sera", exact: true }).click();
  }
  await expect(dialog).toContainText("Merge Sera into Mara.");
  await expect(dialog.getByText("Aliases to keep")).toBeVisible(); await capture("merge");
  await dialog.getByRole("button", { name: "Confirm merge" }).click(); await expect(dialog).toContainText("Select at most 20 aliases"); await capture("merge-validation"); expect(writes).toHaveLength(0);
  await dialog.getByLabel("Alias 21").uncheck(); await dialog.getByRole("button", { name: "Confirm merge" }).click(); await expect(dialog).toContainText("Choose a value for"); expect(writes).toHaveLength(0);
  await dialog.locator("select").selectOption("source"); await dialog.getByRole("button", { name: "Confirm merge" }).click();
  await expect(dialog).toHaveCount(0); expect(writes.at(-1).input.reviewedAliases).toHaveLength(20); expect(writes.at(-1).input.choices["story.role"]).toBe("source");
  expect(writes.at(-1)).toMatchObject({ tail: `${candidateId}/merge`, input: { sourceCharacterId: sourceId } });
  await workspace.getByRole("button", { name: "Undo merge" }).click(); dialog = page.locator("dialog.cast-lifecycle"); await expect(dialog.getByText("Review undo merge")).toBeVisible(); await capture("undo");
  const confirmUndo = dialog.getByRole("button", { name: "Confirm undo merge" });
  await expect(confirmUndo).toBeDisabled();
  await expect(dialog.getByLabel("Harbor guide")).toBeChecked();
  await expect(dialog.getByText("21 selected (maximum 20)")).toBeVisible();
  const finalRoot = "test-results/review-assets/unified-character-editor-final-review";
  await mkdir(finalRoot, { recursive: true });
  await page.screenshot({ path: `${finalRoot}/undo-alias-selection-${width}.png` });
  await dialog.getByLabel("Alias 1", { exact: true }).uncheck();
  await expect(dialog.getByText("20 selected (maximum 20)")).toBeVisible();
  await confirmUndo.click(); await expect(confirmUndo).toBeEnabled();
  const attemptedUndo = writes.at(-1).input;
  expect(attemptedUndo.reviewedAliases).toEqual(undoAliases.slice(1));
  await confirmUndo.click(); await expect(dialog).toHaveCount(0);
  expect(writes.at(-1).input).toEqual(attemptedUndo);
  await workspace.getByRole("button", { name: "Remove from cast" }).click(); dialog = page.locator("dialog.cast-lifecycle"); await capture("removed"); await dialog.getByRole("button", { name: "Confirm remove" }).click();
  await expect(dialog).toHaveCount(0);
  await workspace.getByRole("button", { name: "Add character", exact: true }).click();
  await workspace.getByLabel("Name", { exact: true }).fill("ＭＡＲＡ");
  await expect(workspace.getByText("A removed character holds this name. Restore them instead.")).toBeVisible();
  await expect(workspace.locator("#cast-save")).toBeDisabled();
  await capture("held-name");
  await workspace.getByLabel("Name", { exact: true }).fill("New person");
  if (width === 390) { await workspace.getByRole("button", { name: "Continue in detailed editor" }).click(); await selectEditorSection(workspace, "identity"); }
  await workspace.getByLabel("Aliases (one per line)").fill("mara");
  await expect(workspace.getByText("A removed character holds this name. Restore them instead.")).toBeVisible();
  await workspace.getByLabel("Aliases (one per line)").fill("");
  if (width === 390) await selectEditorSection(workspace, "overview");
  await workspace.getByLabel("Name", { exact: true }).fill("ＭＡＲＡ");
  await workspace.getByRole("button", { name: "Restore Mara" }).click();
  const unsaved = workspace.getByRole("alertdialog", { name: "Unsaved character changes" });
  await expect(unsaved.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await unsaved.getByRole("button", { name: "Keep editing" }).click();
  await expect(workspace.getByLabel("Name", { exact: true })).toHaveValue("ＭＡＲＡ");
  await workspace.getByRole("button", { name: "Restore Mara" }).click();
  await unsaved.getByRole("button", { name: "Discard changes" }).click();
  await workspace.getByRole("button", { name: "Restore", exact: true }).click(); dialog = page.locator("dialog.cast-lifecycle"); await capture("restore"); await dialog.getByRole("button", { name: "Restore character" }).click(); await expect(dialog).toHaveCount(0);
  await workspace.getByRole("button", { name: "Add to world draft" }).click(); dialog = page.locator("dialog.cast-lifecycle"); await dialog.getByRole("button", { name: "Review fields" }).click(); await expect(dialog.getByText("Review world draft fields")).toBeVisible();
  await expect(dialog.getByLabel("Source for Other visual details").getByRole("option", { name: /Authored profile.*Brown coat/ })).toHaveCount(1);
  await expect(dialog.getByLabel("Source for Other visual details").getByRole("option", { name: /Observed in story.*Blue coat/ })).toHaveCount(1);
  await expect(dialog).not.toContainText("observed.story.goals"); await capture("promote");
  await dialog.getByRole("button", { name: "Confirm draft change" }).click(); await expect(dialog).toContainText("changed"); await capture("promote-stale"); await dialog.getByRole("button", { name: "Refresh preview" }).click();
  await dialog.getByLabel("Destination").selectOption("existing"); await dialog.getByLabel("Other visual details", { exact: true }).check(); await dialog.getByLabel("Source for Other visual details").selectOption("observed.appearance.description");
  await dialog.getByRole("button", { name: "Confirm draft change" }).click(); await expect(dialog).toHaveCount(0);
  expect(writes.at(-1).input).toMatchObject({ mode: "replace", targetCharacterId: "existing", selections: [{ destinationPath: "appearance.otherVisualDetails", sourcePath: "observed.appearance.description" }] });
  await workspace.getByRole("button", { name: "Add to world draft" }).click(); dialog = page.locator("dialog.cast-lifecycle");
  await dialog.getByRole("button", { name: "Review fields" }).click();
  await expect(dialog.getByLabel("Name", { exact: true })).toBeChecked();
  await expect(dialog.getByLabel("Goals", { exact: true })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Confirm draft change" }).click(); await expect(dialog).toHaveCount(0);
  expect(writes.at(-1).input).toMatchObject({ mode: "add", selections: [{ destinationPath: "name", sourcePath: "name" }] });
});


for (const castLifecycle of [false, true]) test(`campaign settings shows whether character merging is enabled: ${castLifecycle}`, async ({ page }) => {
  const data = legacyUiFixture({ turnCount: 1, campaignCount: 1, worldCount: 1 });
  await installLegacyUiFixture(page, data);
  const boundary = { turnNumber: 1, timelineRevision: 0 };
  const person = { id: candidateId, name: "Mara", aliases: [], origin: { kind: "manual" }, profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 1, lastObservedTurn: 1 };
  const capabilities = { castEditing: true, castLifecycle };
  await page.route("**/api/v1/meta", route => route.fulfill({ json: { application: { name: "Nexus", version: "test", commit: null, builtAt: null }, capabilities } }));
  await page.route("**/cast**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(`/cast/${candidateId}`)) return route.fulfill({ json: { character: person, revision: 0, boundary, observations: [], overrides: [], autoMatches: [], identityEvents: [], unresolvedCandidateIds: [], editorDestination: null, capabilities } });
    if (path.endsWith("/cast")) return route.fulfill({ json: { revision: 0, boundary, characters: [person], nextCursor: null, capabilities } });
    return route.fallback();
  });
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? 43173}/nexus/index.html#campaigns`);
  await page.locator(`#campaignList [data-campaign-id="${data.campaignId}"]`).click();
  await page.locator("#editCampaignCharacter").click();
  const sheet = page.locator("#campaignCastDialog"); await sheet.getByRole("button", { name: "Mara", exact: true }).click();
  if (!castLifecycle) {
    await expect(sheet).toContainText("Character merging is disabled on this server.");
    await expect(sheet.getByRole("button", { name: "Merge with another character" })).toHaveCount(0);
    return;
  }
  await expect(sheet.getByRole("button", { name: "Merge with another character" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Remove from cast" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Add to world draft" })).toBeVisible();
});


test("rollback keeps Removed readable while lifecycle actions are unavailable", async ({ page }) => {
  await fixture(page, false, true);
  const boundary = { turnNumber: 1, timelineRevision: 0 };
  const person = { id: candidateId, name: "Mara", aliases: [], origin: { kind: "manual" }, profile: {}, pinned: false, ignored: false, removed: true, revision: 1, firstObservedTurn: 1, lastObservedTurn: 1 };
  let writes = 0;
  await page.route("**/api/v1/**", route => {
    const req = route.request(), url = new URL(req.url());
    if (!url.pathname.includes("/cast")) return route.fallback();
    if (req.method() !== "GET") { writes++; return route.fulfill({ status: 503, json: { code: "cast_lifecycle_disabled" } }); }
    if (url.pathname.endsWith(`/cast/${candidateId}`)) return route.fulfill({ json: { character: person, revision: 1, boundary, observations: [], overrides: [], autoMatches: [], identityEvents: [], unresolvedCandidateIds: [], editorDestination: null, capabilities: { castEditing: true, castLifecycle: false } } });
    if (url.pathname.endsWith("/cast")) return route.fulfill({ json: { revision: 1, boundary, characters: url.searchParams.get("filter") === "removed" ? [person] : [], nextCursor: null, capabilities: { castEditing: true, castLifecycle: false } } });
    return route.fallback();
  });
  await open(page); const sheet = page.locator("#campaignCastDialog");
  await expect(sheet.getByLabel("Filter").getByRole("option", { name: "Removed" })).toHaveCount(1);
  await sheet.getByLabel("Filter").selectOption("removed"); await sheet.getByRole("button", { name: "Mara", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "Restore", exact: true })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Merge with another character" })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Edit character" })).toHaveCount(0);
  expect(writes).toBe(0);
});

for (const width of [1280, 390]) test(`Nexus campaign quick creation keeps one draft through detailed sections at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const api = await fixture(page); await openNexusCampaignCharacters(page);
  const dialog = page.locator('#campaignCastDialog');
  await dialog.getByRole('button', { name: 'Add character', exact: true }).click();
  await expect(dialog.locator('.character-quick-create')).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill('Quick companion');
  await dialog.getByLabel('Role', { exact: true }).fill('Guide');
  await dialog.getByLabel('Personality', { exact: true }).fill('Patient');
  await expect(dialog.getByLabel('Use in campaigns')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Continue in detailed editor' }).click();
  await expect(dialog.locator('.character-workspace')).toBeVisible();
  await expect(dialog.locator('.character-workspace-fields').getByRole('textbox').first()).toHaveAccessibleName('Name');
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Quick companion');
  await expect(dialog.getByLabel('Role', { exact: true })).toHaveValue('Guide');
  await dialog.getByRole('button', { name: 'Preview sheet', exact: true }).click();
  await expect(dialog.locator('.character-workspace-preview')).toContainText('Role: Guide');
  await expect(dialog.locator('.character-workspace-preview')).not.toContainText('story.role');
  await dialog.getByRole('button', { name: 'Return to editing', exact: true }).click();
  await page.screenshot({ path: process.env.CAST_SCREENSHOT_ROOT ? `${process.env.CAST_SCREENSHOT_ROOT}/campaign-supporting-detail-${width}.png` : info.outputPath(`campaign-supporting-detail-${width}.png`) });
  await dialog.getByRole('button', { name: 'Save character', exact: true }).click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0]).toMatchObject({ name: 'Quick companion', profile: { 'story.role': 'Guide', 'story.personality': 'Patient' } });
  await expect(dialog.locator('.character-workspace')).toHaveCount(0);
  await expect(dialog.getByRole('heading', { name: 'Quick companion', exact: true })).toBeVisible();
});


test("Nexus dirty editor stages lifecycle entry and cancellation preserves its draft", async ({ page }) => {
  const api = await fixture(page, false, true);
  await page.route("**/cast?*", route => route.fulfill({ json: { revision: 0, boundary: { turnNumber: 1, timelineRevision: 0 }, characters: api.characters, nextCursor: null, capabilities: { castEditing: true, castLifecycle: true } } }));
  await page.route(`**/cast/${candidateId}`, route => route.fulfill({ json: { revision: 0, boundary: { turnNumber: 1, timelineRevision: 0 }, character: api.characters.find(person => person.id === candidateId), observations: [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], editorDestination: null, capabilities: { castEditing: true, castLifecycle: true } } }));
  await openNexusCampaignCharacters(page);
  const dialog = page.locator('#campaignCastDialog');
  await dialog.getByRole('button', { name: 'Mara', exact: true }).click();
  await dialog.getByRole('button', { name: 'Edit character', exact: true }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Uncommitted Mara');
  await selectEditorSection(dialog, "sources");
  for (const name of ['Merge with another character', 'Remove from cast', 'Add to world draft']) {
    await dialog.getByRole('button', { name, exact: true }).click();
    const prompt = dialog.getByRole('alertdialog', { name: 'Unsaved character changes' });
    await expect(prompt).toBeVisible();
    await expect(page.locator('dialog.cast-lifecycle')).toHaveCount(0);
    await prompt.getByRole('button', { name: 'Keep editing' }).click();
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Uncommitted Mara');
  }
});


test("Nexus preset validation reveals identity without losing section draft", async ({ page }) => {
  await fixture(page, false, true, false, false, true); await openNexusCampaignCharacters(page);
  const dialog = page.locator('#campaignCastDialog');
  await dialog.getByRole('button', { name: 'Mara', exact: true }).click();
  await dialog.getByRole('button', { name: 'Edit character', exact: true }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('');
  await selectEditorSection(dialog, 'personality');
  await dialog.getByRole('button', { name: 'Save character', exact: true }).click();
  await expect(dialog.getByLabel('Name', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
  await dialog.getByLabel('Name', { exact: true }).fill('Repaired Mara');
  await selectEditorSection(dialog, 'sources');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(dialog.getByRole('navigation', { name: 'Character sections' }).getByRole('button', { name: /^Sources and history/ })).toHaveAttribute('aria-current', 'true');
});


for (const seeded of [false, true]) test(`Nexus ${seeded ? 'preset' : 'supporting'} ignores late story draft after switching character`, async ({ page }) => {
  await fixture(page, false, true, false, false, seeded, false, true); await openNexusCampaignCharacters(page);
  const dialog = page.locator('#campaignCastDialog');
  await dialog.getByRole('button', { name: 'Mara', exact: true }).click();
  await dialog.getByRole('button', { name: 'Edit character', exact: true }).click();
  await selectEditorSection(dialog, 'sources');
  let release!: () => void; let started = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/draft-preview', async route => { started = true; await gate; await route.fulfill({ json: { boundary: { turnNumber: 1, timelineRevision: 0 }, characterRevision: 0, proposals: [{ path: 'story.otherGuidance', value: 'Late old-character advice', evidenceIds: [] }], evidence: [], omitted: [] } }); });
  await dialog.getByRole('button', { name: 'Draft from story', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await dialog.getByRole('button', { name: 'Back', exact: true }).click();
  await dialog.getByRole('button', { name: 'Iven', exact: true }).click();
  release();
  await expect(dialog.getByRole('heading', { name: 'Iven', exact: true })).toBeVisible();
  await expect(dialog).not.toContainText('Late old-character advice');
  await expect(dialog.getByRole('button', { name: 'Apply selected suggestions', exact: true })).toHaveCount(0);
});


test("Nexus manual quick and detailed creation validate name and retain authored input without writes", async ({ page }) => {
  const api = await fixture(page); await openNexusCampaignCharacters(page);
  const dialog = page.locator('#campaignCastDialog');
  await dialog.getByRole('button', { name: 'Add character', exact: true }).click();
  await dialog.getByLabel('Role', { exact: true }).fill('Remember this guide');
  await dialog.getByRole('button', { name: 'Create campaign character', exact: true }).click();
  await expect(dialog).toContainText('Enter a character name.');
  await expect(dialog.getByLabel('Role', { exact: true })).toHaveValue('Remember this guide');
  expect(api.writes).toEqual([]);
  await dialog.getByRole('button', { name: 'Continue in detailed editor' }).click();
  await selectEditorSection(dialog, 'identity');
  await dialog.getByRole('button', { name: 'Save character', exact: true }).click();
  await expect(dialog.getByLabel('Name', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
  await expect(dialog).toContainText('Enter a character name.');
  await expect(dialog.getByLabel('Role', { exact: true })).toHaveValue('Remember this guide');
  expect(api.writes).toEqual([]);
});


for (const action of ['reset', 'clear', 'restore', 'discover']) test(`Nexus pristine ${action} policy action immediately enables visible Save`, async ({ page }) => {
  const seeded = action !== 'discover';
  const api = await fixture(page, false, true, false, false, seeded);
  if (!seeded) await page.route(`**/cast/${candidateId}`, route => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { revision: 0, boundary: { turnNumber: 1, timelineRevision: 0 }, capabilities: { castEditing: true },
      character: { ...api.characters.find(person => person.id === candidateId), profile: { 'story.role': 'Captain' } },
      observations: [], identityEvents: [], unresolvedCandidateIds: [], editorDestination: null,
      overrides: [{ field: 'story.role', value: 'Captain', evidence: { kind: 'user', editId: protagonistId, effectiveTurnNumber: 1 } }] } });
  });
  await openNexusCampaignCharacters(page);
  const dialog = page.locator('#campaignCastDialog');
  await dialog.getByRole('button', { name: 'Mara', exact: true }).click();
  await dialog.getByRole('button', { name: 'Edit character', exact: true }).click();
  const save = dialog.getByRole('button', { name: 'Save character', exact: true });
  await expect(save).toBeDisabled();
  if (action === 'restore') await selectEditorSection(dialog, 'situation');
  const path = action === 'clear' ? 'personality' : action === 'restore' ? 'goals' : 'role';
  const label = action === 'reset' ? 'Reset to world value' : action === 'clear' ? 'Clear' : action === 'restore' ? 'Restore authored goals' : 'Use discovered value for role';
  await dialog.locator('#cast-story-' + path).locator('..').getByRole('button', { name: label, exact: true }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => api.writes.length).toBe(1);
  if (action === 'reset') expect(api.writes[0].reset).toEqual(['story.role']);
  if (action === 'clear') expect(api.writes[0].reset).toEqual(['story.personality']);
  if (action === 'restore') expect(api.writes[0].restoreAuthoredGoals).toBe(true);
  if (action === 'discover') expect(api.writes[0].clearOverrides).toEqual(['story.role']);
});

test('Nexus adjacent section navigation survives conflict and reapply rerenders at390', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const api = await fixture(page, false, true, false, false, true); await openNexusCampaignCharacters(page);
  const dialog = page.locator('#campaignCastDialog');
  await dialog.getByRole('button', { name: 'Mara', exact: true }).click();
  await dialog.getByRole('button', { name: 'Edit character', exact: true }).click();
  await dialog.locator('#cast-story-role').fill('Navigator');
  await dialog.getByRole('button', { name: 'Next section', exact: true }).click();
  const selector = dialog.getByRole('combobox', { name: 'Section', exact: true });
  await expect(selector).toHaveValue('identity');
  api.conflict(); await dialog.getByRole('button', { name: 'Save character', exact: true }).click();
  await expect(dialog).toContainText('The campaign or character changed');
  await expect(selector).toHaveValue('identity');
  while (await selector.inputValue() !== 'sources') await dialog.getByRole('button', { name: 'Next section', exact: true }).click();
  await dialog.getByRole('button', { name: 'Compare latest', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Reapply my changes', exact: true })).toBeVisible();
  await expect(selector).toHaveValue('sources');
  await dialog.getByRole('button', { name: 'Reapply my changes', exact: true }).click();
  await expect(selector).toHaveValue('sources');
});


for (const surface of ["legacy", "next"] as const) for (const width of [1440, 390]) test(`recoverable review dismissal ${surface} ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const api = await fixture(page, false, false, false, false, false, false, false, true);
  api.characters.push({ id: candidateId, name: "Supporting", aliases: [], origin: { kind: "manual" }, profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 1, lastObservedTurn: 1 });
  if (surface === "legacy") await open(page); else { await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`); await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click(); }
  const dialog = page.locator(surface === "legacy" ? "#campaignCastDialog" : "dialog.characters-workspace");
  await dialog.getByRole("button", { name: "Supporting", exact: true }).click();
  await expect(dialog).toContainText("Removing and restoring characters is disabled on this server.");
  await dialog.getByRole("button", { name: "Back to characters", exact: true }).click();
  await openReview(dialog);
  await expect(dialog.getByRole("button", { name: "Dismiss discovery" })).toBeVisible();
  await dialog.screenshot({ path: info.outputPath(`pending-${surface}-${width}.png`) });
  await dialog.getByRole("button", { name: "Dismiss discovery" }).click();
  await expect(dialog.getByText("Dismissed.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Nothing needs review." })).toBeFocused();
  await dialog.screenshot({ path: info.outputPath(`dismissed-${surface}-${width}.png`) });
  await dialog.getByRole("button", { name: "Dismissed", exact: true }).click();
  await expect(dialog).toContainText("Dismissals made with this review workflow");
  const undoKeys: string[] = [];
  await page.route(`**/cast/candidates/${candidateId}/review-decisions`, route => {
    const input = route.request().postDataJSON(); undoKeys.push(input.idempotencyKey);
    return undoKeys.length === 1 ? route.fulfill({ status: 503, json: { code: "unavailable" } }) : route.fallback();
  });
  await dialog.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(dialog).toContainText("Could not restore this dismissal.");
  await dialog.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(dialog).toContainText("Dismissal undone.");
  expect(undoKeys).toHaveLength(2); expect(undoKeys[0]).toBe(undoKeys[1]);
  await expect(dialog.getByRole("heading", { name: "Identity: Mara" })).toBeFocused();
  expect(api.writes.map((write: any) => write.action)).toEqual(["dismiss_identity", "restore"]);
  await dialog.getByRole("button", { name: "Dismiss discovery" }).click();
  await expect(dialog.getByRole("heading", { name: "Nothing needs review." })).toBeFocused();
  await page.route(`**/cast/candidates/${candidateId}/review-decisions`, route => route.fulfill({ status: 409, json: { code: "cast_revision_conflict" } }));
  await dialog.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(dialog).toContainText("The source or review changed. Reload before deciding.");
  await expect(dialog.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Reload review", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Nothing needs review." })).toBeFocused();
});

for (const surface of ["legacy", "next"] as const) test(`review waits for dismissal and keeps focus on the result ${surface}`, async ({ page }) => {
  const api = await fixture(page, false, false, false, false, false, false, false, true);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  await page.route(`**/cast/candidates/${candidateId}/review-decisions`, async route => {
    calls++; if (calls > 1) return route.fallback(); await gate; return route.fulfill({ status: 503, json: { code: "unavailable" } });
  });
  if (surface === "legacy") await open(page); else { await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`); await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click(); }
  const dialog = page.locator(surface === "legacy" ? "#campaignCastDialog" : "dialog.characters-workspace");
  await openReview(dialog);
  const dismiss = dialog.getByRole("button", { name: "Dismiss discovery" }); await dismiss.click();
  await expect.poll(() => calls).toBe(1);
  await expect(dialog.getByRole("button", { name: "Dismissed", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Back to characters", exact: true })).toBeDisabled();
  await expect(dismiss).toBeDisabled();
  await expect(dialog).toContainText("Identity: Mara");
  await dialog.getByRole("button", { name: "Dismissed", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  await dismiss.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  expect(calls).toBe(1); await expect(dialog).toContainText("Identity: Mara");
  release(); await expect(dialog).toContainText("Could not confirm this decision");
  await expect(dismiss).toBeEnabled(); await expect(dialog.getByRole("button", { name: "Dismissed", exact: true })).toBeEnabled();
  expect(calls).toBe(1); expect(api.writes).toHaveLength(0);
  await dismiss.click(); await expect(dialog.getByRole("heading", { name: "Nothing needs review." })).toBeFocused();
  expect(calls).toBe(2); expect(api.writes).toHaveLength(1);
});

for (const surface of ["legacy", "next"] as const) test(`review focuses the next card after a keyboard dismissal ${surface}`, async ({ page }) => {
  await fixture(page, false, false, false, false, false, false, false, true);
  const secondId = "99999999-9999-4999-8999-999999999999", boundary = { turnNumber: 1, timelineRevision: 0 }, hash = "a".repeat(64);
  let dismissed = false;
  const makeCandidate = (id: string, name: string) => ({ id, reason: "identity_needs_review", reviewRevision: dismissed ? 1 : 0, reviewDetails: [], proposal: { localKey: name, name, aliases: [], existingCharacterId: null, identityEvidence: [{ paragraphId: "p1", quote: `${name} waits.` }], observations: [] }, source: { turnId: "55555555-5555-4555-8555-555555555555", turnNumber: 1, narrationRevision: 0, sourceHash: hash } });
  await page.route("**/cast/candidates?**", route => route.fulfill({ json: { revision: 0, boundary, nextCursor: null, candidates: dismissed ? [makeCandidate(secondId, "Bea")] : [makeCandidate(candidateId, "Ada"), makeCandidate(secondId, "Bea")] } }));
  await page.route(`**/cast/candidates/${candidateId}/review-decisions`, route => { dismissed = true; return route.fulfill({ json: { decisionId: versionId, candidateId, reviewRevision: 1, revision: 0, boundary, disposition: "dismiss_identity" } }); });
  if (surface === "legacy") await open(page); else { await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`); await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click(); }
  const dialog = page.locator(surface === "legacy" ? "#campaignCastDialog" : "dialog.characters-workspace"); await openReview(dialog);
  await expect(dialog.getByRole("heading", { name: "Identity: Ada" })).toBeFocused();
  const dismiss = dialog.getByRole("button", { name: "Dismiss discovery" }); await tabTo(page, dismiss); await page.keyboard.press("Enter");
  await expect(dialog.getByRole("heading", { name: "Identity: Bea" })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
});


test("review controls work at native Chromium 200 percent zoom", async ({}, info) => {
  await mkdir(info.outputDir, { recursive: true });
  const owned = await mkdtemp(resolve(info.outputDir, "review-native-zoom-"));
  const extension = resolve(owned, "extension"); await mkdir(extension);
  await writeFile(resolve(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Review owned zoom probe", version: "1.0.0", permissions: ["tabs"], background: { service_worker: "worker.js" } }));
  await writeFile(resolve(extension, "worker.js"), "chrome.runtime.onInstalled.addListener(() => {});\n");
  const options = { channel: "chromium", headless: true, viewport: null, args: ["--window-size=1280,900", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] };
  Reflect.set(options, "deviceScaleFactor", undefined);
  const context = await chromium.launchPersistentContext(resolve(owned, "profile"), options);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await fixture(page, false, false, false, false, false, false, false, true);
    await open(page); const dialog = page.locator("#campaignCastDialog"); await openReview(dialog);
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const tabId = await worker.evaluate(async expectedOrigin => {
      const chrome = (globalThis as any).chrome;
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const matches = tabs.filter((tab: any) => tab.url && new URL(tab.url).origin === expectedOrigin);
      if (matches.length !== 1) throw new Error("Owned review tab not found");
      await chrome.tabs.setZoomSettings(matches[0].id, { mode: "automatic", scope: "per-tab" });
      await chrome.tabs.setZoom(matches[0].id, 2); return matches[0].id;
    }, new URL(page.url()).origin);
    await expect.poll(() => worker.evaluate(id => (globalThis as any).chrome.tabs.getZoom(id), tabId)).toBe(2);
    const dismiss = dialog.getByRole("button", { name: "Dismiss discovery" });
    await dismiss.focus(); await expect(dismiss).toBeFocused(); await expect(dismiss).toBeInViewport();
    const geometry = await dialog.evaluate(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, viewportWidth: innerWidth, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }; });
    await writeFile(info.outputPath("review-native-zoom-200-geometry.json"), JSON.stringify(geometry, null, 2));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    const capture = async (name: string) => {
      const cdp = await context.newCDPSession(page);
      try { const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); await writeFile(info.outputPath(name), Buffer.from(shot.data, "base64")); }
      finally { await cdp.detach(); }
    };
    await capture("review-native-zoom-200.png");
    await page.keyboard.press("Enter"); await expect(dialog.getByRole("heading", { name: "Nothing needs review." })).toBeFocused();
    await dialog.getByRole("button", { name: "Dismissed", exact: true }).click();
    const undo = dialog.getByRole("button", { name: "Undo", exact: true }); await undo.focus(); await expect(undo).toBeInViewport();
    await capture("review-native-zoom-200-dismissed.png");
    await page.keyboard.press("Enter"); await expect(dialog).toContainText("Dismissal undone.");
  } finally { await context.close(); }
});

for (const surface of ["legacy", "next"] as const) for (const width of [1440, 390]) test(`fact correction preview ${surface} ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const api = await fixture(page, false, true, false, false, false, false, false, false, true);
  if (surface === "legacy") await open(page); else { await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`); await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click(); }
  const dialog = page.locator(surface === "legacy" ? "#campaignCastDialog" : "dialog.characters-workspace");
  await dialog.getByRole("button", { name: "Mara", exact: true }).click();
  await dialog.getByText("Sources and edit history").click();
  await dialog.getByRole("button", { name: "Retract fact" }).click();
  await expect(dialog).toContainText("Before: guide"); await expect(dialog).toContainText("After: Unknown");
  await dialog.screenshot({ path: info.outputPath(`fact-preview-${surface}-${width}.png`) });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); expect(api.writes).toHaveLength(0);
  await dialog.getByRole("button", { name: "Retract fact" }).click();
  await dialog.getByRole("button", { name: "Confirm retraction" }).click();
  await expect(dialog.getByRole("button", { name: "Restore fact" })).toBeVisible();
  await dialog.getByRole("button", { name: "Restore fact" }).click();
  await dialog.getByRole("button", { name: "Confirm restore" }).click();
  await expect(dialog.getByRole("button", { name: "Retract fact" })).toBeVisible();
  expect(api.writes.map(w => w.action)).toEqual(["retract", "restore"]);
});

for (const surface of ["legacy", "next"] as const) test(`fact correction native zoom ${surface}`, async ({}, info) => {
  await mkdir(info.outputDir, { recursive: true });
  const owned = await mkdtemp(resolve(info.outputDir, "fact-zoom-"));
  const extension = resolve(owned, "extension"); await mkdir(extension);
  await writeFile(resolve(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Fact zoom probe", version: "1.0", permissions: ["tabs"], background: { service_worker: "worker.js" } }));
  await writeFile(resolve(extension, "worker.js"), "chrome.runtime.onInstalled.addListener(() => {});\n");
  const options = { channel: "chromium", headless: true, viewport: null, args: ["--window-size=1280,900", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] };
  Reflect.set(options, "deviceScaleFactor", undefined);
  const context = await chromium.launchPersistentContext(resolve(owned, "profile"), options);
  try {
    const page = context.pages()[0] ?? await context.newPage(); await fixture(page, false, true, false, false, false, false, false, false, true);
    if (surface === "legacy") await open(page); else { await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`); await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click(); }
    const dialog = page.locator(surface === "legacy" ? "#campaignCastDialog" : "dialog.characters-workspace");
    await dialog.getByRole("button", { name: "Mara", exact: true }).click(); await dialog.getByText("Sources and edit history").click();
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const tab = await worker.evaluate(async origin => { const chrome = (globalThis as any).chrome; const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); const found = tabs.find((item: any) => item.url && new URL(item.url).origin === origin); if (!found) throw new Error("Owned tab missing"); await chrome.tabs.setZoomSettings(found.id, { mode: "automatic", scope: "per-tab" }); await chrome.tabs.setZoom(found.id, 2); return found.id; }, new URL(page.url()).origin);
    await expect.poll(() => worker.evaluate(id => (globalThis as any).chrome.tabs.getZoom(id), tab)).toBe(2);
    await dialog.getByRole("button", { name: "Retract fact" }).click(); await expect(dialog.getByRole("button", { name: "Confirm retraction" })).toBeFocused();
    const geometry = await dialog.evaluate(el => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })); expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    const cdp = await context.newCDPSession(page); const capture = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); await writeFile(info.outputPath(`fact-native-200-${surface}.png`), Buffer.from(capture.data, "base64"));
  } finally { await context.close(); }
});
for (const surface of ["legacy", "next"] as const) test(`fact correction safeguards ${surface}`, async ({ page }, info) => {
  const api = await fixture(page, false, true, false, false, false, false, false, false, true);
  const boundary = { turnNumber: 1, timelineRevision: 0 };
  const source = { id: protagonistId, characterId: candidateId, field: "story.role", value: "guide", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId: "55555555-5555-4555-8555-555555555555", turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", quote: "Mara waits at the gate." } };
  let previewCalls = 0; const keys: string[] = []; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/decision-preview", route => {
    previewCalls++; if (previewCalls === 1) return route.fulfill({ status: 409, json: { code: "cast_revision_conflict" } });
    const restore = route.request().postDataJSON().action === "restore";
    return route.fulfill({ json: { field: "story.role", currentValue: "captain", projectedValue: restore ? null : "captain", currentConflict: false, projectedConflict: restore, source, castRevision: 0, characterRevision: 0, boundary } });
  });
  await page.route("**/decision", async route => { const input = route.request().postDataJSON(); if (input.action === "restore") return route.fallback(); keys.push(input.idempotencyKey); if (keys.length === 1) { await gate; return route.fulfill({ status: 503, json: { code: "unavailable" } }); } if (keys.length === 2) return route.fulfill({ status: 409, json: { code: "cast_revision_conflict" } }); return route.fallback(); });
  if (surface === "legacy") await open(page); else { await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`); await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click(); }
  const dialog = page.locator(surface === "legacy" ? "#campaignCastDialog" : "dialog.characters-workspace"); await dialog.getByRole("button", { name: "Mara", exact: true }).click(); await dialog.getByText("Sources and edit history").click();
  await dialog.getByRole("button", { name: "Retract fact" }).click(); await expect(dialog).toContainText("Refresh before trying again"); await expect(dialog.getByRole("button", { name: "Confirm retraction" })).toHaveCount(0);
  const reload = dialog.getByRole("button", { name: "Reload character" }); await expect(reload).toBeFocused();
  await dialog.screenshot({ path: info.outputPath(`fact-stale-reload-${surface}.png`) });
  await reload.click(); await expect(dialog.getByText("Sources and edit history")).toBeFocused();
  await dialog.getByRole("button", { name: "Retract fact" }).click(); await expect(dialog).toContainText("displayed value will remain unchanged");
  const confirm = dialog.getByRole("button", { name: "Confirm retraction" }); await confirm.click(); await expect.poll(() => keys.length).toBe(1); await expect(confirm).toBeDisabled(); await confirm.evaluate((el: HTMLButtonElement) => el.click()); expect(keys).toHaveLength(1); release();
  await expect(dialog).toContainText("Retry to check the same request"); await confirm.click();
  await expect(dialog.getByRole("button", { name: "Reload character" })).toBeFocused(); expect(keys[0]).toBe(keys[1]);
  await dialog.getByRole("button", { name: "Reload character" }).click(); await expect(dialog.getByText("Sources and edit history")).toBeFocused();
  await dialog.getByRole("button", { name: "Retract fact" }).click(); await dialog.getByRole("button", { name: "Confirm retraction" }).click();
  await expect(dialog.getByRole("button", { name: "Restore fact" })).toBeVisible(); expect(keys[2]).not.toBe(keys[1]);
  await dialog.getByRole("button", { name: "Restore fact" }).click(); await expect(dialog).toContainText("After: Conflicting observations"); await dialog.getByRole("button", { name: "Confirm restore" }).click(); await expect(dialog.getByRole("button", { name: "Retract fact" })).toBeVisible(); expect(api.writes.map(w => w.action)).toEqual(["retract", "restore"]);
});

for (const surface of ["legacy", "next"] as const) for (const invalid of [false, true]) test(`fact correction ${invalid ? "invalid history" : "old API"} ${surface}`, async ({ page }) => {
  const api = await fixture(page, false, true, false, false, false, false, false, false, invalid); if (invalid) api.setInvalidSource();
  if (surface === "legacy") await open(page); else { await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`); await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click(); }
  const dialog = page.locator(surface === "legacy" ? "#campaignCastDialog" : "dialog.characters-workspace"); await dialog.getByRole("button", { name: "Mara", exact: true }).click(); await dialog.getByText("Sources and edit history").click();
  if (invalid) { await expect(dialog).toContainText("Retracted fact"); await expect(dialog).toContainText("no longer eligible for restoration"); }
  await expect(dialog.getByRole("button", { name: "Restore fact" })).toHaveCount(0); await expect(dialog.getByRole("button", { name: "Retract fact" })).toHaveCount(0); expect(api.writes).toHaveLength(0);
});
for (const surface of ["legacy", "next"] as const) test(`pending retracted source keeps explicit override ${surface}`, async ({ page }) => {
  const api = await fixture(page, false, true); const boundary = { turnNumber: 1, timelineRevision: 0 };
  const candidate = { id: candidateId, reason: "detail_needs_review", resolvedCharacterId: candidateId, proposal: { localKey: "mara", name: "Mara", aliases: [], existingCharacterId: null, identityEvidence: [{ paragraphId: "p1", quote: "Mara waits." }], observations: [] }, source: { turnId: "55555555-5555-4555-8555-555555555555", turnNumber: 1, narrationRevision: 0 }, details: [{ observationIndex: 4, field: "story.role", value: "guide", quote: "Mara waits.", reason: "unverified", canAcceptObservation: false, acceptDisabledReason: "retracted_source", allowedActions: ["confirm", "dismiss"], sourceHash: "a".repeat(64) }] };
  await page.route("**/cast/candidates?**", route => route.fulfill({ json: { revision: 0, boundary, nextCursor: null, candidates: [candidate] } }));
  if (surface === "legacy") await open(page); else { await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`); await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click(); }
  const dialog = page.locator(surface === "legacy" ? "#campaignCastDialog" : "dialog.characters-workspace"); await openReview(dialog);
  await expect(dialog).toContainText("This source was retracted"); await expect(dialog.getByRole("button", { name: "Apply and next" })).toHaveCount(0); await dialog.getByText("Set an override", { exact: true }).click(); await expect(dialog.getByRole("button", { name: "Keep as override" })).toBeVisible(); expect(api.writes).toHaveLength(0);
});
