# Fact context budgeting implementation plan

**Goal:** Load valid campaign facts without an arbitrary count ceiling, send the newest complete facts that fit the actual context and provider request budgets, and omit older facts only from prompts, never authoritative storage.

**Architecture:** Preserve scoped source verification and frozen campaign authority. Remove collection-size gates from fact capture. Select the maximal newest whole suffix using serialized writer and reviewer budgets after required scene authority; preserve whole fact records and report omissions.

**Spec:** User request in this chat: no artificial fact limit; include facts that fit context and drop older facts when exceeded.

**Tech stack:** TypeScript, Zod, PostgreSQL, Vitest.

## Constraints and review focus

- Preserve owner/campaign/world isolation, correction frontiers, retired-fact exclusion and source verification.
- Never delete stored facts or mutate live campaigns for this repair.
- Keep complete records, reserve model output and honor both writer and reviewer input limits.
- Verify more than 512 facts, oversized newest records, zero remaining budget, stable chronology, and invalid/foreign sources.
- This changes the fact-allocation decision in ADR 0040; document the updated policy.

## Tasks

- [x] Capture: add failing tests for 910+ valid correction facts and source retrieval beyond 512, remove arbitrary collection caps in contracts/database, retain validation and isolation. Own application memory schema, database continuity repository, associated unit/integration tests.
- [x] Selection: add failing planner tests for >512 facts, available-budget utilization, oldest-first omission and writer/reviewer ceilings. Replace fact quota and measurement cutoff with context-bounded newest-first whole-record selection. Own runtime planner and tests.
- [x] Verify: run focused unit and real PostgreSQL integrity/isolation tests, type/build checks, review diff and architecture documentation. Record actual failures/skips; do not deploy or retry live generation.

## Execution ledger

- Reusing the existing clean isolated worktree at `8994/InfiniteQuest`.
- Ruling: prioritize valid canonical facts after mandatory scene authority, before optional history/retrieval; this follows the requested context-only fact budget. Required authority and output reservations remain protected.
- Ruling: interpret "drop older facts" strictly as removing the oldest prefix. If the newest whole fact cannot fit, select no facts. Do not skip a newer large fact to backfill older small facts. Exact suffix probes preserve recency and avoid the measured 17-second synchronous per-record reviewer loop without any count or measurement cap.
- Selection performance RED: 512 partial-fit facts needed 216 exact probes, failing the logarithmic probe assertion; the oldest-first permutation test also failed. GREEN after suffix selection: 10 probes, 833 ms; all three targeted selection tests passed.
