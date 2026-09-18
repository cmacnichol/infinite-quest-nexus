export const structuredOutputFactId = "11111111-1111-4111-8111-111111111111";

export function makeStructuredOutputStory(overrides: Record<string, unknown> = {}) {
  return {
    narration: "Mira reaches the quiet observatory and studies the lantern.",
    choices: ["Enter the observatory.", "Study the lantern.", "Call for the keeper.", "Wait by the gate."],
    custom_action_suggestion: "Search the old map for a hidden route.",
    scratchpad: "Mira has reached the observatory.",
    tracker_updates: [],
    image_prompt: "A quiet observatory beside a lantern at dusk.",
    continuity_summary: "Mira reached the observatory and found a lantern.",
    canonical_facts: ["Mira reached the observatory."],
    superseded_facts: [],
    canonical_fact_updates: [{ content: "The observatory lantern is lit.", supersedes_fact_ids: [structuredOutputFactId] }],
    open_threads: ["Learn why the observatory lantern is lit."],
    ...overrides
  };
}

export const validChoiceRepair = {
  choices: ["Enter the observatory.", "Study the lantern.", "Call for the keeper.", "Wait by the gate."],
  custom_action_suggestion: "Search the old map for a hidden route."
};

export const validContinuityReview = {
  version: "story-continuity-review-v1",
  verdict: "pass",
  findings: []
};
