import { expect, it } from "vitest";
import { mountStoryPlayerPage } from "../../apps/web-next/src/story-player-page.js";
import { createStoryTestDom, createStoryTestComposition, settleStoryTest } from "../fixtures/quiet-leaf-story.js";

it("keeps Core narration free of the native turn heading and duplicate retry action", async () => {
  const page = createStoryTestDom();
  const composition = createStoryTestComposition({ turnControlStyle: "flexible_auto" });
  const mounted = mountStoryPlayerPage(page.root, { campaignId: "11111111-1111-4111-8111-111111111111", turnNumber: null }, composition, { uiImplementation: "web-awesome" });
  await settleStoryTest();

  expect(page.root.querySelector("[data-quiet-leaf-presenter] .story-turn-coordinate")).toBeNull();
  expect(page.root.querySelector("[data-quiet-leaf-presenter] .story-title")).toBeNull();
  expect(page.root.querySelector("[data-quiet-leaf-presenter] [data-action='retry-latest-generation']")).toBeNull();
  expect(page.root.querySelector("[data-quiet-leaf-presenter] [data-action='undo-latest']")).not.toBeNull();
  expect(page.root.querySelector("[data-quiet-leaf-presenter] [data-retry-turn]")).not.toBeNull();
  mounted.dispose();
});

it("keeps the native turn heading and latest-generation retry action", async () => {
  const page = createStoryTestDom();
  const composition = createStoryTestComposition({ turnControlStyle: "flexible_auto" });
  const mounted = mountStoryPlayerPage(page.root, { campaignId: "11111111-1111-4111-8111-111111111111", turnNumber: null }, composition, { uiImplementation: "native" });
  await settleStoryTest();

  expect(page.root.querySelector(".story-turn-coordinate")?.textContent).toBe("Turn 1");
  expect(page.root.querySelector(".story-title")?.textContent).toBe("Turn 1");
  expect(page.root.querySelector("[data-action='retry-latest-generation']")).not.toBeNull();
  mounted.dispose();
});
