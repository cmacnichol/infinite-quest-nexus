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
    expect(document.querySelector("#campaignContinuityReviewEnabled")?.getAttribute("type")).toBe("checkbox");
    expect(document.querySelector("#campaignContinuityReviewEnabled")?.hasAttribute("checked")).toBe(false);
    expect([...selector!.options].map((option) => option.value)).toEqual(["off", "standard", "enhanced", "max"]);
    expect(nexusScript).toContain("/story-memory");
    expect(nexusScript).toContain("availableLevels");
    expect(nexusScript).toContain("selectionRequest !== campaignSelectionRequest");
    expect(nexusScript).toContain("Story Memory level was not saved");
  });

  it("keeps immediate Story Memory saves separate from explicit campaign metadata", () => {
    const snapshotStart = nexusScript.indexOf("function campaignSettingsSnapshot()");
    const snapshotEnd = nexusScript.indexOf("\n}", snapshotStart);
    const snapshot = nexusScript.slice(snapshotStart, snapshotEnd);
    const memorySaveStart = nexusScript.indexOf("async function saveCampaignStoryMemory()");
    const memorySaveEnd = nexusScript.indexOf("\nfunction ", memorySaveStart);
    const memorySave = nexusScript.slice(memorySaveStart, memorySaveEnd);

    expect(snapshot).toContain("title: elements.campaignTitle.value");
    expect(snapshot).toContain("storyContextBudgetTokens: Number(elements.campaignStoryContextBudgetTokens.value)");
    expect(snapshot).not.toContain("campaignStoryMemoryLevel");
    expect(memorySave).toContain('method: "PUT"');
    expect(memorySave).toContain('JSON.stringify({ level, continuityReviewEnabled })');
    expect(memorySave).not.toContain("campaignEditGuard.markSaved");
    expect(nexusHtml).toContain("Story Memory saves immediately when changed");
    expect(nexusHtml).toContain("Illustration settings save with their own button and status");
    expect(nexusHtml).toContain("Embedding settings save independently from campaign metadata.");
  });
  it("offers the current campaign's memory level from Story settings", () => {
    const { document } = parseHTML(storyHtml);
    const selector = document.querySelector<HTMLSelectElement>("#storyMemoryLevel");

    expect(selector?.disabled).toBe(true);
    expect(document.querySelector("#storyContinuityReviewEnabled")?.getAttribute("type")).toBe("checkbox");
    expect(document.querySelector("#storyContinuityReviewEnabled")?.hasAttribute("checked")).toBe(false);
    expect([...selector!.options].map((option) => option.value)).toEqual(["off", "standard", "enhanced", "max"]);
    expect(storyScript).toContain("storyMemory");
    expect(storyScript).toContain("availableLevels");
    expect(storyScript).toContain("requestId !== state.storyMemoryRequestId");
    expect(storyScript).toContain("Story Memory level was not saved");
  });
});
