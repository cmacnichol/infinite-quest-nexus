# Turn context history coverage implementation handoff

Implemented on `codex/turn-context-history`, from `bb3606207af71eb8b1f18e7406fdec77e375db41` through implementation head `16661d509a15fe21e71a90fce17505d2e2274f7c`. Terra and Luna implemented and independently reviewed the work. Documentation/cleanup commits follow that implementation head.

The [plan](../superpowers/plans/2026-09-26-turn-context-history-coverage.md), [ADR 0040](../architecture/0040-history-coverage-context.md), and [rollout runbook](../runbooks/story-memory-rollout.md) describe the resulting behavior and operator-controlled deployment. Nothing was pushed, deployed, backfilled, or sent to a live provider.

## Delivered behavior

New eligible campaign-cast jobs freeze `current-continuity-v5`. Historical legacy/v3/v4 jobs retain their captured protocol and requests. `HISTORY_COVERAGE_ENABLED=false` changes only future eligible enqueue to v4; rollback must retain compatible v5 readers for outstanding work. Existing saved overrides keep ADR 0039 compatibility.

V5 captures authoritative state once, reserves eleven prior verbatim turns where they fit, includes a bounded player-intent ledger and complete source-verified active facts, and retrieves optional Chronicle evidence with only actually reserved sources excluded. Writer and enabled-reviewer serialized requests determine fitting. The final layer order ends with current scene. Tail-scene retrieval and strict content-free diagnostics are versioned with v5. Cast admission failures remain independent of Story acceptance.

F3 remains **partial**: player intent is not accepted-event history. Accepted-event synopses and chapter compaction remain deferred. No synthetic test establishes improved live prose quality or a universal lease/performance guarantee.

## Verification and scope

Use repository-pinned `corepack pnpm` **12.4.1**. The final runtime/configuration tree passed `corepack pnpm check` and `corepack pnpm test:unit` at `bc1c2f63`: **365 files, 4,692 passed, 44 skipped**, terminal exit 0. The later `16661d50` changes only an integration fixture; its complete affected PostgreSQL file passed 47/47. Final diff checks passed.

At pre-enable head `8db873d6`, all **43 PostgreSQL files** passed as separate complete-file invocations: **737 tests passed, 22 skipped**. Two combined runners stopped without terminal summaries and are inconclusive, not passing evidence. Per-file execution retained the normal isolated-database setup and complete same-file lifecycle tests; it does not establish cross-file process interaction.

After the planner performance fix and default enablement, these affected complete PostgreSQL files were rerun:

| Suite | Passed | Skipped |
|---|---:|---:|
| Story memory enrollment | 14 | 0 |
| Story memory compatibility | 1 | 1 |
| Campaign cast generation | 9 | 0 |
| Story context payload | 23 | 6 |
| Generation budget growth | 5 | 0 |
| History coverage context | 6 | 0 |
| Generation execution repository | 47 | 0 |

The compatibility skip is Linux-only archive staging. The six payload skips are opt-in known-failure baseline probes, not passing regressions. The earlier 43-file run additionally skipped 14 secure generated-asset staging cases unsupported on this Windows host and one opt-in 1k/10k/100k historical-fact benchmark. Unit skips remain suite-defined skipped cases. Browser checks were not applicable to this backend-only change; live-provider and deployment checks were not performed.

The 28 literal legacy/v3/v4 request/manifest goldens remain unchanged. Focused coverage includes old queued/checkpoint/reclaim/Keep behavior, eleven-turn mutation fences, replacements, intentional empty corrections, retained fact provenance, optional source verification outside the protected-source window, mechanics exclusion, campaign isolation, and independent image failure.

The provider-cap executor regression exercises campaign budget 4m, provider cap 1m, persisted model cap 2m, and reviewer window 500k. It observes the real captured retrieval scope, serialized writer request, prepared JSON-schema reviewer request, margins, and accepted commit. A temporary mutation letting the persisted cap win produced RED; the mutation was reverted and the full executor file passed 97/97. No production validation was weakened to repair stale test fixtures.

Post-flip unit and PostgreSQL diagnostics fixtures initially failed because they omitted four required candidate counters. Test-only commits `bc1c2f63` and `16661d50` supplied them; the strict schema and hostile-field rejection remain unchanged.

### Reproduction

Use an explicitly disposable PostgreSQL database as documented in the plan and testing workflow. The session used a task-owned pgvector PostgreSQL container bound to loopback, never an application database. The verified task-owned container was removed after testing. Automatic approval review rejected deleting the scratch audit directory and temporary config, so they remain locally for inspection; the generated local environment file is not committed or exposed in this handoff.

For the provisioned disposable database, a temporary config inherited `vitest.integration.config.ts` and replaced only `test.globalSetup` with `[]`; `setup-isolated-database.ts`, serial file execution, and other settings remained intact. Set `TEST_DATABASE_URL` securely in the same process, then run each affected file:

```powershell
corepack pnpm exec vitest run --config vitest.integration.task.config.ts tests/integration/history-coverage-context.integration.test.ts
corepack pnpm check
corepack pnpm test:unit
git diff --check
```

The temporary config and generated environment helper are not product artifacts. The ordinary documented integration command can provision its database normally in a supported environment.

## Measured bounds and tradeoffs

| Layer | Bound | Coverage cost |
|---|---|---|
| Recent verbatim history | Up to eleven prior contiguous turns for v5 r2/r3; r1 none | Older or unsent turns require retrieval; historical absent-field behavior remains two |
| Intent source | 512 rows, four pages of 128; raw action 12,000 characters/48,000 UTF-8 bytes; projection 480 characters | Older/unread, oversized, filtered and missing directions are reported, not treated as outcomes |
| Protected facts | 512 candidates; 1,000,000 canonical-source JSON bytes; each complete fact at most 4,000 characters/16,000 bytes | Source/content failures are withheld; omitted verified facts can remain optional retrieval candidates |
| Protected fact fitting | Exact all-fit path, then at most 64 exact measurements | Older small facts can remain unexamined even if they could fit; counters expose this |
| Optional fact verification | At most 2,048 candidate IDs against captured authority | Independent of the 512 protected-source window; no read-time repair or invented IDs |
| Chronicle parents | 2,000 distinct input/output parents, 250 per turn; 1.5x token allowance and 4x parent selection allowance | Bounded pools may omit relevant lower-ranked evidence; upstream estimates are not final sent tokens |
| Final optional fitting | Exact all-fit path, deterministic binary prefix, at most eight exact tail probes | Partial-fit guard may leave fitting records unexamined; source/selected/omitted/guard/trial counters expose this |

Facts receive up to 15% and intent up to 25% of the **same original residual headroom**, after mandatory authority/cast. The existing zero campaign-allocation buffer remains; exact writer/reviewer requests retain their existing 20% plus 1,024-token safety allowances and output reserves. Campaign configuration never overrides a smaller effective provider or reviewer limit.

The composed authoritative PostgreSQL benchmark uses 512 ledger/fact sources and 1,950 seeded retrieval records. At 1m writer/500k reviewer, 1,751 loader candidates deduplicate to 512 final candidates; 131 are selected and 381 omitted/guard-excluded in nine exact batched trials. Recorded runs spent approximately 7.6–7.8 seconds in reservation and 9.17 seconds in final synchronous planning, separated by awaited database retrieval; total elapsed time was 23.29 seconds. Async retrieval wall time is not labeled synchronous blocking. At 4m writer/2m reviewer, 1,529 loader candidates deduplicate to 510 final candidates, all selected; maximum measured final blocking was about 2.42 seconds and total about 9.52 seconds.

A separate **non-authoritative synthetic planner** case covers 1,950 distinct IDs without turn deduplication. All fit at 4m, with zero omissions/guard hits/batched trials, in approximately 169 milliseconds. It establishes planner cost separately from source authority. These host-specific measurements are below the supported 15-second lease for the measured contiguous sections, not a guarantee across machines or every input shape.

## Review record

Tasks 0–12 and the baseline expectation repairs received scoped independent reviews. Final Terra whole-branch review covered `bb360620..16661d50`: **spec approved, standards approved, no remaining actionable findings**. It inspected the source, frozen identity boundaries, authority/exclusions, guards, rollout/rollback, and retained final verification. The final fixture repair had RED 46 passed/1 failed and GREEN 47/47 on the complete PostgreSQL file.

## Controller rulings, in order

The following exact ledger decisions preserve their rationale and cost if wrong.

- Ruling: Use gpt-5.6-terra for integration and review, gpt-6-luna for bounded work — explicit user model choice overrides skill preference for the most capable final reviewer — risk: difficult findings may need further parent adjudication.

- Ruling: Use PowerShell equivalents for skill artifact scripts because bundled Git bash cannot resolve basename/dirname — same plan-scoped artifacts and extraction — risk: extraction differences, verified nonempty per task.

- Ruling: Execute tasks 4–7 before Task 3's complete reservation/retrieval wiring — exact exclusion depends on their selected ledger/fact/recent contracts — cost if wrong: sequencing rework, not a changed product requirement.

- Ruling: Add a v5-only deferred candidate-read seam retaining the old loadGenerationContext wrapper — final RPG/event guidance and reviewer serialization become available only after authority capture — cost if wrong: broader port/test changes; it avoids approximate exclusions and duplicate provider embedding calls.

- Ruling: Correct two stale baseline test expectations in verification work, without production changes — Luna traced both to f69785f4 (full reviewer output reserve and imported campaign r3/off default) — cost if wrong: weakened regressions; preserve explicit oversized-request rejection and operational-state exclusion assertions.

- Ruling: Treat task test-file lists as intended coverage locations, permitting equivalent composed suites where the actual boundary exists — a missing file hunk is not itself a behavior gap; T17 has checkpoint/reclaim infrastructure while T19 covers archive restore — cost if wrong: coverage can become harder to discover; reports must map assertions to requirements.

- Ruling: Task 2 queued historical-job proof covers frozen v3/v4 policy/default isolation and one first dispatch; a queued unprepared job has no serialized provider request to hash — prepared checkpoints separately prove hash preservation and no second dispatch — cost if wrong: lifecycle evidence may be misread; require successful same-provider resume plus mutation fencing tests.

- Ruling: Bound v5 selector input as well as selected output, with a provisional2,000-parent input ceiling and unchanged SQL pools — selection rescans and similarity updates are quadratic and the4m SQL envelope is much larger — cost if wrong: relevant lower-ranked history may be omitted; require observable truncation and measured vector/database performance before accepting the guard.

- Ruling: Extend the new v5 stopReason enum with candidate_pool_limit — a truncated upstream input cannot truthfully report exhausted — cost if wrong: one more v5 diagnostic value to maintain; historical diagnostic shape remains unchanged.

- Ruling: Keep upstream verified-projection token costs as selection estimates, not a promise that the final planner will choose the excerpt — the plan explicitly makes upstream allowances heuristic and final serialized writer/reviewer limits decisive; forcing an excerpt would unnecessarily drop complete evidence that fits — cost if wrong: upstream estimates differ from sent tokens; name/document them clearly, compute the actual usable expanded projection, and test both economical whole-parent and excerpt outcomes.

- Ruling: Preserve the existing zero campaign-allocation buffer while measuring all existing writer/reviewer request safety allowances in v5 H — campaign context is an allocation limit, while provider uncertainty is already charged20%+1024 on each serialized request; adding another buffer would change the specified allocation without evidence — cost if wrong: no separate uncertainty margin on the campaign allocation, though provider caps retain their margins.

- Ruling: Split Task5 implementation into5A source/loader completion and5B exact reservation/manifest integration, followed by one combined independent review — implementer identified remaining load-bearing scope and correctly declined completion — cost if wrong: extra agent handoff, mitigated by explicit report and unchanged fullTask5 acceptance requirements.

- Ruling: Add strict optional storyLedger.coverage metadata (unreadThroughTurn, missingTurnCount, filteredDirectionCount, oversizedDirectionCount, loadedRows) and retain all safe entries within the512 source cap rather than pretrim at32k — omittedThroughTurn alone cannot distinguish unread prefix from internal gaps; provider budgets belong in final measured planning — cost if wrong: an additional v5 schema field and finite512-record coverage guard; require stress measurements and report guard explicitly.

- Ruling: Split Task6 into sourceverification/loader6A and exactplanner/executorsupersession6B with one combinedreview — Task5 showed combinedsource+budget scope exceeded a focused agentpass — cost if wrong: handoff overhead; fullTask6 requirements remain mandatory and are reviewed together.

- Ruling: Bound v5 protected-fact exact reservation work with a provisional64-measurement deterministic guard after exact whole-set/newest-run batching — measured1m partial selection remained25.71s even after immutablehashreuse, while supportedworkerleases canbe15s andheartbeat runs onthe blockedeventloop — cost if wrong: older smallfacts after the measurementguard may be omitted despite fitting; expose unexamined/limit-hit counts, retain512source/all-fitpath, neverexclude unsentIDs, and measurebeforefinalizing. No time-based limits, approximateacceptance, lowerleaseguarantees or silentcaps.

- Ruling: Assign optional Chronicle fact source-verification bypass to Task3 capture/deferred-retrieval integration, sharing Task6 materializers and bounded verifier — Luna confirmed active projection rows can revive correction-removed facts outside the protected layer; the v5 integration seam is the narrow boundary that must verify them — cost if wrong: Task3 gains verifier refactoring and regression scope; v5 cannot enable until stale candidates cannot regain prompt or supersession authority, while valid omitted facts remain retrievable.

- Ruling: Delegate remaining per-task implementation/review coordination to a Terra coordinator using fresh Terra/Luna workers, with root retaining final delivery oversight — remaining work is a long sequential pipeline and every brief, report, checkpoint and gate is durable in this ledger — cost if wrong: another handoff may miss a boundary; require coordinator to read ledger/globalconstraints, preserve review gates, and report exact final evidence rather than declare partial work complete.

- Ruling: Require persisted-candidate evidence for Task 7 lifecycle compatibility rather than treating a fresh queued payload as a checkpoint — Keep and reclaim execute from durable review state, so enqueue-only tests could miss frozen identity incompatibility — cost if wrong: additional focused PostgreSQL cases, while keeping the lifecycle boundary evidence truthful.

- Ruling: Optional Chronicle candidate authority must be verified against a captured frontier but cannot be limited to the protected-fact source window — a legitimate older candidate or sibling may remain outside the 512 protected source records — cost if wrong: bounded candidate materialization and additional PostgreSQL coverage; without it valid history would be silently withheld or stale projections could regain authority.

- Ruling: Treat the two broader Task 8 Story Direction choice-repair failures as unclassified until the planned test-fix diagnosis traces their primary-versus-repair request contract expectation — they are outside the v5 ordering hunk but were not part of the recorded baseline failures — cost if wrong: a narrow test correction or regression fix before Task 11; do not label the full file passed.

- Ruling: Run the final 43 PostgreSQL inventory as bounded isolated per-file invocations with a terminal log, explicit exit, and manifest entry for every file — two aggregate task-owned runners exited mid-suite without a terminal summary, while the harness is designed for per-file disposable-database isolation — cost if wrong: cross-file process interaction is not exercised, but each full same-file lifecycle remains covered; do not make another blind aggregate attempt.

- Ruling: The pre-enable performance gate must measure Task3's actual composed capture/reservation/deferred-retrieval/final-planning path at supported bounds; compact matrix or component timing cannot waive a synchronous event-loop lease risk — forced1,950-candidate high-budget planning exceeded a15s supported lease without terminal progress — cost if wrong: one focused real PostgreSQL serializer benchmark and a narrow planner correction, while avoiding a broad stress rerun or a universal wall-time claim. Record configured/effective writer/reviewer/residual retrieval budgets, full synchronous blocking phase and complete elapsed time separately.

- Ruling: Preserve v5 coverage with an exact whole-set all-fit fast path and deterministic exact batched fitting before any finite work guard — capping4m to a few optional records would regress F4 coverage — cost if wrong: a bounded partial-fit prefix/tail algorithm with explicit selected/unexamined/omitted/trial counters; no approximate acceptance, raised lease floor, unobserved truncation, or silent omission of fitting records. Preserve protected reservations, source validation, ordering/manifest truth, old protocol bytes, actual writer/reviewer margins, and the v4 default.

## Pre-enable PostgreSQL inventory at 8db873d6

All entries below exited 0. This is the pre-enable inventory, not a claim that all files were rerun after enablement.

| Complete integration file | Passed | Skipped |
|---|---:|---:|
| tests/integration/campaign-cast-backfill.integration.test.ts | 31 | 0 |
| tests/integration/campaign-cast-api.integration.test.ts | 8 | 0 |
| tests/integration/campaign-cast-generation.integration.test.ts | 9 | 0 |
| tests/integration/campaign-cast-discovery.integration.test.ts | 57 | 0 |
| tests/integration/campaign-cast-lifecycle.integration.test.ts | 9 | 0 |
| tests/integration/campaign-cast-portability.integration.test.ts | 8 | 0 |
| tests/integration/chronicle-chunk-repository.integration.test.ts | 9 | 0 |
| tests/integration/campaign-cast-repository.integration.test.ts | 19 | 0 |
| tests/integration/chronicle-completion-audit.integration.test.ts | 7 | 0 |
| tests/integration/chronicle-chunk-retrieval.integration.test.ts | 30 | 0 |
| tests/integration/chronicle-historical-fact-pool.integration.test.ts | 8 | 1 |
| tests/integration/chronicle-contract-matrix.integration.test.ts | 24 | 0 |
| tests/integration/chronicle-repository.integration.test.ts | 3 | 0 |
| tests/integration/chronicle-query-cache.integration.test.ts | 8 | 0 |
| tests/integration/chronicle-retrieval-evaluation.integration.test.ts | 3 | 0 |
| tests/integration/chronicle-retrieval-observability.integration.test.ts | 4 | 0 |
| tests/integration/chronicle-turn-immutability.integration.test.ts | 3 | 0 |
| tests/integration/generation-budget-growth.integration.test.ts | 5 | 0 |
| tests/integration/generation-execution-repository.integration.test.ts | 47 | 0 |
| tests/integration/generation-events.integration.test.ts | 5 | 0 |
| tests/integration/generation-recent-window.integration.test.ts | 10 | 0 |
| tests/integration/generation-repository.integration.test.ts | 48 | 0 |
| tests/integration/generation-response-contract-operations.integration.test.ts | 4 | 0 |
| tests/integration/generation-response-contract-failures.integration.test.ts | 49 | 0 |
| tests/integration/generation-response-contract-projection.integration.test.ts | 5 | 0 |
| tests/integration/generation-response-contract-workflow.integration.test.ts | 5 | 0 |
| tests/integration/generation-review.integration.test.ts | 14 | 0 |
| tests/integration/generation-response-contract.integration.test.ts | 23 | 0 |
| tests/integration/preset-generation-workflow.integration.test.ts | 5 | 0 |
| tests/integration/generation.integration.test.ts | 50 | 0 |
| tests/integration/history-protected-facts.integration.test.ts | 9 | 0 |
| tests/integration/history-coverage-context.integration.test.ts | 4 | 0 |
| tests/integration/image-pipeline.integration.test.ts | 25 | 14 |
| tests/integration/story-context-payload.integration.test.ts | 23 | 6 |
| tests/integration/story-continuity-remediation.integration.test.ts | 7 | 0 |
| tests/integration/story-continuity-evaluator.integration.test.ts | 1 | 0 |
| tests/integration/story-memory-compatibility.integration.test.ts | 1 | 1 |
| tests/integration/story-continuity-review.integration.test.ts | 113 | 0 |
| tests/integration/story-memory-enrollment.integration.test.ts | 14 | 0 |
| tests/integration/story-only-generation.integration.test.ts | 17 | 0 |
| tests/integration/world-generation-progress.integration.test.ts | 3 | 0 |
| tests/integration/world-generation-repository.integration.test.ts | 9 | 0 |
| tests/integration/task-14e3e8-private-parity.integration.test.ts | 1 | 0 |
