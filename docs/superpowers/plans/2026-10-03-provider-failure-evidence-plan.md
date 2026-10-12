# Provider Failure Evidence and Safe Retry Guidance Implementation Plan

> **Execution status:** The subsequent user request authorized subagent-driven implementation. Tasks 1–6 are implemented; Tasks 1–5 reviewed and Task 6 selected verification passed. Final branch review and rollout remain separate. The original planning request alone did not authorize implementation. [Verification](../../review/provider-failure-diagnostics-verification.md) records platform skips and the deferred minor.

**Goal:** Preserve enough safe upstream evidence to diagnose rate-limit failures and show accurate retry guidance without introducing duplicate provider dispatches.

**Architecture:** Extract typed evidence at the HTTP/SSE boundary, persist it atomically on physical attempts, and project a restricted view through the existing generation diagnostic path. Fix response-start classification independently of provider response IDs. Keep remote preset routing and explicit Retry semantics unchanged.

**Tech Stack:** TypeScript, Zod, PostgreSQL/pgvector, node-pg-migrate, Vitest, Playwright, existing DOM-based Story UI; pnpm 12.4.1 via Corepack.

**Spec:** [Provider failure evidence and safe retry guidance design](2026-10-03-provider-failure-evidence-design.md). Read it before any task; its limits, vocabulary, copy, and exclusions are normative.

## Workspace and baseline

- Worktree: `C:\Users\chris\.codex\worktrees\provider-failure-diagnostics\InfiniteQuest`.
- Branch: `codex/provider-failure-diagnostics-plan`.
- Original planning base: `30a884a1` (Error Diagnostic). Implementation base after rebase: `origin/main` `66a0deeb`.
- The original deliverables were planning-only; subsequent authorization enabled application, additive migration, tests and operations documentation.
- Implementation installed frozen dependencies with pnpm 12.4.1 and retained the lockfile. Final commands and baseline discrepancies are recorded in [verification](../../review/provider-failure-diagnostics-verification.md).

## Global Constraints

- Every dispatched physical attempt remains immutable in identity and is never reused for another send.
- New Story presets keep one `@preset/<slug>` candidate and leave provider/model fallback to OpenRouter.
- No automatic resend, added background traffic, key rotation, route-policy override, prompt change, or historical-job backfill.
- Raw provider messages/bodies, prompts, secrets and unrestricted headers never enter the new diagnostic, public API, or logs.
- Capture only the design's finite vocabulary and numeric/date fields; maximum diagnostic size is 4096 UTF-8 bytes and maximum retained retry delay is 86400000 ms.
- Preserve owner/campaign scoping, leases, cancellation, deadlines, reported usage/cost, and independent illustration behavior.
- Legacy index.html requires no parity edits; target the current Story surface.
- Database schema is additive; no accepted turn, campaign state, Chronicle memory, import, or provider configuration is rewritten.
- Review associated tests for every changed file. Report skipped/failed checks distinctly; no live-provider or deployed claim from mocks.

## Review Focus

1. HTTP 429 with a generation ID and no successful headers must not masquerade as a started stream (Tasks 2, 4).
2. HTTP 200 with SSE error 429 after a chunk must remain terminal and retain the original partial-output/usage evidence (Tasks 2, 4, 6).
3. Malformed JSON, malicious metadata, date overflow, and unsupported reset units must retain minimal safe evidence without exposing content (Tasks 1, 2, 6).
4. Crash/reclaim and stale claims must not overwrite completed evidence, dispatch again, or attribute another campaign's failure (Tasks 3, 6).
5. Older API/client snapshots, late SSE updates, reloads, and clock changes must not hide a known failure or invent retry authority (Tasks 5, 6).

## Task 1: Define bounded evidence and public projection

**Files**
- Create: `packages/contracts/src/provider-failure.ts`.
- Modify: `packages/contracts/src/index.ts`, `packages/contracts/src/generation-review.ts`.
- Create tests: `tests/unit/provider-failure-diagnostics.test.ts`.
- Extend tests: `tests/unit/safe-generation-diagnostics.test.ts`, `tests/unit/generation-review-contracts.test.ts`.

**Interfaces**
- Produce `providerFailureEvidenceSchema`, `ProviderFailureEvidenceV1` as defined by the spec.
- Produce `providerFailureProjectionSchema`, `ProviderFailureProjectionV1` containing version, source, httpStatus, upstreamStatus, reason, limitSource, retryAfterMs, retryAt only.
- Produce `projectProviderFailureEvidence(value: unknown): ProviderFailureEvidenceV1 | null` and `projectProviderFailure(value: unknown): ProviderFailureProjectionV1 | null`.
- Existing `GenerationFailureDiagnostic` and its public projection gain optional `providerFailure`; absent evidence preserves old behavior.

- [x] Run baseline: `corepack pnpm exec vitest run tests/unit/preset-route-execution.test.ts tests/unit/prepared-text-executor.test.ts tests/unit/provider-response-format.test.ts tests/unit/safe-generation-diagnostics.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'`. Record counts and any failures before editing.
- [x] Write failing tests: valid rate-limit evidence round-trips; unknown keys never project; unknown version returns null; nested raw/secret/prompt canaries are absent; 24h is accepted and overflow is rejected; existing timeout/empty-output messages remain unchanged. Example: `expect(JSON.stringify(projectProviderFailure(evidenceWithPrivateCanary))).not.toContain('PRIVATE_CANARY')` and expect the exact safe status/source/retry fields.
- [x] Run those three contract test files and confirm the new tests fail for missing behavior.
- [x] Implement strict schemas, finite enums and explicit field projection. Extend generation diagnostics without requiring a new field on old jobs or replacing the generic public error envelope.
- [x] Rerun contract tests and `corepack pnpm exec tsc -p tsconfig.json --noEmit`; expect zero failures.
- [x] Commit this boundary independently: `Define bounded provider failure evidence`.

## Task 2: Capture evidence at the real HTTP and SSE seams

**Files**
- Create: `packages/story-engine/src/provider-failure-diagnostics.ts`.
- Modify: `packages/story-engine/src/providers.ts`, `packages/story-engine/src/provider-response-format.ts`.
- Extend: `tests/unit/providers.test.ts`, `tests/unit/provider-response-format.test.ts`.
- Create: `tests/unit/provider-failure-capture.test.ts`.

**Interfaces**
- Consume Task 1 schemas.
- Produce `captureProviderFailure(input: { source: ProviderFailureEvidenceV1['source']; httpStatus: number | null; headers: Headers | null; body: unknown; bodyStatus: 'parsed' | 'absent' | 'malformed' | 'oversized'; observedAt: Date; knownProviderNames: readonly string[]; successfulResponseStarted: boolean; emittedOutput: boolean; isOpenRouter?: boolean }): ProviderFailureEvidenceV1`. Endpoint verification gates OpenRouter header-only attribution.
- Add explicit `providerFailure?: ProviderFailureEvidenceV1` to ProviderHttpError and PreparedResponseContractError; preserve it through wrapping.
- Use explicit successful-response/output evidence rather than interpreting responseId.

- [x] Write deterministic fetch/stream tests at the production adapter: HTTP 429 with x-generation-id, metadata and Retry-After; non-JSON/empty/oversized error body; 401, 402, 403, 404, 503; HTTP 200 SSE error before and after output; stream interruption; absent and unknown metadata. Assert existing payload/usage/partial-output/format diagnostics are unchanged.
- [x] Pin both Retry-After forms and unsupported numeric OpenRouter reset values in tests. Official documentation supplies no numeric reset units, so retain null rather than guess. Use a fixed clock; verify negative/NaN/>24h values become null and no raw header is copied.
- [x] Run `corepack pnpm exec vitest run tests/unit/provider-failure-capture.test.ts tests/unit/providers.test.ts tests/unit/provider-response-format.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'`; confirm new capture assertions fail.
- [x] Implement capture before HTTP or SSE errors are wrapped. Preserve minimal status/header data even if parsing fails. Only accept a provider name from knownProviderNames; keep unknown identity null. Numeric HTTP/SSE error status and recognized enum codes must be recorded without the raw message. Do not change network retry/fallback behavior in this task.
- [x] Rerun the command; verify byte-identical outbound requests and zero new network calls in failure tests.
- [x] Commit: `Capture safe upstream provider failure details`.

## Task 3: Persist immutable failure evidence on physical attempts

**Files**
- Create: `database/migrations/0114_provider_failure_diagnostics.sql` (use the next free number at execution; never renumber an already applied migration).
- Modify: `packages/database/src/prepared-text-attempt-repository.ts`, `packages/story-engine/src/preset-route-execution.ts` (types only in this task).
- Create: `tests/integration/provider-failure-diagnostics.integration.test.ts`.
- Review/extend: `tests/integration/migrations.integration.test.ts`, `tests/integration/preset-generation-workflow.integration.test.ts` and `packages/application/src/system-archives/portability-registry.ts`.

**Interfaces**
- Extend `PhysicalAttemptRecord` with nullable failureDiagnostic and database-derived responseStarted.
- Extend failed `PhysicalAttemptRepository.complete(...)` input with optional failureDiagnostic; retain succeeded input's exclusion of failure evidence.
- Add nullable `failure_diagnostic` column with object/version/size constraints; preserve all existing unique keys and ownership guards.

- [x] Write PostgreSQL tests proving completion stores evidence atomically, stale/foreign owner or lease updates fail, a repeated completion cannot replace first evidence, old null rows remain readable, and failure recording does not affect cost totals. Verify non-2xx response ID persists while response_started_at stays null.
- [x] Run the new integration file against an isolated test database and confirm missing-column/behavior failures.
- [x] Implement the additive migration and safe schema validation at the repository boundary. Update every SELECT/RETURNING path used by loadAttempt, reserve and complete to include response_started_at and failure_diagnostic. Use response_started_at, not identity fields, for record.responseStarted.
- [x] Keep operational classification of the attempt table; extend schema/portability coverage where introspection tracks columns. Never export the raw provider error body or promote operational evidence into portable campaign authority.
- [x] Run new integration, migrations, and preset-workflow suites with the dedicated integration configuration. Expect zero failed or skipped selected tests and unchanged uniqueness/idempotency behavior.
- [x] Commit: `Persist provider failure evidence on physical attempts`.

## Task 4: Correct response-start classification and propagate terminal evidence

**Files**
- Modify: `packages/story-engine/src/preset-route-execution.ts`, `services/runtime/src/prepared-text-executor.ts`, `services/runtime/src/generation-executor-adapter.ts`.
- Extend: `tests/unit/preset-route-execution.test.ts`, `tests/unit/prepared-text-executor.test.ts`, `tests/unit/generation-executor-adapter.test.ts`.

**Interfaces**
- `classifyPresetRouteFailure(error: unknown)` keeps current return fields and adds nullable providerFailure.
- `PreparedRouteTerminalError` carries sanitized providerFailure and physical attempt identity; preserve existing cause and physicalAccounting.
- Existing failureDiagnosticFor records optional providerFailure on the private generation diagnostic; existing job failure log emits the bounded operator fields from the spec.

- [x] Write failing tests for HTTP 429 + response ID + explicit no-success/no-output, HTTP 429 without ID, HTTP 200 SSE error, unknown transport outcome, and legacy error with ID but no trustworthy start evidence. Assert only definitive pre-output failures use existing eligible next-candidate rules.
- [x] Test a single remote preset: exactly one invocation and one terminal failure, including when Retry-After is present. Test an existing multi-candidate historical plan: its eligible next candidate may run, deadline/lease/cancellation rules still apply. No same-candidate replay.
- [x] Run the three unit files; confirm the ID/start regression fails before implementation.
- [x] Thread evidence from Task 2 through the executor into Task 3 completion and the terminal error. Make explicit successful response/output state monotonic. Treat missing legacy evidence conservatively. Preserve deadline precedence and existing transport, format, usage and cost handling.
- [x] Rerun unit files and Task 3 integration suite; assert rejected generations never call accepted-turn commit and no secrets appear in diagnostics or structured logs.
- [x] Commit: `Distinguish rejected requests from started provider responses`.

## Task 5: Project evidence consistently and display safe retry guidance

**Files**
- Modify as needed: `packages/contracts/src/generation.ts`, `packages/contracts/src/client-api.ts`, `services/api/src/server.ts`.
- Modify: `packages/database/src/generation-repository.ts`, `packages/database/src/campaign-state-repository.ts`.
- Modify: `packages/client-core/src/generation/projection.ts`, `packages/client-core/src/generation/machine.ts`, `packages/client-core/src/generation/workflow.ts`, `packages/client-core/src/campaign-store.ts`.
- Modify: `apps/web-next/src/story-player-view.ts`.
- Extend: `tests/unit/server-security.test.ts`, `tests/unit/safe-generation-diagnostics.test.ts`, `tests/unit/client-core/generation-machine.test.ts`, `tests/unit/client-core/generation-workflow.test.ts`, `tests/unit/web-next-story-page.test.ts`.

**Interfaces**
- Consume the existing failureDiagnostic.providerFailure projection; do not add a parallel top-level job field.
- Produce `generationProviderFailurePresentation(value: unknown, nowMs: number, time: { parseTimestamp(value: string): number; formatTimestamp(value: string): string }): { details: readonly string[]; retryAt: string | null } | null` in client-core projection.ts and export it via `packages/client-core/src/index.ts`. The browser supplies Date/localization; client-core remains pure.
- Clock is only for presentation. Retry eligibility and server authority stay unchanged.

- [x] Write failing API tests asserting identical safe evidence for GET/SSE/campaign reload, foreign-owner access denial, unknown-version graceful omission, and absence of all private canaries. Test diagnostic-only snapshot changes are observed; copy nested safe data rather than retaining mutable references.
- [x] Write UI tests using the exact spec copy for platform/upstream/unknown source, future/past retryAt and absent timing. Assert existing Retry/Discard controls remain usable and no fetch occurs just because a retry time passes.
- [x] Run the named unit suites and confirm missing details/copy/equality assertions fail.
- [x] Extend safe projection and snapshot propagation; update equality for every new public evidence field. Render the reason before context-omission details, with localized absolute retry time and textContent-based DOM construction. Do not add polling/countdown timers or disable Retry based on a browser clock.
- [x] Rerun unit suites and TypeScript checks; verify old snapshots still display existing fixed messages.
- [x] Commit: `Show provider limit source and suggested retry time`.

## Task 6: Verify the composed failure path and document operations

**Files**
- Extend: `tests/integration/provider-failure-diagnostics.integration.test.ts`, `tests/integration/generation-events.integration.test.ts`, `tests/integration/campaign-authority-repository.integration.test.ts`.
- Extend: `tests/e2e/generation-integrity-diagnostics.e2e.test.ts`.
- Update: `docs/nexus-guide/providers/health-and-errors.md`, `docs/runbooks/deployment.md`, `docs/architecture/0012-provider-transport-deadlines.md` (describe typed metadata, keep raw-body prohibition).
- Create: `docs/runbooks/provider-failure-diagnostics.md`, `docs/review/provider-failure-diagnostics-verification.md` and screenshots under `docs/review/assets/provider-failure-diagnostics/`.

- [x] Add a composed real-PostgreSQL + deterministic HTTP server test: generation -> HTTP 429 -> immutable physical evidence -> failed job -> safe API/reload. Assert provider request count 1, null result turn, unchanged accepted ledger/state/Chronicle, preserved costs and no cross-campaign evidence.
- [x] Cover append and replace_latest; replay a saved request after explicit user Retry through the existing workflow and prove a distinct logical/physical attempt and exactly one eventual commit. Cover abort/stale claim and post-output SSE rejection without additional provider dispatch.
- [x] Add browser checks for initial live failure and reload, desktop and 390x844 viewport, known/unknown source and retry timing, explicit Retry interaction, no console errors, no private canaries. Save and visually inspect screenshots.
- [x] Run applicable focused suites from Tasks 1-5 and the new composed tests. Then run `corepack pnpm check`, `corepack pnpm build`, and `git diff --check`. Run generation-events and isolation coverage; review shared executor impact with authoring-stage-execution, campaign-cast-discovery and image-pipeline integration suites because the same physical ledger serves them.
- [x] Document exact commands, pass/fail/skip counts and baseline discrepancies. On this machine the nested pnpm shim previously resolved v11 despite Corepack v12; fix the invocation environment or run documented constituent checks and report that the full wrapper was not verified. The shared integration database previously had stale credentials; use a disposable pgvector PostgreSQL instance and the repository per-file isolation setup, never change shared credentials/volumes.
- [x] Update operator documentation with a read-only owner/job-scoped SQL query selecting only safe diagnostic columns, timestamps and IDs. Include instructions to distinguish confirmed source from absent metadata and to correlate OpenRouter request IDs without submitting a new paid generation. Keep old evidence unknown; do not backfill guesses.
- [x] Record rollout order: backup; additive migration; compatible API/workers; frontend; naturally occurring failure/copy-campaign canary only when authorized; inspect safe evidence. Rollback keeps the nullable column and captured rows. No implementation task deploys automatically.
- [x] Commit: `Verify provider failure diagnostics and document operator workflow`.

## Verification commands and expectations

Use paths relative to this worktree. Focused Vitest commands must exclude `**/.worktrees/**` and `**/.codex/**`. Integration commands must use `--config vitest.integration.config.ts`; a bare Vitest success with skipped database tests is not a pass. A temporary disposable-database config must retain `tests/integration/setup-isolated-database.ts`, sequential test files, 30-second test/hook timeouts and cleanup.

Browser command: `corepack pnpm exec playwright test tests/e2e/generation-integrity-diagnostics.e2e.test.ts --grep 'provider failure'` after naming the new cases accordingly. On Windows this existing ESM source test file requires `$env:NODE_OPTIONS='--import tsx'` for its source imports; scope that environment setting to the test process. Browser plugin is not required for these repository Playwright tests.

Docs-only planning verification: local Markdown links resolve, all existing file references were checked, new files are marked Create, worktree base/branch verified, and `git diff --check` passes. Dependencies/application tests are intentionally deferred until implementation because this request changes only planning documents.

## Automatic retry follow-up decision (excluded from this implementation)

After new evidence identifies the limiter, decide whether automatic retries are useful. A separate design must freeze policy per job; define maximum dispatches and total wait; honor Retry-After without shortening it; add distinct durable per-candidate retry ordinals; gate dispatch on persisted definitive pre-output rejection; revalidate authority/lease/cancellation/deadline; sum all costs; and handle crash/reclaim without replaying ambiguous attempts. It must explicitly preserve remote preset routing and non-Story call budgets. A corrected response-start flag alone is not sufficient authorization for automatic replay. Do not activate this follow-up through a hidden environment default.

## Acceptance and handoff

- [x] Each failure carries recognized status/source/timing evidence or an explicit metadata-availability state.
- [x] No raw upstream content or credentials reach new storage/log/API fields.
- [x] HTTP rejection IDs and successful response start are separate facts in runtime and database readers.
- [x] Existing current Story preset failures still issue one request; automatic retry remains out of scope.
- [x] Safe guidance works live and after reload, without changing retry authority.
- [x] Composed PostgreSQL, isolation, browser and compatibility checks pass with evidence; rollout remains an operator action.

Self-review: Tasks 1-2 cover data bounds and extraction; Tasks 3-4 cover durable lifecycle and retry classification; Task 5 covers all public/read paths; Task 6 covers composed integrity, operations and rollback. All five Review Focus cases have assigned tests. No subagent was used to author or review this plan.

Execution recommendation: implement natively in dependency order 1 -> 2 -> 3 -> 4 -> 5 -> 6; these tasks share one evidence contract and the change is narrow enough to benefit from continuity. Review the completed branch independently before publishing. If the user prefers subagent-driven execution, retain the same task interfaces and gates.
