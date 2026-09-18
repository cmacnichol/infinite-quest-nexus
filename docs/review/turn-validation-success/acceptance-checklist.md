# Final acceptance checklist: phases 01–04

This is the coordinator's completion audit. Prior phase checks establish intermediate progress; all final claims refer to final implementation `d9ab9570db951f8d473d7ebcd24d4fc3529dfb34`. The PostgreSQL/browser checkpoint is `b6210ed4`; its only difference is two cleanup calls in an unrelated unit fixture, with identical production, integration, browser and configuration inputs. This explicit source-equivalence check carries those results forward; it is not a claim that the commands ran at a different SHA. An unchecked item is not achieved. The [verification matrix](verification-matrix.md) summarizes progress, while this checklist preserves the full gate granularity. No deployment, production retry/discard, live-provider experiment, or phase 05–06 implementation is authorized by this checklist.

## Earlier-phase regressions at the final SHA

- [x] **R01:** Metrics use the first primary observation; duplicate/reclaim/repair handling does not inflate the denominator; conflicting observations and missing evidence remain explicit.
- [x] **R02:** Report limits, UTC window, read-only transaction and cleanup, JSON/Markdown output, numerator/denominator, actual/configured model, frozen prompt identity, mode/review/context cohorts, and available build identity have tests.
- [x] **R03:** Safe failure diagnostics survive authorized cancel/discard/failure; historical absent fields decode; HTTP and SSE reveal only finite safe diagnostics.
- [x] **R04:** Actual serialized default/override/Action/Story Direction requests contain the new wire contract after creative instructions; old retry/resume text and hashes remain frozen.
- [x] **R05:** The planner's full decision/adversarial table, mixed shapes, no partial repair, content mass balance/order, exact protected values, shared UUID validation, mechanics checks before removal, and unchanged direct parser acceptance pass.
- [x] **R06:** Raw/inventory/protected/result hashes are deterministic and compatible across planner, checkpoint, adapter, database and resume. Narration equals its existing display representation; original raw narration is retained exactly.

## Wire, disclosure and decision

- [x] **W01:** Strict v1 and v2 schemas preserve historical Keep/Retry meaning, reject malformed known versions and extra fields, and support mixed historical journals.
- [x] **W02:** Future versions survive DB/API/client transport as inert markers; an old client receiving v2 follows its refresh path; new clients retain v1 behavior.
- [x] **W03:** List/poll/SSE/detail projections expose only finite fields, hash/count/static repair copy; no raw output, fact content/IDs, provider details or private state leaks.
- [x] **W04:** Repair capability requires an offered repair in an actionable pending review; authorized/applied/failed states do not re-advertise it. Invalid originals have no Keep; Retry remains distinct.
- [x] **W05:** Private plan/result hashes and source candidate/request/raw-reference/nullable-response bindings validate. Owner/campaign/world/base/provider/protocol bindings validate independently.
- [x] **W06:** Real PostgreSQL concurrent identical decisions create one transition/receipt; duplicate replay is idempotent; stale revision, foreign owner, wrong plan, and conflicting decision cause no mutation or queueing.

## Evidence, application and acceptance

- [x] **A01:** Exact producing-request evidence yields complete inventory; proven empty is distinct from missing evidence. Identical duplicate references may dedupe; conflicting contents, unavailable evidence and tampered requests do not offer repair.
- [x] **A02:** No current retrieval or current database facts substitute for original visibility. Original sent fact IDs remain unchanged. A browser-supplied transformed story cannot establish authority.
- [x] **A03:** Application recomputes the plan and checks source/request/plan/protected/result and all scope bindings before persisting an applied checkpoint. No provider call occurs to offer or apply repair.
- [x] **A04:** Original raw attempt/result/request and decision receipt remain durable. The repair event is deterministic and recorded once, without a fabricated provider attempt or token/cost entry.
- [x] **A05:** The composed real-PostgreSQL success sequence pauses with no accepted writes, accepts explicit repair with primary-call count still one, runs configured semantic review separately, then commits exactly once with correct state/facts and preserved narration.
- [x] **A06:** Strict parsing, mechanics validation and mode-specific choice checks remain active after repair. Missing/incomplete/ambiguous candidates stop safely.
- [x] **A07:** Stale campaign/base, world mismatch, changed narration correction, raw/request/plan tampering, foreign owner/provider fingerprint, unseen/inactive/foreign supersession all reject before canonical mutation.
- [x] **A08:** Rejected cases compare actual turn, campaign-state, canonical-fact and accepted Chronicle rows before/after, using distinct owners/campaigns.
- [x] **A09:** Applied provenance is recognized by both runtime resume and database payload loading/commit; typed story alone cannot authorize resume.
- [x] **A10:** Later semantic/event reviews retain v2 provenance and journal, bind original request plus transformed story, and permit only valid actions without silent rewrite.

## Required policy and operation cases

- [x] **P01:** Continuity off: ordinary acceptance path with no semantic call.
- [x] **P02:** Continuity observe: configured review runs and policy behavior is preserved.
- [x] **P03:** Continuity enforce: conflict after repair produces the normal next review, without waiver or another primary request.
- [x] **P04:** Action + append.
- [x] **P05:** Action + replace-latest.
- [x] **P06:** Story Direction + append.
- [x] **P07:** Story Direction + replace-latest.
- [x] **P08:** Extension checkpoint matches repaired main/request/result exactly or stops as incompatible; no unrelated extension graft.
- [x] **P09:** Illustration failure remains nonblocking and repaired metadata cannot enqueue duplicate illustrations; existing Chronicle failure durability remains intact.

## Crash and reclaim boundaries

Each row requires durable evidence of retained original output, no duplicate deterministic event, no extra primary request, no semantic calls beyond the existing durable allowance, and no second accepted turn.

- [x] **D01:** Before decision.
- [x] **D02:** After receipt.
- [x] **D03:** After applied repair checkpoint.
- [x] **D04:** After semantic-review checkpoint.
- [x] **D05:** Before commit.
- [x] **D06:** After commit acknowledgment loss.

## Both rendered clients

All seven scenarios must run on `/story` and `/app/story`, at desktop size and 390×844. Evidence must identify each surface/viewport, with synthetic screenshots under `docs/review/assets/turn-validation-success/`.

- [x] **U01:** Repair success.
- [x] **U02:** Stale revision: fetch/refresh, no automatic resubmission.
- [x] **U03:** Network uncertainty and reload: reconcile durable decision without duplicate submission.
- [x] **U04:** Unsupported version: inert refresh behavior.
- [x] **U05:** Ineligible `{}`: no repair or Keep.
- [x] **U06:** Full Retry: explicit replacement guidance and unchanged meaning.
- [x] **U07:** Continuity rejection after repair: ordinary follow-up review.
- [x] **U08:** Shared workflow tests prove fetch-current-before-submit, one matching receipt, disabled pending controls, preserved narration/candidate-hiding policy and no raw metadata preview.

## Legacy paths, combined checks and measurement

- [x] **F01:** Reference trace and route regressions prove zero automatic schema-repair calls while pending. Only unreachable dispatch is removed; historical decoding, audit, valid resume and fixtures remain. Runbook explains historical automatic versus current explicit repair.
- [x] **F02:** Fresh independent specification and code/durability reviews approve the complete integrated diff. Coordinator adjudicates every finding.
- [x] **F03:** Final SHA passes documented unit, isolated PostgreSQL integration, type/check, build, both named Playwright suites and diff checks. Failed/skipped/baseline cases have explicit dispositions, never pass labels.
- [x] **F04:** Final adapter evidence extraction/eligibility agrees with the independent historical replay, or each difference is explained and corrected. Report first-pass parsing, repair eligibility, strict validity and composed acceptance separately.
- [x] **F05:** Full diff contains only scoped source/docs/synthetic fixtures and no private data/secrets. Local links resolve. Phase handoffs, screenshots and final report match the immutable reviewed SHA.
- [x] **F06:** Final handoff states live success-rate improvement is unmeasured; documents v2-compatible rollback/in-flight-job handling without unsupported commands or restoring over newly accepted turns. Phases 05–06 and canary/deployment remain separately gated.

## Evidence index

An independent read-only audit at `511f8cc6` mapped the requirements below. This index identifies the relevant evidence used for the final requirement audit. The last tamper/ledger/snapshot additions landed in `5ce73866`; an independent refresh at `b6210ed4` found no remaining substantive coverage gap. Final execution results and skip/failure dispositions are in [the final report](final.md).

| Requirements | Evidence sources |
|---|---|
| R01–R03 | `generation-outcome-metrics.test.ts`, `report-turn-validation.test.ts`, review contracts and API/SSE units, real PostgreSQL execution/repository diagnostic preservation cases; Phase 01 handoff |
| R04 | `story-context-payload.integration.test.ts`, `story-memory-enrollment.integration.test.ts`, default/override/Story Direction prompt units; Phase 02 handoff |
| R05–R06 | `fact-format-repair.test.ts`, `fact-format-repair-adapter.test.ts`, parser and review contract tests; long-narration regression and 144-case serializer/hash comparison |
| W01–W04 | Review contract/projection units, `generation-review.integration.test.ts` future marker and plan-bound decision cases, both browser suites and shared workflow tests |
| W05–W06, A03, A07, A09 | Executor authorized-application tamper/provider tests; PostgreSQL review receipt races, coherent scope/applied-receipt tamper cases; execution-repository base/correction/supersession fences |
| A01–A02 | Frozen inventory adapter tests, pure planner visibility rules, retained-request replay/extractor comparison; no current retrieval substitutes for producing evidence |
| A04 | Application-ledger idempotency/conflicting-replay/history units plus composed PostgreSQL success/crash event counts and receipt/source binding |
| A05–A06, A08, A10 | `story-continuity-review.integration.test.ts` accepted-authority snapshots, strict/mode checks, later conflict and Keep, extension cases; execution-repository full rejected-state snapshots |
| P01–P09 | Continuity policy and Action/Story Direction × append/replace tables, matching/incompatible extension resume, optional illustration failure/no duplicate enqueue; existing Chronicle durability cases |
| D01–D06 | Six-row composed repair crash/reclaim table, including accepted-state equality and source/receipt/application/provider-call counts |
| U01–U08 | Seven fresh scenario runs × two surfaces × two viewports, four revoked-Keep regressions, workflow/controller/store units, 28 synthetic screenshots |
| F01 | Executor pending-review call-count and historical reclaim tests, deletion of unreachable dispatch only, deployment runbook historical/current distinction |
| F02–F06 | Independent review adjudications, final immutable run logs, unchanged extractor/hash identity or repeated replay, scope/link/data checks, final report and rollout handoff |

The reachable composed Retry case contains one actual repair of the replacement primary. Later retries after an applied repair belong to bounded downstream stages. Historical receipt selection and multi-entry application-history behavior are tested at their actual adapter/ledger boundaries rather than by inventing a second full-primary runtime transition.
