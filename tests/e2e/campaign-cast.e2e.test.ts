import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Route } from "@playwright/test";

const campaignId = "11111111-1111-4111-8111-111111111111";
const worldId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
const protagonistId = "66666666-6666-4666-8666-666666666666";
const screenshotRoot = process.env.CAST_SCREENSHOT_ROOT;

async function fixture(page: Page) {
  let revision = 0, enabled = true, conflict = false;
  const characters: any[] = [{ id: protagonistId, name: "Iven", aliases: [], origin: { kind: "protagonist", selectedCharacterId: null },
    profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 0, lastObservedTurn: 1 }];
  const overrides = new Map<string, Record<string, string>>();
  const writes: any[] = [];
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
        return send(route, { character: person, revision, boundary, capabilities: { castEditing: enabled }, observations: id === protagonistId ? [] : [{
          id: "77777777-7777-4777-8777-777777777777", characterId: id, field: "story.role", value: "gatekeeper", mode: "claim",
          speakerCharacterId: protagonistId, supersedesObservationId: null,
          evidence: { kind: "turn", turnId: turn.id, turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", quote: turn.narration }
        }],
          overrides: Object.entries(overrides.get(id) ?? {}).map(([field, value]) => ({ field, value, evidence: { kind: "user", editId: protagonistId, effectiveTurnNumber: 1 } })),
          identityEvents: [], unresolvedCandidateIds: [], editorDestination: id === protagonistId ? `/api/v1/campaigns/${campaignId}/character-profile` : null });
      }
      const query = url.searchParams.get("query")?.toLowerCase() ?? "";
      const matches = characters.filter((c) => [c.name, ...c.aliases].some((name: string) => name.toLowerCase().includes(query)));
      const cursor = url.searchParams.get("cursor"), offset = cursor ? matches.findIndex((person) => person.id === cursor) + 1 : 0;
      const page = matches.slice(offset, offset + 2);
      return send(route, { revision, boundary, characters: page,
        nextCursor: offset + page.length < matches.length ? page.at(-1).id : null, trackedThroughTurn: 0, coverageStartTurn: 1, discoveryStatus: "off", capabilities: { castEditing: enabled } });
    }
    if (path === "/api/v1/session") return send(route, { user: { id: worldId, displayName: "Fixture owner", settings: { autoSubmitTurnChoices: true, continuousReading: false, defaultTurnControlStyle: "flexible_action" } }, authentication: "deferred" });
    if (path === "/api/v1/meta") return send(route, { application: { name: "Nexus", version: "test", commit: null, builtAt: null }, capabilities: { castEditing: enabled, systemArchive: false } });
    if (path === "/api/v1/providers") return send(route, { providers: [{ id: versionId, name: "Fixture text", providerType: "openai_compatible", providerRole: "text", enabled: true, isDefault: true }] });
    if (path === "/api/v1/campaigns") return send(route, { campaigns: [campaign] });
    if (path.endsWith("/sync-status")) return send(route, { ...campaign, campaign, world: { id: worldId, title: "Fixture world", versionNumber: 1, genre: "test", tone: "quiet", premise: "Fixture premise", backgroundStory: "", character: "Iven", firstAction: "Look around.", rules: "", playableCharacters: [] }, playerConfig: { selectedCharacterId: null, selectedCharacterName: "", characterSnapshot: null, characterProfile: null, characterProfileRevision: 0, rpgStats: [], trackers: [], eventTriggers: [], useRpgStats: false, suppressEventTriggers: false }, pendingGeneration: null, generationRecovery: null, syncToken: "fixture-1", turnWindowMode: "replace", turns: { campaignId, turns: [turn], nextCursor: null } });
    if (path.endsWith("/turns")) return send(route, { campaignId, turns: [turn], nextCursor: null });
    if (path.endsWith("/state")) return send(route, { campaignId, activeTurnNumber: 1, revision: 1, viewedTurnNumber: 1, isCurrent: true, updatedAt: "2026-09-16T12:00:00.000Z", canonicalFacts: [], openThreads: [], continuitySummary: "", scratchpad: "", rpgStats: [], trackers: [], eventTriggers: [], pendingEventTriggers: [], recordedResolution: null });
    if (path.endsWith("/story-memory")) return send(route, { level: "standard", reviewMode: "observe", availableLevels: ["off", "standard", "enhanced", "max"] });
    if (path.endsWith("/character-profile")) return send(route, { campaignId, name: "Iven", profile: {}, revision: 0,
      characterId: null, storedProfile: null, inheritedFromSnapshot: false, legacyCharacterText: "Iven", rpgStats: [], defaultTriggers: [] });
    if (path.endsWith("/memory/metrics")) return send(route, { turns: 1, estimatedCompleteHistoryTokens: 10, memoryCount: 0, embeddedMemories: 0, semanticHealth: { indexedMemories: 0, jobStatus: "idle" } });
    if (path.endsWith("/cost-summary")) return send(route, { hasReportedCosts: false, totals: [] });
    if (path.endsWith("/memory/embedding-config")) return send(route, { enabled: false, retrievalImplementation: "disabled", retrievalShadowEnabled: false, model: null, documentPrefix: null, queryPrefix: null, batchSize: 1 });
    if (path.endsWith("/illustration-config")) return send(route, { enabled: false, sourcePolicy: "off", matchingScope: "world", confidenceProfile: "balanced", repetitionWindow: 5, maxAttempts: 3, segmentWordCount: 500, imagesPerSegment: 1, segmentPromptMode: "direct" });
    if (path.endsWith("/illustrations/segments")) return send(route, { segments: [] });
    if (path.includes("context-preview")) return send(route, { selectedCompression: "none", retrieval: { mode: "local" }, budget: { estimatedSelectedTokens: 0, configuredTokens: 32000, truncated: false }, scopes: { chronicle: [] } });
    return send(route, {});
  });
  const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${campaignId}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? 43173}/story/${campaignId}`);
  await expect(page.locator("#storyTitle")).toHaveText("Cast fixture");
  return { characters, writes, conflict: () => { conflict = true; }, disable: () => { enabled = false; } };
}
async function open(page: Page) {
  await page.getByRole("button", { name: "Setup", exact: true }).click();
  await page.locator("#btnOpenCast").click();
  await expect(page.getByRole("dialog", { name: "Characters", exact: true })).toBeVisible();
}

for (const width of [1440, 390]) test(`legacy cast add, edit, reset, conflict and capability loss at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const api = await fixture(page); await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await dialog.getByRole("button", { name: "Add character", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Mara");
  await dialog.getByLabel("Aliases (one per line)").fill("The Watcher");
  await dialog.getByLabel("Appearance", { exact: true }).fill("green eyes");
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Mara");
  await expect.poll(() => api.characters.length).toBe(2);
  await dialog.getByLabel("Appearance", { exact: true }).fill("");
  await dialog.getByLabel("Pin character", { exact: true }).check();
  await dialog.getByLabel("Ignore character", { exact: true }).check();
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await expect.poll(() => api.characters[1].pinned).toBe(true);
  await expect(dialog.getByLabel("Appearance", { exact: true })).toHaveValue("");
  await dialog.getByRole("button", { name: "Use discovered value for appearance", exact: true }).click();
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
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
  api.disable();
  await dialog.getByLabel("Name", { exact: true }).fill("Kept draft");
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await expect(dialog).toContainText("editing is disabled");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Kept draft");
  await expect(dialog.getByRole("button", { name: "Save character", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
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
  page.once("dialog", (confirmation) => confirmation.dismiss());
  await page.keyboard.press("Escape");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Unfinished");
  page.once("dialog", (confirmation) => confirmation.accept());
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Setup", exact: true })).toBeFocused();
});
test("legacy cast creates separate same-name people after a conflict and links the protagonist editor", async ({ page }) => {
  const api = await fixture(page); await open(page);
  const dialog = page.locator("#campaignCastDialog");
  await dialog.getByRole("button", { name: "Iven", exact: true }).click();
  await expect(dialog.getByLabel("Name", { exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Edit main character", exact: true }).click();
  await expect(page.locator("#editCharacterProfileDialog")).toBeVisible();
  await page.locator("#btnCancelEditCharacterProfile").click();
  await open(page);
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
    await expect(dialog.getByLabel("Pin character", { exact: true })).toBeVisible();
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
  await expect(dialog).toContainText("Claim: story.role");
  await dialog.getByRole("button", { name: "Turn 1", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#storyArea")).toContainText("Mara waits at the gate");
});
