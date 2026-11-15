import { expect, test } from "@playwright/test";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
const screenshots = process.env.CAST_SCREENSHOT_ROOT ?? join(tmpdir(), "nexus-character-workspace-evidence");
const base = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
test("browser Back keeps the parent world open while deciding a dirty child, then Apply and Save persist", async ({ page }, info) => {
  const fixture = legacyUiFixture({ turnCount: 0, worldCount: 1, campaignCount: 0 });
  await installLegacyUiFixture(page, fixture);
  const saves: any[] = [];
  await page.route(`**/api/v1/worlds/${fixture.worldId}/draft`, async route => {
    saves.push(route.request().postDataJSON());
    await route.fulfill({ json: { revision: 2 } });
  });
  await page.goto(`${base}/nexus/index.html#dashboard`);
  await page.evaluate(() => { location.hash = "world-library"; });
  await page.locator(`#worldManagementCarousel [data-world-id="${fixture.worldId}"]`).click();
  await page.locator("#editWorldDraft").click();
  await page.locator('[data-world-author-step="character"]').click();
  await page.locator("#addPlayableCharacter").click();
  await page.locator("#characterName").fill("History survivor");
  await page.locator("#characterRole").fill("Guide");
  await page.goBack();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.locator("#worldAuthorDialog")).toBeVisible();
  await expect(page.locator("#characterDialog")).toBeVisible();
  await expect(page.locator("#characterName")).toHaveValue("History survivor");
  await page.screenshot({ path: process.env.CAST_SCREENSHOT_ROOT ? `${process.env.CAST_SCREENSHOT_ROOT}/final-fix-history-kept.png` : info.outputPath("history-kept.png") });
  await page.locator("#saveCharacter").click();
  await expect(page.locator("#worldAuthorDialog")).toBeVisible();
  await page.locator("#saveWorldDraft").click();
  await expect.poll(() => saves.length).toBe(1);
  await expect(page.locator("#worldAuthorDialog")).toBeHidden();
  expect(saves[0].content.playableCharacters.find((person: any) => person.name === "History survivor")).toMatchObject({ profile: { story: { role: "Guide" } } });
});

for (const filtered of [false, true]) test(`world Apply returns focus to ${filtered ? "roster heading when filtered" : "replacement edit button"}`, async ({ page }, info) => {
  await page.route("**/api/v1/**", route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/worlds") ? { worlds: [] } : { campaigns: [], providers: [] } }));
  await page.goto(`${base}/nexus/index.html#world-library`);
  await page.locator("#newWorld").click();
  await page.locator('[data-world-author-step="character"]').click();
  if (filtered) await page.getByRole("searchbox", { name: "Search characters" }).fill("not-visible");
  await page.locator("#addPlayableCharacter").click();
  await page.locator("#characterName").fill("Focus traveler");
  await page.locator("#characterRole").fill("Guide");
  await page.locator("#saveCharacter").click();
  if (filtered) await expect(page.locator(".character-roster-heading strong")).toBeFocused();
  else {
    const edit = page.getByRole("button", { name: "Edit Focus traveler", exact: true });
    await expect(edit).toBeFocused();
    await edit.click();
    await page.locator("#characterName").fill("Renamed traveler");
    await page.locator("#saveCharacter").click();
    await expect(page.getByRole("button", { name: "Edit Renamed traveler", exact: true })).toBeFocused();
  }
  await page.screenshot({ path: process.env.CAST_SCREENSHOT_ROOT ? `${process.env.CAST_SCREENSHOT_ROOT}/final-fix-focus-${filtered}.png` : info.outputPath(`focus-${filtered}.png`) });
});
async function mount(page: import("@playwright/test").Page) {
  await page.goto(`${base}/nexus/index.html`);
  await page.evaluate(async () => {
    const modulePath = "/nexus/src/character-editor/workspace.ts";
    const { mountCharacterWorkspace } = await import(/* @vite-ignore */ modulePath);
    document.body.replaceChildren();
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/nexus/nexus.css"; document.head.append(link);
    const opener = document.createElement("button"); opener.textContent = "Open character"; document.body.append(opener); opener.focus();
    const dialog = document.createElement("dialog"); document.body.append(dialog); dialog.showModal();
    const overview = document.createElement("div"); overview.innerHTML = '<label>Name<input id="fixture-name" value="Mira Vale"></label>';
    const identity = document.createElement("div"); identity.innerHTML = '<label>Aliases<textarea id="fixture-aliases">The Wanderer</textarea></label>';
    dialog.append(overview, identity);
    const state = { name: "Mira Vale", destination: "World draft: Example", status: "Changes not applied to world draft", dirty: true, busy: false, locked: false, readOnly: false, sections: [{ id: "overview", label: "Overview", populated: 1, errors: 0, detail: "1 detail" }, { id: "identity", label: "Identity", populated: 1, errors: 1, detail: "1 detail" }] };
    let closes = 0;
    const workspace = mountCharacterWorkspace(dialog, { snapshot: () => state, flush() {}, async commit() { if (document.body.dataset.fail) throw new Error("Offline"); return "blocked"; }, async requestClose() { document.body.dataset.closes = String(++closes); return false; } }, { sections: new Map([["overview", overview], ["identity", identity]]), preview() { const p = document.createElement("p"); p.textContent = '<img src=x onerror="alert(1)">'; return p; } });
    Object.assign(window, { fixture: { workspace, state, dialog } });
  });
}
test("workspace keeps controls, guards exits, reveals errors and safely previews", async ({ page }) => {
  await mount(page);
  await expect(page.getByText("World draft: Example", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Identity.*1 error/ }).click();
  await expect(page.locator("#fixture-aliases")).toBeVisible();
  await page.locator("#fixture-aliases").fill("Retained alias");
  await page.getByRole("button", { name: "Preview sheet", exact: true }).click();
  await expect(page.getByText('<img src=x onerror="alert(1)">', { exact: true })).toBeVisible();
  await expect(page.locator(".character-workspace-preview img")).toHaveCount(0);
  await page.getByRole("button", { name: "Return to editing" }).click();
  await expect(page.locator("#fixture-aliases")).toHaveValue("Retained alias");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("body")).toHaveAttribute("data-closes", "2");
  await expect(page.locator("dialog")).toBeVisible();
  await page.evaluate(() => (window as any).fixture.workspace.reveal("overview", document.querySelector("#fixture-name")));
  await expect(page.locator("#fixture-name")).toBeFocused();
  await page.screenshot({ path: `${screenshots}/workspace-error-focus.png` });
  await page.evaluate(() => { (window as any).fixture.workspace.dispose(); (window as any).fixture.dialog.close(); });
  await expect(page.getByRole("button", { name: "Open character" })).toBeFocused();
  await expect(page.locator("dialog > div #fixture-name")).toHaveValue("Mira Vale");
  await expect(page.locator("dialog > div #fixture-aliases")).toHaveValue("Retained alias");
});
for (const width of [1280, 390, 320, 640]) test(`workspace fits ${width}px and locks retain values`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 }); await mount(page);
  await expect(page.getByRole("button", { name: "Apply to world draft" })).toBeInViewport();
  await page.screenshot({ path: `${screenshots}/workspace-${width}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { (window as any).fixture.state.locked = true; (window as any).fixture.workspace.refresh(); });
  await expect(page.locator("#fixture-name")).toBeDisabled();
  await expect(page.locator("#fixture-name")).toHaveValue("Mira Vale");
});


test("blocked commit reveals errors and rejected commit keeps failure visible", async ({ page }) => {
  await mount(page);
  await page.getByRole("button", { name: "Apply to world draft" }).click();
  await expect(page.locator("#fixture-aliases")).toBeVisible();
  await page.evaluate(() => { document.body.dataset.fail = "true"; });
  await page.getByRole("button", { name: "Apply to world draft" }).click();
  await expect(page.getByRole("status")).toHaveText("Save failed; your changes are kept");
});
test("short CSS viewport remains usable", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 500 }); await mount(page);
  await expect(page.getByRole("button", { name: "Apply to world draft" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${screenshots}/workspace-zoom-200.png` });
});

for (const validation of ["aria", "native"]) test(`blocked commit focuses ${validation} invalid control`, async ({ page }) => {
  await mount(page);
  await page.evaluate((kind) => {
    const control = document.querySelector<HTMLTextAreaElement>("#fixture-aliases")!;
    if (kind === "aria") control.setAttribute("aria-invalid", "true");
    else { control.required = true; control.value = ""; }
  }, validation);
  await page.getByRole("button", { name: "Apply to world draft" }).click();
  await expect(page.locator("#fixture-aliases")).toBeEnabled();
  await expect(page.locator("#fixture-aliases")).toBeFocused();
  await page.screenshot({ path: `${screenshots}/workspace-blocked-${validation}-focus.png` });
});

test("narrow selector and adjacent navigation retain values and keyboard order", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 }); await mount(page);
  const section = page.getByLabel("Section", { exact: true });
  await section.selectOption("identity");
  await expect(page.getByRole("heading", { name: "Identity", exact: true })).toBeFocused();
  await page.locator("#fixture-aliases").fill("Keyboard alias");
  await page.getByRole("button", { name: "Previous section" }).click();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Next section" }).click();
  await expect(page.getByRole("heading", { name: "Identity", exact: true })).toBeFocused();
  await expect(page.locator("#fixture-aliases")).toHaveValue("Keyboard alias");
  await page.keyboard.press("Tab");
  await expect(page.locator("#fixture-aliases")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Preview sheet", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Apply to world draft", exact: true })).toBeFocused();
});

test("world creation starts quick and continues incomplete without writes", async ({ page }) => {
  await page.route("**/api/v1/**", route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path.endsWith("/session") ? { user: { id: "00000000-0000-4000-8000-000000000001" }, capabilities: {} } : path.endsWith("/providers") ? { providers: [] } : path.endsWith("/worlds") ? { worlds: [] } : { campaigns: [] } });
  });
  await page.goto(`${base}/nexus/index.html#world-library`);
  await page.locator("#newWorld").click();
  await page.locator('[data-world-author-step="character"]').click();
  await page.locator("#addPlayableCharacter").click();
  await expect(page.locator(".character-quick-create")).toBeVisible();
  await page.locator("#characterName").fill("Incomplete traveler");
  await page.getByRole("button", { name: "Continue in detailed editor", exact: true }).click();
  await expect(page.locator(".character-workspace")).toBeVisible();
  await expect(page.locator("#characterName")).toHaveValue("Incomplete traveler");
  await expect(page.locator("#playableCharacterRoster")).not.toContainText("Incomplete traveler");
});

for (const width of [1280, 390]) test(`world Apply stays local and failed parent Save retains retry values at ${width}px`, async ({ page }) => {
  const posts: any[] = [];
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/worlds") && route.request().method() === "POST") {
      posts.push(route.request().postDataJSON());
      return route.fulfill({ status: posts.length === 1 ? 409 : 503, json: { error: "unavailable", message: "Fixture world save failed; retry." } });
    }
    return route.fulfill({ json: path.endsWith("/session") ? { user: { id: "00000000-0000-4000-8000-000000000001" }, capabilities: {} } : path.endsWith("/providers") ? { providers: [] } : path.endsWith("/worlds") ? { worlds: [] } : { campaigns: [] } });
  });
  await page.goto(`${base}/nexus/index.html#world-library`);
  await page.locator("#newWorld").click();
  await page.locator("#worldTitle").fill("Retry destination");
  await page.locator('[data-world-author-step="character"]').click();
  await page.locator("#addPlayableCharacter").click();
  await page.locator("#characterName").fill("Supporting traveler");
  await page.locator("#characterCampaignUse").selectOption("supporting");
  await page.screenshot({ path: `${screenshots}/world-quick-${width}.png` });
  await page.locator("#saveCharacter").click();
  await expect(page.locator("#characterDialog")).toBeHidden();
  expect(posts).toHaveLength(0);
  await expect(page.locator("#worldAuthorDialog")).toContainText("Save the world form to persist this change");
  await page.screenshot({ path: `${screenshots}/world-applied-unsaved-${width}.png` });
  await page.locator("#saveWorldDraft").click();
  await expect.poll(() => posts.length).toBe(1);
  await expect(page.locator("#worldAuthorDialog")).toBeVisible();
  await expect(page.locator("#worldAuthorDialog")).toContainText("Your entries are still here");
  await page.screenshot({ path: `${screenshots}/world-save-error-${width}.png` });
  await page.locator("#saveWorldDraft").click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1].content.playableCharacters).toEqual(posts[0].content.playableCharacters);
  expect(posts[0].content.playableCharacters).toHaveLength(1);
  expect(posts[0].content.playableCharacters[0]).toMatchObject({ name: "Supporting traveler", campaignUse: "supporting" });
});

test("world staged Apply and leave keeps invalid input until corrected", async ({ page }) => {
  await page.route("**/api/v1/**", route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path.endsWith("/providers") ? { providers: [] } : path.endsWith("/worlds") ? { worlds: [] } : { campaigns: [] } });
  });
  await page.goto(`${base}/nexus/index.html#world-library`);
  await page.locator("#newWorld").click();
  await page.locator('[data-world-author-step="character"]').click();
  await page.locator("#addPlayableCharacter").click();
  await page.locator("#characterName").fill("Needs guidance");
  await page.locator("#cancelCharacter").click();
  await page.getByRole("button", { name: "Apply and leave" }).click();
  await expect(page.locator("#characterDialog")).toBeVisible();
  await expect(page.locator("#characterName")).toHaveValue("Needs guidance");
  await page.locator("#characterRole").fill("Guide");
  await page.locator("#cancelCharacter").click();
  await page.getByRole("button", { name: "Apply and leave" }).click();
  await expect(page.locator("#characterDialog")).toBeHidden();
  await expect(page.getByRole("button", { name: "Edit Needs guidance", exact: true })).toBeVisible();
});

test("quick presentation honors adapter locks and retains rejected-save feedback", async ({ page }) => {
  await page.goto(`${base}/nexus/index.html`);
  await page.evaluate(async () => {
    const modulePath = "/nexus/src/character-editor/quick-create.ts";
    const { mountQuickCharacterCreate } = await import(/* @vite-ignore */ modulePath);
    document.body.replaceChildren();
    const dialog = document.createElement("dialog"), fields = document.createElement("div"); fields.innerHTML = '<label>Name<input value="Mira"></label>'; document.body.append(dialog); dialog.append(fields); dialog.showModal();
    const state = { name: "Mira", destination: "Campaign", status: "Unsaved changes", dirty: true, busy: false, locked: true, readOnly: false, sections: [] };
    let commits = 0, continues = 0, closes = 0;
    mountQuickCharacterCreate(dialog, { context: "campaign-supporting", fields, port: { snapshot: () => state, flush() {}, async commit() { commits++; throw new Error("Offline"); }, async requestClose() { closes++; return false; } }, onContinue() { continues++; } });
    Object.assign(window, { quickFixture: { state, counts: () => ({ commits, continues, closes }) } });
  });
  await page.getByRole("button", { name: "Create campaign character" }).click();
  await page.getByRole("button", { name: "Continue in detailed editor" }).click();
  expect(await page.evaluate(() => (window as any).quickFixture.counts())).toEqual({ commits: 0, continues: 0, closes: 0 });
  await page.evaluate(() => { (window as any).quickFixture.state.locked = false; });
  await page.getByRole("button", { name: "Create campaign character" }).click();
  await expect(page.getByRole("status")).toHaveText("Save failed; your changes are kept");
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Mira");
  await page.evaluate(() => { (window as any).quickFixture.state.busy = true; });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => (window as any).quickFixture.counts())).toEqual({ commits: 1, continues: 0, closes: 0 });
});

test("workspace lock preserves adapter disabled policies without caching transient busy values", async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const policy = document.createElement("input"); policy.id = "fixture-policy"; policy.disabled = true;
    document.querySelector("#fixture-name")!.parentElement!.append(policy);
    (window as any).fixture.state.busy = true; (window as any).fixture.workspace.refresh();
    // Adapter completion may reenable its controls before the shell refreshes.
    (document.querySelector("#fixture-name") as HTMLInputElement).disabled = false;
  });
  await expect(page.locator("#fixture-name")).toBeDisabled();
  await expect(page.locator("#fixture-policy")).toBeDisabled();
  await page.evaluate(() => { (window as any).fixture.state.busy = false; (window as any).fixture.workspace.refresh(); });
  await expect(page.locator("#fixture-name")).toBeEnabled();
  await expect(page.locator("#fixture-policy")).toBeDisabled();
  await page.evaluate(() => (window as any).fixture.workspace.dispose());
  await expect(page.locator("#fixture-name")).toBeEnabled();
  await expect(page.locator("#fixture-policy")).toBeDisabled();
});


test("world character refinement explains when no default provider is configured", async ({ page }) => {
  await page.route("**/api/v1/**", route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path.endsWith("/providers") ? { providers: [] } : path.endsWith("/worlds") ? { worlds: [] } : { campaigns: [] } });
  });
  await page.goto(`${base}/nexus/index.html#world-library`);
  await page.locator("#newWorld").click();
  await page.locator('[data-world-author-step="character"]').click();
  await page.locator("#addPlayableCharacter").click();
  await page.getByRole("button", { name: "Continue in detailed editor" }).click();
  await page.getByRole("button", { name: /^Appearance ·/ }).click();
  await expect(page.getByText("To refine with AI, choose a default text provider and model in Provider Setup.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Refine with AI" })).toBeDisabled();
});


for (const width of [1280, 390]) test(`world appearance refinement preserves unsaved character at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = legacyUiFixture({ turnCount: 0, worldCount: 0, campaignCount: 0 });
  await installLegacyUiFixture(page, fixture);
  const requests: any[] = [];
  await page.route("**/api/v1/worlds/playable-characters/generate-preview", async route => {
    const request = route.request().postDataJSON(); requests.push(request);
    const current = request.content.playableCharacters.find((character: any) => character.id === request.characterId);
    const character = structuredClone(current);
    character.name = "Rejected name"; character.profile.story.role = "Rejected role";
    character.profile.appearance.hair = '<img src=x onerror="alert(1)">'; character.rpgStats = [];
    await route.fulfill({ json: { character } });
  });
  await page.goto(`${base}/nexus/index.html#world-library`);
  await page.locator("#newWorld").click();
  await page.locator("#worldTitle").fill("Test world");
  await page.locator('[data-world-author-step="character"]').click();
  await page.locator("#addPlayableCharacter").click();
  await page.locator("#characterName").fill("Unsaved traveler");
  await page.locator("#characterRole").fill("Guide");
  await page.getByRole("button", { name: "Continue in detailed editor" }).click();
  if (width === 390) await page.getByLabel("Section", { exact: true }).selectOption("mechanics");
  else await page.getByRole("button", { name: /^Mechanics ·/ }).click();
  await page.locator("#characterMechanics summary").click();
  await page.locator("#addCharacterStat").click();
  await page.locator('#characterStats [data-character-field="name"]').fill("Resolve");
  await page.locator('#characterStats [data-character-field="value"]').fill("42");
  if (width === 390) await page.getByLabel("Section", { exact: true }).selectOption("appearance");
  else await page.getByRole("button", { name: /^Appearance ·/ }).click();
  await page.locator("#characterHair").fill("Unsaved braid");
  await page.getByRole("button", { name: "Refine with AI" }).click();
  await page.getByLabel("What should change in Appearance?").fill("Change the hair");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByText('Proposed: <img src=x onerror="alert(1)">')).toBeVisible();
  expect(await page.locator('[data-refine-panel] img').count()).toBe(0);
  const sent = requests[0].content.playableCharacters.find((character: any) => character.id === requests[0].characterId);
  expect(sent).toMatchObject({ name: "Unsaved traveler", profile: { story: { role: "Guide" }, appearance: { hair: "Unsaved braid" } } });
  expect(sent.rpgStats).toMatchObject([{ name: "Resolve", value: 42 }]);
  await page.getByRole("button", { name: "Apply", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`refine-${width}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator("#characterHair")).toHaveValue('<img src=x onerror="alert(1)">');
  await expect(page.locator("#characterName")).toHaveValue("Unsaved traveler");
  await expect(page.locator("#characterRole")).toHaveValue("Guide");
  await expect(page.locator('#characterStats [data-character-field="value"]')).toHaveValue("42");
  await page.locator("#saveCharacter").click();
  await page.getByRole("button", { name: "Edit Unsaved traveler" }).click();
  if (width === 390) await page.getByLabel("Section", { exact: true }).selectOption("appearance");
  else await page.getByRole("button", { name: /^Appearance ·/ }).click();
  await page.locator("#characterHair").fill("Existing edit");
  await page.getByRole("button", { name: "Refine with AI" }).click();
  await page.getByLabel("What should change in Appearance?").fill("Change again");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
  expect(requests[1].content.playableCharacters.find((character: any) => character.id === requests[1].characterId).profile.appearance.hair).toBe("Existing edit");
  await page.locator("#characterHair").fill("Later local edit");
  await expect(page.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);
  await expect(page.locator("#characterHair")).toHaveValue("Later local edit");
});

test("world refinement discards a response after navigation or close", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 0, worldCount: 0, campaignCount: 0 });
  await installLegacyUiFixture(page, fixture);
  let release!: () => void; let requested = 0;
  await page.route("**/api/v1/worlds/playable-characters/generate-preview", async route => {
    const request = route.request().postDataJSON(); requested++;
    await new Promise<void>(resolve => { release = resolve; });
    const character = structuredClone(request.content.playableCharacters.find((item: any) => item.id === request.characterId));
    character.profile.appearance.hair = "Late proposal";
    await route.fulfill({ json: { character } }).catch(() => {});
  });
  await page.goto(`${base}/nexus/index.html#world-library`);
  await page.locator("#newWorld").click(); await page.locator("#worldTitle").fill("Test world"); await page.locator('[data-world-author-step="character"]').click();
  await page.locator("#addPlayableCharacter").click(); await page.locator("#characterName").fill("Traveler");
  await page.locator("#characterRole").fill("Guide"); await page.getByRole("button", { name: "Continue in detailed editor" }).click();
  await page.getByRole("button", { name: /^Appearance ·/ }).click();
  await page.getByRole("button", { name: "Refine with AI" }).click(); await page.getByLabel("What should change in Appearance?").fill("Change hair");
  await page.getByRole("button", { name: "Generate", exact: true }).click(); await expect.poll(() => requested).toBe(1);
  await page.getByRole("button", { name: /^Identity ·/ }).click(); release();
  await page.getByRole("button", { name: /^Appearance ·/ }).click();
  await expect(page.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Refine with AI" }).click(); await page.getByLabel("What should change in Appearance?").fill("Change hair");
  await page.getByRole("button", { name: "Generate", exact: true }).click(); await expect.poll(() => requested).toBe(2);
  await page.locator("#characterHair").fill("Later edit while pending"); release();
  await expect(page.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);
  await expect(page.locator("#characterHair")).toHaveValue("Later edit while pending");
  await page.getByRole("button", { name: "Refine with AI" }).click(); await page.getByLabel("What should change in Appearance?").fill("Change hair");
  await page.getByRole("button", { name: "Generate", exact: true }).click(); await expect.poll(() => requested).toBe(3);
  await page.locator("#cancelCharacter").click(); await page.getByRole("button", { name: "Discard edits" }).click(); release();
  await expect(page.locator("#characterDialog")).toBeHidden();
});
