import { expect, test } from "@playwright/test";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";

test("World character warns on another character's alias without blocking application", async ({ page }) => {
  await page.route("**/api/v1/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/session") return route.fulfill({ json: quietLeafApiPayloads().session });
    if (path === "/api/v1/worlds") return route.fulfill({ json: { worlds: [] } });
    if (path === "/api/v1/campaigns") return route.fulfill({ json: { campaigns: [] } });
    if (path === "/api/v1/providers") return route.fulfill({ json: { providers: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? 43173}/nexus/index.html#world-library`);
  await page.locator("#newWorld").click();
  await page.locator("#worldTitle").fill("Duplicate fixture");
  await page.locator('[data-world-author-step="character"]').click();
  await page.locator("#addPlayableCharacter").click();
  const dialog = page.locator("#characterDialog");
  await dialog.locator("#characterName").fill("Mara");
  await dialog.locator("#characterRole").fill("Guide");
  await dialog.locator("#characterIdentityDetails summary").click();
  await dialog.locator("#characterAliases").fill("The Watcher");
  await dialog.locator("#saveCharacter").click();
  await expect(dialog).toBeHidden();
  await page.locator("#addPlayableCharacter").click();
  await dialog.locator("#characterName").fill("the watcher");
  await dialog.locator("#characterRole").fill("Scout");
  await expect(dialog).toContainText("Another character uses this name or alias");
  await expect(dialog.locator("#saveCharacter")).toBeEnabled();
  await dialog.locator("#saveCharacter").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#worldAuthorDialog")).toContainText("the watcher");
});
