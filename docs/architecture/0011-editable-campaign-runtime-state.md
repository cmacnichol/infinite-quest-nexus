# ADR 0011: Editable campaign runtime state

## Status

Accepted.

## Decision

The legacy and replacement Story Players and replacement Campaign State page read and update current continuity through the campaign runtime-state API. Continuity summary, private fiction-only scratchpad, open threads, canonical facts, and existing trackers are editable. RPG statistics and triggers remain separate mechanics configuration, preserved by continuity saves.

Manual updates use the campaign turn number and a monotonically increasing campaign-state revision for optimistic concurrency. The API rejects edits during active story generation, validates edited prompt fields through the fiction boundary, invalidates saved model chains, and records a content-free activity event. Private state-edit snapshots are append-only and keyed to their effective turn so rewind and branch operations can restore manual corrections without modifying accepted turns.

Historical state inspection belongs to the Turn History surface and is read-only. Edit State changes only the latest authoritative campaign state. A historical state must first become current through an explicit rewind or branch operation before it can be edited.

## Tracker identity compatibility

The browser/API runtime-state contract requires every tracker to have a
non-empty stable `id`; the Story editor uses that ID for row identity and
removal. Older worlds, character-generation output, portable imports, and
accepted snapshots may contain tracker-shaped objects without IDs.

The API canonicalizes those persisted shapes before strict runtime-state
validation. Valid IDs are preserved, missing IDs receive deterministic
fallbacks, and collisions receive deterministic suffixes. Campaign creation,
imports, transfers, and turn commits apply the same canonicalization before
new writes. Accepted turns are not rewritten solely for compatibility.

## Consequences

- A manual correction is available to the next Story Engine prompt immediately after a successful save.
- Accepted turn rows and their original private snapshots remain append-only.
- Scratchpads remain excluded from Chronicle fiction memories, embeddings, illustration requests, streaming events, and routine logs.
- Corrections use the typed transactional `applyCampaignStateCorrection` memory port. Only changed summary/thread documents and affected fact groups are projected. Unchanged memory IDs, vectors, chunks, accepted fiction, and historical summary checkpoints are retained. Scratchpad-only saves schedule no memory work.
- Both eligible indexing paths are durably queued in the save transaction; provider work runs afterward. Stale vectors and chunk text are retired immediately. A provider outage does not reject a correction; a database enqueue failure rolls it back.
- Generation reads the complete correction at its exact base turn into mandatory `currentContinuity`, including intentional empty fields. It outranks conflicting historical/provider continuity without overriding mandatory world rules. Protocol `story-v13-current-state-corrections` invalidates older continuation chains. Oversized fixed corrections fail explicitly with `context_budget_exceeded`.
- Full rebuilds replay turn-zero corrections, then each accepted turn followed by its corrections in revision order. A correction at N does not overlay the summary/scratchpad/threads of N+1 indefinitely. Same-turn fact removals delete never-effective derived projections because validity intervals cannot have zero length; immutable turn/edit snapshots retain their audit history.
- Branch, transfer, and portable import remap destination fact references together with generated supersession references, without changing source accepted rows. Portable import reconstructs the structured fact projection in its transaction so imported current state is immediately editable without a manual rebuild. Unrelated imported Chronicle records remain intact. No archive version bump is required.
- Migration `0082_turn_zero_state_correction_facts.sql` permits a source/validity turn of zero only for manually corrected canonical facts. Negative values and accepted-turn fact constraints remain invalid. Apply it before enabling turn-zero fact writes; it needs no data backfill. Retain the relaxed constraints during application rollback because restoring the older checks would reject persisted turn-zero corrections.

Implementation scope and concurrency rules: [current-state corrections specification](../superpowers/specs/2026-08-30-current-state-corrections-design.md).
