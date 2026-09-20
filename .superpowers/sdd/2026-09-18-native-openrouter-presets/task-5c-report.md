# Task 5C implementation report

## Status

DONE. API direct authoring, durable world/character/source authoring, illustration prompt refinement, and Story generation now receive the same production `createPreparedTextExecutor` backed by one `createPostgresPreparedTextAttemptRepository` per composed provider graph. Native admission remains disabled by default.

## What changed

- Added `invocationId` beneath a direct `requestScopeId`. A prepared direct workflow creates one stable request scope, one invocation pair for its outline, and one pair for each repeated seed expansion. Initial and semantic repair share the pair ID but retain distinct `initial`/`repair` keys. Separate requests create separate scopes.
- Composed one prepared executor in `createInternals` and passed that exact object to Story, direct world generation, character organization, durable authoring, source authoring, and illustration refinement. The Story worker no longer creates a second attempt repository/executor.
- Supplied durable authoring reservations from the claimed owner, job, stage, job generation, stage generation, and lease token. Both frozen v3 and historical v2 prepared paths receive the reservation and live-claim callback. Source chunk, synthesis, and character stages retain their persisted stage identities.
- Supplied illustration reservations from the actual prompt-job ID, claim attempt, and worker lease owner, with a live query that requires the same refining claim and unexpired lease. Frozen illustration execution fails closed when the claim identity is absent.
- Bound prepared world, character, organizer, extraction, synthesis, and source-character loops to `transportRetryOwner: "prepared_executor"`. Typed terminal schema/refusal/exhaustion/ambiguous/post-output results therefore do not enter the historical outer transport retry loop. Historical v1 rate-limit and timeout retry behavior remains covered.
- Added the single `NATIVE_TEXT_EXECUTION_PLAN_ADMISSION` setting and passed the same value to API generation enqueue, API authoring enqueue, the API provider graph, the worker provider graph, and worker authoring. It defaults to `false`.
- Kept the worker authoring surface capability-minimal: only direct resolution and model inventory methods are exposed; the prepared executor and preset/model preparation ports are carried in the private `authoringTextPlans` collaborator.

## Direct identity ruling and TDD evidence

The first direct composition test showed a real collision: `generateTemplateWorld` reuses one prepared closure for outline and repeated sequential seed expansions, while the prior key had only request scope plus `initial`/`repair`. Rotating request scopes avoided the collision but lost the required workflow parent grouping. Per controller ruling, the final design retains one request scope and adds a logical invocation/pair ID.

- RED: the actual outline/repeated-seed test observed colliding direct reservations when all operations shared the same request scope and `initial` key.
- GREEN: `tests/unit/direct-authoring-response-contract.test.ts` proves one stable scope, distinct outline and repeated-seed pair IDs, matching initial/repair pair IDs, and distinct scopes for concurrent prepared requests.
- Production evidence for the map lifetime is the current `generateTemplateWorld` sequence: outline and each seed expansion are awaited serially. Two simultaneous requests use separate prepared closures and therefore separate scopes. The implementation does not claim support for concurrent same-family initial calls within one closure.

## Other RED/GREEN evidence

- Durable/source RED: actual stage callers initially omitted job/stage generation, lease token, reservation, and live claim. GREEN: the preset/model matrix covers world, character, extraction, synthesis, and source-character initial/repair calls with exact durable reservations; historical v2 reclaim uses the same executor without refreshing route metadata.
- Illustration RED: the adapter had a prepared executor but no prompt-job claim. The first composed integration assertion also used the wrong parent join, then the fake model inventory lacked the required context window. GREEN: the actual prompt job now supplies its stored claim and the composed fake-wire test completes one physical attempt with identical stored/wire body, strict schema, and the frozen prompt exactly once.
- Two-job PostgreSQL RED: sequential workers allowed the first world job to enqueue a character stage that the second worker could claim, so the test did not compare two matching world jobs. GREEN: two concurrently claimed real world jobs execute matching bodies through the production graph and persist separate reservation keys and physical rows with no cross-job mutation.
- Retry RED: prepared terminal failures could be seen by the outer authoring retry owner. GREEN: schema/refusal/exhaustion/ambiguous/post-output cases each make one request and no delay, while historical v1 rate-limit and timeout cases retain their intended retries.
- Production wiring RED: the broad unit run exposed two stale `runtime-main-authoring` expectations after the shared collaborator and enqueue protocol option were added. GREEN: the scoped rerun proves shared executor identity, default-off admission, the minimal worker surface, and the correct default repository option.

## Verification

### Scoped unit gate

Command:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run tests/unit/direct-authoring-response-contract.test.ts tests/unit/authoring-stage-adapter.test.ts tests/unit/authoring-response-adapter.test.ts tests/unit/source-authoring-adapter.test.ts tests/unit/illustration-application-adapter.test.ts tests/unit/provider-application-composition.test.ts tests/unit/prepared-text-executor.test.ts tests/unit/security-config.test.ts tests/unit/runtime-main-authoring.test.ts tests/unit/runtime-generation-composition.test.ts tests/unit/runtime-role-composition.test.ts`

PASS: 11 files, 222 tests.

This includes all prepared terminal categories at one outer request/no delay, historical v1 rate-limit and timeout behavior, all source initial/repair combinations, direct identity grouping, illustration claim binding, config default, and API/worker graph identity.

### Dedicated PostgreSQL covering gate

Command:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/authoring-stage-execution.integration.test.ts tests/integration/preset-generation-workflow.integration.test.ts tests/integration/image-pipeline.integration.test.ts`

PASS: 3 files, 56 passed, 14 skipped. The run used the task-owned private integration configuration and dedicated test database. It covers the two matching durable authoring jobs, direct attempt persistence, illustration lifecycle origins, the real composed illustration prompt job, exact fake-wire bodies, typed claims, current-claim fences, schemas, and prompt-once behavior. The 14 skips are `secureGeneratedAssetsIt` cases intentionally gated by `supportsSecureGeneratedArchiveStaging()`: that secure staging implementation is Linux-only and this run was on Windows.

Harness notes:

- An early command accidentally used the repository-root integration configuration. Global setup aborted on database authentication before tests ran. Re-running against the task-owned private config restored the dedicated harness; no shared/default database was reset or modified and no credential was printed.
- A later sandboxed invocation could not read the private worktree configuration (`Access is denied`) and aborted at config loading. The identical command was rerun with normal worktree access and passed as reported above. Neither abort is an application test failure.

### Static checks

- `& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec tsc -p tsconfig.json --noEmit` — PASS, exit 0, no diagnostics.
- `git diff --check` — PASS, exit 0, no output.

## Broad unit run and unresolved branch gates

Command: `& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' test:unit`

Result: FAIL, 8 failed files plus one failed suite setup, 324 passed files; 15 failed, 4,180 passed, 48 skipped tests. The Task 5C-related `runtime-main-authoring` failures were corrected and its scoped rerun is green. The remaining failures were not classified against the approved base. Physical-attempt archive classification is assigned to Task 6A; the other unresolved failures remain Task 8 final gates:

- `tests/unit/chronicle-transaction-repository.test.ts`: 3 failures; mocks reject a newer provider-profile SQL projection as unexpected.
- `tests/unit/client-api-routes.test.ts`: 1 failure; enqueue response lacks a recognized `operationKind` discriminator.
- `tests/unit/generation-context-planner.test.ts`: 1 timeout at the 1,000,000-token case.
- `tests/unit/generation-response-contract-operation-matrix.test.ts`: 6 failures; five frozen-v2 contract fixtures are rejected and one completion expectation lacks the returned `resultHash: null` field.
- `tests/unit/system-archive-portability.test.ts`: 1 failure; `prepared_text_physical_attempts` is not classified in the archive registry. Ownership: Task 6A.
- `tests/unit/task-14e3g-production-binding.test.ts`: 1 timeout.
- `tests/unit/web-build-contract.test.ts`: suite setup failed because the sandboxed web build could not read outside the worktree path.

No Task 5C production or test file was changed to mask these branch-wide gates.

## Files changed

- `packages/application/src/illustration/types.ts`
- `packages/database/src/config.ts`
- `packages/database/src/prepared-text-attempt-repository.ts`
- `packages/story-engine/src/preset-route-execution.ts`
- `services/runtime/src/authoring-stage-adapter.ts`
- `services/runtime/src/authoring-text-execution-preparation.ts`
- `services/runtime/src/generation-worker-composition.ts`
- `services/runtime/src/illustration-platform-adapter.ts`
- `services/runtime/src/illustration-segment-job-adapter.ts`
- `services/runtime/src/main.ts`
- `services/runtime/src/provider-application-composition.ts`
- `services/runtime/src/source-authoring-adapter.ts`
- `tests/integration/authoring-stage-execution.integration.test.ts`
- `tests/integration/image-pipeline.integration.test.ts`
- `tests/integration/preset-generation-workflow.integration.test.ts`
- `tests/unit/authoring-response-adapter.test.ts`
- `tests/unit/authoring-stage-adapter.test.ts`
- `tests/unit/direct-authoring-response-contract.test.ts`
- `tests/unit/illustration-application-adapter.test.ts`
- `tests/unit/prepared-text-executor.test.ts`
- `tests/unit/provider-application-composition.test.ts`
- `tests/unit/runtime-main-authoring.test.ts`
- `tests/unit/security-config.test.ts`
- `.superpowers/sdd/2026-09-18-native-openrouter-presets/task-5c-report.md`

## Interfaces for the next slice

- Direct `LogicalReservation` now requires `invocationId` in addition to `requestScopeId` and operation.
- `RuntimeConfig.nativeTextExecutionPlanAdmission` reads `NATIVE_TEXT_EXECUTION_PLAN_ADMISSION`; absent remains false.
- Worker generation collaborators now expose the graph-owned `preparedTextExecutor`; callers must not create another repository/executor.
- Durable `LoadedAuthoringStage` carries optional `jobGeneration` and `leaseToken` for compatibility, but every prepared path fails closed unless stage ID, job/stage generations, and lease token are present.
- Illustration refinement request claim fields remain private optional application fields for legacy compatibility; every frozen prepared route requires all of them and the live-claim callback.

## Self-review and limits

- Confirmed one attempt repository/executor instance per actual provider graph and object identity across Story, authoring, organizer, and illustration consumers.
- Confirmed no provider network work moved inside a database transaction. Current-claim checks surround attempt mutations and late lease loss prevents completion/charging through the Task 5B executor contract.
- Confirmed checked request bytes, operation schema, frozen preset prompt, recovery overrides, and source inputs are passed to the shared executor without a second serializer or route loop.
- Confirmed root-owned untracked `docs/review/native-openrouter-presets/` and `scratch/` are excluded.
- No native flag was enabled. No live/paid inference, browser/UI work, deployment, push, PR, or main-checkout integration was performed.

## Independent review fix round 1

Review of `e51faf05` found production composition coherent but required stronger acceptance evidence. This round changes tests and this report only; no production source changed.

### Caller-level terminal containment

`tests/unit/authoring-stage-adapter.test.ts` now calls the real world-outline, standalone-character, and source-extraction adapters with each typed prepared terminal class: schema invalid, refusal, exhausted provider, ambiguous transport outcome, and post-output unknown outcome. Every caller makes one prepared invocation, does not enter repair, and schedules no outer delay. The existing historical-v1 rate-limit and timeout cases remain in `tests/unit/authoring-response-adapter.test.ts` and passed in the same covering run.

The first attempted run imported `buildTemplateWorldPrompt` from the wrong module. That was a test setup error; after importing it from `packages/domain/src/world-template.ts`, the first valid behavioral run passed all five parameter rows. No failing production behavior was observed and no production edit was made.

Focused command:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run tests/unit/authoring-stage-adapter.test.ts -t "contains prepared"`

PASS: 1 file, 5 passed, 52 filtered.

Covering command:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run tests/unit/authoring-stage-adapter.test.ts tests/unit/authoring-response-adapter.test.ts`

PASS: 2 files, 88 tests.

### Actual composed graph and physical-body evidence

The new direct integration invokes two concurrent real `generateTemplateWorld` workflows through `createApiProviderApplicationComposition`, the graph-owned prepared executor, a fake HTTP provider, and the PostgreSQL attempt repository. It proves eight physical rows equal the eight captured wire bodies: two stable request scopes, four distinct invocation pairs within each scope (outline plus three repeated seeds), exact outline/seed schemas, typed initial reservations, and one frozen preset prompt per body.

The durable matrix uses the provider-free API submission surface plus `createRuntimeAuthoringWorkerApplication` over the real worker graph and repository claims. Schema-valid but semantically invalid first outputs deliberately trigger the application repair path. Ten physical rows equal ten captured wire bodies and form five initial/repair pairs with unchanged owner, job, stage, generation, and lease identity: world outline, durable seed character, source extraction, source synthesis, and selected source character. The test also performs the real source review and synthesis transition.

The illustration lifecycle test now uses `createWorkerProviderApplicationComposition` and its shared prepared executor rather than a mock executor. Provisional, directly promoted, and reconciled prompt jobs each persist one physical attempt equal to the captured wire body with exact prompt-job claim identity, the refinement schema, and the frozen preset prompt once. The separate generated-segment composed test continues to cover the generated origin.

Focused commands:

- `& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/authoring-stage-execution.integration.test.ts -t "concurrent template-world"` — PASS: 1 passed, 28 filtered at that point in the file.
- `& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/authoring-stage-execution.integration.test.ts -t "persists composed durable character"` — PASS: 1 passed, 29 filtered.
- `& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/image-pipeline.integration.test.ts -t "promotes provisional native plans"` — PASS: 1 passed, 37 filtered.

Before the valid focused passes, test-only assumptions were corrected: an assertion referenced an unexposed graph property; a fixture used the wrong seed schema literal; the initial SQL marker existed only in outline bodies; durable job generation legitimately begins at zero; and UUID row order does not represent attempt order. These were setup/assertion failures, not production defects. The tests then exercised the production paths and passed without production changes.

Affected complete-file integration commands:

- `& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/authoring-stage-execution.integration.test.ts` — PASS: 1 file, 30 tests.
- `& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/image-pipeline.integration.test.ts` — PASS: 1 file, 24 passed, 14 Linux-only secure-staging skips.

### Fix-round static verification

- `& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec tsc -p tsconfig.json --noEmit` — PASS after narrowing two test-fixture union types; no diagnostics.
- `git diff --check` — PASS, no output.

The broader unit suite was not repeated because the review requested focused and affected covering checks. Its residual failure inventory above remains the Task 6A/Task 8 handoff.

## Independent re-review fix round 2

The scoped re-review accepted the caller containment, direct/durable/source matrix, and generated/provisional/promoted/reconciled illustration evidence. One acceptance gap remained: successful regenerated (`mode: "rebuild"`) illustration execution still appeared only behind a mocked prepared executor or authority-rejection cases.

`tests/integration/image-pipeline.integration.test.ts` now extends the existing real composed illustration test. After completing the generated-origin prompt, it queues a fresh `mode: "rebuild"` set, claims one regenerated prompt job through `createWorkerProviderApplicationComposition`, and completes the request against the fake HTTP provider. The test proves the regenerated job has one succeeded PostgreSQL physical attempt equal byte-for-byte to the one new captured wire body, uses `infinite_quest_illustration_prompt_refinement_v1`, includes `PRIVATE_COMPOSED_ILLUSTRATION_PROMPT` exactly once, carries the exact owner/prompt-job/claim-attempt/lease-owner/initial-operation reservation, and reaches `completed`.

This was a missing-evidence finding against already-correct production composition. The first valid focused run passed; no production defect was reproduced and no production file changed.

Focused command:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/image-pipeline.integration.test.ts -t "generated and regenerated"`

PASS: 1 file, 1 passed, 37 filtered.

Affected complete-file command:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/image-pipeline.integration.test.ts`

PASS: 1 file, 24 passed, 14 skipped. All 14 skips are the Windows run's expected `secureGeneratedAssetsIt` cases because secure generated-archive staging is implemented only on Linux.

Static checks:

- `& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec tsc -p tsconfig.json --noEmit` — PASS, exit 0, no diagnostics.
- `git diff --check` — PASS, exit 0, no output.

Round 2 changes only this integration test and this report. No broader suite was repeated, and the Task 6A/Task 8 residual inventory remains unchanged.
