# Task 4 Report: Cover, Review, and Authoritative Creation

## Status

Implemented Task 4 with focused red-green TDD coverage.

## Completed

- Added the optional cover intent union: `none`, `retained_asset`, and `generated`.
- Added mode-specific retained asset and generated prompt validation.
- Added Review provenance, readiness, warnings, factual collection counts, and canonical serialized content with `playableCharacters: []`.
- Added owner-safe submission snapshots that strip forbidden root identity fields and force schema version 5 with no playable characters.
- Kept API response parsing narrow and retained malformed-request validation before POST.
- Added explicit authoritative world creation with one in-flight POST maximum, disabled duplicate activation, validation before requests, local-state preservation on failure, and navigation only after success.
- Persisted the created world id before optional cover work.
- Added independent retained-cover attachment and generated-cover operations after creation.
- Added cover failure recovery with **Open world** and **Retry cover**. Cover retries call only the cover endpoint and never repeat or roll back world creation.
- Added dirty-only `beforeunload` protection, BFCache-safe persisted pagehide behavior, disposal abortion for generation/creation, and stale-completion navigation guards.
- Preserved prior generated-draft canonicalization, replacement, polling, cancellation, collection editing, and character-exclusion invariants.

## TDD Evidence

Observed expected RED failures before implementation:

- Cover intent/model review tests failed because `coverIntent`, `setCreationCoverIntent`, and `creationReview` did not exist.
- Cover/Review page tests failed because those stages had placeholder rendering.
- Creation orchestration and lifecycle tests failed because create/cover dependencies, duplicate submission protection, dirty guards, and creation abortion were absent.
- The malformed submission boundary test failed because the refactored owner-safe snapshot initially did not validate before fetch; the API boundary was corrected and the test then passed.

## Verification

- `pnpm exec vitest run tests/unit/web-next-world-creation-model.test.ts tests/unit/web-next-world-creation-api.test.ts tests/unit/web-next-world-creation-page.test.ts tests/unit/request-security.test.ts` — PASS, 4 files / 63 tests.
- `pnpm --filter @infinite-quest/web-next check` — PASS.
- `git diff --check` — PASS.
- `node C:/Users/chris/.pi/agent/skills/impeccable/scripts/detect.mjs --json apps/web-next/src/world-creation-page.ts` — PASS, no findings.

The brief names `tests/unit/web-request-security.test.ts`, which does not exist in this checkout. The repository security test is `tests/unit/request-security.test.ts`; that test was run and passed.

## Full-Suite Concern

- `pnpm test` — FAIL on this Windows host: 149 files passed and 13 failed (1681 tests passed, 129 failed, 2 skipped). The failures are outside the Task 4 files and are dominated by Linux-only `/proc/self/fd` secure-filesystem assumptions, Windows path construction (`C:\\C:\\...`), `filesystem_platform_unsupported`, and a Windows `spawnSync pnpm ENOENT`. No Task 4 targeted test failed.

## Files Changed

- `apps/web-next/src/world-creation-model.ts`
- `apps/web-next/src/world-creation-api.ts`
- `apps/web-next/src/world-creation-page.ts`
- `tests/unit/web-next-world-creation-model.test.ts`
- `tests/unit/web-next-world-creation-api.test.ts`
- `tests/unit/web-next-world-creation-page.test.ts`
- `.superpowers/sdd/2026-08-11-world-creation-wizard/task-4-report.md`

## Concerns

- The full repository suite requires a Linux-compatible environment for its secure-filesystem tests; targeted Task 4 verification is green on this host.
- Projectmem was explicitly unavailable for this task, so no projectmem workflow calls or event records were made.

## Fix Round 1 Evidence

- Added a generated-cover status matrix covering accepted pending states (`queued`, `generating`, `provider_pending`, `downloading`), `completed`, and resolved failure states (`recoverable`, `failed`, `cancelled`, `expired`). Pending/success states expose truthful status copy before navigation; resolved failures preserve the created world and retry/open actions.
- Kept **Create world** enabled on an invalid Review. Activation now makes zero creation requests, renders and focuses the complete error summary, and each summary link returns to the exact invalid stage control.
- Expanded creation-failure regression coverage to verify preservation of AI provenance, generated-cover intent and prompt, every collection family, world defaults, and overview fields.
- Added lifecycle regressions for disposal during the initial generated-cover request and during a cover-only retry. Both abort their signal and ignore stale completion without navigation or stale cover messaging.
- Round 1 RED: `pnpm exec vitest run tests/unit/web-next-world-creation-page.test.ts` failed 13 tests before implementation (invalid Review behavior, state hydration/preservation, and all nine generated-cover status rows).
- Round 1 GREEN: `pnpm exec vitest run tests/unit/web-next-world-creation-model.test.ts tests/unit/web-next-world-creation-api.test.ts tests/unit/web-next-world-creation-page.test.ts tests/unit/request-security.test.ts` passed 4 files / 77 tests.
- Round 1 type check: `pnpm --filter @infinite-quest/web-next check` passed.
