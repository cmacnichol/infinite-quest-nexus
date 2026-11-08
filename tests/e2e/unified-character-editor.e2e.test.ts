import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { tabTo } from "./helpers/keyboard.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { characterProfileSchema } from "../../packages/contracts/src/world-library.js";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? 43173}`;

async function capture(page: Page, info: TestInfo, name: string) {
  const path = process.env.EDITOR_PHASE2_EVIDENCE
    ? resolve(process.env.EDITOR_PHASE2_EVIDENCE, name + ".png") : info.outputPath(name + ".png");
  await page.screenshot({ path });
}

for (const surface of ["Story", "campaign"] as const) for (const width of [1440, 390]) {
  test(`${surface} editor compares and reapplies only the author's changes by keyboard at ${width}px`, async ({ page }, info) => {
    const fixture = legacyUiFixture({ turnCount: 1, campaignCount: 1, worldCount: 1 });
    await installLegacyUiFixture(page, fixture);
    const url = `**/api/v1/campaigns/${fixture.campaignId}/character-profile`;
    const profile = characterProfileSchema.parse({ story: { role: "Scout" }, identity: { pronouns: "they/them" } });
    let latest = { name: "The Observer", profile, revision: 3 };
    let attempts = 0;
    await page.route(url, route => {
      if (route.request().method() === "GET") return route.fulfill({ json: {
        ...latest, campaignId: fixture.campaignId, characterId: "fixture-observer", storedProfile: { name: latest.name, profile: latest.profile },
        inheritedFromSnapshot: false, legacyCharacterText: "", rpgStats: [], defaultTriggers: []
      } });
      const body = route.request().postDataJSON();
      attempts++;
      if (attempts === 1) {
        expect(body.expectedRevision).toBe(3);
        latest = { ...latest, name: "Concurrent rename", revision: 4 };
        return route.fulfill({ status: 409, json: { message: "The campaign state changed.", details: { code: "state_revision_changed" } } });
      }
      expect(body).toMatchObject({ name: "Concurrent rename", expectedRevision: 4, editSource: "manual",
        profile: { identity: { pronouns: "they/them" }, story: { role: "Archivist" } } });
      latest = { name: body.name, profile: body.profile, revision: 5 };
      return route.fulfill({ json: { ...latest, campaignId: fixture.campaignId } });
    });
    await page.setViewportSize({ width, height: 900 });
    const isStory = surface === "Story";
    const opener = page.locator(isStory ? "#btnOpenEditCharacterProfile" : "#editCampaignCharacter");
    if (isStory) {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route(`**/story/${fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${origin}/story/${fixture.campaignId}`);
      await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
      await page.getByRole("button", { name: "Setup", exact: true }).press("Enter");
    } else {
      await page.goto(`${origin}/nexus/index.html#campaigns`);
      await page.locator(`#campaignList [data-campaign-id="${fixture.campaignId}"]`).press("Enter");
      await expect(page.locator("#campaignTitle")).toHaveValue("Fixture Campaign 1");
    }
    await opener.press("Enter");
    const dialog = page.locator(isStory ? "#editCharacterProfileDialog" : "#characterDialog");
    const name = dialog.getByRole("textbox", { name: /^(character )?name$/i });
    const role = dialog.getByRole("textbox", { name: "Role", exact: true });
    const save = dialog.getByRole("button", { name: /^Save (character|campaign)/i });
    await expect(name).toBeFocused();
    const essentials = dialog.getByRole("group", { name: "Story essentials" });
    await expect(essentials.getByRole("textbox")).toHaveCount(3);
    await expect(essentials.getByRole("textbox").nth(1)).toHaveAccessibleName("Background");
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await capture(page, info, `${surface}-editor-${width}`);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await tabTo(page, save);
    await page.keyboard.press("Enter");
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("aria-describedby", /\S/);
    const validation = dialog.getByText("Enter a character name.", { exact: true });
    await expect(validation).toBeInViewport();
    await capture(page, info, `${surface}-validation-${width}`);
    await page.keyboard.type("The Observer");
    await tabTo(page, role);
    await page.keyboard.press("Control+a");
    await page.keyboard.type("Archivist");
    await tabTo(page, save);
    await page.keyboard.press("Enter");
    const compare = dialog.getByRole("button", { name: "Compare latest", exact: true });
    await expect(compare).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(role).toHaveValue("Archivist");
    await tabTo(page, compare);
    await page.keyboard.press("Enter");
    await expect(dialog).toContainText("Concurrent rename");
    const reapply = dialog.getByRole("button", { name: "Reapply my changes", exact: true });
    await tabTo(page, reapply);
    await capture(page, info, `${surface}-conflict-${width}`);
    await page.keyboard.press("Enter");
    await expect(save).toBeEnabled();
    await expect(name).toHaveValue("Concurrent rename");
    await expect(role).toHaveValue("Archivist");
    await tabTo(page, save);
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(isStory ? page.getByRole("button", { name: "Setup", exact: true }) : opener).toBeFocused();
    expect(attempts).toBe(2);
  });
}
