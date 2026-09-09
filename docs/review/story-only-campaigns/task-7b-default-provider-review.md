# Task 7B default-provider correction review

## Decision

Approved for source evidence. The zero-turn client predicate now accepts only
providers with `enabled === true`, matching the server's default-provider
selection precondition. A provider response with an absent or malformed
`enabled` field therefore keeps **Begin Story** disabled and retains the setup
recovery link.

## Scope and behavior

- `apps/web-next/src/story-player-page.ts` filters text providers by an explicit
  enabled value before resolving either a campaign override or the server's
  default rule.
- `tests/unit/web-next-story-page.test.ts` adds the missing-`enabled` regression
  to the selection matrix. Existing test fixtures that represent available
  providers already declare `enabled: true`.
- The correction leaves the zero-turn-only lookup boundary intact: accepted-turn
  page loads do not query providers.

## Evidence

- RED: `node node_modules/vitest/vitest.mjs run tests/unit/web-next-story-page.test.ts -t "rejects a provider whose enabled state is missing"` failed before the predicate correction because Begin Story was enabled.
- GREEN: `node node_modules/vitest/vitest.mjs run tests/unit/web-next-story-page.test.ts` passed 70/70.
- `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` passed.
- `git diff --check` passed.

Browser and runtime evidence are outside this source-only correction.

## Narrow re-review

Accepted. The amended predicate uses `details.enabled === true`, which is the
same enabled-state requirement as the server resolver's `enabled = true`
queries. Because the provider-list contract requires each entry to be an
object but permits untyped extension fields, an absent, false, or non-boolean
`enabled` field cannot make a provider eligible. It therefore fails closed.

The explicit selection still requires the configured id to be present in the
enabled text-provider set; it does not fall back to another default. With no
explicit id, the client still allows exactly one enabled text provider or an
enabled default among several, matching the server's selection rule. The
existing accepted-turn regression confirms that the lookup remains restricted
to zero-turn loads. Both renderers consume the same `canBeginStory` state, and
the focused opening test covers both renderers for the Scene opening request.

This re-review was source-only. No browser, runtime, build, or additional test
command was run by this reviewer; the reported focused RED/GREEN and 70-test
unit result remain the implementing agent's evidence.
