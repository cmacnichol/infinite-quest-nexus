# Phase 04 UI handoff

The legacy `/story` and replacement `/app/story` clients fetch the current
saved review before sending Keep, Retry, or `repair_format`. A changed review
is refreshed without resubmission. Each action is independently authorized:
a refreshed Keep capability can never fall through to a Retry replacement.

For a repairable v2 offer, the clients show the bounded format-repair
disclosure and state that Retry replaces the candidate with a new generation.
Malformed candidates do not display Keep. Future versions render as inert
refresh guidance in both clients. The repair follow-up keeps the narration
visible and uses the ordinary continuity review.

Browser evidence uses synthetic fiction only. The 28 required screenshots are
under `docs/review/assets/turn-validation-success/`, covering repair success,
stale revision, network/reload reconciliation, future version, ineligible
offer, full Retry, and repaired-candidate continuity rejection for both
surfaces at 1440x1000 and 390x844.

Verification at this checkpoint:

- `corepack pnpm exec vitest run tests/unit/generation-review-projection.test.ts tests/unit/web-next-story-generation.test.ts tests/unit/client-core/campaign-store.test.ts` — 58 passed.
- `corepack pnpm --filter @infinite-quest/client-core check`; replacement and legacy client checks — passed.
- `corepack pnpm exec playwright test tests/e2e/generation-review.e2e.test.ts --grep "repairs malformed|stale repair|lost repair|future review|ineligible format|full Retry|preserves narration through|never turns a revoked" --reporter=dot` — 32 passed: every required scenario runs independently at both viewports on both surfaces, plus four revoked-Keep cases.
- The 28 pre-existing generation-review browser regressions also passed separately after the final decision-safety change.
