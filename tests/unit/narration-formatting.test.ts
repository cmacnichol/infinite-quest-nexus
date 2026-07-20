import { describe, expect, it } from "vitest";
import { formatNarrationParagraphs } from "../../packages/story-engine/src/narration-formatting.js";

function withoutWhitespace(value: string): string {
  return value.replace(/\s/gu, "");
}

const longUnbrokenNarration = [
  "Dr. Vale pauses beside the brass observatory controls while the storm paints moving shadows across every dial and lever.",
  "The central gauge still reads 3.14 volts, although the machine beneath it has begun to hum with a deeper and less familiar rhythm.",
  "You move closer, careful not to touch the copper rails that now carry thin threads of violet light toward the sealed northern door.",
  "Beyond that door, something heavy crosses the archive floor and stops directly opposite the lock as if it has heard your approach.",
  "\"Stay behind me,\" Vale whispers, drawing the lantern down until its glow barely reaches the first row of darkened instruments.",
  "A second shadow passes beneath the door, smaller than the first, and a patient scratching sound begins around the edge of the frame.",
  "You have only a moment to choose between the emergency cutoff, the speaking tube, and the narrow service passage behind the console."
].join(" ");

describe("narration paragraph formatting", () => {
  it("adds readable paragraph breaks without changing narration content", () => {
    const formatted = formatNarrationParagraphs(longUnbrokenNarration);
    expect(formatted.split("\n\n").length).toBeGreaterThan(1);
    expect(withoutWhitespace(formatted)).toBe(withoutWhitespace(longUnbrokenNarration));
    expect(formatted).toContain("Dr. Vale pauses");
    expect(formatted).toContain("3.14 volts");
  });

  it("is idempotent and retains model-supplied paragraphs", () => {
    const supplied = "The first paragraph remains intact. It establishes the room.\n\n\"Who is there?\" Vale asks. You wait for an answer.";
    const once = formatNarrationParagraphs(supplied);
    expect(once).toBe(supplied);
    expect(formatNarrationParagraphs(once)).toBe(once);
    expect(formatNarrationParagraphs(longUnbrokenNarration)).toBe(formatNarrationParagraphs(formatNarrationParagraphs(longUnbrokenNarration)));
  });

  it("does not force short narration into multiple paragraphs", () => {
    expect(formatNarrationParagraphs("You open the door. The room beyond is empty."))
      .toBe("You open the door. The room beyond is empty.");
  });
});
