# System Archive final fix report

Date: 2026-08-26
Platform: Windows (`win32`)
Node: `v24.19.0`
pnpm: `11.19.0`

## Outcome

All Critical, Important, and Minor findings in `final-review-findings.md` were repaired in one final whole-branch wave. The implementation remains default-off, imports only into an empty destination owned by the Current Owner, exports every retained Original Asset, excludes secrets and operational/security authority, preserves existing Campaign/World/legacy formats and routes, and does not change the repository-root historical `index.html`.

Implementation commit range:

```text
d57db79d2c8ff721fe0babbfdd280b87c737ee9e..fb4bac96ff7159a8e9ebe25fb8ba538751b035ed
```

Implementation commit:

```text
fb4bac96ff7159a8e9ebe25fb8ba538751b035ed Fix System Archive portability guarantees
```

## Finding disposition

### Critical: field-complete portable authority

- Added strict, versioned v2 owner, domain-record, and Original Asset schemas while retaining v1 inspection/import compatibility.
- Added an exhaustive table classification plus a source-column classification for every column in every portable source table. PostgreSQL `information_schema.columns` is the drift gate.
- Preserved safe owner preferences/status/timestamps; provider role/type/default/safe endpoint and configuration; campaign providers/story length/control/settings; complete turn, current-state, edit, Chronicle, provenance, cost/activity, illustration, asset-reference/library, and generation-context authority.
- Provider secrets, provider health state, job IDs, filesystem authority, share/security authority, embeddings, search documents, and other derived/operational fields remain excluded, rebuilt, remapped, or destination-retained according to the ledger.
- Provider profiles remain disabled with unknown health and no credentials after import.
- Added distinct non-default exact sentinels, including row-only `campaign_state` values, Markdown/code blocks, leading/trailing whitespace, IDs, relationships, timestamps, ordinals, metadata, and provider retry configuration.
- Kept System-only asset authority out of existing Campaign Archive manifests and contracts.

### Critical: non-destructive post-import rebuilds

- Replaced destructive `reindex_campaign` enqueueing with `embed_campaign` plus the Chronicle chunk-index job.
- The round-trip integration runs both real Chronicle workers to completion and then proves the queue is idle.
- Exact canonical-fact and Chronicle IDs, text, metadata, timestamps, ordinals, checkpoint authority, and ordering remain unchanged.
- Added a real private-storage asset metadata-backfill execution test that runs the queued job and then proves a second worker is idle without changing Original Asset or library authority. That physical path is Linux-gated and is reported below as skipped on Windows.

### Important: both-client same-kind fencing

- Added independent monotonic export/import generations to the replacement and legacy clients.
- A newer same-kind operation aborts recovery of the older operation.
- Recovery, durable-handle resolution, polling, storage writes, rendering, reports, downloads, and cancellation are guarded by the exact generation, kind, idempotency key, and job ID.
- Deterministic deferred-promise tests cover export and import races on both clients.

### Important: governed preview relationship index

- Replaced OS-temporary SQLite files with a process-local SQLite in-memory index.
- Added independent positive safe-integer record and relationship quotas; every derived relationship row reserves quota before insertion.
- `close()` destroys the index; constructing a replacement after close has no prior authority.
- Tests prove no private OS-temp artifact is created, both row classes are bounded, and restart drops all indexed story authority.

### Important: fixed System Preview TTL and database clock

- System Preview authority is fixed internally at 1,800 seconds and no longer accepts the Campaign/World preview TTL as a repository or composition option.
- Creation, eligibility, upload eligibility, and atomic preview consumption use PostgreSQL `clock_timestamp()` in SQL.
- Campaign/World `ARCHIVE_PREVIEW_TTL_SECONDS` remains independently configurable from 60 through 86,400 seconds.
- A skew regression moves the application clock a day beyond expiry while PostgreSQL remains authoritative and proves idempotent consumption still succeeds.

### Important: non-transforming authoritative text

- String validation now checks nonblank and maximum length without returning `.trim()` output.
- Exact-byte tests retain leading/trailing spaces, newlines, Markdown headings, fenced code blocks, and indented code text through contracts and PostgreSQL round trip.

### Minor: TTL documentation

- Environment documentation now distinguishes configurable Campaign/World preview authority from the fixed database-clock System Archive 1,800-second invariant.

## Changed files

Production and documentation:

- `apps/web-next/src/data-transfer-page.ts`
- `apps/web/public/nexus.js`
- `docs/installation/environment-configuration.md`
- `packages/application/src/providers/types.ts`
- `packages/application/src/providers/use-cases.ts`
- `packages/application/src/system-archives/portability-registry.ts`
- `packages/application/src/system-archives/ports.ts`
- `packages/application/src/system-archives/use-cases.ts`
- `packages/contracts/src/archives.ts`
- `packages/contracts/src/system-archives.ts`
- `packages/database/src/system-archive-export-repository.ts`
- `packages/database/src/system-archive-import-repository.ts`
- `services/api/src/archive-io.ts`
- `services/runtime/src/system-archive-composition.ts`
- `services/runtime/src/system-archive-preview-index.ts`
- `services/worker/src/system-archive-worker.ts`

Tests:

- `tests/e2e/data-transfer.e2e.test.ts`
- `tests/integration/system-archive-resumable.integration.test.ts`
- `tests/integration/system-archive.integration.test.ts`
- `tests/unit/archive-contracts.test.ts`
- `tests/unit/archive-io.test.ts`
- `tests/unit/provider-application.test.ts`
- `tests/unit/system-archive-contracts.test.ts`
- `tests/unit/system-archive-portability.test.ts`
- `tests/unit/system-archive-preview-hardening.test.ts`
- `tests/unit/web-next-data-transfer.test.ts`

## Strict RED/GREEN evidence

Commands below used the bundled Node runtime shown in the final verification section.

### v2 authority, classification, exact text, and non-destructive rebuilds

```powershell
& 'C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules\vitest\vitest.mjs run tests/unit/system-archive-contracts.test.ts tests/unit/system-archive-portability.test.ts tests/unit/archive-contracts.test.ts
```

RED: exit 1. The new v2 closed records and System-only asset authority were rejected or reduced, the source-column ledger was absent, and the exact prose sentinel was returned trimmed.
GREEN: exit 0 after strict v2/v1 separation and non-transforming validation; the focused archive/System contract run completed with 59 tests passed.

```powershell
& 'C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules\vitest\vitest.mjs run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts -t 'round-trips non-default v2 authority exactly and executes non-destructive Chronicle rebuilds'
```

RED: exit 1. The first run could not restore the field-complete v2 authority; subsequent focused RED isolated the generic writer rejecting System-only binding `createdAt`, and the destructive rebuild assertions exposed the wrong Chronicle job semantics.
GREEN: exit 0; 1 passed and 42 skipped by the name filter. Both queued Chronicle workers completed, the third call returned idle, and exact authority remained unchanged.

```powershell
& 'C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules\vitest\vitest.mjs run tests/unit/provider-application.test.ts
```

RED: exit 1; 1 failed and 6 passed because safe provider configuration dropped `retryLimit`.
GREEN: exit 0; 7 passed after accepting only a nonnegative safe-integer `retryLimit`.

```powershell
& 'C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules\vitest\vitest.mjs run tests/unit/archive-contracts.test.ts
```

RED: exit 1; 1 failed and 26 passed because the generic Campaign Archive asset contract accepted System-only authority.
GREEN: exit 0 after restoring the generic schema and defining a separate strict System v2 binding/asset schema.

### preview relationship governance and exact state-row authority

```powershell
& 'C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules\vitest\vitest.mjs run tests/unit/system-archive-preview-hardening.test.ts -t 'bounds relationship rows independently'
```

RED: exit 1; 1 failed and 34 skipped because derived relationship rows were not independently capped.
GREEN: exit 0; 1 passed and 34 skipped after every relationship insertion reserved quota.

```powershell
& 'C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules\vitest\vitest.mjs run tests/unit/system-archive-preview-hardening.test.ts -t 'accepts independent current-state row authority'
```

RED: exit 1; 1 failed and 34 skipped. The preview index incorrectly required a current-state row and a same-revision historical edit to contain identical JSON.
GREEN: exit 0; 1 passed and 34 skipped. Current row authority and edit history remain independent while a genuinely newer edit still fails closed.

The complete focused PostgreSQL run then supplied an additional regression RED:

```powershell
repowise distill C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules\vitest\vitest.mjs run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts --reporter=dot
```

RED: exit 1; 5 failed, 34 passed, and 4 platform-skipped because valid exported row-only state authority was rejected during preview.
GREEN: exit 0; 39 passed and 4 platform-skipped after the relationship invariant was corrected.

### fixed TTL and database-clock eligibility

```powershell
& 'C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules\vitest\vitest.mjs run tests/unit/archive-io.test.ts -t 'keeps Campaign Archive preview TTL configurable when System Archive is enabled'
```

RED setup: the new configuration assertion established that `ARCHIVE_PREVIEW_TTL_SECONDS=137` must remain valid with System Archive enabled; the failing PostgreSQL clock-skew test below captured the System Preview behavior defect because System composition still consumed that setting.
GREEN: exit 0 with `SYSTEM_ARCHIVE_ENABLED=true` and `ARCHIVE_PREVIEW_TTL_SECONDS=137`; Campaign/World configuration retained `137` while System repository construction had no TTL input.

```powershell
& 'C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules\vitest\vitest.mjs run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts -t 'returns the same queued import when preview consumption is retried after response loss'
```

RED: exit 1 when a mocked application clock one day ahead made `Date.now()` reject still-valid PostgreSQL authority.
GREEN: exit 0 after expiry and the atomic state transition moved into SQL using `clock_timestamp()`.

### both-client generation fencing

```powershell
& 'C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' exec playwright test tests/e2e/data-transfer.e2e.test.ts --grep 'fences a delayed recovered (export|import)'
```

RED: exit 1; the legacy recovery path surfaced its superseding `AbortError` and stale recovery could still mutate newer operation state.
GREEN: exit 0; 4 passed, covering export/import on both replacement and legacy clients.

```powershell
& 'C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules\vitest\vitest.mjs run tests/unit/web-next-data-transfer.test.ts -t 'fences a delayed recovered'
```

RED: exit 1 before generation/job/idempotency compare-and-set guards.
GREEN: exit 0 for both replacement-client race cases.

## Fresh final verification

```powershell
repowise distill C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd check
```

Result: exit 0. Repository boundary/data-safety, package TypeScript, both web checks, root TypeScript, and JavaScript syntax checks passed.

```powershell
repowise distill C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd build
```

Result: exit 0. Both web production builds and TypeScript build passed. Only the existing unresolved-at-build-time font notices and large-chunk advisory were emitted.

```powershell
repowise distill C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd test:unit
```

Result: exit 0; 211 files passed; 2,504 tests passed and 44 explicitly skipped (2,548 total).

```powershell
repowise distill C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules\vitest\vitest.mjs run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts --reporter=dot
```

Result: exit 0; 39 passed and 4 platform-skipped.

```powershell
repowise distill C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules\vitest\vitest.mjs run --config vitest.integration.config.ts tests/integration/system-archive-resumable.integration.test.ts --reporter=dot
```

Result: exit 0; 27 passed and 1 platform-skipped.

```powershell
repowise distill C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd test:integration
```

Result: exit 0 across all 68 isolated PostgreSQL integration files. The runner provisions isolated database state per file; no PostgreSQL test was called passed merely because it was skipped.

```powershell
repowise distill C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd test:e2e:data-transfer
```

Result: exit 0; 27 Playwright tests passed using the replacement and legacy clients.

```powershell
git diff --check
git diff --cached --check
```

Result: both exit 0. The cached check emitted only the sandbox warning for the inaccessible user-level Git ignore file.

## Platform skips and remaining uncertainty

The following are present but were **not executed and are not claimed passed** on this Windows host:

- Linux-only durable private spool cleanup after publication failure.
- Linux-only real private asset metadata-backfill execution after System Import.
- Linux-only production private staging import round trip.
- Linux-only production Original Asset attachment rollback/shared-byte preservation.
- Linux-only private resumable-upload recovery across adapter recreation.
- The Task 8 compiled-service process-death/private-root scenarios remain Linux-only as previously recorded.

Windows exercised the process-local preview index, explicit close/recreate restart boundary, PostgreSQL durability/interleavings, full logical v2 round trip, both Chronicle rebuild executors, both rendered clients, and all non-platform-gated archive format regressions. Remaining uncertainty is limited to the explicitly Linux-gated physical permissions, inode/reaper, process-death, and private-root paths above; those require Linux CI/runtime evidence before enabling the still-default-off capability.

## Scope hygiene

- Repository-root `index.html`: unchanged.
- Existing Campaign/World/legacy archive routes and v1 schemas: retained.
- Unrelated pre-existing modifications to `docs/architecture/index.md`, the approved plan/spec, ADR drafts, `CONTEXT.md`, Disaster Recovery plan, Repowise seed directories, and `test-results/`: not staged or committed.
