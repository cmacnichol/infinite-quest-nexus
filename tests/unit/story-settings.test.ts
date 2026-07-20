import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STORY_LENGTH_PROFILE,
  storyLengthProfileFromUnknown,
  storyLengthWordRange
} from "../../packages/contracts/src/story-settings.js";

describe("campaign story-length settings", () => {
  it("normalizes profiles and exposes their authoritative word ranges", () => {
    expect(DEFAULT_STORY_LENGTH_PROFILE).toBe("standard");
    expect(storyLengthProfileFromUnknown(" Extended ")).toBe("extended");
    expect(storyLengthProfileFromUnknown("unsupported")).toBe("standard");
    expect(storyLengthWordRange("brief")).toMatchObject({ minWords: 250, maxWords: 450 });
    expect(storyLengthWordRange("extended")).toMatchObject({ minWords: 1200, maxWords: 2000 });
  });

  it("backfills the authoritative column from legacy storyLength settings", () => {
    const migration = readFileSync("database/migrations/0013_campaign_story_length.sql", "utf8");
    expect(migration).toContain("legacy_settings->>'storyLength'");
    expect(migration).toContain("DEFAULT 'standard'");
    expect(migration).toContain("'brief', 'standard', 'long', 'extended'");
  });

  it("applies the legacy-client readability fallback to every text model", () => {
    const legacyClient = readFileSync("index.html", "utf8");
    expect(legacyClient).toContain("function paragraphizeStoryText");
    expect(legacyClient).toContain("return paragraphizeStoryText(text);");
    expect(legacyClient).not.toContain("return isFreeTextModelMode() ? paragraphize");
  });
});
