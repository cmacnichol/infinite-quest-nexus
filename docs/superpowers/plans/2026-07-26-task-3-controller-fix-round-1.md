# Task 3 Controller Fix Round 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct all nine controller findings at the campaign asset archive inventory, validation, persistence, and restoration boundary without changing Task 1/2 contracts or thumbnail-producing image persistence behavior.

**Architecture:** Keep archive behavior in `services/api/src/asset-archive-service.ts`, with production SQL returning explicitly aliased JSON bindings and with all relationship validation owner/campaign scoped. Use unit tests with stateful SQL-aware fakes for deterministic RED/GREEN coverage, then add a separate skipped-by-default PostgreSQL integration suite that exercises the real projections and restore path when `TEST_DATABASE_URL` is present. Make only the authorized recursive `artifactUrl` sanitizer correction in `packages/contracts/src/archives.ts`.

**Tech Stack:** TypeScript, Vitest, PostgreSQL/node-postgres, Zod archive contracts, filesystem asset store, Sharp image verification.

## Global Constraints

- Add tests before production edits and observe genuine RED output for every behavior wave.
- Do not change Task 1/2 archive contracts except the explicitly authorized `artifactUrl` sanitizer correction.
- Preserve `persistTurnImage` and `persistWorldCover` thumbnail behavior.
- Archive restore must persist originals with no thumbnails; missing thumbnails remain backfillable.
- Keep SQL parameterized and owner/campaign scoped.
- Do not run PostgreSQL tests unless `TEST_DATABASE_URL` is present; report absent-variable tests as not executed, never passed.
- Use two-space TypeScript formatting and review all tests associated with changed files.
- Update the Task 3 report with exact RED/GREEN commands, verification, PostgreSQL status, self-review, and concerns.

---

### Task 1: Add controller regression tests and prove RED

**Files:**
- Modify: `tests/unit/asset-archive-service.test.ts`
- Modify: `tests/unit/archive-contracts.test.ts` or the existing archive-contract test location identified by search
- Create: `tests/integration/asset-archive.integration.test.ts`

**Interfaces:**
- Tests exercise existing `collectCampaignArchiveAssets`, `validateArchiveAssets`, `persistArchiveAssets`, `restoreAssetBindings`, `projectCampaignArchiveAssets`, and `sanitizePortableMetadata` behavior.
- The unit fake must return only columns actually projected by production SQL; it must derive JSON binding presence from `AS binding` and fail when the alias is absent instead of fabricating `binding`.

- [ ] **Step 1: Add unit tests for SQL aliases, scope, authoritative cover, nullable references, and legacy pointer restore.**

  Add focused tests that:
  - make each segment and generation-context fake parse the production query's `AS binding` projection and fail if `row.binding` would be absent;
  - exclude a same-owner foreign-campaign generation context even when its world matches the requested world;
  - include only `worlds.cover_asset_id` as `world_cover`, excluding an older completed world-cover job unless it has another independent binding;
  - include null-turn `asset_references`, map null-turn `turn_illustration` to `campaign_asset`, retain nullable-turn `imported_attachment`, and restore without a fabricated turn;
  - adapt an exact legacy turn image URL and assert the destination turn URL is exactly `/api/v1/assets/<destination-asset-id>` while the source UUID is absent;
  - assert the complete restore binding query writes the mapped destination reference.

- [ ] **Step 2: Add unit tests for canonical manifest validation, nested sanitization, and rollback.**

  Add tests that:
  - reject an arbitrary archive path even when bytes and hashes are valid;
  - reject a full manifest whose asset entry is not `logicalType: "asset-original"` or whose `mediaType` differs from the asset record;
  - remove nested `artifactUrl` alongside existing prohibited metadata keys;
  - make the second original metadata/persistence step fail after the first new original is created, then assert only the new original path is cleaned, a preexisting original remains, and the primary error is preserved (including a safe aggregate if cleanup fails).

- [ ] **Step 3: Add a skipped-by-default real PostgreSQL integration suite.**

  Create `tests/integration/asset-archive.integration.test.ts` using the existing `const databaseUrl = process.env.TEST_DATABASE_URL; const integration = databaseUrl ? describe : describe.skip;` convention. Set up isolated owner/world/campaign/foreign-campaign rows and original assets, then cover real SQL projections, same-world foreign-campaign exclusion, authoritative world cover, source-to-destination ID mapping, legacy pointer restoration, and nullable-turn reference restoration. Use `migrateDatabase` and clean up temporary filesystem state.

- [ ] **Step 4: Run the focused unit tests and capture RED.**

  Run:

  ```powershell
  & '.\\node_modules\\.bin\\vitest.cmd' run tests/unit/asset-archive-service.test.ts tests/unit/archive-contracts.test.ts
  ```

  Expected: exit 1 with failures proving the current SQL aliases, scope, cover selection, canonical validation, sanitizer, rollback, legacy URL, and nullable-turn behavior are not all correct. Fix test harness errors until failures are behavioral, not import/typing mistakes.

### Task 2: Implement SQL projections and inventory/restoration fixes

**Files:**
- Modify: `services/api/src/asset-archive-service.ts`

**Interfaces:**
- Preserve existing exported archive service function signatures and `persistOriginalImage` call behavior.
- Keep campaign asset bindings within the requested campaign; allow only campaign-null reusable world/version contexts through world/version scope.
- Keep `world_cover` authoritative to `worlds.cover_asset_id`; historical job rows may only enter through another approved binding.

- [ ] **Step 1: Add explicit `AS binding` aliases to every retained JSON projection.**

  Alias the segment `jsonb_build_object` and all generation-context/relationship JSON projections that are read through `row.binding`. Remove or stop consuming any historical world-cover-job projection that would incorrectly produce `world_cover`.

- [ ] **Step 2: Harden generation-context inventory predicates.**

  Require a non-null `c.campaign_id` to equal `$2` and have a valid campaign row before it can enter through world or world-version scope. Permit world/world-version scope only for campaign-null reusable contexts, while retaining owner and relationship validity checks.

- [ ] **Step 3: Project null-turn campaign references and exact legacy pointer bindings.**

  Remove the filter that drops nullable-turn references. Convert nullable-turn `turn_illustration` references to `campaign_asset`; preserve `imported_attachment` with `turnId: null`. During restore, update the mapped turn's `image_url` for legacy turn bindings to exactly `/api/v1/assets/${assetId}` and retain the explicit asset reference without writing the source UUID.

- [ ] **Step 4: Implement fail-safe original persistence.**

  Track only newly created content-addressed original paths across the entire persistence operation. Wrap later database/library updates in a failure path that cleans those newly created paths while preserving preexisting paths. Re-throw the original error; if cleanup fails, throw an `AggregateError` containing the primary error and cleanup errors without replacing the primary cause.

- [ ] **Step 5: Run focused tests to verify GREEN, then refactor only while green.**

  Run the Task 3 unit files from Task 1. Confirm all targeted regressions pass, including no thumbnail persistence and unchanged wrapper behavior. If a test fails, return to one root-cause hypothesis at a time.

### Task 3: Implement canonical archive validation and sanitizer correction

**Files:**
- Modify: `services/api/src/asset-archive-service.ts`
- Modify: `packages/contracts/src/archives.ts`

**Interfaces:**
- `validateArchiveAssets` continues to accept the current record-only input and full-manifest input.
- Full manifests validate the corresponding entry metadata against each canonical asset record.
- `sanitizePortableMetadata` remains recursive and removes all preexisting prohibited keys plus `artifactUrl`.

- [ ] **Step 1: Require the exact canonical asset path and approved extension.**

  Validate each record's path against `assets/sha256/<first-two>/<hash>.<approved-extension>`, where the hash is the record content hash and the extension is derived from the record MIME type. Reject arbitrary paths, mismatched hash directories, and mismatched extensions before reading the entry.

- [ ] **Step 2: Validate full-manifest asset entry metadata.**

  When `manifestOrInput` includes a full manifest, find the corresponding entry by canonical path and require `logicalType === "asset-original"` and `mediaType === record.mimeType`; reject missing or mismatched entries. Preserve the record-only behavior for the lightweight input.

- [ ] **Step 3: Add `artifactUrl` to the recursive exclusion predicate.**

  Make the smallest change to `isExcludedMetadataKey` needed to remove `artifactUrl` at any nesting depth, preserving all other sanitizer behavior.

- [ ] **Step 4: Run focused unit tests to verify GREEN.**

  Run:

  ```powershell
  & '.\\node_modules\\.bin\\vitest.cmd' run tests/unit/asset-archive-service.test.ts tests/unit/archive-contracts.test.ts
  ```

### Task 4: Add/execute real PostgreSQL coverage and complete verification

**Files:**
- Modify: `tests/integration/asset-archive.integration.test.ts`
- Modify: `.superpowers/sdd/2026-07-26-campaign-archive-portability/task-3-report.md`
- Modify: `.superpowers/sdd/2026-07-26-campaign-archive-portability/progress.md` if the existing ledger requires a separate controller fix-round entry

- [ ] **Step 1: Run PostgreSQL integration only when configured.**

  Run:

  ```powershell
  if (-not $env:TEST_DATABASE_URL) {
    Write-Output 'NOT EXECUTED: TEST_DATABASE_URL is not set.'
  } else {
    & '.\\node_modules\\.bin\\vitest.cmd' run --config vitest.integration.config.ts tests/integration/asset-archive.integration.test.ts
  }
  ```

  Record an absent variable as not executed, never as passing.

- [ ] **Step 2: Run focused archive and relevant regression checks.**

  Run the Task 3 unit tests, archive contract tests, `pnpm check`, `pnpm build`, and `git diff --check`.

- [ ] **Step 3: Review the complete diff and report.**

  Confirm Task 1/2 contracts are unchanged except the authorized sanitizer line, wrappers still create thumbnails, archive restore does not, every SQL query is parameterized/scoped, and no fake invents projected aliases. Append a clearly labeled `Controller fix round 1/5` section to the report with exact commands/results, changed files, self-review, PostgreSQL status, and concerns.

- [ ] **Step 4: Commit all fix files.**

  ```powershell
  git add services/api/src/asset-archive-service.ts packages/contracts/src/archives.ts tests/unit/asset-archive-service.test.ts tests/unit/archive-contracts.test.ts tests/integration/asset-archive.integration.test.ts .superpowers/sdd/2026-07-26-campaign-archive-portability/task-3-report.md .superpowers/sdd/2026-07-26-campaign-archive-portability/progress.md docs/superpowers/plans/2026-07-26-task-3-controller-fix-round-1.md
  git commit -m "Fix Task 3 archive controller findings"
  ```
