# Provider failure diagnostics verification

Date: 2026-10-03. Implementation was authorized after the planning request and rebased onto `origin/main` `66a0deeb`. Tasks 1–5 were reviewed before Task 6 (base `1063b6d5`). No deployment, push, paid/live-provider request or shared database change was performed.

## Composed behavior

Real disposable pgvector PostgreSQL and a deterministic local HTTP provider exercise queued generation, HTTP 429 with rejected request ID/Retry-After, immutable physical completion, failed job, safe read/reload and explicit Retry. Append and replace_latest preserve exact accepted ledger, state, facts, Chronicle memories/jobs and cost totals on rejection. Each failure dispatches once; rejected IDs do not set response-start time. Explicit Retry uses a new logical/physical identity, replays the saved body and commits exactly one result. The original failed row remains unchanged. Foreign-owner reads fail; sibling campaign reload has no foreign evidence.

Nine negative fixtures cover missing/malformed/SSE/output/started/hash-mismatched/foreign-job/stale-logical/stale-claim proof. None dispatches another request after explicit Retry. A composed post-output SSE 429 retains HTTP 200, response start and output, preserves authority and never advances the preset. Existing physical-ledger/preset tests cover cancellation, stale lease, unknown dispatched reclaim and retained costs. Operator evidence remains bounded; public snapshots omit raw content, identity and counters.

Placement deviation approved by the controller: reuse `generation-response-contract-failures.integration.test.ts` for its existing full HTTP/worker/API harness, rather than duplicate hundreds of setup lines in the evidence-repository test. The evidence file from Task 3 is exercised unchanged; events/authority tests extend real read and reload boundaries.

## Discovered regressions and rulings

- Explicit Retry previously minted a logicalAttempt but retained a previous primary reservation, causing the worker to pause for interrupted-output review after a definitive rejection. The controller authorized a narrow transaction fix. It requires a schema-valid completed current invocation and matching owner/job/body/hash/physical attempt, failed non-2xx HTTP evidence, absent response start and no output. It re-arms the coarse reservation only on explicit Retry and keeps all immutable attempts and ambiguous fences. Both coarse `reserved` and `dispatched` states are accepted because v2 records dispatch in the durable invocation/physical ledger while the coarse reservation may remain reserved.
- Unknown newly captured evidence must not erase a precise existing schema classification. The classifier retains schema_invalid while retaining upstream reason unknown separately. A truncated stream without terminal completion now records ambiguous_transport; the prior unknown assertion was updated to the actual transport meaning.
- Keep the pure client-core boundary. `generationProviderFailurePresentation` takes explicit nowMs plus injected parseTimestamp/formatTimestamp functions; web-next owns Date/localization. No checker exemption, dependency or handwritten date parser was added.
- OpenRouter header-only attribution requires a verified OpenRouter endpoint. Explicit finite metadata can corroborate source. Provider names require invocation inventory corroboration; a failing body cannot certify itself. HTTP 429 alone and a later successful DeepInfra route establish no limiter.
- Official OpenRouter limits documentation supplies no numeric reset-header units. Numeric reset values remain null rather than guessed. Typed upstream metadata/provider_code can support source; raw provider codes/messages/remedy_hint/raw fields are not persisted.
- Strict persisted contract and tolerant optional public projection remain distinct. Derived retryAt and UTF-8 bounds are independently enforced. Malformed arrays/objects cannot coerce to source enums or survive fallback reconstruction.
- Optimized SQL public projections from main are preserved. Existing failure/read paths are reused; malformed optional evidence does not invalidate the whole snapshot. Automatic retries, new fallback routes, provider settings, prompts and historical backfill remain excluded.
- Final review minor resolved: fallback reconstruction passes the shared schema, using a safe current timestamp when timezone normalization expands the year. Real PostgreSQL completion/read coverage preserves original failure and readable evidence. Explicit Retry ledger assertions prove append adds exactly one accepted turn; replacement changes only its target and preserves prior turns and accepted count.

## Commands and results

All commands run from the managed worktree. Database commands use the ignored disposable wrapper, retain `tests/integration/setup-isolated-database.ts`, sequential files and 30-second hook/test timeouts. Credentials never appear in this report. The shared database had stale credentials; no shared credentials or volumes were modified.

Focused Tasks 1–5 command:

```powershell
corepack pnpm exec vitest run tests/unit/provider-failure-diagnostics.test.ts tests/unit/safe-generation-diagnostics.test.ts tests/unit/generation-review-contracts.test.ts tests/unit/provider-failure-capture.test.ts tests/unit/providers.test.ts tests/unit/provider-response-format.test.ts tests/unit/preset-route-execution.test.ts tests/unit/prepared-text-executor.test.ts tests/unit/generation-executor-adapter.test.ts tests/unit/server-security.test.ts tests/unit/client-core/generation-machine.test.ts tests/unit/client-core/generation-workflow.test.ts tests/unit/web-next-story-page.test.ts tests/unit/campaign-state-repository.test.ts tests/unit/client-core/campaign-store.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
```

Passed: 15 files, 533 tests, zero skips/failures. After the Date-adapter refinement, associated helper/UI/API suites are separately rerun below.

Initial composed RED: `run-integration.ps1 -TestPaths @('tests/integration/generation-response-contract-failures.integration.test.ts','-t','provider failure composes')` — two failed / 49 filtered; no second physical attempt after explicit Retry. Early fixture corrections fixed a nonexistent created_at/turn foreign-key assumption and stopped relying on attempt ordering. GREEN selected via `-t 'provider failure (composes|explicit|after)'`: 12 passed / 49 filtered, no failures. A mistaken anchored selector once skipped all 61 and is not counted as verification.

Integration command:

```powershell
& ./.superpowers/sdd/2026-10-03-provider-failure-evidence-plan/run-integration.ps1 -TestPaths @('tests/integration/provider-failure-diagnostics.integration.test.ts','tests/integration/generation-response-contract-failures.integration.test.ts','tests/integration/generation-events.integration.test.ts','tests/integration/campaign-authority-repository.integration.test.ts','tests/integration/generation-repository.integration.test.ts','tests/integration/preset-generation-workflow.integration.test.ts','tests/integration/authoring-stage-execution.integration.test.ts','tests/integration/campaign-cast-discovery.integration.test.ts','tests/integration/image-pipeline.integration.test.ts')
```

First run: 268 passed, four failed, 14 skipped (9 files). Failures were two historical fallback fixtures without definitive HTTP proof, a migration watermark missing 0114 and a read-count assertion not accounting for the added reload GET. Fixtures now provide real typed HTTP evidence without relaxing conservative production behavior; the migration watermark and read count are updated. The 14 image artifact cases require secure generated staging unavailable on Windows and remain skipped, not passed. Final amended-suite results follow.

Amended-suite command uses the same wrapper with `generation-response-contract-failures`, `generation-events`, `preset-generation-workflow` and `campaign-cast-discovery` paths above: four files / 128 tests passed, zero failures/skips. Together with the five unchanged successful files from the first run, all 272 executable cases passed; 14 platform skips remain. Associated time-adapter/helper/UI/API command `corepack pnpm exec vitest run tests/unit/safe-generation-diagnostics.test.ts tests/unit/web-next-story-page.test.ts tests/unit/client-api-routes.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'`: three files / 161 tests passed, no skips.

```powershell
& ./.superpowers/sdd/2026-10-03-provider-failure-evidence-plan/run-integration.ps1 -TestPaths @('tests/integration/generation-response-contract-failures.integration.test.ts','tests/integration/generation-events.integration.test.ts','tests/integration/preset-generation-workflow.integration.test.ts','tests/integration/campaign-cast-discovery.integration.test.ts')
```

Full unit first run: `corepack pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'` — 4811 passed, two failed, 49 skipped, plus web-build suite setup failure; 365 passed / 3 failed files. The nested build subprocess found pnpm 11.15.1, the retry row mock lacked selected orchestrationPrivate, and a compile-fixture test timed out during simultaneous heavy gates. Correct the process PATH and run heavy gates sequentially; no timeout contract is widened.

Pinned full gates use:

```powershell
$env:PATH=(Resolve-Path .superpowers/sdd/2026-10-03-provider-failure-evidence-plan/bin).Path+';'+$env:PATH
corepack pnpm exec pnpm --version # must print 12.4.1
corepack pnpm check
corepack pnpm build
corepack pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'
git diff --check
```

Initial check failed on client-core Date use and build was consequently not run. Final gates are recorded after the injected time adapter correction.

Final `corepack pnpm check` and `corepack pnpm build` passed, exit 0; process nested pnpm reported 12.4.1. Build retains the existing Vite chunk-size warning. Expected logs include synthetic rejection/provider-cap evidence, security-route request/error logs, Node localstorage-file and NO_COLOR/FORCE_COLOR notices, and Windows Git CRLF normalization notices. These are not failures.

Final sequential full-unit gate with the pinned PATH: 368 files passed; 4818 tests passed, 44 platform skips, zero failures. The 44 existing skips require Linux/POSIX permissions or secure generated archive filesystem staging unavailable on Windows. The earlier additional five skips were the failed web-build suite setup and all five passed in this final run. `git diff --check` passed. Local link check: 27 Markdown targets across seven changed documents resolve. Complete owned diff was self-reviewed; no unrelated product changes or secret artifacts were added.

## Self-contained reproduction after scratch cleanup

Historical commands above describe the completed runs. This PowerShell recipe replaces the ignored wrapper/config and pnpm shim. Run from the repository with dependencies installed and Docker available. It creates a unique, loopback-only disposable database with trust authentication, retains per-file isolation and removes only its own resources. It never reads the earlier scratch URL. The final fix used the existing wrapper; this replacement recipe has been reviewed but has not been executed as another database run.

```powershell
$ErrorActionPreference = 'Stop'
$taskRoot = (Get-Location).Path
$taskId = [Guid]::NewGuid().ToString('N')
$taskContainer = "iq-provider-review-$taskId"
$taskConfig = Join-Path $taskRoot "vitest.provider-review-$taskId.config.ts"
$taskBin = Join-Path ([IO.Path]::GetTempPath()) "iq-provider-review-$taskId"
$taskPreviousPath = $env:PATH
$taskPreviousDatabase = $env:TEST_DATABASE_URL
try {
  New-Item -ItemType Directory -Path $taskBin | Out-Null
  Set-Content -LiteralPath (Join-Path $taskBin 'pnpm.cmd') -Value '@corepack pnpm %*'
  $env:PATH = "$taskBin;$taskPreviousPath"
  corepack pnpm exec pnpm --version # must print 12.4.1, pinned by package.json
  if ($LASTEXITCODE -ne 0) { throw 'Pinned pnpm unavailable' }
  @'
import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["tests/integration/**/*.test.ts"],
  setupFiles: ["tests/integration/setup-isolated-database.ts"],
  testTimeout: 30000, hookTimeout: 30000, fileParallelism: false,
  sequence: { hooks: "stack" }
} });
'@ | Set-Content -LiteralPath $taskConfig
  docker run --detach --name $taskContainer --publish 127.0.0.1::5432 `
    --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB=infinitequest `
    pgvector/pgvector:0.8.6-pg18-trixie | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Disposable database creation failed' }
  $taskReady = $false
  for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
    docker exec $taskContainer pg_isready -U postgres -d infinitequest *> $null
    if ($LASTEXITCODE -eq 0) { $taskReady = $true; break }
    Start-Sleep -Seconds 1
  }
  if (!$taskReady) { throw 'Disposable database did not become ready' }
  $taskPort = (docker port $taskContainer 5432/tcp).Split(':')[-1]
  $env:TEST_DATABASE_URL = "postgresql://postgres@127.0.0.1:$taskPort/infinitequest"
  corepack pnpm exec vitest run --config $taskConfig `
    tests/integration/provider-failure-diagnostics.integration.test.ts `
    tests/integration/generation-response-contract-failures.integration.test.ts
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL suites failed' }
  corepack pnpm check
  if ($LASTEXITCODE -ne 0) { throw 'Repository/type checks failed' }
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw 'Diff check failed' }
} finally {
  $env:PATH = $taskPreviousPath
  $env:TEST_DATABASE_URL = $taskPreviousDatabase
  docker rm --force $taskContainer *> $null # exact unique container only
  if (Test-Path -LiteralPath $taskConfig) { Remove-Item -LiteralPath $taskConfig }
  $taskShim = Join-Path $taskBin 'pnpm.cmd'
  if (Test-Path -LiteralPath $taskShim) { Remove-Item -LiteralPath $taskShim }
  if (Test-Path -LiteralPath $taskBin) { Remove-Item -LiteralPath $taskBin } # empty; no recursive deletion
}
```

Final review fix verification: the expanded-year repository regression first failed with null diagnostic evidence (seven passed, one failed). After shared-schema fallback validation and full-ledger retry assertions, both affected PostgreSQL files passed: 69 tests, zero failures/skips. Pinned `corepack pnpm check` passed. No broad unit/build rerun was needed for these narrow changes; the earlier full gate and accepted platform/live-provider/CI limitations remain as recorded.

## Browser evidence

```powershell
$env:NODE_OPTIONS='--import tsx'
$env:PLAYWRIGHT_LEGACY_PORT='43283'
$env:PLAYWRIGHT_WEB_NEXT_PORT='43284'
corepack pnpm exec playwright test tests/e2e/generation-integrity-diagnostics.e2e.test.ts --grep 'provider failure'
```

Passed: two Chromium cases with local API fixtures, initial live stream failure and reload, one explicit Retry POST each, no console/page errors or private canaries. These verify rendered client behavior, not a live provider or deployed topology. Future timing uses an intentional fixed 2099 fixture; elapsed timing uses 2020. No request occurs from time passage/read/reload. All eight images were visually inspected: limiter/timing precede context warnings, mobile wraps and Retry/Discard remain readable.

The same browser command passed again after the time adapter correction (two passed, zero failed/skipped). Historical desktop.png/mobile.png captures already tracked before Task 6 are retained; this report references only the eight new known/unknown live/reload captures.

| Evidence | Desktop 1440×1000 | Mobile 390×844 |
| --- | --- | --- |
| Known upstream live | [desktop](assets/provider-failure-diagnostics/upstream_provider-live-desktop.png) | [mobile](assets/provider-failure-diagnostics/upstream_provider-live-mobile.png) |
| Known upstream reload | [desktop](assets/provider-failure-diagnostics/upstream_provider-reload-desktop.png) | [mobile](assets/provider-failure-diagnostics/upstream_provider-reload-mobile.png) |
| Unknown source live | [desktop](assets/provider-failure-diagnostics/unknown-live-desktop.png) | [mobile](assets/provider-failure-diagnostics/unknown-live-mobile.png) |
| Unknown source reload | [desktop](assets/provider-failure-diagnostics/unknown-reload-desktop.png) | [mobile](assets/provider-failure-diagnostics/unknown-reload-mobile.png) |

## Limits

No CI, production PostgreSQL, deployment/rollback drill, live upstream limiter identification or paid-provider quality check was performed. A production failure can identify a limiter only when its metadata supports it. Platform-skipped image staging and full integration coverage outside the selected suites remain unverified. Rollout is an operator action using the [runbook](../runbooks/provider-failure-diagnostics.md); retain captured data on rollback.
