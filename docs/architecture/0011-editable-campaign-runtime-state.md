# ADR 0011: Editable campaign runtime state

## Status

Accepted.

## Decision

The Story Player reads and updates current private continuity through a dedicated campaign runtime-state API. Runtime state is distinct from player mechanics configuration and consists of the fiction-only scratchpad and structured trackers, plus read-only projections of RPG statistics, triggers, continuity summary, canonical facts, and open threads.

Manual updates use the campaign turn number and a monotonically increasing campaign-state revision for optimistic concurrency. The API rejects edits during active story generation, validates edited prompt fields through the fiction boundary, invalidates saved model chains, and records a content-free activity event. Private state-edit snapshots are append-only and keyed to their effective turn so rewind and branch operations can restore manual corrections without modifying accepted turns.

Historical state inspection belongs to the Turn History surface and is read-only. Edit State changes only the latest authoritative campaign state. A historical state must first become current through an explicit rewind or branch operation before it can be edited.

## Consequences

- A manual correction is available to the next Story Engine prompt immediately after a successful save.
- Accepted turn rows and their original private snapshots remain append-only.
- Scratchpads remain excluded from Chronicle fiction memories, embeddings, illustration requests, streaming events, and routine logs.
- Direct corrections to canonical facts, open threads, or the living summary require a separate typed Chronicle correction workflow rather than raw memory editing.
