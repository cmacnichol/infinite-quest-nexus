# Integration Suite Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the PostgreSQL-backed integration suite after the turn-generation logging branch exposed unrelated baseline failures.

**Architecture:** Fix the database/runtime contract failures at their source, then make integration harnesses configure the same provider transport path used by runtime startup. Keep production changes narrow: admission cleanup SQL, legacy import illustration-linking, and direct turn replacement behavior only if confirmed by the focused regression.

**Tech Stack:** TypeScript, Vitest 4, PostgreSQL 18 with pgvector, node-pg-migrate, Fastify, Undici provider transport.

**Execution status:** Applied on branch `codex/turn-generation-stream-logging` in commits `7ec9c91` and `33aaf85`. Task 5 required no production code change after the provider transport and fixture fixes; the replacement path passed in the targeted integration group and full suite.

## Global Constraints

- Integration tests require `TEST_DATABASE_URL`; skipped PostgreSQL suites are not verification.
- Use structured provider transport through `configureDefaultProviderTransport(createProviderTransport(...))`; do not bypass provider-network policy in tests that exercise provider calls.
- Do not log credentials, prompts, model output, private reasoning, or story content while adding diagnostics.
- Keep every code change paired with the related integration test.

---

## Investigation Summary

- `tests/integration/admission-control.integration.test.ts`: 7/8 fail because `cleanupExpiredBuckets()` runs `window_expires_at < $1 - interval '1 hour'`. PostgreSQL infers `$1` as an interval, causing SQLSTATE `42883` (`timestamptz < interval`). `acquireAdmission()` catches this and reports `AdmissionControlUnavailableError`.
- `tests/integration/cyoa-import.integration.test.ts`: CYOA import reaches `callTextProvider()`, but no default provider transport is configured in the test process.
- `tests/integration/gameplay.integration.test.ts`: provider-backed generation uses service functions directly after `buildServer()`. `buildServer()` does not configure provider transport; runtime startup does. One replacement assertion may also reveal stale latest-turn replacement behavior after transport is fixed.
- `tests/integration/image-pipeline.integration.test.ts`: provider image/Sogni jobs stay `queued` because default provider transport is not configured. The historical segment test separately gets `segmentCount = 0` because the legacy fixture’s latest turn is shorter than half the configured 100-word segment size.
- `tests/integration/import-memory.integration.test.ts`: embedding tests stub global `fetch`, but embedding calls now require the configured provider transport. Asset import tests also fail independently: optional imported illustration linking swallows SQL errors inside an open transaction, leaving it aborted; the insert path omits required segmented-illustration fields such as `source_text_hash`, `start_offset`, and `end_offset`.

### Task 1: Fix Admission Cleanup SQL

**Files:**
- Modify: `services/api/src/admission-service.ts`
- Test: `tests/integration/admission-control.integration.test.ts`

**Interfaces:**
- Consumes: `acquireAdmission(pool, ownerUserId, requestId, policy, now)`
- Produces: successful quota/concurrency decisions and preserved safe error wrapping for real storage failures

- [ ] **Step 1: Write a focused failing assertion for expired bucket cleanup**

Add a test that inserts a bucket older than the retention cutoff, calls `acquireAdmission()`, and verifies the expired bucket is removed while the new request succeeds.

```ts
it("cleans expired buckets using the supplied timestamp without failing admission", async () => {
  const ownerUserId = await initialOwnerId(pool);
  await pool.query(
    `INSERT INTO api_admission_buckets (
       owner_user_id, operation, window_started_at, window_expires_at, accepted_count
     ) VALUES ($1,'provider',$2,$3,1)`,
    [
      ownerUserId,
      new Date("2026-07-23T09:00:00Z"),
      new Date("2026-07-23T09:01:00Z")
    ]
  );

  const decision = await acquireAdmission(pool, ownerUserId, "cleanup-request", {
    key: "provider",
    windowSeconds: 60,
    maxRequests: 2,
    maxConcurrent: 1,
    leaseSeconds: 30
  }, new Date("2026-07-23T12:00:00Z"));

  expect(decision).toMatchObject({ allowed: true, remaining: 1 });
  await expect(pool.query("SELECT count(*)::int AS count FROM api_admission_buckets WHERE window_expires_at < $1::timestamptz - interval '1 hour'", [new Date("2026-07-23T12:00:00Z")]))
    .resolves.toMatchObject({ rows: [{ count: 0 }] });
});
```

- [ ] **Step 2: Run the focused admission test and verify it fails**

Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://infinitequest:testpassword123@127.0.0.1:5433/infinitequest'
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/admission-control.integration.test.ts -t "cleans expired buckets"
```

Expected: FAIL with `AdmissionControlUnavailableError` backed by SQLSTATE `42883`.

- [ ] **Step 3: Fix `cleanupExpiredBuckets()`**

Change the cleanup query to type the timestamp parameter explicitly.

```ts
`DELETE FROM api_admission_buckets
  WHERE ctid IN (
    SELECT ctid
      FROM api_admission_buckets
     WHERE window_expires_at < $1::timestamptz - interval '1 hour'
     ORDER BY window_expires_at
     LIMIT 100
  )`
```

- [ ] **Step 4: Verify admission suite**

Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://infinitequest:testpassword123@127.0.0.1:5433/infinitequest'
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/admission-control.integration.test.ts
```

Expected: all admission tests PASS.

- [ ] **Step 5: Commit**

```bash
git add services/api/src/admission-service.ts tests/integration/admission-control.integration.test.ts
git commit -m "Fix admission cleanup timestamp casting"
```

### Task 2: Add Shared Integration Provider Transport Setup

**Files:**
- Create: `tests/integration/provider-transport-test-helper.ts`
- Modify: `tests/integration/generation.integration.test.ts`
- Modify: `tests/integration/cyoa-import.integration.test.ts`
- Modify: `tests/integration/gameplay.integration.test.ts`
- Modify: `tests/integration/image-pipeline.integration.test.ts`
- Modify: `tests/integration/import-memory.integration.test.ts`

**Interfaces:**
- Consumes: provider base URLs bound to `127.0.0.1`
- Produces: `installIntegrationProviderTransport(allowlist?: string[]): ProviderTransport` helper that configures and returns a closeable transport

- [ ] **Step 1: Create the shared helper**

```ts
import { createProviderNetworkPolicy } from "../../packages/security/src/provider-network-policy.js";
import { configureDefaultProviderTransport, createProviderTransport } from "../../packages/story-engine/src/provider-transport.js";

export function installIntegrationProviderTransport(allowlist = ["127.0.0.0/8"]) {
  const transport = createProviderTransport({
    policy: createProviderNetworkPolicy({ allowlist })
  });
  configureDefaultProviderTransport(transport);
  return transport;
}
```

- [ ] **Step 2: Refactor `generation.integration.test.ts` onto the helper**

Replace direct `createProviderNetworkPolicy`, `createProviderTransport`, and `configureDefaultProviderTransport` usage with `installIntegrationProviderTransport()`. Keep the existing `afterAll` close call.

- [ ] **Step 3: Add failing CYOA transport setup test**

Before adding the helper to CYOA, rerun:

```powershell
$env:TEST_DATABASE_URL='postgresql://infinitequest:testpassword123@127.0.0.1:5433/infinitequest'
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/cyoa-import.integration.test.ts
```

Expected: FAIL with `The default provider transport has not been configured.`

- [ ] **Step 4: Install transport in provider-backed integration suites**

In `beforeAll`, assign:

```ts
providerTransport = installIntegrationProviderTransport();
```

In `afterAll`, close it:

```ts
if (providerTransport) await providerTransport.close();
```

Apply this to CYOA, gameplay, image-pipeline, and import-memory. For `import-memory`, keep the existing `vi.stubGlobal("fetch", ...)` tests only if they still intercept through transport; if not, replace stubs with a local HTTP server provider so the test exercises the same transport path as runtime.

- [ ] **Step 5: Verify transport-dependent suites**

Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://infinitequest:testpassword123@127.0.0.1:5433/infinitequest'
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/generation.integration.test.ts tests/integration/cyoa-import.integration.test.ts tests/integration/gameplay.integration.test.ts tests/integration/image-pipeline.integration.test.ts tests/integration/import-memory.integration.test.ts
```

Expected: transport errors are gone. Any remaining assertion failures become Tasks 3-5.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/provider-transport-test-helper.ts tests/integration/generation.integration.test.ts tests/integration/cyoa-import.integration.test.ts tests/integration/gameplay.integration.test.ts tests/integration/image-pipeline.integration.test.ts tests/integration/import-memory.integration.test.ts
git commit -m "Configure provider transport in integration tests"
```

### Task 3: Repair Imported Illustration Asset Linking

**Files:**
- Modify: `services/api/src/import-service.ts`
- Test: `tests/integration/import-memory.integration.test.ts`

**Interfaces:**
- Consumes: `importLegacyStory(pool, request, assetStore, assetBuffers?)`
- Produces: imported turn images persisted as assets, turn `image_url` updated to `/api/v1/assets/<id>`, and linked `turn_illustration_segment_assets`

- [ ] **Step 1: Add diagnostics by tightening the existing asset tests**

Update the data-URL test to assert `importLegacyStory()` rejects with the original SQL error before the fix if the optional link path still aborts. Do not keep this assertion after the fix; it is only a red-phase check.

- [ ] **Step 2: Fix `linkImportedTurnIllustration()` inserts**

Provide required columns in both inserts.

```ts
const sourceText = narration.slice(0, 1000);
const prompt = (imagePrompt || narration || "Turn illustration").slice(0, 2000);
const sourceHash = sha256(narration || prompt);
```

`turn_illustration_sets` insert must include `source_text_hash`.

`turn_illustration_segments` insert must include `start_offset` and `end_offset`, with values `0` and `sourceText.length`.

- [ ] **Step 3: Protect optional link work with a savepoint**

Replace swallowed in-transaction catches with a small helper:

```ts
async function withOptionalImportStep(client: DatabaseClient, step: () => Promise<void>): Promise<void> {
  await client.query("SAVEPOINT optional_import_step");
  try {
    await step();
    await client.query("RELEASE SAVEPOINT optional_import_step");
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT optional_import_step");
    await client.query("RELEASE SAVEPOINT optional_import_step");
  }
}
```

Use it around optional world-cover import, zip turn-image import, and imported illustration linking. Do not hide errors from required data-URL persistence.

- [ ] **Step 4: Verify asset import tests**

Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://infinitequest:testpassword123@127.0.0.1:5433/infinitequest'
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/import-memory.integration.test.ts -t "asset|data-URL|zip archive"
```

Expected: both asset tests PASS and no `current transaction is aborted` error remains.

- [ ] **Step 5: Commit**

```bash
git add services/api/src/import-service.ts tests/integration/import-memory.integration.test.ts
git commit -m "Fix imported illustration asset linking"
```

### Task 4: Make Historical Illustration Segmentation Test Use Eligible Fiction

**Files:**
- Modify: `tests/integration/image-pipeline.integration.test.ts`

**Interfaces:**
- Consumes: `generateTurnIllustrationSegments(pool, turnId, { mode })`
- Produces: deterministic nonzero segment count without mechanics leakage

- [ ] **Step 1: Update the test fixture narration after import**

Before selecting the latest turn, update its narration to a fiction-only passage with at least 50 words when `segmentWordCount` is 100.

```ts
const eligibleNarration = [
  "Mira raises the lantern as the road bends through silver fog.",
  "The wet stones shine beneath her boots, and the broken arch ahead catches a thin thread of moonlight.",
  "A bell rings somewhere beyond the trees, soft enough to feel distant but clear enough to guide the party forward.",
  "She tightens her weathered blue cloak and studies the shadows for a safe path."
].join(" ");

await pool.query(
  "UPDATE turns SET narration = $2 WHERE campaign_id = $1 AND turn_number = 2",
  [imported.campaignId, eligibleNarration]
);
```

- [ ] **Step 2: Verify the focused segment test**

Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://infinitequest:testpassword123@127.0.0.1:5433/infinitequest'
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/image-pipeline.integration.test.ts -t "historical segment"
```

Expected: `segmentCount > 0` and character reference assertions PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/image-pipeline.integration.test.ts
git commit -m "Seed eligible narration for segment integration"
```

### Task 5: Verify Latest-Turn Replacement Behavior

**Files:**
- Potentially modify: `services/api/src/generation-service.ts`
- Test: `tests/integration/gameplay.integration.test.ts`
- Test: `tests/integration/generation.integration.test.ts`

**Interfaces:**
- Consumes: `enqueueLatestReplacement()`, `runGenerationJob()`, `sync-status`
- Produces: a completed `replace_latest` job that atomically replaces the previous latest turn

- [ ] **Step 1: Rerun after Tasks 1-4**

Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://infinitequest:testpassword123@127.0.0.1:5433/infinitequest'
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/gameplay.integration.test.ts -t "staged latest-turn replacement"
```

Expected: PASS. If it still fails with the original latest action (`Move to Location Beta.`), continue.

- [ ] **Step 2: Add focused state assertions**

In the test, query `generation_jobs` and latest `turns` after `runGenerationJob()` to capture:

```ts
const jobRow = await getGenerationJob(pool, queued.json().id);
expect(jobRow).toMatchObject({ status: "completed", operationKind: "replace_latest" });
```

Add a database query for the latest turn number/action if needed to distinguish failed commit from API serialization.

- [ ] **Step 3: Fix only the confirmed layer**

If the job is completed but the latest turn is unchanged, inspect `commitStoryTurn()` replacement logic and ensure `operation_kind = 'replace_latest'` deletes/supersedes the current latest turn before inserting the replacement under the same expected turn number. If the job is failed, use the job `error_code` and `recovery_metadata` to fix that source instead.

- [ ] **Step 4: Verify replacement tests**

Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://infinitequest:testpassword123@127.0.0.1:5433/infinitequest'
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/gameplay.integration.test.ts tests/integration/generation.integration.test.ts -t "replace|replacement|retry-latest"
```

Expected: latest-turn replacement tests PASS in both suites.

- [ ] **Step 5: Commit only if code changed**

```bash
git add services/api/src/generation-service.ts tests/integration/gameplay.integration.test.ts tests/integration/generation.integration.test.ts
git commit -m "Fix latest turn replacement integration"
```

### Task 6: Full Verification

**Files:**
- No production file changes expected.

**Interfaces:**
- Consumes: all prior tasks
- Produces: clean branch ready for review/PR handoff

- [ ] **Step 1: Run focused changed-file checks**

```powershell
pnpm check
pnpm build
pnpm test:unit
```

Expected: all PASS.

- [ ] **Step 2: Run full PostgreSQL integration suite**

```powershell
$env:TEST_DATABASE_URL='postgresql://infinitequest:testpassword123@127.0.0.1:5433/infinitequest'
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts
```

Expected: all non-skipped integration tests PASS. Existing intentional skips must be listed.

- [ ] **Step 3: Run whitespace and diff review**

```powershell
git diff --check
git diff --stat
git diff -- docs/superpowers/plans/2026-07-26-turn-generation-streaming-logging.md
```

Expected: no whitespace errors and no unrelated turn-generation plan churn.

- [ ] **Step 4: Commit verification docs only if they changed**

```bash
git status --short
```

Expected: clean after commits, or only intentionally unstaged local test artifacts ignored by git.

## Self-Review

- Spec coverage: Covers every failed file from the full-suite rerun: admission-control, CYOA import, gameplay, image-pipeline, and import-memory.
- Placeholder scan: No TBD/TODO placeholders remain; ambiguous items are gated behind focused reruns because Task 5 depends on post-transport behavior.
- Type consistency: Helper returns the existing `ProviderTransport`; service signatures remain unchanged except the optional helper inside `import-service.ts`.
