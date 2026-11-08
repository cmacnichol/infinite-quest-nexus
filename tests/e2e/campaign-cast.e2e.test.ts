import { tabTo } from "./helpers/keyboard.js";
import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Route, type Locator } from "@playwright/test";

const campaignId = "11111111-1111-4111-8111-111111111111";
const worldId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
const protagonistId = "66666666-6666-4666-8666-666666666666";
const candidateId = "88888888-8888-4888-8888-888888888888";
const screenshotRoot = process.env.CAST_SCREENSHOT_ROOT;

async function openReview(dialog: Locator) {
  if (await dialog.getAttribute("id") === "campaignCastDialog") {
    await dialog.getByRole("button", { name: "Needs attention", exact: true }).click();
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
  await dialog.getByRole("button", { name: "Scan earlier story", exact: true }).click();
  await expect(dialog).toContainText("2 character matches need review");
  const retry = dialog.getByRole("button", { name: "Retry turn 1", exact: true });
  await retry.click(); await expect(dialog).toContainText("Could not update the scan");
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
  await retry.click(); await expect(retry).toBeDisabled();
  await expect(dialog).toContainText("Refresh characters before retrying");
  if (screenshotRoot) await page.screenshot({ path: `${screenshotRoot}/retry-conflict-desktop.png`, fullPage: true });
  await dialog.getByRole("button", { name: "Refresh characters", exact: true }).click(); await expect(retry).toBeEnabled();
  api.disable();
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
  await retry.click(); await expect(dialog).toContainText("Check the text provider settings");
  if (screenshotRoot) await page.screenshot({ path: `${screenshotRoot}/retry-recovery-390.png`, fullPage: true });
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

async function fixture(page: Page, deferredDetails = false, conflictFixture = false) {
  let revision = 0, enabled = true, conflict = false, trackingComplete = false, trackingUnavailable = false, pendingMatch = true;
  let resolvedCharacterId: string | undefined;
  const characters: any[] = [{ id: protagonistId, name: "Iven", aliases: [], origin: { kind: "protagonist", selectedCharacterId: null },
    profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 0, lastObservedTurn: 1 }];
  if (conflictFixture) characters.push({ id: candidateId, name: "Mara", aliases: [], origin: { kind: "manual" }, profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 1, lastObservedTurn: 1 });
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
      if (id === "context-preview") return send(route, { mode: "estimate", boundary, castRevision: revision, budgetTokens: 500, usedTokens: 25, coverage: { fromTurn: 1, throughTurn: 1, baseTurn: 1, current: true }, selected: [{ characterId: protagonistId, name: "Iven", reason: "pinned" }], omitted: [{ characterId: candidateId, reason: "budget" }], disabledReason: null });
      if (id === "workspace-status") return send(route, { revision, boundary, capabilities: { editing: enabled, discovery: true, autoMatch: true, backfill: true, context: true }, contextDisabledReason: null, counts: { identities: pendingMatch ? 1 : 0, details: 0, conflicts: 1 }, tracking: { enabled: true, state: trackingComplete ? "complete" : "catching_up", activeTurnNumber: 1, coverageStartTurn: 1, trackedThroughTurn: trackingComplete ? 1 : 0, unresolvedCount: pendingMatch ? 1 : 0, firstGap: trackingComplete ? null : { turnNumber: 1, jobId: null, status: "missing", diagnosticCode: null } } });
      if (id === "discovery") return trackingUnavailable ? send(route, {}, 503) : send(route, {
        enabled: true, state: trackingComplete ? "complete" : "catching_up", activeTurnNumber: 1,
        coverageStartTurn: 1, trackedThroughTurn: trackingComplete ? 1 : 0, unresolvedCount: pendingMatch ? 1 : 0,
        firstGap: trackingComplete ? null : { turnNumber: 1, jobId: null, status: "missing", diagnosticCode: null } });
      if (id === "candidates") return send(route, { revision, boundary, nextCursor: null, candidates: pendingMatch && !(url.searchParams.get("view") === "matches" && resolvedCharacterId) ? [{ id: candidateId,
        ...(resolvedCharacterId ? { resolvedCharacterId, details: [{ observationIndex: 0, field: "story.role", value: "gatekeeper", quote: turn.narration, reason: "claim_not_fact", sourceHash: "a".repeat(64) }] } : {}),
        reason: "identity_needs_review", proposal: { localKey: "mara", name: "Mara", aliases: [], existingCharacterId: null,
          identityEvidence: [{ paragraphId: "p1", quote: turn.narration }], observations: deferredDetails ? [{ field: "story.role", value: "gatekeeper",
            mode: "fact", speakerCharacterId: null, paragraphId: "p1", quote: turn.narration }] : [] },
        source: { turnId: turn.id, turnNumber: 1, narrationRevision: 0 } }] : [] });
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
        if (conflictFixture && id === candidateId) return send(route, { character: person, revision, boundary, capabilities: { castEditing: enabled }, observations: ["guide", "guard"].map((value, index) => ({ id: index ? "77777777-7777-4777-8777-777777777778" : "77777777-7777-4777-8777-777777777777", characterId: id, field: "story.role", value, mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId: turn.id, turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", quote: turn.narration } })), overrides: [], identityEvents: [], unresolvedCandidateIds: [], editorDestination: null });
        return send(route, { character: person, revision, boundary, capabilities: { castEditing: enabled }, observations: id === protagonistId ? [] : [{
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
        nextCursor: offset + page.length < matches.length ? page.at(-1).id : null, capabilities: { castEditing: enabled } });
    }
    if (path === "/api/v1/session") return send(route, { user: { id: worldId, displayName: "Fixture owner", settings: { autoSubmitTurnChoices: true, continuousReading: false, defaultTurnControlStyle: "flexible_action" } }, authentication: "deferred" });
    if (path === "/api/v1/meta") return send(route, { application: { name: "Nexus", version: "test", commit: null, builtAt: null }, capabilities: { castEditing: enabled, systemArchive: false } });
    if (path === "/api/v1/providers") return send(route, { providers: [{ id: versionId, name: "Fixture text", providerType: "openai_compatible", providerRole: "text", enabled: true, isDefault: true }] });
    if (path === "/api/v1/campaigns") return send(route, { campaigns: [campaign] });
    if (path.endsWith("/sync-status")) return send(route, { ...campaign, campaign, world: { id: worldId, title: "Fixture world", versionNumber: 1, genre: "test", tone: "quiet", premise: "Fixture premise", backgroundStory: "", character: "Iven", firstAction: "Look around.", rules: "", playableCharacters: [] }, playerConfig: { selectedCharacterId: null, selectedCharacterName: "", characterSnapshot: null, characterProfile: null, characterProfileRevision: 0, rpgStats: [], trackers: [], eventTriggers: [], useRpgStats: false, suppressEventTriggers: false }, pendingGeneration: null, generationRecovery: null, syncToken: "fixture-1", turnWindowMode: "replace", turns: { campaignId, turns: [turn], nextCursor: null } });
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
  await page.route(`http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? 43173}/story/${campaignId}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? 43173}/story/${campaignId}`);
  await expect(page.locator("#storyTitle")).toHaveText("Cast fixture");
  return { characters, writes, profileWrites, conflict: () => { conflict = true; }, disable: () => { enabled = false; },
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

test("legacy renders completed discovery and preserves edited and ignored characters on refresh", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  const api = await fixture(page); await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await expect(dialog.getByRole("button", { name: "Mara", exact: true })).toHaveCount(0);
  api.publishDiscovery();
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
  await dialog.getByRole("button", { name: "Refresh characters", exact: true }).click();
  await expect(dialog).toContainText("Tracking starts at turn 1");
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/tracking-${width}.png` });
  api.finishTracking();
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

for (const surface of ["legacy", "next"] as const) for (const width of [1440, 390]) test(`shared review and undo ${surface} ${width}`, async ({ page }) => {
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
    const url = new URL(route.request().url()); if (url.searchParams.get("view") === "review") return send(route, { revision: 0, boundary, nextCursor: null, candidates: remainingDetails ? [{ id: candidateId, reason: "detail_needs_review", resolvedCharacterId: supportingId, proposal: { localKey: "mara", name: "Mara", aliases: [], existingCharacterId: null, identityEvidence: [{ paragraphId: "p1", quote: "Iven is the gatekeeper." }], observations: [] }, source: { turnId: "55555555-5555-4555-8555-555555555555", turnNumber: 1, narrationRevision: 0 }, details: [{ observationIndex: 2 - remainingDetails, field: "story.role", value: "gatekeeper", quote: "Iven is the gatekeeper.", reason: "unverified", canAcceptObservation: remainingDetails === 2, sourceHash: "a".repeat(64) }] }] : [] });
    if (url.searchParams.get("view") !== "details") return route.fallback();
    return send(route, { revision: 0, boundary, nextCursor: null, candidates: remainingDetails ? [{ id: candidateId, reason: "detail_needs_review", resolvedCharacterId: supportingId, proposal: { localKey: "mara", name: "Mara", aliases: [], existingCharacterId: null, identityEvidence: [{ paragraphId: "p1", quote: "Iven is the gatekeeper." }], observations: [] }, source: { turnId: "55555555-5555-4555-8555-555555555555", turnNumber: 1, narrationRevision: 0 }, details: [{ observationIndex: 2 - remainingDetails, field: "story.role", value: "gatekeeper", quote: "Iven is the gatekeeper.", reason: "unverified", canAcceptObservation: remainingDetails === 2, sourceHash: "a".repeat(64) }] }] : [] });
  });
  await page.route(`**/cast/candidates/${candidateId}/details/resolve`, route => { const input = route.request().postDataJSON(); decisions.push(input); remainingDetails--; return send(route, { revision: 0, boundary, character: supporting, candidateId, observationIndex: input.observationIndex, disposition: input.action }); });
  if (surface === "legacy") await open(page); else { await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`); await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click(); }
  const dialog = surface === "legacy" ? page.locator("#campaignCastDialog") : page.locator("dialog.characters-workspace");
  await openReview(dialog);
  await expect(dialog).toContainText("gatekeeper");
  if (screenshotRoot) await dialog.screenshot({ path: `${screenshotRoot}/review-${surface}-${width}.png` });
  await dialog.getByRole("button", { name: "Apply and next", exact: true }).click();
  await expect.poll(() => decisions.length).toBe(1); await dialog.getByRole("button", { name: "Dismiss detail", exact: true }).click();
  await expect.poll(() => decisions.length).toBe(2); expect(decisions.map(item => item.action)).toEqual(["accept", "dismiss"]); expect(decisions[0]).not.toHaveProperty("confirmedValue");
  await dialog.getByRole("button", { name: "Back to characters", exact: true }).click();
  if (surface === "legacy") await dialog.getByRole("button", { name: "Back to characters", exact: true }).click();
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
    await dialog.getByRole("button", { name: "Needs attention", exact: true }).click();
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
    await dialog.getByRole("button", { name: "Retry character tracking" }).click();
    await expect.poll(() => retries).toBe(1);
  } else {
    await expect(dialog.getByRole("button", { name: "Retry character tracking" })).toHaveCount(0);
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
  const count = requests.length; await dialog.getByRole("button", { name: "Skip for this pass", exact: true }).click();
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
  await dialog.getByRole("button", { name: "Scan earlier story", exact: true }).click(); await received;
  await page.keyboard.press("Escape"); await expect(dialog).not.toBeVisible(); await openWorkspace();
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
  const attention = dialog.getByRole("button", { name: "Needs attention", exact: true });
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
  await dialog.screenshot({ path: `docs/review/assets/unified-character-editor-phase-2/cast-inbox-${width}.png` });
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
  await dialog.locator("#cast-save").click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0]).toMatchObject({ name: "the watcher" });
  await expect(dialog.getByRole("button", { name: "Edit character", exact: true })).toBeVisible();
});
