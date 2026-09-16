import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Route } from "@playwright/test";

const screenshots = ".superpowers/sdd/nexus-story-continuity-implementation-plan-2026-09-16/story-memory-screenshots";
const worldId = "33333333-3333-4333-8333-333333333333";
const worldVersionId = "44444444-4444-4444-8444-444444444444";
const campaignAId = "11111111-1111-4111-8111-111111111111";
const campaignBId = "22222222-2222-4222-8222-222222222222";

function campaign(id: string, title: string) {
  return {
    id, title, status: "active", activeTurnNumber: 1, createdAt: "2026-09-16T12:00:00.000Z", updatedAt: "2026-09-16T12:00:00.000Z", worldId, worldTitle: "Fixture world",
    worldVersionId, worldVersionNumber: 1, latestWorldVersionNumber: 1, worldUpdateAvailable: false,
    selectedCharacterId: null, selectedCharacterName: "", characterSnapshot: null, characterProfile: null,
    characterProfileRevision: 0, storyLengthProfile: "standard", storyContextBudgetTokens: 32000,
    turnControlStyle: "flexible_action", textProviderProfileId: null, imageProviderProfileId: null, costInformation: []
  };
}

const campaigns = [campaign(campaignAId, "Delayed campaign"), campaign(campaignBId, "Selected campaign")];
const turn = {
  id: "55555555-5555-4555-8555-555555555555", turnNumber: 1, action: "Look around.",
  narration: "The fixture world waits.", inputMode: "action", inputModeSource: "explicit", choices: [],
  customActionSuggestion: "", imagePrompt: "", imageUrl: null, acceptedAt: "2026-09-16T12:00:00.000Z",
  chronicleRetrieval: null, reportedCost: null
};

async function installApi(page: Page) {
  const settings = new Map([
    [campaignAId, { level: "standard", reviewMode: "observe", availableLevels: ["off", "standard", "enhanced", "max"] }],
    [campaignBId, { level: "max", reviewMode: "enforce", availableLevels: ["off", "standard", "enhanced", "max"] }]
  ]);
  const writes: Array<{ campaignId: string; level: string }> = [];
  let memoryGets = 0;
  let memoryResponses = 0;
  let rejectNextSave = false;
  let delayedRoute: Route | null = null;
  let delayedRequested!: () => void;
  const delayedRequest = new Promise<void>((resolve) => { delayedRequested = resolve; });
  const send = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const memoryMatch = path.match(/^\/api\/v1\/campaigns\/([^/]+)\/story-memory$/u);
    if (memoryMatch) {
      const campaignId = memoryMatch[1]!;
      if (request.method() === "GET") memoryGets += 1;
      if (request.method() === "GET" && campaignId === campaignAId) {
        delayedRoute = route;
        delayedRequested();
        return;
      }
      if (request.method() === "PUT") {
        const level = request.postDataJSON().level as string;
        writes.push({ campaignId, level });
        if (rejectNextSave) {
          rejectNextSave = false;
          return send(route, { error: "Synthetic Story Memory save failure." }, 503);
        }
        const current = settings.get(campaignId)!;
        const saved = { ...current, level, reviewMode: level === "max" ? "enforce" : level === "off" ? "off" : "observe" };
        settings.set(campaignId, saved);
        return send(route, saved);
      }
      await send(route, settings.get(campaignId));
      memoryResponses += 1;
      return;
    }
    if (path === "/api/v1/session") return send(route, { user: { id: worldId, displayName: "Fixture owner", settings: { autoSubmitTurnChoices: true, continuousReading: false, defaultTurnControlStyle: "flexible_action" } }, authentication: "deferred" });
    if (path === "/api/v1/meta") return send(route, { application: { name: "Nexus", version: "test", commit: null, builtAt: null }, capabilities: { systemArchive: false } });
    if (path === "/api/v1/providers") return send(route, { providers: [{ id: "44444444-4444-4444-8444-444444444444", name: "Fixture text", providerType: "openai_compatible", providerRole: "text", enabled: true, isDefault: true }] });
    if (path === "/api/v1/worlds") return send(route, { worlds: [] });
    if (path === "/api/v1/campaigns") return send(route, { campaigns });
    if (path.match(/^\/api\/v1\/worlds\//u)) return send(route, { id: worldId, versions: [{ id: worldVersionId, versionNumber: 1 }] });
    if (path.endsWith("/sync-status")) {
      const campaignId = path.split("/")[4]!;
      const selected = campaigns.find((item) => item.id === campaignId)!;
      return send(route, { ...selected, campaign: selected, world: { id: worldId, title: "Fixture world", versionNumber: 1, genre: "test", tone: "quiet", premise: "Fixture premise", backgroundStory: "", character: "", firstAction: "Look around.", rules: "", playableCharacters: [] }, playerConfig: { selectedCharacterId: null, selectedCharacterName: "", characterSnapshot: null, characterProfile: null, characterProfileRevision: 0, rpgStats: [], trackers: [], eventTriggers: [], useRpgStats: false, suppressEventTriggers: false }, pendingGeneration: null, generationRecovery: null, syncToken: "fixture-1", turnWindowMode: "replace", turns: { campaignId, turns: [turn], nextCursor: null } });
    }
    if (path.endsWith("/turns")) return send(route, { campaignId: path.split("/")[4], turns: [turn], nextCursor: null });
    if (path.endsWith("/state")) return send(route, { campaignId: path.split("/")[4], activeTurnNumber: 1, revision: 1, viewedTurnNumber: 1, isCurrent: true, updatedAt: "2026-09-16T12:00:00.000Z", canonicalFacts: [], openThreads: [], continuitySummary: "", scratchpad: "", rpgStats: [], trackers: [], eventTriggers: [], pendingEventTriggers: [], recordedResolution: null });
    if (path.endsWith("/memory/metrics")) return send(route, { turns: 1, estimatedCompleteHistoryTokens: 10, memoryCount: 0, embeddedMemories: 0, semanticHealth: { indexedMemories: 0, jobStatus: "idle" } });
    if (path.endsWith("/cost-summary")) return send(route, { hasReportedCosts: false, totals: [] });
    if (path.endsWith("/memory/embedding-config")) return send(route, { enabled: false, retrievalImplementation: "disabled", retrievalShadowEnabled: false, model: null, documentPrefix: null, queryPrefix: null, batchSize: 1 });
    if (path.endsWith("/illustration-config")) return send(route, { enabled: false, sourcePolicy: "off", matchingScope: "world", confidenceProfile: "balanced", repetitionWindow: 5, maxAttempts: 3, segmentWordCount: 500, imagesPerSegment: 1, segmentPromptMode: "direct" });
    if (path.endsWith("/illustrations/segments")) return send(route, { segments: [] });
    if (path.includes("context-preview")) return send(route, { selectedCompression: "none", retrieval: { mode: "local" }, budget: { estimatedSelectedTokens: 0, configuredTokens: 32000, truncated: false }, scopes: { chronicle: [] } });
    return send(route, {});
  });

  return {
    settings, writes, memoryGets: () => memoryGets, memoryResponses: () => memoryResponses,
    setSettings: (campaignId: string, value: { level: string; reviewMode: string; availableLevels: string[] }) => settings.set(campaignId, value),
    rejectNextSave: () => { rejectNextSave = true; },
    waitForDelayedRequest: () => delayedRequest,
    resolveDelayedRequest: async () => {
      if (delayedRoute) await send(delayedRoute, settings.get(campaignAId));
    }
  };
}

test("legacy Nexus persists Story Memory, retains a failed draft, and fences a stale campaign response", async ({ page }) => {
  const api = await installApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("http://127.0.0.1:43173/nexus/index.html#campaigns");
  await page.locator(`#campaignList [data-campaign-id="${campaignAId}"]`).click();
  await api.waitForDelayedRequest();
  await page.locator(`#campaignList [data-campaign-id="${campaignBId}"]`).click();
  await expect(page.locator("#campaignStoryMemoryLevel")).toHaveValue("max");
  await api.resolveDelayedRequest();
  await expect(page.locator("#campaignStoryMemoryLevel")).toHaveValue("max");
  await expect(page.locator("#campaignStoryMemoryStatus")).toContainText("repairs eligible issues");
  await page.locator("#campaignTabStory").click();

  api.rejectNextSave();
  await page.locator("#campaignStoryMemoryLevel").selectOption("standard");
  await expect.poll(() => api.writes.length).toBe(1);
  await expect(page.locator("#campaignStoryMemoryLevel")).toHaveValue("standard");
  await expect(page.locator("#campaignStoryMemoryStatus")).toContainText("was not saved");

  await page.locator("#campaignStoryMemoryLevel").selectOption("enhanced");
  await expect.poll(() => api.writes.length).toBe(2);
  expect(api.writes[1]).toEqual({ campaignId: campaignBId, level: "enhanced" });
  await expect(page.locator("#campaignStoryMemoryLevel")).toHaveValue("enhanced");
  await page.screenshot({ path: `${screenshots}/nexus-desktop.png`, fullPage: true });

  await page.reload();
  await page.locator(`#campaignList [data-campaign-id="${campaignBId}"]`).click();
  await expect(page.locator("#campaignStoryMemoryLevel")).toHaveValue("enhanced");
  api.setSettings(campaignBId, { level: "max", reviewMode: "observe", availableLevels: ["off", "standard", "enhanced", "max"] });
  await page.reload();
  await page.locator(`#campaignList [data-campaign-id="${campaignBId}"]`).click();
  await page.locator("#campaignTabStory").click();
  await expect(page.locator("#campaignStoryMemoryLevel")).toHaveValue("max");
  await expect(page.locator("#campaignStoryMemoryStatus")).toContainText("observe mode");
});

test("legacy Story settings loads and persists the saved Story Memory level on mobile", async ({ page }) => {
  const api = await installApi(page);
  const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${campaignBId}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:43173/story/${campaignBId}`);
  await expect(page.locator("#storyTitle")).toHaveText("Selected campaign");
  await expect.poll(() => api.memoryGets()).toBe(1);
  await expect.poll(() => api.memoryResponses()).toBe(1);
  await expect(page.locator("#storyMemoryStatus")).not.toContainText("Loading the saved");
  await page.locator("#btnOpenUserProfile").click();
  await expect(page.locator("#storyMemoryLevel")).toHaveValue("max");
  await expect(page.locator("#storyMemoryStatus")).toContainText("repairs eligible issues");
  await page.screenshot({ path: `${screenshots}/story-mobile-max-enforce.png`, fullPage: true });
  await page.locator("#storyMemoryLevel").selectOption("off");
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0]).toEqual({ campaignId: campaignBId, level: "off" });
  await page.screenshot({ path: `${screenshots}/story-mobile-off-saved.png`, fullPage: true });
  await page.reload();
  await page.locator("#btnOpenUserProfile").click();
  await expect(page.locator("#storyMemoryLevel")).toHaveValue("off");
});
