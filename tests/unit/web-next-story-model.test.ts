import { describe, expect, it, vi } from "vitest";
import { STORY_CONTEXT_BUDGET_STORAGE_KEY } from "../../packages/client-core/src/index.js";
import {
  STORY_READING_WIDTH_STORAGE_KEY,
  createStoryUiModel
} from "../../apps/web-next/src/story-player-model.js";

function memoryStorage(values: Record<string, string> = {}): Storage {
  return {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => { values[key] = value; },
    removeItem: (key) => { delete values[key]; },
    clear: () => { for (const key of Object.keys(values)) delete values[key]; },
    key: () => null,
    length: 0
  } as Storage;
}

describe("Story Player local UI model", () => {
  it("defaults reading width to Standard and exposes only local UI state", () => {
    const model = createStoryUiModel({}, memoryStorage());

    expect(model.get().readingWidth).toBe("standard");
    expect(Object.keys(model.get()).sort()).toEqual([
      "activeDialog",
      "activity",
      "choiceBaseText",
      "choiceSelection",
      "contextBudgetTokens",
      "continuousReading",
      "draft",
      "draftOwnerKey",
      "draftOwnerTurnNumber",
      "generationFollowing",
      "history",
      "illustration",
      "intentConfirmation",
      "message",
      "phase",
      "readingWidth",
      "requestedInputMode",
      "viewTurnNumber"
    ]);
    expect(model.get().contextBudgetTokens).toBe(32_000);
  });

  it("restores a valid persisted reading width", () => {
    const model = createStoryUiModel({}, memoryStorage({ [STORY_READING_WIDTH_STORAGE_KEY]: "wide" }));

    expect(model.get().readingWidth).toBe("wide");
  });

  it("restores and persists the Story context budget without adopting campaign state", () => {
    const values: Record<string, string> = { [STORY_CONTEXT_BUDGET_STORAGE_KEY]: "128000" };
    const model = createStoryUiModel({}, memoryStorage(values));

    expect(model.get().contextBudgetTokens).toBe(128_000);
    model.setContextBudgetTokens(256_000);

    expect(model.get().contextBudgetTokens).toBe(256_000);
    expect(values[STORY_CONTEXT_BUDGET_STORAGE_KEY]).toBe("256000");
  });

  it("falls back to Standard when persisted reading width is invalid or storage is unavailable", () => {
    const invalid = createStoryUiModel({}, memoryStorage({ [STORY_READING_WIDTH_STORAGE_KEY]: "expanded" }));
    const blockedStorage = {
      getItem: () => { throw new Error("storage blocked"); },
      setItem: () => { throw new Error("storage blocked"); }
    } as Storage;

    expect(invalid.get().readingWidth).toBe("standard");
    expect(createStoryUiModel({}, blockedStorage).get().readingWidth).toBe("standard");
  });

  it("keeps the local draft intact when changing the viewed turn or reading width", () => {
    const model = createStoryUiModel({ draft: "Wait at the bridge." }, memoryStorage());
    const externalCampaignId = "campaign-authority-remains-outside-the-model";

    model.setViewTurnNumber(7);
    model.setReadingWidth("narrow");

    expect(model.get().viewTurnNumber).toBe(7);
    expect(model.get().readingWidth).toBe("narrow");
    expect(model.get().draft).toBe("Wait at the bridge.");
    expect(externalCampaignId).toBe("campaign-authority-remains-outside-the-model");
  });

  it("tracks composer ownership, input mode, and resettable local draft provenance", () => {
    const model = createStoryUiModel({}, memoryStorage());

    model.syncComposer("campaign-a", 7, "flexible_scene");
    model.setComposerDraft("  Keep this exact draft.  ");
    model.setIntentConfirmation({
      action: "  Keep this exact draft.  ",
      classificationId: "classification-a",
      requestedInputMode: "auto",
      contextBudgetTokens: 32_000
    });

    expect(model.get()).toEqual(expect.objectContaining({
      draft: "  Keep this exact draft.  ",
      draftOwnerKey: "campaign-a:7",
      draftOwnerTurnNumber: 7,
      requestedInputMode: "scene",
      intentConfirmation: expect.objectContaining({ action: "  Keep this exact draft.  " })
    }));
    model.clearComposerDraft();
    expect(model.get()).toEqual(expect.objectContaining({
      draft: "", choiceSelection: [], choiceBaseText: "", intentConfirmation: null
    }));
  });

  it("publishes a restored Retry Latest draft before focus can return to the composer", () => {
    const model = createStoryUiModel({ draft: "Stale visible draft." }, memoryStorage());
    const listener = vi.fn();
    model.subscribe(listener);

    model.restoreComposerDraft("Restored accepted action.");

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ draft: "Restored accepted action." }));
    expect(model.get().draft).toBe("Restored accepted action.");
  });

  it("holds continuous-reading presentation locally without accepting campaign authority", () => {
    const model = createStoryUiModel({ continuousReading: true } as never, memoryStorage());

    expect(model.get().continuousReading).toBe(true);
  });

  it("holds generation preview following as local presentation state", () => {
    const model = createStoryUiModel({}, memoryStorage());

    expect(model.get().generationFollowing).toBe(true);
    model.setGenerationFollowing(false);
    expect(model.get().generationFollowing).toBe(false);
    model.setGenerationFollowing(true);
    expect(model.get().generationFollowing).toBe(true);
  });

  it("discards unknown runtime initial fields instead of retaining campaign authority", () => {
    const model = createStoryUiModel({
      draft: "A local draft.",
      campaign: { id: "must-not-enter-local-ui-state" },
      generation: { id: "must-not-enter-local-ui-state" }
    } as never, memoryStorage());

    expect(model.get()).toEqual(expect.objectContaining({ draft: "A local draft." }));
    expect(model.get()).not.toHaveProperty("campaign");
    expect(model.get()).not.toHaveProperty("generation");
  });

  it("returns snapshots that callers cannot use to mutate backing UI state", () => {
    const model = createStoryUiModel({}, memoryStorage());
    const exposed = model.get() as { draft: string; choiceSelection: number[] };

    exposed.draft = "Externally changed.";
    exposed.choiceSelection.push(1);

    expect(model.get().draft).toBe("");
    expect(model.get().choiceSelection).toEqual([]);
  });

  it("ignores an invalid runtime reading width without adopting or persisting it", () => {
    const values: Record<string, string> = {};
    const model = createStoryUiModel({}, memoryStorage(values));

    model.setReadingWidth("unbounded" as never);

    expect(model.get().readingWidth).toBe("standard");
    expect(values[STORY_READING_WIDTH_STORAGE_KEY]).toBeUndefined();
  });
});
