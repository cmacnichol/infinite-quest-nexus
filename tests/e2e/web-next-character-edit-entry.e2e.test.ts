import { expect, test } from "@playwright/test";
import { mockAuthoringSession } from "./helpers/authoring-session.js";

test.beforeEach(mockAuthoringSession);
for (const width of [1280, 390]) test(`existing world character opens Review at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const draft = { schemaVersion: 5, world: { title: "Glass Atlas", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {} };
  const candidate = { id: "hero", name: "Ilyra", characterText: "", campaignUse: "playable", startingCastDefault: true, alwaysInContext: false, rpgStats: [], defaultTriggers: [], source: {} };
  await page.addInitScript((session) => sessionStorage.setItem("iqn:character-workspace:session:local", JSON.stringify(session)), { version: 1, key: "local", origin: "world-editor", mode: "edit", workflowId: "workflow-1", parentRoute: "/app/worlds/world-1?tab=characters", expectedWorldRevision: 4, parentDraft: draft, worldContext: draft, rosterSummaries: [], candidate, expiresAt: Date.now() + 60_000 });
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/characters/local`);
  await expect(page.locator("[data-character-review]")).toBeVisible();
  await expect(page.locator("[data-character-review]")).toContainText("story");
  await expect(page.locator("[data-character-stage]:disabled")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`review-${width}.png`), fullPage: true });
  await page.locator('[data-action="accept-character"]').click();
  await expect(page.locator('[name="candidate.profile.story.role"]')).toBeFocused();
  await page.locator('[data-character-stage="method"]').click();
  await expect(page.getByRole("heading", { name: "Regenerate with AI" })).toBeVisible();
  await expect(page.getByText("Describe changes and generate a replacement draft for review, or return to Review.")).toBeVisible();
  expect(errors).toEqual([]);
});
