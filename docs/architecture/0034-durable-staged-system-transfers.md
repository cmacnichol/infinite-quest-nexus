# ADR 0034: System transfers are durable, staged, and auditable

## Status

Accepted

## Context

Whole-system exports and imports can exceed an HTTP request lifetime and may be interrupted by application, worker, browser, or host restarts. Import must protect authoritative state and filesystem assets without making validation downtime proportional to archive size.

## Decision

System Export and System Import are durable background operations with observable phases and progress. Export captures one consistent online logical snapshot, streams records and Original Assets, fails rather than publishing inconsistent content, and atomically publishes its completed artifact. Server-side completed artifacts expire after a configurable interval, defaulting to 24 hours, without affecting source data or downloaded copies.

Completed downloads support HTTP ranges, stable ETags, and restart. Browser and headless clients use the same owner-scoped APIs and validation; the headless client has no direct database or filesystem bypass.

The export snapshot contains committed authoritative state only. Active generation, illustration, indexing, or maintenance work may continue but is excluded and summarized by category and count in the report. Export may be cancelled before artifact publication without affecting source data.

System Import uploads an archive once, validates and stages it, verifies compatibility, integrity, free space, and destination emptiness, and returns an Import Preview. Confirmation binds the Archive Fingerprint and destination state. Only the authoritative commit phase acquires the exclusive mutation gate; health, readiness, static UI, and import status remain available while other mutations receive a typed unavailable response.

Logical database records commit atomically. Original Asset publication uses rollback-safe cleanup that never removes pre-existing shared content. An interrupted import does not resume from an uncertain partial row; it revalidates the staged archive and empty destination before restarting the authoritative transaction. Repeated requests are idempotent, but a completed import cannot be applied again to the now-populated destination.

Import may be cancelled during upload, validation, preview, or while queued. It cannot be cancelled after the exclusive authoritative transaction begins. Cancellation removes staged data it exclusively owns. The confirmation experience identifies this boundary before commit.

Whole-system uploads are resumable and stream into bounded persisted staging rather than relying on one browser request or holding an archive in memory. Default limits are 50 GiB compressed, 200 GiB uncompressed, 1,000,000 entries, a 100:1 per-entry expansion ratio, a 5 MiB manifest, 1 GiB per logical shard, and 25 MiB per Original Asset. Deployments may lower these values; raising them requires explicit operator configuration.

Import Preview proves sufficient staging and asset-storage capacity and commit rechecks it. Preview fails closed when capacity cannot be established. A deployment may enable an explicit operator-controlled override for platforms that cannot report free space, but the browser cannot grant that exception.

Only one System Import may be active for the installation, and only one System Export may be active for the Current Owner. Export does not begin while import owns or is waiting for the exclusive gate. Repeated requests with the same idempotency key return the existing job; a request after completion captures a new snapshot.

Default retention is 24 hours after last activity for resumable upload staging, 30 minutes for an Import Preview, and 24 hours for a completed downloadable export artifact. Failed or cancelled staging is cleaned after terminal processing. Import Reports remain durable owner activity until a separate retention policy is adopted.

Authoritative import completion does not wait for Derived Assets or Chronicle indexes. The instance becomes usable with a visible derived-rebuild phase and explicit limitations for disabled providers or unavailable indexes. The operation produces a durable Import Report whose categories correspond to the preview and include versions, fingerprint, domain and asset counts, integrity results, ownership mapping, provider reconfiguration, normalization, rebuild work, warnings, and errors.

## Consequences

- Large transfers survive browser disconnects and expose honest progress.
- Expensive validation happens before the import downtime window.
- Atomic logical writes and rollback-safe asset handling prevent half-imported installations.
- Users can distinguish authoritative restoration from background optimization work.
- Job, staging, expiry, retry, and cleanup behavior require explicit persistence and operational tests.
