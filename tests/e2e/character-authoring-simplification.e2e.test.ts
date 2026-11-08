import { expect, test } from "@playwright/test";
import { characterProfileSchema } from "../../packages/contracts/src/world-library.js";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}`;
const screenshots = process.env.CAST_SCREENSHOT_ROOT;
const world = { schemaVersion: 5, world: { title: "Fixture world", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" },
  playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {} };
const character = { id: "fixture-guide", name: "Mira", characterText: "Retained generated source.",
  profile: characterProfileSchema.parse({ story: { role: "Guide", personality: "Patient" }, appearance: { eyes: "Green" } }),
  rpgStats: [{ name: "Resolve", value: 12 }], defaultTriggers: [{ name: "Light", condition: "At dusk", effect: "Light a lantern" }], source: {} };

for (const width of [1440, 390]) test(`legacy AI draft is the first creation step and preserves edits at ${width}px`, async ({ page }) => {
  const writes: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/api/v1/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") writes.push(path);
    if (path === "/api/v1/session") return route.fulfill({ json: quietLeafApiPayloads().session });
    if (path === "/api/v1/providers") return route.fulfill({ json: { providers: [{ id: "11111111-1111-4111-8111-111111111111", name: "Fixture text", providerType: "lm_studio", providerRole: "text", baseUrl: "http://fixture.invalid", defaultModel: "fixture-model", configuration: {}, enabled: true, isDefault: true, hasApiKey: false, healthStatus: "unknown" }] } });
    if (path === "/api/v1/worlds/playable-characters/generate-preview") return route.fulfill({ json: { character } });
    if (path === "/api/v1/worlds") return route.fulfill({ json: { worlds: [] } });
    if (path === "/api/v1/campaigns") return route.fulfill({ json: { campaigns: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? 43173}/nexus/index.html#world-library`);
  await page.locator("#newWorld").click();
  await page.locator("#worldTitle").fill("Fixture world");
  await page.locator('[data-world-author-step="character"]').click();
  await page.locator("#addPlayableCharacter").click();
  const dialog = page.locator("#characterDialog");
  await expect(dialog.locator("#characterGenerator")).toHaveJSProperty("open", true);
  await expect(dialog.locator("#characterGeneratorPrompt")).toBeVisible();
  await dialog.locator("#characterGeneratorPrompt").fill("A patient guide with green eyes");
  if (screenshots) await page.screenshot({ path: `${screenshots}/legacy-ai-character-${width}.png`, fullPage: true });
  await dialog.locator("#generateCharacter").click();
  await expect(dialog.locator("#characterName")).toHaveValue("Mira");
  await expect(dialog.locator("#characterRole")).toHaveValue("Guide");
  await dialog.locator("#characterRole").fill("My edited guide");
  page.once("dialog", confirm => confirm.dismiss());
  await dialog.locator("#generateCharacter").click();
  await expect(dialog.locator("#characterRole")).toHaveValue("My edited guide");
  expect(writes).toEqual(["/api/v1/worlds/playable-characters/generate-preview"]);
  expect(errors).toEqual([]);
});

for (const width of [1440, 390]) test(`AI character creation goes from concept to editable review at ${width}px`, async ({ page, context }) => {
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page.addInitScript(draft => sessionStorage.setItem("iqn:character-workspace:session:simplified", JSON.stringify({
    version: 1, key: "simplified", origin: "world-creation", mode: "create", workflowId: "fixture-flow", parentRoute: "/app/worlds/new",
    expectedWorldRevision: null, parentDraft: draft, worldContext: draft, rosterSummaries: [], candidate: null, expiresAt: Date.now() + 60000
  })), world);
  await page.route("**/api/v1/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") writes.push(path);
    if (path === "/api/v1/authoring/capabilities") return route.fulfill({ json: { enabled: false, supportedKinds: ["world_concept", "character"], limits: { activeJobsPerOwner: 5, maximumInputBytes: 2097152, listPageSize: 20 } } });
    if (path === "/api/v1/worlds/playable-characters/generate-preview") return route.fulfill({ json: { character } });
    if (path === "/api/v1/worlds/generate-progress") return route.fulfill({ json: { status: "completed", phase: "completed", progressPercent: 100, message: "Ready" } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${origin}/app/characters/simplified`);
  await expect(page.locator('[name="characterMethod"][value="ai"]')).toBeChecked();
  await expect(page.getByRole("button", { name: "Generate character", exact: true })).toBeDisabled();
  await page.evaluate(() => navigator.clipboard.writeText("A patient guide with green eyes"));
  await page.getByRole("button", { name: "Paste character concept", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Generate character", exact: true })).toBeEnabled();
  if (screenshots) await page.screenshot({ path: `${screenshots}/character-concept-${width}.png`, fullPage: true });
  await page.getByRole("button", { name: "Generate character", exact: true }).click();
  const review = page.locator("[data-character-review]");
  await expect(review).toContainText("Patient");
  await expect(review).toContainText("Green");
  await expect(review).toContainText("Guide");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  if (width === 390) {
    const exit = page.getByText("Return without using this character", { exact: true });
    await exit.evaluate(el => el.scrollIntoView({ block: "center" }));
    await exit.focus();
    await expect(exit).toBeFocused();
    await expect(exit).toBeInViewport();
    await exit.click({ trial: true });
  }
  if (screenshots) await page.screenshot({ path: `${screenshots}/character-review-${width}.png`, fullPage: width !== 390 });
  await page.locator('[data-character-edit-stage="mechanics"]').click();
  await page.locator('[data-action="remove-character-mechanic"]').click();
  await expect(page.locator("[data-mechanics-list]")).not.toContainText("Resolve");
  await page.locator('[data-mechanics-collection="defaultTriggers"]').click();
  await expect(page.locator("[data-mechanics-list]")).toContainText("Light");
  await page.locator('[data-character-stage="review"]').click();
  await expect(page.getByRole("button", { name: "Add to world draft", exact: true })).toBeVisible();
  expect(writes).toEqual(["/api/v1/worlds/playable-characters/generate-preview"]);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
