# ADR 0032: System Archives preserve portable authority and original assets

## Status

Accepted

## Context

The application database contains authored and accepted story data alongside credentials, deployment-local configuration, active jobs, leases, capability tokens, provider response state, derived indexes, caches, thumbnails, and observability records. Copying every row would move unsafe or meaningless runtime state, while exporting only visibly bound content would omit retained user assets and history.

## Decision

System Archive uses versioned, allowlisted logical records rather than table-shaped dumps. It includes authoritative worlds, versions and drafts; campaigns, accepted turns, corrections, current state and edit history; portable Chronicle text and checkpoints; canonical facts; visible illustration relationships; costs, imports, and provenance; Portable Settings; and every retained Original Asset owned by the Current Owner, including unbound and archived library images.

System Archive excludes credentials, credential ciphertext and encryption material; host and deployment configuration; active or historical operational jobs and leases; model response chains and raw provider responses; temporary filesystem authority; bearer capabilities; provider health state; embeddings, Chronicle chunks and caches; thumbnails and other Derived Assets; and transient observability state. Imported provider profiles retain only portable non-secret configuration and assignments and remain disabled until destination credentials are supplied and validated. Rebuildable data is regenerated on the destination.

Destination import never automatically matches an imported provider to local credentials or a same-named profile. A post-import checklist treats text, image, and embedding providers independently; the operator supplies credentials, verifies model discovery and health, and explicitly enables each profile.

Accepted turn modes, narration corrections, state and character edit history, world migration and transfer provenance, import provenance, provider-reported costs, and allowlisted user-meaningful activity history are portable. Intent-classifier assignments, model names, confidence telemetry, request correlation data, process identity, and provider diagnostics are excluded.

Archive format version 1 is not application-encrypted. The product identifies it as sensitive private content and requires trusted encrypted storage and transport.

An export fails with an actionable report if a declared Original Asset is missing, unreadable, corrupt, or inconsistent with its recorded metadata. It never silently emits a knowingly incomplete archive.

World-share links, bearer token hashes, external identity bindings, and sessions are invalidated rather than transferred. The Import Report identifies affected feature categories and counts without exposing token material.

Errors, reports, progress, and logs may identify safe logical paths, record identifiers, counts, and typed error codes. They never echo story text, credentials, local filesystem paths, raw provider metadata or responses, or token values.

## Consequences

- Archive completeness is defined by domain semantics and explicit contracts rather than by the current table inventory.
- New persistence features must classify their data as authoritative portable data, portable normalized data, rebuildable data, operational state, security authority, or deployment configuration.
- Imports can rebuild derivatives using destination software without reviving stale jobs or access capabilities.
- Users must re-enter provider credentials and regenerate share links after migration.
