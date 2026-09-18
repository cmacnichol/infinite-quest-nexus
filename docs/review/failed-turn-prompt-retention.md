# Failed turn prompt retention

Base: `2ce55088` (merged generation format/recovery PR #160). Follow-up branch: `codex/retain-failed-turn-prompts`.

The requested behavior is to return a failed turn's submitted text to the next-turn custom text field so the player can retry manually. Both `/story` and `/app/story` are in scope.

## Behavior and boundaries

The change preserves submitted append text separately from transient generation recovery metadata. Restoration matches the campaign, generation attempt, and accepted-turn base. It preserves newer drafts and never submits automatically. Completed turns, replacement prompts, and temporary transport/result-loading failures are not treated as failed append drafts.

Both players restore the submitted text after an authoritative append failure or successful explicit discard. Reload recovery uses best-effort browser storage. The restored input mode remains subject to the campaign's current rules. Editing or clearing restored text prevents it from being restored again from stale terminal recovery metadata.

The behavior uses client state and browser storage only. No provider requests, generation validation, durable review decisions, accepted campaign state, or database schemas are changed.

Storage failures do not block generation; reload restoration is unavailable when browser storage is inaccessible. This is prompt retention, not automatic recovery or acceptance of generated narration.

## Verification

Verified production commit: `20b47cbc`; browser fixture hardening: `c22a27ed`. Synthetic fixtures verify application behavior; no live provider or production campaign was used.

Passed:

- Nine affected Vitest suites: **275 tests passed**. These cover failed-prompt and pending-submission storage, generation workflow, generation monitoring, both Story players and composition, and client boundaries.
- `corepack pnpm check`: repository boundaries, data safety, type checks, and JavaScript syntax checks passed.
- `corepack pnpm build`: both production clients built successfully. Existing web-next font-resolution and bundle-size warnings remain.
- `corepack pnpm exec playwright test tests/e2e/failed-turn-prompt-retention.e2e.test.ts tests/e2e/generation-review.e2e.test.ts`: **34 passed, 1 skipped**, using isolated ports 43293/43294. The six new retention scenarios passed on both players, including live failure, reload, explicit discard, manual resubmission with the selected mode, and accepted completion without stale text.
- Independent Terra review: all identified findings resolved; no remaining production findings.
- `git diff --check`: passed.

The skipped browser assertion requires an explicitly configured Web Awesome server (`TASK7_EXPECT_WEB_AWESOME=true`); this run used the standard renderer. PostgreSQL and live-provider checks were not run because the change is limited to client state, browser storage, and UI behavior. Browser tests used synthetic API responses and do not establish live-provider behavior.

Regression tests also cover protecting newer drafts, changed campaign input policy, changed campaign selection during enqueue, and avoiding association of a rejected local prompt with another active job. Initial failure-restoration and later policy/campaign regressions were observed failing before their fixes. Final verification has no failing checks.

Task-owned test servers were stopped after verification. No migrations, deployment changes, model settings, provider prompts, or secrets changed. Rollback is a client rebuild/redeploy of the prior revision; stored prompt records are best-effort UI data.

## Browser captures

- [Legacy desktop](assets/failed-turn-prompt-retention/legacy-failed-1440.png)
- [Legacy mobile](assets/failed-turn-prompt-retention/legacy-failed-390.png)
- [Replacement desktop](assets/failed-turn-prompt-retention/web-next-failed-1440.png)
- [Replacement mobile](assets/failed-turn-prompt-retention/web-next-failed-390.png)
