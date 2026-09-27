# Task 3 handoff

## Implemented so far

- Added `packages/contracts/src/continuity-review-execution.ts` with the credential-free profile policy, frozen reviewer route plus V2 response-contract bundle, strict effective-limit checks, explicit enabled/disabled snapshot, and snapshot hashing.
- Added `services/runtime/src/continuity-review-execution.ts` to resolve independent primary/fallback Model or Preset route bases through the existing route resolver and prepare one V2 continuity-review response-contract bundle per route.
- Added the policy to safe provider configuration projection and validation, restricted it to `text` profiles, added its safe archive projection, and exported the contracts.
- Added queue preflight wiring in `services/runtime/src/generation-api-composition.ts` to resolve reviewer route metadata using the same selected text profile and credential authority, plus V2 contract eligibility/resolution.
- Added `continuityReviewExecution` to queue-time `PreparedQueuedTextExecution` and persist it for new append/replacement jobs. Missing policy captures an explicit disabled snapshot. Added database validation and persistence-preservation logic so orchestration updates cannot overwrite the frozen reviewer snapshot.
- Added four focused tests in `tests/unit/continuity-review-execution.test.ts`; the TDD RED run initially failed because the contract module did not exist.

## Completed worker wiring

- The final-review block selects the frozen primary reviewer route only when the queue-time snapshot is enabled. It retains legacy reviewer dispatch for historical jobs with no policy snapshot.
- `prepareFrozenContinuityReviewRequest` derives the reviewer plan, binds only its `continuity_review:nonstream` V2 response contract, and checked-serializes direct models or remote presets from that reviewer route. Presets retain `@preset/<slug>` on the wire.
- New policy jobs dispatch through `preparedTextExecutor`, with the reviewer route, reviewer contract bundle, exact checked request, and the durable physical-attempt reservation `{ kind: "story", invocationId: "continuity-review:primary:<bindingHash>" }`. The role-qualified reservation leaves Task 4 a distinct `fallback` identity without re-resolving provider configuration.
- The continuity checkpoint binding still receives the writer's producing-request hash and evidence manifest. Reviewer route/contract selection cannot alter that writer identity.

## Verification

- RED: `corepack pnpm exec vitest run tests/unit/continuity-review-execution.test.ts` initially failed three route-resolution cases because the frozen reviewer route omitted `providerType`.
- GREEN: `corepack pnpm exec vitest run tests/unit/continuity-review-execution.test.ts tests/unit/provider-request-budget.test.ts tests/unit/text-execution-overrides.test.ts tests/unit/story-continuity-review-adapter.test.ts tests/unit/generation-executor-adapter.test.ts` passed: 5 files, 156 tests.
- `corepack pnpm exec tsc -p tsconfig.json --noEmit` passed.
- `git diff --check` passed.

## Files changed by this task

`packages/application/src/providers/types.ts`, `packages/application/src/providers/use-cases.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/provider-profile-view.ts`, `packages/contracts/src/system-archives.ts`, `packages/contracts/src/continuity-review-execution.ts`, `packages/database/src/generation-execution-repository.ts`, `packages/database/src/generation-repository.ts`, `services/runtime/src/generation-api-composition.ts`, `services/runtime/src/generation-executor-adapter.ts`, `services/runtime/src/continuity-review-execution.ts`, and `tests/unit/continuity-review-execution.test.ts`.

The pre-existing untracked plan at `docs/superpowers/plans/2026-09-26-continuity-review-reliability.md` was left untouched.

## Review-finding follow-up

- Policy-enabled reviews now bind `reviewerExecutionSnapshotHash` into the continuity checkpoint and its reservation key; historical bindings omit the optional field and remain valid.
- The provider configuration guide documents the exact text-profile policy shape, explicit `null`/removal disable behavior, same-profile credential authority, and fallback opt-in/default-off semantics.
- Added checkpoint regression coverage for reviewer-bound and historical bindings.

## Prepared-executor integration evidence

- Command: `corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/story-continuity-review.integration.test.ts --testNamePattern "keeps a queue-produced native preset candidate"`.
- Result: passed (the command completed with exit code 0). The captured output showed Vitest starting and `Container infinitequest-integration-postgres Running`; it did not include Vitest's usual test-file or test-count summary, so no count is asserted here.
- The fixture enables `continuityReviewExecutionPolicy` on the text profile and verifies that the final review reaches `preparedTextExecutor` with the frozen primary route and V2 bundle, an exact checked body/hash, `continuity-review:primary:<bindingHash>`, the reviewer snapshot hash in the checkpoint binding, and the writer's original producing-request hash.

## Distinct reviewer-route follow-up

- The writer stays on `@preset/keep`; the policy selects `@preset/reviewer`. The fake provider serves both presets, and the fixture asserts both the frozen route selection and serialized wire model differ. This makes accidental writer-route reuse fail the regression.
- The first JSON-reporter verification attempts did **not** run the test: `numTotalTestSuites: 0`, `numTotalTests: 0`, `numPassedTests: 0`, `numFailedTests: 0`, `success: false`, and `testResults: []`. They are not pass evidence.
- Diagnosis: the test module evaluates `const databaseUrl = process.env.TEST_DATABASE_URL` before its Vitest global setup can provision an environment; additionally, the isolated worktree had a different `.env.test.local` hash while targeting the shared port. Reusing the main checkout's dedicated-test config did not change the zero-test JSON result. No test count is claimed until this harness ordering issue is resolved.

## Physical-attestation follow-up

- `responseContractState` now uses its transaction client and owner/job scope to validate reviewer-bound completed checkpoints against one read-only `prepared_text_physical_attempts` row. The row must match the owner, job, `continuity-review:primary:<bindingHash>` reservation, request body/hash, frozen reviewer plan, preset/model route identity, and frozen `continuity_review:nonstream` contract identity. It must be `completed`, `succeeded`, and have emitted output. Historical writer-ledger validation remains unchanged for bindings without a reviewer snapshot.
- RED: before the new physical-row fixture and validator, the dedicated isolated-PostgreSQL command produced `3 failed | 1 passed | 79 skipped (83)` because reviewer completions have no writer-ledger entry.
- GREEN: `TEST_DATABASE_URL` was read from the ignored task-local file and the dedicated integration config ran `tests/integration/story-continuity-review.integration.test.ts --testNamePattern 'keeps a queue-produced native preset candidate'`: `1 passed` file, `5 passed | 79 skipped (84)` tests. The added cases prove both tampered emitted-output and a `completed` row with `outcome='failed'` are rejected.
- `corepack pnpm exec tsc --noEmit` and `git diff --check` passed.
