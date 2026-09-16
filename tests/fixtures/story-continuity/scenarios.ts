/**
 * Sanitized source oracles for the executor-to-provider continuity baseline.
 *
 * These values name source evidence only. Provider replies live separately so
 * a passing reply cannot manufacture or satisfy a source-presence assertion.
 */
export const storyContinuitySourceOracle = Object.freeze({
  f1WorldSiblingLore: Object.freeze({
    id: "11111111-1111-4111-8111-111111111111",
    entitySnippet: "SABLE_RELAY_ENTITY: the lighthouse relay accepts only silver seals.",
    relationshipSnippet: "SABLE_RELAY_RELATIONSHIP: Keeper Ilyra maintains the Sable Relay."
  }),
  f2EditedCharacter: Object.freeze({
    id: "22222222-2222-4222-8222-222222222222",
    snippet: "MIRA_EDITED_PROFILE: Mira refuses to leave the relay during a storm."
  }),
  f3StructuredOnlyFact: Object.freeze({
    id: "33333333-3333-4333-8333-333333333333",
    snippet: "STRUCTURED_ONLY_FACT: the silver seal opens the Sable Relay."
  }),
  f4LateDirectionBeat: Object.freeze({
    id: "44444444-4444-4444-8444-444444444444",
    actionSnippet: "LATE_DIRECTION_BEAT: resolve the Sable Relay seal before dawn.",
    candidateSnippet: "LATE_DIRECTION_CANDIDATE: the keeper hid the silver seal under the relay stair."
  }),
  f5OldExactFact: Object.freeze({
    id: "55555555-5555-4555-8555-555555555555",
    snippet: "OLD_EXACT_FACT: the original relay key is buried beneath the north stair."
  }),
  correctedNarration: Object.freeze({
    id: "66666666-6666-4666-8666-666666666666",
    snippet: "CORRECTED_NARRATION: Keeper Ilyra survives and guards the silver seal."
  }),
  intentionalEmptyCorrection: Object.freeze({
    id: "77777777-7777-4777-8777-777777777777",
    continuitySummary: "",
    openThreads: Object.freeze([]),
    canonicalFacts: Object.freeze([]),
    scratchpad: ""
  }),
  negative: Object.freeze({
    wrongOwnerId: "88888888-8888-4888-8888-888888888888",
    wrongWorldVersionId: "99999999-9999-4999-8999-999999999999",
    rejectedDraftFactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    omittedFactId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    futureTurnNumber: 9_999
  })
});

/** Deliberately separate deterministic replies used only to advance fixture turns. */
export const storyContinuityCandidateOutput = Object.freeze({
  narration: "The lantern wind carries the company past the Sable Relay.",
  choices: Object.freeze([
    "Enter the relay.",
    "Inspect the stair.",
    "Ask Keeper Ilyra.",
    "Wait for dawn."
  ]),
  customActionSuggestion: "Examine the silver seal.",
  scratchpad: "The fixture relay remains private.",
  imagePrompt: "A storm-lit relay tower.",
  continuitySummary: "The company reaches the Sable Relay.",
  canonicalFacts: Object.freeze([]),
  canonicalFactUpdates: Object.freeze([]),
  openThreads: Object.freeze([])
});

export type StoryContinuitySourceOracle = typeof storyContinuitySourceOracle;
