# ADR 0040: Versioned history-coverage context enrollment

## Status

Accepted 2026-09-27.

## Decision

New Story Memory snapshots that are already eligible for campaign-cast context
capture `current-continuity-v5` and the existing `story-v17-campaign-cast`
prompt identity. The v5 reader is selected only by that frozen tuple. Cast-
disabled and legacy snapshots retain their existing v3 behavior; the compatible
rollback default emits v4 while retaining v5 readers for already queued work.

`HISTORY_COVERAGE_ENABLED=false` changes only the new-job default. It never
rewrites a stored policy, prompt snapshot, checkpoint, enrollment, override,
accepted turn, or derived record. ADR 0039 remains in force: a matching output
shape version and content hash need no new acknowledgement merely because v5 is
selected.

## Consequences

V5 reserves each optional layer against measured writer and, when enabled,
reviewer headroom. Its intent ledger is player intent rather than evidence that
an event occurred; accepted narration and current canonical state establish
outcomes. Protected facts are complete only after scoped source/content
verification. Retrieval excludes only sources actually reserved in the final
request. Ledger, fact, parent, candidate-pool, and optional-fit guards are
bounded and reported as such; configured campaign budget never overrides a
frozen provider limit.

F3 remains partial: accepted-event synopses and chapter compaction are deferred.

Before enabling v5, every API and worker claimant must run a build that reads
v5. During a mixed deployment, keep intake stopped until no older worker can
claim a new v5 job. Rollback first retains compatible v5 readers and drains or
recovers outstanding v5 work, then changes only the enqueue default. Do not
rewrite a job as v4 or discard a valid candidate.
