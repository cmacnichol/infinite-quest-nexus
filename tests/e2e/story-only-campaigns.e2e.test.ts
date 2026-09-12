import { expect, test, type Page } from "@playwright/test";

const campaignId = process.env.IQ_UI_TEST_CAMPAIGN_ID!;
const emptyStoryCampaignId = process.env.IQ_UI_TEST_EMPTY_STORY_CAMPAIGN_ID!;
const emptyStoryCampaignMobileId = process.env.IQ_UI_TEST_EMPTY_STORY_MOBILE_CAMPAIGN_ID!;
const actionOnlyCampaignId = process.env.IQ_UI_TEST_ACTION_ONLY_CAMPAIGN_ID!;
const screenshots = "docs/review/story-only-campaigns/screenshots/legacy";

async function apiJson<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (requestPath) => {
    const response = await fetch(requestPath);
    if (!response.ok) throw new Error(`${requestPath} returned ${response.status}`);
    return response.json();
  }, path) as Promise<T>;
}

type TurnList = { turns: Array<{ id?: string; inputMode?: string; action?: string; customActionSuggestion?: string }> };

async function turns(page: Page): Promise<TurnList> {
  return apiJson<TurnList>(page, `/api/v1/campaigns/${campaignId}/turns`);
}

async function turnCount(page: Page): Promise<number> {
  const payload = await turns(page);
  return payload.turns.length;
}

async function waitForTurnIncrement(page: Page, before: number): Promise<void> {
  await expect.poll(() => turnCount(page), { timeout: 30_000 }).toBe(before + 1);
  await expect(page.locator("#generationProgress")).toHaveClass(/hidden/, { timeout: 30_000 });
  const accepted = await turns(page);
  expect(accepted.turns.at(-1)?.inputMode).toBe("scene");
}

async function openNexusCampaign(page: Page): Promise<void> {
  await page.goto("/nexus/#campaigns");
  const campaign = page.locator(`#campaignList .campaign-button[data-campaign-id="${campaignId}"]`);
  await expect(campaign).toBeVisible();
  await campaign.click();
  await page.locator("#campaignTabStory").click();
}

test.describe.configure({ mode: "serial" });

test("legacy Nexus persists Story Direction and its profile without Auto", async ({ page }, testInfo) => {
  const classifierRequests: string[] = [];
  page.on("request", (request) => {
    if (/intent|classif/i.test(request.url())) classifierRequests.push(request.url());
  });

  await openNexusCampaign(page);
  await expect(page.locator("#campaignTurnControlStyle option")).toHaveCount(2);
  await expect(page.locator("#campaignTurnControlStyle")).toHaveValue(/flexible_(action|scene)/);
  await page.locator("#campaignTurnControlStyle").selectOption("flexible_scene");
  await page.locator("#saveCampaign").click();
  await expect(page.locator("#campaignStatusMessage")).toContainText(/saved/i);
  await openNexusCampaign(page);
  await expect(page.locator("#campaignTurnControlStyle")).toHaveValue("flexible_scene");

  await page.locator("#openNexusUserProfile").click();
  await expect(page.locator("#nexusUserProfileDialog")).toHaveAttribute("open", "");
  await expect(page.locator("#nexusUserProfileDefaultTurnControlStyle option")).toHaveCount(2);
  await page.locator("#nexusUserProfileDefaultTurnControlStyle").selectOption("flexible_scene");
  await page.locator("#nexusUserProfileForm button[type=submit]").click();
  await expect(page.locator("#nexusUserProfileDialog")).not.toHaveAttribute("open", "");
  await page.locator("#openNexusUserProfile").click();
  await expect(page.locator("#nexusUserProfileDefaultTurnControlStyle")).toHaveValue("flexible_scene");
  await page.screenshot({ path: `${screenshots}/management-profile-${testInfo.project.name}.png`, fullPage: true });
  await page.locator("#cancelNexusUserProfile").click();
  if (testInfo.project.name === "mobile") {
    await page.setViewportSize({ width: 320, height: 640 });
    await expect(page.locator("#openNexusUserProfile")).toBeVisible();
    await page.locator("#openNexusUserProfile").click();
    await expect(page.locator("#nexusUserProfileDialog")).toHaveAttribute("open", "");
    const viewport = await page.locator("#nexusUserProfileDialog").evaluate((dialog) => {
      const bounds = dialog.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        left: bounds.left,
        right: bounds.right
      };
    });
    await page.screenshot({ path: `${screenshots}/management-profile-320.png` });
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
    expect(viewport.left).toBeGreaterThanOrEqual(0);
    expect(viewport.right).toBeLessThanOrEqual(viewport.viewportWidth);
    await page.locator("#cancelNexusUserProfile").click();
  }
  expect(classifierRequests).toEqual([]);
});

test("legacy Story Direction accepts typed and choice submissions as scene turns after reload", async ({ page }, testInfo) => {
  const classifierRequests: string[] = [];
  page.on("request", (request) => {
    if (/intent|classif/i.test(request.url())) classifierRequests.push(request.url());
  });
  await page.goto(`/story/${campaignId}`);
  await page.locator("#btnOpenUserProfile").click();
  await page.locator("#userProfileAutoSubmitChoices").check();
  await page.locator("#btnSaveUserProfile").click();
  await page.reload();
  await expect(page.locator("#freeAction")).toBeVisible();
  await expect(page.locator("#turnInputModeField")).toBeHidden();
  await expect(page.locator("#btnTakeAction")).toContainText("Continue story");
  const firstCount = await turnCount(page);
  await page.locator("#freeAction").fill("Continue through the station concourse.");
  await page.locator("#btnTakeAction").click();
  await waitForTurnIncrement(page, firstCount);
  await page.reload();
  await expect(page.locator("#btnTakeAction")).toContainText("Continue story");
  await expect(page.locator("#choiceArea .choice").first()).toBeVisible();
  await expect(page.locator("#freeAction")).toHaveAttribute("placeholder", /Describe the events/);
  const secondCount = await turnCount(page);
  await page.locator("#choiceArea .choice").first().click();
  await waitForTurnIncrement(page, secondCount);
  const accepted = await turns(page);
  expect(accepted.turns.at(-1)?.customActionSuggestion).toBe("Study the station map.");
  await page.screenshot({ path: `${screenshots}/player-story-direction-${testInfo.project.name}.png`, fullPage: true });
  expect(classifierRequests).toEqual([]);
});

test("legacy Story profile exposes separate automatic choice submission preferences", async ({ page }, testInfo) => {
  await page.goto(`/story/${campaignId}`);
  await page.locator("#btnOpenUserProfile").click();
  await expect(page.locator("#userProfileDialog")).toHaveAttribute("open", "");
  await expect(page.locator("#userProfileDefaultTurnControlStyle option")).toHaveCount(2);
  const automaticChoices = page.locator("#userProfileAutoSubmitChoices");
  await expect(automaticChoices).toBeVisible();
  await automaticChoices.uncheck();
  await page.locator("#btnSaveUserProfile").click();
  await expect(page.locator("#userProfileDialog")).not.toHaveAttribute("open", "");
  await page.reload();
  await page.locator("#btnOpenUserProfile").click();
  await expect(automaticChoices).not.toBeChecked();
  await page.locator("#btnCancelUserProfile").click();
  await expect(page.locator("#choiceArea .choice").first()).toBeVisible();
  const before = await turnCount(page);
  await page.locator("#choiceArea .choice").nth(0).click();
  await page.locator("#choiceArea .choice").nth(1).click();
  await expect(page.locator("#freeAction")).toHaveValue(/Follow the lantern\.\nInspect the platform\./);
  await page.locator("#freeAction").press("Enter");
  await waitForTurnIncrement(page, before);
  await page.screenshot({ path: `${screenshots}/player-profile-${testInfo.project.name}.png`, fullPage: true });
});

test("legacy campaign settings restore explicit Action controls after Story Direction", async ({ page }, testInfo) => {
  await openNexusCampaign(page);
  await page.locator("#campaignTurnControlStyle").selectOption("flexible_action");
  await page.locator("#saveCampaign").click();
  await expect(page.locator("#campaignStatusMessage")).toContainText(/saved/i);
  await page.goto(`/story/${campaignId}`);
  await expect(page.locator("#turnInputModeField")).toBeVisible();
  const action = page.locator('[data-turn-input-mode="action"]');
  const scene = page.locator('[data-turn-input-mode="scene"]');
  await expect(action).toBeChecked();
  await scene.check();
  await expect(scene).toBeChecked();
  await page.screenshot({ path: `${screenshots}/player-action-controls-${testInfo.project.name}.png`, fullPage: true });
});

test("legacy player navigates accepted history without treating it as a new generation", async ({ page }) => {
  await page.goto(`/story/${campaignId}`);
  await expect(page.locator("#btnPrev")).toBeEnabled();
  const before = await turnCount(page);
  await page.locator("#btnPrev").click();
  await expect(page.locator("#viewPill")).toContainText(/Viewing turn/);
  await expect(page.locator("#btnNext")).toBeEnabled();
  await expect.poll(() => turnCount(page)).toBe(before);
});

test("empty Story Direction campaign opens with a persisted scene turn", async ({ page }, testInfo) => {
  const emptyCampaignId = testInfo.project.name === "mobile" ? emptyStoryCampaignMobileId : emptyStoryCampaignId;
  await expect.poll(async () => (await page.request.get(`/api/v1/campaigns/${emptyCampaignId}/turns`)).json().then((payload: TurnList) => payload.turns.length)).toBe(0);
  await page.goto(`/story/${emptyCampaignId}`);
  await expect(page.locator("#btnTakeAction")).toContainText("Continue story");
  await expect.poll(async () => {
    const payload = await apiJson<TurnList>(page, `/api/v1/campaigns/${emptyCampaignId}/turns`);
    return payload.turns.length;
  }, { timeout: 30_000 }).toBe(1);
  const payload = await apiJson<TurnList>(page, `/api/v1/campaigns/${emptyCampaignId}/turns`);
  expect(payload.turns[0]?.inputMode).toBe("scene");
});

test("action-only campaign keeps Action locked", async ({ page }) => {
  await page.goto(`/story/${actionOnlyCampaignId}`);
  await expect(page.locator("#turnInputModeField")).toBeVisible();
  await expect(page.locator('[data-turn-input-mode="action"]')).toBeChecked();
  await expect(page.locator('[data-turn-input-mode="scene"]')).toBeDisabled();
});

test("stale Nexus settings save leaves the selected draft intact", async ({ page }) => {
  await openNexusCampaign(page);
  await page.locator("#campaignTurnControlStyle").selectOption("flexible_scene");
  await page.locator("#saveCampaign").click();
  await expect(page.locator("#campaignStatusMessage")).toContainText(/saved/i);

  const draftAction = "flexible_action";
  await page.locator("#campaignTurnControlStyle").selectOption(draftAction);
  await page.locator("#campaignTabOverview").click();
  const draftTitle = `Stale Story Direction ${Date.now()}`;
  await page.locator("#campaignTitle").fill(draftTitle);
  const story = await page.context().newPage();
  const generationDiagnostics: string[] = [];
  story.on("response", async (response) => {
    if (/\/generations/.test(response.url())) generationDiagnostics.push(`${response.status()} ${await response.text()}`);
  });
  try {
    await story.goto(`/story/${campaignId}`);
    await expect(story.locator("#btnTakeAction")).toBeEnabled();
    await expect(story.locator("#turnInputModeField")).toBeHidden();
    const before = await turnCount(story);
    await story.locator("#freeAction").fill("Advance the authoritative campaign state.");
    await story.locator("#btnTakeAction").click();
    try {
      await waitForTurnIncrement(story, before);
    } catch (error) {
      generationDiagnostics.push(await story.locator("body").innerText());
      await story.screenshot({ path: "docs/review/story-only-campaigns/screenshots/legacy/stale-generation-failure.png", fullPage: true });
      throw new Error(`${String(error)}\n${generationDiagnostics.join("\n")}`);
    }
    await page.locator("#saveCampaign").click();
    await expect(page.locator("#campaignStatusMessage")).toHaveClass(/error/);
    await expect(page.locator("#campaignStatusMessage")).toContainText(/409|conflict|changed/i);
    await expect(page.locator("#campaignTurnControlStyle")).toHaveValue(draftAction);
    await expect(page.locator("#campaignTitle")).toHaveValue(draftTitle);
  } finally {
    await story.close();
  }
});

test("retry replaces the latest accepted turn without appending history", async ({ page }) => {
  await openNexusCampaign(page);
  await page.locator("#campaignTurnControlStyle").selectOption("flexible_scene");
  await page.locator("#saveCampaign").click();
  await expect(page.locator("#campaignStatusMessage")).toContainText(/saved/i);
  await page.goto(`/story/${campaignId}`);
  await expect(page.locator("#btnTakeAction")).toContainText("Continue story");
  const beforeTurns = await turns(page);
  const before = beforeTurns.turns.length;
  const replacedId = beforeTurns.turns.at(-1)?.id;
  expect(replacedId).toBeTruthy();
  await page.locator("#btnRetry").click();
  await expect(page.locator("#retryPromptDialog")).toHaveAttribute("open", "");
  await page.locator("#retryPromptEditor").fill("Replace the latest safe station scene with this distinct direction.");
  await page.locator("#btnRetryPromptSubmit").click();
  await expect.poll(async () => (await turns(page)).turns.at(-1)?.id, { timeout: 30_000 }).not.toBe(replacedId);
  expect((await turns(page)).turns.at(-1)?.inputMode).toBe("scene");
  await expect.poll(() => turnCount(page), { timeout: 30_000 }).toBe(before);
  await expect(page.locator("#generationProgress")).toHaveClass(/hidden/, { timeout: 30_000 });
});
