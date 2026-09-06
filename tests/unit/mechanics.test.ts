import { describe, expect, it } from "vitest";
import {
  activatedEventsFromResponse,
  applyTriggerHits,
  buildEventTriggerPrompt,
  buildEventExtensionPrompt,
  buildRpgAssessmentPrompt,
  fictionGuidanceForEvents,
  fictionGuidanceForRoll,
  parseEventExtension,
  performPrivateRoll,
  RPG_ASSESSMENT_SYSTEM_PROMPT
} from "../../packages/story-engine/src/mechanics.js";

const stats = [{ id: "test_stat", name: "Test Stat", value: 65, note: "synthetic fixture value" }];

it("counts distinct event occurrences once without moving activation chronology backward", () => {
  const trigger = { id: "bell", label: "Bell", timing: "after" as const, condition: "The keeper arrives.",
    effect: "The bell rings.", addTextAfter: false, triggeredCount: 1, lastTriggeredTurn: 5, lastTriggeredAt: null };
  const occurrence = { id: "bell-occurrence", sourceTriggerId: "bell", name: "Bell", timing: "after" as const,
    condition: "", effect: "", instructions: "The bell rings.", reason: "", sourceTurn: 2, addTextAfter: false };
  expect(applyTriggerHits([trigger], [occurrence, occurrence, { ...occurrence, sourceTurn: 3 }], "accepted-now"))
    .toEqual([{ ...trigger, triggeredCount: 3, lastTriggeredTurn: 5, lastTriggeredAt: "accepted-now" }]);
});

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
      narration: "The party enters the hall. The d100 roll succeeds and Marker Four becomes active.",
      choices: ["One", "Two", "Three", "Four"],
      custom_action_suggestion: "Wait.",
      scratchpad: "The party reached the hall.",
      tracker_updates: [],
      image_prompt: "A hall",
      continuity_summary: "The party is in the hall.",
      canonical_facts: [],
      superseded_facts: [],
      canonical_fact_updates: [],
      open_threads: []
    }), "The party enters the hall.")).toThrow(/Mechanics language/);
  });

  it("binds an extension to the protected fiction authority, original action, and complete main draft", () => {
    const main = {
      narration: "The party enters the hall.", choices: ["One", "Two", "Three", "Four"],
      custom_action_suggestion: "Wait.", scratchpad: "They entered the hall.", tracker_updates: [],
      image_prompt: "A hall", continuity_summary: "The party entered the hall.", canonical_facts: [],
      superseded_facts: [], canonical_fact_updates: [], open_threads: []
    };
    const prompt = JSON.parse(buildEventExtensionPrompt(main, ["A bell rings."], {
      authoritativeRules: ["The bell is ancient."],
      currentContinuity: { canonicalFacts: [{ id: "bell-fact", content: "The bell hangs above the hall." }] }
    }, "Open the hall door."));

    expect(prompt).toMatchObject({
      original_player_action: "Open the hall door.",
      complete_validated_main_draft: main,
      protected_fiction_safe_base_authority: {
        authoritativeRules: ["The bell is ancient."],
        currentContinuity: { canonicalFacts: [{ id: "bell-fact", content: "The bell hangs above the hall." }] }
      },
      fictional_event_instructions: ["A bell rings."]
    });
  });
});
