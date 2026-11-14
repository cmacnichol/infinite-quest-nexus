import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { characterProfileSchema } from "../../packages/contracts/src/world-library.js";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const evidenceDirectory = resolve(process.env.PLAYWRIGHT_EVIDENCE_DIRECTORY ?? "test-results/sdd-evidence/legacy-ui-2026-10-03/evidence/T18");
const base = quietLeafApiPayloads();

async function installAuthoringApi(page: Page, options: {
  writes: Array<{ method: string; path: string; body: unknown }>;
  holdWorldSave?: () => Promise<void>;
}) {
  await page.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === "GET" ? null : request.postDataJSON();
    if (method !== "GET") options.writes.push({ method, path, body });
    if (path === "/api/v1/meta") return route.fulfill({ json: { application: { version: "synthetic" }, capabilities: {} } });
    if (path === "/api/v1/session") return route.fulfill({ json: base.session });
    if (path === "/api/v1/worlds" && method === "GET") return route.fulfill({ json: { worlds: [] } });
    if (path === "/api/v1/worlds" && method === "POST") {
      if (options.holdWorldSave) {
        await options.holdWorldSave();
        return route.fulfill({ status: 503, json: { error: "fixture_error", message: "Synthetic retryable draft save failure." } });
      }
      return route.fulfill({ status: 201, json: { id: "synthetic-world" } });
    }
    if (path === "/api/v1/campaigns") return route.fulfill({ json: { campaigns: [] } });
    if (path === "/api/v1/providers") return route.fulfill({ json: { providers: [] } });
    if (path === "/api/v1/dashboard/stats") return route.fulfill({ json: { worlds: { total: 0 }, campaigns: { total: 0 }, turns: { total: 0 }, costs: { totalUsd: 0, byProvider: [] } } });
    return route.fulfill({ json: {} });
  });
}

async function openNewWorld(page: Page, writes: Array<{ method: string; path: string; body: unknown }> = [], options: { holdWorldSave?: () => Promise<void> } = {}) {
  mkdirSync(evidenceDirectory, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await installAuthoringApi(page, { ...options, writes });
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await page.locator("#newWorld").click();
  await page.locator("#worldTitle").fill("Synthetic disclosure world");
  await page.locator('[data-world-author-step="character"]').click();
}

test("new character offers manual fallback and detailed notes while keeping empty imported source hidden", async ({ page }) => {
  await openNewWorld(page);
  await page.locator("#addPlayableCharacter").click();
  await expect(page.locator(".character-quick-create")).toBeVisible();
  await expect(page.locator("#characterName")).toBeVisible();
  await expect(page.locator("#characterRole")).toBeVisible();
  await expect(page.locator("#characterPersonality")).toBeVisible();
  await expect(page.locator("#characterGuidance")).toBeHidden();
  await expect(page.locator("#characterGeneratorUnavailable")).toContainText("Provider Setup");
  await expect(page.locator("#characterGenerator")).toBeHidden();
  await page.getByRole("button", { name: "Continue in detailed editor" }).click();
  await worldSection(page, "History and notes");
  await expect(page.locator("#characterUnclassifiedNotes")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator("#characterDialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: resolve(evidenceDirectory, "new-character-mobile-notes.png") });
  await page.locator("#cancelCharacter").click();
  await expect(page.locator("#characterDialog")).toBeHidden();
  await expect(page.locator("#discardChangesDialog")).toBeHidden();
});

test("section changes preserve appearance, mechanics, and imported metadata through Apply and parent Save", async ({ page }) => {
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  await openNewWorld(page, writes);
  await page.locator("#addPlayableCharacter").click();
  await page.locator("#characterName").fill("Mira Vale");
  await page.locator("#characterRole").fill("Guide");
  await page.getByRole("button", { name: "Continue in detailed editor" }).click();
  await worldSection(page, "Appearance");
  await page.locator("#characterClothing").fill("Blue travel coat");
  await worldSection(page, "Mechanics");
  await page.locator("#characterMechanics").evaluate((element: HTMLDetailsElement) => { element.open = true; });
  await page.locator("#addCharacterStat").click();
  const row = page.locator("#characterStats .character-edit-row").last();
  await row.locator('[data-character-field="name"]').fill("Resolve");
  await row.locator('[data-character-field="value"]').fill("17");
  await worldSection(page, "History and notes");
  await page.locator("#characterUnclassifiedNotes").fill("Unsorted imported-era note");
  await worldSection(page, "Identity");
  await page.locator("#characterAliases").fill("Wren, the Keeper\nNorth Star");
  await page.locator("#saveCharacter").click();
  await expect(page.locator("#playableCharacterRoster")).toContainText("Mira Vale");
  await page.getByRole("button", { name: "Edit Mira Vale" }).click();
  await worldSection(page, "Identity");
  await expect(page.locator("#characterAliases")).toHaveValue("Wren, the Keeper\nNorth Star");
  await page.locator("#cancelCharacter").click();
  expect(writes).toEqual([]);
  await page.locator("#saveWorldDraft").click();
  await expect(page.locator("#worldAuthorDialog")).toBeHidden();
  const posted = writes.find(write => write.path === "/api/v1/worlds")?.body as any;
  expect(posted.content.playableCharacters[0]).toMatchObject({ name: "Mira Vale", profile: { story: { role: "Guide" }, appearance: { clothing: "Blue travel coat" }, unclassifiedNotes: "Unsorted imported-era note", identity: { aliases: ["Wren, the Keeper", "North Star"] } }, rpgStats: [expect.objectContaining({ name: "Resolve", value: 17 })] });
});

async function worldSection(page: Page, name: string) {
  await expect(page.locator(".character-workspace")).toBeVisible();
  const select = page.getByRole("combobox", { name: "Section", exact: true });
  if (await select.isVisible()) await select.selectOption({ label: await select.locator("option").filter({ hasText: name }).first().textContent() as string });
  else await page.getByRole("navigation", { name: "Character sections" }).getByRole("button", { name: new RegExp(`^${name} ·`) }).click();
}

test("deleting an existing character edits only the open World draft", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 0, worldCount: 1, campaignCount: 0 });
  const api = await installLegacyUiFixture(page, fixture);
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await page.locator(`#worldManagementCarousel [data-world-id="${fixture.worldId}"]`).click();
  await page.locator("#editWorldDraft").click();
  await page.locator('[data-world-author-step="character"]').click();
  await page.getByRole("button", { name: "Edit The Observer" }).click();
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#deleteCharacter").click();
  await expect(page.locator("#characterDialog")).toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#deleteCharacter").click();
  await expect(page.locator("#playableCharacterRoster")).toContainText("No characters yet");
  expect(api.writes).toHaveLength(0);
});

for (const width of [1440, 390]) test(`campaign aliases and reviewed Organize provenance survive Save at ${width}px`, async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const path = `/api/v1/campaigns/${fixture.campaignId}/character-profile`;
  const api = await installLegacyUiFixture(page, fixture);
  const saves = () => api.writes.filter(write => write.path === path && write.method === "PUT").map(write => write.body);
  const protocolVersion = "fixture-organizer-reviewed-v3";
  await page.route(`**${path}/organize`, route => route.fulfill({ json: {
    candidate: characterProfileSchema.parse({ appearance: { clothing: "blue cloak" } }),
    evidence: [{ path: "appearance.clothing", source: "legacyGuidance", quote: "blue cloak" }],
    conflicts: [], warnings: [], unassignedText: [], protocolVersion
  } }));
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await page.locator(`#campaignList [data-campaign-id="${fixture.campaignId}"]`).click();
  await page.locator("#editCampaignCharacter").click();
  await worldSection(page, "Identity");
  await page.locator("#characterAliases").fill("Wren, the Keeper\nNorth Star");
  await worldSection(page, "History and notes");
  await page.locator("#organizeCharacterProfile").click();
  await expect(page.locator("#characterProfileReviewList")).toContainText("blue cloak");
  expect(await page.locator("#characterProfileReviewDialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: resolve(evidenceDirectory, `campaign-organize-review-${width}.png`) });
  await page.locator("#applyCharacterProfileReview").click();
  expect(saves()).toHaveLength(0);
  await page.locator("#saveCharacter").click();
  await expect(page.locator("#characterDialog")).toBeHidden();
  expect(saves()).toHaveLength(1);
  expect(saves()[0]).toMatchObject({
    expectedRevision: 3, editSource: "ai_organized", organizerProtocolVersion: protocolVersion,
    profile: { identity: { aliases: ["Wren, the Keeper", "North Star"] }, appearance: { clothing: "blue cloak" } }
  });
  await page.locator("#editCampaignCharacter").click();
  await worldSection(page, "Identity");
  await expect(page.locator("#characterAliases")).toHaveValue("Wren, the Keeper\nNorth Star");
  await worldSection(page, "History and notes");
  await page.locator("#organizeCharacterProfile").click();
  await page.locator("#cancelCharacterProfileReview").click();
  await worldSection(page, "Overview");
  await page.locator("#characterRole").fill("Archivist");
  await page.locator("#saveCharacter").click();
  await expect(page.locator("#characterDialog")).toBeHidden();
  expect(saves()).toHaveLength(2);
  expect(saves()[1]).toMatchObject({ expectedRevision: 4, editSource: "manual" });
  expect(saves()[1]).not.toHaveProperty("organizerProtocolVersion");
});

test("invalid hidden mechanics field opens its disclosure before focus", async ({ page }) => {
  await openNewWorld(page);
  await page.locator("#addPlayableCharacter").click();
  await expect(page.locator("#characterDialog")).toBeVisible();
  await page.locator("#characterName").fill("Mira Vale");
  await page.locator("#characterRole").fill("Guide");
  await page.getByRole("button", { name: "Continue in detailed editor" }).click();
  await worldSection(page, "Mechanics");
  await page.locator("#characterMechanics summary").click();
  await page.locator("#addCharacterStat").click();
  await page.locator('#characterStats [data-character-field="name"]').last().fill("Resolve");
  const value = page.locator('#characterStats [data-character-field="value"]').last();
  await value.fill("100");
  await page.locator("#characterMechanics summary").click();
  await page.locator("#saveCharacter").click();
  await expect(page.locator("#characterStatus")).toContainText("whole number from 1 to 99");
  await expect(page.locator("#characterMechanics")).toHaveJSProperty("open", true);
  await expect(value).toBeFocused();
  await expect(page.locator("#characterStatus")).toContainText("whole number from 1 to 99");
});

test("Apply then cancel parent warns and Stay keeps the applied draft without a POST", async ({ page }) => {
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  await openNewWorld(page, writes);
  await page.locator("#addPlayableCharacter").click();
  await page.locator("#characterName").fill("Applied guide");
  await page.locator("#characterRole").fill("Keeps the trail");
  await page.locator("#saveCharacter").click();
  await page.locator("#cancelWorldAuthor").click();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.locator('#discardChangesDialog button[value="keep"]').click();
  await expect(page.locator("#playableCharacterRoster")).toContainText("Applied guide");
  expect(writes).toEqual([]);
});

test("Genre and tone stay optional and disclosure toggling alone does not dirty the world draft", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 0, worldCount: 1, campaignCount: 0 });
  mkdirSync(evidenceDirectory, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await installLegacyUiFixture(page, fixture);
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await page.locator(`#worldManagementCarousel [data-world-id="${fixture.worldId}"]`).click();
  await page.locator("#editWorldDraft").click();
  await expect(page.locator("#worldTitle")).toHaveValue("Fixture World 1");
  await expect(page.locator("#worldGenreToneDisclosure summary")).toBeVisible();
  await expect(page.locator("#worldGenre")).toBeHidden();
  await page.locator("#worldGenreToneDisclosure summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#worldGenre")).toBeVisible();
  await expect(page.locator("#worldGenre")).toHaveValue("Quiet mystery");
  await page.locator("#worldGenreToneDisclosure summary").click();
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await expect(page.locator("#worldGenreToneDisclosure summary")).toBeVisible();
  await page.screenshot({ path: resolve(evidenceDirectory, "world-genre-tone-collapsed-at-200-percent.png"), fullPage: false });
  await page.evaluate(() => { document.documentElement.style.zoom = "1"; });
  await page.locator("#cancelWorldAuthor").click();
  await expect(page.locator("#worldAuthorDialog")).toBeHidden();
  await expect(page.locator("#discardChangesDialog")).toBeHidden();
});

test("world save busy state freezes disclosures and restores their open state after an API error", async ({ page }) => {
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
  const saveStarted = new Promise<void>((resolveStarted) => { started = resolveStarted; });
  await openNewWorld(page, [], { holdWorldSave: async () => { started(); await held; } });
  await page.locator('[data-world-author-step="basics"]').click();
  const summary = page.locator("#worldGenreToneDisclosure summary");
  await summary.click();
  await page.locator("#saveWorldDraft").click();
  await saveStarted;
  await expect(summary).toHaveAttribute("aria-disabled", "true");
  await expect(summary).toHaveAttribute("tabindex", "-1");
  await summary.evaluate((element: HTMLElement) => element.click());
  await expect(page.locator("#worldGenreToneDisclosure")).toHaveJSProperty("open", true);
  release();
  await expect(page.locator("#worldAuthorStatus")).toContainText("Synthetic retryable draft save failure");
  await expect(summary).not.toHaveAttribute("aria-disabled");
  await expect(summary).toHaveAttribute("tabindex", "0");
  await expect(page.locator("#worldGenreToneDisclosure")).toHaveJSProperty("open", true);
  await expect(page.locator("#saveWorldDraft")).toBeEnabled();
});

test("character organization busy state freezes disclosure navigation and restores imported values after API error", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 0, worldCount: 1, campaignCount: 0 });
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
  const requestStarted = new Promise<void>((resolveStarted) => { started = resolveStarted; });
  mkdirSync(evidenceDirectory, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await installLegacyUiFixture(page, fixture);
  await page.route("**/api/v1/worlds/*/draft/playable-characters/organize", async (route) => {
    started();
    await held;
    await route.fulfill({ status: 503, json: { error: "ServiceUnavailable", message: "Synthetic organization failure." } });
  });
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await page.locator(`#worldManagementCarousel [data-world-id="${fixture.worldId}"]`).click();
  await page.locator("#editWorldDraft").click();
  await page.locator('[data-world-author-step="character"]').click();
  await page.getByRole("button", { name: "Edit The Observer" }).click();
  await page.locator("#characterRole").fill("Synthetic guide");
  const mechanicsSummary = page.locator("#characterMechanics > summary");
  await worldSection(page, "Mechanics");
  await mechanicsSummary.click();
  await worldSection(page, "History and notes");
  await page.locator("#organizeCharacterProfile").click();
  await requestStarted;
  await expect(mechanicsSummary).toHaveAttribute("aria-disabled", "true");
  await expect(mechanicsSummary).toHaveAttribute("tabindex", "-1");
  await mechanicsSummary.evaluate((element: HTMLElement) => element.click());
  await expect(page.locator("#characterMechanics")).toHaveJSProperty("open", true);
  release();
  await expect(page.locator("#characterStatus")).toContainText("Synthetic organization failure.");
  await expect(page.locator("#characterRole")).toHaveValue("Synthetic guide");
  await expect(mechanicsSummary).toHaveAttribute("aria-disabled", "false");
  await expect(mechanicsSummary).toHaveAttribute("tabindex", "0");
  await expect(page.locator("#characterMechanics")).toHaveJSProperty("open", true);
  await page.screenshot({ path: resolve(evidenceDirectory, "character-organization-error-retains-form.png") });
});

test("character sections support keyboard navigation and narrow zoom-equivalent layout", async ({ page }) => {
  await openNewWorld(page);
  await page.locator("#addPlayableCharacter").click();
  await page.getByRole("button", { name: "Continue in detailed editor" }).click();
  const appearance = page.getByRole("navigation", { name: "Character sections" }).getByRole("button", { name: /^Appearance ·/ });
  await appearance.focus(); await page.keyboard.press("Enter");
  await expect(page.locator("#characterClothing")).toBeVisible();
  await page.setViewportSize({ width: 640, height: 400 });
  await expect(page.getByRole("combobox", { name: "Section", exact: true })).toBeVisible();
  await expect(page.locator("#saveCharacter")).toBeInViewport();
  await page.screenshot({ path: resolve(evidenceDirectory, "character-appearance-keyboard-200-percent.png") });
});

test("existing imported advanced character round-trips source, unknown fields, and mechanic metadata unchanged", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 0, worldCount: 1, campaignCount: 0 });
  const world = fixture.worldDetails.get(fixture.worldId)! as Record<string, any>;
  const character = {
    id: "fixture-observer",
    name: "Imported Mira",
    characterText: "Preserved source",
    profile: { identity: { aliases: ["North Star"] }, story: { role: "Guide", background: "Old road" }, appearance: { clothing: "Blue mantle", extra: "Keep" }, legacyExtension: { token: "retained" } },
    rpgStats: [{ id: "stat-1", name: "Resolve", value: 17, note: "Steady", imported: "retained" }],
    defaultTriggers: [{ id: "tracker-1", name: "Lantern oil", value: "3 flasks", rules: "Spend nightly", imported: "retained" }],
    source: { type: "portable-import", id: "source-1" },
    customExtension: { kept: true }
  };
  world.draftContent.playableCharacters = [character];
  for (const version of world.versions) version.content.playableCharacters = [character];
  mkdirSync(evidenceDirectory, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  const api = await installLegacyUiFixture(page, fixture);
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await page.locator(`#worldManagementCarousel [data-world-id="${fixture.worldId}"]`).click();
  await page.locator("#editWorldDraft").click();
  await page.locator('[data-world-author-step="character"]').click();
  await page.getByRole("button", { name: "Edit Imported Mira" }).click();
  await expect(page.locator(".character-workspace")).toBeVisible();
  await worldSection(page, "History and notes");
  await expect(page.locator("#characterGuidance")).toHaveValue("Preserved source");
  await expect(page.locator("#characterGuidance")).toBeVisible();
  await page.locator("#saveCharacter").click();
  await page.locator("#saveWorldDraft").click();
  const save = api.writes.find((write) => write.method === "PUT" && write.path.endsWith("/draft"))?.body as { content?: { playableCharacters?: unknown[] } };
  expect(save.content?.playableCharacters?.[0]).toEqual(character);
  await page.screenshot({ path: resolve(evidenceDirectory, "imported-advanced-character-roundtrip.png") });
});
test("campaign Organize review survives generation lock and profile conflict", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const path = `/api/v1/campaigns/${fixture.campaignId}/character-profile`;
  const api = await installLegacyUiFixture(page, fixture);
  const saves = () => api.writes.filter(write => write.path === path && write.method === "PUT");
  let generationActive = false, conflict = true;
  await page.route(`**/api/v1/campaigns/${fixture.campaignId}/sync-status`, route => route.fulfill({ json: {
    ...fixture.syncStatus,
    pendingGeneration: generationActive ? { id: "88888888-8888-4888-8888-888888888888", status: "generating", action: "Look", expectedTurnNumber: 2,
      createdAt: "2026-09-16T12:00:00.000Z", updatedAt: "2026-09-16T12:00:00.000Z", operationKind: "append", replacementTurnId: null } : null
  } }));
  await page.route(`**${path}/organize`, route => route.fulfill({ json: {
    candidate: characterProfileSchema.parse({ appearance: { clothing: "blue cloak" } }),
    evidence: [{ path: "appearance.clothing", source: "legacyGuidance", quote: "blue cloak" }], conflicts: [], warnings: [], unassignedText: [], protocolVersion: "fixture-organizer-v1"
  } }));
  await page.route(`**${path}`, route => {
    if (route.request().method() === "PUT" && conflict) {
      conflict = false;
      return route.fulfill({ status: 409, json: { error: "fixture_error", message: "Profile changed", details: { code: "state_revision_changed" } } });
    }
    return route.fallback();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await page.locator(`#campaignList [data-campaign-id="${fixture.campaignId}"]`).click();
  await page.locator("#editCampaignCharacter").click();
  await worldSection(page, "History and notes");
  await page.locator("#organizeCharacterProfile").click();
  const review = page.locator("#characterProfileReviewDialog"), apply = page.locator("#applyCharacterProfileReview");
  await expect(review).toContainText("blue cloak"); await expect(apply).toBeEnabled();
  generationActive = true;
  await apply.click();
  await expect(apply).toBeDisabled();
  await expect(review).toContainText("Proposals are retained");
  await expect(page.locator("#saveCharacter")).toBeDisabled();
  generationActive = false;
  await review.getByRole("button", { name: "Check generation status" }).click();
  await expect(apply).toBeEnabled();
  await apply.click(); await expect(review).toBeHidden();
  await page.locator("#saveCharacter").click();
  const editor = page.locator("#characterDialog");
  await expect(editor).toContainText("Compare the latest");
  await expect(page.locator("#saveCharacter")).toBeDisabled();
  await editor.getByRole("button", { name: "Compare latest", exact: true }).click();
  await editor.getByRole("button", { name: "Reapply my changes", exact: true }).click();
  await expect(page.locator("#saveCharacter")).toBeEnabled();
  await page.locator("#saveCharacter").click();
  await expect(editor).toBeHidden();
  expect(saves()).toHaveLength(1);
  expect(saves()[0]!.body).toMatchObject({ editSource: "ai_organized", organizerProtocolVersion: "fixture-organizer-v1", profile: { appearance: { clothing: "blue cloak" } } });
});

for (const operation of ["Generate", "Organize"] as const) for (const succeeds of [true, false]) test(`detailed ${operation} ${succeeds ? "success" : "failure"} retains editing and retry`, async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 0, worldCount: 1, campaignCount: 0 });
  await installLegacyUiFixture(page, fixture);
  let requests = 0;
  const path = operation === "Generate" ? "**/api/v1/worlds/playable-characters/generate-preview" : "**/api/v1/worlds/*/draft/playable-characters/organize";
  await page.route(path, route => {
    requests++;
    if (!succeeds) return route.fulfill({ status: 503, json: { error: "unavailable", message: "Synthetic detailed AI failure." } });
    const profile = characterProfileSchema.parse({ story: { role: "Generated guide" }, appearance: { eyes: "Green" } });
    return route.fulfill({ json: operation === "Generate" ? { character: { id: "provider-character", name: "Mira", characterText: "Guide", profile, rpgStats: [], defaultTriggers: [], source: {} } } : { candidate: profile, evidence: [], conflicts: [], warnings: [], unassignedText: [], protocolVersion: "fixture-organizer" } });
  });
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await page.locator(`#worldManagementCarousel [data-world-id="${fixture.worldId}"]`).click();
  await page.locator("#editWorldDraft").click();
  await page.locator('[data-world-author-step="character"]').click();
  await page.getByRole("button", { name: "Edit The Observer", exact: true }).click();
  await expect(page.locator(".character-workspace")).toBeVisible();
  await page.locator("#characterRole").fill("Supplied guide facts");
  const invoke = async () => {
    await worldSection(page, operation === "Generate" ? "Overview" : "History and notes");
    if (operation === "Generate") {
      await page.locator("#characterGenerator").evaluate((node: HTMLDetailsElement) => { node.open = true; });
      await page.locator("#characterGeneratorPrompt").fill("A patient guide");
      page.once("dialog", confirm => confirm.accept());
      await page.locator("#generateCharacter").click();
    } else await page.locator("#organizeCharacterProfile").click();
  };
  const finishReview = async () => {
    if (operation === "Organize" && succeeds) {
      await expect(page.locator("#characterProfileReviewDialog")).toBeVisible();
      await page.locator("#characterProfileReviewDialog").evaluate((node: HTMLDialogElement) => node.close());
    }
    await expect(page.locator("#characterStatus")).toContainText(succeeds ? operation === "Generate" ? "Character generated" : "Review the evidence" : "Synthetic detailed AI failure");
  };
  await invoke(); await finishReview();
  await worldSection(page, "Overview");
  await expect(page.locator("#characterName")).toBeEnabled();
  await page.locator("#characterName").fill("Authored after AI");
  await expect(page.locator("#characterRole")).toBeEnabled();
  await page.locator("#characterRole").fill("Edited after AI");
  await worldSection(page, "Appearance");
  await page.locator("#characterClothing").fill("Authored coat");
  await invoke(); await finishReview();
  expect(requests).toBe(2);
  await worldSection(page, "Overview");
  await expect(page.locator("#characterName")).toBeEnabled();
  await page.locator("#characterName").fill("Still editable after retry");
});
