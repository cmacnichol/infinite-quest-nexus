import { describe, expect, it } from "vitest";
import { recoverInterruptedStory } from "../../packages/story-engine/src/interrupted-story.js";
const story = { narration: "Mira opens the observatory door.", choices: ["Enter.", "Wait.", "Listen.", "Leave."], custom_action_suggestion: "Study the lantern.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "The door is open.", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] };
describe("interrupted story recovery", () => {
  it("recovers the unique valid correction after an invalid first object and before an incomplete repetition", () => {
    const invalid = { ...story, custom_action_suggestion: undefined };
    const raw = JSON.stringify(invalid) + "\nLet me fix the JSON:\n```json\n" + JSON.stringify(story) + "\n```\n" + JSON.stringify(story).slice(0, 90);
    expect(recoverInterruptedStory(raw)).toEqual(story);
  });
  it("rejects ambiguous complete stories", () => {
    expect(recoverInterruptedStory(JSON.stringify(story) + "\n" + JSON.stringify({ ...story, narration: "Mira closes the door." }))).toBeNull();
    expect(recoverInterruptedStory(JSON.stringify(story) + JSON.stringify({ ...story, narration: "Mira closes the door." }))).toBeNull();
  });
  it("never repairs missing fields or accepts truncated JSON", () => {
    expect(recoverInterruptedStory(JSON.stringify(story).slice(0, -1))).toBeNull();
    expect(recoverInterruptedStory(JSON.stringify({ narration: story.narration }))).toBeNull();
  });
  it("rejects mechanic leakage and accepts identical repeated objects", () => {
    expect(recoverInterruptedStory(JSON.stringify({ ...story, narration: "Roll a d20 for a difficulty check." }))).toBeNull();
    expect(recoverInterruptedStory(JSON.stringify(story) + "\n" + JSON.stringify(story))).toEqual(story);
  });
});
