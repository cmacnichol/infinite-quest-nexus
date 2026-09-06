# Portable Campaign and System Archives Design

**Status:** Accepted for implementation planning

**Originally proposed:** 2026-07-26

**Revised:** 2026-08-24

## Summary

Infinite Quest Nexus will add a whole-owner **System Archive** without removing its specialized portable formats. A System Archive is a versioned logical migration of the Current Owner's portable authoritative data, Portable Settings, and every retained Original Asset. It imports only into an empty initialized Destination Instance.

A System Archive is not a **Disaster-Recovery Backup**. Exact recovery remains an operator-managed Recovery Set containing PostgreSQL, asset storage, environment inventory, and separately escrowed encryption material. The products have different trust, compatibility, and operational contracts.

This revision replaces the original migration-0042-era assumptions. The live schema now extends through migration `0077_chronicle_chunk_processed_signature`, so implementation must classify every persisted domain instead of treating the July table inventory as permanently complete.

## Decision authority

This specification implements:

- [ADR 0030: Separate System Archives from disaster recovery](../../architecture/0030-separate-system-archives-from-disaster-recovery.md)
- [ADR 0031: Import System Archives only into empty destinations](../../architecture/0031-empty-destination-system-imports.md)
- [ADR 0032: System Archives preserve portable authority and original assets](../../architecture/0032-system-archives-preserve-portable-authority.md)
- [ADR 0033: System Archives use versioned deterministic logical contracts](../../architecture/0033-versioned-deterministic-system-archives.md)
- [ADR 0034: System transfers are durable, staged, and auditable](../../architecture/0034-durable-staged-system-transfers.md)
- [ADR 0035: Unify portable data transfer without removing specialized formats](../../architecture/0035-unified-data-transfer-experience.md)
- [ADR 0036: Disaster recovery is an operator-managed isolated restore](../../architecture/0036-operator-managed-disaster-recovery.md)
- [ADR 0037: Every persisted domain has an explicit portability classification](../../architecture/0037-exhaustive-portability-classification.md)

Canonical vocabulary lives in the repository-root `CONTEXT.md`.

## Goals

- Export the Current Owner's complete portable logical state and every retained Original Asset into one deterministic archive.
- Import it into a fresh migrated instance without the source database, source filesystem, or provider credentials.
- Preserve non-user application identities and relationships while mapping source ownership to the destination initial owner.
- Preserve Campaign Archive, World JSON, legacy story, Infinite Worlds, CYOA, text import, and readable export behavior.
- Make large uploads and downloads resumable and long-running work durable across browser and process restarts.
- Validate safety, integrity, relationships, compatibility, image bytes, destination emptiness, and storage capacity before mutation.
- Produce matching previews and durable reports proving what was promised, imported, normalized, omitted, and queued for rebuild.
- Keep Disaster-Recovery Backup a separate operator workflow with isolated restore verification.

## Non-goals

- Live merge or destructive replacement of a populated destination.
- Multi-owner, collaborator, OIDC identity, session, or authorization migration in format version 1.
- Source-to-destination synchronization or incremental replication.
- Exporting credentials, encrypted credential material, encryption keys, bearer capabilities, deployment configuration, raw provider state, or operational jobs.
- Resuming generation, illustration, Chronicle, asset-publication, remote-provider, or filesystem operations on another instance.
- Preserving embeddings, Chronicle chunks, query caches, thumbnails, or other rebuildable data.
- Treating checksums or a future signature as proof of source authorization.
- Application-level archive encryption in format version 1.
- Embedding cloud storage, scheduling, replication, or retention vendors in Disaster-Recovery tooling.

## Existing behavior that remains supported

The application already provides World JSON, Campaign Archive ZIP, manifest-less campaign ZIP, portable campaign JSON, `.story`, Infinite Worlds JSON, CYOA JSON, world-editor TXT, matching story TXT, and readable Markdown/HTML/PDF workflows. System Archive augments them. Compatibility Adapters remain until an announced deprecation period and tested conversion path exist.

The Campaign Archive foundation already supplies strict paths, manifests, checksums, bounded ZIP inspection, content-addressed originals, preview authority, rollback-safe publication, typed diagnostics, and durable private filesystem operations. System Archive extends those boundaries instead of adding a second direct-filesystem service.

## Product boundaries

### System Archive

A point-in-time, cross-instance logical transfer for exactly one Current Owner. It contains portable application authority and originals, not a physical PostgreSQL or deployment copy.

### Disaster-Recovery Backup

An operator-managed Recovery Set containing a PostgreSQL logical dump, Original Asset storage, version and migration inventory, integrity evidence, and restore instructions. Encryption keys and deployment secrets remain under separate custody. Recovery first targets a matching or explicitly compatible application, PostgreSQL, and extension environment; cross-version conversion belongs to System Archive.

### Specialized portable formats

World JSON, Campaign Archive, legacy and external imports, and Readable Story Exports retain their narrower scopes. System Archive is not the mechanism for adding one campaign or world to a populated destination.

## Portability classification

Every persisted domain has one central Portability Classification. A migration that adds or changes persisted meaning updates the registry. Schema-inventory tests reject unclassified domains.

### Portable authority

Versioned logical projections include:

- Current Owner display profile and preferences;
- worlds, immutable versions, drafts, publication state, fork provenance, and covers;
- campaigns, settings, selected-character snapshots, structured profiles, profile edits, current state, and state edits;
- accepted turns, resolved input modes, narration corrections, timestamps, choices, sanitized mechanics-private state, and sanitized model metadata;
- world migrations and cross-world transfer provenance;
- structured canonical facts;
- campaign memory and illustration configuration;
- Chronicle memories without vectors and summary checkpoints, including imported full-history checkpoints;
- visible illustration sets, segments, selected and alternate originals, and sanitized fiction-only prompts;
- import provenance, provider-reported cost events, and allowlisted user-meaningful activity history; and
- assets, references, library metadata, sanitized generation contexts, and every retained Original Asset, including unbound and archived library entries.

### Portable after normalization

- Provider profiles retain non-secret kind, role, endpoint, model, context, retry, timeout, and explicitly allowlisted configuration.
- Provider assignments remain, but imported providers are disabled, credentialless, and reset to unknown health.
- Visible illustration records normalize to terminal states consistent with imported originals.
- Known image relationships become explicit bindings and destination asset URLs.
- Activity metadata is allowlisted and recursively secret-redacted.

### Rebuildable

Excluded and rebuilt data includes embeddings, Chronicle chunks and jobs, processed signatures, skip reasons, retrieval candidates and runs, query-embedding caches, thumbnails, asset derivatives, and eligible indexes. Authoritative import completes before rebuilds; the UI shows rebuild status and limitations.

### Operational

Generation, attempt, model-chain, image, illustration, Chronicle, world-generation, asset-maintenance, admission-control, archive-preview, upload, publication, filesystem, lease, retry, progress, and recovery rows are excluded. Active work may continue during export but is summarized only by safe category and count.

### Security authority

Encrypted API keys, nonces, authentication tags, key versions, decrypted credentials, credential-encryption keys, database credentials, share links, token hashes, OIDC identities, sessions, cookies, authorization grants, private delivery/read capabilities, temporary provider URLs, and authorization headers are excluded.

### Deployment configuration

Database URLs, filesystem roots, Swarm secrets/configs, hostnames, CORS/CSP/network allowlists, trust-proxy settings, worker sizing, admission limits, migration controls, and host or capacity policy are excluded.

## Shared archive container

Format version 1 is a deterministic ZIP:

```text
manifest.json
system.json
records/owner.json
records/providers/000001.ndjson
records/prompts/000001.ndjson
records/worlds/000001.ndjson
records/world-versions/000001.ndjson
records/world-drafts/000001.ndjson
records/campaigns/000001.ndjson
records/turns/000001.ndjson
records/turn-corrections/000001.ndjson
records/campaign-state/000001.ndjson
records/campaign-history/000001.ndjson
records/canonical-facts/000001.ndjson
records/chronicle/000001.ndjson
records/illustrations/000001.ndjson
records/imports/000001.ndjson
records/cost-events/000001.ndjson
records/activity-events/000001.ndjson
assets/assets.json
assets/sha256/<prefix>/<content-hash>.<extension>
```

Logical streams do not mirror table rows. Each NDJSON line is an independently validated envelope with domain and payload versions. A shard closes before 256 MiB; the absolute configured JSON-entry limit is 1 GiB.

`manifest.json` records the shared format and version, `archiveType: "system"`, archive ID and time, source application and migration watermark, exactly one source-owner provenance descriptor, payload versions, exact entry metadata, and the Archive Fingerprint.

The Archive Fingerprint hashes canonical logical payload hashes and sorted Original Asset hashes. It excludes archive ID, creation time, compression metadata, and build metadata. Original filenames derive from content hashes; duplicate bytes share one ZIP entry while logical records and bindings remain distinct.

## Compatibility

- Container and payload versions evolve independently.
- Compatible additions within a major version define explicit defaults.
- Breaking contracts create a new major version.
- Newer applications import supported older logical payloads through explicit Compatibility Adapters.
- Older applications reject unsupported newer archives before mutation.
- A published format is not retired without a standalone conversion path.
- Archives never contain or execute SQL or source migrations.
- A newer migration watermark is accepted only when logical payload versions are supported.
- System Archive has no manifest-less compatibility mode.

## Archive safety

Every archive is untrusted. Before Import Preview, the server rejects absolute paths, drive prefixes, traversal, backslashes, control characters, links, special files, duplicate normalized names, undeclared or multiply declared entries, limit violations, invalid images, invalid metadata, and broken logical relationships. It verifies every byte length and SHA-256 value, parses strict UTF-8 schemas, and uses explicit nested-metadata allowlists.

Checksums detect corruption but do not authenticate the source. A future detached signature cannot establish ownership or bypass validation.

Default limits are 50 GiB compressed, 200 GiB uncompressed, 1,000,000 entries, a 100:1 per-entry expansion ratio, a 5 MiB manifest, a 1 GiB JSON/NDJSON entry, and a 25 MiB Original Asset. Deployments may lower them; raising them requires explicit operator configuration.

## Ownership and destination

Format version 1 contains exactly one source owner. Import rejects multiple-owner archives.

The Destination Instance must have all required migrations, exactly its generated initial owner, no authoritative owner data, and no active operational work other than infrastructure evaluating the current import.

Import preserves portable non-user UUIDs and remaps every ownership relationship to the destination initial owner. Source owner IDs are provenance only. System Import never merges, overwrites, or synchronizes, and the Source Instance remains untouched. A second import into the populated destination fails the emptiness check.

## Durable transfer model

### System Export

```text
queued -> capturing -> writing -> verifying -> published -> expired
   \-> cancelling -> cancelled
   \-> failed
```

At most one export is active for the Current Owner. It captures a repeatable-read logical snapshot, keyset-streams deterministic records, inventories originals, and re-verifies each original while writing. Active operational work is excluded. Cancellation is allowed before publication.

Completed artifacts publish atomically, expire server-side after 24 hours by default, and support HTTP ranges, stable ETags, restart, `Cache-Control: no-store`, and owner-scoped authorization.

### Resumable upload and preview

```text
uploading -> uploaded -> validating -> previewed -> commit-queued
    \-> cancelled | failed | expired
previewed -> superseded | expired
```

Browser and CLI clients create an upload session and send bounded chunks with index, byte range, length, and SHA-256. Completion verifies assembled length and hash before archive inspection. The 2 GiB request ceiling remains a per-request boundary; no request approaches the 50 GiB archive limit.

Upload staging expires 24 hours after last activity. Import Preview expires after 30 minutes and binds archive fingerprint, compatibility, destination fingerprint, storage preflight, and normalization summary. Preview and commit prove staging and asset-root capacity; failure to establish capacity fails closed unless an operator enables a platform-specific override.

### System Import

```text
commit-queued -> revalidating -> waiting-for-gate -> importing
      \-> cancelled | failed
importing -> authoritative-committed -> rebuilding -> completed
      \-> rolled-back -> failed
```

Only one import is active for the installation. It revalidates archive, compatibility, emptiness, and capacity before acquiring the exclusive mutation gate. Health, readiness, static UI, and import status remain available; all other mutations return `system-import-in-progress`.

The relational graph commits in one transaction. Original publication uses the existing private durable publication boundary and rollback-safe cleanup. Newly created unreferenced files may be removed after rollback; pre-existing shared originals are never removed.

Import can be cancelled before `importing`. A crash never resumes at an uncertain row: the job revalidates staged input and an empty destination before a new transaction. After commit, the gate clears and the app is usable while thumbnail and Chronicle rebuilds continue. Rebuild failure remains visible and retryable without rolling back authority.

## API contract

```text
POST   /api/v1/system-exports
GET    /api/v1/system-exports/:jobId
DELETE /api/v1/system-exports/:jobId
GET    /api/v1/system-exports/:jobId/download

POST   /api/v1/system-imports/uploads
PUT    /api/v1/system-imports/uploads/:uploadId/chunks/:index
GET    /api/v1/system-imports/uploads/:uploadId
DELETE /api/v1/system-imports/uploads/:uploadId
POST   /api/v1/system-imports/uploads/:uploadId/complete
POST   /api/v1/system-imports/preview
POST   /api/v1/system-imports
GET    /api/v1/system-imports/:jobId
DELETE /api/v1/system-imports/:jobId
```

Create and commit requests require idempotency keys. Chunk requests are independently bounded and idempotent. Preview consumes an opaque completed-upload handle. Commit consumes the matching preview handle and destination fingerprint plus explicit acknowledgement of the empty-destination and non-cancellable boundaries.

An official headless CLI uses these APIs for create, inspect, download, upload, preview, confirm, cancel, and monitor. It has no direct database or filesystem bypass.

## Preview and report

Import Preview reports archive and application versions, fingerprint, source-owner count, logical and asset counts, destination emptiness, owner mapping, provider reconfiguration, invalidated external access, normalization and omissions, rebuild work, capacity checks, warnings, and typed errors.

The durable Import Report uses the same categories and records final verified counts, integrity, owner mapping, disabled providers, normalization, invalidated access, rebuild status, and terminal diagnostics. Reports, APIs, progress, and logs never echo story text, credentials, local paths, raw provider metadata/responses, or tokens.

## Data Transfer experience

Nexus and the replacement UI expose one **Data Transfer** area for System Archive, World and Campaign Archives, legacy and external imports, and Readable Story Exports. Existing contextual actions remain.

The server detects the exact format and returns the correct preview. Browser JavaScript never opens archive entries. Pasted data stays limited to supported JSON and text workflows.

System Import requires acknowledgement of archive sensitivity, empty destination, invalidated access, provider credential re-entry, and the non-cancellable boundary. After import, Data Transfer shows the provider checklist, rebuild status, and Import Report. It never offers source synchronization or deletion.

## Provider and access recovery

Imported text, image, and embedding profiles remain distinct and disabled. Nexus never matches credentials or same-named profiles automatically. The operator supplies each credential, verifies health and model discovery, and explicitly enables it.

Share links, token hashes, sessions, OIDC bindings, and external authorization do not transfer. The owner creates new access relationships on the Destination Instance.

## Disaster-Recovery contract

The operator CLI provides `create`, `inspect`, `verify`, `restore`, and `drill`. Capture uses a maintenance window stopping writers and workers unless the deployment supplies an explicitly supported atomic database-and-volume snapshot.

Commands accept paths or streams and produce machine-readable manifests and reports. External tooling owns encrypted storage/transport, scheduling, replication, and retention. Nexus defines no bespoke backup encryption and never embeds the credential-encryption key in the ordinary Recovery Set.

Evidence distinguishes Created, Verified, and Drill proven. Restore targets isolated empty storage and never overwrites the only production copy. Automated retention never deletes the last Drill-Proven Recovery Set.

## Rollout and exposure

Implementation lands in independently reviewable phases behind a default-off runtime capability. Public System Archive API and UI remain unavailable until export/import round-trip proof succeeds. Existing formats remain available throughout.

System Archive and Disaster-Recovery have separate implementation plans. Either can be reviewed and tested without pretending the other is complete.

## Verification requirements

Required proof includes:

- contract, normalization, classification, safety, cancellation, and lifecycle unit tests;
- real PostgreSQL export/import, emptiness, rollback, concurrency, and idempotency tests;
- real filesystem publication and cleanup tests on Windows and Linux where semantics differ;
- compatibility fixtures for every existing format and supported System Archive version;
- worker, transaction, stream, process, disk, malicious ZIP/image/path, and metadata fault tests;
- rendered browser tests for Nexus and the replacement UI;
- headless API/CLI range and resumable-transfer tests;
- an isolated Disaster-Recovery Restore Drill; and
- `pnpm check`, unit/integration tests, `pnpm build`, docs build, and `git diff --check`.

A skipped PostgreSQL, filesystem, platform, or browser suite is unverified, never passed.

## Acceptance criteria

System Archive is complete only when a representative owner-wide source exports and a fresh destination imports playable worlds and campaigns, preserved identities/state/history/images/settings, remapped ownership, disabled credentialless providers, invalidated external access, and reconciled preview/report counts. Secrets, jobs, leases, vectors, chunks, thumbnails, capabilities, model chains, and raw provider state must be absent. Existing formats must still work, and corrupt or interrupted imports must leave no partial graph or orphan originals.

Disaster-Recovery tooling is complete only when a coordinated Recovery Set is created, verified, restored into isolation, and passes the application Restore Drill without modifying the source installation or its only backup.
