# Final acceptance checklist: phases 01–04

This is the coordinator's completion audit. Prior phase checks establish intermediate progress; all final claims must refer to one immutable integrated SHA. An unchecked item is not achieved. The [verification matrix](verification-matrix.md) summarizes progress, while this checklist preserves the full gate granularity. No deployment, production retry/discard, live-provider experiment, or phase 05–06 implementation is authorized by this checklist.

## Earlier-phase regressions at the final SHA

- [ ] **R01:** Metrics use the first primary observation; duplicate/reclaim/repair handling does not inflate the denominator; conflicting observations and missing evidence remain explicit.
- [ ] **R02:** Report limits, UTC window, read-only transaction and cleanup, JSON/Markdown output, numerator/denominator, actual/configured model, frozen prompt identity, mode/review/context cohorts, and available build identity have tests.
- [ ] **R03:** Safe failure diagnostics survive authorized cancel/discard/failure; historical absent fields decode; HTTP and SSE reveal only finite safe diagnostics.
- [ ] **R04:** Actual serialized default/override/Action/Story Direction requests contain the new wire contract after creative instructions; old retry/resume text and hashes remain frozen.
- [ ] **R05:** The planner's full decision/adversarial table, mixed shapes, no partial repair, content mass balance/order, exact protected values, shared UUID validation, mechanics checks before removal, and unchanged direct parser acceptance pass.
- [ ] **R06:** Raw/inventory/protected/result hashes are deterministic and compatible across planner, checkpoint, adapter, database and resume. Narration equals its existing display representation; original raw narration is retained exactly.

## Wire, disclosure and decision

- [ ] **W01:** Strict v1 and v2 schemas preserve historical Keep/Retry meaning, reject malformed known versions and extra fields, and support mixed historical journals.
- [ ] **W02:** Future versions survive DB/API/client transport as inert markers; an old client receiving v2 follows its refresh path; new clients retain v1 behavior.
- [ ] **W03:** List/poll/SSE/detail projections expose only finite fields, hash/count/static repair copy; no raw output, fact content/IDs, provider details or private state leaks.
- [ ] **W04:** Repair capability requires an offered repair in an actionable pending review; authorized/applied/failed states do not re-advertise it. Invalid originals have no Keep; Retry remains distinct.
- [ ] **W05:** Private plan/result hashes and source candidate/request/raw-reference/nullable-response bindings validate. Owner/campaign/world/base/provider/protocol bindings validate independently.
- [ ] **W06:** Real PostgreSQL concurrent identical decisions create one transition/receipt; duplicate replay is idempotent; stale revision, foreign owner, wrong plan, and conflicting decision cause no mutation or queueing.

## Evidence, application and acceptance

- [ ] **A01:** Exact producing-request evidence yields complete inventory; proven empty is distinct from missing evidence. Identical duplicate references may dedupe; conflicting contents, unavailable evidence and tampered requests do not offer repair.
- [ ] **A02:** No current retrieval or current database facts substitute for original visibility. Original sent fact IDs remain unchanged. A browser-supplied transformed story cannot establish authority.
- [ ] **A03:** Application recomputes the plan and checks source/request/plan/protected/result and all scope bindings before persisting an applied checkpoint. No provider call occurs to offer or apply repair.
- [ ] **A04:** Original raw attempt/result/request and decision receipt remain durable. The repair event is deterministic and recorded once, without a fabricated provider attempt or token/cost entry.
- [ ] **A05:** The composed real-PostgreSQL success sequence pauses with no accepted writes, accepts explicit repair with primary-call count still one, runs configured semantic review separately, then commits exactly once with correct state/facts and preserved narration.
- [ ] **A06:** Strict parsing, mechanics validation and mode-specific choice checks remain active after repair. Missing/incomplete/ambiguous candidates stop safely.
- [ ] **A07:** Stale campaign/base, world mismatch, changed narration correction, raw/request/plan tampering, foreign owner/provider fingerprint, unseen/inactive/foreign supersession all reject before canonical mutation.
- [ ] **A08:** Rejected cases compare actual turn, campaign-state, canonical-fact and accepted Chronicle rows before/after, using distinct owners/campaigns.
- [ ] **A09:** Applied provenance is recognized by both runtime resume and database payload loading/commit; typed story alone cannot authorize resume.
- [ ] **A10:** Later semantic/event reviews retain v2 provenance and journal, bind original request plus transformed story, and permit only valid actions without silent rewrite.

## Required policy and operation cases

- [ ] **P01:** Continuity off: ordinary acceptance path with no semantic call.
- [ ] **P02:** Continuity observe: configured review runs and policy behavior is preserved.
- [ ] **P03:** Continuity enforce: conflict after repair produces the normal next review, without waiver or another primary request.
- [ ] **P04:** Action + append.
- [ ] **P05:** Action + replace-latest.
- [ ] **P06:** Story Direction + append.
- [ ] **P07:** Story Direction + replace-latest.
- [ ] **P08:** Extension checkpoint matches repaired main/request/result exactly or stops as incompatible; no unrelated extension graft.
- [ ] **P09:** Illustration failure remains nonblocking and repaired metadata cannot enqueue duplicate illustrations; existing Chronicle failure durability remains intact.

## Crash and reclaim boundaries

Each row requires durable evidence of retained original output, no duplicate deterministic event, no extra primary request, no semantic calls beyond the existing durable allowance, and no second accepted turn.

- [ ] **D01:** Before decision.
- [ ] **D02:** After receipt.
- [ ] **D03:** After applied repair checkpoint.
- [ ] **D04:** After semantic-review checkpoint.
- [ ] **D05:** Before commit.
- [ ] **D06:** After commit acknowledgment loss.

## Both rendered clients

All seven scenarios must run on `/story` and `/app/story`, at desktop size and 390×844. Evidence must identify each surface/viewport, with synthetic screenshots under `docs/review/assets/turn-validation-success/`.

- [ ] **U01:** Repair success.
- [ ] **U02:** Stale revision: fetch/refresh, no automatic resubmission.
- [ ] **U03:** Network uncertainty and reload: reconcile durable decision without duplicate submission.
- [ ] **U04:** Unsupported version: inert refresh behavior.
- [ ] **U05:** Ineligible `{}`: no repair or Keep.
- [ ] **U06:** Full Retry: explicit replacement guidance and unchanged meaning.
- [ ] **U07:** Continuity rejection after repair: ordinary follow-up review.
- [ ] **U08:** Shared workflow tests prove fetch-current-before-submit, one matching receipt, disabled pending controls, preserved narration/candidate-hiding policy and no raw metadata preview.

## Legacy paths, combined checks and measurement

- [ ] **F01:** Reference trace and route regressions prove zero automatic schema-repair calls while pending. Only unreachable dispatch is removed; historical decoding, audit, valid resume and fixtures remain. Runbook explains historical automatic versus current explicit repair.
- [ ] **F02:** Fresh independent specification and code/durability reviews approve the complete integrated diff. Coordinator adjudicates every finding.
- [ ] **F03:** Final SHA passes documented unit, isolated PostgreSQL integration, type/check, build, both named Playwright suites and diff checks. Failed/skipped/baseline cases have explicit dispositions, never pass labels.
- [ ] **F04:** Final adapter evidence extraction/eligibility agrees with the independent historical replay, or each difference is explained and corrected. Report first-pass parsing, repair eligibility, strict validity and composed acceptance separately.
- [ ] **F05:** Full diff contains only scoped source/docs/synthetic fixtures and no private data/secrets. Local links resolve. Phase handoffs, screenshots and final report match the immutable reviewed SHA.
- [ ] **F06:** Final handoff states live success-rate improvement is unmeasured; documents v2-compatible rollback/in-flight-job handling without unsupported commands or restoring over newly accepted turns. Phases 05–06 and canary/deployment remain separately gated.
