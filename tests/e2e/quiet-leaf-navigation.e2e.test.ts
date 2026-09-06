import { expect, test } from "@playwright/test";
import { installStoryApi } from "../fixtures/quiet-leaf-api.js";

const webAwesomeBuild = process.env.VITE_UI_COMPONENTS === "web-awesome";

async function expectLoadedFixtureStory(page: import("@playwright/test").Page) {
  if (webAwesomeBuild) {
    await expect(page.getByRole("heading", { name: "Fixture Story", exact: true })).toBeVisible();
    return;
  }
  const controls = page.getByRole("region", { name: "Story controls", exact: true });
  await expect(controls.getByText("Fixture Story", { exact: true })).toBeVisible();
  await expect(controls.getByText("Active turn 1", { exact: true })).toBeVisible();
}

test("the Story chooser enters the selected sanitized campaign without leaving the replacement route", async ({ page }) => {
  const api = await installStoryApi(page);
  try {
    await page.goto("/app/story");
    const campaign = page.getByRole("link", { name: "Fixture Story", exact: true });
    await expect(campaign).toBeVisible();
    await campaign.click();
    await expect(page).toHaveURL(`/app/story/${api.campaignId}`);
    await expectLoadedFixtureStory(page);
  } finally {
    api.assertNoUnexpectedRequests();
  }
});

test("the app entry resumes only the server-verified remembered Story campaign", async ({ page }) => {
  const api = await installStoryApi(page);
  try {
    await page.addInitScript((campaignId) => {
      localStorage.setItem("infinite-quest.story-resume.v1", JSON.stringify({ version: 1, campaignId }));
    }, api.campaignId);
    await page.goto("/app/");
    await expect(page).toHaveURL(`/app/story/${api.campaignId}`);
    await expectLoadedFixtureStory(page);
  } finally {
    api.assertNoUnexpectedRequests();
  }
});

test("the direct World Library route renders the sanitized contract fixture", async ({ page }) => {
  const api = await installStoryApi(page);
  try {
    await page.goto("/app/worlds");
    await expect(page.getByRole("heading", { name: "World Library", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /Fixture World/i })).toBeVisible();
    await expect(page.getByText("1 campaign", { exact: true })).toBeVisible();
  } finally {
    api.assertNoUnexpectedRequests();
  }
});

test("the native default keeps the draft label and textarea in its native grid flow", async ({ page }) => {
  test.skip(webAwesomeBuild, "Core has its own draft-field geometry coverage.");
  const api = await installStoryApi(page);
  try {
    await page.goto(`/app/story/${api.campaignId}`);
    const field = page.locator(".story-draft-field");
    const textarea = page.locator("textarea[data-story-draft]");
    const label = field.locator("label");
    await expect(textarea).toBeVisible();
    const geometry = await field.evaluate((element) => ({
      areas: getComputedStyle(element).gridTemplateAreas,
      labelBottom: element.querySelector("label")?.getBoundingClientRect().bottom ?? 0,
      textareaTop: element.querySelector("textarea")?.getBoundingClientRect().top ?? 0
    }));
    expect(geometry.areas).toBe("none");
    expect(geometry.labelBottom).toBeLessThanOrEqual(geometry.textareaTop);
    await expect(label).toBeVisible();
  } finally {
    api.assertNoUnexpectedRequests();
  }
});
