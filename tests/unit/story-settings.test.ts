import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STORY_LENGTH_PROFILE,
  storyLengthProfileSchema,
  storyLengthProfileFromUnknown,
  storyLengthWordRange,
  type StoryLengthProfile
} from "../../packages/contracts/src/index.js";

describe("campaign story-length settings", () => {
  it("exports the shared story-length contract from the public barrel", () => {
    const profile: StoryLengthProfile = storyLengthProfileSchema.parse("long");

    expect(profile).toBe("long");
  });

  it("normalizes profiles and exposes their authoritative word ranges", () => {
    expect(DEFAULT_STORY_LENGTH_PROFILE).toBe("standard");
    expect(storyLengthProfileFromUnknown(" Extended ")).toBe("extended");
    expect(storyLengthProfileFromUnknown("unsupported")).toBe("standard");
    expect(storyLengthWordRange("brief")).toMatchObject({ minWords: 250, maxWords: 450 });
    expect(storyLengthWordRange("long")).toMatchObject({ minWords: 800, maxWords: 1200 });
    expect(storyLengthWordRange("extended")).toMatchObject({ minWords: 1200, maxWords: 2000 });
  });

  it("backfills the authoritative column from legacy storyLength settings", () => {
    const migration = readFileSync("database/migrations/0013_campaign_story_length.sql", "utf8");
    expect(migration).toContain("legacy_settings->>'storyLength'");
    expect(migration).toContain("DEFAULT 'standard'");
    expect(migration).toContain("'brief', 'standard', 'long', 'extended'");
  });

  it("renders narration through the active Story Player sanitizer", () => {
    const storyPlayer = readFileSync("apps/web/src/story.js", "utf8");
    expect(storyPlayer).toContain("const sanitizeNarration = (text) => {");
    expect(storyPlayer).toContain('`<div class="narration">${sanitizeNarration(turn.narration)}</div>`');
    expect(storyPlayer).toContain("sanitizeNarration(narrationText)");
  });
});
