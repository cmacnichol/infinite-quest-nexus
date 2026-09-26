import { describe, expect, it } from "vitest";
import { narrationFormatSignals } from "../../packages/story-engine/src/narration-format-signals.js";

const signal = (raw: string, accepted = raw) => narrationFormatSignals(raw, accepted);

describe("narrationFormatSignals", () => {
  it("does not flag a solitary nonverbal scene", () => {
    expect(signal("Rain hammers the shutters. You wait alone by the cold stove.\n\nThe lamp gutters.").suspectedUnquotedSpeech).toBe(false);
  });
  it("does not flag reported speech", () => {
    expect(signal("She said she was leaving before dawn. You told her that the bridge was closed.").suspectedUnquotedSpeech).toBe(false);
  });
  it("does not flag internal thought", () => {
    expect(signal("Too late, you think. The ledger is gone, and Tomas knew it.").suspectedUnquotedSpeech).toBe(false);
  });
  it("does not flag correctly quoted dialogue, straight or typographic", () => {
    expect(signal("\"Stay,\" Mara says.\n\n\"Why?\" you ask.").suspectedUnquotedSpeech).toBe(false);
    expect(signal("“Stay,” Mara says.\n\n“Why?” you ask.").suspectedUnquotedSpeech).toBe(false);
  });
  it("does not flag mixed narration with some quoted dialogue", () => {
    expect(signal("The door creaks. “Stay,” Mara says. Wind rattles the glass, and you ask why, she replies nothing.").suspectedUnquotedSpeech).toBe(false);
  });
  it("flags repeated tagged speech without marks", () => {
    const result = signal("Are you leaving? Mara asks. Not yet, you say. Then when, she asks.");
    expect(result.speechTagsWithoutMarks).toBeGreaterThanOrEqual(2);
    expect(result.suspectedUnquotedSpeech).toBe(true);
  });
  it("reports synthesized paragraphs", () => {
    expect(signal("One. Two. Three.", "One.\n\nTwo. Three.").paragraphsSynthesized).toBe(true);
    expect(signal("One.\n\nTwo.", "One.\n\nTwo.").paragraphsSynthesized).toBe(false);
  });
});
