import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const evidenceDirectory = resolve(".superpowers/sdd/legacy-ui-2026-10-03/evidence/T03");
const campaignA = { id: "campaign-a", title: "Campaign Alpha", status: "active", worldId: "world-a", worldVersionId: "version-a", worldTitle: "World Alpha", worldVersionNumber: 1, activeTurnNumber: 3, stateRevision: 5, turnControlStyle: "flexible_action", storyLengthProfile: "standard", storyContextBudgetTokens: 32000 };
const campaignB = { ...campaignA, id: "campaign-b", title: "Campaign Beta" };
type ApiLogEntry = { method: string; path: string; status: number; requestBody: string | null; response: unknown };
let apiLog: ApiLogEntry[] = [];
let campaignRecords = new Map<string, typeof campaignA>();

function response(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

async function fixtureRoute(route: Route, controls: { patchGate?: Promise<void>; patchStatus?: number; patchStarted?: () => void }) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace(/^\/api\/v1/u, "");
  let body: unknown = {};
  let status = 200;
  if (path === "/meta") body = {};
  else if (path === "/session") body = { user: { id: "owner-synthetic", displayName: "Test owner", settings: { autoSubmitTurnChoices: true, continuousReading: false } } };
  else if (path === "/providers") body = { providers: [] };
  else if (path === "/worlds") body = { worlds: [] };
  else if (path === "/campaigns" && request.method() === "GET") body = { campaigns: [...campaignRecords.values()] };
  else if (/^\/campaigns\/campaign-[ab]\/state$/u.test(path)) body = { activeTurnNumber: 3, revision: 5 };
  else if (path === "/worlds/world-a") body = { ...campaignA, versions: [{ id: "version-a", versionNumber: 1 }] };
  else if (/^\/campaigns\/campaign-[ab]\/story-memory$/u.test(path) && request.method() === "GET") body = { level: "standard", reviewMode: "off", availableLevels: ["off", "standard", "enhanced", "max"] };
  else if (/^\/campaigns\/campaign-[ab]\/story-memory$/u.test(path) && request.method() === "PUT") {
    body = { level: JSON.parse(request.postData() || "{}").level, reviewMode: "off", availableLevels: ["off", "standard", "enhanced", "max"] };
  } else if (/^\/campaigns\/campaign-[ab]\/memory\/metrics$/u.test(path)) body = { turns: 3, memoryCount: 2, semanticHealth: { status: "available", indexedMemories: 0 } };
  else if (/^\/campaigns\/campaign-[ab]\/cost-summary$/u.test(path)) body = { hasReportedCosts: false, totals: [] };
  else if (/^\/campaigns\/campaign-[ab]\/memory\/embedding-config$/u.test(path)) body = { enabled: false, retrievalImplementation: "legacy_hybrid", retrievalShadowEnabled: false, model: null, documentPrefix: null, queryPrefix: null, batchSize: null };
  else if (/^\/campaigns\/campaign-[ab]\/illustration-config$/u.test(path)) body = { enabled: false, sourcePolicy: "off", matchingScope: "world", confidenceProfile: "balanced", repetitionWindow: 5, model: "", size: "1024x1024", aspectRatio: "1:1", quality: "auto", outputFormat: "png", maxAttempts: 3, segmentWordCount: 500, segmentPromptMode: "direct" };
  else if (/^\/campaigns\/campaign-[ab]\/image-jobs$/u.test(path)) body = { jobs: [] };
  else if (/^\/campaigns\/campaign-[ab]\/memory\/context-preview/u.test(path)) body = { selectedCompression: "balanced", retrieval: { mode: "lexical" }, budget: { estimatedSelectedTokens: 0, configuredTokens: 32000, truncated: false }, scopes: { chronicle: [] } };
  else if (/^\/campaigns\/campaign-[ab]$/u.test(path) && request.method() === "PATCH") {
    controls.patchStarted?.();
    if (controls.patchGate) await controls.patchGate;
    const input = JSON.parse(request.postData() || "{}");
    status = controls.patchStatus ?? 200;
    if (status >= 400) body = { message: "Synthetic save failure" };
    else {
      const id = path.slice("/campaigns/".length);
      body = { ...campaignRecords.get(id), ...input, id, imageProviderProfileId: null, updatedAt: "2026-10-03T12:00:00Z" };
      campaignRecords.set(id, body as typeof campaignA);
    }
  } else if (/^\/campaigns\/campaign-[ab]\/memory\/embeddings\/status$/u.test(path)) body = { status: "idle" };
  apiLog.push({ method: request.method(), path, status, requestBody: request.postData() ?? null, response: body });
  await route.fulfill(response(body, status));
}

async function openWorkspace(page: Page, controls: { patchGate?: Promise<void>; patchStatus?: number; patchStarted?: () => void } = {}) {
  await page.route("**/api/v1/**", (route) => fixtureRoute(route, controls));
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await page.locator('#campaignList [data-campaign-id="campaign-a"]').waitFor();
  await page.locator('#campaignList [data-campaign-id="campaign-a"]').click();
  await expect(page.locator("#campaignTitle")).toHaveValue("Campaign Alpha");
}

function saveEvidence(name: string) {
  mkdirSync(evidenceDirectory, { recursive: true });
  appendFileSync(resolve(evidenceDirectory, "api-events.jsonl"), `${JSON.stringify({ test: name, events: apiLog })}
`, "utf8");
}

test.beforeEach(() => {
  apiLog = [];
  campaignRecords = new Map([[campaignA.id, structuredClone(campaignA)], [campaignB.id, structuredClone(campaignB)]]);
  mkdirSync(evidenceDirectory, { recursive: true });
});
test.afterEach(({}, testInfo) => saveEvidence(testInfo.title));

test("keeps unsaved title and selection when Stay is chosen", async ({ page }) => {
  await openWorkspace(page);
  await page.locator("#campaignTitle").fill("Local Alpha title");
  await page.locator('#campaignList [data-campaign-id="campaign-b"]').click();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await expect(page.locator("#saveCampaignEditsDecision")).toBeVisible();
  await page.screenshot({ path: resolve(evidenceDirectory, "campaign-edits-stay.png") });
  await page.locator('#discardChangesDialog button[value="keep"]').click();
  await expect(page.locator("#campaignTitle")).toHaveValue("Local Alpha title");
  await expect(page.locator("#memoryTitle")).toHaveText("Campaign Alpha");
  expect(apiLog.some((entry) => entry.method === "PATCH")).toBe(false);
});

test("discards edits before switching without writing them", async ({ page }) => {
  await openWorkspace(page);
  await page.locator("#campaignTitle").fill("Discarded Alpha title");
  await page.locator('#campaignList [data-campaign-id="campaign-b"]').click();
  await page.locator('#discardChangesDialog button[value="discard"]').click();
  await expect(page.locator("#campaignTitle")).toHaveValue("Campaign Beta");
  expect(apiLog.some((entry) => entry.method === "PATCH")).toBe(false);
});

test("waits for explicit campaign save success before switching", async ({ page }) => {
  let release!: () => void;
  let started!: () => void;
  const patchGate = new Promise<void>((resolve) => { release = resolve; });
  const patchStarted = new Promise<void>((resolve) => { started = resolve; });
  await openWorkspace(page, { patchGate, patchStarted: started });
  await page.locator("#campaignTitle").fill("Saved Alpha title");
  await page.locator('#campaignList [data-campaign-id="campaign-b"]').click();
  await page.locator("#saveCampaignEditsDecision").click();
  await patchStarted;
  await expect(page.locator("#memoryTitle")).toHaveText("Campaign Alpha");
  await expect(page.locator("#campaignSaveStatus")).toHaveAttribute("data-state", "saving");
  await page.screenshot({ path: resolve(evidenceDirectory, "campaign-edits-saving.png") });
  release();
  await expect(page.locator("#memoryTitle")).toHaveText("Campaign Beta");
  expect(apiLog.find((entry) => entry.method === "PATCH")?.requestBody).toContain("Saved Alpha title");
});

test("saved campaign fields survive a selection cycle and later saves use the persisted baseline", async ({ page }) => {
  await openWorkspace(page);
  await page.locator("#campaignTitle").fill("Committed Alpha title");
  await page.locator("#campaignTabStory").click();
  await page.locator("#campaignStoryLengthProfile").selectOption("long");
  await page.locator("#campaignStoryContextBudgetTokens").selectOption("64000");
  await page.locator("#saveCampaign").click();
  await expect(page.locator("#campaignSaveStatus")).toHaveAttribute("data-state", "saved");
  await expect(page.locator("#campaignList [data-campaign-id=\"campaign-a\"] strong")).toHaveText("Committed Alpha title");
  await page.locator("#campaignList [data-campaign-id=\"campaign-b\"]").click();
  await expect(page.locator("#memoryTitle")).toHaveText("Campaign Beta");
  await page.locator("#campaignList [data-campaign-id=\"campaign-a\"]").click();
  await expect(page.locator("#campaignTitle")).toHaveValue("Committed Alpha title");
  await expect(page.locator("#campaignStoryLengthProfile")).toHaveValue("long");
  await expect(page.locator("#campaignStoryContextBudgetTokens")).toHaveValue("64000");
  await page.screenshot({ path: resolve(evidenceDirectory, "campaign-edits-save-select-cycle.png") });
  await page.locator("#campaignTabOverview").click();
  await page.locator("#campaignTitle").fill("Second Alpha title");
  await page.locator("#saveCampaign").click();
  await expect(page.locator("#campaignSaveStatus")).toHaveAttribute("data-state", "saved");
  const patches = apiLog.filter((entry) => entry.method === "PATCH");
  expect(patches).toHaveLength(2);
  expect(patches[0]?.requestBody).toContain("Committed Alpha title");
  expect(patches[1]?.requestBody).toContain("Second Alpha title");
  expect(campaignRecords.get("campaign-a")?.storyContextBudgetTokens).toBe(64000);
});
test("stays on the campaign and preserves fields after save failure", async ({ page }) => {
  await openWorkspace(page, { patchStatus: 500 });
  await page.locator("#campaignTitle").fill("Failed Alpha title");
  await page.locator('#campaignList [data-campaign-id="campaign-b"]').click();
  await page.locator("#saveCampaignEditsDecision").click();
  await expect(page.locator("#campaignTitle")).toHaveValue("Failed Alpha title");
  await expect(page.locator("#memoryTitle")).toHaveText("Campaign Alpha");
  await expect(page.locator("#campaignSaveStatus")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#campaignStatusMessage")).toHaveText("Campaign settings could not be saved.");
  await expect(page.locator("#campaignStatusMessage")).not.toContainText("Synthetic save failure");
});

test("late save completion cannot overwrite a campaign selected after Discard", async ({ page }) => {
  let release!: () => void;
  let started!: () => void;
  const patchGate = new Promise<void>((resolve) => { release = resolve; });
  const patchStarted = new Promise<void>((resolve) => { started = resolve; });
  await openWorkspace(page, { patchGate, patchStarted: started });
  await page.locator("#campaignTitle").fill("Late Alpha title");
  await page.locator('#campaignList [data-campaign-id="campaign-b"]').click();
  await page.locator("#saveCampaignEditsDecision").click();
  await patchStarted;
  await page.locator('#campaignList [data-campaign-id="campaign-b"]').click();
  await page.locator('#discardChangesDialog button[value="discard"]').click();
  await expect(page.locator("#memoryTitle")).toHaveText("Campaign Beta");
  release();
  await expect(page.locator("#memoryTitle")).toHaveText("Campaign Beta");
  await expect(page.locator("#campaignTitle")).toHaveValue("Campaign Beta");
});

test("automatic Story Memory saves remain separate from dirty campaign metadata", async ({ page }) => {
  await openWorkspace(page);
  await page.locator("#campaignTitle").fill("Still unsaved Alpha title");
  await page.locator("#campaignTabStory").click();
  await page.locator("#campaignStoryMemoryLevel").selectOption("enhanced");
  await expect.poll(() => apiLog.some((entry) => entry.method === "PUT" && entry.path.endsWith("/story-memory"))).toBe(true);
  await page.locator('#campaignList [data-campaign-id="campaign-b"]').click();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await expect(page.locator("#campaignTitle")).toHaveValue("Still unsaved Alpha title");
  expect(apiLog.some((entry) => entry.method === "PATCH")).toBe(false);
});

test("link navigation offers Save, Discard, and Stay before leaving the campaign workspace", async ({ page }) => {
  await openWorkspace(page);
  await page.locator("#campaignTitle").fill("Keep Alpha title");
  await page.locator("#navDashboard").click();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.locator('#discardChangesDialog button[value="keep"]').click();
  await expect(page).toHaveURL(/#campaigns$/u);
  await page.locator("#navDashboard").click();
  await page.locator('#discardChangesDialog button[value="discard"]').click();
  await expect(page).toHaveURL(/#dashboard$/u);
  await page.locator("#navSetup").click();
  await page.locator("#navCampaigns").click();
  const campaignLoad = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/campaigns/campaign-a/state");
  await page.locator('#campaignList [data-campaign-id="campaign-a"]').click();
  await campaignLoad;
  await page.locator("#campaignTitle").fill("Saved Alpha title");
  await page.locator("#navDashboard").click();
  await page.locator("#saveCampaignEditsDecision").click();
  await expect(page).toHaveURL(/#dashboard$/u);
  expect(apiLog.filter((entry) => entry.method === "PATCH")).toHaveLength(1);
});
