import { expect, test } from "@playwright/test";
import { campaignId, fixture } from "./helpers/web-next-sheet-fixture.js";

for (const width of [1280, 390]) test(`supporting editor registry sections at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await fixture(page, false, true);
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`);
  await page.locator("[data-campaign-tools] summary").click();
  await page.locator("[data-tool-action='open-characters']").click();
  const dialog = page.locator("dialog.characters-workspace");
  await dialog.getByRole("button", { name: "Mara", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit character", exact: true }).click();
  await expect(dialog.locator("[data-cast-group] summary")).toHaveText(["Identity", "History", "Personality and voice", "Current situation", "Appearance"]);
  await expect(dialog.locator("#characters-identity-pronouns")).toHaveAttribute("id", "characters-identity-pronouns");
  await page.screenshot({ path: info.outputPath(`web-next-editor-${width}.png`) });
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await dialog.locator("#characters-story-role").fill("Guide");
  await dialog.getByRole("button", { name: "Save character", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Saved Mara" })).toBeVisible();
  await expect(dialog.getByText("Sources and edit history")).toBeVisible();
});
