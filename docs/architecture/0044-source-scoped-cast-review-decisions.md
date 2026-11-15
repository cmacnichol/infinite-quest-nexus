# ADR 0044 — Source-scoped cast review decisions

## Status

Accepted 2026-11-14. Contracts and storage are additive; review controls remain unavailable until their readers and writers are implemented.

## Decision

Pending discovery dismissals form a campaign- and owner-scoped operational journal, separate from authoritative cast facts. A campaign-scoped sequence advances for every new decision under the existing campaign lock, so duplicate candidates share one review fence. A restore references the dismissal it reverses. Decisions are immutable while their scoped campaign and source turn remain; explicit campaign deletion or source-turn removal cascades only the associated operational decisions. Deleting a retained-source candidate alone is rejected. The stored source and original target provide collision-safe comparison alongside a versioned fingerprint; source validity and timeline reconciliation remain separate checks. Fingerprints ignore candidate and job identifiers and normalize identity names and alias order, but preserve detail values, speakers and evidence exactly. New evidence and corrected narration remain reviewable.

Legacy candidate `detail_decisions` dismissals remain readable as compatible suppressions for their retained source. Do not import legacy accepts or confirms as dismissals, rewrite old records, or silently undo them. Operational decisions are excluded from portable archives and branches; those workflows may review discoveries again.

Recorded fact retractions are separate authoritative campaign edits, not discovery dismissals, and must survive supported archive, branch and transfer workflows. Their readers and portable representations must precede any writer. Explicit supersession edges remain authoritative even if a superseding fact is retracted.

## Consequences

The new table and sequence have no live write path yet. A future repository must validate retained source, ownership, generation locks, revisions and idempotent receipts atomically, comparing stored payloads as well as fingerprints. Older binaries may ignore this additive schema while no decisions are written; after writes, preserve the schema and data. Rollback must not drop retained decisions: use compatible readers or a reviewed restore. No production migration or deployment is authorized by this decision.
