import { expect, it, vi } from "vitest";
import { createDisplayPreferences } from "../../apps/web-next/src/preferences/display-preferences.js";
import { mountStoryPlayerPage } from "../../apps/web-next/src/story-player-page.js";
import { createStoryTestDom, createStoryTestComposition, settleStoryTest } from "../fixtures/quiet-leaf-story.js";

it("prepares Retry without immediately appending a turn", async () => {
  const page = createStoryTestDom();
  const composition = createStoryTestComposition({ turnControlStyle: "flexible_auto" });
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

it("submits the captured ambiguous action without rereading the editor", async () => {
  const page = createStoryTestDom();
  const classifyTurnInput = vi.fn().mockResolvedValue({
    classificationId: "88888888-8888-4888-8888-888888888888",
    classification: "mixed",
    resolvedMode: "scene",
    confidenceBand: "ambiguous",
    providerSource: "story_text",
    expiresAt: "2026-08-18T00:01:00.000Z"
  });
  const composition = createStoryTestComposition({ turnControlStyle: "flexible_auto", classifyTurnInput });
  const mounted = mountStoryPlayerPage(page.root, { campaignId: "11111111-1111-4111-8111-111111111111", turnNumber: null }, composition, { uiImplementation: "web-awesome" });
  await settleStoryTest();

  const draft = page.root.querySelector<HTMLElement & { value: string }>("wa-textarea");
  const continueStory = page.root.querySelector<HTMLElement>("[data-continue-story]");
  if (!draft || !continueStory) throw new Error("Quiet Leaf composer controls are missing.");
  draft.value = "Preserve this action.";
  draft.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  continueStory.dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await settleStoryTest();

  expect(page.root.querySelector("[data-story-intent-confirmation]")?.textContent).toContain("Preserve this action.");
  draft.value = "A newer draft.";
  page.root.querySelector<HTMLElement>("[data-confirm-intent-scene]")?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await settleStoryTest();

  expect(vi.mocked(composition.workflow.submit)).toHaveBeenCalledWith(
    "11111111-1111-4111-8111-111111111111",
    expect.objectContaining({ request: expect.objectContaining({ action: "Preserve this action.", resolvedInputMode: "scene" }) })
  );
  mounted.dispose();
});

it("preserves a real typed draft through display preference refreshes", async () => {
  const page = createStoryTestDom();
  const display = createDisplayPreferences(null);
  const composition = createStoryTestComposition({ turnControlStyle: "flexible_auto" });
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

it("clears a stale Core confirmation after real editor typing and focuses its action", async () => {
  const page = createStoryTestDom();
  const classifyTurnInput = vi.fn().mockResolvedValue({
    classificationId: "99999999-9999-4999-8999-999999999999",
    classification: "mixed",
    resolvedMode: "scene",
    confidenceBand: "ambiguous",
    providerSource: "story_text",
    expiresAt: "2026-08-18T00:01:00.000Z"
  });
  const composition = createStoryTestComposition({ turnControlStyle: "flexible_auto", classifyTurnInput });
  const mounted = mountStoryPlayerPage(page.root, { campaignId: "11111111-1111-4111-8111-111111111111", turnNumber: null }, composition, { uiImplementation: "web-awesome" });
  await settleStoryTest();

  const draft = page.root.querySelector<HTMLElement & { value: string }>("wa-textarea");
  const continueStory = page.root.querySelector<HTMLElement>("[data-continue-story]");
  const confirmAction = page.root.querySelector<HTMLElement>("[data-confirm-intent-action]");
  if (!draft || !continueStory || !confirmAction) throw new Error("Quiet Leaf confirmation controls are missing.");
  const focus = vi.spyOn(confirmAction, "focus");
  draft.value = "An ambiguous action.";
  draft.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  continueStory.dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await settleStoryTest();

  expect(focus).toHaveBeenCalledOnce();
  draft.value = "A new action.";
  draft.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  expect(page.root.querySelector<HTMLElement>("[data-story-intent-confirmation]")?.hidden).toBe(true);
  mounted.dispose();
});
