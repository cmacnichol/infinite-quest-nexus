# Campaign cast phase 06: optional accepted-history backfill implementation plan

> **For agentic workers:** Implement task-by-task with strict TDD. Use `superpowers:subagent-driven-development` when delegation is selected; otherwise execute natively. Do not start relationship implementation in this patch.

**Goal:** Let a user populate characters from an existing campaign's selected accepted history without overwriting manual edits or regenerating story turns.

**Architecture:** A user-requested durable scan schedules the same source-revision extraction used for forward discovery, with a frozen range and resumable per-turn progress. Backfill is metadata recovery, and automatic results retain the same evidence and identity rules.

**Tech Stack:** TypeScript, PostgreSQL jobs, existing text execution routing, Vitest, Playwright.

**Spec:** [Shared specification](2026-09-22-campaign-cast.md). Dependency: phase 05 accepted. Optional; phases 01–05 can release without it.

## Global constraints

Shared constraints apply. Never scan a production campaign automatically on deployment or feature enablement. Preview the selected range and estimated work; explicit Start authorizes provider calls for that range. Do not promise a precise cost when token pricing or usage is unavailable.

## Files and ownership

- Create `packages/application/src/campaign-cast/backfill.ts`, `packages/database/src/campaign-cast-backfill-repository.ts` and the next ordered `_campaign_cast_backfill.sql` migration.
- Extend cast contracts/routes/composition/job worker, `apps/web-next/src/campaign-cast-panel.ts`, shared cast client modules, and legacy cast renderer from phase 03.
- Extend archive classifications for operational scan state; keep applied identities/events/evidence portable through the existing phase 02 path.
- Add `tests/unit/campaign-cast-backfill.test.ts`, `tests/integration/campaign-cast-backfill.integration.test.ts`; extend `tests/e2e/campaign-cast.e2e.test.ts` and `docs/runbooks/campaign-cast.md`.

## Interfaces and controls

```ts
type CastBackfillRequest = {
  fromTurn: number; throughTurn: number;
  expectedBoundary: CastBoundary; idempotencyKey: string;
};
type CastBackfillProgress = {
  id: Id; fromTurn: number; throughTurn: number;
  completeTurns: number; failedTurns: number; pendingReviewCount: number;
  status: "queued" | "running" | "paused" | "complete" | "failed" | "cancelled";
};
```

Expose preview/start/get/pause/resume/cancel under the cast API's `scans` resource. A repeated identical Start key returns the original scan. Only one active scan per campaign; forward discovery has priority, and scan publication follows the active-generation deferral rule. Pausing stops new provider dispatch; a running response may checkpoint. Cancellation preserves already applied, evidenced records.

## Review focus

Incomplete older history; imported turns with changed IDs; partially completed scans resumed after restart; rewind/correction during a scan; discovering an older alias for a character already edited by the user.

## Task 1: preview and durable range scheduling

- [ ] Validate positive inclusive accepted-turn ranges, bounded by the active campaign boundary. Reject gaps/invalid turn references during preview; do not silently pretend absent history exists.
- [ ] Add the range contract assertion before scheduler implementation:

```ts
expect(castBackfillRequestSchema.safeParse({
  fromTurn: 8, throughTurn: 3,
  expectedBoundary: { turnNumber: 10, timelineRevision: 0 },
  idempotencyKey: "history-scan-0001"
}).success).toBe(false);
```

- [ ] Preview turn count, estimated chunk requests, existing completed receipts, and provider/model selection. Freeze the accepted source identities and execution plan at Start.
- [ ] Schedule ordered per-turn work using phase 04 receipts. Reuse completed matching source/protocol receipts; corrections require a new revision. Pause and resume retain checkpoints and never duplicate applied records.
- [ ] Test stale boundary rejection, duplicate Start, restart recovery, pause/cancel, and a newer forward-discovery job. Run new unit and real-PostgreSQL backfill suites RED/GREEN; commit scheduler.

## Task 2: publication, UI, and historical coverage

- [ ] Apply old observations at their source turn, never the scan's current turn. Do not overwrite a later accepted dynamic fact or manual override with older evidence. An older identity alias can enrich history only after passing the same ambiguity checks.
- [ ] Recompute coverage bounds accurately. A completed scan of turns 20–40 does not claim turns 1–19 were tracked. Keep the first release to the contiguous policy below and explain it in preview; the shared single-range contract stays unchanged.
- [ ] Choose the bounded first-release policy: accept only a contiguous extension of existing coverage, or an initial contiguous range for an untracked campaign. Failed gaps remain visible until retried. Do not introduce disjoint-range support in this patch.
- [ ] Add **Scan earlier story** with range preview, Start, progress, pause/resume/cancel, and failed-turn retry in both Story cast panels. Explain that cancellation keeps characters already discovered. Show pending identity decisions separately from scan failure.
- [ ] Invalidate/cancel pending work after a rewind or changed source revision. A scan result cannot resurrect a character from a removed future turn. Narration correction reprocesses only the affected source revision.
- [ ] Test old facts versus new overrides, ambiguous aliases, branch-before-introduction, import-remapped evidence, and canceled partial progress. Assert no accepted narration changes and no story-generation calls.
- [ ] Run both-surface browser coverage and screenshots, backfill integration suite, affected lifecycle/portability tests, and type checks; commit and complete handoff.

## Exit gate and rollback

Users can safely scan earlier accepted history with honest progress, resumability, costs/usage visibility where available, and no loss of edits. Disable new scans to roll back; preserve applied cast and allow cancellation/read-only progress. Relationship extraction remains a separate future project that consumes the existing identity/provenance/temporal infrastructure.
