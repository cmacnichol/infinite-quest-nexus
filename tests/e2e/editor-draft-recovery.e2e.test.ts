import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { characterProfileSchema } from "../../packages/contracts/src/world-library.js";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? 43173}`;
for (const surface of ["Story", "campaign"] as const) {
  async function setup(page: Page, conflict = true) {
    const fixture = legacyUiFixture({ turnCount: 1, campaignCount: 1, worldCount: 1 });
    await installLegacyUiFixture(page, fixture);
    let recovery = false;
    await page.route(`**/api/v1/campaigns/${fixture.campaignId}/sync-status`, route => route.fulfill({ json: {
      ...fixture.syncStatus, pendingGeneration: null,
      generationRecovery: recovery ? { id: "55555555-5555-4555-8555-555555555555", status: "recoverable" } : null
    } }));
    let latest = { name: "The Observer", profile: characterProfileSchema.parse({ story: { role: "Scout" } }), revision: 3 };
    let writes = 0;
    await page.route(`**/api/v1/campaigns/${fixture.campaignId}/character-profile`, route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { ...latest, campaignId: fixture.campaignId, characterId: "fixture-observer", storedProfile: { name: latest.name, profile: latest.profile }, inheritedFromSnapshot: false, legacyCharacterText: "", rpgStats: [], defaultTriggers: [] } });
      writes++;
      const body = route.request().postDataJSON();
      if (conflict && writes === 1) {
        latest = { name: "Concurrent name", profile: characterProfileSchema.parse({ story: { role: "Guide" } }), revision: 4 };
        return route.fulfill({ status: 409, json: { error: "Conflict", message: "Revision changed", code: "state_revision_changed", details: { code: "state_revision_changed" }, correlationId: "fixture-revision" } });
      }
      latest = { name: body.name, profile: body.profile, revision: 5 };
      return route.fulfill({ json: { ...latest, campaignId: fixture.campaignId } });
    });
    const isStory = surface === "Story";
    if (isStory) {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route(`**/story/${fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${origin}/story/${fixture.campaignId}`);
      await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
      await page.getByRole("button", { name: "Setup", exact: true }).click();
    } else {
      await page.goto(`${origin}/nexus/index.html#campaigns`);
      await page.locator(`#campaignList [data-campaign-id="${fixture.campaignId}"]`).click();
      await expect(page.locator("#campaignTitle")).toHaveValue("Fixture Campaign 1");
    }
    const opener = page.locator(isStory ? "#btnOpenEditCharacterProfile" : "#editCampaignCharacter");
    await opener.click();
    const dialog = page.locator(isStory ? "#editCharacterProfileDialog" : "#characterDialog");
    const role = dialog.locator('[data-character-profile-path="story.role"]');
    const name = dialog.getByRole("textbox", { name: /^(character )?name$/i });
    const save = dialog.getByRole("button", { name: /^Save (character|campaign)/i });
    return { dialog, role, name, save, opener, setRecovery(value: boolean) { recovery = value; }, get writes() { return writes; } };
  }

  test(`${surface} discards a conflicting draft and loads the latest profile`, async ({ page }) => {
    const editor = await setup(page);
    await editor.role.fill("Archivist");
    await editor.save.click();
    await expect(editor.dialog.getByText(/profile changed/i)).toBeVisible();
    await editor.dialog.getByRole("button", { name: "Compare latest" }).click();
    await expect(editor.dialog).toContainText("Concurrent name");
    await editor.dialog.getByRole("button", { name: "Discard draft and load latest" }).click();
    await expect(editor.name).toHaveValue("Concurrent name");
    await expect(editor.role).toHaveValue("Guide");
    await expect(editor.name).toBeFocused();
    await editor.dialog.getByRole("button", { name: /^(cancel|close)$/i }).first().click();
    await expect(editor.dialog).toBeHidden();
    await expect(surface === "Story" ? page.getByRole("button", { name: "Setup", exact: true }) : editor.opener).toBeFocused();
    expect(editor.writes).toBe(1);
  });

  test(`${surface} keeps and discards a dirty draft through the close prompt`, async ({ page }) => {
    const editor = await setup(page);
    await editor.role.fill("Archivist");
    await page.keyboard.press("Escape");
    await expect(editor.dialog.getByRole("button", { name: "Keep editing" })).toBeVisible();
    await expect(editor.dialog.getByRole("button", { name: "Save changes" })).toBeVisible();
    await expect(editor.dialog.getByRole("button", { name: "Discard changes" })).toBeVisible();
    await editor.dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(editor.role).toHaveValue("Archivist");
    await expect(editor.name).toBeFocused();
    await page.keyboard.press("Escape");
    await editor.dialog.getByRole("button", { name: "Discard changes" }).click();
    await expect(editor.dialog).toBeHidden();
    expect(editor.writes).toBe(0);
  });

  test(`${surface} saves from the dirty close prompt and restores focus`, async ({ page }) => {
    const editor = await setup(page, false);
    await editor.role.fill("Archivist");
    await page.keyboard.press("Escape");
    await editor.dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(editor.dialog).toBeHidden();
    expect(editor.writes).toBe(1);
    await expect(surface === "Story" ? page.getByRole("button", { name: "Setup", exact: true }) : editor.opener).toBeFocused();
  });

  test(`${surface} saves an existing profile with a name and no story guidance`, async ({ page }) => {
    const editor = await setup(page, false);
    await editor.role.fill("");
    await editor.save.click();
    await expect(editor.dialog).toBeHidden();
    expect(editor.writes).toBe(1);
  });

  test(`${surface} locks and unlocks a dirty draft when recovery begins`, async ({ page }) => {
    const editor = await setup(page);
    await editor.role.fill("Archivist");
    editor.setRecovery(true);
    await expect(editor.role).toBeDisabled({ timeout: 10000 });
    await expect(editor.role).toHaveValue("Archivist");
    editor.setRecovery(false);
    await expect(editor.role).toBeEnabled({ timeout: 10000 });
    await expect(editor.role).toHaveValue("Archivist");
  });
}
