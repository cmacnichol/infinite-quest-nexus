import { expect, it, vi } from "vitest";
import { createDisplayPreferences } from "../../apps/web-next/src/preferences/display-preferences.js";
import { mountStoryPlayerPage } from "../../apps/web-next/src/story-player-page.js";
import { createStoryTestDom, createStoryTestComposition, settleStoryTest } from "../fixtures/quiet-leaf-story.js";

it("prepares Retry without immediately appending a turn", async () => {
  const page = createStoryTestDom();
  const composition = createStoryTestComposition({ turnControlStyle: "flexible_action" });
  const mounted = mountStoryPlayerPage(page.root, { campaignId: "11111111-1111-4111-8111-111111111111", turnNumber: null }, composition, { uiImplementation: "web-awesome" });
  await settleStoryTest();

  const retry = page.root.querySelector<HTMLElement>("[data-retry-turn]");
  expect(retry).not.toBeNull();
  if (!retry) return;
  retry.dispatchEvent(new page.window.Event("click", { bubbles: true }));

  expect(vi.mocked(composition.workflow.submit)).not.toHaveBeenCalled();
  expect(page.root.querySelector<HTMLElement & { value: string }>("wa-textarea")?.value).toBe("Proceed.");
  mounted.dispose();
});

it("uses the mounted Core shell for the validated campaign context", async () => {
  const page = createStoryTestDom();
  const composition = createStoryTestComposition({ turnControlStyle: "flexible_action" });
  const mounted = mountStoryPlayerPage(page.root, { campaignId: "11111111-1111-4111-8111-111111111111", turnNumber: null }, composition, { uiImplementation: "web-awesome" });
  await settleStoryTest();

  expect(page.root.dataset.storyCampaignId).toBe("11111111-1111-4111-8111-111111111111");
  expect(page.root.querySelector("[data-campaign-tools]")).toBeNull();
  mounted.dispose();
});

it("keeps idle Core Story free of native command status and width controls", async () => {
  const page = createStoryTestDom();
  const composition = createStoryTestComposition({ turnControlStyle: "flexible_action" });
  const mounted = mountStoryPlayerPage(page.root, { campaignId: "11111111-1111-4111-8111-111111111111", turnNumber: null }, composition, { uiImplementation: "web-awesome" });
  await settleStoryTest();

  const commandRow = page.root.querySelector<HTMLElement>(".story-command-row");
  expect(commandRow?.hidden).toBe(true);
  expect(commandRow?.textContent).not.toContain("Story Engine ready");
  expect(page.root.querySelector("[data-reading-width]")).toBeNull();
  mounted.dispose();
});

it("routes a Core artwork command through display preferences", async () => {
  const page = createStoryTestDom();
  const display = createDisplayPreferences(null);
  const composition = createStoryTestComposition({ turnControlStyle: "flexible_action" });
  const mounted = mountStoryPlayerPage(page.root, { campaignId: "11111111-1111-4111-8111-111111111111", turnNumber: null }, composition, {
    uiImplementation: "web-awesome",
    displayPreferences: display
  });
  await settleStoryTest();

  const menu = page.root.querySelector<HTMLElement>("[data-shell-campaign-menu] wa-dropdown");
  if (!menu) throw new Error("Core campaign settings menu is missing.");
  menu.dispatchEvent(new page.window.CustomEvent("wa-select", { detail: { item: { value: "hide-turn-artwork" } } }));

  expect(display.artworkVisible("11111111-1111-4111-8111-111111111111", "66666666-6666-4666-8666-666666666666")).toBe(false);
  mounted.dispose();
  display.dispose();
});

it("submits a direct Action without a confirmation control", async () => {
  const page = createStoryTestDom();
  const composition = createStoryTestComposition({ turnControlStyle: "flexible_action" });
  const mounted = mountStoryPlayerPage(page.root, { campaignId: "11111111-1111-4111-8111-111111111111", turnNumber: null }, composition, { uiImplementation: "web-awesome" });
  await settleStoryTest();
  const draft = page.root.querySelector<HTMLElement & { value: string }>("wa-textarea");
  const continueStory = page.root.querySelector<HTMLElement>("[data-continue-story]");
  if (!draft || !continueStory) throw new Error("Quiet Leaf composer controls are missing.");
  draft.value = "Preserve this action.";
  draft.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  continueStory.dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await settleStoryTest();
  expect(vi.mocked(composition.workflow.submit)).toHaveBeenCalledWith(
    "11111111-1111-4111-8111-111111111111",
    expect.objectContaining({ request: expect.objectContaining({ action: "Preserve this action.", resolvedInputMode: "action" }) })
  );
  expect(page.root.querySelector("[data-story-intent-confirmation]")).toBeNull();
  mounted.dispose();
});

it("preserves a real typed draft through display preference refreshes", async () => {
  const page = createStoryTestDom();
  const display = createDisplayPreferences(null);
  const composition = createStoryTestComposition({ turnControlStyle: "flexible_action" });
  const mounted = mountStoryPlayerPage(page.root, { campaignId: "11111111-1111-4111-8111-111111111111", turnNumber: null }, composition, {
    uiImplementation: "web-awesome",
    displayPreferences: display
  });
  await settleStoryTest();

  const draft = page.root.querySelector<HTMLElement & { value: string }>("wa-textarea");
  if (!draft) throw new Error("Quiet Leaf draft control is missing.");
  draft.value = "Keep this unsaved action.";
  draft.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  display.setStoryWidth("full");
  display.setTurnArtwork("11111111-1111-4111-8111-111111111111", "66666666-6666-4666-8666-666666666666", false);

  expect(page.root.querySelector("wa-textarea")).toBe(draft);
  expect(draft.value).toBe("Keep this unsaved action.");
  mounted.dispose();
  display.dispose();
});

it("keeps refreshed Quiet Leaf narration and history commands connected to the Story page", async () => {
  const page = createStoryTestDom();
  const display = createDisplayPreferences(null);
  const composition = createStoryTestComposition();
  const mounted = mountStoryPlayerPage(page.root, { campaignId: "11111111-1111-4111-8111-111111111111", turnNumber: null }, composition, {
    uiImplementation: "web-awesome",
    displayPreferences: display
  });
  await settleStoryTest();

  display.setStoryWidth("full");
  page.root.querySelector<HTMLElement>("[data-action='open-complete-history']")?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await settleStoryTest();

  expect(page.root.querySelector("[data-story-history]")?.hasAttribute("open")).toBe(true);
  mounted.dispose();
  display.dispose();
});

it("keeps a direct Quiet Leaf draft free of retired confirmation controls", async () => {
  const page = createStoryTestDom();
  const composition = createStoryTestComposition({ turnControlStyle: "flexible_action" });
  const mounted = mountStoryPlayerPage(page.root, { campaignId: "11111111-1111-4111-8111-111111111111", turnNumber: null }, composition, { uiImplementation: "web-awesome" });
  await settleStoryTest();
  const draft = page.root.querySelector<HTMLElement & { value: string }>("wa-textarea");
  if (!draft) throw new Error("Quiet Leaf draft control is missing.");
  draft.value = "A new action.";
  draft.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  expect(page.root.querySelector("[data-story-intent-confirmation]")).toBeNull();
  mounted.dispose();
});
