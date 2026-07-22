# ADR 0018: Canonical facts use structured, rebuildable projections

## Status

Accepted

## Context

Chronicle currently supersedes canonical facts by comparing normalized text. A correction expressed with different wording can therefore leave an obsolete or contradictory fact active. Facts must support precise correction without making a derived memory index authoritative or weakening campaign and ownership boundaries.

## Decision

Accepted turn state snapshots carry structured canonical fact updates with explicit `supersedesFactIds`. Chronicle deterministically derives a stable identifier for every projected fact from its campaign, source turn, fact index, and sanitized content. The application validates supersession references against facts visible to the same owner and campaign at that turn. Chronicle projects the snapshots into one record per fact, including its source turn, active or superseded status, replacement reference when present, entity references, and provenance.

Identifier-based supersession is the primary path. Normalized-text matching remains only as a compatibility fallback while importing or rebuilding legacy snapshots that predate stable fact identifiers; new accepted snapshots must not depend on it.

The accepted turn ledger and its typed state snapshots remain authoritative. Structured fact records are derived, rebuildable projections and never rewrite accepted history. Rebuilds reproduce identifiers and supersession relationships from the snapshots rather than asking a model to infer them again.

Every projection, lookup, supersession, and retrieval query is constrained by owner and campaign. Historical or replacement generation additionally selects only facts established at or before its turn cutoff and applies only supersession events visible by that cutoff. Reusable world canon remains separately scoped by world and immutable world version.

## Consequences

- Paraphrased corrections can retire the intended fact without relying on string equality.
- Fact history and provenance remain inspectable while normal retrieval returns only facts active at the requested point in time.
- Chronicle can be deleted and rebuilt without losing canonical campaign state.
- Legacy imports require a bounded text-matching compatibility path until their snapshots are upgraded.
- Schema, contracts, validation, rebuild logic, and retrieval tests must evolve together, including owner, campaign, and historical-cutoff isolation tests.
