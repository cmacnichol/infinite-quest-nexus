# ADR 0030: Separate System Archives from disaster recovery

## Status

Accepted

## Context

Users need to move all of their Infinite Quest content to another instance, while operators need to recover an installation after data loss. A raw database copy cannot safely satisfy both needs: it includes deployment-specific operational state and encrypted credentials, while omitting externally stored assets and encryption material unless those are coordinated separately.

## Decision

Infinite Quest will provide two distinct products. A **System Archive** is a versioned logical migration format containing portable authoritative application data and original assets. A **Disaster-Recovery Backup** is an operator-managed recovery set containing the database, asset storage, and the encryption material and deployment configuration needed to restore an installation.

System Archive will augment and unify the existing import and export experience. Specialized World JSON, Campaign Archive, legacy import, Infinite Worlds import, and readable story export workflows remain supported for their narrower purposes; they are not replaced by the whole-system workflow.

The existing proposed System Archive design will be revised against the current schema rather than replaced with an unrelated design. Record-level portability, identity mapping, destination conflict behavior, secrets, derived data, and compatibility details are decided separately and documented before implementation.

## Consequences

- Cross-instance migration does not silently transfer credentials, deployment authority, or resumable operational state.
- Disaster recovery remains capable of exact installation recovery but requires stricter operator handling of secrets and encryption material.
- Existing portable and readable formats remain stable user-facing contracts while shared validation, staging, preview, and progress infrastructure can be unified internally.
- Product and UI language must reserve **backup** for disaster recovery and use **System Archive** for portable whole-system migration.
