# ADR 0036: Disaster recovery is an operator-managed isolated restore

## Status

Accepted

## Context

Exact installation recovery requires database contents, externally stored assets, encryption material, and deployment knowledge. These materials carry administrative authority and cannot safely share the browser permissions or cross-version guarantees of portable user archives.

## Decision

Disaster-Recovery Backup is an operator-only CLI and runbook workflow. It creates and verifies a Recovery Set containing a PostgreSQL logical dump, Original Asset storage, application/database/extension and migration inventory, counts, integrity checks, and restore instructions. Credential-encryption keys and deployment secrets are escrowed separately and are never placed in the ordinary recovery archive or exposed through the application UI.

The repository provides `create`, `inspect`, `verify`, `restore`, and `drill` operations with machine-readable manifests and reports. Commands accept operator-selected paths or streams. External schedulers and backup platforms own scheduling, remote storage, replication, and retention; Nexus does not embed vendor-specific cloud backup behavior.

Recovery capture uses a controlled maintenance window that stops application mutations and workers. A deployment may substitute an explicitly supported atomic database-and-volume snapshot mechanism. An uncoordinated live database dump and filesystem copy is never described as a complete Recovery Set.

Nexus does not define bespoke recovery-archive cryptography. Recovery commands support streaming into operator-approved encrypted tooling, and the runbook requires encrypted storage and transport. Reports never contain encryption keys or deployment secrets.

A Recovery Set restores first into a matching or explicitly compatible application, PostgreSQL, and extension environment. After recovery is verified, normal application migrations may move the installation forward. Cross-version logical conversion remains the responsibility of System Archive.

Restore always targets isolated, empty database and asset storage. Operators verify readiness, ownership, story continuity, representative assets, credential decryption, and Chronicle recovery before controlled cutover. The workflow never restores over the only production copy or mutates its source Recovery Set.

Recovery evidence distinguishes **Created**, **Verified**, and **Drill proven** states. Only a recent Drill-Proven Recovery Set is demonstrated recoverable. Automated retention must never delete the last Drill-Proven Recovery Set.

## Consequences

- Administrative secrets and exact runtime state remain outside user-facing Data Transfer permissions.
- The encryption key is required for complete recovery but can be protected under separate custody.
- Restore procedures must record environment compatibility and verification evidence.
- Operators need an isolated restore target and an explicit cutover plan.
- Recovery automation must coordinate maintenance mode or a supported atomic snapshot and must integrate with external secret custody, encrypted storage, scheduling, and retention.
