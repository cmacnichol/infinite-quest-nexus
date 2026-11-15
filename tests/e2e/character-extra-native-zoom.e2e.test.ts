import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";
import { mockAuthoringSession } from "./helpers/authoring-session.js";

async function zoomContext(info: TestInfo): Promise<BrowserContext> {
  await mkdir(info.outputDir, { recursive: true });
  const owned = await mkdtemp(resolve(info.outputDir, "native-zoom-extra-"));
  const extension = resolve(owned, "extension"); await mkdir(extension);
  await writeFile(resolve(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Owned zoom probe", version: "1.0.0", permissions: ["tabs"], background: { service_worker: "worker.js" } }));
  await writeFile(resolve(extension, "worker.js"), "chrome.runtime.onInstalled.addListener(() => {});\n");
  const options = { channel: "chromium", headless: true, viewport: null, args: ["--window-size=1280,900", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] };
  Reflect.set(options, "deviceScaleFactor", undefined);
  return chromium.launchPersistentContext(resolve(owned, "profile"), options);
}
async function setZoom(context: BrowserContext, page: Page, origin: string, name: string) {
  const baseline = await page.evaluate(() => ({ innerWidth, outerWidth, devicePixelRatio }));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const tabId = await worker.evaluate(async expected => { const chrome = (globalThis as any).chrome; const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); const matches = tabs.filter((tab: any) => tab.url && new URL(tab.url).origin === expected); if (matches.length !== 1) throw new Error("Owned tab not found"); await chrome.tabs.setZoomSettings(matches[0].id, { mode: "automatic", scope: "per-tab" }); await chrome.tabs.setZoom(matches[0].id, 2); return matches[0].id; }, origin);
  await expect.poll(() => worker.evaluate(id => (globalThis as any).chrome.tabs.getZoom(id), tabId)).toBe(2);
  const metrics = await page.evaluate(() => ({ innerWidth, outerWidth, devicePixelRatio, scrollWidth: document.documentElement.scrollWidth, rootZoom: getComputedStyle(document.documentElement).zoom, scale: visualViewport?.scale }));
  expect(metrics.innerWidth / baseline.innerWidth).toBeCloseTo(0.5, 1); expect(metrics.devicePixelRatio / baseline.devicePixelRatio).toBeCloseTo(2, 1); expect(metrics.rootZoom).toBe("1"); expect(metrics.scale).toBe(1); expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
  const root = process.env.CAST_SCREENSHOT_ROOT ?? infoFallback(); await mkdir(root, { recursive: true });
  const cdp = await context.newCDPSession(page);
  try { const capture = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); await writeFile(resolve(root, `${name}.png`), Buffer.from(capture.data, "base64")); } finally { await cdp.detach(); }
  await writeFile(resolve(root, `${name}.json`), JSON.stringify({ tabZoom: 2, baseline, metrics }, null, 2));
}
async function captureViewport(context: BrowserContext, page: Page, name: string) {
  const root = process.env.CAST_SCREENSHOT_ROOT ?? infoFallback(); await mkdir(root, { recursive: true });
  const cdp = await context.newCDPSession(page);
  try { const capture = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); await writeFile(resolve(root, `${name}.png`), Buffer.from(capture.data, "base64")); } finally { await cdp.detach(); }
}
function infoFallback() { return "test-results"; }

test("Nexus sheet edits and undoes at native 200 percent", async ({}, info) => {
  const context = await zoomContext(info);
  try {
    const page = context.pages()[0] ?? await context.newPage(); const data = legacyUiFixture({ turnCount: 1, campaignCount: 1, worldCount: 1 }); await installLegacyUiFixture(page, data);
    const person = { id: "88888888-8888-4888-8888-888888888888", name: "Mara", aliases: [], origin: { kind: "manual" }, profile: { "story.role": "Scout" }, pinned: false, ignored: false, revision: 0, firstObservedTurn: 1, lastObservedTurn: 1 }; const boundary = { turnNumber: 1, timelineRevision: 0 }; let revision = 0;
    await page.route("**/api/v1/meta", route => route.fulfill({ json: { capabilities: { castEditing: true } } }));
    await page.route("**/cast?*", route => route.fulfill({ json: { revision, boundary, characters: [person], nextCursor: null, capabilities: { castEditing: true } } }));
    await page.route(`**/cast/${person.id}`, route => { if (route.request().method() !== "GET") { const body = route.request().postDataJSON(); person.profile["story.role"] = body.setOverrides?.["story.role"] ?? "Scout"; revision++; person.revision++; return route.fulfill({ json: { revision, boundary, character: person } }); } return route.fulfill({ json: { revision, boundary, character: person, observations: [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], editorDestination: null, capabilities: { castEditing: true } } }); });
    const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? 43173}`; await page.goto(`${origin}/nexus/index.html#campaigns`); await page.locator(`#campaignList [data-campaign-id="${data.campaignId}"]`).click(); await page.locator("#editCampaignCharacter").click(); const dialog = page.locator("#campaignCastDialog"); await dialog.getByRole("button", { name: "Mara", exact: true }).click();
    await setZoom(context, page, origin, "nexus-sheet-native-zoom-200"); await dialog.getByRole("button", { name: "Edit Role" }).focus(); await page.keyboard.press("Enter"); const role = dialog.getByRole("textbox", { name: "Role", exact: true }); await expect(role).toBeFocused(); await role.fill("Guide"); await role.evaluate(node => node.scrollIntoView({ block: "center" })); const roleBounds = await role.evaluate(node => { const field = node.getBoundingClientRect(), container = node.closest("dialog")!.getBoundingClientRect(); return { top: field.top, bottom: field.bottom, containerTop: container.top, containerBottom: container.bottom }; }); expect(roleBounds.top).toBeGreaterThanOrEqual(roleBounds.containerTop); expect(roleBounds.bottom).toBeLessThanOrEqual(roleBounds.containerBottom); await captureViewport(context, page, "nexus-sheet-native-zoom-200-edited"); const save = dialog.getByRole("button", { name: "Save", exact: true }); const cancel = dialog.getByRole("button", { name: "Cancel", exact: true }); await save.evaluate(node => node.scrollIntoView({ block: "center" })); for (const control of [save, cancel]) { const bounds = await control.evaluate(node => { const rect = node.getBoundingClientRect(), container = node.closest("dialog")!.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, containerTop: container.top, containerBottom: container.bottom, viewportHeight: innerHeight }; }); expect(bounds.top).toBeGreaterThanOrEqual(Math.max(0, bounds.containerTop)); expect(bounds.bottom).toBeLessThanOrEqual(Math.min(bounds.viewportHeight, bounds.containerBottom)); } await save.click(); await dialog.getByRole("button", { name: "Undo", exact: true }).click(); await expect(dialog.getByText("Undone", { exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test("Web-Next world workspace edits at native 200 percent", async ({}, info) => {
  const context = await zoomContext(info);
  try {
    const page = context.pages()[0] ?? await context.newPage(); await mockAuthoringSession({ context });
    const draft = { schemaVersion: 5, world: { title: "Glass Atlas", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {} };
    const candidate = { id: "hero", name: "Ilyra", characterText: "", campaignUse: "playable", startingCastDefault: true, alwaysInContext: false, rpgStats: [], defaultTriggers: [], source: {} };
    await page.addInitScript(session => sessionStorage.setItem("iqn:character-workspace:session:local", JSON.stringify(session)), { version: 1, key: "local", origin: "world-editor", mode: "edit", workflowId: "workflow-1", parentRoute: "/app/worlds/world-1?tab=characters", expectedWorldRevision: 4, parentDraft: draft, worldContext: draft, rosterSummaries: [], candidate, expiresAt: Date.now() + 60_000 });
    const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}`; await page.goto(`${origin}/app/characters/local`); await expect(page.locator('[data-page="character-workspace"]')).toBeVisible(); await setZoom(context, page, origin, "web-next-world-native-zoom-200"); await page.locator('[data-character-stage="story"]').click(); const role = page.locator('[name="candidate.profile.story.role"]'); await role.focus(); await role.fill("Zoom navigator"); await expect(role).toHaveValue("Zoom navigator"); await expect(role).toBeInViewport(); const geometry = await role.evaluate(node => ({ bottom: node.getBoundingClientRect().bottom, footerTop: document.querySelector(".character-progress-ledger")!.getBoundingClientRect().top })); expect(geometry.bottom).toBeLessThanOrEqual(geometry.footerTop); await captureViewport(context, page, "web-next-world-native-zoom-200-edited");
  } finally { await context.close(); }
});
