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
  await dialog.getByRole("button", { name: "Show empty fields", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Hide empty fields", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Show empty fields", exact: true })).toBeFocused();
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

test("Web-Next keeps an inline draft and focus during a tracking refresh", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await page.clock.install();
  const api = await fixture(page, false, true);
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`);
  await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click();
  const dialog = page.locator("dialog.characters-workspace"); await dialog.getByRole("button", { name: "Mara", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit Name", exact: true }).click(); const input = dialog.getByRole("textbox", { name: "Name", exact: true }); await input.fill("Draft Mara");
  const refreshed = page.waitForResponse(response => response.url().includes("/cast/workspace-status") && response.request().method() === "GET");
  api.advanceRevision(); await page.clock.fastForward(5_000); expect((await (await refreshed).json()).revision).toBe(1); await expect(input).toHaveValue("Draft Mara"); await expect(input).toBeFocused();
  await page.screenshot({ path: info.outputPath("web-next-preserved-sheet-draft.png") });
  page.once("dialog", async prompt => { expect(prompt.message()).toContain("Discard unsaved character changes?"); await prompt.dismiss(); });
  await dialog.getByRole("button", { name: "Back to characters", exact: true }).click(); await expect(input).toHaveValue("Draft Mara");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
});

test("Web-Next returns to the sheet after switching editors and cancelling", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fixture(page, false, true);
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`);
  await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click();
  const dialog = page.locator("dialog.characters-workspace"); await dialog.getByRole("button", { name: "Mara", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit Name", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Draft Mara");
  page.once("dialog", prompt => prompt.accept());
  await dialog.getByRole("button", { name: "Edit character", exact: true }).click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Edit Name", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Edit Name", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Mara");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("web-next-returned-to-sheet.png") });
});
