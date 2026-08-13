# Task 7d — Track C exit audit

**Audited:** 2026-08-03
**Scope:** C0-C8, B4a/13a-R prerequisites, and C6 Task 7P/7a/7b/7c.
**Decision:** Track C is complete at the backend/client-boundary level. The
only authorized implementation sequence after this audit is Task 10 (B1), then
11 (B2), 12 (B3), 13b (B4b), 14a-14e (B5), and the Task 14f backend completion
audit. No replacement-UI implementation is authorized before Task 14f.

## Evidence by exit criterion

1. **Pure client-core.** `packages/client-core/tsconfig.json` fixes the
   compiler environment to ES2023 with no ambient platform types.
   `pnpm --filter @infinite-quest/client-core check` and
   `pnpm check:client-boundaries` verify the package and import/global rules.
   C6 adds the read-only `Store` and immutable `CampaignProjection` in
   [`store.ts`](../../packages/client-core/src/store.ts) and
   [`campaign-projection.ts`](../../packages/client-core/src/campaign-projection.ts).

2. **Framework-free client-web adapters.** The C5 browser source, storage,
   clock, delay, and ID adapters remain in `packages/client-web/src/`; the same
   boundary check rejects framework imports. C6 consumes only validated core
   ports and events, not browser APIs.

3. **Story Player seam.** C8's reviewed gate commits `9cca4e7`, `cac241a`, and
   `4bcd3de` route the existing Story Player through shared workflow and
   transport composition. Its completion report is
   [`2026-08-02-task-9-c8-completion.md`](2026-08-02-task-9-c8-completion.md);
   the Gate 2 revert rehearsal is the rollback evidence. C6 does not replace
   rendering and therefore introduces no visual/UI work.

4. **Runtime-validated HTTP data.** Shared schemas in
   [`packages/contracts/src/client-api.ts`](../../packages/contracts/src/client-api.ts)
   and [`packages/contracts/src/generation.ts`](../../packages/contracts/src/generation.ts)
   validate the adopted request/response and stream projections; client-web
   validates ingress before the workflow/store sees it. The contract and route
   suites run under the unit/integration gates below.

5. **No raw partial output.** The public polling snapshot omits
   `partialOutput`; the stream snapshot supplies only validated
   `partialNarration`. The workflow emits `GenerationEvent.narration`, and the
   store copies only that event's presentation-safe data. Focused workflow,
   projection, and boundary tests cover this rule.

6. **One watcher per job per tab.** C5's composed browser source owns the
   single watcher lifecycle; C6's `attachGeneration()` stores only one private
   matching run/session and rejects campaign/job mismatch. The focused
   client-core/client-web suites exercise duplicate attachment, detach, retry,
   and recovery behavior.

7. **No upward package imports.** `pnpm check:client-boundaries` verifies the
   client package graph has no `apps/` or `services/` import. The checks include
   compiler fixture projects, not only source-string assertions.

8. **Behavior genuinely relocated.**
   [`generation-workflow.test.ts`](../../tests/unit/client-core/generation-workflow.test.ts)
   drives submit, stream, poll degradation, recovery/auto-retry, settlement,
   and resume through fakes. C6 adds the independent
   [`campaign-store.test.ts`](../../tests/unit/client-core/campaign-store.test.ts)
   composition that wires a real `GenerationWorkflow`/`GenerationRun` into the
   reducer and covers completed replacement reconciliation. Neither test loads
   an app module.

9. **Named management-client transition.** The remaining management networking
   is the explicit legacy-client transition recorded in
   [`CLIENT_CORE_BOUNDARY.md`](../ui/CLIENT_CORE_BOUNDARY.md) and retained until
   its owning later UI slices; Track C does not claim all routes migrated.

10. **Verification and manual proof.** The commands below passed for this
    audit: `pnpm check` and `pnpm build` (548 repository candidates),
    `pnpm test:unit` (959 tests across 83 files), and `pnpm test:integration`
    (193 passed, 2 skipped across 17 files). Task 9's completion report retains
    the manual legacy play-loop and revert-rehearsal proof because this
    environment has no installed interactive browser/Playwright executable.
    That limitation does not authorize UI work; U6 owns browser E2E coverage.

## C6/contract reconciliation

The governing documents now agree on these shipped rules:

- `CampaignProjection` is an immutable, non-authoritative campaign view.
  Runtime state, stream/session ownership, and replacement provenance are
  campaign/job scoped.
- `sync-status` supplies an opaque `syncToken` and a discriminated bounded
  window (`unchanged` or self-identifying `replace`); older turns use separate
  opaque-cursor pages.
- Server recovery order is active pending job, then sanitized recovery, then
  local pending-submission hint. A completed result outside the visible window
  is fetched and reconciled without replaying a generation.
- `append` and `replace_latest` are discriminated public operation/target pairs
  in enqueue, polling, stream, pending, recovery, workflow run, and store.

## Commands and results

The executing Task 7d checkpoint records exact terminal output in its SDD
report. This audit passed the required command set:

```text
pnpm check
pnpm build
pnpm test:unit
pnpm test:integration
pnpm exec tsx scripts/benchmark-client-contracts.ts
git diff --check
pjm precheck
```

The contract benchmark reports 2,000 turns with validation p50/p95
2.157096/6.956568 ms, 351-byte stream payloads, two frames per generation, and
`leaseOnlySnapshotChangesFrame: false`. The stream allowlist contains the
operation/target pair plus the approved narration, error, and result fields;
this is the current ADR 0028 evidence. `git diff --check` and `pjm precheck`
also pass. The scoped review must inspect the complete Task 7d documentation
diff before the checkpoint is accepted.

## Documentation/staging constraint

`docs/ui/SLICE_0_1_IMPLEMENTATION_PLAN.md` already contains inherited,
uncommitted Task 7 sequencing and status-table edits. Its Task 7d status and
completion block cannot be committed in isolation without also staging those
user-owned changes. This audit intentionally does not stage that file. A parent
or owner must reconcile and commit the existing plan hunk, then mark 7P, 7a,
7b, 7c, and 7d complete with their checkpoint evidence. This is a documentation
staging constraint, not a technical authorization exception: UI remains blocked
until Task 14f.
