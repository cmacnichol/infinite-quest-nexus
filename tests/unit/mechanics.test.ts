import { describe, expect, it } from "vitest";
import {
  activatedEventsFromResponse,
  buildEventTriggerPrompt,
  buildRpgAssessmentPrompt,
  fictionGuidanceForEvents,
  fictionGuidanceForRoll,
  parseEventExtension,
  performPrivateRoll,
  RPG_ASSESSMENT_SYSTEM_PROMPT
} from "../../packages/story-engine/src/mechanics.js";

const stats = [{ id: "test_stat", name: "Test Stat", value: 65, note: "synthetic fixture value" }];

describe("typed private story orchestration", () => {
  it("produces a reproducible private percentile resolution", () => {
    const result = performPrivateRoll({
      stat_id: "test_stat",
      difficulty_modifier: -15,
      rationale: "Synthetic assessment rationale.",
      favorable_outcome: "Marker Five becomes active.",
      setback_outcome: "Marker Five remains inactive."
    }, stats, 42);
    expect(result).toMatchObject({ statId: "test_stat", base: 65, modifier: -15, target: 50, roll: 42, success: true, margin: 8 });
    expect(fictionGuidanceForRoll(result)).toEqual(["Marker Five becomes active."]);
  });

  it("keeps referee terminology out of the narrative guidance", () => {
    const result = performPrivateRoll({
      stat_id: "test_stat",
      difficulty_modifier: 0,
      rationale: "Private rationale.",
      favorable_outcome: "The d20 roll succeeds and Marker Five becomes active.",
      setback_outcome: "Marker Five remains inactive."
    }, stats, 10);
    const guidance = fictionGuidanceForRoll(result).join(" ");
    expect(guidance).not.toMatch(/d20|\broll(?:s|ed|ing)?\b|\bdice?\b/i);
    expect(RPG_ASSESSMENT_SYSTEM_PROMPT).toMatch(/percentile/);
    expect(buildRpgAssessmentPrompt({}, "Activate Object Delta.", stats)).not.toContain("difficulty_modifier");
  });

  it("accepts only configured trigger IDs and sanitizes their effects", () => {
    const triggers = [{
      id: "location",
      label: "Door",
      timing: "before" as const,
      condition: "Location Gamma opens",
      effect: "Marker Four becomes active.",
      addTextAfter: false,
      triggeredCount: 0,
      lastTriggeredTurn: null,
      lastTriggeredAt: null
    }];
    const events = activatedEventsFromResponse(JSON.stringify({
      activated_trigger_ids: ["location", "invented"],
      reasons: { location: "The player opened Location Gamma." }
    }), triggers, 4);
    expect(events).toHaveLength(1);
    expect(fictionGuidanceForEvents(events)).toEqual(["Marker Four becomes active."]);
    expect(buildEventTriggerPrompt("before", {}, "Activate Object Delta.", 4, triggers)).not.toContain("Marker Four");
  });

  it("rejects mechanics leakage in an after-response extension", () => {
    expect(() => parseEventExtension(JSON.stringify({
      additional_text: "The d100 roll succeeds and Marker Four becomes active.",
      tracker_updates: []
    }))).toThrow(/Mechanics language/);
  });
});
