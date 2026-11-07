# Character review recovery implementation plan

**Goal:** Recover incomplete tracking and reduce the work of reviewing characters from accepted campaign turns.

**Architecture:** Use the existing scan and retry APIs. Store user-accepted source observations with the original turn evidence; retain the existing explicit override operation. Both Story clients share the same review flow.

**Scope:** Campaign cast only. Preserve strict matching unless an operator explicitly enables the existing unique-name policy. Never retry a paid request merely by opening a screen.

1. **Tracking recovery.** Show continuous coverage and the first gap; route failed forward jobs and scan-owned retries to their appropriate controls. Suggest the missing contiguous range. Preserve preview, idempotency and completed work. Verify failure, pause, manual-only, disabled and fully covered states.
2. **Detail authority.** Add a distinct accept action for eligible, unchanged observations. Preserve the original turn, source revision, hash and quote. Retain existing confirm semantics for explicit overrides, including old receipts. Verify chronology, conflicts, stale sources, authorization, generation locks and replay with PostgreSQL.
3. **Continuous review.** Use one queue for matches and details across both clients. Show exact-match suggestions, current versus proposed facts and their source turns. Group by resolved identity and field. Preserve explicit decisions, optional overrides and skips; continue to the next actionable item. Count only visible identity proposals.
4. **Verification.** Exercise both Story interfaces with synthetic desktop/mobile browser fixtures, run cast and repository checks, record limitations, and leave the running installation unchanged.

## Delivery and verification

Implemented in an isolated worktree based on `origin/main` at `97a8d986`. No migration or change to a running installation is required to retain existing facts and overrides. Deploy the updated application to use the new review controls. Recovery and review do not start paid work on their own.

- Full unit run: 5,340 passed, 44 skipped; subsequent focused decision and source tests passed.
- Eight affected PostgreSQL suites: 159 passed. After the last unique-name change, the full discovery suite passed all 64 tests, including ignored-name collisions and alias suggestions.
- Both Story clients: all 44 character browser tests passed with synthetic data, including failed-job recovery, source inspection, grouped proposals, stale revisions, older-server fallback, and exact versus ambiguous suggestions.
- Repository checks, TypeScript, production builds and diff whitespace checks passed. The existing Vite bundle-size warning remains.
- Live provider calls, deployment, changes to live feature flags and retries of real campaign jobs were not performed.

[Desktop review](../../review/assets/character-review-recovery/review-legacy-1440.png) · [Mobile review](../../review/assets/character-review-recovery/review-next-390.png) · [Tracking recovery](../../review/assets/character-review-recovery/tracking-recovery.png)
