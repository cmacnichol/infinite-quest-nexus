# ADR 0029: Chronicle turn retrieval audits are versioned, atomic provenance

## Status

Accepted

## Context

Chronicle retrieval can use legacy or chunked hybrid implementation, semantic or
lexical execution, a dedicated embedding provider or the explicit text-role
fallback, and either cached or live query vectors. A completed turn must make
that observed production path inspectable without turning diagnostics into
authority or exposing sensitive retrieval inputs and provider details.

Accepted `turns.model_metadata` is the only persistence location for this
provenance. Accepted turns remain immutable: existing, imported, and historical
rows are not migrated, backfilled, or inferred.

## Decision

New accepted turns may store a versioned `chronicleRetrieval` value in
`model_metadata`. The v1 contract records the configured and effective
implementation, effective retrieval mode, sanitized fallback code, resolved
provider role and safe provider/model labels, vector path, call outcome, and
request/cache counters. Its schema rejects contradictory combinations.

Missing, malformed, or imported audit data projects as `null`, and UI presents
it as `Unknown — this turn predates retrieval auditing or came from an import
without audit metadata.` A known lexical-only execution is never represented
by `null`; it carries a complete v1 audit and an applicable sanitized fallback
code.

The audit records only the actual production path. Optional operational shadow
telemetry remains separate, retention-bound, and expiring; it never changes
the accepted-turn audit or establishes turn authority.

The audit must not store a provider profile ID, provider fingerprint, endpoint,
credentials, raw action/query/narration, memory content, provider response,
candidate identifier, or raw error.

Corrections preserve their accepted turn's audit. Branch and transfer copy the
existing accepted audit with the copied turn. A replacement turn observes and
records a new audit. Portable exports omit this audit, so an imported turn
projects to `null` rather than implying source-installation provenance.

## Rollback

Rollback removes the write, read, and UI projection paths. Existing JSONB keys
are harmless historical data and need not be deleted. Rollback does not update
accepted turns, run a migration, or backfill audit values.

## Consequences

- Turn provenance is inspectable only when it was observed at acceptance time.
- Historical uncertainty remains explicit instead of being fabricated from
  configuration or derived state.
- Retrieval diagnostics retain their privacy boundary while production behavior
  remains distinguishable from shadow experiments.
