# Campaign Archive Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current best-effort campaign ZIP with a validated, standalone Campaign Archive that contains one campaign, its exact pinned world version, portable Chronicle content, and every associated original image, then import it transactionally with fresh destination identities.

**Architecture:** Add shared archive contracts and bounded ZIP I/O, extract asset portability from the existing asset service, and move campaign export/import orchestration into a focused service registered through a Fastify plugin. Export captures one repeatable-read database snapshot and builds a temporary verified artifact before download. Import stages one upload, validates it completely during preview, binds a hashed token to the fingerprint and destination choice, and commits all relational data plus content-addressed originals through a source-to-destination ID map.

**Tech Stack:** Node.js 22, TypeScript 7, Fastify 5, PostgreSQL with `pg`, Zod 4, `archiver` 8 for ZIP output, [`unzipper` 0.12.5](https://www.npmjs.com/package/unzipper) plus [`@types/unzipper` 0.10.11](https://www.npmjs.com/package/%40types/unzipper) for central-directory ZIP reads, Sharp 0.35, Vitest 4, browser JavaScript, VitePress.

## Global Constraints

- Campaign Export and System Export remain different products. This plan implements only Campaign Archive behavior plus the shared archive foundation that the System Archive plan consumes.
- A Campaign Archive contains exactly one campaign, its exact pinned immutable world version, the attached world metadata, portable campaign/Chronicle records, and every required original image. It never includes unrelated world versions, campaigns, owner-library-only assets, provider profiles, prompt overrides, or operational jobs.
- The server-derived `initial-owner` scopes every export, preview, and import. Source owner IDs are provenance only and never authorization.
- Campaign import creates fresh destination UUIDs for world, world-version, campaign, turn, memory, illustration, and asset records. It may reuse an exact canonical destination world version only when preview reports that choice.
- Re-importing the same content fingerprint with the same destination option returns the prior completed result. A different archive never mutates an existing campaign in place.
- Archives never contain provider credentials, encryption material, authentication identities, active jobs, leases, remote provider state, response chains, embeddings, thumbnails, raw provider responses, or private model reasoning.
- Original images are portable. Thumbnails and embedding vectors are rebuilt from imported authoritative data.
- Missing, unreadable, mismatched, or corrupt required assets fail export or import; they are never silently skipped.
- Apply these default limits, while allowing operators to lower them: 25 MiB per original image, 2 GiB compressed campaign archive, 20 GiB uncompressed campaign archive, 100,000 entries, 100:1 maximum per-entry expansion, 5 MiB manifest, and 1 GiB JSON/NDJSON entry.
- Reject traversal, absolute paths, backslashes, duplicate normalized names, symlinks, special files, encrypted entries, unsupported compression methods, undeclared entries, missing entries, size mismatches, and checksum mismatches before authoritative mutation.
- Stage uploads and generated artifacts only beneath a configured, root-validated archive directory. Never derive a filesystem path from the uploaded filename.
- Keep legacy portable world JSON, campaign JSON, and manifest-less campaign ZIPs importable. New browser-facing campaign downloads always use the manifest archive.
- Do not edit root `index.html`; it is historical reference. UI work belongs in `apps/web/public`.
- Preserve unrelated worktree changes. Stage only the files named in the task being committed.
- PostgreSQL integration verification requires a real `TEST_DATABASE_URL`. A skipped integration suite is not completion.

---

## File and Interface Map

### Create

- `packages/contracts/src/archives.ts`
  - Manifest, payload, archive-entry, asset, binding, preview, commit, result, and typed-error schemas.
  - Canonical sorting and content-fingerprint helpers with no filesystem or database dependencies.
- `services/api/src/archive-io.ts`
  - Upload staging, root/path validation, central-directory inspection, bounded entry streams, checksum verification, deterministic ZIP writing, and safe cleanup.
- `services/api/src/asset-archive-service.ts`
  - Campaign asset inventory, portable metadata projection, original-byte verification, archive asset writing, destination persistence, binding restoration, and rollback cleanup.
- `services/api/src/campaign-archive-service.ts`
  - Campaign snapshot assembly, archive export, preview, token validation, ID remapping, transactional import, and manifest-less ZIP adaptation.
- `services/api/src/archive-routes.ts`
  - Campaign export, campaign archive preview/commit, and legacy campaign ZIP multipart routes.
- `database/migrations/0043_archive_previews.sql`
  - Hashed preview tokens, staged archive metadata, destination binding, expiry, consumption, and lookup indexes for both archive types.
- `tests/unit/archive-contracts.test.ts`
- `tests/unit/archive-io.test.ts`
- `tests/unit/asset-archive-service.test.ts`
- `tests/integration/campaign-archive.integration.test.ts`

### Modify

- `package.json`
- `pnpm-lock.yaml`
- `packages/contracts/src/index.ts`
- `packages/database/src/config.ts`
- `services/api/src/asset-service.ts`
- `services/api/src/world-service.ts`
- `services/api/src/import-service.ts`
- `services/api/src/server.ts`
- `tests/integration/dashboard-stats.integration.test.ts`
- `tests/integration/gameplay.integration.test.ts`
- `tests/unit/server-security.test.ts`
- `tests/unit/user-profile.test.ts`
- `tests/unit/management-ui.test.ts`
- `tests/integration/import-memory.integration.test.ts`
- `apps/web/public/index.html`
- `apps/web/public/nexus.js`
- `apps/web/public/nexus.css`
- `docs/nexus-guide/campaigns/import-export.md`
- `docs/nexus-guide/worlds/import-export.md`

### Stable interfaces delivered for the System Archive plan

```ts
export type ArchiveLimits = {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxEntries: number;
  maxExpansionRatio: number;
  maxManifestBytes: number;
  maxJsonEntryBytes: number;
};

export type StagedArchive = {
  relativePath: string;
  absolutePath: string;
  compressedBytes: number;
};

export type InspectedArchive = {
  manifest: ArchiveManifest;
  staged: StagedArchive;
  entries: ReadonlyMap<string, InspectedArchiveEntry>;
  uncompressedBytes: number;
};

export async function stageArchiveUpload(
  source: NodeJS.ReadableStream,
  archiveRoot: string,
  limits: ArchiveLimits
): Promise<StagedArchive>;

export async function inspectArchive(
  staged: StagedArchive,
  limits: ArchiveLimits,
  expectedType?: "campaign" | "system"
): Promise<InspectedArchive>;

export async function readVerifiedEntry(
  archive: InspectedArchive,
  path: string,
  maximumBytes: number
): Promise<Buffer>;

export async function removeArchivePath(
  archiveRoot: string,
  relativePath: string
): Promise<void>;
```

---

## Task 1: Define strict archive contracts and deterministic fingerprints

**Files:**

- Create: `packages/contracts/src/archives.ts`
- Create: `tests/unit/archive-contracts.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Add failing manifest strictness tests**

Create tests that parse one valid campaign manifest, then reject an unknown root field, uppercase checksum, unsupported format version, duplicate normalized entry paths, a payload path absent from `entries`, and an asset binding outside the campaign scope.

```ts
import {
  archiveManifestSchema,
  archivePathSchema,
  calculateContentFingerprint
} from "../../packages/contracts/src/archives.js";

it("rejects unknown version-one root fields", () => {
  const parsed = archiveManifestSchema.safeParse({ ...validManifest, unexpected: true });
  expect(parsed.success).toBe(false);
});

it.each(["../turns.json", "/absolute.json", "C:/drive.json", "a\\b.json", "a/./b.json"])(
  "rejects unsafe archive path %s",
  (path) => expect(archivePathSchema.safeParse(path).success).toBe(false)
);
```

- [ ] **Step 2: Run the contract test and confirm the import fails**

Run:

```powershell
pnpm exec vitest run tests/unit/archive-contracts.test.ts
```

Expected: FAIL because `packages/contracts/src/archives.ts` does not exist.

- [ ] **Step 3: Implement strict schemas and exported inferred types**

Define `.strict()` Zod schemas for:

```ts
export const archiveTypeSchema = z.enum(["campaign", "system"]);
export const archiveSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const archivePathSchema = z.string().superRefine(validatePortableArchivePath);

export const archiveEntrySchema = z.object({
  path: archivePathSchema,
  logicalType: z.string().trim().min(1).max(100),
  mediaType: z.string().trim().min(1).max(200),
  byteLength: z.number().int().nonnegative(),
  sha256: archiveSha256Schema
}).strict();

export const archivePayloadSchema = z.object({
  kind: z.enum(["campaign", "world", "chronicle", "assets", "system", "records"]),
  path: archivePathSchema,
  formatVersion: z.number().int().positive()
}).strict();
```

The root schema must enforce:

- `format === "infinite-quest-archive"`;
- `formatVersion === 1`;
- unique entry paths after `normalize("NFC").toLocaleLowerCase("en-US")`;
- every payload path appears in entries;
- no `manifest.json` entry in `entries`;
- a campaign manifest declares exactly `campaign.json`, `world.json`, `chronicle.json`, and `assets/assets.json` payloads.

- [ ] **Step 4: Define explicit portable asset bindings**

Use a discriminated union rather than generic target fields:

```ts
export const archiveAssetBindingSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("world_cover"), worldId: z.uuid() }).strict(),
  z.object({ role: z.literal("world_version_asset"), worldId: z.uuid(), worldVersionId: z.uuid() }).strict(),
  z.object({ role: z.literal("campaign_asset"), campaignId: z.uuid() }).strict(),
  z.object({ role: z.literal("turn_illustration"), campaignId: z.uuid(), turnId: z.uuid() }).strict(),
  z.object({
    role: z.literal("illustration_segment_variant"),
    campaignId: z.uuid(),
    turnId: z.uuid(),
    segmentId: z.uuid(),
    variantIndex: z.number().int().nonnegative()
  }).strict(),
  z.object({ role: z.literal("imported_attachment"), campaignId: z.uuid(), turnId: z.uuid().nullable() }).strict(),
  z.object({
    role: z.literal("generation_context"),
    campaignId: z.uuid().nullable(),
    worldId: z.uuid().nullable(),
    worldVersionId: z.uuid().nullable(),
    turnId: z.uuid().nullable(),
    sourceContextId: z.uuid()
  }).strict()
]);
```

Add `archiveAssetRecordSchema`, allowing only portable technical metadata and library fields from the approved design.

- [ ] **Step 5: Add recursive metadata sanitization and canonical hashing**

Export:

```ts
export function sanitizePortableMetadata(value: unknown): unknown;
export function canonicalArchiveJson(value: unknown): string;
export function calculateContentFingerprint(input: {
  payloadHashes: readonly string[];
  originalAssetHashes: readonly string[];
}): string;
```

Remove keys matching credential/secret patterns, temporary provider URLs, authorization headers, local storage paths, and remote artifact fields at every nesting level. Sort object keys, payload hashes, and unique asset hashes before hashing. Preserve array order unless the calling schema explicitly defines it as a set.

- [ ] **Step 6: Define campaign preview and commit contracts**

Add strict schemas for:

```ts
export const campaignArchiveDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("embedded") }).strict(),
  z.object({ kind: z.literal("existing_world_version"), worldVersionId: z.uuid() }).strict()
]);

export const campaignArchiveCommitRequestSchema = z.object({
  previewToken: z.string().min(40).max(200),
  destination: campaignArchiveDestinationSchema
}).strict();
```

The preview response includes campaign/world titles, version, turn/Chronicle/asset counts, original bytes, selected character summary, world reuse result, warnings, provider exclusion statement, destination operation, fingerprint, token, and expiry.

- [ ] **Step 7: Define typed archive errors**

Export the exact code union:

```ts
export const archiveErrorCodeSchema = z.enum([
  "archive-format-unrecognized",
  "archive-version-unsupported",
  "archive-entry-unsafe",
  "archive-entry-duplicate",
  "archive-limit-exceeded",
  "archive-checksum-mismatch",
  "archive-entry-missing",
  "archive-json-invalid",
  "archive-asset-invalid",
  "archive-asset-missing",
  "archive-world-mismatch",
  "archive-owner-count-unsupported",
  "archive-destination-not-empty",
  "archive-preview-stale",
  "archive-storage-insufficient",
  "system-import-in-progress",
  "archive-import-conflict",
  "archive-export-inconsistent"
]);
```

- [ ] **Step 8: Export the module and rerun the focused test**

Add `export * from "./archives.js";` to `packages/contracts/src/index.ts`.

Run:

```powershell
pnpm exec vitest run tests/unit/archive-contracts.test.ts
pnpm check
```

Expected: both PASS.

- [ ] **Step 9: Commit the contract increment**

```powershell
git add packages/contracts/src/archives.ts packages/contracts/src/index.ts tests/unit/archive-contracts.test.ts
git commit -m "Add portable archive contracts"
```

---

## Task 2: Add bounded staged ZIP I/O and archive runtime configuration

**Files:**

- Create: `services/api/src/archive-io.ts`
- Create: `tests/unit/archive-io.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/database/src/config.ts`
- Modify: `tests/integration/dashboard-stats.integration.test.ts`
- Modify: `tests/integration/gameplay.integration.test.ts`
- Modify: `tests/unit/server-security.test.ts`
- Modify: `tests/unit/user-profile.test.ts`

- [ ] **Step 1: Install the central-directory ZIP reader**

Run:

```powershell
pnpm add unzipper@0.12.5
pnpm add -D @types/unzipper@0.10.11
```

Keep `jszip` because the active browser and legacy compatibility tests still use it. Do not use JSZip for new server archive parsing.

- [ ] **Step 2: Add failing archive I/O tests**

Cover:

- staged upload compressed-byte enforcement;
- traversal, drive, backslash, control-character, and NUL rejection;
- duplicate names after case folding and Unicode NFC normalization;
- encrypted, symlink, and unsupported-compression rejection;
- manifest, entry count, uncompressed bytes, JSON size, and expansion limits;
- undeclared, missing, wrong-length, and wrong-checksum entries;
- successful bounded read of a valid archive;
- cleanup refusing a path outside the configured root.

Use `archiver` to construct normal ZIP fixtures in a temporary directory and direct descriptor fixtures for unsafe central-directory metadata that `archiver` cannot emit.

- [ ] **Step 3: Run the I/O test and confirm missing exports**

Run:

```powershell
pnpm exec vitest run tests/unit/archive-io.test.ts
```

Expected: FAIL because `archive-io.ts` does not exist.

- [ ] **Step 4: Add grouped archive configuration**

Extend `RuntimeConfig`:

```ts
archiveStorageRoot: string;
archivePreviewTtlSeconds: number;
systemArchiveArtifactTtlSeconds: number;
campaignArchiveLimits: ArchiveLimits;
systemArchiveLimits: ArchiveLimits;
```

Load these defaults:

```ts
archiveStorageRoot: resolve(process.env.ARCHIVE_STORAGE_ROOT?.trim() || "local-data/archives"),
archivePreviewTtlSeconds: integerSetting("ARCHIVE_PREVIEW_TTL_SECONDS", 1800, 60, 86400),
systemArchiveArtifactTtlSeconds: integerSetting("SYSTEM_ARCHIVE_ARTIFACT_TTL_SECONDS", 86400, 300, 604800)
```

Use byte-valued settings for the approved campaign/system limits. Permit lower operator values and cap values at the approved maxima. Update every explicit `RuntimeConfig` test fixture returned by `rg -l "RuntimeConfig = \\{|as RuntimeConfig|makeConfig\\(" tests services packages`.

- [ ] **Step 5: Implement safe staging and root validation**

`stageArchiveUpload` must:

1. create `<archiveRoot>/staging`;
2. choose a server-generated UUID filename;
3. stream through a compressed-byte counting transform into a file opened with `flag: "wx"` and mode `0o640`;
4. delete the partial file on truncation or stream failure;
5. return only a root-relative path plus resolved path and byte count.

`removeArchivePath` must resolve the relative path, require it to remain under the archive root, and remove only that file. It must not accept absolute paths.

- [ ] **Step 6: Implement central-directory inspection without extraction**

Use `unzipper.Open.file(staged.absolutePath)`. For each central-directory record:

- normalize and validate the logical path;
- reject directory collisions and duplicate file names after NFC/case folding;
- inspect general-purpose flags and reject encryption;
- allow compression methods 0 and 8 only;
- inspect Unix mode bits from external attributes and allow regular files/directories only;
- sum declared uncompressed sizes using safe integers;
- enforce entry, total-uncompressed, and per-entry expansion limits before opening data streams.

Never call `directory.extract`.

- [ ] **Step 7: Verify manifest and entries through bounded streams**

Read `manifest.json` first with a 5 MiB byte limiter. Parse UTF-8 without BOM, validate the strict schema, compare `archiveType` when supplied, and then stream each declared entry through a SHA-256/length transform.

```ts
export class ArchiveError extends Error {
  constructor(
    readonly code: ArchiveErrorCode,
    message: string,
    readonly statusCode = 400,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ArchiveError";
  }
}
```

Errors may identify a normalized logical path or source ID. They must not include local paths, JSON content, image bytes, or provider metadata.

- [ ] **Step 8: Add deterministic ZIP artifact writing**

Provide a helper that writes to `<archiveRoot>/artifacts/<uuid>.zip.tmp`, appends entries in caller-supplied deterministic order, records byte length/SHA-256 while streaming, appends `manifest.json` last, finalizes, fsyncs/closes, and atomically renames to `.zip`.

Return:

```ts
export type CompletedArchiveArtifact = {
  relativePath: string;
  absolutePath: string;
  byteLength: number;
  contentFingerprint: string;
};
```

If any source stream fails, abort `archiver`, close the output, remove the temporary file, and rethrow a typed error.

- [ ] **Step 9: Run focused and configuration tests**

Run:

```powershell
pnpm exec vitest run tests/unit/archive-io.test.ts tests/unit/server-security.test.ts tests/unit/user-profile.test.ts
pnpm check
```

Expected: PASS.

- [ ] **Step 10: Commit the archive I/O increment**

```powershell
git add package.json pnpm-lock.yaml packages/database/src/config.ts services/api/src/archive-io.ts tests/unit/archive-io.test.ts tests/integration/dashboard-stats.integration.test.ts tests/integration/gameplay.integration.test.ts tests/unit/server-security.test.ts tests/unit/user-profile.test.ts
git commit -m "Add bounded archive IO"
```

---

## Task 3: Extract reusable original-asset portability

**Files:**

- Create: `services/api/src/asset-archive-service.ts`
- Create: `tests/unit/asset-archive-service.test.ts`
- Modify: `services/api/src/asset-service.ts`
- Modify: `tests/integration/image-pipeline.integration.test.ts`

- [ ] **Step 1: Add failing tests for portable metadata and content paths**

Test that:

- duplicate source asset rows with one content hash produce one archive byte entry;
- metadata recursion removes `apiKey`, `authorization`, `encrypted_api_key`, `artifactUrl`, and local storage paths;
- output asset paths are `assets/sha256/<first-two>/<hash>.<approved-extension>`;
- MIME/signature mismatch and files over 25 MiB fail;
- a required source asset read failure reports all affected asset IDs;
- imported originals can skip derivative creation and are selected by the existing backfill worker because the thumbnail is missing.

- [ ] **Step 2: Run the asset test and confirm failure**

Run:

```powershell
pnpm exec vitest run tests/unit/asset-archive-service.test.ts
```

Expected: FAIL because the archive asset service does not exist and the image primitives are private.

- [ ] **Step 3: Extract image verification without changing existing callers**

In `asset-service.ts`, export:

```ts
export const MAX_IMPORTED_IMAGE_BYTES = 25 * 1024 * 1024;
export function imageExtensionForMimeType(mimeType: string): string;
export async function verifyOriginalImage(bytes: Buffer, mimeType: string): Promise<VerifiedImage>;
export async function persistOriginalImage(
  client: DatabaseClient,
  store: FilesystemAssetStore,
  ownerUserId: string,
  input: {
    bytes: Buffer;
    mimeType: string;
    sourceAssetId?: string;
    provenance?: { campaignId: string | null; turnId: string | null };
    createThumbnail?: boolean;
  }
): Promise<StoredAsset>;
```

Keep `persistTurnImage` and `persistWorldCover` as wrappers with `createThumbnail: true`. Use `createThumbnail: false` for archive restore so derivative generation is visibly rebuildable.

- [ ] **Step 4: Extend asset backfill to regenerate missing thumbnails**

Change `runAssetMetadataBackfill` selection from only missing dimensions to:

```sql
WHERE (
  assets.pixel_width IS NULL
  OR assets.pixel_height IS NULL
  OR NOT EXISTS (
    SELECT 1
      FROM asset_derivatives derivatives
     WHERE derivatives.owner_user_id = assets.owner_user_id
       AND derivatives.source_asset_id = assets.id
       AND derivatives.derivative_kind = 'thumbnail'
       AND derivatives.transform_version = 1
  )
)
AND NOT (assets.technical_metadata ? 'backfillError')
```

Preserve imported portable dimensions while still decoding the original before generating the thumbnail.

- [ ] **Step 5: Implement campaign asset inventory from explicit relationships**

`collectCampaignArchiveAssets` must union:

- `asset_references`;
- `turn_illustration_segment_assets` joined through the campaign;
- completed campaign `image_jobs` assets;
- attached world cover;
- asset generation contexts scoped to the campaign, pinned version, or attached world.

Also adapt legacy `/api/v1/assets/:uuid` pointers from turn/world JSON into explicit bindings during export. If such a pointer names an absent or foreign-owner asset, fail with `archive-asset-missing`.

- [ ] **Step 6: Project portable asset records**

Read `assets`, `asset_library_entries`, and `asset_generation_contexts`. Exclude derivatives and filesystem fields. Emit deterministic asset records sorted by source asset UUID and bindings sorted by role plus target IDs.

```ts
export type CampaignAssetInventory = {
  records: ArchiveAssetRecord[];
  uniqueOriginals: Array<{
    contentHash: string;
    archivePath: string;
    sourceAssetIds: string[];
    mimeType: string;
    byteLength: number;
  }>;
};
```

- [ ] **Step 7: Implement verified write and restore helpers**

Export:

```ts
export async function verifyAndWriteArchiveAssets(...): Promise<ArchiveEntry[]>;
export async function validateArchiveAssets(...): Promise<ValidatedArchiveAssetSet>;
export async function persistArchiveAssets(
  client: DatabaseClient,
  store: FilesystemAssetStore,
  ownerUserId: string,
  validated: ValidatedArchiveAssetSet,
  idMap: ArchiveIdMap
): Promise<{ assetIds: Map<string, string>; createdPaths: string[] }>;
export async function restoreAssetBindings(...): Promise<void>;
export async function cleanupUnreferencedCreatedPaths(...): Promise<void>;
```

Import must create one destination asset for each unique content hash, map every source asset UUID to it, preserve safe library metadata, and apply all bindings only after target IDs exist.

- [ ] **Step 8: Run asset and image regression tests**

Run:

```powershell
pnpm exec vitest run tests/unit/asset-archive-service.test.ts
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/image-pipeline.integration.test.ts
```

Expected: PASS, including existing image persistence and thumbnail behavior.

- [ ] **Step 9: Commit the asset portability increment**

```powershell
git add services/api/src/asset-service.ts services/api/src/asset-archive-service.ts tests/unit/asset-archive-service.test.ts tests/integration/image-pipeline.integration.test.ts
git commit -m "Add archive asset portability"
```

---

## Task 4: Build fail-closed Campaign Archive export

**Files:**

- Create: `services/api/src/campaign-archive-service.ts`
- Create: `tests/integration/campaign-archive.integration.test.ts`
- Modify: `services/api/src/world-service.ts`
- Modify: `tests/integration/import-memory.integration.test.ts`

- [ ] **Step 1: Add a complete campaign export fixture**

In the new integration test, create:

- one world with at least two immutable versions and a world cover;
- two campaigns on different versions, proving only the selected campaign/version exports;
- accepted turns through `active_turn_number`;
- current campaign state;
- character profile edits and state edits;
- Chronicle memory plus a legacy full-history checkpoint;
- campaign world migration/transfer provenance;
- illustration config, set, segment, alternate variant assets, and asset library metadata;
- provider cost events;
- an unrelated owner-library image that must not export.

- [ ] **Step 2: Add failing export assertions**

Call the new export service, inspect the resulting ZIP with `inspectArchive`, and assert:

- exact file set and archive type;
- `campaign.json.world` canonical hash equals `world.json`;
- only the pinned world version exists;
- all required logical records exist;
- every expected original image and binding exists;
- the unrelated campaign and library image are absent;
- no credential, embedding vector, thumbnail, active job, response chain, or provider profile field appears.

Add a second test that removes one source original from the asset root and expects `archive-asset-missing` with the safe source asset ID.

- [ ] **Step 3: Run the integration test and confirm failure**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-archive.integration.test.ts
```

Expected: FAIL because campaign archive export is not implemented.

- [ ] **Step 4: Add a repeatable-read campaign snapshot**

Implement:

```ts
export async function captureCampaignArchiveSnapshot(
  pool: DatabasePool,
  campaignId: string
): Promise<CampaignArchiveSnapshot>;
```

Use one client:

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
```

Resolve `initialOwnerId(client)`, lock nothing, and query the approved campaign scope in dependency-neutral portable objects. Check that:

- `MAX(turn_number)` through accepted turns equals `campaign.active_turn_number`;
- the selected campaign state exists and its revision matches the captured campaign state revision;
- no accepted turn commit is present without corresponding current state.

Throw `archive-export-inconsistent` before creating an artifact if the snapshot is inconsistent.

- [ ] **Step 5: Project the three campaign payloads**

Build:

```ts
export type CampaignArchivePayloads = {
  campaign: PortableCampaignV3 & { archiveRecords: CampaignArchiveRecordsV1 };
  world: PortableWorldPayload;
  chronicle: PortableCampaignChronicleV1;
};
```

`campaign.json` retains format version 3 compatibility and adds versioned `archiveRecords` for profile/state edits, illustration records, costs, and provenance. `world.json` is the authoritative canonical pinned-world payload. `chronicle.json` contains non-vector memory and summary data not derivable from accepted turns.

- [ ] **Step 6: Create the deterministic artifact**

Implement the overloaded service:

```ts
export async function exportCampaign(
  pool: DatabasePool,
  campaignId: string,
  options?: null
): Promise<Record<string, unknown>>;

export async function exportCampaign(
  pool: DatabasePool,
  campaignId: string,
  options: CampaignArchiveExportOptions
): Promise<CompletedArchiveArtifact>;
```

The null overload returns format-3 JSON for focused tests/internal compatibility. The archive overload:

1. captures logical data and immutable asset metadata;
2. closes the repeatable-read transaction;
3. reads each original through the asset service;
4. checks database length, MIME, content hash, and decoder validity;
5. writes `campaign.json`, `world.json`, `chronicle.json`, `assets/assets.json`, then sorted content-addressed originals;
6. computes the content fingerprint;
7. appends `manifest.json`;
8. atomically publishes the completed temporary ZIP.

- [ ] **Step 7: Keep a narrow world-service compatibility export**

Remove the large ZIP implementation from `world-service.ts` and re-export or delegate to the new service so existing internal imports have one behavior:

```ts
export { exportCampaign } from "./campaign-archive-service.js";
```

Do not duplicate archive SQL or asset traversal in `world-service.ts`.

- [ ] **Step 8: Run export, memory, and build checks**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-archive.integration.test.ts tests/integration/import-memory.integration.test.ts
pnpm build
```

Expected: PASS.

- [ ] **Step 9: Commit the export increment**

```powershell
git add services/api/src/campaign-archive-service.ts services/api/src/world-service.ts tests/integration/campaign-archive.integration.test.ts tests/integration/import-memory.integration.test.ts
git commit -m "Harden campaign archive export"
```

---

## Task 5: Implement staged preview and transactional Campaign Archive import

**Files:**

- Create: `database/migrations/0043_archive_previews.sql`
- Modify: `services/api/src/campaign-archive-service.ts`
- Modify: `services/api/src/import-service.ts`
- Modify: `tests/integration/campaign-archive.integration.test.ts`
- Modify: `tests/integration/migrations.integration.test.ts`

- [ ] **Step 1: Add failing migration and preview-token tests**

Assert that the migration creates `archive_previews` with:

- UUID primary key and owner foreign key;
- `archive_type IN ('campaign','system')`;
- token hash, content fingerprint, destination hash, application version, staged relative path, source name, preview JSON, status, expiry, consumed timestamp, and result JSON;
- status constraint `previewed|consumed|expired|failed`;
- unique token hash;
- owner/type/fingerprint and expiry indexes.

Test that raw preview tokens and absolute local paths are never stored.

- [ ] **Step 2: Add failing import behavior tests**

Extend `campaign-archive.integration.test.ts` to cover:

- preview does not create world/campaign/asset rows;
- preview reports titles, counts, bytes, selected character, exclusions, and create/reuse decision;
- commit remaps every source entity ID and rewrites image pointers;
- import into a non-empty owner leaves unrelated data unchanged;
- exact-world reuse and explicit compatible-world attachment;
- same fingerprint plus same destination is idempotent;
- a different destination option has a distinct idempotency hash;
- stale/expired/consumed tokens fail;
- destination option mismatch fails;
- corrupt image or forced mid-transaction SQL failure leaves no imported relational rows;
- rollback removes only newly created unreferenced files;
- legacy manifest-less campaign ZIP preview emits compatibility warnings.

- [ ] **Step 3: Run migration and campaign tests and confirm failure**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/migrations.integration.test.ts tests/integration/campaign-archive.integration.test.ts
```

Expected: FAIL because the preview table and import methods do not exist.

- [ ] **Step 4: Add the preview migration**

Create `0043_archive_previews.sql`. Store `staged_archive_path` as a root-relative slash-separated path. Add a partial unique index that allows one live preview for one owner/type/fingerprint/destination hash and an expiry index for bounded cleanup.

Do not cascade preview deletion into imports or authoritative content; preview rows are staging metadata only.

- [ ] **Step 5: Implement preview token generation and validation**

Generate 32 random bytes and return Base64URL. Store:

```ts
const tokenHash = createHash("sha256").update(rawToken, "utf8").digest("hex");
```

Bind the preview to:

- owner UUID;
- content fingerprint;
- canonical destination option hash;
- running application version;
- staged relative path;
- 30-minute expiry.

Preview reuses a still-valid staged row only when all bound values match. Otherwise it creates a new row and safely expires/removes obsolete staging.

- [ ] **Step 6: Implement Campaign Archive preview**

```ts
export async function previewCampaignArchive(
  pool: DatabasePool,
  config: RuntimeConfig,
  staged: StagedArchive,
  sourceName: string,
  destination: CampaignArchiveDestination
): Promise<CampaignArchivePreview>;
```

Perform every ZIP, manifest, payload, checksum, cross-file world-hash, binding-scope, and original-image validation. Query the destination only after archive validation to report canonical world reuse or compatible selected-version attachment. Do not write original bytes to the final asset root during preview.

- [ ] **Step 7: Implement the source-to-destination identity map**

Use explicit namespaces:

```ts
export type ArchiveIdKind =
  | "world"
  | "worldVersion"
  | "campaign"
  | "turn"
  | "memory"
  | "summary"
  | "profileEdit"
  | "stateEdit"
  | "migration"
  | "transfer"
  | "illustrationSet"
  | "illustrationSegment"
  | "asset"
  | "generationContext";

export type ArchiveIdMap = Map<ArchiveIdKind, Map<string, string>>;
```

Generate fresh UUIDs once per source ID, except a reused destination world/world-version. Reject an unknown reference rather than retaining a source UUID.

- [ ] **Step 8: Lock and revalidate the preview at commit**

Start `importCampaignArchive` by hashing the raw token, opening a transaction,
and selecting the owner-scoped preview `FOR UPDATE`. Verify status, expiry,
application version, archive fingerprint, and destination hash, then rerun
staged archive validation and decode every original before the first
authoritative INSERT.

- [ ] **Step 9: Add destination-aware import idempotency**

Look up:

```ts
sha256("campaign-archive-v1\0" + fingerprint + "\0" + destinationHash)
```

in `imports`. Return the prior completed result when it matches. Otherwise
create or reuse the previewed world/version and allocate the complete ID map.

- [ ] **Step 10: Insert campaign-owned relational records**

Insert campaign, current state, accepted turns, profile/state histories,
Chronicle content, illustration records, costs, and provenance in foreign-key
order. Rewrite only references represented by the validated ID map.

- [ ] **Step 11: Persist originals and restore bindings**

Persist each unique original with `createThumbnail: false`, restore portable
library metadata, apply explicit bindings, and rewrite known image pointers to
destination `/api/v1/assets/:assetId` URLs.

- [ ] **Step 12: Finalize import and rollback cleanup**

Insert the completed `imports` row, mark the preview consumed, and commit. On
failure, roll back, run `cleanupUnreferencedCreatedPaths`, retain a safe failed
preview error, and never delete a pre-existing content-addressed original.

- [ ] **Step 13: Adapt legacy ZIPs without weakening new validation**

Add `adaptLegacyCampaignZip` that:

- accepts only `campaign.json` or `infinite-quest-campaign.json` plus `assets/<uuid>.<extension>`;
- builds an in-memory version-1 logical manifest and explicit legacy bindings;
- validates MIME/signature/size;
- emits warnings that source checksums and explicit binding guarantees were absent;
- passes the adapted payload through the same ID remap and transaction code.

Keep JSON/pasted campaign imports on `importLegacyStory`. Remove only the new-manifest ZIP assumptions from that service.

- [ ] **Step 14: Run focused PostgreSQL tests**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/migrations.integration.test.ts tests/integration/campaign-archive.integration.test.ts tests/integration/import-memory.integration.test.ts
```

Expected: PASS.

- [ ] **Step 15: Commit the import increment**

```powershell
git add database/migrations/0043_archive_previews.sql services/api/src/campaign-archive-service.ts services/api/src/import-service.ts tests/integration/campaign-archive.integration.test.ts tests/integration/migrations.integration.test.ts
git commit -m "Add transactional campaign archive import"
```

---

## Task 6: Register focused archive API routes and typed errors

**Files:**

- Create: `services/api/src/archive-routes.ts`
- Modify: `services/api/src/server.ts`
- Modify: `tests/integration/campaign-archive.integration.test.ts`
- Modify: `tests/unit/server-security.test.ts`

- [ ] **Step 1: Add failing route contract tests**

Build the Fastify server and assert:

- `GET /api/v1/campaigns/:campaignId/export` returns 200, `application/zip`, `Cache-Control: no-store`, and `attachment; filename="infinite-quest-campaign.zip"`;
- campaign preview accepts one multipart `file` plus JSON `destination`;
- commit accepts only JSON token/destination and returns 201 or idempotent 200;
- a campaign route cannot export a foreign-owner campaign;
- malformed archives return the exact typed archive code and safe details;
- response cleanup removes the generated temporary campaign artifact;
- existing legacy JSON and manifest-less ZIP imports still work.

- [ ] **Step 2: Run the route tests and confirm failure**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-archive.integration.test.ts
pnpm exec vitest run tests/unit/server-security.test.ts
```

Expected: FAIL because routes remain inline and new endpoints are absent.

- [ ] **Step 3: Implement the archive route plugin**

```ts
export type ArchiveRouteOptions = {
  pool: DatabasePool;
  config: RuntimeConfig;
  assetStore: FilesystemAssetStore;
};

export async function registerArchiveRoutes(
  app: FastifyInstance,
  options: ArchiveRouteOptions
): Promise<void>;
```

Register:

```text
GET  /api/v1/campaigns/:campaignId/export
POST /api/v1/imports/campaign-archive/preview
POST /api/v1/imports/campaign-archive
```

Use per-route multipart limits set to `config.campaignArchiveLimits.maxCompressedBytes`. Stream directly to staging and check Fastify's truncation indicator. Accept only one file part and one bounded destination JSON field.

Change the global multipart registration in `server.ts` from the current 50 MiB default to the configured System Archive compressed limit as the absolute server ceiling. Keep the lower Campaign Archive and legacy import limits on their individual route parsers; otherwise the plugin-level 50 MiB limit would reject a valid Campaign Archive before route code can enforce its own bound.

- [ ] **Step 4: Move legacy campaign ZIP multipart parsing out of `server.ts`**

Register the multipart form of `/api/v1/imports/legacy-story` from `archive-routes.ts` and delegate JSON bodies to the existing service. Remove `JSZip`, `part.toBuffer()`, asset buffer enumeration, and ZIP-specific logic from `server.ts`.

Keep route URLs and JSON request behavior stable.

- [ ] **Step 5: Serve completed artifacts safely**

Open the completed archive with `createReadStream`. Set:

```text
Content-Type: application/zip
Content-Disposition: attachment; filename="infinite-quest-campaign.zip"
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

Attach one response-finished/response-closed cleanup callback that calls `removeArchivePath`. Do not delete the artifact before the stream closes.

- [ ] **Step 6: Expose typed archive codes through the central error handler**

Extend `errorDetails` to capture `code`, and return:

```ts
{
  error: details.code ?? details.name,
  message: exposedMessage,
  correlationId: request.id,
  details: safeDetails
}
```

`ArchiveError.expose` is true. Server-side filesystem paths and raw payload data must not enter `safeDetails`.

- [ ] **Step 7: Register the plugin from `buildServer`**

Create both roots:

```ts
await mkdir(config.assetStorageRoot, { recursive: true });
await mkdir(config.archiveStorageRoot, { recursive: true });
```

Register archive routes after multipart and before the remaining domain routes. Remove the old campaign export route from `server.ts`.

- [ ] **Step 8: Run route, security, check, and build verification**

Run:

```powershell
pnpm exec vitest run tests/unit/server-security.test.ts
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-archive.integration.test.ts
pnpm check
pnpm build
```

Expected: PASS.

- [ ] **Step 9: Commit the route extraction**

```powershell
git add services/api/src/archive-routes.ts services/api/src/server.ts tests/integration/campaign-archive.integration.test.ts tests/unit/server-security.test.ts
git commit -m "Register campaign archive routes"
```

---

## Task 7: Add Campaign Archive preview and commit to the Import UI

**Files:**

- Modify: `apps/web/public/index.html`
- Modify: `apps/web/public/nexus.js`
- Modify: `apps/web/public/nexus.css`
- Modify: `tests/unit/management-ui.test.ts`

- [ ] **Step 1: Add failing static UI tests**

Assert the active UI contains:

- a file import source selector with `auto` and `campaign_archive`;
- copy explaining one campaign plus its attached world and originals;
- preview fields for turn count, Chronicle count, image count/bytes, world create/reuse, selected character, and provider exclusion;
- JavaScript calls to the campaign archive preview and commit endpoints;
- commit uses the preview token and does not upload the ZIP twice;
- legacy JSON/paste paths remain;
- status updates use existing `role="status"`/`aria-live`.

- [ ] **Step 2: Run the UI test and confirm failure**

Run:

```powershell
pnpm exec vitest run tests/unit/management-ui.test.ts
```

Expected: FAIL because the new import mode and endpoints are absent.

- [ ] **Step 3: Add the Campaign Archive source option**

Add a compact selector above the file input:

```html
<label>Import source
  <select id="importSourceType">
    <option value="auto">Detect world, campaign, or Infinite Worlds content</option>
    <option value="campaign_archive">Campaign backup (.zip)</option>
  </select>
</label>
```

Retain `.zip,.story,.json,.txt` acceptance. Explain that Campaign Archive imports create a standalone campaign with its attached world and original images, while provider profiles and credentials remain excluded.

- [ ] **Step 4: Upload ZIPs once for server preview**

For a selected ZIP with `campaign_archive` or ZIP auto mode:

1. build `FormData` with the file and current destination JSON;
2. POST to `/api/v1/imports/campaign-archive/preview`;
3. store `{ kind: "campaign_archive", previewToken, destination, preview }`;
4. clear references to file content from `selectedImport`;
5. render server counts and warnings.

Do not call `new JSZip().loadAsync(file)` for manifest Campaign Archives. Keep browser ZIP parsing only as a temporary fallback for legacy `.story` files when the server returns `archive-format-unrecognized`.

- [ ] **Step 5: Refresh preview when destination changes**

Because the preview token is bound to destination, changing embedded/existing world options must explicitly request a new preview from the selected file and replace the old token. Disable Import during the refresh.

- [ ] **Step 6: Commit without a second upload**

Add a branch in `importStory()`:

```ts
if (selectedImport.kind === "campaign_archive") {
  const result = await api("/api/v1/imports/campaign-archive", {
    method: "POST",
    body: JSON.stringify({
      previewToken: selectedImport.previewToken,
      destination: selectedImport.destination
    })
  });
  await loadWorlds(result.worldId);
  await loadCampaigns(result.campaignId);
}
```

Display whether the import was new or idempotently reused, plus turn/Chronicle/image counts. On `archive-preview-stale`, retain the file selection and instruct the user to preview again.

- [ ] **Step 7: Keep export behavior and improve messaging**

`exportSelectedCampaign` continues to call the same GET URL. Update success copy to state that the exact attached world and associated originals were included and provider credentials were excluded.

- [ ] **Step 8: Add responsive/archive preview styling**

Use existing card/status tokens. Add no new design system. Ensure counts wrap to one column at the existing mobile breakpoint and errors remain readable without horizontal scrolling.

- [ ] **Step 9: Run UI syntax and unit checks**

Run:

```powershell
pnpm exec vitest run tests/unit/management-ui.test.ts
node --check apps/web/public/nexus.js
pnpm check
```

Expected: PASS.

- [ ] **Step 10: Commit the Campaign Archive UI**

```powershell
git add apps/web/public/index.html apps/web/public/nexus.js apps/web/public/nexus.css tests/unit/management-ui.test.ts
git commit -m "Add campaign archive import UI"
```

---

## Task 8: Document behavior and complete Campaign Archive verification

**Files:**

- Modify: `docs/nexus-guide/campaigns/import-export.md`
- Modify: `docs/nexus-guide/worlds/import-export.md`
- Review: all files changed by Tasks 1-7

- [ ] **Step 1: Document the standalone Campaign Archive guarantee**

Update the campaign guide with:

- exact pinned-world scope;
- accepted turns, state, portable Chronicle, and associated original images;
- excluded profiles, credentials, jobs, vectors, and thumbnails;
- create/reuse/attach destination choices;
- fresh destination IDs and idempotent fingerprint behavior;
- legacy JSON/manifest-less ZIP compatibility;
- unencrypted/private-content warning;
- distinction from disaster-recovery backup.

- [ ] **Step 2: Distinguish all three world/campaign formats**

Update the world guide:

- world JSON is one immutable world snapshot only;
- Campaign Archive is one campaign plus attached world and images;
- System Archive is owner-wide and will have its own import option;
- none of the portable formats confer source authorization.

- [ ] **Step 3: Build documentation**

Run:

```powershell
pnpm --dir docs build
```

Expected: VitePress build succeeds with no broken links.

- [ ] **Step 4: Run all focused unit suites**

Run:

```powershell
pnpm exec vitest run tests/unit/archive-contracts.test.ts tests/unit/archive-io.test.ts tests/unit/asset-archive-service.test.ts tests/unit/management-ui.test.ts tests/unit/server-security.test.ts tests/unit/user-profile.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run all related real-PostgreSQL suites**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required; a skipped suite is not verification" }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/migrations.integration.test.ts tests/integration/campaign-archive.integration.test.ts tests/integration/import-memory.integration.test.ts tests/integration/image-pipeline.integration.test.ts tests/integration/world-library.integration.test.ts
```

Expected: PASS with no skipped database suite.

- [ ] **Step 6: Run repository-wide verification**

Run:

```powershell
pnpm check
pnpm build
pnpm test
git diff --check
git status --short
```

Expected: all commands succeed. `git status --short` lists only intentional changes or pre-existing unrelated user changes.

- [ ] **Step 7: Perform a manual two-installation smoke test**

1. Export a campaign with world cover, accepted-turn image, alternate segment image, and Chronicle history.
2. Import it into a different non-empty installation.
3. Confirm the unrelated destination records remain unchanged.
4. Load the imported campaign and verify exact world version, character, current state, accepted turns, cover, selected image, alternate variant, and library metadata.
5. Remove one source original and confirm export fails instead of producing an incomplete ZIP.

- [ ] **Step 8: Commit documentation and any verification-only corrections**

```powershell
git add docs/nexus-guide/campaigns/import-export.md docs/nexus-guide/worlds/import-export.md
git commit -m "Document campaign archive portability"
```

Do not include unrelated worktree files in this commit.

---

## Campaign Archive completion checkpoint

Do not begin System Archive implementation until:

- the Campaign Archive can round-trip through a different non-empty database;
- every source entity is remapped or explicitly reused;
- all associated original images survive;
- missing source bytes fail export;
- corrupt archives fail before authoritative writes;
- exact re-import is idempotent;
- the shared archive I/O, asset portability, preview table, route plugin, and typed errors are stable;
- focused and full verification commands above pass against real PostgreSQL.
