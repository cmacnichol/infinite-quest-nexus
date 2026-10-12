# Independent preimplementation audit packet

Plan: [Implementation plan](./implementation-plan.md).
Spec: [Design specification](./design-spec.md).
Baseline:94853d2d859f57b8a75bb69edd532c016570dffa.
Status: Ready with explicit conditions; independent reviewer confirmed A01–A07 resolved. No implementation authorization inferred.

## Auditor assignment

Audit this plan as a fresh agent before any code implementation. Read the spec and task packets, verify important current source boundaries, and identify incorrect assumptions, incomplete contracts, missing failure cases, overengineering, unsafe sequencing and test gaps. Review the reasoning for each change; do not implement it, install packages or mutate live data.

Use current worktree source, not historical findings. Treat E01-E08as observed audit evidence and E09-E18as source-confirmed findings. Do not represent one warm localhost sample as a browser/production benchmark.

## Required audit checks

1. User intent: desktop, one-turn default, history/resume, new/experienced setup with disclosed advanced fields.
2. Existing invariants: authoritative database, immutable versions,append-only acceptance,idempotent jobs,role-separated providers and no cross-campaign data.
3. Browser draft semantics: per resolved user/campaign,retention,failed quota,pending/failed provenance and late accepted job vs new typing.
4. Editing: normalized baseline,unsaved selection,all dismiss paths,nested parent save and busy operations.
5. Reading: exact turn identity,resume replacement/correction,keyboard/sticky/scroll behavior and no accidental submit.
6. History API: additive endpoints,validated request/response,corrected narration,query-bound cursors,consistent snapshot,owner scoping,no private projection and bounded results.
7. Setup: readiness guidance doesn't duplicate/override domain validators;creation preferences apply equally;committed refresh failure cannot duplicate.
8. Performance: request dependencies justified,optional data nonblocking,bootstrap conditional,compression excludes SSE/ranges,cache invalidation explicit.
9. Accessibility: names,tab semantics,focus,status,motion,contrast,zoom and screenshots;automated tests not presented as certification.
10. Agent feasibility: task size/interfaces,barrel exports,serial shared files,file moves,test selection and environment blockers.
11. Coverage: all E01-E18mapped;recommend any deferral explicitly rather than dropping scope silently.
12. Rollback: preserve canonical content and compatible local settings;deployment remains separately authorized.

## Output format

Write findings by priority:
- ID and severity (blocker/high/medium/low).
- Task(s) and exact plan/source location.
- Why the current proposal fails or leaves an important ambiguity.
- Concrete plan correction and regression assertion.
- Whether correction blocks implementation or only the named conditional task.

Then give:
- Verdict: ready / ready with explicit conditions / requires revision.
- Coverage gaps and unnecessary complexity.
- Decision proposals accepted/rejected (retention,reader defaults,page/window sizes,search scope,bootstrap gate,compression).
- Unverified facts and required evidence, with no invented pass.
- Confirmation no application implementation occurred.

## Findings and disposition

Initial verdict: requires revision. Reviewer /root/audit_legacy_ui_plan audited documents/current source without implementation.

| ID | Priority | Disposition |
| --- | --- | --- |
| A01 | High | T07transactional IndexedDB conditional write/delete with immutable revision; T08captures submission revision, preserves same-text new edits and second-tab conflicts. |
| A02 | High | T31explicit source create/remove,package syntax command,boundary scripts and known CSP/build/source-reading tests. |
| A03 | Medium | T13depends on T10/T11; selected preview plus49cards; adjacent lookup budget and Turn12of317 assertion. |
| A04 | Medium | T21depends on T04; T31enumerated Nexus integration barrier; T33/T34 manifests re-approved after move. |
| A05 | Medium | T01environment then six-suite baseline then reproducibility instrumentation; no forced product red/green for capture. |
| A06 | Medium | T28go/no-go and exact field/file contract addendum precede tests or code. |
| A07 | Low | Disclosed30day retention,protected current record,no unexpired silent eviction,expiry notice without prose. |

Provisionally accepted: appearance defaults,page/window sizes,campaign-wide literal search and conditional bootstrap/compression. T10uses direct application context entrypoint; no root barrel needed.
## Final independent outcome

Reviewer: /root/audit_legacy_ui_plan, focused second pass.
Verdict: ready with explicit conditions; no original blocking finding remains.
The reviewer confirmed every correction A01–A07 against the revised documents.

Final clarifications adopted:
- T07 WriteResult explicitly distinguishes capacity from quota.
- T08 app-controlled navigation awaits transaction commit; browser reload/close receives a native unsaved warning and best-effort flush, with no promise that asynchronous IndexedDB completes in beforeunload.
- The relevant regression assertions distinguish these two navigation cases.

Why IndexedDB: atomic compare-and-delete across tabs is required by the chosen single shared per-user/campaign draft record. LocalStorage cannot provide it. Per-writer records would require extra session discovery/selection/cleanup policy and were not selected.

## Conditions that remain before execution

1. Explicit user authorization to implement; the current request is planning only.
2. T01 executable environment/baseline; unavailable checks are not passes.
3. Fresh task reviews and exclusive shared-file ownership.
4. T28 post-optimization measurements, go/no-go and exact projection/file addendum before any bootstrap code.
5. T32 operational compression/cache review before rollout; deployment separately authorized.
6. T33/T34 file manifests regenerated and reviewed after T31 source move.
7. Real PostgreSQL, browser, contrast/performance and provider evidence reported separately.

## Planning verification

-35task packets present.
-Existing source manifests checked; future files owned by dependency tasks recognized.
-Local links between all three documents resolve.
-Documentation whitespace checked; original checkout remains clean.
-Only these planning documents were written; no application implementation, dependency installation, database/provider mutation, commit, push or deployment.
-Application tests were not run for this documentation-only work. Test executability,contrast,new-query performance and runtime speed remain unverified.

## Original audit reasoning retained

A01: The original draft shape had no immutable revision or conditional clear. Text/timestamp comparison could delete a retyped identical or concurrent-tab draft.
A02: Moving nexus.js without updating the root syntax-check command and boundary/CSP/source-reading consumers would break mandatory checks or weaken protections.
A03: An exact resumed old turn is not automatically a cursor page. Selected preview and nearby-turn lookup needed a bounded explicit policy.
A04: Prose scheduling did not prevent T31from moving source before all Nexus integrations, and T21used T04without depending on it.
A05: Baseline instrumentation was asked to run before repairing known execution prerequisites. Infrastructure failures are not intentional red regressions.
A06: The optional bootstrap packet put test creation before its before-coding evidence decision.
A07: Silent capacity eviction would create another unexplained loss of unsent text. Disclosure and no-unexpired-eviction policy were missing.
