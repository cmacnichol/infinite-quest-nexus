# System Archive Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complete Current Owner System Archive export/import workflow with resumable transfer, deterministic logical records, every retained original image, empty-destination import, durable reports, and unified legacy/replacement UI access.

**Architecture:** Extend the existing Campaign Archive manifest, private durable filesystem operations, portable staging/publication boundaries, and worker lanes. New application ports own System Archive policy; PostgreSQL adapters stream logical records and own job state; runtime compositions bind archives and Original Asset publication; API and both clients consume safe opaque views only.

**Tech Stack:** Node.js 22, TypeScript 7, Fastify 5, PostgreSQL 18/pgvector, Zod 4, archiver 8, unzipper 0.12.5, Sharp 0.35, Vitest 4, legacy browser JavaScript, web-next TypeScript, VitePress.

**Spec:** `docs/superpowers/specs/2026-07-26-portable-campaign-and-system-archives-design.md`

## Global Constraints

- Preserve all existing import/export formats and routes.
- Format version 1 contains exactly one Current Owner and imports only into an empty initialized destination.
- Preserve portable non-user UUIDs; remap every owner relationship to the destination initial owner.
- Never export credentials, encryption material, access capabilities, active jobs, model chains, vectors, chunks, caches, thumbnails, or deployment configuration.
- Include every retained Original Asset, including unbound and archived Image Library entries.
- Use logical versioned records, never SQL or table dumps.
- Browser code never parses archive entries or receives a server filesystem path.
- Reuse private durable filesystem and asset-publication boundaries; do not add direct `fs` mutation to API or application modules.
- Keep System Archive behind `SYSTEM_ARCHIVE_ENABLED=false` until the final round-trip gate passes.
- Apply strict TDD and record RED/GREEN evidence for each task.
- PostgreSQL suites require `TEST_DATABASE_URL`; skipped suites remain unverified.
- Do not modify historical root `index.html`.

---

## File and interface map

### Create

- `packages/contracts/src/system-archives.ts` — public schemas for logical records, jobs, uploads, previews, reports, and API requests.
- `packages/application/src/system-archives/types.ts` — owner-bound commands/views and branded opaque handles.
- `packages/application/src/system-archives/ports.ts` — archive, job, snapshot, upload, import, and rebuild ports.
- `packages/application/src/system-archives/use-cases.ts` — policy orchestration without SQL or paths.
- `packages/application/src/system-archives/portability-registry.ts` — exhaustive persisted-domain classification.
- `packages/application/src/system-archives/index.ts` — public application exports.
- `database/migrations/0078_system_archive_jobs.sql` — durable export/import jobs, leases, reports, and active-job constraints.
- `database/migrations/0079_resumable_system_archive_uploads.sql` — owner-scoped upload sessions/chunks and durable filesystem authority.
- `packages/database/src/system-archive-job-repository.ts` — enqueue, claim, heartbeat, cancel, progress, terminal result.
- `packages/database/src/system-archive-export-repository.ts` — repeatable-read owner snapshot and keyset streams.
- `packages/database/src/system-archive-import-repository.ts` — emptiness fingerprint and atomic logical insert graph.
- `packages/database/src/system-archive-upload-repository.ts` — resumable session/chunk metadata.
- `services/runtime/src/system-archive-composition.ts` — archive I/O, upload assembly, preview, export, and import compositions.
- `services/api/src/system-archive-routes.ts` — owner-scoped HTTP routes and range downloads.
- `services/api/src/system-import-gate.ts` — shared/exclusive PostgreSQL mutation gate.
- `services/worker/src/system-archive-worker.ts` — durable job lane.
- `scripts/system-archive.ts` — headless HTTP client using the public API.
- `apps/web-next/src/data-transfer-api.ts` — safe System Archive HTTP client.
- `apps/web-next/src/data-transfer-page.ts` — replacement UI Data Transfer page.
- `tests/unit/system-archive-contracts.test.ts`
- `tests/unit/system-archive-portability.test.ts`
- `tests/unit/system-archive-use-cases.test.ts`
- `tests/unit/system-archive-routes.test.ts`
- `tests/unit/system-import-gate.test.ts`
- `tests/unit/system-archive-cli.test.ts`
- `tests/unit/web-next-data-transfer.test.ts`
- `tests/e2e/data-transfer.e2e.test.ts`
- `playwright.config.ts` — rendered legacy/replacement Data Transfer coverage.
- `tests/integration/system-archive.integration.test.ts`
- `tests/integration/system-archive-resumable.integration.test.ts`
- `tests/fixtures/system-archives/v1-minimal/` — deterministic current-version fixture.

### Modify

- `packages/contracts/src/index.ts` — export System Archive contracts.
- `packages/application/src/index.ts` — export application surface.
- `packages/database/src/config.ts` — default-off capability and upload TTL/chunk settings.
- `database/migrations/0053_durable_asset_portable_operations.sql` only through a new migration, never in place — extend supported artifact/input kinds via `0078`/`0079`.
- `services/api/src/server.ts` — register gate and routes in security-correct order.
- `services/worker/src/worker.ts` — add one bounded System Archive lane.
- `services/runtime/src/main.ts` — compose System Archive dependencies.
- `apps/web/public/index.html`, `apps/web/public/nexus.js`, `apps/web/public/nexus.css` — legacy Nexus Data Transfer.
- `apps/web-next/src/app-shell.ts` — native Data Transfer navigation.
- `apps/web-next/src/bootstrap.ts` — route `/app/data-transfer` to the native page.
- `tests/unit/management-ui.test.ts`, `tests/unit/server-security.test.ts`, `tests/unit/worker-concurrency.test.ts`, `tests/integration/migrations.integration.test.ts`.
- `package.json` — add `system-archive` CLI script.
- User, provider, environment, and operations documentation named in Task 9.

### Stable interfaces

```ts
export type PortabilityClass =
  | "portable_authority"
  | "portable_normalized"
  | "rebuildable"
  | "operational"
  | "security_authority"
  | "deployment_configuration";

export type SystemArchiveJobKind = "export" | "import";
export type SystemArchiveJobStatus =
  | "queued" | "capturing" | "writing" | "verifying" | "published"
  | "uploading" | "validating" | "previewed" | "revalidating"
  | "waiting_for_gate" | "importing" | "authoritative_committed"
  | "rebuilding" | "completed" | "cancelling" | "cancelled"
  | "rolled_back" | "failed" | "expired";

export interface SystemArchiveApplication {
  enqueueExport(command: EnqueueSystemExportCommand): Promise<SystemArchiveJobView>;
  getJob(command: GetSystemArchiveJobCommand): Promise<SystemArchiveJobView>;
  cancelJob(command: CancelSystemArchiveJobCommand): Promise<SystemArchiveJobView>;
  createUpload(command: CreateSystemUploadCommand): Promise<SystemUploadView>;
  putChunk(command: PutSystemUploadChunkCommand): Promise<SystemUploadView>;
  completeUpload(command: CompleteSystemUploadCommand): Promise<SystemUploadView>;
  previewImport(command: PreviewSystemImportCommand): Promise<SystemImportPreviewView>;
  commitImport(command: CommitSystemImportCommand): Promise<SystemArchiveJobView>;
}
```

---

### Task 1: Add exhaustive classification and System Archive contracts

**Files:**
- Create: `packages/contracts/src/system-archives.ts`
- Create: `packages/application/src/system-archives/portability-registry.ts`
- Create: `packages/application/src/system-archives/types.ts`
- Create: `packages/application/src/system-archives/index.ts`
- Create: `tests/unit/system-archive-contracts.test.ts`
- Create: `tests/unit/system-archive-portability.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/application/src/index.ts`

**Interfaces:**
- Consumes: existing `archiveManifestSchema`, `archiveAssetRecordSchema`, `archiveErrorCodeSchema`.
- Produces: `SYSTEM_ARCHIVE_DOMAINS`, `SYSTEM_ARCHIVE_TABLE_CLASSIFICATIONS`, payload/job/upload/preview/report schemas, and branded owner-bound commands.

- [ ] **Step 1: Write failing contract tests**

```ts
expect(systemArchivePayloadSchema.parse(validPayload).sourceOwnerCount).toBe(1);
expect(() => systemPortableProviderSchema.parse({ encryptedApiKey: "secret" })).toThrow();
expect(() => systemChronicleRecordSchema.parse({ embedding: [0.1] })).toThrow();
expect(systemArchiveJobViewSchema.parse(job).status).toBe("queued");
```

- [ ] **Step 2: Write the failing migration-inventory classification test**

```ts
const createdTables = await readCreatedTableNames("database/migrations");
expect(createdTables.filter((table) => !(table in SYSTEM_ARCHIVE_TABLE_CLASSIFICATIONS))).toEqual([]);
```

The helper parses literal `CREATE TABLE`/`CREATE TABLE IF NOT EXISTS` identifiers and fails on duplicates or dynamic names.

- [ ] **Step 3: Run RED**

```powershell
pnpm exec vitest run tests/unit/system-archive-contracts.test.ts tests/unit/system-archive-portability.test.ts
```

Expected: FAIL because the System Archive schemas and exhaustive registry do not exist.

- [ ] **Step 4: Implement strict schemas and classifications**

```ts
export const SYSTEM_ARCHIVE_DOMAINS = [
  "providers", "prompts", "worlds", "world-versions", "world-drafts",
  "campaigns", "turns", "turn-corrections", "campaign-state",
  "campaign-history", "canonical-facts", "chronicle", "illustrations",
  "imports", "cost-events", "activity-events"
] as const;

const portableJsonValueSchema = z.json();

export const systemRecordEnvelopeSchema = z.object({
  domain: z.enum(SYSTEM_ARCHIVE_DOMAINS),
  formatVersion: z.literal(1),
  sourceId: z.string().uuid(),
  record: z.record(z.string(), portableJsonValueSchema)
}).strict();
```

Classify every current migration table. Mark `turn_narration_corrections` portable authority; `world_share_links` security authority; Chronicle chunks/runs/cache rebuildable; and all portable/publication/filesystem/admission/job tables operational.

- [ ] **Step 5: Run GREEN and repository checks**

```powershell
pnpm exec vitest run tests/unit/system-archive-contracts.test.ts tests/unit/system-archive-portability.test.ts
pnpm check
```

- [ ] **Step 6: Commit**

```powershell
git add packages/contracts/src/system-archives.ts packages/contracts/src/index.ts packages/application/src/system-archives packages/application/src/index.ts tests/unit/system-archive-contracts.test.ts tests/unit/system-archive-portability.test.ts
git commit -m "Define system archive portability contracts"
```

### Task 2: Add durable jobs and resumable-upload persistence

**Files:**
- Create: `database/migrations/0078_system_archive_jobs.sql`
- Create: `database/migrations/0079_resumable_system_archive_uploads.sql`
- Create: `packages/database/src/system-archive-job-repository.ts`
- Create: `packages/database/src/system-archive-upload-repository.ts`
- Modify: `packages/database/src/config.ts`
- Modify: `tests/unit/security-config.test.ts`
- Modify: `tests/integration/migrations.integration.test.ts`
- Create: `tests/integration/system-archive-resumable.integration.test.ts`

**Interfaces:**
- Consumes: `portable_staged_inputs`, `portable_export_artifacts`, `durable_filesystem_operations`, owner scopes, hashed opaque handles.
- Produces: `SystemArchiveJobRepository`, `SystemArchiveUploadRepository`, `SYSTEM_ARCHIVE_ENABLED`, chunk size/TTL configuration, limit-increase and unknown-capacity operator gates.

- [ ] **Step 1: Add failing migration and repository tests**

```ts
await expect(repository.enqueueExport(owner, idempotency)).resolves.toMatchObject({ status: "queued" });
await expect(repository.enqueueExport(owner, idempotency)).resolves.toMatchObject({ id: first.id });
await expect(uploads.recordChunk({ uploadId, index: 0, offset: 0, bytes: 4, sha256 })).resolves.toMatchObject({ receivedBytes: 4 });
```

Assert one active export per owner, one active import globally, lease-safe claims, heartbeat expiry, same-chunk replay, conflicting-chunk rejection, and owner isolation.

- [ ] **Step 2: Run RED with PostgreSQL**

```powershell
pnpm exec vitest run tests/integration/migrations.integration.test.ts tests/integration/system-archive-resumable.integration.test.ts
```

Expected: FAIL because migrations `0078` and `0079` and repositories are absent.

- [ ] **Step 3: Create additive online migrations**

```sql
CREATE TABLE system_archive_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('export','import')),
  status text NOT NULL,
  idempotency_key_hash text NOT NULL,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  report jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, kind, idempotency_key_hash)
);
```

Add partial active-job indexes, strict status/lease constraints, safe foreign keys to staged inputs/artifacts, upload session/chunk tables, expiry indexes, and owner-scope triggers. Extend generic portable kind constraints only through these migrations.

Alter `portable_export_artifacts` in `0078` so `export_kind='system_zip'` requires `campaign_id`, `world_id`, and `world_version_id` to be null while `content_type='application/zip'`. Preserve existing Campaign/World constraints. System Import jobs reference completed `portable_staged_inputs` directly and do not reuse campaign/world destination columns from `portable_import_operations`.

- [ ] **Step 4: Implement claim/heartbeat/cancel/upload repositories**

```ts
export interface SystemArchiveJobRepository {
  enqueueExport(owner: OwnerScope, idempotencyKeyHash: string): Promise<SystemArchiveJobView>;
  claimNext(workerId: string, leaseSeconds: number): Promise<ClaimedSystemArchiveJob | null>;
  heartbeat(jobId: string, workerId: string, leaseSeconds: number): Promise<boolean>;
  requestCancellation(owner: OwnerScope, jobId: string): Promise<SystemArchiveJobView>;
}
```

- [ ] **Step 5: Add configuration with safe defaults**

```ts
systemArchiveEnabled: booleanSetting("SYSTEM_ARCHIVE_ENABLED", false),
systemArchiveUploadTtlSeconds: boundedArchiveIntegerSetting("SYSTEM_ARCHIVE_UPLOAD_TTL_SECONDS", 86_400, 300, 604_800),
systemArchiveChunkBytes: boundedArchiveIntegerSetting("SYSTEM_ARCHIVE_CHUNK_BYTES", 16_777_216, 1_048_576, 67_108_864),
systemArchiveAllowLimitIncrease: booleanSetting("SYSTEM_ARCHIVE_ALLOW_LIMIT_INCREASE", false),
systemArchiveAllowUnknownFreeSpace: booleanSetting("SYSTEM_ARCHIVE_ALLOW_UNKNOWN_FREE_SPACE", false),
```

Keep current approved limits as hard maxima unless `SYSTEM_ARCHIVE_ALLOW_LIMIT_INCREASE=true`; only then may parsing accept explicitly configured larger safe integers. Neither gate is portable or browser-controlled. Add config tests proving both defaults are false and malformed booleans fail startup.

- [ ] **Step 6: Run GREEN**

```powershell
pnpm exec vitest run tests/integration/migrations.integration.test.ts tests/integration/system-archive-resumable.integration.test.ts tests/unit/security-config.test.ts
pnpm check
```

- [ ] **Step 7: Commit**

```powershell
git add database/migrations/0078_system_archive_jobs.sql database/migrations/0079_resumable_system_archive_uploads.sql packages/database/src/system-archive-job-repository.ts packages/database/src/system-archive-upload-repository.ts packages/database/src/config.ts tests/integration/migrations.integration.test.ts tests/integration/system-archive-resumable.integration.test.ts tests/unit/security-config.test.ts
git commit -m "Add durable system archive jobs"
```

### Task 3: Build deterministic owner-wide System Export

**Files:**
- Create: `packages/application/src/system-archives/ports.ts`
- Create: `packages/application/src/system-archives/use-cases.ts`
- Modify: `packages/application/src/system-archives/index.ts`
- Create: `packages/database/src/system-archive-export-repository.ts`
- Create: `services/runtime/src/system-archive-composition.ts`
- Create: `tests/unit/system-archive-use-cases.test.ts`
- Create: `tests/integration/system-archive.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 record contracts; Task 2 jobs; Campaign Archive manifest writer; private asset readers.
- Produces: `SystemArchiveSnapshotPort`, `SystemArchiveWriterPort`, `runSystemExport(job)`.

- [ ] **Step 1: Create an exhaustive PostgreSQL export fixture and failing assertions**

```ts
expect(report.domainCounts["turn-corrections"]).toBe(1);
expect(report.originalAssets).toBe(4); // cover, selected, alternate, unbound library
expect(serialized).not.toContain("encrypted_api_key");
expect(serialized).not.toContain("world_share_links");
expect(serialized).not.toContain("chronicle_memory_chunks");
```

- [ ] **Step 2: Run RED**

```powershell
pnpm exec vitest run tests/unit/system-archive-use-cases.test.ts tests/integration/system-archive.integration.test.ts
```

- [ ] **Step 3: Implement repeatable-read keyset streams**

```ts
export interface SystemArchiveSnapshotPort {
  withOwnerSnapshot<T>(owner: OwnerScope, consume: (snapshot: SystemArchiveSnapshot) => Promise<T>): Promise<T>;
}

export interface SystemArchiveSnapshot {
  readOwner(): Promise<SystemOwnerRecord>;
  streamDomain(domain: SystemArchiveDomain, afterId?: string): AsyncIterable<SystemRecordEnvelope>;
  listOriginalAssets(): AsyncIterable<SystemOriginalAssetRecord>;
  summarizeExcludedOperationalWork(): Promise<Readonly<Record<string, number>>>;
}
```

Use deterministic UUID/chronology ordering and bounded pages. Keep the repeatable-read transaction open only for logical record streaming and immutable asset inventory; verify each file again while writing.

- [ ] **Step 4: Implement deterministic sharding and publication**

```ts
await writer.writeDomainShards(domain, records, { targetBytes: 256 * 1024 * 1024 });
await writer.writeOriginal({ archivePath, expectedSha256, expectedBytes, stream });
const artifact = await writer.publish({ manifest, contentFingerprint });
```

Abort and mark failed if any declared original is missing, changes identity, fails decode, or mismatches metadata.

- [ ] **Step 5: Add cancellation, progress, and inconsistency tests**

Assert cancellation removes only unpublished artifacts; active jobs are excluded by category/count; and a changing/missing asset prevents publication.

- [ ] **Step 6: Run GREEN**

```powershell
pnpm exec vitest run tests/unit/system-archive-use-cases.test.ts tests/integration/system-archive.integration.test.ts tests/unit/archive-io.test.ts tests/unit/task-14e3f-export-stream-abort.test.ts
```

- [ ] **Step 7: Commit**

```powershell
git add packages/application/src/system-archives packages/database/src/system-archive-export-repository.ts services/runtime/src/system-archive-composition.ts tests/unit/system-archive-use-cases.test.ts tests/integration/system-archive.integration.test.ts
git commit -m "Stream complete system archives"
```

### Task 4: Assemble resumable uploads and validate Import Preview

**Files:**
- Modify: `services/runtime/src/system-archive-composition.ts`
- Modify: `packages/database/src/system-archive-upload-repository.ts`
- Create: `packages/database/src/system-archive-import-repository.ts`
- Modify: `tests/integration/system-archive-resumable.integration.test.ts`
- Modify: `tests/integration/system-archive.integration.test.ts`

**Interfaces:**
- Consumes: private bounded prewrite/publish operations, upload metadata, strict System Archive schemas.
- Produces: upload-session methods, assembled staged input, destination fingerprint, `SystemImportPreviewView`.

- [ ] **Step 1: Add failing chunk and preview safety tests**

Cover replay, conflicting hash, missing chunk, overlap, truncation, restart after process recreation, unsafe ZIP names, Unicode duplicates, expansion limits, corrupt images, broken relationships, insufficient space, multi-owner archive, and non-empty destination.

- [ ] **Step 2: Run RED**

```powershell
pnpm exec vitest run tests/integration/system-archive-resumable.integration.test.ts tests/integration/system-archive.integration.test.ts
```

- [ ] **Step 3: Implement bounded chunk publication**

```ts
await uploads.putChunk({
  owner,
  uploadHandle,
  index,
  offset,
  byteLength,
  sha256,
  body: bindPrivateBoundedStreamLimits(body, { maxBytes: config.systemArchiveChunkBytes })
});
```

Publish each chunk through private durable filesystem authority. Completion requires contiguous ranges and verifies the assembled compressed hash before producing one opaque staged-input handle.

- [ ] **Step 4: Implement exact emptiness/capacity fingerprint**

```ts
export type SystemImportDestinationFingerprint = Readonly<{
  initialOwnerId: string;
  latestMigration: string;
  authoritativeCountsHash: string;
  activeJobsHash: string;
  checkedAt: string;
}>;
```

Ignore only the current upload/preview/job infrastructure. Any owner content or unrelated active job makes preview invalid.

- [ ] **Step 5: Implement preview validation and opaque authority**

Return versions, fingerprint, counts, bytes, owner mapping, disabled providers, invalidated access, normalization, rebuilds, space, and safe diagnostics. Bind them to 30-minute preview authority; never expose paths.

- [ ] **Step 6: Run GREEN and fault restart tests**

```powershell
pnpm exec vitest run tests/integration/system-archive-resumable.integration.test.ts tests/integration/system-archive.integration.test.ts tests/unit/archive-io.test.ts
```

- [ ] **Step 7: Commit**

```powershell
git add services/runtime/src/system-archive-composition.ts packages/database/src/system-archive-upload-repository.ts packages/database/src/system-archive-import-repository.ts tests/integration/system-archive-resumable.integration.test.ts tests/integration/system-archive.integration.test.ts
git commit -m "Validate resumable system imports"
```

### Task 5: Gate mutations and execute atomic empty-destination import

**Files:**
- Create: `services/api/src/system-import-gate.ts`
- Create: `tests/unit/system-import-gate.test.ts`
- Modify: `services/api/src/server.ts`
- Modify: `services/runtime/src/system-archive-composition.ts`
- Modify: `packages/database/src/system-archive-import-repository.ts`
- Modify: `tests/unit/server-security.test.ts`
- Modify: `tests/integration/system-archive.integration.test.ts`

**Interfaces:**
- Consumes: preview authority, destination fingerprint, existing private Original Asset publication, PostgreSQL advisory locks.
- Produces: `registerSystemImportGate`, `runSystemImport(job)`, rebuild requests, durable Import Report.

- [ ] **Step 1: Add failing gate and rollback tests**

```ts
expect(await app.inject({ method: "POST", url: "/api/v1/worlds" })).toMatchObject({ statusCode: 503 });
expect(await app.inject({ method: "GET", url: "/health/ready" })).toMatchObject({ statusCode: 200 });
expect(await app.inject({ method: "GET", url: `/api/v1/system-imports/${jobId}` })).toMatchObject({ statusCode: 200 });
```

Inject a mid-domain database failure and an asset-publication failure; assert the destination remains empty and pre-existing originals survive.

- [ ] **Step 2: Run RED**

```powershell
pnpm exec vitest run tests/unit/system-import-gate.test.ts tests/unit/server-security.test.ts tests/integration/system-archive.integration.test.ts
```

- [ ] **Step 3: Implement shared API and exclusive worker locks**

```ts
export const SYSTEM_IMPORT_LOCK_KEY = "infinitequest:system-import:v1";

export async function withSystemMutationPermit<T>(pool: DatabasePool, work: () => Promise<T>): Promise<T>;
export async function withExclusiveSystemImport<T>(client: DatabaseClient, work: () => Promise<T>): Promise<T>;
```

Register after security/CORS hooks and before all mutating domain routes. Exempt GET/HEAD/OPTIONS, health/readiness/static assets, status, and the commit enqueue route only.

- [ ] **Step 4: Implement dependency-ordered transactional import**

Insert owner profile, providers/prompts, worlds/versions/drafts, campaigns/state/history, turns/corrections, facts, Chronicle, illustrations, provenance/costs/activity, then assets/bindings. Preserve non-user IDs and replace every owner relation with the destination owner.

```ts
await importRepository.withAtomicImport(owner, async (tx) => {
  await tx.insertLogicalDomains(validated.domains);
  await assetPublisher.publishOriginals(tx, validated.originals);
  await tx.recordImportReport(report);
});
```

- [ ] **Step 5: Normalize providers/access and enqueue rebuilds**

Reset provider health and secrets, keep assignments, exclude share links/identities, normalize illustration states, queue thumbnails and eligible Chronicle work only after commit.

- [ ] **Step 6: Add crash/retry/non-cancellable tests**

Assert pre-transaction cancellation succeeds; cancellation during `importing` is rejected; stale previews fail; process restart revalidates and restarts from an empty destination; rebuild failure leaves import authority committed.

- [ ] **Step 7: Run GREEN**

```powershell
pnpm exec vitest run tests/unit/system-import-gate.test.ts tests/unit/server-security.test.ts tests/integration/system-archive.integration.test.ts tests/integration/asset-archive.integration.test.ts
```

- [ ] **Step 8: Commit**

```powershell
git add services/api/src/system-import-gate.ts services/api/src/server.ts services/runtime/src/system-archive-composition.ts packages/database/src/system-archive-import-repository.ts tests/unit/system-import-gate.test.ts tests/unit/server-security.test.ts tests/integration/system-archive.integration.test.ts
git commit -m "Restore system archives atomically"
```

### Task 6: Add API routes, worker lane, range downloads, and headless CLI

**Files:**
- Create: `services/api/src/system-archive-routes.ts`
- Create: `services/worker/src/system-archive-worker.ts`
- Create: `tests/unit/system-archive-routes.test.ts`
- Create: `scripts/system-archive.ts`
- Create: `tests/unit/system-archive-cli.test.ts`
- Modify: `services/api/src/server.ts`
- Modify: `services/worker/src/worker.ts`
- Modify: `services/runtime/src/main.ts`
- Modify: `tests/unit/worker-concurrency.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `SystemArchiveApplication`, job repository, runtime composition, private download grants.
- Produces: specified `/api/v1/system-*` routes, one bounded worker lane, `pnpm system-archive`.

- [ ] **Step 1: Add failing route, range, authorization, and CLI tests**

Test feature-disabled 404, 202 enqueue, owner isolation, idempotency, chunk bounds, stale handles, cancellation boundaries, `Range`/`If-Range`, ETag, no-store, disconnect cleanup, and CLI never importing database modules.

- [ ] **Step 2: Run RED**

```powershell
pnpm exec vitest run tests/unit/system-archive-routes.test.ts tests/unit/system-archive-cli.test.ts tests/unit/worker-concurrency.test.ts
```

- [ ] **Step 3: Register routes behind the capability**

```ts
if (config.systemArchiveEnabled) {
  await app.register(registerSystemArchiveRoutes, { application, limits: config.systemArchiveLimits });
}
```

All route projections parse shared response schemas. File streams bind cleanup to response close/abort and return safe typed errors.

- [ ] **Step 4: Add one fair worker lane**

```ts
type ActiveLane = {
  name: "illustration" | "chronicle" | "asset" | "system-archive";
  active: Set<Promise<boolean>>;
  nextEligibleAt: number;
  run(): Promise<boolean>;
};
```

Claim at most one System Archive job; heartbeat leases; do not starve generation/illustration/Chronicle/asset lanes; recover expired leases.

- [ ] **Step 5: Implement the API-only CLI**

```powershell
pnpm system-archive -- export --base-url http://127.0.0.1:8080 --output .\system.zip
pnpm system-archive -- import --base-url http://127.0.0.1:8080 --file .\system.zip
pnpm system-archive -- status --base-url http://127.0.0.1:8080 --job <uuid>
```

Use Undici HTTP calls, resumable chunks, range downloads, JSON status, and explicit confirmation for import. Do not read PostgreSQL or storage roots.

- [ ] **Step 6: Run GREEN**

```powershell
pnpm exec vitest run tests/unit/system-archive-routes.test.ts tests/unit/system-archive-cli.test.ts tests/unit/worker-concurrency.test.ts tests/unit/archive-routes.test.ts
pnpm check
```

- [ ] **Step 7: Commit**

```powershell
git add services/api/src/system-archive-routes.ts services/api/src/server.ts services/worker/src/system-archive-worker.ts services/worker/src/worker.ts services/runtime/src/main.ts scripts/system-archive.ts package.json tests/unit/system-archive-routes.test.ts tests/unit/system-archive-cli.test.ts tests/unit/worker-concurrency.test.ts
git commit -m "Expose durable system archive transfers"
```

### Task 7: Add unified Data Transfer to both active UI surfaces

**Files:**
- Modify: `apps/web/public/index.html`
- Modify: `apps/web/public/nexus.js`
- Modify: `apps/web/public/nexus.css`
- Create: `apps/web-next/src/data-transfer-api.ts`
- Create: `apps/web-next/src/data-transfer-page.ts`
- Modify: `apps/web-next/src/app-shell.ts`
- Modify: `apps/web-next/src/bootstrap.ts`
- Modify: `tests/unit/management-ui.test.ts`
- Create: `tests/unit/web-next-data-transfer.test.ts`
- Create: `tests/e2e/data-transfer.e2e.test.ts`
- Create: `playwright.config.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: server-side detection, System Archive routes, existing import/export routes.
- Produces: accessible Data Transfer navigation, upload/progress/preview/confirm/report UI in both clients.

- [ ] **Step 1: Add failing legacy and replacement UI tests**

Assert purpose cards, contextual shortcuts, resumable progress, preview categories, empty-destination and non-cancellable acknowledgements, cancellation, provider/access/rebuild/report results, and no JSZip/archive-entry parsing.

- [ ] **Step 2: Run RED**

```powershell
pnpm exec vitest run tests/unit/management-ui.test.ts tests/unit/web-next-data-transfer.test.ts
```

- [ ] **Step 3: Build server-driven shared view behavior**

```ts
export type DataTransferApi = Readonly<{
  createExport(idempotencyKey: string): Promise<SystemArchiveJobView>;
  createUpload(file: File): Promise<SystemUploadView>;
  preview(uploadHandle: string): Promise<SystemImportPreviewView>;
  commit(previewHandle: string, idempotencyKey: string): Promise<SystemArchiveJobView>;
}>;
```

The replacement page renders native UI. Legacy Nexus uses the same JSON contracts. Neither reads ZIP entries.

- [ ] **Step 4: Preserve every existing route and shortcut**

Keep Campaign Management export, World export, Story readable exports, and every legacy/external source. Move Import navigation copy to Data Transfer without breaking `#imports` deep links; redirect them to the appropriate section.

- [ ] **Step 5: Add accessibility and disconnect behavior**

Use live regions for phases/errors, focus the first invalid acknowledgement, preserve upload state on rerender, disable only unavailable actions, and restore controls after terminal status.

- [ ] **Step 6: Add rendered cross-surface browser coverage**

```ts
test("System Archive preview and confirmation remain server-owned", async ({ page }) => {
  await page.goto("/app/data-transfer");
  await expect(page.getByRole("heading", { name: "Data Transfer" })).toBeVisible();
  await page.getByLabel("System Archive file").setInputFiles(fixturePath);
  await expect(page.getByText("Destination must be empty")).toBeVisible();
});
```

Configure Playwright to start the built application against an isolated PostgreSQL database and asset/archive roots. Run the same upload/preview/status checks through `/nexus/#data-transfer` and `/app/data-transfer`, plus keyboard focus, responsive layout, cancellation, disconnect/reload, and accessible error announcements.

- [ ] **Step 7: Run GREEN, browser tests, and client builds**

```powershell
pnpm exec vitest run tests/unit/management-ui.test.ts tests/unit/web-next-data-transfer.test.ts tests/unit/web-next-campaign-editor.test.ts
pnpm build:web:legacy
pnpm build:web:next
pnpm exec playwright test tests/e2e/data-transfer.e2e.test.ts
```

- [ ] **Step 8: Commit**

```powershell
git add apps/web/public/index.html apps/web/public/nexus.js apps/web/public/nexus.css apps/web-next/src/data-transfer-api.ts apps/web-next/src/data-transfer-page.ts apps/web-next/src/app-shell.ts apps/web-next/src/bootstrap.ts tests/unit/management-ui.test.ts tests/unit/web-next-data-transfer.test.ts tests/e2e/data-transfer.e2e.test.ts playwright.config.ts package.json
git commit -m "Unify portable data transfer UI"
```

### Task 8: Lock compatibility and complete end-to-end verification

**Files:**
- Create: `tests/fixtures/system-archives/v1-minimal/manifest.json`
- Create: `tests/fixtures/system-archives/v1-minimal/system.json`
- Create: `tests/integration/system-archive-e2e.integration.test.ts`
- Modify: every existing import/export unit and integration suite affected by shared detection.
- Modify: `packages/database/src/config.ts` only after the release gate decision.

**Interfaces:**
- Consumes: Tasks 1-7 and all existing Compatibility Adapters.
- Produces: frozen v1 fixture, fresh-instance round-trip proof, capability-release evidence.

- [ ] **Step 1: Freeze a deterministic v1 compatibility fixture**

Generate it from a sanitized minimal logical fixture, then check in exact manifest/payload bytes and hashes. The test imports it without regenerating it.

- [ ] **Step 2: Add the complete fresh-database scenario**

Create multiple worlds/versions/drafts/campaigns/turns/corrections, Chronicle content, prompts, providers, costs, selected/alternate/unbound/archived originals, excluded jobs/vectors/share links, then export and import into a newly created migrated test database and empty asset root.

- [ ] **Step 3: Assert the acceptance contract**

Compare logical identities, owner remap, playable campaigns, state/history, Original Asset hashes, settings, disabled providers, invalidated access, absence of excluded domains, preview/report reconciliation, and derived rebuild status.

- [ ] **Step 4: Add failure and platform scenarios**

Inject worker death, transaction failure, disconnect, disk exhaustion, hash mismatch, unsafe ZIP, stale preview, cancellation, and Windows junction/Linux symlink attacks. Mark platform cases skipped only with an explicit unverified report.

- [ ] **Step 5: Run every compatibility suite**

```powershell
pnpm test:unit
pnpm test:integration
pnpm check
pnpm build
pnpm exec playwright test tests/e2e/data-transfer.e2e.test.ts
```

- [ ] **Step 6: Review the capability gate**

Keep `SYSTEM_ARCHIVE_ENABLED=false` unless the real PostgreSQL, filesystem, both-client browser, compatibility, and fresh-instance round-trip evidence is present in the review. Enabling it is a focused follow-up commit after that evidence, not an assumption inside this task.

- [ ] **Step 7: Commit**

```powershell
git add tests/fixtures/system-archives tests/integration/system-archive-e2e.integration.test.ts packages/database/src/config.ts
git commit -m "Verify system archive round trips"
```

### Task 9: Publish user and operator documentation

**Files:**
- Create: `docs/nexus-guide/operations/system-data-transfer.md`
- Modify: `docs/.vitepress/config.ts`
- Modify: `docs/nexus-guide/campaigns/import-export.md`
- Modify: `docs/nexus-guide/worlds/import-export.md`
- Modify: `docs/player-guide/saving-and-exporting.md`
- Modify: `docs/installation/provider-configuration.md`
- Modify: `docs/installation/environment-configuration.md`
- Modify: `docs/operations/backup-restore.md`
- Modify: `docs/architecture/index.md`

**Interfaces:**
- Consumes: verified public behavior and final environment variable names.
- Produces: one current migration guide and explicit System Archive/DR/specialized-format distinctions.

- [ ] **Step 1: Document Data Transfer and System Archive**

Include scope, sensitivity, export/download, resumable upload, preview, empty destination, cancellation boundary, provider re-entry, access invalidation, rebuild status, reports, and source cutover.

- [ ] **Step 2: Update specialized-format guides**

Retain World JSON, Campaign Archive, legacy/external, and readable-export instructions. Remove every “System Archive planned” statement only after the capability gate is approved.

- [ ] **Step 3: Document configuration**

List the default-off capability, chunk/TTL settings, limits, roots, capacity override, and the rule that browser input cannot raise limits or bypass preflight.

- [ ] **Step 4: Document provider recovery and DR separation**

Explain disabled credentialless profiles, independent text/image/embedding verification, regenerated share links, and why System Archive does not replace the Recovery Set.

- [ ] **Step 5: Build docs and run final repository validation**

```powershell
pnpm --dir docs build
pnpm check
pnpm test:unit
pnpm test:integration
pnpm build
git diff --check
```

- [ ] **Step 6: Review the complete diff**

Confirm no secrets, source paths, private campaigns, historical root `index.html`, unrelated changes, or unsupported “passed” claims are present. Capture rendered screenshots for both Data Transfer surfaces.

- [ ] **Step 7: Commit**

```powershell
git add docs
git commit -m "Document system archive migration"
```

## Completion checkpoint

The plan is complete only when every acceptance criterion in the linked specification maps to Tasks 1-9, the feature remains default-off until complete round-trip evidence exists, all specialized formats remain working, and PostgreSQL/filesystem/browser/platform skips are reported as unverified.
