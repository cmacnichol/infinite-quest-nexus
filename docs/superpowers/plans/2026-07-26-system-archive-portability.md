# System Archive Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate System Export and System Import workflow that moves every portable record and original asset owned by the initial owner into a fresh Infinite Quest Nexus database without exporting credentials, active runtime state, or derived data.

**Architecture:** Build on the completed Campaign Archive contracts, ZIP I/O, asset portability, preview table, and route plugin. A durable `system_archive_jobs` table drives worker-created exports and worker-executed imports. Export keyset-pages allowlisted logical domains through one repeatable-read snapshot into deterministic NDJSON shards and a content-addressed asset archive. Import stages and validates the archive, proves the destination is empty, acquires an owner-wide advisory lock, gates all other mutating API requests, preserves non-user application UUIDs, remaps owner scope to the destination initial owner, normalizes providers/runtime state, and commits the logical restore in one transaction.

**Tech Stack:** Node.js 22, TypeScript 7, Fastify 5, PostgreSQL advisory locks and `FOR UPDATE SKIP LOCKED`, Zod 4, shared Campaign Archive `archive-io.ts` and `asset-archive-service.ts`, `archiver` 8, `unzipper` 0.12.5, Sharp 0.35, Vitest 4, browser JavaScript, VitePress.

## Global Constraints

Prerequisite: complete `docs/superpowers/plans/2026-07-26-campaign-archive-portability.md` through its completion checkpoint. This plan assumes these stable interfaces already exist:

- strict archive manifest, entry, asset, binding, error, and preview contracts;
- bounded staged ZIP inspection and deterministic artifact writing;
- original-image validation and content-addressed persistence;
- `archive_previews` migration/table;
- `registerArchiveRoutes`;
- typed archive errors in the central API error response;
- runtime archive roots, limits, and expiry settings.

- System Export and Campaign Export stay separate. System Export contains all portable owner data and every original owner asset; it is never used as the one-campaign workflow.
- System Import has its own explicit option in the existing Import screen and its own preview, confirmation, job status, and errors.
- A System Archive is a portable logical migration format, not a PostgreSQL physical backup, filesystem snapshot, secret backup, encryption-key backup, or live merge format.
- Format version 1 supports exactly one source owner and imports only into a destination with exactly its idempotently created `initial-owner` and no authoritative owner data.
- Preserve all non-user application UUIDs. Replace every source owner relationship with the destination initial owner's UUID. Never import the source user's UUID as destination identity.
- Include every approved logical domain and every original owner asset, including retained unreferenced library images.
- Exclude encrypted/decrypted credentials, credential nonces/tags/key versions, identity-provider links, active or historical operational jobs, leases, generation attempts, raw provider responses, model chains, remote image state, temporary provider URLs, vectors, and generated thumbnails.
- Import provider profiles disabled, credentialless, non-default until assignments are restored, and with health `unknown`, zero failures, no last health check, and no last error. Preserve remapped campaign/default assignments so the UI can show what needs reconfiguration.
- Import Chronicle memory without vectors. Preserve embedding configuration references, but do not run embeddings until the remapped provider is supplied credentials and enabled.
- Normalize visible illustration sets/segments to terminal display states matching imported originals. No imported record may remain queued, running, leased, generating, refining, matching, downloading, recoverable, or provider-pending.
- System records are allowlisted logical objects, not raw table dumps. Each NDJSON line is independently schema-validated.
- Deterministically shard each logical domain before 256 MiB. Keep the shared maximum individual JSON/NDJSON entry limit at 1 GiB.
- Apply the approved defaults: 50 GiB compressed, 200 GiB uncompressed, 1,000,000 entries, 100:1 per-entry expansion, 5 MiB manifest, 25 MiB per original, 24-hour completed-export expiry, and 30-minute preview expiry.
- System Import validates archive safety, all checksums, all record schemas, all references, all images, migration compatibility, free space, and destination emptiness before authoritative mutation.
- System Import commits relational data in one transaction. Newly written original files receive rollback-safe cleanup; pre-existing content-addressed files are never removed.
- While a System Import owns the exclusive gate, all other mutating API requests return HTTP 503 with `system-import-in-progress`. Health, readiness, static UI, and import status remain available.
- Preserve unrelated worktree changes and never edit legacy root `index.html`.
- A skipped PostgreSQL integration suite is not verification.

---

## File and Interface Map

### Create

- `database/migrations/0044_system_archive_jobs.sql`
  - Durable export/import jobs, idempotency, progress, lease, staging/artifact, expiry, warnings, result, and terminal error fields.
- `services/api/src/system-archive-service.ts`
  - Logical domain codecs/projections, export enqueue/claim/run, deterministic NDJSON streaming, import preview, destination fingerprint, import enqueue/claim/run, UUID/owner restoration, normalization, cleanup, and status.
- `services/api/src/system-import-gate.ts`
  - Fastify mutation guard using non-blocking shared PostgreSQL advisory locks and an exclusive worker lock.
- `tests/unit/system-archive-normalization.test.ts`
- `tests/unit/system-import-gate.test.ts`
- `tests/integration/system-archive.integration.test.ts`
- `docs/nexus-guide/operations/system-data-migration.md`

### Modify

- `packages/contracts/src/archives.ts`
- `database/migrations/0043_archive_previews.sql` only if an additive correction is discovered before `0044`; once `0043` is deployed, put every schema change in `0044`.
- `services/api/src/archive-routes.ts`
- `services/api/src/provider-service.ts`
- `services/api/src/server.ts`
- `services/worker/src/worker.ts`
- `tests/integration/migrations.integration.test.ts`
- `tests/unit/server-security.test.ts`
- `tests/unit/management-ui.test.ts`
- `apps/web/public/index.html`
- `apps/web/public/nexus.js`
- `apps/web/public/nexus.css`
- `docs/.vitepress/config.ts`
- `docs/nexus-guide/campaigns/import-export.md`
- `docs/nexus-guide/worlds/import-export.md`
- `docs/nexus-guide/providers/health-and-errors.md`
- `docs/operations/backup-restore.md`
- `docs/installation/environment-configuration.md`

### Durable service interfaces

```ts
export async function enqueueSystemExport(
  pool: DatabasePool,
  request: SystemExportRequest
): Promise<SystemArchiveJob>;

export async function previewSystemImport(
  pool: DatabasePool,
  config: RuntimeConfig,
  staged: StagedArchive,
  sourceName: string
): Promise<SystemImportPreview>;

export async function enqueueSystemImport(
  pool: DatabasePool,
  request: SystemImportCommitRequest
): Promise<SystemArchiveJob>;

export async function getSystemArchiveJob(
  pool: DatabasePool,
  jobId: string
): Promise<SystemArchiveJob>;

export async function runSystemArchiveJob(
  pool: DatabasePool,
  config: RuntimeConfig,
  workerId: string,
  leaseSeconds: number
): Promise<boolean>;
```

### System Archive layout

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

Domains create additional six-digit shards deterministically before the current
entry reaches 256 MiB.

---

## Task 1: Add system payload, domain-record, preview, and job contracts

**Files:**

- Modify: `packages/contracts/src/archives.ts`
- Create: `tests/unit/system-archive-normalization.test.ts`

- [ ] **Step 1: Add failing system contract tests**

Test:

- one valid `archiveType: "system"` manifest and `system.json`;
- owner count must be exactly one;
- all required logical domains are declared;
- every NDJSON envelope uses the expected domain/version;
- provider credentials and health fields are rejected by the portable provider schema;
- Chronicle vectors are rejected;
- active illustration states are rejected;
- job and preview responses accept only documented phases/statuses.

- [ ] **Step 2: Run the test and confirm missing contracts**

Run:

```powershell
pnpm exec vitest run tests/unit/system-archive-normalization.test.ts
```

Expected: FAIL because system record schemas do not exist.

- [ ] **Step 3: Define system metadata and record-domain constants**

Add:

```ts
export const SYSTEM_ARCHIVE_DOMAINS = [
  "providers",
  "prompts",
  "worlds",
  "world-versions",
  "world-drafts",
  "campaigns",
  "turns",
  "campaign-state",
  "campaign-history",
  "chronicle",
  "illustrations",
  "imports",
  "cost-events",
  "activity-events"
] as const;

export const systemArchivePayloadSchema = z.object({
  format: z.literal("infinite-quest-system"),
  formatVersion: z.literal(1),
  databaseMigration: z.string().regex(/^[0-9]{4}_[a-z0-9_]+$/),
  sourceOwnerCount: z.literal(1),
  recordCounts: z.record(z.enum(SYSTEM_ARCHIVE_DOMAINS), z.number().int().nonnegative()),
  assetCount: z.number().int().nonnegative(),
  originalAssetBytes: z.number().int().nonnegative(),
  normalizationReport: z.object({
    credentialsRemoved: z.number().int().nonnegative(),
    providersDisabled: z.number().int().nonnegative(),
    vectorsRemoved: z.number().int().nonnegative(),
    runtimeStatesNormalized: z.number().int().nonnegative()
  }).strict()
}).strict();
```

- [ ] **Step 4: Define independently validated NDJSON envelopes**

Use:

```ts
export const systemRecordEnvelopeSchema = z.object({
  domain: z.enum(SYSTEM_ARCHIVE_DOMAINS),
  formatVersion: z.literal(1),
  sourceId: z.uuid(),
  record: z.record(z.string(), z.unknown())
}).strict().superRefine(validateDomainRecord);
```

`validateDomainRecord` dispatches to one strict allowlisted schema per domain. Record schemas use portable camelCase names and explicit source IDs; they must not mirror raw row names or accept passthrough credential/runtime fields.

- [ ] **Step 5: Define owner and provider portability**

`records/owner.json` contains only source system key provenance, display name, and user settings. The destination initial owner remains active; source status is not portable identity/profile data.

Portable providers contain:

- source profile ID;
- name, provider type/role, base URL, default model;
- context/output/temperature/timeout;
- recursively sanitized provider configuration;
- source default flag as assignment intent.

They cannot contain encrypted API key, nonce, authentication tag, key version, health state/counters, last check/error, or an enabled true value. Imported normalization is represented in the preview/report, not trusted from source input.

- [ ] **Step 6: Define system job and import contracts**

```ts
export const systemArchiveJobOperationSchema = z.enum(["export", "import"]);
export const systemArchiveJobStatusSchema = z.enum([
  "queued",
  "locking",
  "validating",
  "snapshotting",
  "writing-records",
  "writing-assets",
  "importing",
  "committing",
  "completed",
  "failed",
  "expired"
]);

export const systemExportRequestSchema = z.object({
  idempotencyKey: z.uuid()
}).strict();

export const systemImportCommitRequestSchema = z.object({
  previewToken: z.string().min(40).max(200),
  confirmEmptyDestination: z.literal(true)
}).strict();
```

Job responses expose phase, record progress, asset progress, bytes processed, warnings, safe terminal errors, completion/expiry timestamps, and download availability. They never expose staging/artifact filesystem paths or preview token hashes.

- [ ] **Step 7: Rerun contract and repository checks**

Run:

```powershell
pnpm exec vitest run tests/unit/archive-contracts.test.ts tests/unit/system-archive-normalization.test.ts
pnpm check
```

Expected: PASS.

- [ ] **Step 8: Commit system contracts**

```powershell
git add packages/contracts/src/archives.ts tests/unit/system-archive-normalization.test.ts
git commit -m "Add system archive contracts"
```

---

## Task 2: Add durable System Archive jobs and lease handling

**Files:**

- Create: `database/migrations/0044_system_archive_jobs.sql`
- Create: `services/api/src/system-archive-service.ts`
- Modify: `tests/integration/migrations.integration.test.ts`
- Modify: `tests/integration/system-archive.integration.test.ts`

- [ ] **Step 1: Add failing migration tests**

Assert `system_archive_jobs` has:

```text
id
owner_user_id
operation
status
phase
idempotency_key
content_fingerprint
preview_id
staged_archive_path
artifact_path
artifact_byte_length
record_progress
asset_progress
bytes_processed
warnings
result
attempts
lease_owner
lease_expires_at
error_code
error_message
created_at
updated_at
completed_at
expires_at
```

Require:

- operation check `export|import`;
- the status contract from Task 1;
- unique `(owner_user_id, operation, idempotency_key)`;
- one active import per owner;
- claim and expiry indexes;
- owner-scoped composite uniqueness;
- `preview_id` foreign key to `archive_previews`.

- [ ] **Step 2: Run migration tests and confirm failure**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/migrations.integration.test.ts
```

Expected: FAIL because migration `0044` does not exist.

- [ ] **Step 3: Create the online migration**

Use a normal `.sql` migration, not `.maintenance.sql`. Add partial indexes:

```sql
CREATE UNIQUE INDEX system_archive_jobs_one_active_import_idx
  ON system_archive_jobs(owner_user_id)
  WHERE operation = 'import'
    AND status IN ('queued','locking','validating','importing','committing');

CREATE INDEX system_archive_jobs_claim_idx
  ON system_archive_jobs(status, created_at)
  WHERE status IN ('queued','locking','validating','snapshotting',
                   'writing-records','writing-assets','importing','committing');
```

Store artifact/staging paths relative to `archiveStorageRoot`.

- [ ] **Step 4: Add export enqueue/status idempotency tests**

Test:

- first request creates one queued job;
- same owner/operation/idempotency key returns the same job;
- another key creates another job only when no policy conflict exists;
- caller-supplied owner data is ignored;
- status query rejects an unknown or foreign-owner job.

- [ ] **Step 5: Implement enqueue and public job projection**

Resolve `initialOwnerId(pool)` internally. Return 202-ready DTOs through:

```ts
export async function enqueueSystemExport(...): Promise<SystemArchiveJob>;
export async function getSystemArchiveJob(...): Promise<SystemArchiveJob>;
```

Never project `staged_archive_path`, `artifact_path`, `token_hash`, lease owner, or internal error stack.

- [ ] **Step 6: Implement lease-safe claiming**

Use one transaction and `FOR UPDATE SKIP LOCKED`:

```sql
WITH candidate AS (
  SELECT id
    FROM system_archive_jobs
   WHERE status = 'queued'
      OR (
        status IN ('locking','validating','snapshotting','writing-records',
                   'writing-assets','importing','committing')
        AND lease_expires_at < now()
      )
   ORDER BY created_at, id
   FOR UPDATE SKIP LOCKED
   LIMIT 1
)
UPDATE system_archive_jobs jobs
   SET status = CASE WHEN jobs.operation = 'import' THEN 'locking' ELSE 'validating' END,
       phase = CASE WHEN jobs.operation = 'import' THEN 'locking' ELSE 'validating' END,
       attempts = attempts + 1,
       lease_owner = $1,
       lease_expires_at = now() + ($2::text || ' seconds')::interval,
       updated_at = now()
  FROM candidate
 WHERE jobs.id = candidate.id
RETURNING jobs.*;
```

Every progress/terminal update must include `WHERE id = $1 AND lease_owner = $2`. A lost lease throws a typed internal `lease_lost` and never publishes an artifact or commits import data.

- [ ] **Step 7: Add heartbeat and safe failure helpers**

Heartbeat at `max(5 seconds, leaseSeconds / 3)`. On failure:

- set status `failed`;
- clear lease fields;
- store an approved archive error code and a safe bounded message;
- retain no stack, story content, local path, provider payload, or image data;
- schedule staged/temp cleanup.

- [ ] **Step 8: Run migration/job tests**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/migrations.integration.test.ts tests/integration/system-archive.integration.test.ts
```

Expected: PASS for migration and job lifecycle tests added so far.

- [ ] **Step 9: Commit the durable job foundation**

```powershell
git add database/migrations/0044_system_archive_jobs.sql services/api/src/system-archive-service.ts tests/integration/migrations.integration.test.ts tests/integration/system-archive.integration.test.ts
git commit -m "Add durable system archive jobs"
```

---

## Task 3: Stream deterministic owner-wide logical System Export

**Files:**

- Modify: `services/api/src/system-archive-service.ts`
- Modify: `tests/unit/system-archive-normalization.test.ts`
- Modify: `tests/integration/system-archive.integration.test.ts`

- [ ] **Step 1: Build a complete owner-wide export fixture**

Create source data for every included domain:

- modified initial-owner profile/settings;
- text, intent, embedding, and image provider profiles with encrypted credentials and health history;
- default assignments and campaign-specific assignments;
- prompt overrides;
- worlds, all versions, drafts, forks, statuses, covers;
- campaigns, character/profile/state histories, migrations/transfers;
- accepted turns with sanitized and deliberately credential-shaped model metadata;
- canonical facts, memory config, non-vector Chronicle memory, summary checkpoints;
- illustration config, visible sets/segments/variants;
- import provenance, cost events, and activity events;
- bound assets plus one retained unreferenced owner-library original;
- operational generation/image/Chronicle/prompt/resolution/backfill jobs and model chains that must not export;
- a second owner whose rows must not export.

- [ ] **Step 2: Add failing archive completeness and exclusion tests**

After running an export job, assert:

- `system.json`, owner record, every expected domain shard, asset manifest, and originals exist;
- counts match source logical records;
- every included non-user UUID is unchanged in NDJSON;
- every source original is included once by content hash;
- unreferenced library original is present;
- second-owner records are absent;
- credentials, job IDs, lease data, remote IDs, vectors, thumbnails, raw responses, response chains, provider health, and local paths are absent;
- logical record ordering, shard boundaries, entry hashes, and content fingerprint are deterministic for unchanged logical content; the complete ZIP bytes may differ because archive ID and creation time are intentionally excluded from the fingerprint.

- [ ] **Step 3: Run focused tests and confirm export failure**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts
```

Expected: FAIL because the worker export body is absent.

- [ ] **Step 4: Implement owner, provider, and prompt projections**

Add allowlisted projectors and keyset queries for owner, providers, and prompt
overrides. Provider projection removes credentials and health fields and
records default selection only as portable assignment intent. Do not use
`SELECT *`.

- [ ] **Step 5: Implement world and campaign root projections**

Add keyset queries/projectors for worlds, world versions, world drafts,
campaigns, turns, campaign state, and campaign history. Include version/fork,
character, state-edit, migration, and transfer provenance defined by the
contracts.

- [ ] **Step 6: Implement Chronicle, illustration, and audit projections**

Add keyset queries/projectors for Chronicle, illustrations, imports, cost
events, and activity events. Chronicle omits vector columns. Illustration
projection includes visible sets/segments/assets but no prompt, resolution,
image, or backfill job rows.

Every domain query:

- includes `owner_user_id = $owner`;
- orders by stable source UUID plus chronological tie-breaker where needed;
- supports `after` cursor and `LIMIT 1000`;
- emits portable camelCase records;
- recursively sanitizes allowed JSON metadata;
- validates the envelope before writing.

- [ ] **Step 7: Stream NDJSON shards without loading a domain into memory**

Use keyset pages and a `PassThrough` per shard:

```ts
const MAX_SYSTEM_NDJSON_SHARD_BYTES = 256 * 1024 * 1024;
const SYSTEM_EXPORT_PAGE_SIZE = 1000;
```

Before writing a line that would cross the shard threshold, end the current stream and open the next `records/<domain>/<six-digit>.ndjson`. Hash and count uncompressed bytes as lines flow. Validate every envelope before writing `canonicalArchiveJson(envelope) + "\n"`.

- [ ] **Step 8: Capture one repeatable-read snapshot**

Begin:

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
```

Within that snapshot:

1. verify exactly one source owner;
2. read migration watermark;
3. stream all domain records;
4. capture complete owner asset metadata/bindings and immutable original hashes;
5. write `records/owner.json` and `system.json`;
6. end the snapshot.

The job table and archive preview tables are operational and excluded, so progress updates may use a separate pool connection while the snapshot remains stable.

- [ ] **Step 9: Stream every original and finalize the manifest**

After the DB snapshot closes:

- read each original through the asset service;
- verify length, MIME, content hash, and decoder;
- fail the job with `archive-asset-missing`/`archive-asset-invalid` if any source is inconsistent;
- append originals in content-hash order;
- append `assets/assets.json`;
- compute the content fingerprint from canonical logical-record hashes plus sorted original hashes;
- append `manifest.json` last;
- atomically rename the completed artifact;
- set expiry to `now() + systemArchiveArtifactTtlSeconds`.

- [ ] **Step 10: Update progress without leaking data**

Expose phases:

```text
validating
snapshotting
writing-records
writing-assets
completed
```

Progress includes domain/processed/total records, processed/total assets, bytes written, warnings, and elapsed timings. Logs include only correlation/job ID, owner scope, fingerprint prefix, counts, bytes, phase, and typed failures.

- [ ] **Step 11: Run normalization and export integration tests**

Run:

```powershell
pnpm exec vitest run tests/unit/system-archive-normalization.test.ts
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit System Export logic**

```powershell
git add services/api/src/system-archive-service.ts tests/unit/system-archive-normalization.test.ts tests/integration/system-archive.integration.test.ts
git commit -m "Stream complete system archives"
```

---

## Task 4: Add System Export API, worker execution, expiry, and profile UI

**Files:**

- Modify: `services/api/src/archive-routes.ts`
- Modify: `services/worker/src/worker.ts`
- Modify: `apps/web/public/index.html`
- Modify: `apps/web/public/nexus.js`
- Modify: `apps/web/public/nexus.css`
- Modify: `tests/unit/management-ui.test.ts`
- Modify: `tests/integration/system-archive.integration.test.ts`

- [ ] **Step 1: Add failing API and UI lifecycle tests**

Assert:

- POST export returns 202 and one owner-scoped job;
- status moves through phases and ends completed;
- download before completion returns 409;
- completed download has ZIP/no-store/attachment headers;
- foreign/unknown job returns 404;
- expired job returns 410 with `archive-preview-stale` or a dedicated safe expired detail;
- expiry deletes only generated archive artifact;
- User Profile & Settings has a System data section, private-content warning, credentials-excluded copy, export button, progress, and download action.

- [ ] **Step 2: Run tests and confirm missing route/UI**

Run:

```powershell
pnpm exec vitest run tests/unit/management-ui.test.ts
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Register System Export routes**

Add:

```text
POST /api/v1/system-exports
GET  /api/v1/system-exports/:jobId
GET  /api/v1/system-exports/:jobId/download
```

POST parses `systemExportRequestSchema` and returns 202. Download reads only a completed, unexpired, owner-scoped artifact beneath `archiveStorageRoot`; it never accepts a path from the request.

- [ ] **Step 4: Run System Archive jobs from the worker**

In `runWorker`, call `runSystemArchiveJob` before lower-priority metadata backfill work:

```ts
const archived = await runSystemArchiveJob(
  pool,
  config,
  workerId,
  config.workerLeaseSeconds
);
```

System import/export work is sequential in the main loop and may run concurrently only with an already active story-generation promise. The System Import gate added later prevents authoritative campaign mutation during import.

- [ ] **Step 5: Add bounded artifact expiry cleanup**

On each worker pass, before claiming another System Archive job:

- select at most 10 completed export jobs whose `expires_at <= now()`;
- validate each relative artifact path under `archiveStorageRoot`;
- remove only that generated ZIP;
- mark the job `expired`, clear artifact path/length, and retain safe counts/report;
- do not touch staged imports or source assets.

- [ ] **Step 6: Add System data controls to User Profile & Settings**

Add a fieldset:

```html
<fieldset class="nexus-system-data">
  <legend>System data</legend>
  <p>The ZIP contains private worlds, campaigns, Chronicle content, and original images. It is not encrypted. Provider credentials and encryption keys are excluded.</p>
  <button id="exportSystemData" class="button secondary" type="button">Export system</button>
  <p id="systemExportStatus" class="status hidden" role="status" aria-live="polite"></p>
</fieldset>
```

- [ ] **Step 7: Implement create, poll, and download**

Generate one UUID idempotency key per user click. POST once, poll status at a bounded interval, render phase/counts/bytes, and initiate download only from the completed download URL. Stop polling on completed, failed, expired, dialog close, or page unload.

Do not download the ZIP through JSON helpers.

- [ ] **Step 8: Run worker/API/UI checks**

Run:

```powershell
pnpm exec vitest run tests/unit/management-ui.test.ts
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts
node --check apps/web/public/nexus.js
pnpm build
```

Expected: PASS.

- [ ] **Step 9: Commit System Export surfaces**

```powershell
git add services/api/src/archive-routes.ts services/worker/src/worker.ts apps/web/public/index.html apps/web/public/nexus.js apps/web/public/nexus.css tests/unit/management-ui.test.ts tests/integration/system-archive.integration.test.ts
git commit -m "Add system export workflow"
```

---

## Task 5: Validate System Import archives and prove destination emptiness

**Files:**

- Modify: `services/api/src/system-archive-service.ts`
- Modify: `services/api/src/archive-routes.ts`
- Modify: `tests/integration/system-archive.integration.test.ts`

- [ ] **Step 1: Add failing preview and safety tests**

Cover:

- valid system preview reports app/migration versions, domain counts, assets/bytes, provider reconfiguration, rebuild work, normalization, free space, fingerprint, and empty destination;
- newer migration watermark fails `archive-version-unsupported`;
- source owner count other than one fails `archive-owner-count-unsupported`;
- campaign archive on system endpoint fails format mismatch;
- checksum, reference, schema, or image failure prevents preview token creation;
- non-empty authoritative table returns exact counts and `archive-destination-not-empty`;
- active operational jobs fail emptiness;
- changed owner profile or destination state stales a token;
- insufficient archive/asset filesystem space fails `archive-storage-insufficient`;
- raw tokens and absolute staging paths never appear in API responses/logs.

- [ ] **Step 2: Run preview tests and confirm failure**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts
```

Expected: FAIL because System Import preview is absent.

- [ ] **Step 3: Define migration compatibility**

Read the destination's latest applied migration and compare to the archive watermark using an explicit supported range:

```ts
export type ArchiveMigrationCompatibility = {
  minimumSupportedSource: string;
  currentDestination: string;
};
```

Format version 1 rejects a source newer than the running code's declared current migration. Older supported sources pass through named logical adapters keyed by payload version; never run SQL from the archive.

- [ ] **Step 4: Implement exact destination preflight**

Require:

- exactly one `users` row;
- that row has `system_key = 'initial-owner'`;
- zero rows for worlds, world versions, world drafts, campaigns, turns, assets, provider profiles, imports, prompt overrides, and owner activity;
- zero rows for generation, Chronicle, image, illustration prompt/resolution/candidate/backfill, and other operational jobs;
- zero model chains;
- no other active System Import job.

Ignore the current preview row and System Archive job infrastructure itself.

Return a structured `DestinationEmptinessReport` with safe per-domain counts.

- [ ] **Step 5: Bind a destination fingerprint to the preview**

Calculate from:

- destination initial-owner UUID and `updated_at`;
- current migration watermark;
- sorted preflight domain counts;
- active job counts;
- current application version.

The token hash is stored in `archive_previews` with archive type `system`, staged relative path, archive fingerprint, destination fingerprint/hash, preview JSON, and 30-minute expiry.

- [ ] **Step 6: Validate all logical references before issuing a token**

Stream every NDJSON line with bounded line length. Validate its envelope/domain schema and collect source IDs in disk-bounded or domain-batched sets. Then verify:

- every foreign source ID resolves to an included record;
- every asset binding resolves;
- provider assignments reference included profiles;
- all owner references use the one source owner;
- non-user IDs are unique across their entity namespace;
- no excluded job/credential/vector/thumbnail fields exist.

Validate every original with checksum, MIME, signature, 25 MiB cap, and Sharp decoder. Do not persist final asset files.

- [ ] **Step 7: Check required free space**

Use `fs.promises.statfs` for archive staging and asset roots. Report:

- staged compressed bytes;
- declared uncompressed bytes;
- unique original bytes not already content-addressed at destination;
- 10% write/rollback headroom with a minimum 1 GiB;
- available bytes for each root.

Fail before token creation when either root cannot satisfy its requirement. If the platform cannot report free space, return an explicit warning and require operator confirmation only if repository deployment policy allows it; the default implementation fails closed for System Import.

- [ ] **Step 8: Register the preview endpoint**

Add:

```text
POST /api/v1/system-imports/preview
```

Accept exactly one streamed multipart ZIP under system compressed limits. Pasted content is unsupported. Return 200 with the preview token only after every validation succeeds.

- [ ] **Step 9: Run focused preview tests**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts
```

Expected: PASS for preview, compatibility, reference, free-space, and emptiness cases.

- [ ] **Step 10: Commit System Import preview**

```powershell
git add services/api/src/system-archive-service.ts services/api/src/archive-routes.ts tests/integration/system-archive.integration.test.ts
git commit -m "Validate system archive imports"
```

---

## Task 6: Gate mutating APIs with PostgreSQL advisory locks

**Files:**

- Create: `services/api/src/system-import-gate.ts`
- Create: `tests/unit/system-import-gate.test.ts`
- Modify: `services/api/src/server.ts`
- Modify: `tests/unit/server-security.test.ts`
- Modify: `tests/integration/system-archive.integration.test.ts`

- [ ] **Step 1: Add failing gate behavior tests**

Test:

- GET, HEAD, OPTIONS, health, readiness, static UI, and system import status never take the mutation lock;
- ordinary POST/PUT/PATCH/DELETE take a non-blocking shared advisory lock and release it after response/error/abort;
- active import status returns 503 and `system-import-in-progress`;
- failure to acquire shared lock returns the same typed 503 immediately;
- a request that sees no active row, acquires the shared lock, then observes an active row on recheck still returns 503;
- System Import commit can enqueue its own job;
- Campaign Archive import, provider edits, world/campaign mutations, generation enqueue, and System Export enqueue are blocked while import is active.

- [ ] **Step 2: Run unit tests and confirm failure**

Run:

```powershell
pnpm exec vitest run tests/unit/system-import-gate.test.ts tests/unit/server-security.test.ts
```

Expected: FAIL because no mutation guard exists.

- [ ] **Step 3: Define one stable advisory-lock key**

Use one documented signed 64-bit constant:

```ts
export const SYSTEM_IMPORT_ADVISORY_LOCK_KEY = 0x49514e535953544dn;
```

Bind it as a string parameter cast to `bigint`; do not interpolate it into SQL.

- [ ] **Step 4: Implement the shared request lock**

For mutating `/api/v1/` methods:

1. query active import statuses;
2. if active, return typed 503;
3. borrow a dedicated pool client;
4. call `SELECT pg_try_advisory_lock_shared($1::bigint) AS acquired`;
5. if false, release and return typed 503;
6. recheck active status using that client;
7. retain the client for the request lifetime;
8. release with `pg_advisory_unlock_shared` exactly once on response, error, or abort.

Use a closure-scoped `WeakMap` and an idempotent release helper. Do not hold the lock on a connection returned to the pool.

- [ ] **Step 5: Define narrow exemptions**

Exempt:

- safe methods GET/HEAD/OPTIONS;
- `/health/*` and static routes, which are outside mutating API handling;
- `POST /api/v1/system-imports`, because it only enqueues the gate-owning job and performs its own active-job check.

Do not exempt System Export, campaign import, provider updates, or other POST preview endpoints.

- [ ] **Step 6: Register the gate before mutating API routes**

Call `registerSystemImportGate(app, { pool })` after security/CORS hooks and before archive/domain route registration. Ensure the system import commit route remains reachable through its explicit exemption.

- [ ] **Step 7: Add exclusive worker-lock helpers**

Export:

```ts
export async function acquireSystemImportExclusiveLock(
  client: DatabaseClient
): Promise<void>;

export async function releaseSystemImportExclusiveLock(
  client: DatabaseClient
): Promise<void>;
```

The worker marks the job `locking` before waiting for `pg_advisory_lock`, so new mutations fail the active-row check while existing shared-lock requests drain.

- [ ] **Step 8: Run gate unit and integration tests**

Run:

```powershell
pnpm exec vitest run tests/unit/system-import-gate.test.ts tests/unit/server-security.test.ts
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts
```

Expected: PASS, including immediate typed 503 and lock release.

- [ ] **Step 9: Commit the import gate**

```powershell
git add services/api/src/system-import-gate.ts services/api/src/server.ts tests/unit/system-import-gate.test.ts tests/unit/server-security.test.ts tests/integration/system-archive.integration.test.ts
git commit -m "Gate writes during system import"
```

---

## Task 7: Execute empty-database System Import transactionally

**Files:**

- Modify: `services/api/src/system-archive-service.ts`
- Modify: `services/api/src/archive-routes.ts`
- Modify: `services/api/src/provider-service.ts`
- Modify: `services/worker/src/worker.ts`
- Modify: `tests/integration/system-archive.integration.test.ts`
- Modify: `tests/integration/image-pipeline.integration.test.ts`

- [ ] **Step 1: Add a fresh-database round-trip harness**

Create a second temporary PostgreSQL database using the pattern in `tests/integration/migrations.integration.test.ts` and `dropTestDatabaseWhenIdle`. Migrate it to current, assert it contains only the initial owner, copy no source files, and give it a separate temporary asset/archive root.

- [ ] **Step 2: Add failing import assertions**

Export the complete source fixture, preview/commit into the fresh destination, run the worker job, and assert:

- every included logical count matches;
- all non-user IDs match the source;
- every `owner_user_id` equals the destination initial-owner UUID and differs from source owner UUID;
- source owner display/settings are restored;
- provider IDs and assignments are preserved, but profiles are disabled, credentialless, health unknown, and failure counters reset;
- prompt overrides, worlds/versions/drafts, campaigns/state/history, turns, facts, Chronicle, illustrations, imports, costs, activity, and assets restore;
- every original is readable and every binding resolves;
- no vectors, thumbnails, model chains, generation attempts, or active operational jobs restore;
- illustration states are terminal;
- thumbnail backfill subsequently creates derivatives;
- enabling a restored embedding provider after adding credentials queues eligible reindex work.

- [ ] **Step 3: Add failing rollback/conflict tests**

Cover:

- non-empty destination rejects before job creation;
- destination changes after preview produce `archive-preview-stale`;
- source UUID conflict fails `archive-import-conflict`;
- forced SQL failure after several domains leaves destination empty;
- corrupt staged bytes fail before transaction;
- lost lease aborts before commit;
- repeating completed import fails emptiness instead of merging;
- newly written unreferenced files are cleaned after rollback;
- source asset and generated export artifacts remain untouched.

- [ ] **Step 4: Run round-trip tests and confirm failure**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts
```

Expected: FAIL because System Import execution is absent.

- [ ] **Step 5: Enqueue import from the exact preview**

Register:

```text
POST /api/v1/system-imports
GET  /api/v1/system-imports/:jobId
```

Commit:

1. hashes and locks the preview token;
2. requires `confirmEmptyDestination: true`;
3. checks owner, type, fingerprint, destination fingerprint, app version, expiry, and unused status;
4. rechecks that no active System Import exists;
5. creates one queued import job pointing to the root-relative staged path;
6. uses the preview ID as the import job's internal idempotency key;
7. marks preview consumed by that job;
8. returns 202.

- [ ] **Step 6: Acquire the exclusive gate and revalidate**

Worker import:

1. claims the job and sets `locking`;
2. borrows one dedicated client;
3. acquires the exclusive System Import advisory lock;
4. rechecks destination emptiness/migration compatibility;
5. reopens/revalidates the complete staged archive and all originals;
6. starts the database transaction only after validation.

Hold the exclusive lock until commit/rollback, terminal job update, and gate cleanup complete.

- [ ] **Step 7: Restore owner, providers, prompts, and asset roots**

Within one transaction, update portable initial-owner fields; insert provider
profiles with preserved IDs, destination owner, empty credential columns,
disabled state, health unknown, and deferred defaults; insert prompt overrides;
and insert asset core rows with preserved IDs, no derivatives, and nullable
bindings.

- [ ] **Step 8: Restore worlds, versions, drafts, and campaigns**

Insert worlds with covers deferred, then immutable world versions, drafts, and
campaigns with provider/asset pointers deferred where foreign-key order
requires.

- [ ] **Step 9: Restore state, turns, histories, and Chronicle**

Insert campaign state, accepted turns, profile edits, state edits, migrations,
transfers, canonical facts, memory configs, Chronicle memories without vectors,
and summary checkpoints.

- [ ] **Step 10: Restore terminal illustrations and audit records**

Insert terminal illustration sets/segments/segment assets, then imports, cost
events, and sanitized owner activity events.

- [ ] **Step 11: Restore asset metadata, bindings, and deferred pointers**

Insert asset library metadata, generation contexts, and live references.
Restore world covers, campaign provider assignments/defaults, and known image
API pointers. Write the normalization/import report to the System Archive job.

Every INSERT names columns explicitly. Any source ID absent from the validated
reference map is a hard conflict.

- [ ] **Step 12: Preserve IDs while remapping owner scope**

Use source UUIDs directly for every application record except `users`. Reject conflicts even if row content appears identical. Replace:

- row `ownerUserId`;
- created-by user IDs;
- nested owner scope fields in allowlisted portable records;
- ownership relationships;

with destination initial-owner UUID. Do not rewrite entity IDs embedded in fictional world content unless the logical contract identifies them as database record references.

- [ ] **Step 13: Restore originals rollback-safely**

Stream validated originals into content-addressed storage with `createThumbnail: false`, preserving source asset UUID rows. Track only paths newly created by this import. After rollback, delete a tracked path only if no committed destination asset row references its content hash.

After commit, the existing asset backfill worker regenerates missing thumbnails.

- [ ] **Step 14: Normalize provider and derived-data reactivation**

Modify `updateProvider` so a restored embedding provider that changes from disabled/credentialless to enabled/usable:

- finds owner campaigns whose imported memory config references that provider and has embedding enabled;
- enqueues one deduplicated `reindex_campaign` Chronicle job per eligible campaign;
- does not enqueue if credentials/model/config remain unusable.

Text/image provider re-enable does not recreate old operational jobs or remote provider state.

- [ ] **Step 15: Finalize job and cleanup**

After DB commit:

- mark job completed with counts, normalization, destination owner ID, and completed time;
- clear lease and staged path;
- remove only the staged archive;
- release exclusive advisory lock;
- let normal worker passes perform thumbnail and eligible reindex work.

On failure:

- roll back;
- cleanup newly created unreferenced originals;
- retain staging only until bounded failure cleanup finishes;
- mark failed with safe typed error;
- release lock/client in `finally`.

- [ ] **Step 16: Run round-trip, rollback, and image tests**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts tests/integration/image-pipeline.integration.test.ts tests/integration/import-memory.integration.test.ts
```

Expected: PASS with two actual PostgreSQL databases and distinct asset roots.

- [ ] **Step 17: Commit System Import execution**

```powershell
git add services/api/src/system-archive-service.ts services/api/src/archive-routes.ts services/api/src/provider-service.ts services/worker/src/worker.ts tests/integration/system-archive.integration.test.ts tests/integration/image-pipeline.integration.test.ts
git commit -m "Restore system archives into empty databases"
```

---

## Task 8: Add a distinct System Import experience

**Files:**

- Modify: `apps/web/public/index.html`
- Modify: `apps/web/public/nexus.js`
- Modify: `apps/web/public/nexus.css`
- Modify: `tests/unit/management-ui.test.ts`

- [ ] **Step 1: Add failing System Import UI tests**

Assert:

- `importSourceType` includes `system_archive` labeled `System backup (.zip)`;
- System Import has a dedicated preview area and confirmation checkbox;
- pasted content is disabled/rejected for this type;
- preview posts the ZIP only to `/api/v1/system-imports/preview`;
- commit posts token/confirmation without re-upload;
- status polls `/api/v1/system-imports/:jobId`;
- domain counts, asset sizes, migration result, emptiness, disabled providers, rebuild work, free space, warnings, and fingerprint render;
- browser code never opens System Archive record or asset entries with JSZip;
- accessible status announces progress/failure/completion.

- [ ] **Step 2: Run UI test and confirm failure**

Run:

```powershell
pnpm exec vitest run tests/unit/management-ui.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Add the explicit source type and confirmation**

Add:

```html
<option value="system_archive">System backup (.zip)</option>
```

When selected:

- require file upload;
- hide clipboard/paste and campaign destination controls;
- show System Import explanation;
- show a checkbox with exact meaning: “I understand this import requires an empty destination and will restore all portable system data.”

- [ ] **Step 4: Preview the System Archive on the server**

Upload once to `/api/v1/system-imports/preview`. Store only the returned token, summary, and selected file handle needed to request a new preview if the token expires. Do not parse `manifest.json`, NDJSON, or assets in browser code.

Render a table/list of domain counts and separate notices for:

- credentials excluded/providers disabled;
- thumbnails and eligible embeddings rebuilt;
- destination empty/not empty;
- required/available storage;
- unencrypted private content.

- [ ] **Step 5: Commit and poll the durable import**

POST:

```ts
{
  previewToken: selectedImport.previewToken,
  confirmEmptyDestination: elements.confirmEmptySystemImport.checked
}
```

Poll the returned job until completed/failed. Disable all other import controls while this job is active. Keep navigation, status, and health-related UI available. On completion, reload session, worlds, campaigns, providers, prompt library, and dashboard summaries.

- [ ] **Step 6: Handle typed failures**

Map:

- `archive-destination-not-empty` to per-domain blocker copy;
- `archive-preview-stale` to “Preview again”;
- `archive-storage-insufficient` to required/available byte details;
- `archive-version-unsupported` to source/destination version guidance;
- `system-import-in-progress` to current job progress;
- checksum/asset errors to safe logical path/source ID details.

Never display local paths, story content, provider metadata, or raw archive JSON.

- [ ] **Step 7: Add responsive and accessible styling**

Use semantic fieldsets, labels, `progress`, existing `.status`, and the existing mobile breakpoint. Keep the confirmation checkbox adjacent to the commit button and disable commit until checked and preview says empty/compatible.

- [ ] **Step 8: Run UI and syntax checks**

Run:

```powershell
pnpm exec vitest run tests/unit/management-ui.test.ts
node --check apps/web/public/nexus.js
pnpm check
```

Expected: PASS.

- [ ] **Step 9: Commit the distinct System Import UI**

```powershell
git add apps/web/public/index.html apps/web/public/nexus.js apps/web/public/nexus.css tests/unit/management-ui.test.ts
git commit -m "Add distinct system import UI"
```

---

## Task 9: Document operations and complete System Archive verification

**Files:**

- Create: `docs/nexus-guide/operations/system-data-migration.md`
- Modify: `docs/.vitepress/config.ts`
- Modify: `docs/nexus-guide/campaigns/import-export.md`
- Modify: `docs/nexus-guide/worlds/import-export.md`
- Modify: `docs/nexus-guide/providers/health-and-errors.md`
- Modify: `docs/operations/backup-restore.md`
- Modify: `docs/installation/environment-configuration.md`
- Review: all files changed by Tasks 1-8

- [ ] **Step 1: Write the System data migration guide**

Document:

- System Export from User Profile & Settings;
- job progress, download, 24-hour expiry;
- private/unencrypted archive handling;
- exact empty-destination prerequisite;
- distinct System Import selection, preview, confirmation, and progress;
- owner remapping and non-user ID preservation;
- provider credentials excluded, profiles disabled, and re-entry/re-enable steps;
- thumbnail and Chronicle rebuild behavior;
- typed failure recovery and safe retry;
- no merge support;
- distinction from disaster-recovery backup.

- [ ] **Step 2: Add the guide to Nexus navigation**

In `docs/.vitepress/config.ts`, add a `System data` group under `/nexus-guide/` with `System data migration` linking to `/nexus-guide/operations/system-data-migration`.

- [ ] **Step 3: Update related user/provider guidance**

State:

- Campaign Archive remains one campaign plus attached world/images;
- world JSON remains world-only;
- System Archive is owner-wide and uses its own import option;
- restored provider profiles retain assignments but are disabled, credentialless, and health unknown;
- credentials must be re-entered by role before use.

- [ ] **Step 4: Update operations and runtime configuration**

`docs/operations/backup-restore.md` must explain that System Archive does not replace coordinated PostgreSQL, asset storage, Swarm secrets/configs, and encryption-key backups.

`docs/installation/environment-configuration.md` must list archive storage root, preview/artifact TTLs, campaign/system compressed/uncompressed/entry limits, expansion limit, and lower-only operator behavior.

- [ ] **Step 5: Build documentation**

Run:

```powershell
pnpm --dir docs build
```

Expected: VitePress succeeds with the new page reachable from navigation.

- [ ] **Step 6: Run focused unit verification**

Run:

```powershell
pnpm exec vitest run tests/unit/archive-contracts.test.ts tests/unit/archive-io.test.ts tests/unit/asset-archive-service.test.ts tests/unit/system-archive-normalization.test.ts tests/unit/system-import-gate.test.ts tests/unit/management-ui.test.ts tests/unit/server-security.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run focused real-PostgreSQL verification**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required; a skipped suite is not verification" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/migrations.integration.test.ts tests/integration/campaign-archive.integration.test.ts tests/integration/system-archive.integration.test.ts tests/integration/import-memory.integration.test.ts tests/integration/image-pipeline.integration.test.ts tests/integration/world-library.integration.test.ts tests/integration/gameplay.integration.test.ts
```

Expected: PASS with the System Archive test creating and removing its fresh destination database.

- [ ] **Step 8: Run complete repository verification**

Run:

```powershell
pnpm check
pnpm build
pnpm test
pnpm --dir docs build
git diff --check
git status --short
```

Expected: all pass, integration is not skipped, and status contains no unintended files.

- [ ] **Step 9: Perform the end-to-end migration acceptance test**

1. Create multiple worlds/versions/campaigns, accepted turns, Chronicle content, provider profiles/assignments, prompt overrides, covers, segment variants, and an unreferenced library original.
2. Export the complete system.
3. Start a fresh database containing only migrations and its initial owner, with a separate empty asset root.
4. Select **System backup (.zip)**, preview, confirm, and run import.
5. Verify logical counts, preserved non-user IDs, destination owner remap, disabled providers, prompt settings, playable campaigns, exact images, unreferenced library asset, Chronicle behavior, and no credentials/active jobs/vectors/thumbnails in the archive.
6. Add credentials and enable restored providers; verify assignments remain and eligible Chronicle reindex starts only when usable.
7. Attempt the same import again and confirm the destination-not-empty failure.
8. During a forced long import, confirm ordinary mutating APIs return 503 while health, readiness, static UI, and job status remain available.

- [ ] **Step 10: Commit documentation and verification corrections**

```powershell
git add docs/.vitepress/config.ts docs/nexus-guide/operations/system-data-migration.md docs/nexus-guide/campaigns/import-export.md docs/nexus-guide/worlds/import-export.md docs/nexus-guide/providers/health-and-errors.md docs/operations/backup-restore.md docs/installation/environment-configuration.md
git commit -m "Document system archive migration"
```

Do not stage unrelated generated or user-owned worktree files.

---

## System Archive completion checkpoint

The feature is complete only when:

- Campaign Export remains standalone and unchanged in scope;
- System Export includes every approved logical domain and every original owner asset;
- System Import appears as its own explicit option;
- preview validates the full archive and empty destination before issuing a token;
- import preserves every non-user ID and remaps only owner scope;
- providers are disabled and credentialless with assignments retained;
- excluded jobs, credentials, vectors, thumbnails, response chains, and remote state are absent;
- import rollback leaves no relational partial state or orphan original files;
- ordinary writes receive typed 503 throughout the exclusive import gate;
- completed exports expire without touching source data;
- full unit, real-PostgreSQL integration, build, documentation, diff, and end-to-end checks pass.
