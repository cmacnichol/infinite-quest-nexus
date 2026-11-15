import { expect, test } from "@playwright/test";
import { mockAuthoringSession } from "./helpers/authoring-session.js";

test.beforeEach(mockAuthoringSession);
for (const width of [1280, 390]) test(`refine unsaved character at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const draft = { schemaVersion: 5, world: { title: "Glass Atlas", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {} };
  const candidate = { id: "hero", name: "Ilyra", characterText: "", campaignUse: "playable", startingCastDefault: true, alwaysInContext: false, rpgStats: [], defaultTriggers: [], source: {} };
  await page.addInitScript(session => sessionStorage.setItem("iqn:character-workspace:session:local", JSON.stringify(session)), { version: 1, key: "local", origin: "world-editor", mode: "edit", workflowId: "workflow-1", parentRoute: "/app/worlds/world-1?tab=characters", expectedWorldRevision: 4, parentDraft: draft, worldContext: draft, rosterSummaries: [], candidate, expiresAt: Date.now() + 60_000 });
  let sent: any;
  await page.route("**/api/v1/worlds/playable-characters/generate-preview", route => { sent = route.request().postDataJSON(); const generated = structuredClone(sent.content.playableCharacters.find((item: any) => item.id === "hero")); generated.profile.story.role = "Sailor"; return route.fulfill({ json: { character: generated } }); });
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/characters/local`);
  await expect(page.locator('[data-page="character-workspace"]')).toBeVisible();
  await page.locator('[data-character-stage="story"]').click(); await page.locator('[name="candidate.profile.story.role"]').fill("Unsaved navigator");
  await page.getByRole("button", { name: "Refine with AI" }).click(); await page.getByLabel("What should change in Story?").fill("Make brave");
  await page.getByRole("button", { name: "Generate", exact: true }).click(); await expect(page.getByText("Proposed: Sailor")).toBeVisible();
  expect(sent.characterId).toBe("hero"); expect(sent.content.playableCharacters[0].profile.story.role).toBe("Unsaved navigator"); expect(sent.prompt).toContain("Make brave");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`refine-${width}.png`), fullPage: true });
  await page.getByRole("button", { name: "Apply", exact: true }).click(); await expect(page.locator('[name="candidate.profile.story.role"]')).toHaveValue("Sailor"); expect(errors).toEqual([]);
});
