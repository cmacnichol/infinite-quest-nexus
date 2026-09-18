# Structured output phase 02 handoff

Base: `a8bc02f1ea908f08efe118fa23d6a2fccfe76214`. Final: the scoped commit that contains this handoff.

This patch adds an immutable provider-wire schema registry in Story Engine. Its three entries are `story-native-v1`, `choices-v1`, and `continuity-review-v1`; each hashes its fully stable-serialized schema body. A schema body is recursively frozen, and a changed body requires a new version and a new verification record.

| Generation path | Response-schema operation |
| --- | --- |
| Primary, explicit primary retry, full-story continuity repair, event extension | `story` |
| Choice-only repair | `choices` |
| Continuity review | `continuity_review` |
| RPG assessment, event-trigger assessment, authoring, embeddings, images | Existing explicit behavior; no inherited story schema |
| `repair_format` | Local deterministic transformation; no provider request or response schema |

The story schema requires every current replacement and delta field, exactly four choices, empty `superseded_facts`, bounded arrays, UUID fact references, and closed known objects. It preserves arbitrary JSON in `tracker_updates` item objects. `requiresOpenTrackerObjects` is therefore true only for `story`; a profile that cannot represent open tracker objects must be ineligible before dispatch. The wire schema rejects provider-shape omissions that the compatibility parser may normalize, while `parseStoryOutput` retains its current normalization and mechanics checks.

The continuity-review wire schema covers source, candidate, and omission unions and retains exact whitespace-bearing quotations. It checks syntax and bounds only. `validateContinuityReview` remains responsible for evidence IDs, candidate draft hashes, locations, and semantic authority. Choice repair still uses its normal parser for duplicate and mechanics checks.

RED: before registry construction, `corepack pnpm exec vitest run tests/unit/provider-output-schema.test.ts` failed 13 behavioral assertions because the callable registry threw `Provider output schemas have not been registered.`

GREEN: `corepack pnpm exec vitest run tests/unit/provider-output-schema.test.ts tests/unit/story-output.test.ts tests/unit/fact-format-repair.test.ts tests/unit/story-continuity-review-contracts.test.ts` passed 119 tests in 4 files. `corepack pnpm check` passed after the final schema/test corrections. `git diff --check` is recorded with the final scoped review.

No PostgreSQL, browser, live-provider, production-data, deployment, or main-branch checks ran. No provider mode or request serialization changed in this patch. Tracker compatibility is a registry declaration only; endpoint capability admission and frozen dispatch remain later patches.
