# Legacy UI implementation record

Implementation branch: `codex/legacy-ui-usability`, isolated managed worktree `legacy-ui-usability-implementation/InfiniteQuest`.

The user authorized implementation of the [audited plan](../../superpowers/plans/legacy-ui-2026-10-03/implementation-plan.md), using Luna implementers and Sol or Astra verification. The [design specification](../../superpowers/plans/legacy-ui-2026-10-03/design-spec.md) and [audit packet](../../superpowers/plans/legacy-ui-2026-10-03/audit-packet.md) remain the design and audit references. Planning-only language in those archived documents no longer limits authorized local implementation and verification. Publication, production deployment, and billable live-provider calls remain outside the request.

## Accepted work

| Task | Result | Review and verification |
| --- | --- | --- |
| T01 | Deterministic synthetic UI fixtures, configurable route instrumentation, baseline screenshots and repeatable browser benchmark | Sol accepted after two scoped correction rounds. Six existing suites: 111 passed; baseline browser: 4 passed; native long-task lifecycle: 1 passed; 5 warmups/30 samples retained. No product behavior changed. |
| T02 | Pure edit-session comparison and shared native-dialog dismissal policy | Sol accepted at bd68ef50 after disposal-generation regression and evidence-log correction. 12 unit tests and 1 native-dialog browser test passed; focus and stale-session cases covered. Production wiring follows in T03/T04. |
| T07 | Scoped transactional IndexedDB action drafts, retention notices and conditional revision clearing | Sol accepted at b10bcda5 after global-capacity and revision-freshness corrections. 14 unit tests and 1 real two-page IndexedDB browser test passed. The browser proves newer identical text survives a stale clear. |
| T10 | Additive exact accepted-turn lookup, effective correction and public cost | Sol accepted at fc5f0894 after adding missing production registration and a buildServer regression. Real PostgreSQL composition tests: 2 passed; corrective composition unit checks: 64 passed; source/package/boundary checks passed. A later combined root TypeScript check passed in T06; final full integration remains T35. |
| T14 | Bounded literal campaign-history search with snapshot-bound cursors | Sol accepted at d44cef6f. 9 units and 3 real PostgreSQL cases passed; current production types passed. Single warm EXPLAIN samples are query observations, with no route p95 or production speedup claim. |
| T19 | Shared pure campaign creation draft and preference defaults | Sol accepted at 19410b3c; 11 unit tests and scoped type/boundary checks passed. Existing action-only and flexible modes are preserved. Actual Basic/Advanced preservation proof belongs to T20. |
| I01 | Optional isolated loopback PostgreSQL root URL for integration tests | Sol accepted after rejecting unsupported IPv6 URL literals. 22 focused unit tests, TypeScript and diff checks passed. Standard-config real PostgreSQL read-performance suite: 2 passed, with migrations and per-file isolation. Shared credentials and volumes unchanged. |

T01 commits: `f87113ff`, `7524e48b`, `63ea4f60`. I01 commits: `550b9b9e`, `2c48deb0`.

The [baseline](baseline.md) is a mocked development-server observation, not production latency. Corrected history-open p50/p95: 113.45/168.13 ms, with 18.21% coefficient of variation. Small timing changes require another controlled run before attribution. Native long tasks are captured by document phase; API JSON and static response bytes are measured separately. Screenshots capture history while the dialog is open. Original incorrect summaries were superseded by retained corrected artifacts.

## Implementation decisions and reasons

- Shared-file product changes are serialized. Disjoint foundational files may be implemented concurrently, and Git commits are coordinated. This avoids interleaving edits to the large legacy Nexus and Story modules while retaining parallel work where ownership is clear.
- Related tests and focused checks run for each task; complete suites run at the final integration gate and justified intermediate boundaries. Repeating broad suites without a concrete concern would add cost without distinct evidence.
- I01 uses an explicit `INFINITEQUEST_TEST_DATABASE_URL`, validated as PostgreSQL on `localhost` or `127.0.0.1` with a test-only database name. The existing shared provisioner remains the default. The per-file `TEST_DATABASE_URL` handoff is deliberately not an override. An existing shared-volume credential mismatch prevented assertions, so an owned disposable instance was necessary. IPv6 is rejected because the installed driver preserves brackets into its socket host.
- T02 browser proof uses a synthetic native-dialog harness before production wiring in T03/T04. Fake DOM tests cannot prove native Escape cancellation or focus restoration. An additive synchronous cancel binding prevents default closure and delegates to the same asynchronous dismissal policy; it must support disposal and avoid duplicate listeners.
- T07 gains an additive `readExpiryNotice(scope): Promise<boolean>` because its specified `read` result cannot disclose retention expiry. Notice metadata contains no expired prose, remains user/campaign scoped, expires after 30 days, and is capped at 50 globally. Only informational notice metadata can drop oldest entries; unexpired drafts cannot be silently evicted. Protection of the active write target during pruning does not grant indefinite retention.
- T06 pure resume policy belongs in client-core, with exports through both legacy browser entries. Its initial file list omitted that boundary, so ownership was expanded before assignment. Resume precedence remains unchanged from the audited specification.

- T02 disposal invalidates pending decisions as well as removing listeners. An optional isCurrent callback protects captured selection/session epochs. A retained failed type log was explicitly superseded by the coordinated current passing check; failed logs are never represented as passes.
- T03 needs the pure createEditSession helper through the existing served management entry. T19 owns that entry while building shared defaults and adds the export without duplicating policy.
- T19 has no disclosure state, so Advanced-toggle preservation is tested in T20’s rendered dialog rather than through a meaningless copied boolean. Pure request building validates missing/contract-invalid character IDs and preserves draft values; the server retains authoritative character membership validation.

## Evidence and remaining gates

Raw task logs, review packages, screenshots, benchmark samples and the execution ledger are retained locally under the ignored `.superpowers/sdd/legacy-ui-2026-10-03/` task workspace. They contain synthetic fixtures; private test credentials are separately ignored and must never be printed or committed. Committed review documents summarize the evidence and decisions.

Remaining plan tasks are in progress or pending; only the rows marked accepted above are complete. T10 production registration is now accepted after a failing-then-passing buildServer regression. A combined root TypeScript check passed during T06; it does not replace the final integration gate. T28 requires a post-optimization evidence decision and separate audited projection addendum before code; an evidence-backed deferral is valid. T32 requires operational review before acceptance, without deployment. Final acceptance requires relevant complete unit/integration/browser/build checks, screenshots, performance comparisons, and a fresh Astra whole-branch review. No feature completion is claimed by this interim record.

- T14 current production compilation supersedes an earlier TS2379 failure, whose raw log is preserved. Its 2,002-turn PostgreSQL fixture has refreshed statistics; EXPLAIN excludes the separate history-version query and does not establish route latency, cold IO or production concurrency.
