# ADR 0031: Import System Archives only into empty destinations

## Status

Accepted

## Context

A System Archive must recreate one owner's interconnected data without treating source identity as destination authorization. Merging a whole owner graph into a populated destination would require conflict rules for immutable versions, append-only turns, assets, prompts, providers, provenance, and future collaborators. Destructive replacement would put unrelated destination data at risk.

## Decision

System Archive format version 1 contains exactly one Current Owner. System Import accepts only a fully migrated destination containing its generated initial owner and no authoritative owner data or active operational work.

Import preserves portable non-user record identities so the restored graph remains internally stable. It replaces every source ownership relationship with the destination's initial owner identity. The source owner identity remains provenance only and never establishes authorization. Archives containing multiple source owners are rejected.

System Import never merges into or replaces a populated destination. Specialized Campaign Archive and World JSON imports remain the supported additive workflows for populated instances.

System Archive is a point-in-time transfer, not replication. Import never contacts, locks, mutates, or deletes the Source Instance. Later source changes do not synchronize, and another System Archive cannot merge them into the populated Destination Instance. Source retention or decommissioning is a separate owner decision after destination verification.

## Consequences

- Destination conflicts and partial merge semantics are eliminated from format version 1.
- Repeating an import into the same destination fails the emptiness check instead of duplicating or overwriting records.
- Future multi-user or collaborative archives require a new identity-mapping and authorization decision rather than silently extending this contract.
- Preview and commit must both verify destination emptiness because destination state can change between them.
