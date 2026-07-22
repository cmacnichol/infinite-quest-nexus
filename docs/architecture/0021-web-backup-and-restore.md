# ADR 0021: Web-managed staged restore and complete Nexus recovery bundles

## Status

Proposed implementation plan.

This plan is intentionally not an operator runbook. The existing command-line guidance remains authoritative until the acceptance criteria in this document have passed in both Compose and Swarm-compatible test deployments.

## Goal

Add an operator-only **System** area to Infinite Quest Nexus that can:

1. Download and restore a database-only backup that completely replaces the current PostgreSQL database.
2. In a second delivery phase, download and restore one encrypted Nexus recovery bundle containing PostgreSQL, generated assets, and the credential material needed to make restored provider profiles usable.

Both restore modes must preserve the old installation until the replacement has been restored, migrated, and validated. A failed replacement must return to the old database and asset namespace without requiring manual database surgery.

## Current state

- PostgreSQL is authoritative for users, worlds, immutable world versions, campaigns, accepted turns, campaign state, memories, jobs, providers, imports, and asset metadata.
- Generated raster assets are stored separately under `ASSET_STORAGE_ROOT`; PostgreSQL stores their relative paths and hashes.
- Provider credentials are encrypted in PostgreSQL using the separately configured `CREDENTIAL_ENCRYPTION_KEY`.
- The application image does not contain `pg_dump`, `pg_restore`, or the PostgreSQL administrative client tools.
- The API accepts JSON bodies up to 64 MiB. Database and full-installation uploads cannot use that in-memory JSON path.
- Compose runs API and worker responsibilities in one `all` process. Swarm runs independently replicated API and worker services.
- API and worker correctness currently coordinates through PostgreSQL. There is no deployment-wide maintenance mode or write-drain protocol.
- The service is pre-authentication. Resolving requests to `initial-owner` is not operator authentication.
- The existing backup guide correctly identifies PostgreSQL, generated assets, and the credential-encryption key as the complete recovery set, but it does not automate a verified restore drill.

## Non-goals

- Physical PostgreSQL base backups, WAL archiving, point-in-time recovery, or replication management.
- Replacing infrastructure-level backup policies for a production PostgreSQL service.
- Exporting Docker, Swarm, reverse-proxy, TLS, database-password, or provider-endpoint infrastructure configuration.
- Silently changing Docker or Swarm secrets during restore.
- Restoring selected tables, worlds, campaigns, or assets. Existing portable import/export workflows remain the selective migration mechanism.
- Cross-major PostgreSQL downgrade support.
- Supporting an asset driver without a verified snapshot/export/import contract.
- Treating browser access to the trusted network as sufficient authorization for destructive administration.

## Architectural decisions

### Use logical PostgreSQL archives

Create the database payload with the PostgreSQL client matching the supported server major:

```text
pg_dump --format=custom --no-owner --no-acl
```

The custom archive remains a native `pg_restore` payload. Nexus wraps it with a versioned manifest so upload validation does not depend on filenames or caller-provided metadata.

Do not implement a table-by-table JSON dump. It would duplicate PostgreSQL behavior, omit extension and sequence state, and make future migrations harder to restore safely.

### Never clean-restore directly into the live database

Every restore targets a newly created staging database. Nexus restores the archive, applies the running application's online migrations, runs integrity checks, and only then swaps database names. The previous database remains available under a generated rollback name until post-swap verification and retention cleanup complete.

### Coordinate maintenance through PostgreSQL

Add a maintenance flag plus a PostgreSQL advisory-lock protocol:

- Mutating API operations and claimed worker jobs hold a shared maintenance lock for their complete authoritative operation.
- A restore first sets maintenance mode, preventing new shared holders.
- The restore coordinator then obtains the exclusive form of the same advisory lock. Acquiring it proves earlier mutations and worker jobs have drained.
- Read-only status, health, restore progress, and backup download endpoints remain available where safe.

This protocol works across Compose and replicated Swarm services. Process-local flags may optimize presentation but are never the correctness boundary.

### Use the same image and runtime contract in both deployment modes

Add a `maintenance` runtime role to the existing image. The Compose `all` role runs the maintenance loop alongside its worker. Swarm deploys exactly one `infinitequest-maintenance` replica using the same image. The maintenance replica owns PostgreSQL administrative subprocesses; ordinary API and worker replicas do not receive the administrative database credential.

The API writes a restore request to the authoritative database and streams the upload to shared backup staging storage. The maintenance role claims and executes it with a durable lease. Before swapping databases, it copies the operation record and active maintenance state into the staged database so API polling resumes against the replacement database after reconnection.

### Separate normal and administrative database credentials

Continue using `DATABASE_URL` for normal application work. Introduce `DATABASE_MAINTENANCE_URL` or its `_FILE` variant for the maintenance role only. It connects through a maintenance database such as `postgres` and must have only the cluster privileges required to:

- create and drop staging databases;
- terminate connections to the named Nexus databases;
- rename databases;
- connect to and restore the staging database;
- inspect server and extension compatibility.

The URL must not be returned by the API, included in an archive, logged, or supplied to ordinary API/worker replicas in Swarm.

### Make database swap the commit point

Use generated, validated database identifiers rather than caller input:

```text
live:       infinitequest
staging:    infinitequest_restore_<operation suffix>
rollback:   infinitequest_rollback_<UTC timestamp>_<operation suffix>
```

The coordinator connects to the maintenance database, terminates live application connections, renames live to rollback, and renames staging to live. The old and new databases must be in the same PostgreSQL cluster; cross-cluster replacement remains an operator-managed workflow.

After the swap, `node-postgres` pools reconnect using the unchanged live database name. Readiness remains false until migrations, initial-owner resolution, extension checks, and restore verification succeed.

### Preserve restore progress across the swap

Restore state cannot exist only in the database being replaced. Immediately before swap, the coordinator inserts or updates the same operation ID in staging. After swap, clients polling that ID see the continuing operation in the new live database. The coordinator retains the administrative connection and can update either database explicitly during rollback.

### Treat backup storage as operational, not authoritative

Uploads, generated archives, and intermediate extraction directories live under a dedicated `BACKUP_STORAGE_ROOT`, not the asset directory. Compose mounts a named backup-staging volume. Swarm mounts a private shared path accessible to API and maintenance replicas.

Files use server-generated names, mode `0600`, atomic finalization, configurable quotas, and bounded retention. Operation records may be retained longer than their archive files for audit purposes. Backup files are never committed to the repository.

## Common foundation

The following work is required before either restore mode is enabled.

### Database schema

Add an online migration containing:

```text
system_maintenance
  singleton_id                 boolean primary key default true
  mode                         normal | database_restore | nexus_backup | nexus_restore
  operation_id                 uuid nullable
  reason                       text
  requested_by                 text
  started_at / updated_at
  CHECK singleton_id = true

maintenance_operations
  id                           uuid primary key
  owner_user_id                uuid nullable
  kind                         database_backup | database_restore | nexus_backup | nexus_restore
  status                       uploaded | queued | draining | creating | validating |
                               swapping | verifying | completed | recoverable |
                               rolling_back | rolled_back | failed | cancelled | expired
  source_filename              text nullable
  artifact_path                text nullable
  artifact_bytes               bigint nullable
  artifact_sha256              text nullable
  archive_format_version       integer nullable
  source_nexus_version         text nullable
  source_postgres_major        integer nullable
  source_schema_migrations     jsonb
  progress                     jsonb
  validation_report            jsonb
  error_code / error_message   text nullable
  lease_owner                  text nullable
  lease_expires_at             timestamptz nullable
  created_at / updated_at / completed_at / expires_at

maintenance_events
  operation_id                 uuid
  sequence                     bigint
  stage                        text
  message                      text
  details                      jsonb
  created_at
  primary key (operation_id, sequence)
```

Requirements:

- Operation and event details must be bounded and contain no secrets or archive content.
- Claims use `FOR UPDATE SKIP LOCKED` plus expiring leases.
- Only one destructive restore may be queued, draining, validating, swapping, verifying, or rolling back.
- Database backups may be serialized initially to limit disk and database load.
- Restore rows copied into staging must retain the original operation UUID and safe event history.
- Migration rollback is forward-fix only; do not automatically remove these tables once deployed.

### Maintenance lock integration

Create shared helpers in the database package:

```ts
withMaintenanceReadLock(pool, operation)
withMaintenanceWriteLock(pool, operation)
maintenanceStatus(pool)
assertMutationsAllowed(pool)
```

The naming should describe application behavior even if PostgreSQL implements the operation using shared and exclusive advisory locks.

Apply the shared lock to:

- every mutating API route;
- provider generation that may create costs or health updates;
- imports and deletes;
- generation, Chronicle, and image jobs from claim through final commit or recorded failure;
- asset writes and deletions;
- migration execution when initiated during normal startup.

Do not hold an ordinary database transaction open across a long provider request solely for maintenance locking. Use a dedicated session-level advisory lock connection and release it in `finally`. If the connection is lost, PostgreSQL releases the lock automatically and the operation must fail safely before authoritative commit.

During maintenance:

- mutation routes return `503` with `code: "system_maintenance"`, operation ID, mode, and retry guidance;
- workers finish a held job but claim no new work;
- story and management UIs become read-only;
- liveness remains healthy;
- readiness reports `503` during the swap and reports a distinct maintenance state before the swap;
- restore status and event endpoints remain accessible.

### Operator authorization

Add a distinct `BACKUP_RESTORE_OPERATOR_TOKEN` or `_FILE` secret and default `BACKUP_RESTORE_ENABLED=false`.

Administrative endpoints must:

- require same-origin requests;
- reject general cross-origin access even if application CORS permits it elsewhere;
- require the operator token in a dedicated header;
- compare the token in constant time;
- require TLS unless the request is from an explicitly allowed loopback/local-development path;
- redact the header in request logs;
- rate-limit authentication failures and administrative mutations;
- never store the token in local storage, cookies, operation rows, or browser logs.

The System page may remember the token only in page memory for the current tab. Future authentication can replace this with an administrator role without changing the operation contracts.

### PostgreSQL tooling

- Install the supported PostgreSQL 18 client in the production image.
- Run `pg_dump`, `pg_restore`, `createdb`, and administrative SQL with `spawn`, an argument array, `shell: false`, a minimal environment, and bounded stderr capture.
- Supply credentials through a protected connection environment or service file without placing passwords in process arguments.
- Validate the resolved executable version at startup when backup/restore is enabled.
- Refuse backup if the dump client is older than the server major.
- Record executable and server versions in structured logs and operation metadata.
- Never accept executable switches, database identifiers, filesystem paths, or connection strings from the browser.

### Streaming and storage limits

Do not increase Fastify's global JSON `bodyLimit`. Register a dedicated streaming multipart or octet-stream path with:

- `BACKUP_MAX_UPLOAD_BYTES`;
- `BACKUP_MAX_STORED_BYTES`;
- `BACKUP_RETENTION_HOURS`;
- `BACKUP_STORAGE_ROOT`;
- minimum-free-space checks before backup, upload acceptance, staging restore, and full-bundle extraction;
- SHA-256 calculation while streaming;
- abort cleanup when the client disconnects;
- no decompression before archive type and declared limits are validated;
- extraction limits for file count, individual file size, total expanded bytes, and compression ratio.

All archive paths must be normalized and rejected if absolute, empty, duplicated, contain `..`, use unsupported link types, or escape the staging root.

### Shared contracts

Add typed contracts for:

- capabilities and current maintenance status;
- operation kinds, stages, progress, validation reports, and terminal results;
- backup creation options;
- uploaded archive preview;
- destructive restore confirmation;
- event polling;
- retention and cleanup results.

Use one error vocabulary across API, worker, UI, tests, and documentation. At minimum distinguish invalid archive, unsupported format, incompatible PostgreSQL major, newer schema, insufficient space, missing extension, missing asset, credential-key failure, drain timeout, restore failure, validation failure, swap failure, verification failure, rollback failure, and authorization failure.

## Phase 1: Database backup and complete database replacement

### Phase 1 artifact format

Use a versioned unencrypted tar container named `*.iqnexus-db-backup`:

```text
manifest.json
database/infinitequest.dump
integrity/sha256.json
```

The manifest contains:

```text
format                         infinite-quest-nexus-database-backup
formatVersion                  1
createdAt
nexusVersion
postgresServerVersion
postgresDumpVersion
databaseNameHint               informational only
schemaMigrations[]
initialOwnerId
dumpBytes
dumpSha256
assetsIncluded                 false
credentialKeyIncluded          false
credentialKeyFingerprint       one-way fingerprint only, or null
```

The database archive contains private story data and encrypted provider credentials. The UI must warn that the file is sensitive even though provider API keys remain encrypted. Encryption at rest is the operator's responsibility in Phase 1.

Raw `.dump` restore is out of scope for the first release because it lacks the Nexus compatibility manifest. It may be added later through an explicitly reduced-assurance operator path.

### Phase 1 backup workflow

1. Authenticate and create a `database_backup` operation.
2. Check PostgreSQL tooling, storage quota, and free space.
3. Run `pg_dump` from the normal database URL into a newly created spool file.
4. Calculate size and SHA-256 while writing.
5. Query backup metadata using a transactionally consistent read where practical. If migration inventory changes during backup creation, discard the artifact and retry after startup migration activity ends.
6. Build the manifest and integrity file.
7. Assemble the final tar to a temporary name and atomically rename it.
8. Mark the operation completed and expose a content-disposition download.
9. Delete the artifact automatically after its retention deadline or explicit operator cleanup.

Database backup does not require maintenance mode. `pg_dump` provides a consistent database snapshot. The manifest must not claim that generated asset files were captured.

### Phase 1 upload and preview

1. Stream the upload to an isolated operation directory.
2. Verify container magic, format version, permitted members, sizes, and hashes.
3. Run `pg_restore --list` against the embedded dump.
4. Inspect the source manifest without trusting its database name or paths.
5. Compare PostgreSQL major versions and migration inventory.
6. Reject a backup containing applied migrations unknown to the running application.
7. Permit an older known schema because staging will receive current online migrations.
8. Return a preview containing source time/version, database size, owner UUID, migration difference, key-fingerprint match, and explicit excluded components.

Preview performs no live mutation and creates no database.

### Phase 1 destructive confirmation

Execution requires all of:

- operator reauthentication;
- the uploaded operation ID;
- its SHA-256 digest to prevent a preview/execute race;
- `acknowledgeDataLoss: true`;
- `acknowledgeAssetsExcluded: true`;
- a typed phrase exactly matching `REPLACE <configured database name>`;
- confirmation issued before a short expiration deadline.

The API enqueues rather than executing the restore in the request process. The browser should expect transient disconnection and continue polling the same operation ID.

### Phase 1 restore workflow

1. Maintenance coordinator claims the queued restore.
2. Revalidate the artifact digest, confirmation deadline, tooling, permissions, and disk space.
3. Set `system_maintenance.mode = database_restore`.
4. Stop new mutations and job claims.
5. Acquire the exclusive maintenance advisory lock with a configured drain timeout.
6. If drain times out, clear maintenance and fail without changing the database.
7. Create a staging database from `template0` with encoding and locale compatible with the live database.
8. Run `pg_restore --exit-on-error --no-owner --no-acl` into staging.
9. Connect using a staging application pool and run current online migrations.
10. Never apply a `.maintenance.sql` migration automatically as part of restore. If one is pending, report `recoverable` and require the existing reviewed maintenance-migration procedure.
11. Validate staging:
    - PostgreSQL major and required extensions;
    - exact known migration ordering;
    - active `initial-owner`;
    - non-null ownership and cross-scope constraints;
    - foreign keys and expected indexes;
    - representative counts for worlds, versions, campaigns, accepted turns, jobs, memories, providers, and assets;
    - no invalid active-job combination;
    - provider credential decryptability only when the source and destination key fingerprints match.
12. Copy the restore operation and active maintenance row into staging.
13. Close the staging application pool.
14. Release target-database lock connections that must not survive rename, retain control through the administrative connection, and terminate remaining live database sessions.
15. Rename live to rollback and staging to live.
16. Allow API/worker pools to reconnect to the unchanged live name, but keep mutations disabled.
17. Verify normal migrations, initial-user identity, readiness query, core list queries, and operation continuity.
18. On success, clear maintenance, record the rollback database name and expiry, and resume workers.
19. On failure, terminate replacement connections, reverse the names, verify the original database, mark `rolled_back`, and clear maintenance.
20. If rollback itself fails, leave maintenance active, emit a critical structured event, and provide exact operator recovery identifiers without automatically dropping either database.

### Phase 1 asset and credential behavior

Database-only replacement intentionally leaves the current asset filesystem and runtime encryption key in place.

- If a restored `assets.storage_path` exists and its hash matches, it remains usable.
- Missing or mismatched restored assets are reported after restore; they do not invalidate accepted turns.
- Unreferenced existing files remain untouched and can be reconciled later.
- If the backup credential-key fingerprint differs from the running key, restore may proceed only after a second warning. Restored provider profiles are disabled and marked as requiring credential re-entry; Nexus must not repeatedly attempt decryption with the wrong key.
- If fingerprints match, validate a bounded credential sample before re-enabling mutations.

Disabling incompatible restored provider profiles requires an auditable staging-database update before swap and must not erase encrypted source values. Add an explicit credential-health state rather than replacing ciphertext with null.

### Phase 1 API

```text
GET    /api/v1/admin/system/capabilities
GET    /api/v1/admin/system/maintenance

POST   /api/v1/admin/database-backups
GET    /api/v1/admin/operations/:operationId
GET    /api/v1/admin/operations/:operationId/events?after=<sequence>
GET    /api/v1/admin/database-backups/:operationId/download
DELETE /api/v1/admin/database-backups/:operationId/artifact

POST   /api/v1/admin/database-restores/uploads
GET    /api/v1/admin/database-restores/:operationId/preview
POST   /api/v1/admin/database-restores/:operationId/execute
POST   /api/v1/admin/database-restores/:operationId/cancel
POST   /api/v1/admin/database-restores/:operationId/retry
```

Cancel is accepted only before draining or while a safely cancellable staging step is active. It is rejected after database swap begins.

### Phase 1 web interface

Add a **System** navigation item and isolated management view.

Database backup card:

- live database identity, server version, current migration, approximate database size, and last verified operation;
- **Create database backup** button;
- progress, size, digest, download, and delete-artifact controls;
- warning that assets and the credential key are excluded.

Database restore card:

- streamed file picker/drop zone;
- upload progress;
- server-produced compatibility preview;
- current database and incoming backup summary side by side;
- blockers separated from warnings;
- typed replacement phrase and acknowledgment checkboxes;
- destructive **Replace database** button;
- durable stage timeline;
- reconnection polling with exponential backoff;
- terminal success, automatic rollback, or operator-intervention state.

When maintenance begins, all management and story screens display a common banner and disable mutation controls. Do not depend on each individual form implementing its own safety decision; the API remains authoritative.

### Phase 1 configuration

```text
BACKUP_RESTORE_ENABLED=false
BACKUP_RESTORE_OPERATOR_TOKEN_FILE=
DATABASE_MAINTENANCE_URL_FILE=
BACKUP_STORAGE_ROOT=/var/lib/infinitequest/backups
BACKUP_MAX_UPLOAD_BYTES=10737418240
BACKUP_MAX_STORED_BYTES=21474836480
BACKUP_RETENTION_HOURS=24
BACKUP_ROLLBACK_RETENTION_HOURS=24
BACKUP_DRAIN_TIMEOUT_SECONDS=900
BACKUP_OPERATION_LEASE_SECONDS=120
BACKUP_REQUIRE_TLS=true
```

Bounds and production defaults must be reviewed rather than copied blindly. Every setting must be documented in `.env.example`, installation guidance, Compose, and Swarm secret/config documentation.

### Phase 1 code map

Expected additions or changes:

```text
database/migrations/0027_system_maintenance.sql
packages/contracts/src/backup.ts
packages/database/src/maintenance.ts
packages/database/src/admin.ts
packages/backup/src/postgres-tools.ts
packages/backup/src/database-archive.ts
packages/backup/src/integrity.ts
services/api/src/admin-auth.ts
services/api/src/backup-service.ts
services/api/src/maintenance-routes.ts
services/maintenance/src/maintenance-worker.ts
services/runtime/src/main.ts
services/worker/src/worker.ts
apps/web/public/index.html
apps/web/public/nexus.js
apps/web/public/nexus.css
Dockerfile
compose.yaml
deploy/swarm/stack.yaml
.env.example
docs/operations/backup-restore.md
docs/operations/recovery/database.md
```

Names may change during implementation, but PostgreSQL tooling, archive parsing, admin authorization, and restore coordination should remain separated from the main API route file.

### Phase 1 tests

Unit tests:

- manifest schema and canonical hashing;
- generated-name validation and path confinement;
- PostgreSQL command argument construction without shell interpolation;
- operator-token comparison and log redaction;
- maintenance route classification;
- progress-state transition rules;
- confirmation phrase, digest binding, and expiry;
- upload, expanded-size, member-count, and compression-ratio limits.

Integration tests with isolated PostgreSQL 18/pgvector:

- backup/restore round trip preserves UUIDs, worlds, versions, campaigns, accepted turns, state, jobs, memories, providers, and migration inventory;
- an older known backup migrates successfully in staging;
- a backup with unknown newer migrations is rejected before maintenance;
- corrupt, truncated, forged-hash, and non-Nexus archives are rejected;
- missing pgvector fails staging validation without touching live;
- maintenance blocks new API mutations and worker claims;
- in-flight shared locks drain before the exclusive restore lock;
- drain timeout clears maintenance without swap;
- staging restore or migration failure leaves live unchanged;
- database swap reconnects pools to restored data;
- failed post-swap verification automatically restores the original database;
- restore status survives the database swap;
- wrong credential-key restore disables affected providers without deleting ciphertext;
- missing assets are reported but do not corrupt accepted history;
- concurrent restore submissions cannot both execute;
- expired leases are recoverable without duplicate swap.

Deployment tests:

- Compose `all` role performs a verified round trip without adding a third steady-state container;
- Swarm-shaped tests run separate API, worker, and maintenance roles with at least two API and worker processes;
- no API/worker process in the Swarm shape receives the administrative database URL;
- container restart during pre-swap work resumes or safely fails;
- container restart during the commit boundary produces either the old or new verified database, never an untracked ambiguous state;
- rendered Compose and Swarm manifests remain valid.

Browser tests:

- System navigation and capability-disabled state;
- backup progress and download;
- restore preview, warnings, typed confirmation, and cancellation;
- global maintenance banner and disabled controls;
- transient disconnect and resumed polling;
- completed, rolled-back, recoverable, and critical-failure presentation;
- keyboard and screen-reader labeling for destructive dialogs;
- responsive layout and no archive data in browser storage.

### Phase 1 acceptance criteria

Phase 1 is complete only when:

- a browser-created database backup restores into an isolated installation and matches authoritative row counts and representative hashes;
- a destructive restore never modifies the live database before staging validation passes;
- automatic rollback has been demonstrated after an injected post-swap failure;
- two API and two worker processes stop writes before the swap;
- the application reconnects without changing its configured database name;
- database-only exclusions and credential-key mismatch behavior are visible before confirmation;
- operator authorization is disabled by default and reviewed against the pre-auth security posture;
- PostgreSQL client/server compatibility, disk capacity, retention, and cleanup are documented;
- `pnpm check`, unit tests, PostgreSQL integration tests, documentation build, Compose smoke test, Swarm rendering, and `git diff --check` pass.

## Phase 2: Full Nexus backup and restore

Phase 2 begins only after Phase 1 restore and rollback drills are reliable. It reuses the same maintenance protocol, staged database restore, operation model, authorization, and System interface.

### Phase 2 recovery set

A complete Nexus recovery bundle contains:

1. The native PostgreSQL custom archive.
2. Every filesystem asset represented by authoritative `assets` rows, with path, length, MIME type, and content hash.
3. The source credential-encryption key, protected inside the encrypted bundle so provider credentials can be rewrapped for the destination installation.
4. A versioned recovery manifest and integrity inventory.

It does not contain the PostgreSQL password, maintenance credential, operator token, TLS keys, reverse-proxy configuration, Docker/Swarm secrets unrelated to provider credential decryption, or inference-service data.

### Phase 2 encrypted bundle format

Use `*.iqnexus-backup` with an authenticated, versioned outer envelope. The payload is a tar stream:

```text
manifest.json
database/infinitequest.dump
assets/<namespace>/<content-addressed path>
recovery/credential-encryption-key.json
integrity/sha256.json
```

The outer header contains only what is needed to decrypt safely:

```text
magic
envelopeVersion
KDF identifier and bounded parameters
salt
stream-encryption algorithm
nonce/chunk parameters
```

Requirements:

- Full bundles are always encrypted; there is no unencrypted full-backup option.
- The operator supplies a backup passphrase through the System page for creation and restore.
- Derive the envelope key with a reviewed memory-hard KDF such as scrypt or Argon2id using versioned bounded parameters.
- Use authenticated streaming encryption with unique nonces and an authenticated final record. Do not invent an unaudited chunk protocol during feature implementation; select a maintained library or established format and record that choice in a focused security review.
- The passphrase and plaintext recovery key exist only in request/worker memory, are never stored in operation rows or logs, and are cleared on a best-effort basis after use.
- Restore authenticates the complete encrypted stream before processing its contents into a candidate replacement.
- Manifest and member hashes remain inside the encrypted envelope and are verified after decryption.

If a passphrase must cross from the API to the maintenance replica, do not put it in PostgreSQL. Use a short-lived, one-read secret handoff protected by an ephemeral maintenance public key, or terminate the creation/restore request at the maintenance service through an internal authenticated channel. The concrete handoff mechanism requires threat-model review before implementation.

### Phase 2 asset consistency model

Introduce asset namespaces so restored files can be staged without overwriting the current installation:

```text
asset_storage_namespaces
  id
  name                         generated opaque value
  state                        active | staging | rollback | deleting
  created_at / updated_at

system_storage_state
  singleton_id
  active_asset_namespace_id
```

Asset paths remain relative and content-addressed. The filesystem layout becomes:

```text
ASSET_STORAGE_ROOT/
  namespaces/
    <namespace>/aa/<content hash>.png
```

The asset service resolves the active namespace through database state. New assets always write to that namespace. Existing installations receive a `legacy` namespace migration or a reviewed one-time filesystem layout transition that does not rewrite image bytes.

During full restore, assets extract into a new staging namespace. Before database swap, the staged database is updated to select that namespace. The rollback database still selects the old namespace. Therefore the database-name swap atomically selects the matching asset tree without renaming the mounted storage root.

Do not delete the old namespace until the rollback database retention period ends. Rollback-database cleanup and namespace cleanup are one audited operation.

### Phase 2 full-backup consistency

A full backup must describe one mutually consistent database-and-asset state.

1. Enter `nexus_backup` maintenance mode.
2. Drain mutating API and worker operations through the exclusive maintenance lock.
3. Run the database dump.
4. Query the authoritative asset inventory from the same quiescent state.
5. Verify each asset path is confined to the active namespace and matches database length/hash/type metadata.
6. Package exactly the authoritative asset inventory. Do not silently include orphan temporary files.
7. Include an orphan/missing/mismatch report in the operation result. A full backup fails if any authoritative asset is missing or mismatched.
8. Include the credential-encryption key only inside the encrypted envelope.
9. Finalize and authenticate the bundle.
10. Clear maintenance after the immutable artifact is complete.

The initial implementation accepts the resulting maintenance window. A later storage-driver snapshot contract may reduce downtime, but it must not weaken consistency.

### Phase 2 full-restore workflow

1. Upload the encrypted bundle to isolated storage with ciphertext limits.
2. Authenticate operator and collect the passphrase without persistence.
3. Decrypt to a protected staging area, enforcing expanded-size and member limits.
4. Validate envelope, manifest, member hashes, database archive, and asset inventory.
5. Return a preview with database and asset counts/sizes, source Nexus/PostgreSQL versions, provider credential count, and required downtime warning.
6. Require the Phase 1 destructive confirmation plus `acknowledgeAssetsReplaced: true` and `acknowledgeCredentialRewrap: true`.
7. Enter `nexus_restore` maintenance mode and drain writes.
8. Restore, migrate, and validate the staging database using the Phase 1 workflow.
9. Create a staging asset namespace and extract only validated regular files to server-generated paths.
10. Compare every restored `assets` row to exactly one staged file and verify byte length, MIME signature, and content hash. Reject missing, extra, duplicate, or mismatched members.
11. Decrypt each stored provider credential in staging with the bundled source key.
12. Re-encrypt it with the destination installation's currently configured `CREDENTIAL_ENCRYPTION_KEY`, using the current credential format and fresh nonces.
13. Validate bounded decryptability with the destination key and record counts only. Never record plaintext credentials.
14. Set the staged database's active asset namespace to the new staging namespace.
15. Copy operation/maintenance state into staging and perform the Phase 1 database swap.
16. Verify database readiness, asset reads for a deterministic sample plus all metadata hashes already checked, provider credential decryptability, and namespace selection.
17. Mark the new namespace active and the old namespace rollback-retained.
18. On failure after swap, reverse the database names; the old database automatically selects the old asset namespace. Mark the new namespace failed/staging for later cleanup.
19. Clear plaintext staging material immediately after success or failure and apply normal encrypted-artifact retention to the uploaded bundle.

Credential rewrapping avoids changing the destination Docker or Swarm secret and keeps the same deployment contract in both modes. If the destination credential key is absent, full restore is blocked before maintenance begins.

### Phase 2 API and UI additions

```text
POST   /api/v1/admin/nexus-backups
GET    /api/v1/admin/nexus-backups/:operationId/download
POST   /api/v1/admin/nexus-restores/uploads
GET    /api/v1/admin/nexus-restores/:operationId/preview
POST   /api/v1/admin/nexus-restores/:operationId/execute
```

The System page adds **Full Nexus backup** and **Full Nexus restore** cards. It must clearly distinguish:

- database-only backup: shorter, online, assets/key excluded;
- full Nexus backup: encrypted, includes assets and credential recovery, requires a maintenance window;
- portable world/campaign export: selective content migration, not installation replacement.

Passphrase inputs require confirmation, strength guidance, visibility toggle, and a warning that a forgotten passphrase cannot be recovered. Never prefill, persist, or place the passphrase in a URL.

### Phase 2 code map

Expected additional work:

```text
database/migrations/0028_asset_storage_namespaces.sql
packages/backup/src/nexus-bundle.ts
packages/backup/src/envelope-encryption.ts
packages/backup/src/asset-inventory.ts
packages/backup/src/credential-rewrap.ts
services/api/src/asset-service.ts
services/api/src/backup-service.ts
services/maintenance/src/maintenance-worker.ts
apps/web/public/index.html
apps/web/public/nexus.js
apps/web/public/nexus.css
compose.yaml
deploy/swarm/stack.yaml
docs/operations/backup-restore.md
docs/operations/compose/storage.md
docs/operations/swarm/shared-assets.md
```

### Phase 2 tests

Unit and security tests:

- envelope versioning, KDF bounds, authentication failure, truncation, and wrong passphrase;
- no nonce reuse across chunks or bundles;
- passphrase and recovery key redaction from errors, logs, rows, and progress events;
- tar traversal, links, devices, duplicate names, member bombs, and expansion limits;
- asset namespace path confinement;
- deterministic asset inventory and hash validation;
- provider credential rewrap from source key to destination key with fresh nonces;
- unsupported credential key versions fail before swap.

Integration and deployment tests:

- full backup/restore preserves authoritative database state and every asset byte;
- restored provider credentials decrypt with a different destination installation key;
- missing, extra, modified, wrong-type, and duplicate assets fail before swap;
- orphan files are reported and excluded from the bundle;
- concurrent image completion cannot race a full backup after maintenance drain;
- successful restore selects the new namespace while rollback selects the old namespace;
- injected database, asset, credential, and post-swap failures roll back both state components;
- cleanup never deletes the namespace referenced by live or rollback-retained database state;
- Compose and replicated Swarm-shaped deployments use identical bundle semantics;
- a large synthetic asset set is streamed within memory limits and respects disk quotas;
- restart and lease recovery cannot produce a partially active namespace.

Recovery drills:

- restore the full bundle into an empty installation with a different destination credential key;
- verify initial-owner UUID, worlds, campaigns, accepted turns, current state, representative Chronicle reconstruction, all asset hashes, and safe provider-model discovery;
- demonstrate automatic rollback after an injected post-swap asset-read failure;
- record duration, peak temporary disk use, expected maintenance window, and cleanup results.

### Phase 2 acceptance criteria

Phase 2 is complete only when:

- one passphrase-encrypted file restores PostgreSQL, all authoritative filesystem assets, and usable provider credentials into an installation with a different credential key;
- the bundle contains none of the excluded infrastructure secrets;
- every authoritative asset is hash-verified before commit;
- database swap and asset namespace selection behave as one recoverable commit;
- a failed full restore automatically returns both the original database and original asset namespace;
- secret handoff and streaming encryption receive focused security review;
- large-bundle memory, disk, timeout, and retention limits are documented and tested;
- Compose and Swarm-compatible recovery drills pass using the same application image and contracts.

## Operation state machines

Database backup:

```text
queued -> creating -> validating -> completed
                     \-> failed
```

Database or Nexus restore:

```text
uploaded -> queued -> draining -> creating -> validating -> swapping -> verifying -> completed
              |          |           |            |            |
              |          +----------> failed <----+            +-> rolling_back -> rolled_back
              +-> cancelled
```

`recoverable` is used only when the artifact and live installation remain safe but operator action is required, such as a reviewed maintenance migration or insufficient cleanup space. `failed` before swap guarantees the live installation was unchanged. `rolled_back` guarantees the old database and, in Phase 2, old asset namespace were restored. A rollback failure is a distinct critical terminal condition and leaves maintenance active.

## Observability and audit

Structured events must include operation ID, kind, stage, source/destination PostgreSQL versions, archive bytes, elapsed time, migration counts, asset counts, drain duration, swap attempt, verification result, rollback result, and correlation ID.

Never log:

- operator token or bundle passphrase;
- database URLs or passwords;
- credential-encryption keys or decrypted provider credentials;
- database/archive contents;
- private story content;
- caller-controlled archive paths without sanitization.

Add metrics for operation totals by result, duration by stage, uploaded/generated bytes, drain time, validation failures by safe code, rollback attempts/results, retained artifact bytes, retained rollback-database count, and retained asset-namespace bytes.

## Cleanup and retention

- Artifact deletion and rollback cleanup are separate explicit operations.
- A completed download does not immediately delete its artifact; browser retries must remain possible within retention.
- Cleanup refuses to delete an artifact used by an active operation.
- Database cleanup verifies the candidate name, operation record, age, and that it is not the configured live database before issuing `DROP DATABASE`.
- Namespace cleanup verifies that no live or retained rollback database references it.
- Failed staging databases and namespaces are retained for a short diagnostic window unless they contain decrypted temporary material; plaintext key material is always removed immediately.
- Cleanup failures are visible in System status and logs but do not retroactively fail a successful restore.

## Rollout sequence

1. Merge common contracts, schema, authorization, tooling checks, and maintenance read-only behavior behind disabled feature flags.
2. Add database backup creation and isolated restore tests without exposing destructive execution.
3. Enable Phase 1 restore only in development and CI; complete injected-failure and rollback drills.
4. Document least-privilege administrative credentials and add Compose/Swarm configuration examples.
5. Enable Phase 1 for reviewed trusted-network deployments.
6. Add asset namespaces before full-bundle support and migrate existing assets without changing URLs.
7. Complete the encrypted-envelope threat review and credential-rewrap tests.
8. Enable Phase 2 in development and CI; complete cross-key, cross-installation recovery drills.
9. Enable Phase 2 for reviewed deployments after storage sizing and rollback retention are configured.

Each step must remain backward-compatible with replicas from the prior deployable application version. Maintenance-table and asset-namespace migrations therefore precede code that requires them, and old replicas must either operate normally or fail readiness clearly during the rollout window.

## Documentation deliverables

Before either phase is described as available, update:

- the active backup and restore runbook;
- database recovery guidance;
- Compose and Swarm storage requirements;
- environment and secret reference;
- security posture and reverse-proxy requirements;
- System-page user guidance;
- upgrade and rollback documentation;
- current capabilities;
- an environment-specific restore-drill record template.

The runbook must retain command-line recovery procedures. The web interface is an additional controlled recovery path, not the only way to recover an unavailable API.

## Final review gates

The pull requests implementing this plan must identify:

- user-visible behavior and downtime;
- schema and migration changes;
- PostgreSQL privilege changes;
- new secrets and file-based secret paths;
- archive compatibility and retention policy;
- security review results;
- restore and rollback drills performed;
- Compose and Swarm validation;
- temporary disk-space requirements;
- expected recovery point and recovery time characteristics.

No release may claim verified backup/restore until an archive produced by that release has been restored into an isolated environment and the complete appropriate Phase 1 or Phase 2 acceptance suite has passed.
