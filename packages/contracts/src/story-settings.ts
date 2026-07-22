import { z } from "zod";

export const storyLengthProfileSchema = z.enum(["brief", "standard", "long", "extended"]);

export type StoryLengthProfile = z.infer<typeof storyLengthProfileSchema>;

export type StoryLengthWordRange = {
  profile: StoryLengthProfile;
  minWords: number;
  maxWords: number;
};

export const DEFAULT_STORY_LENGTH_PROFILE: StoryLengthProfile = "standard";

export const STORY_LENGTH_WORD_RANGES: Record<StoryLengthProfile, StoryLengthWordRange> = {
  brief: { profile: "brief", minWords: 250, maxWords: 450 },
  standard: { profile: "standard", minWords: 450, maxWords: 900 },
  long: { profile: "long", minWords: 800, maxWords: 1200 },
  extended: { profile: "extended", minWords: 1200, maxWords: 2000 }
};

export function storyLengthWordRange(profile: StoryLengthProfile = DEFAULT_STORY_LENGTH_PROFILE): StoryLengthWordRange {
  return STORY_LENGTH_WORD_RANGES[profile];
}

export function storyLengthProfileFromUnknown(value: unknown): StoryLengthProfile {
  const parsed = storyLengthProfileSchema.safeParse(typeof value === "string" ? value.trim().toLowerCase() : value);
  return parsed.success ? parsed.data : DEFAULT_STORY_LENGTH_PROFILE;
}
