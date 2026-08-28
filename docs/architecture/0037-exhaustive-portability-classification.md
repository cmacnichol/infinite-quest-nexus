# ADR 0037: Every persisted domain has an explicit portability classification

## Status

Accepted

## Context

The original System Archive proposal predates later narration-correction, Chronicle chunking, retrieval-observability, capability, and durable-filesystem tables. An allowlisted logical export is safe only if schema growth cannot silently create unclassified authoritative data.

## Decision

The repository maintains one central registry assigning every persisted domain a Portability Classification: portable authority, portable after normalization, rebuildable, operational, security authority, or deployment configuration. The registry records the logical archive domain or explicit exclusion rationale without treating raw table layout as the archive contract.

Schema-inventory tests fail when a migration introduces a persisted domain without a classification. Contract and real-PostgreSQL round-trip fixtures prove representative coverage for every portable category and absence for every excluded category. Review of a migration that changes the meaning of persisted data must revisit its classification even when no table is added.

## Consequences

- Schema evolution cannot silently omit new portable authority from System Archive.
- Security-sensitive and operational exclusions remain reviewable rather than implicit.
- The registry requires maintenance alongside migrations and archive contract adapters.
- Table inventory tests detect classification drift, while domain round trips remain the proof of portable behavior.
