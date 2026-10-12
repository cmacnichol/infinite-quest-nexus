# Story activity history operations

The legacy Story player records safe operational transitions separately from accepted turns, campaign state, Chronicle and the existing private portable `activity_events` ledger. Database migration `0115_story_activity.sql` adds `story_activity_events`, `activity_event_outbox`, `campaign_activity_history` and source revision columns. Operational history is excluded from System and Campaign Archives; an imported campaign begins without operational history. A database backup may retain it.

Coverage begins with the first successful new capture for each campaign. There is no historical backfill. Old producers do not capture transitions, and an upgraded producer may first observe a terminal transition for a pre-existing job. Completeness begins only after all participating producers are upgraded. Activity cannot authorize retry, Keep, discard or acceptance; open current recovery options and re-read authoritative job state.

## Rollout and rollback

1. Back up the authoritative database and verify restoration under the normal [deployment procedure](deployment.md). Apply the additive migration under the migration lock.
2. Deploy compatible API and workers, then the legacy client. Existing strict meta responses are unchanged. Older clients continue to use existing generation APIs. An unsupported activity GET uses explicitly labeled local-only fallback after session and campaign access validation.
3. Use copied-campaign canaries: enqueue while the browser is closed, complete and reopen history; force review/retry and image failure; temporarily stop publication, confirm Story completes and backlog catches up after restart. Inspect only safe counts, IDs and fixed codes. Confirm owner isolation and no duplicate accepted turn.
4. Monitor pending count/age, quarantine count and worker/database health. A growing backlog delays history and does not establish failed generation. Capture database failure rolls back its domain transaction; existing idempotency/retry controls must remain in force.

For application rollback, stop or replace compatible producers/workers according to the existing job/protocol rollout constraints. Retain additive tables, rows, revision columns and accepted turns. Do not run a destructive down migration. Old producers stop new capture; queued snapshots remain available for a compatible publisher. Older APIs may omit the new GET; client local fallback is an honest coverage gap. Database restoration is a separate recovery operation: a cursor ahead of the restored campaign high-water mark returns `resetRequired`; the client clears stale server history and reconciles again. Restoration that loses accepted turns needs its own authorized recovery decision.

## Publication and retention

The existing worker has an optional Activity lane of capacity 1. It publishes up to 100 committed snapshots at a nominal one-second interval (five seconds after a maintenance error) and cleans up at most 1,000 rows every 60 seconds. A shared transaction advisory lock serializes publication across replicas before global sequence allocation. Publication order defines pagination; occurrence timestamps do not promise global chronological commit order. Required index: `(owner_user_id, campaign_id, sequence DESC)` on published events, with pending outbox ordering/indexes installed by the migration. No provider, new service, external queue or browser subscription is needed to publish.

Published events expire 30 days after publication, not occurrence. Published outbox receipts expire after 7 days. Pending and quarantined snapshots are retained until resolved or their campaign/user is deleted. Cleanup updates retention floors; expired or future cursors require reset. Source job/turn/provider cleanup retains safe historical IDs; deleting the owning campaign or user cascades its feed. Retention is bounded per pass, so overdue cleanup can take multiple passes.

Batch sizes are defaults, not measured throughput promises. Capture adds a revision update, safe snapshot and coverage write in the source transaction. See [verification evidence](../review/legacy-activity-verification.md) for the local fixture measurement and its limits. Size database connections using the worker deployment guidance; the lane shares the existing pool.

## Safe diagnostics

Use an authorized operator connection. These read-only queries return aggregates and fixed codes without snapshots, provider bodies, actions, narration, credentials or private errors:

```sql
SELECT count(*) AS pending_count,
       greatest(0, extract(epoch FROM (clock_timestamp() - min(occurred_at)))) AS oldest_pending_seconds
FROM activity_event_outbox
WHERE published_at IS NULL AND quarantine_code IS NULL;

SELECT quarantine_code, count(*) AS quarantined_count
FROM activity_event_outbox
WHERE quarantine_code IS NOT NULL
GROUP BY quarantine_code;

SELECT count(*) AS retained_events, min(published_at) AS oldest_publication,
       max(published_at) AS newest_publication
FROM story_activity_events;
```

Worker signals use fixed names/codes: `activity_publication_health`, `activity_maintenance_error` with `activity-maintenance-failed` and `activity_publication_quarantined`. Investigate worker liveness, advisory-lock contention and database availability before increasing batch size. A quarantine marks an invalid safe snapshot and sets incomplete coverage. Preserve that row for investigation; do not export its JSON or replace the code with arbitrary exception text. Reproduce validation with a sanitized fixture and repair the producer/validator before considering an explicitly reviewed data repair. There is no automatic replay of rejected snapshots or user-facing quarantine override.

## Browser behavior and limits

`History may be delayed` means publication is pending or unavailable; `Showing cached activity` describes a verified open scope during an outage. Cold offline reload requires current session and campaign access validation before revealing IndexedDB history. `Local history storage unavailable` means cache durability is unavailable while Story remains usable. Browser observations stay in that browser and are never uploaded. Reversible hide watermarks change presentation, not server retention. Search and diagnostic copy/download operate on loaded entries and include scope/coverage information; they do not fetch unlimited history.

The first release covers generation/review/retry/cancel/discard and campaign image/segment transitions in the active legacy player. World authoring, cast/indexing histories and replacement-client presentation are outside coverage. Deterministic test providers establish workflow semantics; no production deployment, live-provider quality or sustained publication capacity is claimed.
