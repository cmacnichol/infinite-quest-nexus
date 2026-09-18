# Turn validation success: verification matrix

Scope: requested implementation phases 01–04. Status entries remain pending until coordinator inspection establishes evidence at the final integrated SHA. No deployment or live-model improvement is implied.

## Baseline

- Base source: `2ce5508872ba0588c0c0ea51769bb828194b3f46`.
- Isolated worktree: `C:/Git/InfiniteQuest/.worktrees/turn-validation-success`.
- Five focused unit files: 75 passed.
- Real isolated PostgreSQL baseline `generation-review.integration.test.ts`: 8 passed.
- Initial integration setup failed due to a newly generated worktree test password differing from the pre-existing test volume. Reusing the existing ignored test environment corrected setup; no production database changes were made.
- Browser validation will use repository Playwright because the Browser plugin/skill is not available in this session. Native CUA is not needed for deterministic repository browser fixtures.
- Read-only production cohort reconfirmed during implementation: newest 50 jobs with `created_at <= 2026-09-18T05:05:13.987485Z`, 40 completed, 49 saved first responses, 15 valid and 34 invalid. This fixed cutoff prevents newer user jobs from changing the before/after denominator.
- Additional read-only shape audit: 145 rejected ID-bearing fact items include 63 UUID-shaped IDs, 66 short ASCII labels, nine empty strings, and seven null IDs. Phase-03 eligibility was corrected to cover these inert-label shapes only under explicit consent; actual replacement references remain exact visible UUIDs. Raw fiction was not emitted or saved in the repository.
- Remaining malformed fact wrappers: 31 contain empty `supersedes_fact_ids` arrays (zero nonempty or malformed lists), and three contain finite nonnegative integer `estimatedTokens`. These are item-shape observations, not proof that their containing stories pass every repair/authority gate.

- Coordinator phase01 rerun: six focused unit files121/121; two real PostgreSQL files69/69, no skips.
- Historical evidence availability, same fixed50 cutoff:10 jobs retain primaryResult requestBody/hash;38 retain sourceEvidenceManifest. Four invalid and four valid earliest responses exactly match retained primaryResult response bytes. The other two retained primary results belong to different observations. Do not reconstruct missing historical request content from current state; report evidence unavailable separately.

## Phase acceptance evidence

| Requirement | Required evidence | Status |
|---|---|---|
| 01 earliest primary denominator and duplicates | Reducer tests including completed-after-repair and no-response cases | Passed at 9f5986ca; see phase-01 handoff and coordinator rerun |
| 01 report read-only bounded SQL and redaction | CLI tests and safe report sample | Passed at 9f5986ca; see phase-01 handoff and coordinator rerun |
| 01 actual vs configured model/prompt cohorts | Cohort output fixtures and source trace | Passed at efdf6225; actual enrolled, legacy Story Direction, and v16 marked identities covered; review approved |
| 01 failure cause survives disposition | PostgreSQL failure/cancel/discard tests | Passed at 9f5986ca; see phase-01 handoff and coordinator rerun |
| 01 public finite diagnostics | HTTP/SSE projection and injection tests | Passed at 9f5986ca; see phase-01 handoff and coordinator rerun |
| 02 mandatory rule in actual composed requests | Default/override/Action/Story Direction payload tests | Passed at 1f4e9fb9; phase-02 handoff, coordinator Linux and exact Retry regression, review clean |
| 02 old prompt identity preserved | Old job retry/resume and new enqueue integration evidence | Passed at 1f4e9fb9; phase-02 handoff, coordinator Linux and exact Retry regression, review clean |
| 03 complete decision table | Each shape accepted or rejected as specified | Passed at 099d2394; independent reviewer and coordinator each ran 100 tests across three files |
| 03 content mass balance and protected fields | Exact preservation and collision tests | Passed at 099d2394; trim-changing candidates rejected, mixed content wrappers preserved |
| 03 parser acceptance unchanged | Direct malformed object still rejected | Passed at 099d2394; existing parser files unchanged and rejection regressions pass |
| 03 ID/supersession and mechanics safety | Visible/unseen ID and mechanics fixtures | Passed at 099d2394; removed references checked for mechanics, shared UUID validation, review approved |
| 04 v1/v2 wire and checkpoint compatibility | Old receipts, future versions, clients, compile checks | Pending |
| 04 explicit decision, atomic concurrency | DB duplicate/stale/wrong owner/revision/plan tests | Pending |
| 04 exact original request/source evidence | Tampering and changed authority tests | Pending |
| 04 no repeated primary generation | Composed provider-call counts before/after repair | Pending |
| 04 ordinary downstream validation retained | Strict parser, choice, continuity-off/observe/enforce and commit tests | Pending |
| 04 crash/reclaim boundaries | Before/after receipt/checkpoint/review/commit tests | Pending |
| 04 no rejected authoritative writes | Turn/state/fact/accepted Chronicle row comparisons | Pending |
| 04 Action and Story Direction, append/replacement | Composed mode/operation matrix | Pending |
| 04 optional illustrations independent | Acceptance despite illustration failure, no duplicate enqueue | Pending |
| 04 both UI surfaces | Desktop/mobile Playwright interactions and screenshots | Pending |
| 04 unreachable dispatch removed safely | Route call-count and historical resume regressions | Pending |
| Combined source quality | Fresh Terra spec/code review plus coordinator findings adjudication | Pending |
| Combined verification | Focused/full relevant units, real DB, type/check/build, diff | Pending |
| Reduces observed format failures | Bounded read-only saved-response replay and synthetic acceptance comparison | Pending |

## Outcome interpretation

Report first-pass parse success separately from deterministic repair eligibility, strict validity after repair, and actual acceptance in composed tests. Retrospective parser replay cannot prove historical downstream acceptance. User-authorized recovery is not first-pass generation improvement. Live-provider quality remains unmeasured unless separately authorized.

## Phase 04 checkpoint verification (incomplete phase)

At immutable `0eaab2a6e5838b0f10858459c8c312760f1da879`, the coordinator independently ran eight focused unit files (169 passed) and `generation-review.integration.test.ts` against isolated Linux PostgreSQL (10 passed, no skips). Source was a Git archive, so subsequent implementation edits were excluded. The PostgreSQL suite includes the future-version projection regression. This evidence covers planner/adapter, review contracts/projections/policy, client workflow, parser, and receipt behavior; it does not establish composed repair acceptance, crash recovery, or rendered browser behavior. Those gates remain pending.

At immutable `b973297c`, the coordinator independently ran the composed continuity-review and receipt suites against isolated Linux PostgreSQL: 58/58 passed, no skips. The new format-repair case proves a v2 offer, explicit repair decision, one primary call, completed job, one additional accepted turn and saved repair provenance. It does not yet prove all intermediate no-write, crash, policy/mode, later-review and optional-provider gates in the acceptance checklist. Expected synthetic unavailable-embedding diagnostics were logged by the harness; no live provider was used.

At immutable `5cd223c7`, the coordinator independently ran the adapter and report suites: 12/12 passed. The repeated-receipt regression selects the matching current receipt after an older receipt. The report uses sanitized build identity with precedence `NEXUS_BUILD_COMMIT`, `GIT_SHA`, `BUILD_SHA`, then `unknown`; nine report tests cover precedence, fallback and unsafe labels. This closes the deferred deployed build environment naming gap, without claiming a deployed report was executed.

### Broad unit checkpoint

The coordinator ran the complete unit selection at immutable `5cd223c7` in the Git-equipped Linux test image: **306 files passed; 3,850 tests passed; one platform-conditional test skipped; exit 0**. The skipped test checks rejection on an unsupported secure-filesystem host; this Linux host supports that implementation, so its supported-host cases ran. The previously failing dropped-notification timing case passed at 15,062 ms. No unhandled FileHandle errors occurred. This closes the prior broad-run uncertainty at this intermediate SHA; final runtime/UI edits still require final verification.

An initial coordinator invocation omitted `tests/unit` and incorrectly collected Playwright, integration and standalone fixture tests under Vitest. It failed and is not counted as verification. The corrected command matched the package script's `vitest run tests/unit` selection, with the required worktree exclusions. Neither run used live providers or production PostgreSQL.

### Scope and later-review checkpoints

- `fe37fe1a`: coordinator independently passed 59 real Linux PostgreSQL tests (48 continuity, 11 review persistence) and 61 adapter/executor unit tests. The coherent campaign-scope tamper fixture now explicitly passes checkpoint schema validation. Removing only the load-time actual-job scope guard in a disposable archive made the targeted test fail (`expected payload to be null`); the intact version passes. This proves that regression exercises the scope guard, while the full foreign-owner/world/base/commit matrix remains pending.
- `da43fad8`: coordinator independently passed the targeted real-PostgreSQL repair → continuity conflict → explicit Keep → completed sequence (one passed, 48 deselected). Journal retains repair and Keep; primary call count remains one. This is not the second-repair/Retry or crash matrix.
- `ea905754`: coordinator independently passed 57 executor unit tests after removing 122 provably unreachable automatic schema/mechanics repair dispatch lines. Existing structure-review call-count and historical recovery checkpoint cases remain. The runbook and full final verification remain outstanding.

### UI review corrections at the earlier checkpoint

The UI implementer reported 14 scenario tests spanning both surfaces, with desktop and mobile captures (28 screenshots), plus 58 focused units. Those results are not yet final approval. Coordinator source review found a consent bug in the new web-next preflight decision ternary: an unavailable Keep could fall through to an available Retry. The UI agent corrected the branch structure and adding a capability-revocation regression that requires zero decision/replacement requests. Final browser and unit checks must include that correction.

Coordinator review found an additional browser coverage gap: the initial helper took screenshots at two viewports but did not execute each complete interaction independently at both sizes. The UI agent parameterized fresh scenario runs by surface and viewport; screenshot count alone is not accepted as the 28-case interaction matrix. Unknown-version coverage must also explicitly exclude generic Retry, not only Repair and Keep.

### Independently verified UI checkpoint

At `5ec89f48`, the coordinator independently ran both complete browser files (`generation-review.e2e.test.ts` and `generation-integrity-diagnostics.e2e.test.ts`) on separate local Vite ports: **99 passed, one skipped, exit 0** in 50.9 seconds. The skipped existing case requires the explicitly selected optional Web Awesome build. Source under apps, contracts, client-core and e2e matched the commit before and after this run; concurrent backend-only edits were not exercised by mocked browser APIs. All seven new scenarios now execute independently on each surface and viewport, plus four revoked-Keep regressions. This is browser behavior evidence, not a live API or provider result.

The coordinator also ran the four affected UI/workflow unit files from an immutable archive: **96/96 passed**. Representative final mobile and desktop screenshots were visually inspected: future reviews expose refresh guidance without a review Retry, and repair disclosure distinguishes unchanged narration from full replacement. Verification-generated image rewrites were restored to the committed synthetic artifacts. The later independent UI review is recorded below; final integrated verification remains required after runtime completion.

### Combined provenance and recovery checkpoint

At immutable `833fb40b`, the coordinator independently passed **79/79 real PostgreSQL tests**: 67 continuity/recovery cases and 12 review persistence cases. This includes the applied-repair receipt scope correction from `1ecd8959`, concurrent decisions, policy/operation coverage and six crash boundaries. The original primary response and request remain distinct from the transformed draft. These tests use deterministic providers and isolated databases; they do not establish live-provider quality.

The complete immutable unit selection at that same checkpoint passed **306 files, 3,854 tests**, with one existing platform-conditional secure-filesystem test skipped and exit 0. The dropped-notification timing case passed at 15,041 ms. The initial Docker attempt was denied access to the daemon; the authorized isolated-container run supplied the reported results.

The independent UI reviewer approved the scoped `5ec89f48` UI changes without actionable findings, including explicit action branches and inert future versions. This is scoped review approval, not final integrated approval. Extension binding, a second repair after explicit Retry, the remaining rejected-write matrix, and final full checks remain tracked by the acceptance checklist.
