import { describe, expect, it } from "vitest";
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
      "choiceSelection",
      "draft",
      "history",
      "illustration",
      "message",
      "phase",
      "readingWidth",
      "viewTurnNumber"
    ]);
  });

  it("restores a valid persisted reading width", () => {
    const model = createStoryUiModel({}, memoryStorage({ [STORY_READING_WIDTH_STORAGE_KEY]: "wide" }));

    expect(model.get().readingWidth).toBe("wide");
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
});
