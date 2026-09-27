/** Synthetic, non-user story used to reproduce a provider output cap. */
export const continuityReviewOutputLimitFixture = {
  direction: "Wait for the lighthouse signal.",
  story: {
    narration: "Mira waits at the lighthouse while the storm gathers offshore.",
    choices: ["Keep watch", "Return inside", "Signal the harbor", "Leave the coast"],
    custom_action_suggestion: "Keep watch",
    scratchpad: "synthetic private scratchpad",
    tracker_updates: [],
    image_prompt: "A lighthouse above a stormy coast.",
    continuity_summary: "Mira waits at the lighthouse.",
    canonical_facts: [],
    canonical_fact_updates: [],
    superseded_facts: [],
    open_threads: []
  },
  evidence: "Mira is at the lighthouse and is waiting for a signal."
} as const;

export const continuityReviewOutputLimitResponse = {
  content: "{\"version\":\"story-continuity-review-v1\",\"verdict\":\"pass\",\"findings\":[",
  outputLimited: true,
  finishReason: "length",
  usage: { inputTokens: 12_000, outputTokens: 4_096, totalTokens: 16_096 },
  usageReported: true
} as const;
