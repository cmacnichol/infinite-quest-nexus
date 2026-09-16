import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";

const nexusHtml = readFileSync("apps/web/public/index.html", "utf8");
const nexusScript = readFileSync("apps/web/public/nexus.js", "utf8");
const storyHtml = readFileSync("apps/web/public/story.html", "utf8");
const storyScript = readFileSync("apps/web/src/story.js", "utf8");

describe("legacy campaign story-memory controls", () => {
  it("offers the four server-backed levels in Nexus campaign Story settings", () => {
    const { document } = parseHTML(nexusHtml);
    const selector = document.querySelector<HTMLSelectElement>("#campaignStoryMemoryLevel");

    expect(document.querySelector("#campaignPanelStory")?.contains(selector)).toBe(true);
    expect(selector?.disabled).toBe(true);
    expect([...selector!.options].map((option) => option.value)).toEqual(["off", "standard", "enhanced", "max"]);
    expect(nexusScript).toContain("/story-memory");
    expect(nexusScript).toContain("availableLevels");
    expect(nexusScript).toContain("selectionRequest !== campaignSelectionRequest");
    expect(nexusScript).toContain("Story Memory level was not saved");
  });

  it("offers the current campaign's memory level from Story settings", () => {
    const { document } = parseHTML(storyHtml);
    const selector = document.querySelector<HTMLSelectElement>("#storyMemoryLevel");

    expect(selector?.disabled).toBe(true);
    expect([...selector!.options].map((option) => option.value)).toEqual(["off", "standard", "enhanced", "max"]);
    expect(storyScript).toContain("storyMemory");
    expect(storyScript).toContain("availableLevels");
    expect(storyScript).toContain("requestId !== state.storyMemoryRequestId");
    expect(storyScript).toContain("Story Memory level was not saved");
  });
});
