import { expect, test } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPT_TEMPLATE_CATALOG } from "../../packages/contracts/src/prompt-library.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;

test("Prompt Library confirms campaign resets and accepts longer writer instructions", async ({ page }) => {
  const writes: unknown[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const template = { ...PROMPT_TEMPLATE_CATALOG.story_system, effectiveSource: "application", effectiveContent: "Saved application instructions." };
  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown = {};
    if (path === "/api/v1/session") body = { user: { id: "66666666-6666-4666-8666-666666666666", displayName: "Fixture", settings: {} }, authentication: "deferred" };
    if (path === "/api/v1/worlds") body = { worlds: [] };
    if (path === "/api/v1/campaigns") body = { campaigns: [] };
    if (path === "/api/v1/providers") body = { providers: [] };
    if (path === "/api/v1/prompt-library") body = { templates: [template] };
    if (path === "/api/v1/prompt-library/overrides") {
      writes.push(request.postDataJSON());
      body = { library: { templates: [template] } };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`${origin}/nexus/index.html#prompt-library`);
  await expect(page.getByRole("heading", { name: "Story writer", exact: true })).toBeVisible();
  const content = page.locator("#promptLibraryContent");
  await expect(content).toHaveAttribute("maxlength", "64000");
  await content.fill("a".repeat(64_000));
  await page.getByRole("button", { name: "Save prompt", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ content: "a".repeat(64_000) });
  const reset = page.getByRole("button", { name: "Reset all campaigns to application default", exact: true });
  page.once("dialog", async dialog => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("overwrite all campaign overrides");
    expect(dialog.message()).toContain("Story writer");
    await dialog.dismiss();
  });
  await reset.click();
  expect(writes).toHaveLength(1);
  page.once("dialog", dialog => dialog.accept());
  await reset.click();
  await expect(page.locator("#promptLibraryStatus")).toContainText("All your campaigns now inherit");
  expect(writes[1]).toEqual({ key: "story_system", scope: "application", allCampaigns: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator("#promptLibraryEditor").screenshot({ path: join(tmpdir(), `prompt-library-reset-${width}.png`) });
  }
  await content.fill("Unsaved application edits");
  await reset.click();
  await expect(page.locator("#promptLibraryStatus")).toContainText("Save or discard");
  expect(writes).toHaveLength(2);
  await page.locator("#promptLibraryDiscard").click();
  expect(errors).toEqual([]);
});
