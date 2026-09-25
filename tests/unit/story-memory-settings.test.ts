import { describe, expect, it } from "vitest";
import {
  storyMemoryLevelSchema,
  storyMemorySettingsSchema,
  storyMemorySettingsUpdateSchema
} from "../../packages/contracts/src/story-memory-policy.js";

describe("story memory settings contracts", () => {
  it("accepts the four public levels and the enforced Max response", () => {
    expect(storyMemoryLevelSchema.options).toEqual(["off", "standard", "enhanced", "max"]);
    expect(storyMemorySettingsSchema.parse({
      level: "max",
      reviewMode: "enforce",
      availableLevels: ["off", "standard", "enhanced", "max"]
    })).toMatchObject({ level: "max", reviewMode: "enforce" });
  });

  it("accepts only a strict public level update", () => {
    expect(storyMemorySettingsUpdateSchema.parse({ level: "enhanced" })).toEqual({ level: "enhanced", continuityReviewEnabled: false });
    expect(storyMemorySettingsUpdateSchema.parse({ level: "max", continuityReviewEnabled: true })).toEqual({ level: "max", continuityReviewEnabled: true });
    expect(storyMemorySettingsUpdateSchema.safeParse({ level: "enhanced", continuityReviewEnabled: true }).success).toBe(false);
    expect(storyMemorySettingsUpdateSchema.safeParse({ level: "max", reviewMode: "enforce" }).success).toBe(false);
  });
});
