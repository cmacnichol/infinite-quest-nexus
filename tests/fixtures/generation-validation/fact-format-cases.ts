import type { StoryTurnOutput } from "../../../packages/contracts/src/generation.js";

export const visibleBeaconId = "11111111-1111-4111-8111-111111111111";
export const visibleGateId = "22222222-2222-4222-8222-222222222222";

export function makeSyntheticStory(): StoryTurnOutput {
  return {
    narration: "The beacon is lit.",
    choices: ["Approach the beacon.", "Wait at the gate.", "Study the horizon.", "Call to the keeper."],
    custom_action_suggestion: "Describe another careful action.",
    scratchpad: "Private synthetic planning note.",
    tracker_updates: [],
    image_prompt: "A beacon shining beside a quiet gate.",
    continuity_summary: "The beacon is lit beside the gate.",
    canonical_facts: [],
    superseded_facts: [],
    canonical_fact_updates: [],
    open_threads: ["Learn why the beacon was lit."]
  };
}

export function rawSyntheticStory(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...makeSyntheticStory(), ...overrides });
}
