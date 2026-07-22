# ADR 0020: Summary checkpoints are validated rebuild seeds

## Status

Accepted

## Context

Chronicle retains periodic campaign continuity summaries so historical prompt construction and rebuilds do not always have to replay every accepted turn. These checkpoints are derived data. Selecting a checkpoint solely because its row has the highest turn number can admit stale, malformed, or incorrectly copied content into a historical context, especially after a replacement, rewind, branch, import, or interrupted rebuild.

A checkpoint must therefore be tied to the accepted fiction that produced it without making the checkpoint authoritative. The validation material must also preserve the Story Engine's fiction-only boundary: mechanics, private scratchpads, provider metadata, diagnostics, and rejected output must not influence or enter a recoverable summary.

## Decision

For a requested historical cutoff, Chronicle considers campaign continuity checkpoints in descending turn order and only at or before that cutoff. It validates each candidate against the accepted turn ledger and uses the newest candidate that passes. A checkpoint after the cutoff is never eligible. If no candidate is valid, Chronicle falls back to the validated living summary available from accepted turn state and, when necessary, replays accepted turns without a checkpoint seed.

Version 2 checkpoints carry `schemaVersion`, `throughTurn`, `sourceSnapshotHash`, `continuitySummary`, `openThreads`, and `factProjection`. The integrity hash is recomputed with stable serialization from the accepted turn number and the accepted snapshot's sanitized `continuitySummary`, `canonicalFacts`, `supersededFacts`, `canonicalFactUpdates`, and `openThreads`. Action, narration, mechanics, trackers, scratchpads, model or provider metadata, raw responses, and other private or operational fields are excluded from the hash input. The summary and threads must agree with the accepted snapshot represented by that hash. Fact seeds are independently checked for deterministic IDs, normalized content, campaign-local source turns, validity bounds, and in-checkpoint supersession links before a rebuild may use them.

Version 1 checkpoints contain only their legacy summary payload and cannot prove integrity cryptographically. They remain a compatibility fallback only when their sanitized summary exactly matches the accepted through-turn snapshot's continuity summary. An unmatched or unparseable version 1 row is skipped rather than trusted or repaired in place.

Checkpoint creation and rebuilds are deterministic and idempotent for a campaign, summary kind, and through-turn number. A Chronicle rebuild retains validated historical checkpoints, may use the newest validated version 2 checkpoint as a seed, and replays later accepted turns to recreate subsequent projections. Invalid checkpoints are discarded. The accepted-turn ledger remains the recovery source of truth throughout; checkpoints never rewrite turns or campaign state.

Rewinds and latest-turn replacements remove checkpoints beyond the retained turn before rebuilding derived memory. Branches do not copy checkpoints; the destination campaign rebuilds them against its copied accepted ledger. Owner and campaign scope apply to checkpoint selection, validation, deletion, and recreation.

## Consequences

- Historical context uses the newest trustworthy checkpoint without crossing its requested turn boundary.
- Corrupt or stale checkpoints degrade to an older valid checkpoint, a validated living summary, or ledger replay instead of contaminating a prompt.
- Version 1 data remains readable under a deliberately stricter compatibility rule, while version 2 provides deterministic integrity verification.
- Checkpoint validation cannot leak mechanics, private scratchpads, provider details, or rejected output into Chronicle memory.
- Replacements, rewinds, branches, imports, and rebuilds require tests for cutoff selection, invalid hashes, legacy fallback, and deterministic recreation.
