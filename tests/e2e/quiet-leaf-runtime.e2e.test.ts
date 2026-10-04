import { expect, test, type Locator } from "@playwright/test";

function normalizedVisibleText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

async function effectiveNarration(locator: Locator): Promise<string> {
  return normalizedVisibleText((await locator.allInnerTexts()).join("\n"));
}

test("both Story clients render the same current disposable campaign turn", async ({ page, context }, testInfo) => {
  const campaignId = process.env.IQ_UI_TEST_CAMPAIGN_ID?.trim();
  if (!campaignId) throw new Error("A disposable IQ_UI_TEST_CAMPAIGN_ID is required");

  const campaignPath = encodeURIComponent(campaignId);
  await page.goto(`/app/story/${campaignPath}`);
  await expect(page.getByRole("button", { name: "Continue Story", exact: true })).toBeVisible();

  const implementation = await page.locator('main[data-page="story-player"]').getAttribute("data-ui-implementation");
  if (implementation !== "native" && implementation !== "web-awesome") {
    throw new Error(`Unsupported rendered Story component profile: ${String(implementation)}`);
  }

  let replacementTitle: Locator;
  let replacementContext: Locator;
  let replacementNarration: Locator;
  if (implementation === "native") {
    replacementTitle = page.locator(".story-command-campaign");
    // Only the selected leaf has record actions; this excludes continuous-reading history and any live preview.
    const selectedLeaf = page.locator(".story-leaf:has(.story-turn-record-actions)");
    replacementContext = selectedLeaf.locator(".story-turn-coordinate");
    replacementNarration = selectedLeaf.locator(".story-narration");
  } else {
    replacementTitle = page.locator("[data-story-title]");
    replacementContext = page.locator("[data-story-context]");
    // Only the selected leaf has record actions; this excludes continuous-reading history and any live preview.
    replacementNarration = page.locator("[data-narration] .story-leaf:has(.story-turn-record-actions) [data-effective-narration]");
  }

  await expect(replacementTitle).toBeVisible();
  await expect(replacementContext).toHaveText(/^Turn \d+$/u);
  await expect(replacementNarration.first()).toBeVisible();
  const replacementTurn = Number(normalizedVisibleText(await replacementContext.textContent() ?? "").match(/^Turn (\d+)$/u)?.[1]);
  expect(Number.isSafeInteger(replacementTurn)).toBe(true);

  const legacy = await context.newPage();
  try {
    await legacy.goto(`/story/${campaignPath}`);
    const legacyTitle = legacy.locator("#storyTitle");
    const legacyTurn = legacy.locator("#turnPill");
    await expect(legacyTitle).toBeVisible();
    await expect(legacyTurn).toHaveText(`Turn ${replacementTurn}`);
    const legacyTurnNumber = Number((await legacyTurn.innerText()).replace("Turn ", ""));
    expect(legacyTurnNumber).toBe(replacementTurn);
    const legacyScene = legacy.locator(`#scene-${legacyTurnNumber}`);
    await expect(legacyScene).toBeVisible();
    // Legacy scenes carry data-turn-number; accept either ordinary narration or segmented prose, never illustration controls.
    const legacyNarration = legacyScene.locator(".narration:not(.segmented-narration), .narration-segment-copy");
    await expect(legacyNarration.first()).toBeVisible();

    expect(normalizedVisibleText(await legacyTitle.innerText()))
      .toBe(normalizedVisibleText(await replacementTitle.innerText()));
    expect(await effectiveNarration(legacyNarration))
      .toBe(await effectiveNarration(replacementNarration));

    await page.screenshot({ path: testInfo.outputPath(`quiet-leaf-${implementation}-replacement.png`), fullPage: true });
    await legacy.screenshot({ path: testInfo.outputPath(`quiet-leaf-${implementation}-legacy.png`), fullPage: true });
  } finally {
    await legacy.close();
  }
});
