# Portable Campaign and System Archives Design

**Status:** Proposed for written-spec review

**Date:** 2026-07-26

## Summary

Infinite Quest Nexus will provide two distinct ZIP-based portability features:

1. **Campaign Export** creates a standalone archive for one campaign, the exact
   immutable world version pinned to that campaign, and every original image
   associated with either the campaign or that pinned world snapshot.
2. **System Export** creates an owner-wide logical archive containing all
   portable authoritative application data and the complete original asset
   library. System Import is exposed as its own option in the existing Import
   screen and is accepted only by an otherwise-empty Nexus database.

The two archive types share manifest, integrity, asset, and archive-safety
contracts, but they have different identity and conflict semantics. Campaign
Import creates destination identities and remaps references. System Import
preserves application record identities while mapping the source initial owner
to the destination database's initial owner.

Neither archive type contains provider credentials, encryption material,
leases, private model response chains, or resumable remote-provider state.
System Export is therefore a portable logical migration format, not a
replacement for an operator-managed PostgreSQL, secrets, and filesystem
disaster-recovery backup.

## Goals

- Make a Campaign Export sufficient to import and run that campaign on another
  Nexus installation without separately exporting its world or copying image
  storage.
- Make a System Export sufficient to migrate all portable owner data and
  original image assets into a new, empty Nexus database.
- Preserve authoritative world, campaign, turn, state, provenance, cost, prompt,
  and Chronicle content without trusting source UUIDs as destination
  authorization.
- Preserve original image bytes and their logical relationships while using the
  destination's existing content-addressed asset store and image validation.
- Detect corruption, truncation, missing assets, unsupported archive versions,
  and unsafe ZIP structures before writing authoritative records.
- Keep repeated Campaign Imports idempotent by archive content fingerprint.
- Keep System Import deterministic by requiring an empty destination and
  preserving non-user application UUIDs.
- Keep existing portable world JSON, portable campaign JSON, and legacy
  campaign ZIP imports compatible.

## Non-goals

- Exporting API keys, encrypted credentials, credential nonces, authentication
  identities, Docker secrets, database credentials, or encryption keys.
- Moving active generation, Chronicle, image, illustration refinement,
  resolution, or backfill jobs between installations.
- Resuming LM Studio response chains or remote image-provider jobs after import.
- Treating System Export as a live database merge into an installation that
  already contains user content.
- Supporting multiple source owners in System Archive format version 1.
- Encrypting archive files in format version 1. The UI must warn that archives
  contain private story content and must be stored and transferred securely.
- Preserving generated thumbnails or embedding vectors. Both are rebuilt from
  authoritative imported data.
- Importing arbitrary database rows or SQL supplied by an archive.

## Existing baseline

The current implementation already:

- exposes `GET /api/v1/campaigns/:campaignId/export`;
- writes `campaign.json` and collected image bytes to a ZIP when filesystem
  asset storage is available;
- accepts campaign ZIP files in the management UI;
- reads `campaign.json` and `assets/` entries during multipart campaign import;
- imports selected world-cover and turn-image bytes through asset persistence;
- supports portable campaign JSON and portable world JSON import;
- strips provider credentials from current campaign payloads.

The baseline does not yet establish the required standalone guarantees:

- the ZIP has no versioned root manifest or per-entry checksums;
- asset discovery mixes relational references with UUID extraction from URLs;
- image MIME type is not declared by a trusted archive contract during import;
- selected image import paths assume PNG;
- missing, unreadable, or invalid assets are silently ignored;
- ZIP parsing buffers the complete upload and does not define protection against
  duplicate normalized names, path traversal, expansion bombs, or entry-count
  exhaustion;
- the archive does not contain a separate canonical portable world payload;
- campaign asset bindings are implicit rather than explicitly remappable;
- System Export and System Import do not exist.

The new work will evolve the baseline rather than introduce a second unrelated
campaign format.

## Design principles

### Logical records, not table dumps

Archive payloads are versioned domain contracts. They may carry source UUIDs,
timestamps, and provenance, but they do not contain SQL, database sequences,
constraint definitions, or opaque `SELECT *` output. Import code validates each
record and writes through explicit, ownership-scoped persistence logic.

### Originals are portable; derivatives are rebuildable

Every included asset represents an original PNG, JPEG, WebP, or GIF accepted by
the asset service. Thumbnails are not exported. The destination regenerates
derivatives with its current transform version.

### Archive relationships are explicit

Asset bindings identify roles and source record IDs. Import must not discover
authoritative relationships by searching arbitrary text for UUID-shaped
substrings. Known legacy image URL fields may be read only by the compatibility
adapter for pre-manifest campaign archives.

### Validation precedes mutation

The importer completes ZIP safety checks, manifest validation, entry checksum
verification, image signature and metadata verification, compatibility checks,
and conflict preflight before creating authoritative domain records.

### Missing data fails closed

An export that claims to contain an asset must contain readable bytes matching
the asset's declared length, MIME type, and SHA-256 hash. Export fails with a
list of affected asset IDs if this cannot be satisfied. Import rejects an
archive when any required entry is absent, corrupt, duplicated, or invalid.

## Shared archive format

Both archive types use a root `manifest.json` with this logical shape:

```json
{
  "format": "infinite-quest-archive",
  "formatVersion": 1,
  "archiveType": "campaign",
  "archiveId": "4ad1bf8e-32b2-4caf-8e70-5e193a1025c0",
  "createdAt": "2026-07-26T18:00:00.000Z",
  "applicationVersion": "1.0.0",
  "databaseMigration": "0042_json_illustration_refinement_prompt",
  "sourceOwner": {
    "systemKey": "initial-owner"
  },
  "contentFingerprint": "sha256-lowercase-hex",
  "payloads": [
    {
      "kind": "campaign",
      "path": "campaign.json",
      "formatVersion": 3
    }
  ],
  "entries": [
    {
      "path": "campaign.json",
      "logicalType": "campaign",
      "mediaType": "application/json",
      "byteLength": 1234,
      "sha256": "sha256-lowercase-hex"
    }
  ]
}
```

The concrete schema has these rules:

- unknown root fields are rejected for format version 1;
- `archiveType` is exactly `campaign` or `system`;
- every non-directory ZIP entry except `manifest.json` appears exactly once in
  `entries`;
- every manifest entry resolves to exactly one normalized ZIP entry;
- paths use forward slashes, lowercase fixed directory names, and no leading
  slash, drive prefix, `.` segment, `..` segment, backslash, NUL, or control
  character;
- symlink and special-file entries are rejected;
- duplicate names are rejected after Unicode normalization and
  case-insensitive comparison;
- `sha256` is lowercase hexadecimal SHA-256 of the uncompressed entry bytes;
- `byteLength` is the exact uncompressed byte length;
- JSON is UTF-8 without a byte-order mark;
- records and manifest arrays are emitted in deterministic order;
- `contentFingerprint` is SHA-256 over the canonical logical payload hashes and
  sorted original asset hashes. It excludes `archiveId`, `createdAt`, ZIP
  compression metadata, and application build metadata.

Format version 1 uses these safety defaults:

- maximum original image size: 25 MiB, matching the current asset boundary;
- maximum campaign archive upload: 2 GiB compressed and 20 GiB uncompressed;
- maximum system archive upload: 50 GiB compressed and 200 GiB uncompressed;
- maximum entry count: 100,000 for campaign archives and 1,000,000 for system
  archives;
- maximum compression expansion ratio per entry: 100:1;
- maximum `manifest.json` size: 5 MiB;
- maximum individual JSON or NDJSON entry size: 1 GiB.

Deployments may lower these values through runtime configuration. Raising them
requires explicit operator configuration. Parsing is streaming and stages
uploads beneath a dedicated directory inside the configured application data
root; it does not use browser-supplied filenames as filesystem paths.

## Asset contract

Both archive types use `assets/assets.json` and content-addressed original files:

```text
assets/
  assets.json
  sha256/
    ab/
      abcdef...0123.png
```

Each asset record contains:

- source asset UUID;
- SHA-256 content hash;
- relative archive path;
- MIME type;
- byte length;
- pixel width and height;
- technical image metadata that is safe and portable;
- library metadata such as title, caption, notes, tags, origin, review status,
  reuse scope, automatic-reuse flag, favorite flag, and archive status;
- creation timestamp;
- explicit logical bindings.

Bindings may target:

- world cover;
- world version asset;
- campaign asset;
- turn illustration;
- illustration segment variant;
- imported attachment;
- generation context retained for the image library.

Every binding names its source record IDs and role. A campaign archive may name
only the exported campaign, its turns and illustration segments, the attached
world, and the attached world version. A system archive may name any record
included in its logical record files.

The archive filename is derived from the content hash, not the source asset UUID.
Multiple source asset records with the same content hash share one ZIP entry.
Import recreates one owner-scoped destination asset per unique content hash and
then applies all validated metadata and bindings.

Portable technical metadata must not contain temporary provider URLs,
authorization headers, API keys, local filesystem paths, or credential-shaped
fields. Image-generation parameters are sanitized using the same credential
removal rules used at existing provider boundaries.

## Campaign Archive specification

### Scope

A Campaign Archive contains exactly:

- one campaign;
- the exact immutable world version currently pinned by that campaign;
- the owning world metadata needed to display and manage the imported world;
- the campaign's current state and state revision;
- all accepted turns through the active turn;
- campaign character snapshot, structured profile, and profile edit history;
- campaign state-edit history;
- campaign world migration and transfer provenance relevant to the campaign;
- campaign illustration configuration;
- active and historical illustration sets and segments required to reproduce the
  visible story;
- Chronicle summaries and non-vector memory content needed to preserve imported
  history and current context;
- provider-reported campaign and turn costs;
- import provenance and portable settings;
- every original asset bound to the campaign, its accepted turns, its
  illustration sets or segments, completed campaign image outputs, the attached
  world cover, or the pinned world version.

It does not contain other versions of the world, other campaigns using the same
world, owner-library images with no binding to this campaign or world version,
provider profiles, prompt overrides, activity from unrelated records, or any
operational job row.

### Files

```text
manifest.json
campaign.json
world.json
chronicle.json
assets/assets.json
assets/sha256/<prefix>/<content-hash>.<extension>
```

- `campaign.json` remains compatible with portable campaign format version 3
  for the first archive-format release.
- `world.json` is a canonical portable world payload for the pinned immutable
  version. It is the authoritative attached-world snapshot for archive import.
- The legacy `campaign.json.world` projection remains present for compatibility
  and must have the same canonical world-content hash as `world.json`.
- `chronicle.json` carries summaries and non-vector memory records that are not
  fully represented by accepted turns, including imported full-history
  checkpoints.
- `assets/assets.json` carries asset metadata and explicit bindings.

### Export flow

1. Resolve the campaign using the server-derived owner.
2. Start a read-only, repeatable-read database transaction.
3. Read the campaign, pinned world and world version, accepted turns, current
   state, portable Chronicle content, asset metadata, and bindings from one
   consistent snapshot.
4. Reject the export if the campaign has a pending accepted-turn commit that is
   not yet reflected in campaign state.
5. End the database snapshot after the complete logical record set and immutable
   asset hash list have been captured.
6. Stream deterministic JSON and each content-addressed original asset into the
   ZIP.
7. Verify every asset against database metadata and the manifest hash while it
   is read.
8. Finalize the manifest and stream the completed download as
   `infinite-quest-campaign.zip`.

The endpoint remains:

```text
GET /api/v1/campaigns/:campaignId/export
```

The JSON-only service overload remains available for focused tests and legacy
internal callers. The browser-facing endpoint always returns the manifest ZIP
when asset storage is configured, as required by normal runtime startup.

### Import identity and conflict rules

- Import belongs to the destination server's current owner.
- The source owner UUID, when present as provenance, is never accepted as
  authorization.
- World, world-version, campaign, turn, memory, segment, and asset UUIDs are
  remapped to destination UUIDs.
- Known relational and structured asset references are rewritten through the
  explicit source-to-destination map.
- Import defaults to creating or reusing the exact attached world snapshot.
- The existing optional workflow to attach the campaign to a user-selected
  compatible world version remains available after preview.
- Re-importing the same `contentFingerprint` with the same destination option
  returns the previously completed import result.
- A different archive is never merged into an existing campaign in place.
- When exact canonical world content already exists for the owner, import may
  reuse that immutable world version after the preview reports the reuse.

### Campaign Import preview

The Import screen detects `archiveType: "campaign"` and shows:

- campaign title;
- attached world title and version;
- accepted turn count;
- Chronicle record counts;
- original image count and total bytes;
- whether the attached world will be created or reused;
- selected-character summary;
- warnings for unsupported optional fields that will be ignored;
- a statement that provider profiles and credentials are not included;
- the calculated destination operation.

Preview performs all archive and checksum validation but does not persist
authoritative records or final asset files.

API contract:

```text
POST /api/v1/imports/campaign-archive/preview
POST /api/v1/imports/campaign-archive
```

Preview accepts the campaign ZIP as a streamed multipart upload and returns a
preview token bound to the staged archive fingerprint, destination option,
running application version, and expiry time. The token expires after 30
minutes. Legacy JSON and manifest-less ZIP imports remain on their compatibility
routes until they are adapted into the same preview result.

### Campaign Import commit

Commit accepts the preview token and the confirmed destination option; it does
not require the browser to upload the archive a second time.

1. Revalidate the staged archive, preview token, and fingerprint.
2. Verify and decode every original image using the asset service.
3. Begin one database transaction.
4. Create or reuse the attached world version.
5. Create the campaign, current state, turns, profile history, state history,
   portable Chronicle content, illustration records, cost records, and
   provenance in dependency order.
6. Persist content-addressed originals, recreate asset library metadata, and
   apply explicit bindings using the destination ID map.
7. Rewrite known image pointers to destination `/api/v1/assets/:assetId` URLs.
8. Record the completed import with its content fingerprint and destination IDs.
9. Commit and queue thumbnail and embedding rebuild work after commit.

If a database write fails, the transaction rolls back. Newly written
content-addressed files are removed only when the importer created them and no
committed destination asset references them. Existing shared content-addressed
files are never removed by rollback cleanup.

## System Archive specification

### Scope and ownership

System Archive format version 1 exports all portable data owned by the
database-backed `initial-owner`. It records that source owner as provenance but
does not export the source user's internal UUID as a destination identity.

Import is accepted only when:

- all database migrations required by the running application have completed;
- the destination has exactly its idempotently-created initial user;
- no worlds, world versions, drafts, campaigns, turns, assets, provider
  profiles, imports, prompt overrides, or owner activity records exist;
- no operational job is queued, leased, recoverable, or running;
- no other System Import job is active.

Format version 1 rejects archives containing more than one source owner.

### Included logical data

The archive includes versioned logical records for:

- initial-owner display profile and user preferences;
- provider profiles with non-secret endpoint, role, model, context, retry, and
  provider-specific configuration;
- default provider selection and campaign provider assignments;
- prompt template overrides;
- worlds, all immutable world versions, drafts, publication metadata, fork
  provenance, status, and covers;
- campaigns, settings, character snapshots, structured profiles, profile edit
  history, current state, state edits, world migrations, and world transfers;
- accepted turns and their append-only identity, input mode, narration,
  choices, mechanics-private state, accepted timestamps, and sanitized model
  metadata;
- structured canonical facts;
- campaign memory configuration;
- Chronicle memories without embedding vectors;
- summary checkpoints, including imported full-history checkpoints;
- campaign illustration configuration;
- visible illustration sets, segments, segment assets, and sanitized prompts;
- imports and source provenance;
- provider-reported cost events;
- owner activity events after credential-shaped metadata is removed;
- all original owner assets, including retained owner-library assets that are
  not currently bound to a world or campaign;
- asset library metadata, generation contexts, and live references.

### Excluded or normalized logical data

The archive excludes:

- encrypted API keys, credential nonces, authentication tags, key versions, and
  any decrypted credential;
- user identity-provider links;
- generation jobs, attempts, leases, idempotency reservations, raw provider
  responses, and model response chains;
- Chronicle jobs and embedding vectors;
- image jobs, remote job IDs, polling state, provider artifact URLs, download
  state, and leases;
- illustration prompt, resolution, candidate, and backfill job rows;
- generated thumbnails;
- provider health counters, health status, and last-error details;
- application process identity, correlation IDs, and transient readiness state.

Provider profiles are imported disabled, with credentials empty and health reset
to `unknown`. Campaign assignments to those remapped profiles remain present so
the UI can show which profile must be re-enabled after the operator supplies a
new credential.

Chronicle memories retain text, scope, source identifiers, chronology, and
entity metadata but import with no embedding vector. The destination queues
embedding rebuilds only for campaigns whose imported memory configuration is
enabled and whose selected embedding provider is later made usable.

Visible illustration sets and segments are normalized to terminal display
states that match their imported assets. No imported record remains queued,
leased, generating, refining, matching, downloading, or recoverable.

### Files

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
records/campaign-state/000001.ndjson
records/campaign-history/000001.ndjson
records/chronicle/000001.ndjson
records/illustrations/000001.ndjson
records/imports/000001.ndjson
records/cost-events/000001.ndjson
records/activity-events/000001.ndjson
assets/assets.json
assets/sha256/<prefix>/<content-hash>.<extension>
```

`system.json` contains the system payload version, migration watermark,
source-owner count, record counts, asset counts, and normalization report.
NDJSON records are grouped by logical domain rather than mirroring raw tables.
Each line is an independently schema-validated logical record. Domains are
sharded deterministically before an entry reaches 256 MiB, so no growing
installation depends on one unbounded NDJSON entry. Export ordering is
deterministic by source UUID and chronological tie-breakers.

### System Export workflow

System Export is a durable worker operation because its size is not bounded by
one campaign.

API contract:

```text
POST /api/v1/system-exports
GET  /api/v1/system-exports/:jobId
GET  /api/v1/system-exports/:jobId/download
```

1. `POST` creates an idempotent export job and returns HTTP 202.
2. The worker captures a read-only, repeatable-read logical snapshot and the
   complete immutable asset inventory.
3. The worker streams records and assets into a temporary archive, computes
   counts and checksums, then atomically publishes the completed artifact.
4. The status endpoint reports phase, record progress, asset progress, bytes
   written, warnings, and terminal error details.
5. The download endpoint serves only a completed artifact owned by the current
   server-resolved owner.
6. Completed artifacts expire after 24 hours by default. Expiry removes only the
   generated archive artifact, never source assets.

The User Profile & Settings dialog receives a **System data** section with
**Export system**. It explains that credentials and encryption keys are
excluded and that the resulting archive contains private story content.

### System Import preview and confirmation

The existing Import screen gains a distinct source type:

```text
System backup (.zip)
```

Automatic detection may select it after reading `manifest.json`, but the UI must
still show a System Import-specific preview and confirmation. Pasted content is
not supported for System Import.

API contract:

```text
POST /api/v1/system-imports/preview
POST /api/v1/system-imports
GET  /api/v1/system-imports/:jobId
```

Preview streams the upload to staging and reports:

- archive format and source application version;
- migration compatibility;
- source-owner count;
- record counts by domain;
- original asset count and bytes;
- destination emptiness checks;
- providers that will require credentials and remain disabled;
- derived data that will be rebuilt;
- archive warnings and normalization counts;
- required free staging and asset-storage space;
- content fingerprint.

Commit requires the exact preview token and a confirmation checkbox stating
that the destination must be empty. The preview token binds the archive
fingerprint, destination emptiness result, running application version, and
expiry time. It cannot be reused after data changes or after 30 minutes.

### System Import execution

System Import is a durable worker operation:

1. Acquire a PostgreSQL advisory lock for owner-wide system import.
2. Recheck destination emptiness and migration compatibility.
3. Mark the System Import job active. All other mutating API requests return
   HTTP 503 with the typed error `system-import-in-progress`; health, readiness,
   import status, and static UI routes remain available.
4. Revalidate every staged archive entry and image.
5. Open one database transaction.
6. Update portable initial-owner profile fields.
7. Insert domain records in dependency order while preserving all non-user
   application UUIDs.
8. Replace every source `owner_user_id` relationship with the destination
   initial owner's UUID.
9. Insert sanitized provider profiles disabled and restore their assignments.
10. Persist content-addressed original assets and restore their metadata and
    bindings.
11. Normalize nonportable runtime states and record an import report.
12. Commit the database transaction.
13. Queue thumbnail regeneration and eligible Chronicle reindex work.
14. Clear the import-in-progress gate and mark the job completed.

Failure before commit rolls back all database records. Staged files remain only
until the failed job's cleanup finishes. Newly created content-addressed files
are removed only when they are not referenced by a committed asset row.

Because System Import requires an empty database, record-ID conflicts are a
hard validation failure rather than a merge option. Repeating a completed
System Import on the same destination fails the emptiness check.

## Service boundaries

Implementation will use focused modules rather than continue growing
`world-service.ts`, `import-service.ts`, and `server.ts`.

### Shared archive contracts

`packages/contracts/src/archives.ts` owns:

- root manifest schemas;
- campaign and system archive discriminator schemas;
- entry and checksum schemas;
- asset record and binding schemas;
- preview and job response schemas;
- archive-format compatibility helpers;
- typed error codes.

### Archive I/O

`services/api/src/archive-io.ts` owns:

- normalized path validation;
- streaming ZIP entry enumeration;
- duplicate-name and special-file rejection;
- staged upload handling;
- size, count, and expansion limits;
- checksum verification;
- deterministic ZIP writing helpers.

It has no world, campaign, or database-domain logic.

### Asset portability

`services/api/src/asset-archive-service.ts` owns:

- asset inventory resolution from explicit database relationships;
- safe portable metadata projection;
- original-byte validation and archive streaming;
- archive asset verification;
- content-addressed destination persistence;
- source-to-destination asset mapping;
- binding restoration and rollback-safe cleanup.

It reuses image verification and storage primitives extracted from
`asset-service.ts`; it does not duplicate image signature or dimension logic.

### Campaign portability

`services/api/src/campaign-archive-service.ts` owns:

- campaign snapshot assembly;
- attached-world assembly;
- campaign archive creation;
- preview;
- source-to-destination identity mapping;
- campaign import transaction orchestration;
- legacy manifest-less campaign ZIP adaptation.

### System portability

`services/api/src/system-archive-service.ts` owns:

- owner-wide logical snapshot assembly;
- system record normalization;
- System Export job execution;
- destination-empty preflight;
- System Import execution;
- identity preservation and owner remapping;
- final import report.

### API registration

Archive routes should be registered from a focused route plugin, such as
`services/api/src/archive-routes.ts`, and called by `buildServer`. Multipart ZIP
parsing must not remain inline in `server.ts`.

### Worker integration

The worker claims durable System Export and System Import jobs. A migration adds
the job table, status constraints, progress fields, artifact/staging paths,
content fingerprint, preview token data, lease fields, expiry, warnings, and
terminal error metadata. Campaign Export remains a direct streamed request;
Campaign Import commit may remain request-scoped after staging and preview
because it is bounded to one campaign.

## Security and privacy requirements

- Resolve owner identity server-side for every export, preview, import, status,
  and download request.
- Never accept owner UUIDs from archive content as authorization.
- Sanitize every JSON value recursively for credential-shaped fields before it
  enters a portable payload.
- Use explicit allowlisted logical record schemas; passthrough fields are
  permitted only within already-versioned world and campaign content contracts.
- Never extract archive entries using source paths.
- Reject absolute paths, traversal, duplicate normalized names, symlinks,
  special files, unsupported compression methods, encrypted ZIP entries, and
  entries omitted from the manifest.
- Verify file size and checksum before parsing JSON or decoding images.
- Apply the existing image MIME allowlist, signature checks, 25 MiB per-original
  limit, and decoder verification.
- Do not log archive payloads, story text, image bytes, credentials, or private
  mechanics. Log correlation ID, archive type, fingerprint prefix, record
  counts, asset counts, byte counts, phases, timings, and typed failures.
- Send `Cache-Control: no-store` and a restrictive
  `Content-Disposition: attachment` on archive downloads.
- Delete staged uploads and expired generated archives through bounded,
  root-validated cleanup.
- Document that the ZIP itself is unencrypted and contains private user content.

## Compatibility and versioning

- `manifest.formatVersion` versions the shared container contract.
- Each payload records its own format version.
- Importers reject a newer required major format with
  `archive-version-unsupported`.
- Optional fields added compatibly within format version 1 require defaults
  defined by the contract.
- Exporters always emit the current payload versions.
- Existing portable world JSON remains importable.
- Existing portable campaign JSON remains importable.
- Existing campaign ZIP archives containing `campaign.json` and `assets/`
  without `manifest.json` remain importable through a legacy adapter.
- Legacy imports receive warnings that checksum, MIME declaration, and explicit
  asset-binding guarantees were unavailable in the source archive.
- System Archive format version 1 has no manifest-less compatibility mode.
- System Import accepts only migration watermarks in the running application's
  declared compatibility range. A newer source watermark is rejected. An older
  supported logical payload is upgraded by explicit contract adapters, never by
  executing source SQL.

## Error model

Archive APIs return typed errors with a safe message and structured details.
Required error codes include:

- `archive-format-unrecognized`;
- `archive-version-unsupported`;
- `archive-entry-unsafe`;
- `archive-entry-duplicate`;
- `archive-limit-exceeded`;
- `archive-checksum-mismatch`;
- `archive-entry-missing`;
- `archive-json-invalid`;
- `archive-asset-invalid`;
- `archive-asset-missing`;
- `archive-world-mismatch`;
- `archive-owner-count-unsupported`;
- `archive-destination-not-empty`;
- `archive-preview-stale`;
- `archive-storage-insufficient`;
- `system-import-in-progress`;
- `archive-import-conflict`;
- `archive-export-inconsistent`.

Validation errors identify safe logical paths and source IDs but never echo
story content, credentials, local filesystem paths, or raw provider metadata.

## Testing strategy

### Contract and unit tests

- accept valid campaign and system manifests;
- reject unknown root fields and invalid version combinations;
- canonicalize deterministic entry ordering and content fingerprints;
- reject traversal, absolute paths, backslashes, duplicate normalized names,
  symlinks, special files, missing entries, undeclared entries, and invalid
  checksums;
- enforce compressed, uncompressed, entry-count, JSON, manifest, expansion, and
  per-image limits;
- validate every asset MIME type and signature combination;
- prove credential-shaped fields are removed from nested metadata;
- prove asset bindings use explicit IDs and roles;
- verify provider normalization, illustration terminal-state normalization, and
  embedding removal;
- verify campaign ID remapping and system ID preservation rules.

### PostgreSQL integration tests

- Campaign Export and Import round-trip one campaign, its exact world version,
  current state, accepted turns, character data, Chronicle content, costs,
  illustration segments, world cover, alternate segment images, and library
  metadata;
- Campaign Import into an existing non-empty owner succeeds without touching
  unrelated worlds, campaigns, memories, or assets;
- repeated Campaign Import returns the same completed result;
- attach-to-existing-world preview and commit preserve the exported campaign
  character and state;
- a missing source asset makes Campaign Export fail rather than omit the image;
- a corrupt archive leaves no campaign, world, import, memory, or asset
  reference rows;
- System Export covers every included logical domain and every original owner
  asset, including an unreferenced retained library image;
- System Import into a new database preserves non-user UUIDs, remaps
  `owner_user_id`, disables providers, restores assignments, and leaves no
  active jobs or model chains;
- System Import rejects a non-empty destination before mutation;
- System Import rollback leaves the destination empty after a forced
  mid-transaction failure;
- cross-owner rows cannot be exported, previewed, downloaded, or imported
  through caller-supplied identity;
- imported vectors are absent and rebuild jobs are queued only when eligible;
- imported thumbnails are regenerated from original bytes.

These tests must run against a real PostgreSQL database through
`TEST_DATABASE_URL`; a skipped database suite is not a completed verification.

### API and UI tests

- campaign download returns ZIP content type, no-store caching, and the expected
  filename;
- System Export job lifecycle returns 202, progress, completion, download, and
  expiry behavior;
- Import file selection accepts `.zip` and detects campaign versus system
  manifests;
- the Import screen presents a dedicated System backup option and does not
  route it through campaign import;
- System Import preview renders domain counts, asset sizes, disabled-provider
  warnings, rebuild warnings, and destination-empty status;
- stale preview tokens and changed destination state prevent commit;
- mutating APIs return `system-import-in-progress` during commit while status and
  health remain available;
- campaign and system failures are announced through accessible status regions;
- browser code never parses System Archive record or asset entries.

### End-to-end verification

1. Create multiple worlds, versions, campaigns, turns, Chronicle records,
   provider profiles, prompt overrides, world covers, campaign illustrations,
   alternate segment images, and an unreferenced library image.
2. Export one campaign and import it into a different non-empty installation.
3. Load the imported campaign and verify its attached world, state, accepted
   turns, and images without access to the source database or asset root.
4. Export the complete source system.
5. Start a fresh database with only migrations and its initial owner.
6. Import the System Archive from the Import screen.
7. Verify counts, preserved record identities, owner remapping, provider
   disabled state, prompt configuration, playable campaigns, visible images,
   Chronicle rebuild behavior, and absence of credentials or active jobs.
8. Run `pnpm check`, the complete unit suite, PostgreSQL integration suite,
   application build, documentation build, and `git diff --check`.

## Documentation requirements

Update:

- `docs/nexus-guide/campaigns/import-export.md` with the standalone archive
  guarantee, attached-world scope, image inclusion rules, compatibility, and
  import conflict behavior;
- `docs/nexus-guide/worlds/import-export.md` to distinguish world-only JSON from
  Campaign Archive and System Archive;
- a new system data migration guide under `docs/nexus-guide/operations/` with
  export, empty-destination import, progress, provider credential re-entry,
  failure recovery, and archive sensitivity;
- provider documentation to state that profiles are imported disabled and
  credentials are never exported;
- operations documentation to state that System Export is not a substitute for
  PostgreSQL, secret, and filesystem disaster-recovery backups.

## Rollout sequence

The implementation plan should deliver independently reviewable increments:

1. shared manifest, archive-safety, checksum, and asset-binding contracts;
2. hardened Campaign Archive export and legacy-compatible import;
3. Campaign Archive UI preview and complete round-trip coverage;
4. durable System Export jobs and download UI;
5. empty-destination System Import preview, commit gate, and worker execution;
6. full PostgreSQL round trip, UI coverage, documentation, and operational
   verification.

Campaign Archive remains usable after increment 3 even if System Archive work is
not yet complete. System Import is not exposed until its empty-destination,
rollback, ownership, credential-stripping, and asset-round-trip tests pass.

## Acceptance criteria

The feature is complete when:

- a Campaign Archive imported into another installation can load and continue
  the campaign with its exact attached world version and every associated
  original image;
- no Campaign Export silently omits a required image;
- a System Archive imported into a fresh database restores all specified
  portable owner data and every original asset;
- System Import is a visibly separate option in the existing Import screen;
- campaign import remaps identities while System Import preserves non-user
  identities and remaps only owner scope;
- credentials, encryption material, active jobs, leases, remote job state,
  response chains, embeddings, and thumbnails are absent from archives;
- providers restored by System Import are disabled until credentials are
  supplied;
- corrupt, unsafe, oversized, incompatible, or incomplete archives fail before
  authoritative mutation;
- failed imports do not leave partially imported relational state;
- all related unit, real-PostgreSQL integration, API, UI, build, documentation,
  and diff checks pass.
