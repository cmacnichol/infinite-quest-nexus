import { expect, test } from "@playwright/test";
import { campaignId, fixture } from "./helpers/web-next-sheet-fixture.js";

for (const width of [1280, 390]) test(`Web-Next sheet saves and undoes at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await fixture(page, false, true);
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`);
  await page.locator("[data-campaign-tools] summary").click();
  await page.locator("[data-tool-action='open-characters']").click();
  const dialog = page.locator("dialog.characters-workspace");
  await dialog.getByRole("button", { name: "Mara", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit Name", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Marin");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByText("Saved Name.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`web-next-sheet-${width}.png`) });
  await dialog.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(dialog.getByText("Undone", { exact: true })).toBeVisible();
  await expect(dialog.locator('[data-path="name"]')).toContainText("Mara");
});
