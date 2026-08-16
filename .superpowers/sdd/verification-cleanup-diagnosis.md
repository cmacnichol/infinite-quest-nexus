# Verification Cleanup Diagnosis

Date: 2026-08-16
Workspace: `C:\Users\chris\.codex\worktrees\2c9d\InfiniteQuest`
Phase: diagnosis captured before cleanup implementation

## Reproduced failures

### Repository boundaries

Command:

```powershell
pnpm check
```

The command stopped in `check:repository` with exactly three findings:

```text
packages/domain/src/legacy-campaign-normalization.ts: legacy client compatibility must remain inside the reviewed migration boundary
packages/application/src/turn-corrections/types.ts: application import ../../../contracts/src/turn-corrections.js is outside packages/application or contracts
packages/application/src/turn-corrections/use-cases.ts: application import ../../../contracts/src/turn-corrections.js is outside packages/application or contracts
```

#### Legacy campaign normalization

Classification: **incorrect test/checker expectation**.

`scripts/check-repository-boundaries.mjs` treats every active file containing `LegacyStory` as compatibility code and requires an exact entry in `LEGACY_MIGRATION_ALLOWLIST`. The approved parity plan explicitly names `packages/domain/src/legacy-campaign-normalization.ts` as the pure legacy conversion boundary, but the allowlist was not updated when that file was added. The normalizer's own unit suite passes; this is not compatibility leakage.

Smallest safe repair:

- add only `packages/domain/src/legacy-campaign-normalization.ts` to the exact allowlist;
- add an executed guard regression proving that this path is accepted while an unreviewed active path containing the same marker remains rejected;
- keep the marker and stale-entry enforcement intact.

#### Turn corrections

Classification: **code defect** (two files, one architectural root cause).

`packages/application` may import contracts only through `@infinite-quest/contracts`. The package already declares that workspace dependency and `packages/contracts/src/index.ts` exports the turn-correction contract. The two deep relative imports bypass the public package boundary; `node scripts/check-client-boundaries.mjs` independently reproduces only those two violations.

Smallest safe repair:

- replace both deep relative specifiers with `@infinite-quest/contracts`;
- retain the existing client-boundary rule that rejects deep cross-package imports;
- run the turn-correction application unit suite and application typecheck.

### Windows child-process runners

#### TypeScript fixture runner

Classification: **runner defect**.

`tests/unit/client-boundaries.test.ts` calls `execFileSync("pnpm", ...)`. On this Windows/Node 24 host the four compiler-fixture cases fail because the child process never starts:

```text
code: ENOENT
syscall: spawnSync pnpm
stdout: ""
stderr: ""
```

Changing the executable to `pnpm.cmd` is not sufficient: direct Node execution of the command shim fails with `EINVAL`. Running the repository-local TypeScript CLI through `process.execPath` does execute both the accepted and rejected fixtures and preserves their real diagnostics.

Smallest safe repair: resolve `typescript/package.json`, invoke its `bin/tsc` with `process.execPath`, and retain combined stdout/stderr plus the spawn error message.

#### Isolated PostgreSQL integration runner

Classification: **runner defect**.

Command:

```powershell
pnpm test:integration
```

The first isolated file never starts:

```text
[integration 1/65] tests/integration/admission-control.integration.test.ts
Error: spawn EINVAL
errno: -4071
syscall: spawn
```

`scripts/run-isolated-integration.mjs` selects `pnpm.cmd` on Windows and passes it directly to `spawn`, which Node 24 does not treat as a native executable. The e8/e3f isolated runners repeat the same pattern.

Smallest safe repair:

- resolve `vitest/package.json` and execute `vitest.mjs` with `process.execPath`;
- preserve one Vitest process per integration file;
- give the shared runner an executed command-shape regression;
- update the e8/e3f runner family to use the same shell-free JS entrypoint, not `shell: true`.

### Secure filesystem platform failures

Classification: **unsupported-platform contract**, with an **incorrect test harness expectation** in unrelated API tests.

The production adapter deliberately rejects every non-Linux host before constructing descriptor-anchored storage:

```text
filesystem_platform_unsupported
```

This is required by the documented `/proc/self/fd`, `O_NOFOLLOW`, and retained-directory-anchor security design. Native Windows must not gain a path-only fallback.

Representative direct PostgreSQL command:

```powershell
.\node_modules\.bin\vitest.cmd run --config vitest.integration.config.ts tests/integration/task-14e3b5-storage-composition.integration.test.ts
```

PostgreSQL was provisioned and migrations `0001` through `0075` completed. All seven cases then failed at `services/runtime/src/secure-filesystem-adapter.ts` with `filesystem_platform_unsupported`, proving the database path is healthy and the failure is the intentional host capability boundary.

`pnpm test:unit` also shows two distinct groups:

1. Tests that directly exercise the Linux descriptor adapter (`/proc/self/fd`) must be explicitly capability-gated on unsupported hosts and remain mandatory in Linux Docker/CI.
2. Route, profile, and security tests that are not testing storage currently compose the production secure filesystem unnecessarily; these should inject an inert, closeable storage/application composition so their actual HTTP behavior continues to run on Windows.

Smallest safe repair:

- use the existing production-owned Linux capability predicate for explicit skips of only successful descriptor-backed suites;
- retain and execute fail-closed unsupported-platform assertions on Windows;
- add optional composition factories to the server boundary and have the shared API test helper inject complete inert asset/portable compositions;
- do not blanket-skip API tests, integration files, or database coverage;
- retain Linux CI/Docker as the proof for every secure-filesystem success path.

## Repair verification matrix

- `pnpm check`
- focused legacy-normalization and turn-correction tests
- focused client-boundary and isolated-runner unit tests
- `pnpm test:unit`
- direct real-PostgreSQL platform-neutral integration files through the repaired isolated runner
- native Windows secure-filesystem suites with named capability skips and fail-closed tests still executing
- Linux Docker/CI required for positive `/proc/self/fd` success-path proof
- `pnpm build`
- `git diff --check`

## Residuals discovered during implementation verification

The first repairs made the broad runners executable on Windows, which exposed
additional failures that had previously been hidden behind the runner and
storage-composition setup errors.

### Generation output-limit classification

Classification: **code defect**.

When a provider returned truncated JSON with a length/output-limit finish, the
executor classified the failure as `invalid_json` and attempted compact JSON
recovery. Output-limited incomplete content is already a retry boundary and
must remain distinguishable from malformed complete output. The smallest safe
repair is to persist/log `output_limit`, skip same-attempt compact recovery,
and retain the authoritative ledger unchanged for the explicit retry.

### Historical migration downgrade fixtures

Classification: **incorrect test expectation**.

The generation-events, 14e2c adapter, and normalized-publication downgrade
fixtures migrated isolated databases through irreversible migrations 0071–0075
before testing historical down paths. They therefore failed at 0075 rather
than reaching the migration under test. The safe repair is to bound initial
migration at the historical ceiling (`0069_import_progress_status`) and then
exercise the existing down/up assertions. Current-schema migration coverage
continues independently through 0075.

### Portable expiry timing

Classification: **incorrect test expectation**.

The portable repository tests waited only against the Node clock, while the
repository authoritatively compares expiry with PostgreSQL `clock_timestamp()`.
Short TTLs could therefore be expired in the application process but not yet
expired in the database. Polling both clocks against the persisted row is the
smallest deterministic repair; write-once expiry authority remains unchanged.

### Benchmark and API route harnesses

Classification: **incorrect test harness expectation**.

The play-loop benchmark and world-campaign route suite constructed production
secure storage even though their platform-neutral cases do not exercise it.
The benchmark now supplies local fail-fast inert asset/portable compositions.
The route suite uses the shared inert composition on unsupported platforms,
while its one genuine portable-storage case remains capability-gated and uses
the production composition on Linux.

### Descriptor-backed integration matrices

Classification: **unsupported-platform contract**.

The full wrapper revealed more positive-path composition matrices whose every
failure originated at `filesystem_platform_unsupported`: asset publication,
portable normalized publication, illustration publication, metadata backfill,
filesystem recovery, maintenance scheduling, and production-composed parity.
Whole-file gates are used only where every case constructs the Linux
descriptor-backed graph. Mixed files gate only the secure cases and continue
to execute their database/repository/HTTP assertions on Windows.

### Credential ACL, source inventory, and character dialog fixtures

Classification: **incorrect platform/test expectation**.

- Random credential-key generation is portable; the `0600` mode assertion is
  POSIX-specific and is now a separately capability-gated assertion.
- Runtime source-inventory tests converted file URLs by reading `.pathname`,
  which produces a leading-slash Windows path. `fileURLToPath` and normalized
  separators preserve the same inventory assertion cross-platform.
- The character dialog fixture selected the first generic `dialog` rather than
  `.character-prompt-dialog` and stubbed one instance even though the native
  methods are resolved through the element prototype. The repaired fixture
  targets the production dialog and validates both native and fallback focus,
  inert-background, and cleanup behavior.
