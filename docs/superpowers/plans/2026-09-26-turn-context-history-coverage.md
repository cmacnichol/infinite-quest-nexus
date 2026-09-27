# Turn Context History Coverage Implementation Plan

> **For agentic workers:** Implement task-by-task using the execution workflow authorized by the user. Steps use checkbox syntax. Implementation is authorized with Terra and Luna subagents. Deployment and live-provider calls remain outside scope.

**Goal:** Increase the accepted story evidence available to the next turn while preserving frozen requests, authoritative state, campaign isolation, and writer/reviewer budget limits.

**Architecture:** Introduce frozen context protocol `current-continuity-v5`. Capture scoped authority, reserve bounded history layers against actual serialized writer and reviewer requests, and exclude only guaranteed-sent sources before retrieval. Keep historical readers unchanged and enable v5 only after compatibility and lifecycle verification.

**Tech Stack:** TypeScript ESM, Zod, PostgreSQL + pgvector, Vitest, repository-pinned pnpm.

**Spec:** [Turn-generation context review](../../review/turn-generation-context-review-2026-09-26.md), findings F1–F9. Its production observations are dated 2026-09-26 and have not been refreshed in this review.

**Review baseline:** `bb360620`, reviewed 2026-09-27. Neither plan nor spec existed in this worktree; both were copied from `C:/Git/InfiniteQuest`. That checkout was left unchanged. PR #168 is already merged via `f3b9f4f5`; PR #170 subsequently changed reviewer budgeting. Use current symbols rather than the original plan's line numbers.

## Review findings and decisions

| Priority | Original plan issue | Correction |
|---|---|---|
| High | Proposed planner argument 15 now collides with `reviewInputLimit`. | Append protocol as argument 16; test a reviewer smaller than the writer (Tasks 2, 5). |
| High | All captured recents are excluded before knowing which fit verbatim. | Exclude only reserved recents; omitted recents remain eligible for complete/excerpt retrieval (Tasks 3, 7). |
| High | Ledger/facts become mandatory at 40% of a rough allowance before complete authority/reviewer costs are measured. | Use measured residual capacity and whole-record trimming (Tasks 5, 6). |
| High | Directions are called accurate story-so-far history although requests may fail or merely say “Continue”. | Define an intent ledger; mark F3 partial and defer accepted-event synopses/chapter compaction. |
| High | One v4 planner golden cannot prove v3, retrieval, serialization, reclaim, and recovery compatibility. | Capture historical fixtures before runtime edits; test persisted requests end-to-end (Tasks 0, 2, 12). |
| High | Error messages are logged assuming provider errors never contain private text. | Log fixed classifications only (Task 1). |
| High | Directly promoting derived fact rows can bypass correction/source-ID integrity. | Verify scoped source/content identity before granting supersession authority (Task 6). |
| Medium | Multiplying all pools by four reaches 256,000 candidate-pool records at 4m; ledger reads are unbounded. | Bound SQL reads, measure maximum-budget cost, expose limits (Tasks 4–6, 12). |
| Medium | Planner deduplication can drop unseen facts because their source turn is sent. | Dedupe narration by turn and facts by verified ID in v5 (Tasks 3, 6). |
| Medium | Window changes lack commit, Keep, replacement, checkpoint, and rollback coverage. | Audit all readers and full lifecycle (Tasks 7, 11, 12). |
| Medium | Fixed 4× parent cap can still bind before tokens; layer order is not global chronology. | Report guards honestly and test actual sent evidence/order (Tasks 4, 8, 10). |
| Medium | Obsolete branch commands, blanket failure waivers, invented co-author trailers and premature “addressed” status. | Rebaseline, use actual authorship, and claim completion only after verification. |

## Global constraints

- Preserve legacy/v3/v4 bytes **for identical frozen inputs and captured sources**. Protocols do not make mutable retrieval results immutable. Resume saved requests/checkpoints using existing integrity rules; never rebuild from current defaults or update goldens to conceal regressions.
- Gate new history behavior with `isHistoryCoverageContextProtocol`. Absence retains old behavior; unknown protocols fail validation. Enable v5 only in Task 11; no mid-plan deployment. Changing v5 semantics/constants after production jobs exist needs a new version.
- Preserve owner, campaign, world-version, operation and base-turn boundaries. Replacement of turn N uses base N−1 and cannot see the replaced turn N.
- Accepted narration and complete corrected state outrank intent/derived memory. Preserve intentional empty corrections. Authority reads must not repair indexes or invent fact IDs.
- Read the [scene-context review note](../../architecture/scene-context-mechanics-review.md); it grants no relaxation of mechanics separation. New fiction evidence excludes mechanics, private findings, rejected drafts, scratchpads and foreign-campaign content.
- No production edits, deployment, live generation or paid backfill without separate authorization. Optional cast discovery/illustration failures remain independent of Story acceptance.
- Synthetic fixtures only. Diagnostics allow fixed enums, IDs, counts, hashes and token estimates, never arbitrary error strings, story text, credentials or provider responses.
- Reproduce baseline failures rather than accepting old “known/flaky” exemptions. Distinguish unit, PostgreSQL, browser, deterministic-provider and live-provider evidence; report passed/failed/skipped with reasons.
- Use repository-pinned pnpm; commands use `corepack pnpm`. Preserve user changes, stage exact files and do not add invented co-author identities.
- Review tests for each changed file and follow the [test matrix](../../workflows/testing.md). RED precedes production edits; GREEN follows them. The user authorized implementation on 2026-09-27; deployment remains excluded.

## Scope and review focus

The **base turn** supplies `currentScene`. A **captured recent window** contains up to 11 earlier effective turns for v5 r2/r3; capture does not imply inclusion. The **reserved recent window** is the contiguous newest subset guaranteed to fit and remain in the final request. r1 retains its one-turn policy.

`storyLedger` is a chronological **intent ledger**, not an accepted-event synopsis. `protectedFacts` contains selected complete verified active facts, not all facts. Upstream allowances are selection heuristics; final serialized writer/reviewer budgets remain decisive.

F3's event synopsis ledger and chapter compaction are explicitly **deferred**. This increment adds no generation calls or output-schema field. If complete event coverage is required for release, design that source-linked synopsis workflow first; do not claim F3 resolved by direction excerpts.

Required edge cases:

1. Oversized recent narration cannot fit verbatim but a verified excerpt remains retrievable (Tasks 3, 7).
2. Large authority or smaller reviewer leaves little headroom: omit history without clipping authority or overflowing transport (Tasks 5, 6).
3. State correction clears facts or a turn is replaced: no retired/future fact reappears (Tasks 6, 7).
4. Restart, lease expiry, Keep and historical replay preserve request/candidate identity without another generation call (Tasks 2, 7, 12).
5. Long campaigns, missing indexes, “Continue” inputs and hostile text produce honest omissions and no leakage (Tasks 4–6, 9, 10).

## File map and shared interfaces

| Files | Responsibility | Tasks |
|---|---|---|
| `services/runtime/src/generation-executor-adapter.ts` | Cast admission, frozen serializer/reviewer wiring, visible fact IDs | 1–3, 6, 10 |
| `packages/contracts/src/story-prompt.ts`, `packages/contracts/src/story-memory-policy.ts` | v5 literal, gate, constants, snapshot schema | 2 |
| `packages/database/src/story-memory-policy-repository.ts` | New-job default only | 11 |
| `packages/domain/src/chronicle-diversity.ts`, `packages/database/src/chronicle-context-repository.ts` | Exclusions, token-aware selection, query tail, fallback/diagnostics | 3, 4, 9, 10 |
| `packages/database/src/chronicle-generation-context.ts`, `packages/application/src/memory/types.ts` | Scoped capture, bounded reads, reservation/retrieval seam | 3, 5–7 |
| `packages/domain/src/story-history-ledger.ts`, `packages/domain/src/story-history-facts.ts` (new) | Pure intent and complete-fact selection | 5, 6 |
| `packages/database/src/campaign-continuity-repository.ts` | Reuse/extend fact-source verification | 6 |
| `packages/database/src/generation-authority.ts`, `packages/database/src/generation-repository.ts`, `packages/database/src/generation-execution-repository.ts` | Recent identity throughout job lifecycle | 7 |
| `packages/application/src/memory/generation-context.ts` | Strict private schemas and evidence | 2, 5–7, 10 |
| `services/runtime/src/generation-context-planner.ts` | Exact reservations, final order, budgets and manifest | 2–8, 10 |
| `packages/story-engine/src/prompt.ts`, `packages/domain/src/chronicle-query-plan.ts` | Intent instruction and scene-tail helper | 5, 8, 9 |
| `docs/architecture/0040-history-coverage-context.md` (new if number free), `docs/architecture/story-context-integrity.md` | Decision, guarantees, rollout/rollback | 11 |

`HISTORY_COVERAGE_POLICY`: `recentWindowTurns: 11`, `ledgerBudgetShare: 0.25`, `protectedFactBudgetShare: 0.15`, `ledgerDirectionCharacters: 480`, `parentTokenMultiplier: 1.5`, `parentCountMultiplier: 4`, `sceneHintCharacters: 1000`. Shares use **measured residual headroom**, not total allowance. Finalize additional safety bounds before v5 enablement.

Planner signature: retain argument 13 `serializeStoryRequest`, 14 `reviewInputTokens`, 15 `reviewInputLimit`; append argument 16 `contextProtocol?: string`. Use valid typed fixtures with unequal writer/reviewer limits; avoid `any`/`as never` masking signature/schema errors.

## Task 0: Current baseline and review inputs

**Files:** plan/spec; new synthetic `tests/fixtures/history-coverage/`; `tests/unit/generation-context-planner.test.ts`.

- [x] Inspect status, HEAD, branch and instructions. Reuse this worktree; create `codex/turn-context-history` here when implementing if needed. Do not switch the main checkout to the obsolete remediation branch.
- [x] Check copied documents for private prose/secrets; retain the report as dated evidence.
- [x] Record `corepack pnpm --version`, `corepack pnpm check`, `corepack pnpm test:unit`, full logs and exit codes. Classify exact baseline failures, not counts alone.
- [x] **Before Task 1**, capture wire-body/manifest goldens on unchanged production code: legacy, v3 r1/r2/r3, v4 r2/r3, applicable cast states, direct/frozen-route serializers, review off/observe/enforce. Use valid deterministic UUIDs/schemas.
- [x] Pin PR #170 behavior with reviewer smaller than writer. Save source commit, inputs, expected bytes/hash; rerun to confirm PASS. Commit planning/baseline artifacts when implementing; no runtime edits yet.

## Task 1: F4 — Cast admission and safe errors

**Files/tests:** executor adapter; `tests/unit/generation-executor-adapter.test.ts`; `tests/integration/campaign-cast-generation.integration.test.ts`, `tests/integration/campaign-cast-discovery.integration.test.ts`.

**Interfaces:** `castDiscoveryAdmissionExecution(job, provider, loadTextExecution): Promise<GenerationTextProvider>` with existing collaborator types; `castAdmissionFailureReason(error: unknown): "invalid_execution_revision" | "provider_unavailable" | "unexpected_error"`, mapped only from recognized typed codes.

- [x] RED: route-basis descriptor lacks revisions; load owner-scoped live execution. Non-route-basis job reuses valid provider. Match manual cast-scan requested-model handling; native presets retain native routing.
- [x] RED: persisted ready/unavailable admissions are reused; errors containing synthetic secrets/story canaries yield fixed codes only. Assert Story commit and single independent discovery enqueue despite preparation/illustration failures.
- [x] Run `corepack pnpm vitest run tests/unit/generation-executor-adapter.test.ts -t "cast|discovery admission"`; then implement resolution only for new admission, retaining frozen Story route.
- [x] GREEN: units and both PostgreSQL suites; commit exact files. Backfill remains operator-only. Discovery affects future cast snapshots; claim only already-captured Story requests unchanged.

## Task 2: Add v5 readers without enablement

**Files/tests:** contracts, schemas, planner/executor; `tests/unit/story-memory-policy.test.ts`, `tests/unit/generation-context-contracts.test.ts`, `tests/unit/generation-context-planner.test.ts`; `tests/integration/story-memory-compatibility.integration.test.ts`.

**Interfaces:** export `HISTORY_STORY_MEMORY_CONTEXT_POLICY_VERSION = "current-continuity-v5"`, `HISTORY_COVERAGE_POLICY`, `isHistoryCoverageContextProtocol(value: unknown): boolean`; append planner argument 16.

- [x] RED: v5 requires matching cast flag/prompt protocol; reject unknown/mismatched protocols. Old snapshots gain no defaults. Test executor argument wiring with a smaller reviewer limit.
- [x] Run focused suites; implement literal, schema, exports, gate and wiring. Leave new snapshot default at v4.
- [x] GREEN: units, Task 0 goldens, `corepack pnpm check`. Old optional-field isolation will be tested when Tasks 5–7 introduce those fields; current frozen goldens stay unchanged.
- [x] PostgreSQL: queued historical jobs retain captured policy/protocol across restart and changed live defaults, then make one initial primary call. Prepared checkpoints successfully resume with an unchanged provider and retain request hash without another primary call; incompatible provider changes remain fenced. Use the composed continuity-review suite where its recovery fixture supplies this boundary. Commit readers separately from enablement.

## Task 3: F2 — Exclude guaranteed sources without losing fallback

**Files/tests:** planner/executor, authority/retrieval seams, diversity, memory types; `tests/unit/chronicle-diversity.test.ts`, planner units; `tests/integration/chronicle-historical-fact-pool.integration.test.ts`, `tests/integration/chronicle-chunk-retrieval.integration.test.ts`.

**Interfaces:** `GenerationHistoryReservation = Readonly<{ recentTurnIds: readonly string[]; protectedFactIds: readonly string[] }>`; retrieval `generationExclusions?: GenerationHistoryReservation`; selector `excludedParentTurnIds?`, `excludedCanonicalFactIds?` readonly string arrays.

- [ ] RED: capture 1–11, fit 10–11; exclude only 10–11. Verified excerpt from 9 remains selectable. A recent gap stops verbatim selection, not all older retrieval.
- [ ] RED: facts from recent/base turns survive unless their IDs are sent. Multi-fact parent with excluded and unseen facts cannot be dropped wholesale; use individually verified facts or suppress only fully covered parents.
- [ ] RED: chunked, lexical-only, semantic-unavailable and index-unready paths obey exclusions; old protocols retain ordering/shape. High-ranked duplicates do not starve older-source replenishment.
- [ ] Run tests; introduce a v5 authority-reservation phase before retrieval using final serializers/reviewer estimator/quotas. Reserve cast/history/recents without Chronicle candidates, pass actual IDs, retain reservation through final planning. Tasks 5–7 extend it.
- [ ] Final planning must retain reserved sources or recompute exclusions/selection; never silently drop a source whose alternative was excluded. If exact pre-reservation cannot be shared, retain narration candidates until final selection rather than approximate captured-ID exclusion.
- [ ] Dedupe narration by turn, facts by verified ID. Apply exclusions before upstream rank-family limits where feasible; test replenishment, not only absence.
- [ ] GREEN: focused units/PostgreSQL and old goldens; commit.

## Task 4: F1 — Token-aware selection with observable guards

**Files/tests:** diversity/retrieval modules and `ChronicleProductionRankFusionProfile` declaration if needed; diversity units; `tests/integration/chronicle-retrieval-evaluation.integration.test.ts`, `tests/integration/chronicle-retrieval-observability.integration.test.ts`.

**Interfaces:** `maximumParentTokens?: number`; `chronicleParentTokens(content: string): number`; `generationChronicleRetrievalLimits(budget, options?: { historyCoverage?: boolean })`. Diagnostics: limits, selected estimates, unique skips, `stopReason: "parent_limit" | "token_limit" | "diversity_limit" | "candidate_pool_limit" | "exhausted"`.

- [ ] RED: skip oversized parent, fit later small one; exact boundary, zero/invalid budget and empty pool terminate. Old diagnostics unchanged; exact cap with no remaining candidates reports exhausted.
- [ ] RED: fact-dense fixture supplies more distinct accepted turns/facts than v4. If new count guard still binds, report it rather than claiming tokens alone bind.
- [ ] RED: complete narration exceeds allowance but certified excerpt fits final request; retain an excerpt-capable candidate path. Facts stay whole. Separate upstream estimates from actually sent tokens: estimate the usable expanded certified projection, while allowing final planning to choose the complete parent when it fits. Preserve valid narration sibling spans when a parent is ranked by its action chunk.
- [ ] Implement 1.5× allowance/4× parent guard only for v5, deterministic diversity/per-turn limits, unique skip counts and diversity stop reason.
- [ ] Do not blindly multiply all SQL pools. Measure bounded expansion at 32k/128k/1m/4m; add replenishment only if existing pools starve selection, with fixed observable ceiling recorded before v5 enablement.
- [ ] GREEN: units/retrieval suites and synthetic 300-/2,000-turn comparisons. Record SQL rows/count, runtime, peak pool, selected sources and final tokens; keep public-preview limits unchanged. Commit with limitations.

## Task 5: F3 partial — Intent ledger and measured reservation

**Files/tests:** new ledger module, loader/types/schemas, planner, Story prompt; new `tests/unit/story-history-ledger.test.ts`; planner/contract units; new `tests/integration/history-coverage-context.integration.test.ts`.

**Interfaces:** `StoryLedgerSourceTurn = Readonly<{ turnId: string; turnNumber: number; inputMode: "action" | "scene"; action: string }>`; `StoryLedgerEntry` replaces `action` with `direction`. `StoryLedger = Readonly<{ version: "story-ledger-v1"; entries: readonly StoryLedgerEntry[]; omittedThroughTurn: number | null }>`; `ledgerDirectionExcerpt(text: string, maximumCharacters: number): string`; `selectStoryLedger(turns: readonly StoryLedgerSourceTurn[], options: { budgetTokens: number; directionCharacters: number }): StoryLedger`. Authority gains optional `storyLedger`; evidence group `ledger` retains semantic role `player_intent`.

- [ ] RED: chronology, shuffled input, empty/no-budget, huge/whitespace/mechanics-only input, Unicode and “Continue”. Ellipsis counts inside 480 characters. Derive boundary budgets from exact serialization, not approximate comments or changing tests to match implementation.
- [ ] RED: requested action fails in narration; ledger remains intent, cannot establish an event/fact ID, and reviewer evidence preserves the distinction.
- [ ] RED: large override/current scene/world authority or smaller reviewer leaves little room. History never makes otherwise feasible mandatory authority overflow. Mandatory authority alone too large retains safe recovery before provider I/O.
- [ ] Run tests; load scoped `< baseTurnNumber` rows with bounded newest-first keyset paging in the authority transaction. Normalize before excerpting; do not load every full action. Order by turn number and ID; report older omissions and interior gaps honestly.
- [ ] Support >20,000-turn campaigns without parsing every turn through an array cap; cap selected records, page input and retain omission metadata. Test owner/campaign/world canaries, base 0/1, replacement cutoff and imported gaps.
- [ ] Shared reservation: measure complete mandatory authority and cast first. H is the nonnegative minimum of remaining context, writer and enabled-reviewer headroom including safety allowances. Fact/ledger ceilings are 15%/25% of the same H. Apply existing recent/world shares to remaining capacity after those reservations; unused shares remain available to optional history.
- [ ] Reserve newest whole ledger entries with exact serialized trial costs including wrappers/reviewer manifest. Stop at first non-fitting entry, preserve suffix/omission boundary. Remove reserved recent duplicates without claiming missing history is necessarily in the summary; do not grow reservation after retrieval.
- [ ] Add v5-only instruction: “storyLedger records earlier player intent, not proof of events. Accepted narration and current canonical state establish outcomes. Unlisted history is unknown; do not invent it.” Preserve old prompt bytes.
- [ ] Manifest pointers describe final sent intent projections, not full original input. Test pointer/hash, strict roundtrip, reviewer serialization and old-protocol absence.
- [ ] GREEN: pure/schema/planner and new PostgreSQL suite, including long-history row/lock bounds; commit. F3 remains partial.

## Task 6: F5 — Complete verified active facts

**Files/tests:** new facts module, source verifier, authority/types/schemas, planner/executor; new `tests/unit/story-history-facts.test.ts`; `tests/unit/campaign-continuity-repository.test.ts`, planner/executor units; new history-coverage integration, historical-fact integration and `tests/integration/story-continuity-review.integration.test.ts`.

**Interfaces:** `ProtectedFact = Readonly<{ id: string; turnNumber: number; content: string }>`; `selectProtectedFacts(facts: readonly ProtectedFact[], budgetTokens: number): Readonly<{ facts: readonly ProtectedFact[]; omittedCount: number }>`; optional authority `protectedFacts`, `protectedFactsOmitted`.

- [ ] RED: facts active at base only (`valid_from_turn <= base`, `valid_until_turn IS NULL OR > base`); exclude foreign/future/superseded/duplicate/invalid-source facts. Order ties by source turn, source fact index, then ID.
- [ ] RED: intentional empty/full correction removes obsolete facts; retained/correction IDs remain verified against scoped content. Imported/missing rows cannot gain invented IDs. Test index lag/rebuild without repairing authority on read.
- [ ] RED: oversized fact does not block later smaller facts. Select newest-first, skip non-fitting whole records, return chronology and exact omitted count; a fact subset need not be contiguous history.
- [ ] Run tests; implement bounded scoped paging with existing fact-source verification. Never truncate content while retaining UUID. If sanitization cannot preserve verified complete fiction-safe content, omit it and withhold supersession authority.
- [ ] Reserve facts within measured 15% ceiling and exact writer/reviewer costs; exclude only selected IDs. Omitted verified facts remain retrievable; unseen siblings of aggregate parents are not discarded.
- [ ] Extend `sentCanonicalFactIds`/manifest from actually sent complete facts only. Test included fact can be superseded while omitted/foreign/truncated fact cannot, including enforce review/repair.
- [ ] GREEN: focused units, history-coverage/historical-fact/continuity-review PostgreSQL and old goldens; commit.

## Task 7: F6 — Recent-window identity throughout lifecycle

**Files/tests:** generation authority/enqueue/execution repositories, loader/schemas/planner; `tests/unit/generation-authority.test.ts`, contract/planner units; `tests/integration/generation-recent-window.integration.test.ts`, `tests/integration/generation-execution-repository.integration.test.ts`, cast-generation integration.

**Interfaces:** optional `ResolveRequest.recentWindowTurns`; optional `GenerationBaseIdentityV3.recentWindowTurns`, inherited by V4. Absence retains 2. This protocol emits only 11 as the new value, paired with `recentWindowFingerprint`; reject unsupported/mismatched combinations.

- [ ] RED: v5 r2/r3 capture up to 11 effective earlier turns; v3/v4 retain two; r1 adds none. Early campaigns work. Preserve `recentTurnTarget === 3` layered eligibility without mutating frozen policy.
- [ ] RED: enqueue → execution → lease reclaim → commit use identical window/fingerprint; correction of oldest newly captured turn invalidates stale authority. Replacement N sees only through base N−1.
- [ ] Run tests; find every authority resolver, identity parser/comparison, commit/Keep/checkpoint and relevant portability reader. Propagate stored size on every revalidation path; choose new size only at enqueue from frozen protocol. Never infer from current defaults or backfill historical identities.
- [ ] Add cross-field validation, exact old field absence, contiguous newest-first reservation and ascending sent recents. Use reserved IDs for Task 3 exclusions; omitted recents remain optional evidence.
- [ ] GREEN: units/PostgreSQL covering retries, stale claimant rejection, expired leases, Keep and history corrections. Resume cannot regenerate a valid saved candidate. Commit.

## Task 8: F7 — Stable layer order ending with current scene

**Files/tests:** planner/prompt; planner units; `tests/integration/story-context-payload.integration.test.ts`.

**Interface:** v5 wire order: rules → world canon → character → cast → world references → current continuity → protected facts → intent ledger → Chronicle → recent turns → current scene. Account for every optional field before final scene.

- [ ] RED: inspect actual provider body, not just intermediate object keys. Test empty/nonempty layers, chronology within arrays, final current scene followed by current input.
- [ ] Implement one v5 projection shared by measurement, transport and manifest; retain old insertion order/bytes. Overlapping layers are not one globally chronological event timeline.
- [ ] GREEN: planner/payload integration, pointers/hashes and old goldens; commit. Live quality claims require separately authorized A/B evidence.

## Task 9: F8 — Tail scene query and source validation

**Files/tests:** query-plan helper/retrieval repository; `tests/unit/chronicle-query-plan.test.ts`; chunk-retrieval integration.

**Interface:** `sceneHintTail(content: string, maximumCharacters: number): string`, bounded normalized tail with safe word/Unicode boundaries; zero limit yields empty text.

- [ ] RED: empty/short/long/no-space/multibyte inputs, zero/invalid limits, disjoint opening/ending canaries; ending retained and length <= 1,000.
- [ ] RED: integrated v5 query uses effective base-turn ending including corrections; v4 keeps prefix. Missing/stale Chronicle cannot substitute a different turn as current; use captured base scene. No extra provider call merely to choose tail.
- [ ] Implement gated wiring after fiction sanitization; preserve cache query identity/fallback. GREEN unit/PostgreSQL comparison and old fixtures; commit. Live A/B remains separately authorized.

## Task 10: F9 — Strict diagnostics from final evidence

**Files/tests:** retrieval types/schema/loader, planner/executor; contract/planner units; observability and new history-coverage integration.

**Interface:** strict `HistoryCoverageDiagnostics`, not arbitrary `Record<string, string | number>`. Include configured limits; selected candidate estimates; unique skips/exclusions; fixed stop/fallback enums; ledger sent/omitted boundary; facts sent/omitted; recents captured/sent; final context/writer/reviewer tokens. Unavailable stages are null, not fabricated zeroes.

- [ ] RED: attempt metadata roundtrips v5 `contextDiagnostics.layers.history`; old shape unchanged. Unknown keys/arbitrary strings/private canaries fail validation.
- [ ] RED: counters match final manifest after dedupe, excerpts and trimming; distinguish selected candidates from sent evidence and estimates from final request totals.
- [ ] Explicitly project approved fields, never spread arbitrary retrieval/error objects. Audit strict persisted metadata schemas.
- [ ] GREEN: units/PostgreSQL roundtrip including lexical fallback/empty pool; commit. Provide content-free operator read-only query using verified current metadata path.

## Task 11: New-job enablement and rollback documentation

**Files/tests:** snapshot repository, new ADR 0040 if free, integrity doc/review status; `tests/integration/story-memory-enrollment.integration.test.ts`, compatibility and cast-generation integration.

- [ ] RED: new cast-enabled snapshots use v5; cast-disabled/legacy unchanged; old jobs retain protocol. Shape-compatible overrides need no re-acknowledgement ([ADR 0039](../../architecture/0039-implicit-prompt-override-acknowledgement.md)).
- [ ] Complete Tasks 1–10 and relevant Task 12 compatibility/budget/recovery/performance gates before flipping. Related failures block enablement, not automatically classified as old failures.
- [ ] Change new eligible snapshots only: no stored snapshot rewrite, reenrollment, override edit, backfill or accepted-turn mutation.
- [ ] Write ADR with residual budgets, intent/outcome distinction, fact verification, actual-source exclusions, guards, identity and measured limits. Mark F3 partial; other findings addressed only after tests pass, not because this plan exists.
- [ ] Document operator-approved rollout per [deployment runbook](../../runbooks/deployment.md): every potential claimant understands v5 before enqueue; prevent older workers claiming new v5 jobs in mixed deployments.
- [ ] Rollback stops new v5 production and drains/retains outstanding work on compatible readers before removing support. Never rewrite jobs as v4 or discard valid candidates. Compatible rollback can retain v5 readers while changing only enqueue default.
- [ ] GREEN: enrollment/compatibility/override/goldens and synthetic mixed-reader rollback tests; commit separately from readers. Do not deploy.

## Task 12: Full verification and handoff

- [ ] Run `corepack pnpm check`, `corepack pnpm test:unit`, `git diff --check`; retain full logs/exit codes and compare exact baseline failures. No tail-only failure reporting.
- [ ] Run affected PostgreSQL `chronicle-*`, `campaign-cast-*`, `story-continuity-*`, `generation-*`, `story-memory-*`, new history-coverage and story-context payload suites; include additional checks required by changed contracts.
- [ ] Verify Task 0 hashes unchanged and persisted request/checkpoint replay end-to-end. Report primary/review/repair calls separately; no new generation on Keep/resume.
- [ ] Compare synthetic v4/v5 at 32k/64k/128k/256k/1m/4m with provider-limited envelopes/smaller reviewer. Report distinct turns/facts, final headroom, omissions, SQL rows/count, runtime and lock duration. Include >20,000-turn loader stress; configured budget never overrides provider.
- [ ] Verify isolation, mechanics separation, visible supersession authority, replacement cutoff, corrected state, Keep integrity and independent image failure. Intent/excerpts do not equal complete event history.
- [ ] Review entire diff and exact-file staging. Independent agents only if authorized by chosen workflow. No UI change planned; if introduced, rendered-browser verification/screenshots become required.
- [ ] Hand off passed/failed/skipped evidence, deferred F3 synopsis/compaction, remaining finite guards, and operator-only deploy/backfill/A/B steps. No live quality claims from deterministic fixtures.

## Disposable PostgreSQL procedure (implementation only)

The original shared-DB credential failure is historical. Inspect `vitest.integration.config.ts`, `tests/integration/setup-isolated-database.ts`, and `scripts/ensure-test-database.mjs`. Tests create/drop isolated per-file databases; use only a disposable role/destination with necessary privileges.

For a task-owned container use a unique name/ownership label, available port bound to `127.0.0.1`, repository-compatible PostgreSQL/pgvector, generated temporary credential and `pg_isready`. Keep credentials out of commits/logs.

If global setup overrides supplied URL, create untracked root `vitest.integration.task.config.ts` importing standard config and overriding only `globalSetup: []`; preserve setup/isolation/timeouts/serial execution. Verify disposable target before running. PowerShell after provisioning:

```powershell
$env:TEST_DATABASE_URL = $taskDatabaseUrl
corepack pnpm vitest run --config vitest.integration.task.config.ts tests/integration/history-coverage-context.integration.test.ts
$testExitCode = $LASTEXITCODE
```

Retain full log/exit status. Restore prior environment variable in `finally`; remove only ownership-verified task-created container and exact temporary config. Never delete pre-existing containers by guessed names or commit temporary config/credentials.

## Progress log

- 2026-09-26: Original plan written against remediation branch; implementation not started.
- 2026-09-27: Reviewed against `bb360620`; corrected baseline/signature, privacy/exclusions, budgets, fact authority, lifecycle/rollback gaps and verification. F3 explicitly limited to intent-ledger increment. Documentation only; implementation/runtime tests not performed.

- 2026-09-27 implementation: Task 0 complete at cddfbf7b; 28 frozen-context goldens and TypeScript passed, independently reviewed. Baseline full static check passed; unit and PostgreSQL pre-existing failures recorded in execution ledger.
