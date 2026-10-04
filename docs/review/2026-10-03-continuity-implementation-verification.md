# Story continuity implementation verification

Branch: `codex/continuity-defects`

Pre-rebase implementation head with completed validation: `1ec9bb8f`

Rebased implementation head: `7aa6a99e` on `origin/main` at `b0b57dd9`
Post-rebase validation: unit, check, build, and browser diagnostics passed. Pre-rebase evidence is retained below.
Scope: the A1 and A2 repairs from the [story continuity audit](2026-10-03-story-continuity-audit.md).

This report records implementation and validation evidence separately from the historical audit. It does not claim that all integration files passed in one uninterrupted run.

## Implemented behavior

**A1 — retrieved fact recall.** In history-coverage planning, eligible canonical facts remain candidates until protected and current authority have actually been selected. Chronicle suppression then uses the selected authority and requires matching fact identity and verified content. Facts omitted by the protected allocation can therefore remain eligible for optional Chronicle transmission when they pass source validation and fit the remaining budget. Recent-turn suppression continues to remove duplicate narration evidence without discarding an independently retrieved fact. History-coverage v5 retains its existing early certified-excerpt selection; the reachable excerpt-retry path is covered on the layered non-history route. The final provider payload, sent fact IDs, and manifest agree in the recall regression.

**A2 — tracker identity and acceptance.** The shared `applyCampaignTrackerUpdates` projection resolves exact IDs first, then exact trimmed names, normalizes legacy aliases before merging, and preserves omitted fields. Ambiguous or conflicting identity throws a content-free `CampaignTrackerUpdateError`. Acceptance applies the projection to the transaction-locked append base or the saved pre-turn replacement base, so identity errors roll back before accepted authority changes. Raw candidate and provider evidence remains preserved. A recoverable `tracker_update_identity_invalid` job diagnostic maps to `repair_authority`; the existing Activity surface retains its generic `generation_failed` message.

For a pre-existing `location`/`Location` duplicate pair, name-only updates keep the legacy tie-break and target the tracker whose ID equals the display name. Both entries remain in current state and subsequent fiction-safe tracker context. This preserves compatibility; it does not resolve the conflicting values.

## Scope and compatibility constraints

- Only A1 fact selection and A2 tracker identity/acceptance were implemented. Existing feature flags and quotas remain unchanged. There is no automatic merge or deletion of historical duplicate trackers.
- No prompt wording or protocol version, provider-output schema, database schema, migration, dependency, secret, deployment setting, provider routing or retry policy, or illustration timing changed. The only contracts change is the `tracker_update_identity_invalid: "repair_authority"` diagnostic-action mapping; it adds no model-output or prompt field. A1 intentionally changes which verified evidence is selected into a provider request.
- Accepted turns and raw provider/candidate evidence remain unchanged by projection. No automatic repair of historical accepted state is included.
- The changes do not resolve the open mechanics-routing review recorded in `docs/architecture/scene-context-mechanics-review.md`.

Sol reviewed each implementation task. Tasks 1 through 5 received spec and quality approval after their recorded corrections. Final whole-branch review approved the implementation with 0 critical, 0 important, and 1 nonblocking P3 advisory. The advisory is to strengthen `activity-generation.integration.test.ts` by seeding tracker-value canaries before asserting their absence in the Activity payload. That test strengthening is deferred. Task 5's tracker canaries verify the prompt-projection boundary; they do not prove the separate Activity boundary. The exact generic diagnostic assertion and existing strict Activity projection checks support the nonblocking verdict.

## Recorded implementation rulings

- **Dedicated test database authentication:** temporarily align the idle dedicated integration-test role with its container credential, keep the original authentication backup private, then restore the original role after all test clients finish. This used a disposable test database, not campaign or production data. Cost if this ruling were wrong: a later test run could need reconnection. The controller confirmed restoration after testing, privately verified it, and removed the private backup and task-created environment file. Future database runs need valid dedicated test authentication configured again.
- **v5 excerpt coverage:** keep history-coverage v5 packing unchanged and describe its case as early certified-excerpt selection; prove the reachable retry on the layered non-history route. v5 packing returns no omitted blocks for that retry loop. Cost if this ruling were wrong: a future v5 retry feature would need its own coverage; adding a retry path here would change runtime behavior beyond this repair.
- **Task 2 existing coverage:** reuse existing meaningful isolation, source-validation, and budget tests where they already assert the requirements, document their exact test names and fresh results, and add only the composed recall/replay case needed to close the gap. Reused cases include `composes the PostgreSQL ledger loader through the exact planner manifest and reviewer serializer`, `measures one captured authority through reservation, retrieval, and final serializer planning at every supported envelope`, `withholds foreign, retired, future, mismatched, imported, and missing projection candidates without repairing rows`, `suppresses stale pre-frontier rows after an empty correction while retaining a later accepted fact without repairing projection`, and the `unsupplied structured supersession` case of `rejects %s without mutating accepted authority`. Cost if this ruling were wrong: a missing requirement would remain uncovered; Sol's requirement mapping and review were the gate for identifying and fixing such gaps before Task 2 approval.

## Verification evidence

| Area | Result | Evidence and limits |
| --- | --- | --- |
| Focused unit tests | **Passed** | Planner and boundary suites: 64/64. Tracker projection suites: 49/49. Acceptance/recovery suites: 168/168. |
| Full unit suite | **Passed after setup correction** | Aggregate: 376 files, 4,936 passed, 44 intentional Windows/platform skips, 0 unresolved failures. The initial full invocation exited 1 because a nested child resolved pnpm 11.15.1 instead of pinned 12.4.1; the five blocked web-build tests passed in a targeted rerun after using a process-local pnpm 12.4.1 shim. This is not a claim that the initial invocation exited 0. |
| Focused PostgreSQL integration | **Passed** | Task 2 files: history coverage 6/6; protected facts 10/10; historical fact pool 8 passed, 1 optional benchmark skipped; continuity remediation 8/8. Task 4: generation 57/57 and Activity generation 14/14. Task 5: continuity review 113/113, context payload 25 passed/6 skipped, story-only generation 17/17; the saved-Keep reclaim case also passed in isolation after its final lease assertion. The 3-pass/141-filtered test-name run is a filtered subset, not suite completeness. |
| Full PostgreSQL integration | **All files attempted; initial aggregate had 3 failures** | Across the initial runner and sequential resume, all 128 files ran once: 116 passed files, 3 failed files, 9 skipped files; 1,565 tests passed, 3 failed, and 199 skipped. The initial failures were Activity illustration (claim returned no job ID), authoring jobs (worker recovery completed 0 stages instead of 4), and secure-storage repository (`archive_unavailable`, 9/10). Unchanged clean full-file reruns passed all three affected files (26/26, 4/4, 10/10). Distinct latest outcomes are 119 passing files, 9 skipped, 1,568 passed tests, 199 skipped, and 0 currently reproduced failures. The original three failures remain unexplained; the full integration sequence did not exit 0 uninterrupted. |
| Repository check | **Passed** | `pnpm check` passed repository boundary and data-safety checks, TypeScript, and client syntax checks. |
| Build | **Passed** | `pnpm build` passed package, runtime, legacy client, and replacement client builds. Vite emitted its nonfatal large-chunk warning for the replacement client. |
| Browser diagnostics | **Passed** | `generation-integrity-diagnostics.e2e.test.ts`: 54/54 passed with process-scoped `NODE_OPTIONS=--import=tsx`. Both Story surfaces rendered the safe recovery message at desktop and mobile sizes; the recovery action offers discard and no retry. This verifies presentation and interaction behavior, not live-model quality. |
| Final pre-rebase typecheck and `git diff --check` | **Passed** | Root TypeScript check and final whitespace check passed on `1ec9bb8f`. |
| Live provider, deployment, CI | **Not run** | No live-provider narrative-quality, deployment, or CI claim is made. |

The full integration failures were followed by focused reruns with no source or test edits. Those reruns are useful passing evidence, but they do not explain or erase the failures in the combined run. The 199 PostgreSQL skips were 192 Linux platform/archive gates, 6 opt-in known-failure baselines, and 1 opt-in historical-fact benchmark. The 44 unit skips were Windows/platform-specific. The runs spanned 2026-10-03 local time and 2026-10-04 UTC.

## Browser screenshots

The screenshots show the safe tracker-identity recovery presentation on both Story surfaces at desktop and mobile viewport widths:

- Legacy Story: [1440 px](assets/generation-integrity-diagnostics/legacy-tracker_identity-1440.png), [390 px](assets/generation-integrity-diagnostics/legacy-tracker_identity-390.png)
- Web Next Story: [1440 px](assets/generation-integrity-diagnostics/web-next-tracker_identity-1440.png), [390 px](assets/generation-integrity-diagnostics/web-next-tracker_identity-390.png)

## Pre-rebase independent review (2026-10-03, Claude Code)

A second review of `origin/main...ac242a75` (base `1374688c`) found no defects in A1 or A2. Both repairs do what the audit required. This review re-ran the focused unit suites only. The PostgreSQL and browser results above come from the implementation record and were not re-run, because the dedicated test-database authentication had already been restored.

### A1 — retrieved fact recall

| Check | Finding |
| --- | --- |
| Fix location | In history coverage, canonical-fact candidates survive the early filter. They are dropped later only when the same fact ID *and* exact content appear in the selected `protected-fact:` / `current-fact:` blocks. Fact-specific latest-turn and recent-turn exclusions are limited to history coverage; non-history behavior is unchanged. |
| Production retrieval path | The database loader's `generationExclusions.protectedFactIds` comes from the reservation plan's *selected* protected facts (`generation-executor-adapter.ts`, reservation construction), not from all captured facts. A fact left out of protected allocation therefore reaches the planner. |
| Current-continuity facts | These are serialized only when their `current-fact:` block is selected, so dropping duplicates based on selected blocks matches the wire payload. |
| Tests catch the defect | With the baseline planner temporarily swapped in, 5 new tests fail. They are the protected-allocation recall case, its control, the ID-only duplicate case, and the latest/selected-predecessor turn cases. All pass with the fix. |

### A2 — tracker identity

| Check | Finding |
| --- | --- |
| Single merge point | `mergedTrackers` is removed. `applyCampaignTrackerUpdates` is called only inside `commitAcceptedTurn`'s transaction, so a thrown identity error rolls back before any write. |
| Error handling | Both commit call sites (normal acceptance and saved-Keep resume) are inside the executor `try` whose typed `CampaignTrackerUpdateError` branch runs before the generic failure branch. That branch mirrors the existing recoverable-integrity branch and uses the lease-fenced `markRecoverable`. |
| Resolution policy | A direct probe of the helper matched the plan in every case: the audit Location example; the legacy `location`/`Location` tie-break; an ID-addressed `currentValue` alias; trimmed names; an ID equal to another tracker's name not being targeted; create-then-update in one batch; `-2` suffixes on ID collisions; `conflicting_identity` for an unknown ID with an existing name; explicit clearing; numeric coercion; unmodified inputs; the unchanged 200-tracker cap. |
| Contract scope | The only contracts change is the `tracker_update_identity_invalid: "repair_authority"` entry. |

### Evidence from this review

| Area | Result |
| --- | --- |
| Focused unit suites (planner, history facts/reservation, evidence spans, trackers, state editors, state contract, safe diagnostics, executor adapter, client-core workflow) | **Passed** 281/281, 11 files |
| Baseline red check (planner) | **Confirmed** 5 new tests fail on the `1374688c` planner |
| PostgreSQL integration, browser diagnostics, check, build | **Not re-run**; see the implementation evidence above |
| Upstream overlap | `origin/main` is 19 commits ahead of `ac242a75`; none touch the changed source files |

## Remaining items recorded at pre-rebase review

Deferred follow-ups. None of these block A1/A2 correctness; they are scheduled for later.

- **Activity privacy test (P3):** seed tracker names, values, nested private fields, and raw-error canaries in `activity-generation.integration.test.ts`, then assert those values are absent from the Activity payload. The current negative assertion has nothing seeded to find.
- **Unexplained integration failures:** diagnose the three all-files failures (Activity illustration, authoring jobs, secure-storage repository) and get one uninterrupted green full run. They lie outside the A1/A2 change set.
- **Test-database authentication:** configure valid dedicated integration-test authentication before the next PostgreSQL run.
- **Branch hygiene:** the branch has since been rebased onto `origin/main` at `b0b57dd9` (implementation head `7aa6a99e`). Post-rebase validation is complete; commit/push/PR remain pending.

Recorded for context:

- The pre-rebase whole-branch Sol review approved `1ec9bb8f` with 0 critical, 0 important, and 1 nonblocking P3 Activity privacy-test advisory.
- The dedicated integration-test authentication was restored after all clients finished, privately verified, and its backup and task-created environment file were removed. No credential or backup contents are reproduced here. Future database test runs need valid dedicated test authentication configured again.
- The three failures in the all-files PostgreSQL pass remain recorded even though unchanged isolated reruns passed; their causes remain unconfirmed, and there is no uninterrupted green full-suite claim.
- Existing duplicate tracker pairs remain untouched and can retain conflicting values in future prompt context until explicitly consolidated through the state editor.
- Pull-request publication is authorized and pending. CI, deployment, and live-provider verification have not been performed.

## Rebased publication validation (2026-10-03 local)

Fresh validation ran on tested checkout HEAD `48290981` (implementation commit `7aa6a99e`) over `origin/main` at `b0b57dd9`. These results are separate from the pre-rebase counts above.

| Area | Result | Evidence and limits |
| --- | --- | --- |
| Full unit suite | **Passed** | 376 files, 4,938 tests passed, 44 platform skips; exit 0. The count differs from the pre-rebase run after dependency updates. |
| Repository check | **Passed** | 2,098 repository boundary/data-safety candidates plus TypeScript and client syntax checks. |
| Build | **Passed** | Package, runtime, and client builds passed. Vite reported the main chunk at 843.44 kB with its nonfatal 500 kB threshold warning. |
| Browser diagnostics | **Passed** | Post-rebase `generation-integrity-diagnostics.e2e.test.ts`: 54/54 passed, 0 skipped. Sol verified the 173-entry screenshot manifest with 0 mismatches after restoring 43 generated screenshot rewrites; the four approved tracker-identity screenshots were retained unchanged. |
| PostgreSQL integration | **Not rerun** | The dedicated test authentication has been restored. The prior all-file aggregate and three unchanged focused reruns above remain pre-rebase evidence. |

The pull-request description is prepared. Commit, push, and pull-request creation are authorized and remain pending. No deployment or live-provider verification is claimed.
