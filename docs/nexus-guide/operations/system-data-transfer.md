# System data transfer

System Archive format version 1 moves the Current Owner's portable library from one Infinite Quest Nexus installation to another. It contains portable stories, worlds, settings, and every retained original image, including unbound and archived Image Library entries. It is a point-in-time logical migration, not a database clone, merge, synchronization service, or disaster-recovery backup.

::: danger Release gate: keep disabled
System Archive is implemented behind `SYSTEM_ARCHIVE_ENABLED=false` and is not approved for production enablement. The API routes are not registered and both Data Transfer clients report **Disabled by operator** while the setting is false. Existing World, Campaign, legacy/external, and readable export workflows remain available.

Current release evidence remains incomplete. Known blockers and incomplete gates include a parked same-kind browser reload/cancellation race; the latest full integration run, which stopped on a Chronicle lease-time assertion before completing the suite even though that file later passed 7/7 alone; a Docker/PostgreSQL expiry test affected by application/database clock divergence; and two Linux-only compiled-service/private-root scenarios that have not run on this Windows host. The focused rerun does not make the interrupted full integration gate green. Do not describe the full integration, Linux, or private-root paths as passed. Enable the capability only after a separate review closes the blockers and records a representative source-to-empty-destination round trip.

In the parked UI race, recovered operation A can overwrite the browser's reference to a newer ambiguously accepted same-kind operation B. **Cancel** can then target A while B remains active. Until this is fixed, do not start another export during export recovery or another import during import recovery. Record every accepted job ID, verify status with the CLI or owner-scoped API, and explicitly cancel every unwanted durable job by its recorded ID.
:::

## Choose the right transfer product

| Need | Use | Destination behavior |
| --- | --- | --- |
| Move one immutable world snapshot | **World JSON** | Import into the current owner's World Library. |
| Move one campaign and its pinned world | **Campaign Archive** | Create a separate campaign or attach it to a compatible world version. |
| Move one owner's complete portable library | **System Archive** | Import only into an empty initialized destination. |
| Save a story for people to read | **Readable Markdown, HTML, or PDF** | No authoritative data import. |
| Restore the same installation after loss | **Operator Recovery Set** | Restore coordinated PostgreSQL, assets, configuration inventory, and separately escrowed encryption material. |

System Archive augments these formats; it does not replace them. It is not the right way to add one campaign or world to a populated destination.

## What format version 1 contains

System Archive exports versioned logical records rather than SQL or table dumps. Portable authority includes:

- the Current Owner's display profile, prompts, and other allowlisted portable settings;
- worlds, immutable versions, drafts, publication state, covers, fork provenance, and authored content;
- campaigns, selected-character snapshots, structured profiles and edits, settings, current state and state edits, world migrations, and transfer provenance;
- accepted turns, resolved input modes, narration corrections, choices, sanitized mechanics-private state, and portable model metadata;
- canonical facts and portable Chronicle memories and summary checkpoints, without embeddings or chunks;
- visible illustration sets, segments, selected and alternate originals, bindings, library metadata, and sanitized fiction-only prompts;
- allowlisted import provenance, provider-reported costs, and user-meaningful activity history; and
- every retained **Original Asset**, including images that are archived or not currently bound to a world, campaign, or turn.

Non-user UUIDs are preserved so relationships remain stable. The one source owner ID is provenance only: every ownership relationship is remapped to the destination installation's generated initial owner.

### Normalized on import

Provider profiles retain only allowlisted non-secret configuration such as provider kind, role, endpoint, selected model, context, timeout, and retry settings. Text, image, and embedding profiles remain distinct. Every imported profile is disabled, has no credential, and has unknown health until an operator reconfigures it.

Visible illustration records are normalized to terminal state consistent with the retained original files. Known image relationships become destination bindings. Rebuildable indexes and thumbnails are queued after authoritative import.

### Deliberately excluded

A System Archive never contains:

- API keys, credential ciphertext, encryption keys, nonces, authentication tags, database credentials, or authorization headers;
- share links, token hashes, sessions, cookies, OIDC identities, external authorization grants, or private delivery/read capabilities;
- generation, image, Chronicle, import, System Archive, admission, lease, retry, progress, or other operational jobs;
- model response chains, raw provider responses, temporary provider URLs, provider health state, or deployment capabilities;
- embeddings, Chronicle chunks/jobs, retrieval candidates/runs, query caches, thumbnails, or other derived files; or
- database URLs, filesystem roots, deployment hostnames, network allowlists, Swarm secrets/configs, worker sizing, or other deployment configuration.

Allowlisted provider configuration is portable content, not deployment configuration. Consequently, sanitized provider endpoint topology—including its host and port—can remain in the archive even though credentials and secret-bearing URL components are removed. Review that exposure before transfer.

The ZIP is not encrypted and has no archive password. Checksums detect corruption but do not authenticate the source. Store and transport it only through trusted encrypted channels and access-controlled storage. Anyone who can read the ZIP can read its portable story, image, and sanitized provider-topology content.

## Destination requirements

Format version 1 accepts exactly one source owner and exactly one empty initialized Destination Instance. The destination must:

- run all required database migrations and a compatible System Archive payload version;
- contain its generated `initial-owner` user but no authoritative owner data;
- have no conflicting active work other than infrastructure evaluating this import; and
- have enough verified free space in both private archive staging and Original Asset storage.

Import never merges, overwrites, synchronizes, or contacts the Source Instance. A second System Import into the now-populated destination fails the emptiness check. Keep the source intact until the destination is verified and cutover is complete.

## Export and download

In a release-approved validation deployment, open **Data Transfer** in Nexus or `/app/data-transfer` in the replacement UI:

1. Confirm the capability reports **Available**.
2. Select **Create System Archive**.
3. Monitor the durable export through capture, write, checksum verification, and publication.
4. Download the published ZIP before it expires.
5. Record the job ID and published ZIP-byte SHA-256/strong ETag with your migration evidence.

Only one export can be active for the Current Owner. Export captures a repeatable-read logical snapshot while unrelated operational work may continue. That work is omitted and reported only as safe category counts. Original files are re-read and verified while the ZIP is written; a missing or changed original fails the export instead of publishing an incomplete archive.

Published downloads support byte ranges, a strong content-hash ETag, `Cache-Control: no-store`, and restart after an interrupted connection. That ETag is the SHA-256 of the exact published ZIP bytes. The default publication lifetime is 24 hours. Export cancellation is accepted only before publication; a published or expired job is terminal.

The official CLI queues the job, monitors it until publication, resumes a partial local download when the ETag still matches, and verifies the completed file hash:

```powershell
pnpm system-archive -- export --base-url https://source.example --output .\nexus-system.zip
```

Use `--idempotency-key` to replay an ambiguously accepted create request without starting a second logical export.

## Resumable upload and Import Preview

The browser and CLI hash the local file, create a durable upload session, and send bounded chunks. The server verifies each chunk's offset, length, and SHA-256, then verifies the assembled file length and hash before opening the archive. Browser JavaScript never opens ZIP entries and never receives a server filesystem path.

Upload state survives an ordinary browser disconnect or process restart. The default inactivity TTL is 24 hours. The CLI prints the upload ID; supply it to resume the same local file and chunk size:

```powershell
pnpm system-archive -- import --base-url https://destination.example --file .\nexus-system.zip --upload UPLOAD_UUID
```

Without `--upload`, the CLI creates a new upload. Its default chunk size is 16 MiB; `--chunk-bytes` can choose a smaller value within the server's configured maximum.

After upload completion, the server creates an **Import Preview**. Preview is read-only and reports:

- archive/application/migration versions and the Archive Fingerprint;
- one source owner and the destination owner mapping;
- record and Original Asset counts and bytes;
- destination emptiness and compatibility;
- disabled provider count and required provider re-entry;
- invalidated external-access categories;
- normalized and deliberately omitted data, including operational category counts;
- Chronicle-index and thumbnail rebuild work;
- staging and asset-root capacity checks; and
- warnings, typed errors, and preview expiry.

A valid preview returns an opaque, short-lived handle bound to the exact logical Archive Fingerprint, destination fingerprint, compatibility decision, capacity preflight, and normalization summary. `archiveFingerprint` is the manifest's logical content fingerprint; it is distinct from the SHA-256/ETag of the container ZIP bytes and the two values are not interchangeable. Preview authority lives for exactly 1,800 seconds (30 minutes), matching the current repository default and compiled-release test invariant. It is not an operator-tunable window. Re-upload or preview again if it expires or if destination authority changes.

The browser cannot raise limits, assert free space, choose a server path, or bypass preview. Unknown free space fails closed unless the operator explicitly enabled the platform-specific override before startup.

## Commit and cancellation boundary

Review the complete preview before committing. System Import requires five explicit acknowledgements:

1. the archive contains sensitive unencrypted content;
2. the destination must be empty;
3. existing external access is invalidated;
4. provider credentials must be re-entered; and
5. import becomes non-cancellable at the authoritative commit boundary.

Interactive CLI use displays Preview first, asks all five questions, and requires the exact logical `archiveFingerprint` returned by that Preview. Noninteractive use additionally requires `--confirm-fingerprint` with that value—not the downloaded ZIP's byte hash—and every acknowledgement flag:

```powershell
pnpm system-archive -- import `
  --base-url https://destination.example `
  --file .\nexus-system.zip `
  --confirm-fingerprint PREVIEW_ARCHIVE_FINGERPRINT `
  --acknowledge-sensitive-archive `
  --acknowledge-empty-destination `
  --acknowledge-invalidated-access `
  --acknowledge-provider-reentry `
  --acknowledge-non-cancellable-boundary
```

Commit revalidates the archive, preview authority, destination emptiness, relationships, and both capacity checks. It may wait for the exclusive mutation gate. While the relational import owns that gate, health/readiness, static UI, and read/status requests remain available; other mutations return `system-import-in-progress`.

Cancellation is allowed while an import is queued, validating, previewed, revalidating, or waiting for the gate. It is no longer allowed once status reaches `importing`. The complete relational graph commits in one database transaction. Original files use rollback-safe private publication: a failed pre-commit import leaves no partial graph, newly created unreferenced files may be removed, and pre-existing shared originals are never removed.

After authoritative commit, the gate clears and the application can be used while Chronicle indexes and thumbnails are queued. A failure in post-commit finalization or rebuild scheduling does not roll back accepted authority; the durable job remains reclaimable so a worker can reconcile and continue.

## Jobs, restart, and status

System Archive jobs and transfer authority are stored in PostgreSQL. Workers heartbeat bounded leases; another worker can reclaim an expired lease after a process stop. Reclaimed imports revalidate durable staged input and reconcile whether authority already committed instead of resuming from an uncertain row.

Use the same job ID after a client restart:

```powershell
pnpm system-archive -- status --base-url https://destination.example --job JOB_UUID --kind export
pnpm system-archive -- status --base-url https://destination.example --job JOB_UUID --kind import
pnpm system-archive -- cancel --base-url https://destination.example --job JOB_UUID --kind export
pnpm system-archive -- cancel --base-url https://destination.example --job JOB_UUID --kind import
```

Terminal export states are `published`, `cancelled`, `failed`, and `expired`. Terminal import states are `completed`, `cancelled`, `rolled_back`, `failed`, and `expired`. Do not delete private staging files manually: durable expiry, lease, fingerprint, and cleanup records are the authority for safe reaping.

## Import Report and destination recovery

The durable Import Report reconciles final records and Original Assets against the Preview. It records the verified fingerprint, versions, owner mapping, disabled providers, normalization, invalidated access, categorized omissions, integrity checks, rebuild state, and terminal diagnostics. Reports and logs omit story bodies, credentials, local paths, raw provider responses, and tokens.

After import:

1. Compare Preview and Import Report record/asset counts and confirm all integrity checks are true.
2. Re-enter credentials separately for text, image, and embedding profiles.
3. Verify endpoint health **and model discovery** for each profile, then explicitly enable the intended profiles and assignments.
4. Monitor Chronicle-index and thumbnail rebuilds. Playable authority is committed before these derived jobs complete, but retrieval quality and thumbnails may be limited until they do.
5. Create new share links and external access. Source sessions, OIDC bindings, and capabilities do not transfer.
6. Open representative worlds and campaigns, verify accepted-turn continuity, state, character profiles, illustrations, and unbound/archived originals.
7. Cut traffic over only after application-level verification. Retain the source and archive according to your migration rollback policy; Nexus never deletes or synchronizes the source.

## Operator configuration

System Archive uses the private `ARCHIVE_STORAGE_ROOT` for durable upload, preview, and export staging and `ASSET_STORAGE_ROOT` for retained Original Assets. API and worker replicas must see the same durable roots and the same PostgreSQL database. See [Runtime configuration](../../installation/environment-configuration.md#system-archive-settings) for exact settings, limits, bounds, and Compose/Swarm injection requirements.

Do not point archive staging at an OS temporary directory. Do not remove a live staged file, edit System Archive job/upload rows, or copy a private server path to a client. Use the API, Data Transfer UI, or official CLI so database and filesystem authority remain coordinated.

### API surface

The CLI and both browser products use only these Current Owner-scoped routes:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/system-exports` | Idempotently queue an export. |
| `GET` | `/api/v1/system-exports/:jobId` | Read export status/report. |
| `DELETE` | `/api/v1/system-exports/:jobId` | Request pre-publication cancellation. |
| `GET` | `/api/v1/system-exports/:jobId/download` | Range-capable published download. |
| `POST` | `/api/v1/system-imports/uploads` | Create a resumable upload. |
| `GET` | `/api/v1/system-imports/uploads/:uploadId` | Read durable upload progress. |
| `PUT` | `/api/v1/system-imports/uploads/:uploadId/chunks/:index` | Send one checksummed byte range. |
| `DELETE` | `/api/v1/system-imports/uploads/:uploadId` | Cancel an upload. |
| `POST` | `/api/v1/system-imports/uploads/:uploadId/complete` | Verify and finalize upload assembly. |
| `POST` | `/api/v1/system-imports/preview` | Validate server-side and issue opaque Preview authority. |
| `POST` | `/api/v1/system-imports` | Idempotently commit the acknowledged Preview. |
| `GET` | `/api/v1/system-imports/:jobId` | Read import status/report. |
| `DELETE` | `/api/v1/system-imports/:jobId` | Request pre-commit cancellation. |

Callers never submit a `user_id`; during the pre-authentication phase the server resolves the database-backed initial owner. Restrict the API to the intended trusted network. When the release gate is disabled, `/api/v1/meta` reports `capabilities.systemArchive: false` and the routes above are unavailable.

## Troubleshooting and observability

| Symptom | Meaning and response |
| --- | --- |
| **Disabled by operator** | Expected while the release gate is closed. Confirm `/api/v1/meta`; do not enable merely to make the control appear. |
| `404` job/upload/download | The identifier is wrong for the Current Owner, the capability is disabled, or a published artifact is no longer available. |
| `409` upload offset/conflict | Resume from the server's durable `receivedBytes`; do not skip a missing prefix or reuse a session for a different file/chunk layout. |
| `410` upload/preview expired | Create or resume a current upload, then obtain a new Preview. |
| `416` download range | The local partial file length no longer matches the artifact. The CLI verifies ETag/length and restarts once from byte zero when safe. |
| Preview says destination is not empty | Use a fresh initialized installation. System Import has no merge or overwrite mode. |
| Capacity is unknown or insufficient | Fix the mount/permissions/capacity probe. Use the unknown-capacity override only after an operator independently verifies space; it does not override a measured shortage. |
| `system-import-in-progress` | The authoritative import holds the exclusive mutation gate. Monitor the import job; do not bypass the gate. |
| Provider is disabled after import | Expected. Supply that role's credential, verify endpoint and model discovery, then enable explicitly. |
| Import remains `authoritative_committed` or `rebuilding` | Authority is present; inspect the sanitized job/report code and worker logs, restore a healthy System Archive worker lane, and allow lease-based reconciliation. Do not re-import into the populated destination. |

Worker logs use the `worker_system-archive_error` event with an allowlisted `errorCode`, not raw archive content. Shutdown logs include `systemArchiveJobs` in the drain count. Correlate API failures by the response correlation ID, job ID, and sanitized code. Never paste the archive, story text, server paths, credentials, or raw provider payloads into tickets or logs.

## System Archive does not replace disaster recovery

System Archive intentionally omits the exact operational and secret material needed to reconstruct a failed installation. A disaster-recovery Recovery Set coordinates PostgreSQL, Original Asset storage, an application/migration/environment inventory, and separately escrowed credential-encryption material. Recovery first targets a matching or explicitly compatible isolated environment; cross-version logical migration is a later System Archive concern.

Keep independent Recovery Sets even after a successful System Archive migration. See [Back up and restore Nexus](../../operations/backup-restore.md).
