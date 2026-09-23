# Campaign cast phase 04 acceptance

Date: 2026-09-23. Scope: automatic discovery and legacy `/story` controls. The user deferred web-next. This accepts phase 04 for progression to phase 05; the feature remains default off and has not been deployed.

## Requirement evidence

| Plan requirement | Current source and verification |
| --- | --- |
| Strict sparse extraction schema, exact evidence, no invented completion | `campaign-cast-discovery` contracts/domain and unit tests reject foreign IDs, extra fields, unsupported/clipped evidence, attribution errors, intentions, instruction text and duplicate proposals. |
| Stable paragraphs, bounded complete chunks | Domain tests cover paragraph splitting, stable source references and over-limit history; PostgreSQL tests complete only after every chunk publishes. |
| Ambiguous aliases, same-name people, unnamed people, world and protagonist identity | Domain tests keep ambiguity pending and retain evidence-based unnamed labels. PostgreSQL tests cover world/playable provenance, protagonist boundaries, same-name races and same-batch alias collisions. |
| Durable frozen direct/preset execution and atomic enqueue | `campaign-cast-discovery.integration.test.ts` executes both frozen route kinds through the prepared executor and durable accounting. `generation-execution-repository.integration.test.ts` covers accepted append/replacement enqueue, rollback and admission failure without losing the accepted story. |
| Ordering, restart, duplicate delivery, leases and idempotent publication | Discovery PostgreSQL cases exercise checkpoint recovery, receipt rollback, stale leases, failed gaps and per-campaign ordering. Parsed output is reused without payment. |
| Manual edits, active generation and lifecycle races | Discovery/lifecycle PostgreSQL cases preserve overrides, defer publication for all active generation states, reconcile corrected sources, fence rewind/replacement work and preserve other campaigns. |
| Honest coverage, branch/transfer and portability | Coverage starts at enrollment and stops at gaps; pending identity review is separate. Branch/transfer tests preserve forward enrollment without copying operational jobs. Portable evidence/identity decisions survive import with mapped IDs. |
| Provider limits and failure isolation | Two actual dispatches per source chunk/retry generation; cross-pool capacity leases; 30-second prepared deadline; bounded chunks. Production discovery composition now exercises deterministic timeout and malformed output through both automatic attempts, then proves no further dispatch, no discovered authority and identical accepted turn IDs/narration/timestamps. Every provider request is asserted to be the extraction schema. |
| Candidate review and Retry | Owner-bound API/PostgreSQL tests cover attach/create, idempotency, stale source/revisions, active generation and failed admission recovery. Legacy browser tests cover source review, same-name targets, Retry recovery/conflict, capability loss and no story regeneration request. |
| Rendered discovery and editing | Eleven legacy browser tests pass, including completion refresh and retained user correction/Ignore after another discovery response. Browser fixtures test UI rendering; PostgreSQL tests separately prove persistence. Inspected `.tmp/campaign-cast/acceptance-screenshots/discovery-refresh-390.png`: controls fit the mobile dialog. |
| Default-off operation and rollback | Config tests prove discovery requires editing. Compose and both Swarm roles forward both default-off flags and the same capacity limit. Disabling discovery retains evidence/checkpoints; runbook documents qualified routing, costs, recovery, migration and rollback. |

## Timing and limits of evidence

With `CAST_TEST_TIMINGS=true`, the deterministic local PostgreSQL run recorded:

| Operation | Elapsed | Discovery calls | Narration calls during discovery |
| --- | ---: | ---: | ---: |
| Accepted-story transaction including enqueue | 33.41 ms | 0 | Not measured |
| Successful preset discovery tick | 85.24 ms | 1 | 0 |
| Successful direct-model discovery tick | 84.25 ms | 1 | 0 |
| Injected deadline failure tick | 36.14 ms | 1 | 0 |
| Malformed output tick | 37.16 ms | 1 | 0 |

These are single local measurements of commit/enqueue and discovery processing, not a throughput benchmark or live-model narration latency. The timeout fixture injects a classified deadline; it does not wait 30 seconds. Deadline propagation itself has focused executor/capacity tests. Real prose quality is unverified.

## Verification record

- Generation acceptance plus discovery: 81 PostgreSQL tests passed; includes the 44-test discovery suite.
- Legacy browser: 11 passed; web-next intentionally deferred.
- Capability/runtime/scheduler selection: 64 unit tests passed. Deployment/config selection: 65 passed.
- Repository/TypeScript and whitespace checks passed.
- Final full unit run: 4,396 passed across 349 files, with 44 existing skips (`phase4-audit-unit.log`).
- Previous capacity checkpoint: 4,393 unit tests passed, 44 existing skips. Its PostgreSQL run had one migration-order failure; the complete migration suite passed on isolated rerun. This remains recorded rather than being relabeled as an entirely green initial run.
- Read-only independent acceptance review found the missing failure/timing evidence, then confirmed its addition; the parent also corrected capability dependency and deployment wiring.

Logs are under `.tmp/campaign-cast/phase4-{failure-audit,latency-audit,browser-audit,gate-red,gate-green,deploy-red,deploy-green,audit-check}.log`. No live provider, production-data mutation or deployment occurred.

Phase 05 still must capture versioned cast authority and feed bounded, source-linked context to generation. Phase 06 still must implement optional historical backfill. No relationships ship in this phase.
