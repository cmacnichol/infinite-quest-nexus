import { expect, test, type Page } from "@playwright/test";

const campaignId = process.env.IQ_UI_TEST_CAMPAIGN_ID!;
const emptyNewUiStoryCampaignId = process.env.IQ_UI_TEST_EMPTY_NEW_UI_STORY_CAMPAIGN_ID!;
const emptyNewUiStoryCampaignMobileId = process.env.IQ_UI_TEST_EMPTY_NEW_UI_STORY_MOBILE_CAMPAIGN_ID!;
const actionOnlyCampaignId = process.env.IQ_UI_TEST_ACTION_ONLY_CAMPAIGN_ID!;
const screenshots = "docs/review/story-only-campaigns/screenshots/new-ui";

function screenshotPath(name: string, renderer: string, project: string): string {
  return `${screenshots}/${name}-${renderer}-${project}.png`;
}

type TurnList = { turns: Array<{ id?: string; inputMode?: string; customActionSuggestion?: string }> };

async function apiJson<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (requestPath) => {
    const response = await fetch(requestPath);
    if (!response.ok) throw new Error(`${requestPath} returned ${response.status}`);
    return response.json();
  }, path) as Promise<T>;
}

async function turns(page: Page, id = campaignId): Promise<TurnList> {
  return apiJson<TurnList>(page, `/api/v1/campaigns/${id}/turns`);
}

async function turnCount(page: Page, id = campaignId): Promise<number> {
  return (await turns(page, id)).turns.length;
}

async function activeTurnNumber(page: Page, id = campaignId): Promise<number> {
  const sync = await apiJson<{ campaign: { activeTurnNumber: number } }>(page, `/api/v1/campaigns/${id}/sync-status`);
  return sync.campaign.activeTurnNumber;
}

async function storyDraft(page: Page) {
  const implementation = await page.locator(".app-shell").getAttribute("data-ui-implementation");
  return implementation === "web-awesome"
    ? page.getByRole("textbox", { name: "Custom Action", exact: true })
    : page.locator("[data-story-draft]");
}

async function continueStoryButton(page: Page) {
  const implementation = await page.locator(".app-shell").getAttribute("data-ui-implementation");
  return implementation === "web-awesome"
    ? page.getByRole("button", { name: "Continue Story", exact: true })
    : page.locator("[data-action='continue-story']");
}

async function expectReadableWebAwesomeTurnLengthControls(page: Page): Promise<void> {
  if (await page.locator(".app-shell").getAttribute("data-ui-implementation") !== "web-awesome") return;
  const select = page.locator("[data-turn-length-select]");
  const details = page.locator("[data-turn-length-details]");
  await expect(select).toBeVisible();
  await expect(details).toBeVisible();
  const bounds = await page.evaluate(() => {
    const select = document.querySelector<HTMLElement>("[data-turn-length-select]");
    const details = document.querySelector<HTMLElement>("[data-turn-length-details]");
    if (!select || !details) throw new Error("Turn length controls are missing.");
    const selectBox = select.getBoundingClientRect();
    const detailsBox = details.getBoundingClientRect();
    const serialize = (box: DOMRect) => ({ left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height });
    return { selectBox: serialize(selectBox), detailsBox: serialize(detailsBox), viewportWidth: window.innerWidth };
  });
  expect(bounds.selectBox.width).toBeGreaterThanOrEqual(96);
  expect(bounds.detailsBox.width).toBeGreaterThanOrEqual(72);
  expect(bounds.selectBox.height).toBeGreaterThanOrEqual(40);
  expect(bounds.detailsBox.height).toBeGreaterThanOrEqual(40);
  expect(bounds.detailsBox.height).toBeLessThanOrEqual(96);
  expect(bounds.selectBox.left).toBeGreaterThanOrEqual(0);
  expect(bounds.selectBox.right).toBeLessThanOrEqual(bounds.viewportWidth + 1);
  expect(bounds.detailsBox.right).toBeLessThanOrEqual(bounds.viewportWidth + 1);
  const overlaps = bounds.selectBox.left < bounds.detailsBox.right && bounds.selectBox.right > bounds.detailsBox.left
    && bounds.selectBox.top < bounds.detailsBox.bottom && bounds.selectBox.bottom > bounds.detailsBox.top;
  expect(overlaps).toBe(false);
}

async function waitForNextActiveTurn(page: Page, before: number, inputMode: "action" | "scene", id = campaignId): Promise<TurnList> {
  await expect.poll(() => activeTurnNumber(page, id), { timeout: 30_000 }).toBe(before + 1);
  await expect(await continueStoryButton(page)).toBeEnabled({ timeout: 30_000 });
  const accepted = await turns(page, id);
  expect(accepted.turns.at(-1)?.inputMode).toBe(inputMode);
  return accepted;
}

async function waitForNextSceneTurn(page: Page, before: number, id = campaignId): Promise<TurnList> {
  return waitForNextActiveTurn(page, before, "scene", id);
}

async function saveNewTurnControlStyle(page: Page, style: "flexible_action" | "flexible_scene"): Promise<void> {
  await page.goto(`/app/campaigns/${campaignId}/overview`);
  const form = page.locator("#overview-form");
  await expect(form).toBeVisible();
  await form.locator('select[name="turnControlStyle"]').selectOption(style);
  await form.locator('button[type="submit"]').click();
  await expect(page.locator("#campaign-message")).toContainText(/saved/i);
}

async function waitForProfilePatch(page: Page, mutate: () => Promise<void>): Promise<void> {
  const response = page.waitForResponse((candidate) => candidate.url().endsWith("/api/v1/users/me/profile")
    && candidate.request().method() === "PATCH" && candidate.ok());
  await mutate();
  await response;
}

async function setAutomaticChoiceSubmission(page: Page, enabled: boolean): Promise<void> {
  await expect(page.locator("[data-story-composer]")).toBeVisible();
  const implementation = await page.locator(".app-shell").getAttribute("data-ui-implementation");
  if (implementation === "web-awesome") {
    await page.locator("wa-button.command-menu__trigger").filter({ hasText: "Profile" }).click();
    await page.locator("wa-dropdown-item[value='preferences']").click();
    const automaticChoices = page.locator("[data-profile='auto-submit']");
    await expect(automaticChoices).toBeEnabled();
    const current = await automaticChoices.evaluate((element) => (element as HTMLElement & { checked?: boolean }).checked === true);
    let changed = false;
    if (current !== enabled) {
      await waitForProfilePatch(page, () => automaticChoices.click());
      await expect(automaticChoices).toHaveJSProperty("checked", enabled);
      await expect(page.locator("[data-profile-status]")).toContainText(/saved/i);
      changed = true;
    }
    await page.getByRole("button", { name: "Close Preferences" }).click();
    if (changed) {
      await page.reload();
      await expect(page.locator("[data-story-composer]")).toBeVisible();
    }
    return;
  }

  await page.locator(".user-profile-toggle").click();
  const automaticChoices = page.locator("#user-profile-auto-submit");
  await expect(automaticChoices).toBeEnabled();
  let changed = false;
  if ((await automaticChoices.isChecked()) !== enabled) {
    await waitForProfilePatch(page, () => enabled ? automaticChoices.check() : automaticChoices.uncheck());
    changed = true;
  }
  await page.locator("[data-user-profile-close]").click();
  if (changed) {
    await page.reload();
    await expect(page.locator("[data-story-composer]")).toBeVisible();
  }
}

async function selectWebAwesomeProfileTurnStyle(page: Page, value: "flexible_action" | "flexible_scene"): Promise<void> {
  const turnStyle = page.locator("[data-profile='turn-control-style']");
  const label = value === "flexible_action" ? "Action" : "Story Direction";
  expect(await turnStyle.locator("wa-option").evaluateAll((options) => options.map((option) => option.getAttribute("value"))))
    .toEqual(["action_only", "flexible_action", "flexible_scene"]);
  await expect(turnStyle).toBeEnabled();
  const current = await turnStyle.evaluate((element) => (element as HTMLElement & { value?: string }).value);
  if (current === value) return;
  await waitForProfilePatch(page, async () => {
    await turnStyle.click();
    await page.getByRole("option", { name: label, exact: true }).click();
  });
  await expect(turnStyle).toHaveJSProperty("value", value);
}

test.describe.configure({ mode: "serial" });

test("new UI saves Story Direction without Auto", async ({ page }, testInfo) => {
  await page.goto(`/app/campaigns/${campaignId}/overview`);
  const renderer = await page.locator(".app-shell").getAttribute("data-ui-implementation") ?? "native";
  const form = page.locator("#overview-form");
  await expect(form).toBeVisible();
  await expect(form.locator('select[name="turnControlStyle"] option')).toHaveCount(2);
  await expect(form.locator('select[name="turnControlStyle"]')).toHaveValue(/flexible_(action|scene)/);
  await form.locator('select[name="turnControlStyle"]').selectOption("flexible_scene");
  await form.locator('button[type="submit"]').click();
  await expect(page.locator("#campaign-message")).toContainText(/saved/i);
  await expect(form.locator('select[name="turnControlStyle"]')).toHaveValue("flexible_scene");
  await page.screenshot({ path: screenshotPath("management", renderer, testInfo.project.name), fullPage: true });
  await page.reload();
  await expect(form.locator('select[name="turnControlStyle"]')).toHaveValue("flexible_scene");
  await form.locator('select[name="turnControlStyle"]').selectOption("flexible_action");
  await form.locator('button[type="submit"]').click();
  await expect(page.locator("#campaign-message")).toContainText(/saved/i);
  await page.goto(`/app/story/${campaignId}`);
  await expect(page.locator("[data-story-composer]")).toBeVisible();
  const restoredModes = page.locator("[data-story-input-modes] [data-input-mode], [data-story-composer] wa-radio");
  await expect(restoredModes).toHaveCount(2);
  await expect(restoredModes.nth(0)).toContainText("Action");
  await expect(restoredModes.nth(1)).toContainText("Story Direction");
});

test("new action-only campaign keeps Action locked", async ({ page }) => {
  await page.goto(`/app/campaigns/${actionOnlyCampaignId}/overview`);
  const form = page.locator("#overview-form");
  await expect(form).toBeVisible();
  const title = form.locator("input[name='title']");
  await title.fill("Action-only title save");
  await form.locator("button[type='submit']").click();
  await expect(page.locator("#campaign-message")).toContainText(/saved/i);
  await page.reload();
  await expect(form.locator("select[name='turnControlStyle']")).toHaveValue("flexible_action");
  await page.goto(`/app/story/${actionOnlyCampaignId}`);
  await expect(page.locator("[data-story-composer]")).toBeVisible();
  const modes = page.locator("[data-story-input-modes] [data-input-mode], [data-story-composer] wa-radio");
  await expect(modes).toHaveCount(1);
  await expect(modes.first()).toContainText("Action");
  await expect(page.locator("[data-input-mode='scene'], wa-radio[value='scene']")).toHaveCount(0);
});

test("new UI profile persists Story Direction without Auto", async ({ page }, testInfo) => {
  await page.goto(`/app/story/${campaignId}`);
  const implementation = await page.locator(".app-shell").getAttribute("data-ui-implementation");
  if (implementation === "web-awesome") {
    await page.locator("wa-button.command-menu__trigger").filter({ hasText: "Profile" }).click();
    await page.locator("wa-dropdown-item[value='preferences']").click();
    const turnStyle = page.locator("[data-profile='turn-control-style']");
    await expect(turnStyle.locator("wa-option[value='flexible_auto']")).toHaveCount(0);
    await selectWebAwesomeProfileTurnStyle(page, "flexible_action");
    await selectWebAwesomeProfileTurnStyle(page, "flexible_scene");
    await expect(page.locator("[data-profile-status]")).toContainText(/saved/i);
    await page.getByRole("button", { name: "Close Preferences" }).click();
    await page.reload();
    await page.locator("wa-button.command-menu__trigger").filter({ hasText: "Profile" }).click();
    await page.locator("wa-dropdown-item[value='preferences']").click();
    await expect(turnStyle).toHaveJSProperty("value", "flexible_scene");
    await page.screenshot({ path: screenshotPath("profile", implementation, testInfo.project.name), fullPage: true });
    await turnStyle.scrollIntoViewIfNeeded();
    const dialogMetrics = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>("dialog[open]");
      if (!dialog) throw new Error("Preferences dialog is not open.");
      const box = dialog.getBoundingClientRect();
      return { clientHeight: dialog.clientHeight, scrollHeight: dialog.scrollHeight, scrollTop: dialog.scrollTop, top: box.top, bottom: box.bottom, viewportHeight: window.innerHeight };
    });
    console.log(JSON.stringify({ profileDialog: dialogMetrics }));
    await page.screenshot({ path: screenshotPath("profile-visible", implementation, testInfo.project.name), fullPage: false });
    return;
  }

  await page.locator(".user-profile-toggle").click();
  const dialog = page.locator(".user-profile-dialog");
  await expect(dialog).toHaveAttribute("open", "");
  const turnStyle = "#user-profile-turn-style";
  await expect(page.locator(`${turnStyle} option`)).toHaveCount(2);
  await expect(page.locator("[data-user-profile-fields]")).toBeEnabled();
  const nativeTurnStyle = page.locator(turnStyle);
  if (await nativeTurnStyle.inputValue() !== "flexible_action") {
    await waitForProfilePatch(page, async () => { await nativeTurnStyle.selectOption("flexible_action"); });
  }
  await waitForProfilePatch(page, async () => { await nativeTurnStyle.selectOption("flexible_scene"); });
  await page.locator("[data-user-profile-close]").click();
  await page.reload();
  await page.locator(".user-profile-toggle").click();
  await expect(page.locator(turnStyle)).toHaveValue("flexible_scene");
  await page.screenshot({ path: screenshotPath("profile", implementation ?? "native", testInfo.project.name), fullPage: true });
});

test("new Story Direction composer has no classifier controls and submits scene turns", async ({ page }, testInfo) => {
  const classifierRequests: string[] = [];
  page.on("request", (request) => {
    if (/intent|classif/i.test(request.url())) classifierRequests.push(request.url());
  });
  await saveNewTurnControlStyle(page, "flexible_scene");
  await page.goto(`/app/story/${campaignId}`);
  const renderer = await page.locator(".app-shell").getAttribute("data-ui-implementation") ?? "native";
  await expect(page.locator("[data-story-composer]")).toBeVisible();
  await expect(page.locator("[data-story-intent-confirmation]")).toHaveCount(0);
  await expect(page.locator("[data-input-mode='auto']")).toHaveCount(0);
  await expect(page.locator("[data-story-composer] [data-input-mode], [data-story-composer] wa-radio-group")).toHaveCount(0);
  await expectReadableWebAwesomeTurnLengthControls(page);
  const before = await activeTurnNumber(page);
  await (await storyDraft(page)).fill("Continue through the station concourse.");
  await (await continueStoryButton(page)).click();
  await waitForNextSceneTurn(page, before);
  await page.screenshot({ path: screenshotPath("player", renderer, testInfo.project.name), fullPage: true });
  expect(classifierRequests).toEqual([]);
});

test("new Story Direction accepts generated choices as persisted scene turns", async ({ page }) => {
  await saveNewTurnControlStyle(page, "flexible_scene");
  await page.goto(`/app/story/${campaignId}`);
  await setAutomaticChoiceSubmission(page, true);
  const choice = page.locator("[data-story-choice], [data-inline-choice]").first();
  await expect(choice).toBeVisible();
  const before = await activeTurnNumber(page);
  await choice.click();
  const accepted = await waitForNextSceneTurn(page, before);
  expect(accepted.turns.at(-1)?.customActionSuggestion).toBe("Study the station map.");
});

test("new Story Direction keeps automatic choice submission separate from multiselect keyboard submission", async ({ page }) => {
  await saveNewTurnControlStyle(page, "flexible_scene");
  await page.goto(`/app/story/${campaignId}`);
  await setAutomaticChoiceSubmission(page, false);
  const choices = page.locator("[data-story-choice], [data-inline-choice]");
  await expect(choices.nth(1)).toBeVisible();
  await choices.nth(0).click();
  await choices.nth(1).click();
  const draft = await storyDraft(page);
  await expect(draft).toHaveValue(/Follow the lantern\.\nInspect the platform\./);
  const before = await activeTurnNumber(page);
  await (await continueStoryButton(page)).focus();
  await (await continueStoryButton(page)).press("Enter");
  await waitForNextSceneTurn(page, before);
});

test("new flexible controls submit explicit Action then Story Direction without a classifier", async ({ page }) => {
  const classifierRequests: string[] = [];
  page.on("request", (request) => {
    if (/intent|classif/i.test(request.url())) classifierRequests.push(request.url());
  });
  await saveNewTurnControlStyle(page, "flexible_action");
  await page.goto(`/app/story/${campaignId}`);
  await expect(page.locator("[data-story-composer]")).toBeVisible();
  const action = page.locator("[data-input-mode='action'], wa-radio[value='action']");
  const scene = page.locator("[data-input-mode='scene'], wa-radio[value='scene']");
  await expect(action).toHaveCount(1);
  await expect(scene).toHaveCount(1);
  await expect(page.locator("[data-input-mode='auto'], wa-radio[value='auto']")).toHaveCount(0);

  await action.click();
  const actionBefore = await activeTurnNumber(page);
  await (await storyDraft(page)).fill("Use the marked exit before the rain reaches the platform.");
  await (await continueStoryButton(page)).click();
  await waitForNextActiveTurn(page, actionBefore, "action");

  await scene.click();
  const sceneBefore = await activeTurnNumber(page);
  await (await storyDraft(page)).fill("Describe the platform falling quiet after the departure.");
  await (await continueStoryButton(page)).click();
  await waitForNextActiveTurn(page, sceneBefore, "scene");
  expect(classifierRequests).toEqual([]);
});

test("the same campaign saves Story Direction from legacy management and Action from the new editor", async ({ page }) => {
  await page.goto("/nexus/#campaigns");
  const legacyCampaign = page.locator(`#campaignList .campaign-button[data-campaign-id="${campaignId}"]`);
  await expect(legacyCampaign).toBeVisible();
  await legacyCampaign.click();
  await page.locator("#campaignTabStory").click();
  await page.locator("#campaignTurnControlStyle").selectOption("flexible_scene");
  await page.locator("#saveCampaign").click();
  await expect(page.locator("#campaignStatusMessage")).toContainText(/saved/i);

  await page.goto(`/app/story/${campaignId}`);
  await expect(page.locator("[data-story-composer]")).toBeVisible();
  await expect(page.locator("[data-story-composer] [data-input-mode], [data-story-composer] wa-radio-group")).toHaveCount(0);

  await page.goto(`/app/campaigns/${campaignId}/overview`);
  const form = page.locator("#overview-form");
  await expect(form.locator('select[name="turnControlStyle"]')).toHaveValue("flexible_scene");
  await form.locator('select[name="turnControlStyle"]').selectOption("flexible_action");
  await form.locator('button[type="submit"]').click();
  await expect(page.locator("#campaign-message")).toContainText(/saved/i);

  await page.goto(`/story/${campaignId}`);
  await expect(page.locator("#turnInputModeField")).toBeVisible();
  await expect(page.locator('[data-turn-input-mode="action"]')).toBeChecked();
});

test("new editor preserves an unsaved Action style and title after a real concurrent Story Direction turn", async ({ page }) => {
  await saveNewTurnControlStyle(page, "flexible_scene");
  await page.goto(`/app/campaigns/${campaignId}/overview`);
  const form = page.locator("#overview-form");
  const draftTitle = `New UI stale style ${Date.now()}`;
  await form.locator('input[name="title"]').fill(draftTitle);
  await form.locator('select[name="turnControlStyle"]').selectOption("flexible_action");

  const story = await page.context().newPage();
  try {
    await story.goto(`/app/story/${campaignId}`);
    await expect(story.locator("[data-story-composer]")).toBeVisible();
    await expect(story.locator("[data-story-composer] [data-input-mode], [data-story-composer] wa-radio-group")).toHaveCount(0);
    const before = await activeTurnNumber(story);
  await (await storyDraft(story)).fill("Advance the authoritative Story Direction campaign state.");
    await (await continueStoryButton(story)).click();
    await waitForNextSceneTurn(story, before);

    await form.locator('button[type="submit"]').click();
    await expect(page.locator("#campaign-message")).toContainText(/409|conflict|changed/i);
    await expect(form.locator('select[name="turnControlStyle"]')).toHaveValue("flexible_action");
    await expect(form.locator('input[name="title"]')).toHaveValue(draftTitle);
  } finally {
    await story.close();
  }
});

test("new Story player history navigation does not append a turn", async ({ page }) => {
  await saveNewTurnControlStyle(page, "flexible_scene");
  await page.goto(`/app/story/${campaignId}`);
  const beforeAppend = await activeTurnNumber(page);
  await (await storyDraft(page)).fill("Create one more accepted scene before navigating history.");
  await (await continueStoryButton(page)).click();
  await waitForNextSceneTurn(page, beforeAppend);
  const activeTurnBeforeHistory = await activeTurnNumber(page);
  const previous = page.locator("[data-action='previous-turn']").first();
  await expect(previous).toBeEnabled();
  await previous.click();
  await expect(page.locator(".story-command-view, [data-story-context]")).toContainText(/Viewing turn|Turn \d+/);
  await expect.poll(() => activeTurnNumber(page)).toBe(activeTurnBeforeHistory);
});

test("new Story retry replaces the accepted turn ID without appending history", async ({ page }) => {
  await saveNewTurnControlStyle(page, "flexible_scene");
  await page.goto(`/app/story/${campaignId}`);
  const beforeTurns = await turns(page);
  const replacedId = beforeTurns.turns.at(-1)?.id;
  expect(replacedId).toBeTruthy();
  const activeTurnBeforeReplacement = await activeTurnNumber(page);
  const renderer = await page.locator(".app-shell").getAttribute("data-ui-implementation") ?? "native";
  const retry = renderer === "web-awesome"
    ? page.getByRole("button", { name: "Retry Turn", exact: true })
    : page.locator("[data-action='retry-latest-generation']");
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(await storyDraft(page)).toHaveValue(/.+/);
  await (await storyDraft(page)).fill("Replace the latest station scene with a distinct Story Direction.");
  const confirmation = new Promise<{ type: string; message: string }>((resolve) => {
    page.once("dialog", (dialog) => {
      const details = { type: dialog.type(), message: dialog.message() };
      void dialog.accept().then(() => resolve(details));
    });
  });
  await (await continueStoryButton(page)).click();
  await expect.poll(async () => (await confirmation).type).toBe("confirm");
  await expect.poll(async () => (await confirmation).message).toMatch(/^Retry persisted Turn \d+\?$/);
  await expect.poll(async () => (await turns(page)).turns.at(-1)?.id, { timeout: 30_000 }).not.toBe(replacedId);
  await expect.poll(() => activeTurnNumber(page), { timeout: 30_000 }).toBe(activeTurnBeforeReplacement);
  expect((await turns(page)).turns.at(-1)?.inputMode).toBe("scene");
});

test("empty new Story Direction campaign begins a persisted scene for each renderer and viewport", async ({ page }, testInfo) => {
  const emptyCampaignId = testInfo.project.name === "mobile"
    ? emptyNewUiStoryCampaignMobileId
    : emptyNewUiStoryCampaignId;
  await expect.poll(async () => {
    const response = await page.request.get(`/api/v1/campaigns/${emptyCampaignId}/turns`);
    if (!response.ok()) return -1;
    return (await response.json() as TurnList).turns.length;
  }).toBe(0);
  await page.goto(`/app/story/${emptyCampaignId}`);
  const renderer = await page.locator(".app-shell").getAttribute("data-ui-implementation") ?? "native";
  const begin = page.locator("[data-action='begin-story']");
  await expect(begin).toBeVisible();
  await begin.click();
  await expect.poll(() => turnCount(page, emptyCampaignId), { timeout: 30_000 }).toBe(1);
  expect((await turns(page, emptyCampaignId)).turns[0]?.inputMode).toBe("scene");
  await page.screenshot({ path: screenshotPath("empty-opening", renderer, testInfo.project.name), fullPage: true });
});
