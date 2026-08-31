import type { StoryWidth } from "./display-preferences.js";

export function storyWidthLimits(width: StoryWidth): Readonly<{ leaf: string; prose: string }> {
  const limits = {
    auto: { leaf: "1440px", prose: "78ch" },
    comfortable: { leaf: "800px", prose: "65ch" },
    wide: { leaf: "1440px", prose: "100ch" },
    full: { leaf: "none", prose: "none" }
  } as const;
  return limits[width];
}
