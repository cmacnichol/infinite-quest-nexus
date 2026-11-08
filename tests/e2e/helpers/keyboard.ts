import { expect, type Locator, type Page } from "@playwright/test";

export async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let i = 0; i < 100; i++) {
    if (await target.evaluate(el => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}
