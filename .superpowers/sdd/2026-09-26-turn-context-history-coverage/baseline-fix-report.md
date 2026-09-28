# Baseline assertion repairs

## Root causes and test changes

- `tests/unit/prepared-text-executor.test.ts`: the frozen-review test retained the removed 16,384-token clamp. The current contract reserves the configured 48,000 output tokens, leaving 17,536 input tokens in the 65,536-token route. Its old fixture required 21,138 tokens and was correctly rejected. The fixture now fits; the test compares the dispatched body and payload hash with the frozen bytes, asserts `max_tokens` equals the configured value (including 48,000), and verifies an oversized request fails before another provider dispatch.
- `tests/integration/story-memory-compatibility.integration.test.ts`: the restore assertion reflected the pre-0112 destination default. Migration 0112 changed new campaigns to `r3/off`. The source `r1/off` enrollment remains operational and excluded; the destination trigger supplies `r3/off`, and the test retains that default proof and the later explicit `r1/off` transition.
- `tests/integration/story-context-payload.integration.test.ts`: both failures treated the second provider request as if it were the first narration request. The primary request carries the full authority and canonical-fact contract; after invalid choices, the second request is `story_choice_repair` and carries its separate strict choice-only contract. Assertions now address each actual request in order. The repair must ask for exactly `choices` and `custom_action_suggestion`, explicitly excluding narration, facts, trackers, explanations, and other fields; the primary must retain canonical-fact authority and output-shape instructions.

## RED evidence

- `baseline-fix-red-unit.log`: 1 failed, 9 passed. Failure reports 21,138 required versus 17,536 available tokens.
- `baseline-fix-red-story-direction.log`: both Story Direction request-contract assertions fail against the actual choice-only repair request.
- `baseline-fix-red-system-archive.log`: System Archive restore expected `enforce` but the 0112 destination trigger produced `off`.
- Task 8's original full-file reproduction is retained in `task-8-pg.log` (2 failed, 21 passed, 6 skipped).

## GREEN evidence

- `baseline-fix-green-unit.log`: `corepack pnpm vitest run tests/unit/prepared-text-executor.test.ts` — exit 0; 1 file and 10 tests passed.
- `baseline-fix-green-pg.log`: disposable PostgreSQL targeted regressions — exit 0; 2 files, 5 passed, 26 filtered out.
- `baseline-fix-green-pg-full.log`: both affected integration files on disposable PostgreSQL — exit 0; 2 files, 24 passed, 7 skipped. Six unrelated known-failure probes remain gated by `RUN_KNOWN_FAILURE_BASELINES`; the Campaign ZIP case remains skipped on Windows by its existing platform guard.
- `baseline-fix-tsc.log`: `corepack pnpm exec tsc -p tsconfig.json --noEmit` — exit 0. `git diff --check` — exit 0.

The initial sandboxed Vite invocation could not read the repository's parent directories; reruns with the task-authorized elevated Vite access completed. No production, migration, prompt, provider, archived-authority, or contract files changed. No live provider was used.
