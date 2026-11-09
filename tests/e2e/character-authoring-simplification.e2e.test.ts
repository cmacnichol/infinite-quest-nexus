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

for (const width of [1440, 390]) test(`Nexus reviews, stops and retries cast suggestions locally at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  let hasProvider = false, seedRequests = 0, release!: () => void;
  const expansions: string[] = [], writes: string[] = [];
  const createdId = "a1111111-1111-4111-8111-111111111111";
  let submitted: Record<string, any> | undefined;
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/session")) return route.fulfill({ json: quietLeafApiPayloads().session });
    if (path.endsWith("/providers")) return route.fulfill({ json: { providers: hasProvider ? [{
      id: "11111111-1111-4111-8111-111111111111", name: "Fixture", providerType: "lm_studio", providerRole: "text",
      baseUrl: "http://fixture.invalid", defaultModel: "fixture-model", configuration: {}, enabled: true, isDefault: true, hasApiKey: false, healthStatus: "unknown"
    }] : [] } });
    if (path.endsWith("/suggest-cast-preview")) {
      const request = route.request().postDataJSON(); expect(request.content.world.title).toBe("Unsaved world"); expect(request.count).toBe(5);
      seedRequests++; return route.fulfill({ json: { seeds: seedRequests === 1 ? [] : ["Mira", "Vale", "Oren"].map((name, i) => ({
        seedId: `11111111-1111-4111-8111-11111111111${i}`, name, role: "Guide", concept: "Lighthouse keeper"
      })) } });
    }
    if (path.endsWith("/generate-preview")) {
      const body = route.request().postDataJSON(); expect(body.campaignUse).toBe("supporting");
      expansions.push(body.seed.name);
      if (expansions.length === 1) await new Promise<void>(resolve => { release = resolve; });
      if (expansions.length === 2) return route.fulfill({ status: 503, json: {} });
      return route.fulfill({ json: { character: { ...character, name: body.seed.name } } });
    }
    if (route.request().method() !== "GET") writes.push(path);
    if (path.endsWith("/worlds") && route.request().method() === "POST") {
      submitted = route.request().postDataJSON(); return route.fulfill({ status: 201, json: { id: createdId } });
    }
    if (path.endsWith("/worlds/" + createdId)) return route.fulfill({ json: { id: createdId, title: "Unsaved world", draftRevision: 1,
      status: "active", draftContent: submitted?.content, versions: [], campaigns: [] } });
    if (path.endsWith("/worlds")) return route.fulfill({ json: { worlds: [] } });
    if (path.endsWith("/campaigns")) return route.fulfill({ json: { campaigns: [] } });
    return route.fulfill({ json: {} });
  });
  const visit = async () => {
    await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? 43173}/nexus/index.html#world-library`);
    await page.locator("#newWorld").click(); await page.locator("#worldTitle").fill("Unsaved world");
    await page.locator('[data-world-author-step="character"]').click(); await page.getByRole("button", { name: "Suggest cast" }).click();
  };
  await visit();
  const dialog = page.getByRole("dialog", { name: "Suggest cast" });
  await expect(dialog.getByRole("button", { name: "Suggest seeds" })).toBeDisabled();
  await expect(dialog).toContainText("Configure a default text provider");
  hasProvider = true; await page.reload(); await visit();
  await dialog.getByRole("button", { name: "Suggest seeds" }).click(); await expect(dialog).toContainText("No new names");
  await dialog.getByLabel("Direction").fill("Coastal villages"); await dialog.getByRole("button", { name: "Retry" }).click();
  await dialog.getByLabel("Name", { exact: true }).nth(1).fill("Vale Renamed");
  await dialog.getByRole("button", { name: "Expand selected" }).click(); await expect.poll(() => expansions.length).toBe(1);
  await dialog.getByRole("button", { name: "Stop" }).click(); release(); await expect(dialog.getByText("Not generated", { exact: true })).toHaveCount(2);
  const rows = dialog.locator("fieldset");
  await rows.nth(1).getByRole("button", { name: "Retry" }).click(); await expect(rows.nth(1)).toContainText("Failed to generate");
  await rows.nth(1).getByRole("button", { name: "Retry" }).click(); await expect(rows.nth(1)).toContainText("Generated");
  await rows.nth(2).getByRole("button", { name: "Drop" }).click();
  await rows.first().getByRole("button", { name: "Edit character" }).click();
  await page.locator("#characterName").fill("Vale Renamed"); await page.getByRole("button", { name: "Apply to suggestion" }).click();
  await dialog.getByRole("button", { name: "Add selected to draft" }).click(); await expect(dialog).toContainText("already exists");
  await rows.first().getByRole("button", { name: "Edit character" }).click();
  await page.locator("#characterName").fill("Mira Edited"); await page.getByRole("button", { name: "Apply to suggestion" }).click();
  await expect(rows.first().getByLabel("Name", { exact: true })).toHaveValue("Mira Edited");
  page.once("dialog", confirm => confirm.dismiss()); await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
  await page.screenshot({ path: `test-results/review-assets/unified-character-editor-phase-5/suggest-cast-${width}.png` });
  await dialog.getByRole("button", { name: "Add selected to draft" }).click(); await expect(dialog).toBeHidden();
  await expect(page.locator("#worldAuthorDialog")).toContainText("Mira Edited");
  expect(expansions).toEqual(["Mira", "Vale Renamed", "Vale Renamed"]); expect(writes).toEqual([]);
  await page.locator("#saveWorldDraft").click(); await expect.poll(() => writes).toEqual(["/api/v1/worlds"]);
  const roster = submitted?.content?.playableCharacters;
  expect(roster).toHaveLength(2); expect(new Set(roster.map((row: typeof character) => row.id)).size).toBe(2);
  expect(roster).toMatchObject(["Mira Edited", "Vale Renamed"].map(name => ({
    name, campaignUse: "supporting", startingCastDefault: true, alwaysInContext: false, rpgStats: [], defaultTriggers: []
  })));
});

for (const existing of [false, true]) test(`Web-Next Supporting preview preserves ${existing ? "existing" : "empty"} hidden mechanics with durable authoring enabled`, async ({ page }) => {
  const original = { ...character, id: "existing-support", campaignUse: "supporting", startingCastDefault: false, alwaysInContext: false,
    rpgStats: [{ name: "Kept stat", value: 7 }], defaultTriggers: [{ name: "Kept tracker", condition: "Night", effect: "Watch" }] };
  const requests: Array<{ path: string; body: any }> = [];
  await page.addInitScript(({ draft, original, existing }) => sessionStorage.setItem("iqn:character-workspace:session:supporting-proof", JSON.stringify({
    version: 1, key: "supporting-proof", origin: "world-creation", mode: existing ? "edit" : "create", workflowId: "supporting-flow", parentRoute: "/app/worlds/new",
    expectedWorldRevision: null, parentDraft: draft, worldContext: draft, rosterSummaries: [], candidate: existing ? original : null, expiresAt: Date.now() + 60000
  })), { draft: world, original, existing });
  await page.route("**/api/v1/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") requests.push({ path, body: route.request().postDataJSON() });
    if (path.endsWith("/authoring/capabilities")) return route.fulfill({ json: { enabled: true, supportedKinds: ["character"], limits: { activeJobsPerOwner: 5, maximumInputBytes: 2097152, listPageSize: 20 } } });
    if (path.endsWith("/generate-preview")) return route.fulfill({ json: { character: { ...character, rpgStats: [{ name: "Generated stat", value: 99 }], defaultTriggers: [{ name: "Generated tracker" }] } } });
    if (path.endsWith("/generate-progress")) return route.fulfill({ json: { status: "completed", phase: "completed", progressPercent: 100, message: "Ready" } });
    return route.fulfill({ json: {} });
  });
  await page.route("**/app/worlds/new", route => route.fulfill({ contentType: "text/html", body: "<title>Returned to draft</title>" }));
  if (!existing) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/app/characters/supporting-proof`);
  await page.locator("[data-character-use]").selectOption("supporting");
  if (!existing && screenshots) {
    await page.locator("[data-character-use]").evaluate(element => element.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: `${screenshots}/web-next-supporting-generation-390.png` });
  }
  await page.locator('[name="characterMethod"][value="ai"]').check();
  await page.locator('[data-character-prompt="compact"]').fill("A lighthouse guide");
  page.once("dialog", confirm => confirm.accept());
  await page.getByRole("button", { name: "Generate character", exact: true }).click();
  await expect(page.locator("[data-character-review]")).toContainText("Guide");
  await expect(page.locator('[data-character-stage="mechanics"]')).toBeHidden();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ path: "/api/v1/worlds/playable-characters/generate-preview", body: { campaignUse: "supporting" } });
  await page.getByRole("button", { name: existing ? "Update world draft" : "Add to world draft", exact: true }).click();
  const result = await page.evaluate(() => JSON.parse(sessionStorage.getItem("iqn:character-workspace:result:supporting-proof") || "null"));
  expect(result.result.candidate).toMatchObject({ campaignUse: "supporting", rpgStats: existing ? original.rpgStats : [], defaultTriggers: existing ? original.defaultTriggers : [] });
});

for (const existing of [false, true]) test(`Nexus Supporting generation preserves ${existing ? "existing" : "empty"} hidden mechanics`, async ({ page }) => {
  const bodies: any[] = []; let saved: any;
  await page.route("**/api/v1/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/session")) return route.fulfill({ json: quietLeafApiPayloads().session });
    if (path.endsWith("/providers")) return route.fulfill({ json: { providers: [{ id: "11111111-1111-4111-8111-111111111111", name: "Fixture", providerType: "lm_studio", providerRole: "text", baseUrl: "http://fixture.invalid", defaultModel: "fixture-model", configuration: {}, enabled: true, isDefault: true, hasApiKey: false, healthStatus: "unknown" }] } });
    if (path.endsWith("/generate-preview")) { bodies.push(route.request().postDataJSON()); return route.fulfill({ json: { character } }); }
    if (path.endsWith("/worlds") && route.request().method() === "POST") { saved = route.request().postDataJSON(); return route.fulfill({ status: 201, json: { id: "10000000-0000-4000-8000-000000000001" } }); }
    if (path.endsWith("/worlds")) return route.fulfill({ json: { worlds: [] } });
    if (path.endsWith("/campaigns")) return route.fulfill({ json: { campaigns: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? 43173}/nexus/index.html#world-library`);
  await page.locator("#newWorld").click(); await page.locator("#worldTitle").fill("Supporting test");
  await page.locator('[data-world-author-step="character"]').click(); await page.locator("#addPlayableCharacter").click();
  const dialog = page.locator("#characterDialog");
  if (existing) {
    await dialog.locator("#characterGeneratorPrompt").fill("Initial guide");
    await dialog.locator("#generateCharacter").click();
    await expect(dialog.locator("#characterName")).toHaveValue("Mira");
    await dialog.locator("#saveCharacter").click();
    await page.getByRole("button", { name: "Edit Mira" }).click();
  }
  await dialog.locator("#characterCampaignUse").selectOption("supporting");
  if (existing) await dialog.locator("#characterGenerator > summary").click();
  await dialog.locator("#characterGeneratorPrompt").fill("A new guide");
  if (existing) page.once("dialog", confirm => confirm.accept());
  await dialog.locator("#generateCharacter").click();
  await expect(dialog.locator("#characterName")).toHaveValue("Mira");
  await expect(dialog.locator("#characterMechanics")).toBeHidden();
  await dialog.locator("#saveCharacter").click();
  await page.locator("#saveWorldDraft").click();
  await expect.poll(() => saved).toBeTruthy();
  expect(bodies.at(-1)).toMatchObject({ campaignUse: "supporting" });
  expect(saved.content.playableCharacters[0]).toMatchObject({ campaignUse: "supporting", rpgStats: existing ? character.rpgStats : [], defaultTriggers: existing ? character.defaultTriggers : [] });
});
