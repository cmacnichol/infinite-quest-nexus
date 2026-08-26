# System Archive second final remediation report

Date: 2026-08-26
Platform: Windows (`win32`)
Node: `v24.18.0`
pnpm: `11.19.0`
Base: `c384a39`

## Outcome

The four findings in `second-final-remediation-findings.md` were implemented in the authorized scope. System Archive remains default-off. The repository-root historical `index.html`, existing v1 compatibility, unrelated dirty/untracked files, and inaccessible `.repowise-seed` files were not changed by this remediation.

Implementation commit:

```text
36e77b1c3b3e34a395db70652bca3b7755b81528 Fix System Archive residual blockers
```

## Finding disposition

### 1. Strict secret and capability boundary

- Added one recursive v2 portable-authority JSON validator at the shared `systemRecordEnvelopeSchema` boundary and applied it to every v2 arbitrary JSON field, including mechanics, owner/campaign settings, state, Chronicle, imports, cost/activity data, generation context, and asset technical metadata.
- Strengthened the established excluded-metadata policy for compact/camel/snake token, capability, grant, nonce, and authentication aliases.
- Import validation rejects unsafe authority without transforming it. Export explicitly sanitizes known source metadata before parsing the common strict schema.
- Added a separate image-authority validator: ordinary stable public HTTP(S) URLs and internal asset URLs remain valid; credentials/userinfo, fragments, signed/temporary/capability material, secret-bearing query parameters, local/private hosts, and file/data/blob schemes fail closed.

### 2. Exact PostgreSQL timestamp authority

- Direct owner and Original Asset authority queries now use scoped PostgreSQL `to_char(... AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` projections.
- Asset/reference/library/generation-context/segment timestamps retain all six PostgreSQL fractional digits.
- No global node-postgres parser was changed; existing JSONB-built timestamp authority remains unchanged.

### 3. PostgreSQL bigint activity identity

- V2 activity IDs are validated as canonical positive signed-bigint decimal strings (`1` through `9223372036854775807`).
- Import binds the v2 string directly to PostgreSQL and advances the sequence from the restored authority without passing through JavaScript `Number`.
- V1 UUID-derived activity compatibility remains on its existing numeric derivation path.

### 4. Governed preview-index bytes

- Added an injectable positive safe-integer `maximumIndexedBytes` with a conservative 512 MiB production default.
- Every SQLite insertion now passes through one pre-insertion byte-budget gate that accounts for row overhead and retained UTF-8 strings before SQLite retains the values.
- Full character profiles and asset bindings are represented by canonical SHA-256 equality projections. Campaign-state JSON and state-edit JSON are no longer retained because relationship validation reads only their revision authority.
- Overflow preserves the typed `archive-limit-exceeded` failure instead of being remapped by SQLite relationship error handling.

## Changed files

Implementation and tests:

- `packages/contracts/src/archives.ts`
- `packages/contracts/src/system-archives.ts`
- `packages/database/src/system-archive-export-repository.ts`
- `packages/database/src/system-archive-import-repository.ts`
- `services/runtime/src/system-archive-preview-index.ts`
- `tests/integration/system-archive.integration.test.ts`
- `tests/unit/system-archive-contracts.test.ts`
- `tests/unit/system-archive-preview-hardening.test.ts`

Evidence/ledger:

- `.superpowers/sdd/2026-07-26-system-archive-portability/second-final-fix-report.md`
- `.superpowers/sdd/2026-07-26-system-archive-portability/progress.md`

## Strict RED evidence

Each RED below was captured before its corresponding production correction. Later REDs came from incremental adversarial self-review of the same four findings.

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/system-archive-contracts.test.ts tests/unit/system-archive-preview-hardening.test.ts
```

Initial RED: exit 1; both files failed, with 10 failed and 67 passed. Recursive secret/capability aliases and unsafe image authority were accepted, and the preview index had no byte-budget failure.

```powershell
node --env-file=.env.test.local node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts -t 'preserves exact PostgreSQL microseconds|round-trips non-default v2 authority'
```

Initial PostgreSQL RED: exit 1; 2 failed and 42 skipped. Direct-query timestamps returned `.123Z` instead of `.123456Z`, and the `9007199254740993` v2 activity sentinel failed with `System Archive activity identity is invalid.`

```powershell
node --env-file=.env.test.local node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts -t 'removes recursive secret and capability authority'
```

Export/persistence RED: exit 1; 1 failed and 44 skipped because the recursive `oneTimeReadGrant` sentinel remained in archive bytes. The first sanitizer iteration also exposed a destination non-null constraint by producing `NULL` for an unsafe source image URL; the final exporter uses the schema-valid empty-image representation.

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/system-archive-preview-hardening.test.ts -t 'preserves the typed byte-limit failure'
```

Preview error-typing RED: exit 1; 1 failed and 36 skipped. The required `archive-limit-exceeded` was caught and remapped to `archive-world-mismatch`.

Additional adversarial REDs:

- Focused contracts/preview: 3 failed and 77 passed because a root-level `bearerToken`, empty-userinfo `https://@...`, and an empty fragment marker `#` were accepted.
- Image-authority filter: 1 failed, 10 passed, and 33 skipped because IPv4-mapped IPv6 loopback (`[::ffff:127.0.0.1]`) was accepted.
- First complete PostgreSQL runner after bigint hardening: the System Archive file had 1 failed, 40 passed, and 4 skipped because the v2 union refinement called `BigInt` on a valid v1 UUID candidate. The final refinement short-circuits by canonical decimal shape/length before conversion.
- Minimal-projection filter: 1 failed and 37 skipped because campaign-state JSON was still hashed and counted even though no relationship query reads it.

## Focused GREEN evidence

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/system-archive-contracts.test.ts tests/unit/system-archive-preview-hardening.test.ts
```

Result: exit 0; 2 files and 82 tests passed.

```powershell
node --env-file=.env.test.local node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts
```

Result: exit 0; 41 passed and 4 explicitly platform-skipped.

## Full verification

```powershell
pnpm check
```

Result: exit 0. The repository checks passed; warnings were limited to inaccessible pre-existing `.repowise-seed` paths and the sandbox-inaccessible user Git ignore file.

```powershell
pnpm build
```

Result: exit 0. Both production web builds and TypeScript build passed. Existing font-resolution and large-chunk advisories remained warnings only.

```powershell
pnpm test:unit
```

Result: exit 0; 211 files passed; 2,519 tests passed and 44 explicitly skipped (2,563 total).

```powershell
node --env-file=.env.test.local scripts/run-isolated-integration.mjs
```

Final result: exit 0 across all 68 isolated PostgreSQL integration files.

The preceding complete-run attempt is not hidden or called passed: it stopped at file 42/68 when the unrelated `task-14e3b3-finalized-delivery.integration.test.ts` lock-ordering test returned `resolution.kind = "error"` once. The exact test immediately passed alone (1 passed, 9 skipped), its whole file then passed (10/10), no changed file overlaps that path, and the restarted 68-file runner completed with exit 0. This remains a timing-dependent test concern, not an omitted gate.

```powershell
pnpm test:e2e:data-transfer
```

Result: exit 0; 27 Playwright tests passed across the replacement and legacy Data Transfer clients.

```powershell
git diff --check
git diff --cached --check
git diff --check c384a39..36e77b1
```

Result: exit 0 for the working implementation tree, exact staged implementation, and implementation range. Final evidence-commit range and working-tree checks are repeated in the handoff after the report/ledger commit.

## Platform skips and remaining uncertainty

The focused System Archive PostgreSQL file explicitly skipped these four secure private-staging cases on Windows; they are **not claimed passed**:

- Cleans durable private spool authority when publication fails.
- Executes every queued post-import asset rebuild without changing Original Asset authority.
- Consumes opaque preview authority and restores through production staging.
- Rolls back logical authority when production Original Asset attachment fails and preserves shared bytes.

The complete runner also retained the existing Linux-only skips for the two compiled-service/private-root release scenarios, production private resumable-upload recovery across adapter recreation, and the ten-test private asset metadata-backfill composition file. Existing Linux-only process-death, inode/reaper, permissions, and private-root evidence remains outside this Windows remediation run.

## Scope hygiene and concerns

- System Archive remains default-off; no enablement configuration changed.
- Repository-root historical `index.html` is unchanged.
- Existing v1, Campaign Archive, World Archive, and legacy routes/contracts remain in scope only through passing regressions.
- Unrelated modifications to `docs/architecture/index.md`, the approved plan/spec, and unrelated untracked files remain unstaged and uncommitted.
- Inaccessible `.repowise-seed` files were neither read nor modified.
- The single non-reproducing finalized-delivery concurrency failure above is the only newly observed non-System-Archive test concern.

## Post-review narrow security repair

The fresh security review after `36e77b1` / `92fdee2` confirmed three direct instances of the already-authorized secret/capability blocker: separator-obfuscated secret and grant keys, explicit v2 provider response authority, and percent-encoded signed/temporary image-path segments. The repair is committed in `6c7eece` (`Harden System Archive authority boundaries`). System Archive remains default-off.

### Strict RED evidence

The following regressions were added and run before any production edit:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/system-archive-contracts.test.ts tests/unit/system-archive-portability.test.ts
```

RED result: exit 1; 2 files failed, with 14 failed and 46 passed. The failures demonstrated all seven punctuation/Unicode separator aliases, five encoded/query URL probes, the explicit v2 `providerResponseId` boundary, and the incorrect portability-registry classification. Safe story-key and stable public-image controls remained in the same contract fixture.

```powershell
node --env-file=.env.test.local node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts -t "removes recursive secret and capability authority|round-trips non-default v2 authority"
```

PostgreSQL RED result: exit 1; 2 failed and 43 skipped. Export bytes contained `provider-response-authority-sentinel`, while the safe v2 cost-event fixture without `providerResponseId` was rejected because that field was still required.

### Minimal repair

- Portable metadata keys now pass through Unicode NFKC normalization and separator-insensitive semantic-family checks. Established secret/grant spellings such as `api.key`, `private.key`, `auth.header`, `bearer.grant`, and Unicode separator variants fail closed, while ordinary safe story keys remain accepted.
- Image URL path segments are decoded exactly once. Malformed encoding, residual percent-encoding (double-decoding ambiguity), encoded path separators, and decoded `signed`, `presigned`, `temp`, `temporary`, or `capability` segments are rejected; stable public HTTP(S) images with ordinary percent-encoded content remain accepted.
- The strict v2 cost-event contract no longer accepts `providerResponseId`; export never emits it, import SQL cannot restore it, and the source-column registry classifies it as `operational_excluded`. The v1 cost-event schema remains accepted. Unsafe v2 import input is rejected, not silently transformed.

### Focused GREEN evidence

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/system-archive-contracts.test.ts tests/unit/system-archive-portability.test.ts
```

Result: exit 0; 2 files and 60 tests passed.

```powershell
node --env-file=.env.test.local node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts -t "removes recursive secret and capability authority|round-trips non-default v2 authority"
```

Result: exit 0; 2 passed and 43 skipped by the name filter.

### Current-head full verification

- `pnpm check`: exit 0. Repository boundary, TypeScript, web, and syntax checks passed; warnings remained limited to the inaccessible user Git ignore file and pre-existing `.repowise-seed` paths.
- `pnpm build`: exit 0. Both production web builds and TypeScript build passed; existing font-resolution and large-chunk advisories remained warnings only.
- `pnpm test:unit`: exit 0; 211 files passed, 2,532 tests passed, and 44 were explicitly skipped (2,576 total).
- Full isolated `tests/integration/system-archive.integration.test.ts`: exit 0; 41 passed and 4 Windows-only platform skips remained unverified.
- `node --env-file=.env.test.local scripts/run-isolated-integration.mjs`: exit 0 across all 68 isolated PostgreSQL integration files.
- `pnpm test:e2e:data-transfer`: exit 0; all 27 Playwright tests passed across the replacement and legacy clients.

No new platform skip was introduced. The Windows- and Linux-only private staging, recovery, metadata-backfill, process-death, and private-root paths listed above remain unverified rather than being called passed. The unrelated dirty documentation and inaccessible/untracked user files remained outside the commit, and repository-root historical `index.html` is unchanged.
