import { expect, test } from "@playwright/test";
import { installStoryApi } from "../fixtures/quiet-leaf-api.js";

async function pageOverflow(page: import("@playwright/test").Page): Promise<Readonly<{
  readonly viewport: number;
  readonly pixels: number;
  readonly offenders: readonly Readonly<Record<string, string | number>>[];
}>> {
  return page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll<HTMLElement>("*")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const computed = getComputedStyle(element);
        return {
          tag: element.tagName.toLowerCase(),
          className: element.className || "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          minWidth: computed.minWidth,
          gridTemplateColumns: computed.gridTemplateColumns
        };
      })
      .filter((element) => element.right > viewport + 1 || element.left < -1)
      .sort((left, right) => Math.max(right.right - viewport, -right.left) - Math.max(left.right - viewport, -left.left))
      .slice(0, 12);
    return { viewport, pixels: document.documentElement.scrollWidth - viewport, offenders };
  });
}

test("Core preferences save the display name through the explicit profile route", async ({ page }) => {
  const api = await installStoryApi(page, { expectedProfileUpdates: 1 });
  try {
    await page.goto(`/app/story/${api.campaignId}`);
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await page.getByRole("menuitem", { name: "Preferences", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Preferences", exact: true });
    await expect(dialog).toBeVisible();
    const displayName = dialog.getByRole("textbox", { name: "Display name", exact: true });
    await expect(displayName).toHaveValue("Fixture Reader");
    await displayName.fill("Fixture Reader Updated");
    await expect(dialog.getByRole("status")).toHaveText("Profile saved.");
  } finally {
    api.assertNoUnexpectedRequests();
  }
});

test("Story width stays local and avoids horizontal overflow across the representative viewport matrix", async ({ page }) => {
  const api = await installStoryApi(page);
  try {
    await page.goto(`/app/story/${api.campaignId}`);
    const openPreferences = async () => {
      await page.getByRole("button", { name: "Profile", exact: true }).click();
      await page.getByRole("menuitem", { name: "Preferences", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Preferences", exact: true });
      return {
        dialog,
        width: dialog.getByRole("combobox", { name: "Story width", exact: true }),
        widthControl: dialog.locator('wa-select[data-preference="story-width"]')
      };
    };
    let { dialog, width, widthControl } = await openPreferences();
    const matrix = [
      { viewport: 390, preference: "comfortable", option: "Comfortable" },
      { viewport: 768, preference: "auto", option: "Automatic" },
      { viewport: 1440, preference: "wide", option: "Wide" },
      { viewport: 2560, preference: "full", option: "Full width" },
      { viewport: 3440, preference: "auto", option: "Automatic" }
    ] as const;
    for (const [index, entry] of matrix.entries()) {
      await page.setViewportSize({ width: entry.viewport, height: 900 });
      await width.click();
      await page.getByRole("option", { name: entry.option, exact: true }).click();
      await expect(widthControl).toHaveJSProperty("value", entry.preference);
      await expect.poll(() => page.evaluate(() => {
        const stored = localStorage.getItem("infinite-quest.display-preferences.v1");
        return stored === null ? null : JSON.parse(stored).storyWidth;
      })).toBe(entry.preference);
      await dialog.getByRole("button", { name: "Close Preferences", exact: true }).click();
      const overflow = await pageOverflow(page);
      expect(overflow.pixels, `DOM overflow at matrix ${entry.viewport}px: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(1);
      if (index < matrix.length - 1) ({ dialog, width, widthControl } = await openPreferences());
    }
    await page.setViewportSize({ width: 2560, height: 1080 });
    ({ dialog, width, widthControl } = await openPreferences());
    await width.click();
    await page.getByRole("option", { name: "Comfortable", exact: true }).click();
    await dialog.getByRole("button", { name: "Close Preferences", exact: true }).click();
    const measure = () => page.evaluate(() => {
      const leaf = document.querySelector<HTMLElement>("[data-reading-leaf]");
      const narration = document.querySelector<HTMLElement>("[data-narration] .story-narration");
      if (!leaf || !narration) throw new Error("Quiet Leaf measurement targets are missing.");
      return {
        leafWidth: leaf.getBoundingClientRect().width,
        narrationWidth: narration.getBoundingClientRect().width,
        proseWidth: narration.parentElement?.getBoundingClientRect().width ?? 0
      };
    });
    const comfortable = await measure();

    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await page.getByRole("menuitem", { name: "Preferences", exact: true }).click();
    const fullDialog = page.getByRole("dialog", { name: "Preferences", exact: true });
    const fullWidth = fullDialog.getByRole("combobox", { name: "Story width", exact: true });
    await fullWidth.click();
    await page.getByRole("option", { name: "Full width", exact: true }).click();
    await fullDialog.getByRole("button", { name: "Close Preferences", exact: true }).click();
    const full = await measure();
    expect(full.leafWidth).toBeGreaterThan(comfortable.leafWidth + 300);
    expect(full.narrationWidth).toBeGreaterThan(comfortable.narrationWidth + 300);
    expect(full.narrationWidth).toBeGreaterThan(full.proseWidth * 0.9);
    const overflow = await pageOverflow(page);
    expect(overflow.pixels, `DOM overflow at 2560px: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(1);
  } finally {
    api.assertNoUnexpectedRequests();
  }
});

test("a returning reader sees the schema-fixture library illustration without a profile mutation", async ({ page }) => {
  const api = await installStoryApi(page, { illustration: "enabled", returningUser: true });
  try {
    await page.goto(`/app/story/${api.campaignId}`);
    const artwork = page.getByRole("img", { name: /Illustration of the platform is quiet/i });
    await expect(artwork).toBeVisible();
    await expect(artwork).toHaveAttribute("src", /\/ui-test\/quiet-leaf-door\.png$/);
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await page.getByText("Preferences", { exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveValue("Returning Fixture Reader");
  } finally {
    api.assertNoUnexpectedRequests();
  }
});
