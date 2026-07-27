# Linux Archive Integration Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native Windows test runs pass without weakening archive staging security, while requiring every successful archive staging path to run in Linux CI.

**Architecture:** Add one production-owned predicate that reports whether secure generated-archive staging is implemented on the current platform. Use it both to preserve the fail-closed runtime guard and to skip only the 21 Linux-only success cases on native Windows; then make the PostgreSQL test harness cross-platform and restore the complete integration suite on Ubuntu CI.

**Tech Stack:** TypeScript 7, Node.js 24, Vitest 4, GitHub Actions, Docker Compose, PostgreSQL 18 with pgvector.

## Global Constraints

- Native Windows API archive generation remains unsupported and fail-closed.
- Linux Docker is the only production execution path.
- Do not add native Win32 directory-handle support.
- Do not permit path-only generated-archive staging on Windows.
- Do not weaken symlink, junction, directory-identity, cleanup, or root-boundary checks.
- Do not change campaign archive formats, API contracts, database schemas, or production deployment manifests.
- Do not skip platform-neutral campaign archive, gameplay, database, import, or validation coverage.
- Successful campaign archive export, staging, preview, cleanup, and gameplay export must execute in Ubuntu CI.
- Use strict TDD: capture RED before production or workflow changes, make the minimum scoped change, then capture GREEN.
- Preserve unrelated working-tree changes in `.claude`, `.repowise`, `.vscode`, and `AGENTS.md`.
- Treat PostgreSQL tests as verified only when the real Docker-provisioned integration suite actually runs.

---

## File Structure

- Modify `services/api/src/archive-io.ts`: own the secure generated-staging capability predicate and enforce it before filesystem mutation.
- Modify `tests/unit/archive-io.test.ts`: specify the platform capability matrix and unsupported-platform fail-closed behavior.
- Modify `tests/integration/campaign-archive.integration.test.ts`: skip exactly the 20 successful generated-staging cases on unsupported hosts.
- Modify `tests/integration/gameplay.integration.test.ts`: skip only the campaign ZIP export case on unsupported hosts.
- Modify `scripts/ensure-test-database.mjs`: select `docker.exe` on Windows and `docker` elsewhere.
- Modify `scripts/ensure-test-database.d.mts`: declare the Docker command resolver.
- Modify `tests/unit/ensure-test-database.test.ts`: cover Windows and Linux Docker executable selection.
- Modify `.github/workflows/ci.yml`: add the Ubuntu PostgreSQL integration step.
- Modify `tests/unit/ci-workflow.test.ts`: require the integration step without workflow-owned credentials.

### Task 1: Define the secure generated-staging capability

**Files:**
- Modify: `services/api/src/archive-io.ts:32-40`
- Modify: `services/api/src/archive-io.ts:368-386`
- Test: `tests/unit/archive-io.test.ts:20-34`
- Test: `tests/unit/archive-io.test.ts:380-413`

**Interfaces:**
- Consumes: Node's `process.platform` value.
- Produces: `supportsSecureGeneratedArchiveStaging(platform?: NodeJS.Platform): boolean`.
- Produces: `createArchiveStagingDirectory(archiveRoot, prefix)` rejects with `ArchiveError.code === "archive-entry-unsafe"` before creating `archiveRoot/staging` when the predicate is false.

- [ ] **Step 1: Import the not-yet-implemented predicate in the unit test**

Add `supportsSecureGeneratedArchiveStaging` to the existing import from `services/api/src/archive-io.js`:

```ts
import {
  ArchiveError,
  createArchiveStagingDirectory,
  inspectArchive,
  readVerifiedEntry,
  rehydratePersistedStagedArchive,
  removeArchivePath,
  stageArchiveUpload,
  supportsSecureGeneratedArchiveStaging,
  writeArchiveArtifact,
  type ArchiveArtifactEntry,
  type ArchiveLimits,
  type StagedArchive
} from "../../services/api/src/archive-io.js";
```

- [ ] **Step 2: Write the failing capability-matrix test**

Add a focused describe block before `describe("staged archive uploads", ...)`:

```ts
describe("secure generated archive staging capability", () => {
  it.each([
    ["linux", true],
    ["win32", false],
    ["darwin", false]
  ] as const)("reports %s support as %s", (platform, expected) => {
    expect(supportsSecureGeneratedArchiveStaging(platform)).toBe(expected);
  });
});
```

- [ ] **Step 3: Tighten the existing fail-closed test**

Change `"does not expose a mutable fallback path for generated archive asset writes"` so it proves the capability check happens before staging-directory creation:

```ts
it("does not expose a mutable fallback path for generated archive asset writes", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const root = await temporaryRoot();

  const error = await expectArchiveError(
    createArchiveStagingDirectory(root, "campaign-export-"),
    "archive-entry-unsafe"
  );

  expect(error.message).toBe("This platform cannot safely stage generated archive assets.");
  await expect(stat(join(root, "staging"))).rejects.toMatchObject({ code: "ENOENT" });
});
```

Add `stat` to the existing import from `node:fs/promises`.

- [ ] **Step 4: Run the focused test to verify RED**

Run:

```powershell
pnpm exec vitest run tests/unit/archive-io.test.ts --reporter=verbose
```

Expected: FAIL because `supportsSecureGeneratedArchiveStaging` is not exported. If module loading stops at the missing export, that is sufficient RED evidence for both new expectations.

- [ ] **Step 5: Add the minimal production capability predicate**

Place this near the archive constants:

```ts
export function supportsSecureGeneratedArchiveStaging(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === "linux";
}
```

The optional argument exists to make the platform matrix a pure unit test. Production callers omit it.

- [ ] **Step 6: Enforce the predicate before filesystem mutation**

Keep prefix validation first, then reject unsupported staging before `prepareRootDirectory`:

```ts
export async function createArchiveStagingDirectory(
  archiveRoot: string,
  prefix: string
): Promise<ArchiveStagingDirectory> {
  if (!/^[a-z0-9-]+$/i.test(prefix)) {
    throw archiveError("archive-entry-unsafe", "Archive staging requires a safe directory prefix.");
  }
  if (!supportsSecureGeneratedArchiveStaging()) {
    throw archiveError(
      "archive-entry-unsafe",
      "This platform cannot safely stage generated archive assets."
    );
  }
  const { root, directory, stable } = await prepareRootDirectory(archiveRoot, "staging");
```

Remove the later `if (!stable.anchor)` branch at the old lines 381-386. Do not alter Linux anchor creation, `stableChildPath`, cleanup identity checks, or the no-junction validation.

- [ ] **Step 7: Run focused GREEN verification**

Run:

```powershell
pnpm exec vitest run tests/unit/archive-io.test.ts --reporter=verbose
pnpm check
git diff --check -- services/api/src/archive-io.ts tests/unit/archive-io.test.ts
```

Expected: all archive I/O unit tests pass; type checking passes; diff check reports no errors.

- [ ] **Step 8: Review the scoped diff**

Run:

```powershell
git diff -- services/api/src/archive-io.ts tests/unit/archive-io.test.ts
```

Confirm:

- only Linux reports secure generated-staging support;
- unsupported hosts fail before `staging` is created;
- Linux stable-handle and cleanup code is unchanged;
- no archive contract or error code changed.

- [ ] **Step 9: Commit Task 1**

```powershell
git add -- services/api/src/archive-io.ts tests/unit/archive-io.test.ts
git commit -m "Expose secure archive staging capability"
```

### Task 2: Partition integration tests by staging capability

**Files:**
- Modify: `tests/integration/campaign-archive.integration.test.ts:10-20`
- Modify: `tests/integration/campaign-archive.integration.test.ts:353-1218`
- Modify: `tests/integration/gameplay.integration.test.ts:1-15`
- Modify: `tests/integration/gameplay.integration.test.ts:409-427`

**Interfaces:**
- Consumes: `supportsSecureGeneratedArchiveStaging(): boolean` from Task 1.
- Produces: a `secureGeneratedStagingIt` Vitest selector in each integration file.
- Produces: native Windows integration results with the 21 generated-staging success cases skipped and every platform-neutral case still executed; pre-existing explicit skips in unrelated integration files remain unchanged.
- Produces: Linux integration results with all 21 cases enabled.

- [ ] **Step 1: Capture the existing Windows integration RED**

With Docker Engine running, run:

```powershell
pnpm test:integration
```

Expected: FAIL with the current 21-case cascade:

- 20 failures in `campaign-archive.integration.test.ts`;
- one failure in `gameplay.integration.test.ts`;
- the common error is `archive-entry-unsafe: This platform cannot safely stage generated archive assets.`

Record the failing test names, not only the aggregate count.

- [ ] **Step 2: Import the shared capability into the campaign archive integration test**

Consolidate the two archive I/O imports:

```ts
import {
  inspectArchive,
  readVerifiedEntry,
  stageArchiveUpload,
  supportsSecureGeneratedArchiveStaging,
  type ArchiveLimits
} from "../../services/api/src/archive-io.js";
```

Define the test selector beside `integration`:

```ts
const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const secureGeneratedStagingIt = supportsSecureGeneratedArchiveStaging() ? it : it.skip;
```

- [ ] **Step 3: Gate exactly the 20 campaign archive cases that require successful generated staging**

Replace `it(` with `secureGeneratedStagingIt(` only for these tests and prefix each title with `[secure generated staging] `. For example:

```ts
secureGeneratedStagingIt("[secure generated staging] exports only the selected campaign and pinned world version as a deterministic manifest archive", async () => {
```

Keep each existing test body and closing syntax unchanged. Apply that mechanical declaration-and-title change to:

```text
exports only the selected campaign and pinned world version as a deterministic manifest archive
serves campaign exports as no-store attachments and removes the response artifact
previews multipart Campaign Archives and commits the bound JSON request
rejects an assets payload that contradicts manifest asset metadata
fails closed for an archive that exceeds configured limits
fails closed when a required original is absent
preview cleanup removes a successful new import upload after commit
canonicalizes ID-less campaign, turn, and state-edit tracker snapshots on import
migration history omits audit rows whose world versions are not portable
preview cleanup retries a superseded upload without deleting the replacement
commits a persisted staged archive from only the preview token and destination
rejects an explicitly selected destination version whose canonical world content differs
attaches an explicitly selected world version when only export-removed provider secrets differ
revalidates explicit attachment through export-compatible sanitization after a secret changes post-preview
preview cleanup removes an idempotent duplicate import upload after commit
preview cleanup retries a consumed upload without rolling back the committed import
preview cleanup retries expired staging after a transient deletion failure
rejects expired, consumed, and application-stale preview tokens
preview cleanup lets a failed commit supersede expiry after rollback
preview cleanup marks failed commits failed and removes staging plus newly persisted archive originals
```

Do not gate these platform-neutral cases:

```text
does not export a foreign-owner campaign
returns the typed safe archive error for malformed archive uploads
keeps legacy JSON imports and manifest-less ZIP previews available
fails closed when a required original exceeds the configured export image limit
rejects a campaign state revision that does not match its edit ledger
previews manifest-less legacy ZIPs with compatibility warnings
```

Do not gate the outer `integration("campaign archive export", ...)` block; its database setup and platform-neutral tests must still run on Windows.

- [ ] **Step 4: Gate only the gameplay ZIP export case**

Import the predicate:

```ts
import { supportsSecureGeneratedArchiveStaging } from "../../services/api/src/archive-io.js";
```

Define the selector beside `integration`:

```ts
const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const secureGeneratedStagingIt = supportsSecureGeneratedArchiveStaging() ? it : it.skip;
```

Change only the selector and title:

```ts
secureGeneratedStagingIt("[secure generated staging] exports the portable campaign ZIP format via GET /api/v1/campaigns/:id/export", async () => {
```

Keep the existing body and closing syntax unchanged. Leave the Story Player generation, replacement, player-config, and rewind tests as normal `it(...)` cases.

- [ ] **Step 5: Run the two focused integration files for GREEN**

Run:

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-archive.integration.test.ts tests/integration/gameplay.integration.test.ts --reporter=verbose
```

Expected on native Windows:

- zero failures;
- the 21 named secure generated-staging cases are reported as skipped;
- the six named platform-neutral campaign archive cases execute;
- the four non-export gameplay cases execute;
- PostgreSQL is provisioned and migrations run.

Expected on Linux:

- zero failures;
- none of the 21 secure generated-staging cases are skipped.

- [ ] **Step 6: Run the complete Windows integration suite**

Run:

```powershell
pnpm test:integration
```

Expected: PASS with the 21 explicitly named secure generated-staging cases skipped. The three pre-existing explicit skips in `world-library.integration.test.ts` and `image-pipeline.integration.test.ts` remain unchanged; any other newly introduced skip or failure must be investigated before proceeding.

- [ ] **Step 7: Review the scoped diff and test selection**

Run:

```powershell
git diff -- tests/integration/campaign-archive.integration.test.ts tests/integration/gameplay.integration.test.ts
```

Compare every changed test name against the two exact lists above. Confirm no outer describe block, setup hook, platform-neutral case, or assertion was changed.

- [ ] **Step 8: Commit Task 2**

```powershell
git add -- tests/integration/campaign-archive.integration.test.ts tests/integration/gameplay.integration.test.ts
git commit -m "Scope archive integration tests by platform"
```

### Task 3: Make PostgreSQL provisioning portable

**Files:**
- Modify: `scripts/ensure-test-database.mjs:8-16`
- Modify: `scripts/ensure-test-database.mjs:107-117`
- Modify: `scripts/ensure-test-database.d.mts:1-24`
- Test: `tests/unit/ensure-test-database.test.ts:20-61`

**Interfaces:**
- Produces: `dockerCommandForPlatform(platform?: NodeJS.Platform): "docker.exe" | "docker"`.
- Consumes: the resolver in `ensureTestDatabase`.
- Preserves: `EnsureTestDatabaseOptions.execute(command, argumentsList, { cwd })`.
- Preserves: generated `.env.test.local` credentials and the `infinitequest-test` Compose project contract.

- [ ] **Step 1: Write the failing Docker command matrix**

Import `dockerCommandForPlatform` with `ensureTestDatabase`:

```ts
import {
  dockerCommandForPlatform,
  ensureTestDatabase
} from "../../scripts/ensure-test-database.mjs";
```

Add:

```ts
it.each([
  ["win32", "docker.exe"],
  ["linux", "docker"],
  ["darwin", "docker"]
] as const)("uses %s Docker command %s", (platform, expected) => {
  expect(dockerCommandForPlatform(platform)).toBe(expected);
});
```

- [ ] **Step 2: Make the existing execution expectation platform-aware**

Replace the literal `"docker.exe"` expectation with:

```ts
expect(execute).toHaveBeenCalledWith(dockerCommandForPlatform(), [
  "compose",
  "--env-file", config.environmentFile,
  "--project-name", "infinitequest-test",
  "--file", join(projectRoot, "compose.test.yaml"),
  "up", "--detach", "integration-postgres"
], { cwd: projectRoot });
```

- [ ] **Step 3: Run focused RED verification**

Run:

```powershell
pnpm exec vitest run tests/unit/ensure-test-database.test.ts --reporter=verbose
```

Expected: FAIL because `dockerCommandForPlatform` is not exported.

- [ ] **Step 4: Implement the pure resolver**

Add near the test database constants:

```js
export function dockerCommandForPlatform(platform = process.platform) {
  return platform === "win32" ? "docker.exe" : "docker";
}
```

Use it when launching Compose:

```js
await execute(dockerCommandForPlatform(), [
  "compose",
  "--env-file", config.environmentFile,
  "--project-name", TEST_COMPOSE_PROJECT,
  "--file", composeFile,
  "up", "--detach", "integration-postgres"
], { cwd: projectRoot });
```

- [ ] **Step 5: Declare the resolver**

Add to `scripts/ensure-test-database.d.mts`:

```ts
export function dockerCommandForPlatform(
  platform?: NodeJS.Platform
): "docker.exe" | "docker";
```

Do not change `EnsureTestDatabaseOptions`, the `execute` callback signature, ports, project names, credentials, or Compose arguments.

- [ ] **Step 6: Run focused GREEN verification**

Run:

```powershell
pnpm exec vitest run tests/unit/ensure-test-database.test.ts --reporter=verbose
pnpm check
git diff --check -- scripts/ensure-test-database.mjs scripts/ensure-test-database.d.mts tests/unit/ensure-test-database.test.ts
```

Expected: focused tests, type checking, and diff check pass.

- [ ] **Step 7: Commit Task 3**

```powershell
git add -- scripts/ensure-test-database.mjs scripts/ensure-test-database.d.mts tests/unit/ensure-test-database.test.ts
git commit -m "Make integration database provisioning portable"
```

### Task 4: Enforce the Linux integration suite in CI

**Files:**
- Modify: `.github/workflows/ci.yml:35-42`
- Modify: `tests/unit/ci-workflow.test.ts:5-13`

**Interfaces:**
- Consumes: cross-platform `pnpm test:integration` provisioning from Task 3.
- Produces: an Ubuntu CI step named `Test PostgreSQL integration suite`.
- Preserves: no workflow `services.postgres`, no workflow `TEST_DATABASE_URL`, and no committed database password.

- [ ] **Step 1: Rewrite the workflow contract test first**

Replace the old unit-only contract with:

```ts
describe("GitHub CI test workflow", () => {
  it("runs unit and Docker-provisioned PostgreSQL integration tests", async () => {
    const workflow = await readFile(resolve(".github/workflows/ci.yml"), "utf8");

    expect(workflow).toMatch(/name: Test unit suite\r?\n\s+run: pnpm test:unit/u);
    expect(workflow).toMatch(
      /name: Test PostgreSQL integration suite\r?\n\s+run: pnpm test:integration/u
    );
    expect(workflow).not.toMatch(/services:\r?\n\s+postgres:/u);
    expect(workflow).not.toContain("TEST_DATABASE_URL:");
    expect(workflow).not.toMatch(/run: pnpm test\r?\n/u);
  });
});
```

The negative `pnpm test` assertion prevents the unit suite from running twice.

- [ ] **Step 2: Run the workflow test for RED**

Run:

```powershell
pnpm exec vitest run tests/unit/ci-workflow.test.ts --reporter=verbose
```

Expected: FAIL because the workflow lacks `Test PostgreSQL integration suite`.

- [ ] **Step 3: Add the Ubuntu integration step**

Insert immediately after the unit test step:

```yaml
      - name: Test PostgreSQL integration suite
        run: pnpm test:integration
```

Do not add a workflow service, `TEST_DATABASE_URL`, static password, or separate database image. The Vitest global setup must remain the sole provisioning path.

- [ ] **Step 4: Run focused GREEN verification**

Run:

```powershell
pnpm exec vitest run tests/unit/ci-workflow.test.ts tests/unit/ensure-test-database.test.ts --reporter=verbose
pnpm check
git diff --check -- .github/workflows/ci.yml tests/unit/ci-workflow.test.ts
```

Expected: focused tests, type checking, and diff check pass.

- [ ] **Step 5: Validate workflow and Compose assumptions locally**

Run:

```powershell
$env:POSTGRES_PASSWORD = "compose-validation-only"
docker compose config --quiet
docker compose --env-file .env.test.local --project-name infinitequest-test --file compose.test.yaml config --quiet
Remove-Item Env:POSTGRES_PASSWORD
```

Expected: both Compose configurations validate. The second command may run only after a prior integration test has generated ignored `.env.test.local`.

- [ ] **Step 6: Review the complete Task 4 diff**

Run:

```powershell
git diff -- .github/workflows/ci.yml tests/unit/ci-workflow.test.ts
```

Confirm the only workflow behavior change is the new integration step and that no secret or database URL appears.

- [ ] **Step 7: Commit Task 4**

```powershell
git add -- .github/workflows/ci.yml tests/unit/ci-workflow.test.ts
git commit -m "Run PostgreSQL integration tests in CI"
```

### Task 5: Complete cross-platform verification

**Files:**
- No production-file changes expected.
- Verify all files changed in Tasks 1-4.

**Interfaces:**
- Consumes: all prior task commits.
- Produces: Windows evidence, Linux CI evidence, final diff review, and an explicit accounting of skips.

- [ ] **Step 1: Run the complete native Windows suite**

Run:

```powershell
pnpm test
```

Expected:

- all unit tests pass;
- all platform-neutral PostgreSQL integration tests pass;
- the 21 named secure generated-staging success cases are skipped in addition to the three pre-existing explicit integration skips;
- no test reports `archive-entry-unsafe` as an unexpected failure.

Do not call this green if PostgreSQL setup fails, Docker is unavailable, or any integration file is skipped for a missing `TEST_DATABASE_URL`.

- [ ] **Step 2: Run repository checks**

Run:

```powershell
pnpm check
pnpm build
git diff --check
```

Expected: all commands exit zero. Existing line-ending warnings on unrelated dirty files may be reported separately but must not be introduced by this plan.

- [ ] **Step 3: Review the complete implementation diff**

Use the immutable design commit that immediately precedes this plan:

```powershell
git diff --stat 3430d3c..HEAD
git diff 3430d3c..HEAD -- services/api/src/archive-io.ts tests/unit/archive-io.test.ts tests/integration/campaign-archive.integration.test.ts tests/integration/gameplay.integration.test.ts scripts/ensure-test-database.mjs scripts/ensure-test-database.d.mts tests/unit/ensure-test-database.test.ts .github/workflows/ci.yml tests/unit/ci-workflow.test.ts
```

Confirm:

- no Windows staging fallback was added;
- only the 21 capability-dependent integration cases are gated;
- the Linux CI integration step has no embedded credentials;
- no API, schema, archive-format, or deployment manifest changed.

- [ ] **Step 4: Verify Linux execution in GitHub Actions**

After the branch is published through the repository's normal PR workflow, inspect the Ubuntu `Test PostgreSQL integration suite` step.

Required evidence:

```text
campaign-archive.integration.test.ts: secure generated-staging cases executed, zero skipped for platform
gameplay.integration.test.ts: portable campaign ZIP export executed
integration suite: zero failures
```

If the workflow fails, capture the exact failing test and logs. Do not mark Linux archive staging verified from the Windows skip result.

- [ ] **Step 5: Record final verification**

Report:

- Windows unit pass count;
- Windows integration pass and skip counts, distinguishing the 21 capability skips from the three pre-existing explicit skips;
- Linux CI integration pass count and confirmation that those 21 cases executed;
- `pnpm check`, `pnpm build`, and `git diff --check` results;
- current branch and final commit list;
- any remaining unrelated dirty files.

No final verification commit is required unless correcting documentation generated during implementation.
