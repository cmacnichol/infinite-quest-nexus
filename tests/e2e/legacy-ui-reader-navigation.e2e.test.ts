import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const evidence = ".superpowers/sdd/legacy-ui-2026-10-03/evidence/T09";
const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;

async function openReader(page: Page, autoSubmitTurnChoices: boolean) {
  const fixture = legacyUiFixture({ turnCount: 6, worldCount: 1, campaignCount: 1 });
  const user = fixture.session.user as { settings: Record<string, unknown> };
  user.settings.autoSubmitTurnChoices = autoSubmitTurnChoices;
  const api = await installLegacyUiFixture(page, fixture);
  await loadStoryDocument(page, fixture.campaignId);
  await expect(page.locator("#storySyncStatus")).toContainText(/Story synced/u);
  await expect(page.locator("[data-story-reader-toolbar]")).toBeVisible({ timeout: 4000 });
  return { api, fixture };
}

async function loadStoryDocument(page: Page, campaignId: string) {
  const html = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`${origin}/story/${campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}/story/${campaignId}`);
}

test("previous_next_do_not_submit", async ({ page }) => {
  const { api } = await openReader(page, false);
  const toolbar = page.locator("[data-story-reader-toolbar]");

  await toolbar.getByRole("button", { name: "Previous turn" }).click();
  await expect(toolbar.locator("[data-reader-turn-count]")).toHaveText("Turn 5 of 6");
  await toolbar.getByRole("button", { name: "Next turn" }).click();
  await expect(toolbar.locator("[data-reader-turn-count]")).toHaveText("Turn 6 of 6");
  await toolbar.getByRole("button", { name: "History" }).click();
  await expect(page.locator("#turnHistoryDialog")).toHaveAttribute("open", "");
  await page.locator("#btnTurnHistoryDone").click();

  expect(api.writes.filter(write => write.method === "POST")).toEqual([]);
});

test("boundary_buttons_are_disabled", async ({ page }) => {
  await openReader(page, false);
  const toolbar = page.locator("[data-story-reader-toolbar]");

  await expect(toolbar.getByRole("button", { name: "Next turn" })).toBeDisabled();
  await expect(toolbar.getByRole("button", { name: "Next turn" })).toHaveAttribute("title", "You are already at the latest turn.");
  await toolbar.getByRole("button", { name: "Previous turn" }).click();
  await toolbar.getByRole("button", { name: "Previous turn" }).click();
  await toolbar.getByRole("button", { name: "Previous turn" }).click();
  await toolbar.getByRole("button", { name: "Previous turn" }).click();
  await toolbar.getByRole("button", { name: "Previous turn" }).click();
  await expect(toolbar.locator("[data-reader-turn-count]")).toHaveText("Turn 1 of 6");
  await expect(toolbar.getByRole("button", { name: "Previous turn" })).toBeDisabled();
});

test("jump_latest_preserves_draft", async ({ page }) => {
  const { api } = await openReader(page, false);
  const toolbar = page.locator("[data-story-reader-toolbar]");
  const action = page.locator("#freeAction");
  await action.fill("Keep this reading draft.");
  await toolbar.getByRole("button", { name: "Previous turn" }).click();
  await toolbar.getByRole("button", { name: "Jump to latest" }).click();

  await expect(toolbar.locator("[data-reader-turn-count]")).toHaveText("Turn 6 of 6");
  await expect(action).toHaveValue("Keep this reading draft.");
  expect(api.writes.filter(write => write.method === "POST")).toEqual([]);
});

test("more_retains_replacement_guards", async ({ page }) => {
  const { api } = await openReader(page, false);
  const more = page.locator("[data-story-more]");
  const toggle = more.locator("summary");

  await expect(more.locator("#btnUndo")).toBeHidden();
  await toggle.click();
  await expect(more.locator("#btnUndo")).toBeEnabled();
  await expect(more.locator("#btnRetry")).toBeEnabled();
  const confirmations: string[] = [];
  page.on("dialog", async dialog => {
    confirmations.push(dialog.message());
    await dialog.dismiss();
  });
  await more.locator("#btnUndo").click();
  await expect.poll(() => confirmations.length).toBe(1);
  expect(confirmations[0]).toMatch(/Undo the last turn/u);
  await more.locator("#btnRetry").click();
  await expect(page.locator("#retryPromptDialog")).toHaveAttribute("open", "");
  await page.locator("#btnRetryPromptCancel").click();
  expect(api.writes.filter(write => write.method === "POST")).toEqual([]);
  await page.locator("[data-story-reader-toolbar]").getByRole("button", { name: "Previous turn" }).click();
  await expect(more.locator("#btnUndo")).toBeDisabled();
  await expect(more.locator("#btnRetry")).toBeDisabled();
});

test("choice_mode_label_matches_preference", async ({ page }) => {
  const { api, fixture } = await openReader(page, true);
  const choice = page.locator("#choiceArea .choice").first();
  await expect(choice).toHaveAccessibleName(/Choose and continue/u);
  await choice.click();
  await expect.poll(() => api.writes.filter(write => write.method === "POST").length).toBe(1);
  const choiceSubmission = api.writes.find(write => write.method === "POST");
  expect(choiceSubmission?.path).toMatch(/\/generations$/u);
  expect(choiceSubmission?.body).toMatchObject({ action: "Inspect the ticket window" });

  (fixture.session.user as { settings: Record<string, unknown> }).settings.autoSubmitTurnChoices = false;
  await loadStoryDocument(page, fixture.campaignId);
  await expect(page.locator("#choiceArea .choice").first()).toHaveAccessibleName(/Add to draft/u);
  const action = page.locator("#freeAction");
  await action.fill("My added detail.");
  await page.locator("#choiceArea .choice").first().click();
  await expect(action).toHaveValue(/My added detail\.[\s\S]*Inspect the ticket window/u);
  await expect.poll(() => api.writes.filter(write => write.method === "POST").length).toBe(1);
});

test("keyboard_focus_not_obscured_at_desktop_and_200_percent_zoom", async ({ page }) => {
  // A 640x400 CSS viewport is the effective layout area of a 1280x800 desktop at 200% browser zoom.
  await page.setViewportSize({ width: 640, height: 400 });
  await openReader(page, false);
  const toolbar = page.locator("[data-story-reader-toolbar]");
  await toolbar.getByRole("button", { name: "Previous turn" }).click();
  await toolbar.getByRole("button", { name: "Previous turn" }).focus();
  await page.keyboard.press("Tab");
  const geometry = await toolbar.evaluate((element) => {
    const toolbarBounds = element.getBoundingClientRect();
    const focusedBounds = document.activeElement?.getBoundingClientRect();
    return {
      toolbarTop: toolbarBounds.top,
      toolbarBottom: toolbarBounds.bottom,
      focusTop: focusedBounds?.top ?? -1,
      focusBottom: focusedBounds?.bottom ?? -1,
      viewportHeight: window.innerHeight,
      focused: document.activeElement?.getAttribute("aria-label"),
      visible: Boolean(document.activeElement?.getBoundingClientRect().width)
    };
  });
  expect(geometry.focused).toBe("Next turn");
  expect(geometry.visible).toBe(true);
  expect(geometry.focusTop).toBeGreaterThanOrEqual(geometry.toolbarTop);
  expect(geometry.focusBottom).toBeLessThanOrEqual(geometry.toolbarBottom);
  expect(geometry.focusBottom).toBeLessThanOrEqual(geometry.viewportHeight);
  for (const name of ["Previous turn", "Next turn", "History", "Jump to latest"]) {
    await expect(toolbar.getByRole("button", { name })).toBeVisible();
  }
  await page.screenshot({ path: `${evidence}/reader-200-percent-640x400.png`, fullPage: false });
});

test("long_scene_reader_toolbar_stays_available_without_scrolling_to_composer", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { fixture } = await openReader(page, false);
  const finalTurn = fixture.turns.at(-1)!;
  finalTurn.narration = Array.from({ length: 36 }, (_, index) => `Paragraph ${index + 1}: ${"The station clock moved while the rain softened against the roof. ".repeat(5)}`).join("\n\n");
  await loadStoryDocument(page, fixture.campaignId);
  await expect(page.locator("#scene-6 .narration")).toBeVisible();
  const previousAction = page.locator("#scene-6 .previous-action-disclosure");
  await expect(previousAction.locator("summary")).toHaveText("Previous action · Turn 6");
  await expect(previousAction.locator(".action-tag")).toBeHidden();
  await previousAction.locator("summary").click();
  await expect(previousAction.locator(".action-tag")).toBeVisible();
  const toolbar = page.locator("[data-story-reader-toolbar]");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await expect(toolbar).toBeInViewport();
  const toolbarBounds = await toolbar.boundingBox();
  const headerBounds = await page.locator(".universal-nav").boundingBox();
  expect(toolbarBounds?.y).toBeGreaterThanOrEqual((headerBounds?.height ?? 0) - 1);
  await page.screenshot({ path: `${evidence}/long-scene-reader-1280x800.png`, fullPage: false });
});
