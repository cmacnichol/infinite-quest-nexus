import { expect, test, type Route } from "@playwright/test";
import { installStoryApi } from "../fixtures/quiet-leaf-api.js";

type MemoryLevel = "off" | "standard" | "enhanced" | "max";

test.use({ baseURL: process.env.STORY_MEMORY_TEST_BASE_URL ?? "http://127.0.0.1:43174" });

test("campaign editor and Story Campaign Tools save and reload the same memory setting", async ({ page }, testInfo) => {
  const api = await installStoryApi(page);
  let level: MemoryLevel = "enhanced";
  const availableLevels: readonly MemoryLevel[] = ["off", "standard", "enhanced", "max"];
  await page.route(`**/api/v1/campaigns/${api.campaignId}/story-memory`, async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ level, reviewMode: level === "max" ? "enforce" : "off", availableLevels }) });
      return;
    }
    if (route.request().method() === "PUT") {
      const body = JSON.parse(route.request().postData() ?? "{}") as { level?: MemoryLevel };
      if (!body.level || !availableLevels.includes(body.level)) throw new Error("Story memory PUT omitted an available level.");
      level = body.level;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ level, reviewMode: level === "max" ? "enforce" : "off", availableLevels }) });
      return;
    }
    await route.abort("blockedbyclient");
  });
  await page.route("**/api/v1/providers", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ providers: [] }) }));

  await page.goto(`/app/campaigns/${api.campaignId}/overview`);
  const editor = page.locator("#memory-settings-form");
  await expect(editor).toBeVisible();
  await expect(editor.locator("select[name='storyMemoryLevel']")).toHaveValue("enhanced");
  await editor.locator("select[name='storyMemoryLevel']").selectOption("max");
  await editor.getByRole("button", { name: "Save memory level" }).click();
  await expect(page.locator("#campaign-message")).toContainText("Campaign memory level saved.");
  await expect(editor).toContainText("Max reviews continuity, attempts a repair, and blocks unresolved conflicts.");
  await page.screenshot({ path: `${testInfo.outputPath("story-memory-editor-desktop.png")}`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${testInfo.outputPath("story-memory-editor-mobile.png")}`, fullPage: true });

  await page.goto(`/app/story/${api.campaignId}`);
  await expect(page.locator("[data-story-composer]")).toBeVisible();
  const draft = page.locator("[data-story-draft]");
  await draft.fill("Keep this unsent draft.");
  await page.locator("[data-campaign-tools] summary").click();
  await page.getByRole("button", { name: "Campaign Memory", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Campaign Memory", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-story-memory-level]")).toHaveValue("max");
  await expect(dialog).toContainText("Max reviews continuity, attempts a repair, and blocks unresolved conflicts.");
  await page.screenshot({ path: testInfo.outputPath("story-memory-dialog-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath("story-memory-dialog-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.locator("[data-story-memory-level]").selectOption("standard");
  await dialog.getByRole("button", { name: "Save Campaign Memory", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(draft).toHaveValue("Keep this unsent draft.");
  await page.screenshot({ path: `${testInfo.outputPath("story-memory-story-mobile.png")}`, fullPage: true });

  await page.reload();
  await expect(page.locator("[data-story-composer]")).toBeVisible();
  await page.locator("[data-campaign-tools] summary").click();
  await page.getByRole("button", { name: "Campaign Memory", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Campaign Memory", exact: true }).locator("[data-story-memory-level]")).toHaveValue("standard");
});

test("Story keeps the composer draft when campaign memory cannot load", async ({ page }) => {
  const api = await installStoryApi(page);
  await page.route(`**/api/v1/campaigns/${api.campaignId}/story-memory`, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) }));
  await page.goto(`/app/story/${api.campaignId}`);
  const draft = page.locator("[data-story-draft]");
  await draft.fill("Keep this draft when memory is unavailable.");
  await page.locator("[data-campaign-tools] summary").click();
  await page.getByRole("button", { name: "Campaign Memory", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Campaign Memory", exact: true });
  await expect(dialog).toContainText("Campaign memory settings could not be loaded. Your story draft is preserved.");
  await expect(draft).toHaveValue("Keep this draft when memory is unavailable.");
});

test("Story retains the memory selection and draft after a failed save and allows retry", async ({ page }) => {
  const api = await installStoryApi(page);
  let failSave = true;
  await page.route(`**/api/v1/campaigns/${api.campaignId}/story-memory`, async route => {
    if (route.request().method() === "PUT" && failSave) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) });
      return;
    }
    const level = route.request().method() === "PUT" ? "enhanced" : "max";
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ level, reviewMode: level === "max" ? "enforce" : "off", availableLevels: ["off", "standard", "enhanced", "max"] }) });
  });
  await page.goto(`/app/story/${api.campaignId}`);
  const draft = page.locator("[data-story-draft]");
  await draft.fill("Keep this draft through a failed save.");
  await page.locator("[data-campaign-tools] summary").click();
  await page.getByRole("button", { name: "Campaign Memory", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Campaign Memory", exact: true });
  await dialog.locator("[data-story-memory-level]").selectOption("enhanced");
  await dialog.getByRole("button", { name: "Save Campaign Memory", exact: true }).click();
  await expect(dialog).toContainText("Campaign memory could not be saved.");
  await expect(dialog.locator("[data-story-memory-level]")).toHaveValue("enhanced");
  await expect(draft).toHaveValue("Keep this draft through a failed save.");
  failSave = false;
  await dialog.getByRole("button", { name: "Save Campaign Memory", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(draft).toHaveValue("Keep this draft through a failed save.");
});

test("Story ignores a late campaign-memory response after navigation", async ({ page }) => {
  const api = await installStoryApi(page);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let requested!: () => void;
  const requestStarted = new Promise<void>((resolve) => { requested = resolve; });
  await page.route(`**/api/v1/campaigns/${api.campaignId}/story-memory`, async route => {
    requested();
    await delayed;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ level: "max", reviewMode: "enforce", availableLevels: ["off", "standard", "enhanced", "max"] }) });
  });
  await page.route("**/api/v1/providers", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ providers: [] }) }));
  await page.goto(`/app/story/${api.campaignId}`);
  await page.locator("[data-campaign-tools] summary").click();
  await page.getByRole("button", { name: "Campaign Memory", exact: true }).click();
  await requestStarted;
  await page.goto(`/app/campaigns/${api.campaignId}/overview`);
  release();
  await expect(page.locator("#overview-form")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Campaign Memory", exact: true })).toHaveCount(0);
});
