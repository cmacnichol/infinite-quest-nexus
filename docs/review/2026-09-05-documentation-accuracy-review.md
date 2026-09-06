# Repository documentation accuracy review — 2026-09-05

> Pre-correction review snapshot. See the [subsequent documentation correction pass](./2026-09-05-documentation-corrections.md) for updated guidance and the remaining implementation/design follow-ups. The findings and verification results below describe the original reviewed tree.

## Result

The repository cannot be certified as fully current and accurate. This review found eleven actionable documentation or documentation-verification issues, including a failing documentation build and a conflict between the documented illustration acceptance boundary and the streaming implementation.

Application source, configuration, tests, and existing documentation were not edited. This report is the only authored repository addition. Build commands regenerated ignored build output. No commit, deployment, provider request, production database operation, or documentation correction was performed.

## Review baseline and method

- Checkout: `C:\Git\InfiniteQuest`.
- HEAD: `3489aaaf1ed4fe1a9142f56ec03fdaa5cd7ce255`.
- Scope: current working tree, including the existing local documentation changes, rather than HEAD alone.
- Existing tracked modifications: `.claude/CLAUDE.md`, `AGENTS.md`, `docs/architecture/index.md`, `docs/concepts/identity-and-ownership.md`, and `docs/workflows/testing.md`.
- Existing untracked files: `AGENTS_BACKUP.md`, `docs/architecture/scene-context-mechanics-review.md`, and the two September 5 prompt-memory remediation plan/spec files.
- The documentation inventory contained 247 tracked or non-ignored untracked Markdown pages under `docs/`, before this report. Two ignored local notes were excluded from that count.
- RepoWise was consulted for orientation. Its index reported commit `ffd2e0d3c7e8`, five days old and behind HEAD. Its generated overview also contained inconsistent size figures and an unusable module description. Findings below rely on live source and executable evidence, not its generated assertions. The index was not modified.
- Reviewed the repository rules, documentation checklist, README, domain vocabulary, architecture overview, capabilities, configuration, deployment and recovery guidance, provider/Chronicle/Story guides, and relevant implementation paths. Ran documentation compilation/link validation, static checks, application compilation, unit tests, manifest validation, and a reproduction of an unsafe verification claim.
- Scanned the documentation corpus for literal source references and configuration coverage. Missing paths in dated plans and historical audits were treated as historical evidence, not automatically as current defects.

This is a repository-wide documentation audit with targeted source tracing. It is not a claim that every sentence, every function, every external link, or every user interaction has been independently proven. The limitations below are part of the result, not passed checks.

## Findings

### D01 — P1: Current documentation cannot build

**Evidence:** `pnpm --filter @infinite-quest/docs build` exited 1 with exactly two reported dead links:

- `docs/concepts/identity-and-ownership.md:15` links to `../../database/migrations/0001_initial_nexus.sql`.
- `docs/architecture/scene-context-mechanics-review.md:5` links to `../../AGENTS.md`.

Both targets exist in the repository, but they are outside the VitePress documentation source and are not valid generated site pages. VitePress reported the second target as `./../../AGENTS` after Markdown URL normalization. Both links belong to pre-existing local edits, so this finding applies to this working tree; it does not establish that the committed or deployed site currently fails.

**Impact:** the documentation build used by `.github/workflows/docs.yml` cannot publish this tree.

**Correction:** use repository source URLs for non-site files, or link to the corresponding published conceptual guidance. Preserve dead-link enforcement and rerun the documentation build.

### D02 — P1: Illustration acceptance timing has an unresolved contract conflict

**Documentation:** `docs/concepts/illustration-pipeline.md:3` describes illustration work as post-acceptance; its sequence diagram commits the turn before claiming image work. `docs/concepts/generation-integrity.md:26` says the optional image job starts only after story commitment. The provider image guide and image recovery guide repeat this model.

**Implementation:** `services/runtime/src/generation-executor-adapter.ts:846` extracts partial streamed narration and creates provisional illustration sets and segments before final acceptance. `services/runtime/src/illustration-segment-job-adapter.ts:297` strips mechanics from the segment; its direct mode queues a `streaming_illustration` image job around line 336. ADR `0025-streaming-illustration-pipeline.md` explicitly accepts pre-commit image work and subsequent promotion.

**Impact:** the published lifecycle omits a real execution path, while the repository's generation-integrity instructions also require a validation boundary. Segment sanitization is not evidence of final-turn acceptance. This review does not assert that an actual rejected segment reached a live provider; no provider experiment was performed.

**Correction:** explicitly reconcile ADR 0025, the current instructions, and the intended validation boundary. Document provisional creation, allowed dispatch timing, failure cleanup, and promotion. Do not simply weaken mechanics or acceptance safeguards to make documentation match the implementation.

### D03 — P2: Storage and reset guidance omit persistent archive and encryption-key volumes

**Documentation:** `docs/installation/storage.md:3` says Compose uses two named volumes and lists only PostgreSQL and assets. `docs/operations/compose/storage.md` describes only those stores; `docs/operations/compose/reset.md` describes deletion primarily in terms of the database and assets.

**Implementation:** `compose.yaml:48` mounts `infinitequest-secrets`; lines 49–51 mount `infinitequest-archives`; lines 67–71 declare four volumes. The application bootstrap stores the generated credential-encryption key in the secrets volume.

**Impact:** operators do not receive a complete persistence inventory. Resetting with `down --volumes` also destroys the local encryption key and durable archive staging/download state. The backup guide correctly requires separate key escrow, but the storage guide does not identify its actual default location.

**Correction:** document all four volumes, their container paths, retention and reset effects, and the distinction between authoritative recovery data and operational archive artifacts.

### D04 — P2: System Archive release/default status contradicts the runtime

**Documentation:** `docs/player-guide/saving-and-exporting.md:22` calls System Archive planned-release and disabled by default. `docs/nexus-guide/campaigns/import-export.md:48` says a normal installation cannot use it behind a default-off gate. `docs/runbooks/deployment.md:34` says root Compose remains false-by-default.

**Implementation:** `packages/database/src/config.ts:232` defaults `SYSTEM_ARCHIVE_ENABLED` to true. `compose.yaml:37` also defaults to true. The base Swarm stack explicitly sets false. The environment-configuration and System data transfer pages already describe this distinction correctly.

**Impact:** users and operators are told the released Compose feature is unavailable, and may incorrectly assume its routes are withdrawn.

**Correction:** align all entry-point guides to enabled direct runtime/single-node Compose versus disabled base Swarm. Keep empty-destination and storage requirements intact.

### D05 — P2: Chronicle rollout instructions conflict with new-campaign defaults

**Documentation:** `docs/runbooks/deployment.md:68` calls chunked retrieval explicit opt-in; line 75 calls legacy hybrid with shadow disabled the default; line 87 says not to convert newly created campaigns automatically.

**Implementation:** `packages/database/src/world-repository.ts:1220` inserts new campaign embedding configuration with `retrieval_implementation='chunked_hybrid'` and `retrieval_shadow_enabled=true`. `docs/nexus-guide/chronicle/retrieval-modes.md:7` already documents that behavior.

**Impact:** an operator following the rollout guide may assume newly created campaigns require a separate production opt-in when they already select chunked retrieval, subject to its readiness fallback.

**Correction:** distinguish historical rollout instructions, unchanged existing campaigns, and current new-campaign creation defaults. Reconcile the semantic-configuration procedure with that distinction.

### D06 — P2: Sogni setup guidance does not distinguish the two shipped adapters

**Documentation:** `docs/nexus-guide/providers/sogni.md` presents one Sogni workflow using bearer-authenticated creative workflows and a 180-second default/600-second maximum generation deadline. The installation provider page likewise describes creative-workflow routes. No Sogni SDK setup guidance was found in the active provider, installation, or capabilities sections.

**Implementation:** `packages/contracts/src/generation.ts:5` exposes both `sogni` and `sogni_sdk`. `apps/web/public/nexus.js:4627` distinguishes Sogni Creative Workflow from Sogni Supernet SDK. `services/runtime/src/illustration-platform-adapter.ts:88` gives SDK jobs a 600-second default and 3,600-second maximum, versus 180/600 seconds for the creative-workflow adapter. ADR 0022 records the separate SDK provider.

**Impact:** the guide is ambiguous for a real provider choice and its limits do not apply to both adapters.

**Correction:** provide separate adapter setup and recovery instructions, with exact UI names and adapter-specific model, credential, deadline, and remote-job behavior. External vendor endpoint/pricing claims still require separate live verification.

### D07 — P2: Security guidance misstates the active CSP

**Documentation:** `docs/operations/security.md:15` says the current CSP is permissive for provider and image connectivity.

**Implementation:** `packages/security/src/content-security-policy.ts:4` uses `default-src 'none'`; line 8 restricts connections to `'self'`. Images allow self/data/blob plus explicitly configured origins. `services/api/src/request-security.ts:24` applies the generated header.

**Impact:** the operating model incorrectly implies browser connectivity to inference providers is broadly permitted. Provider network requests are server-side, and the image-origin policy is explicit.

**Correction:** describe the actual connection and image directives while retaining the trusted-network and pre-authentication limitations. A stricter CSP does not establish authentication or a complete security audit.

### D08 — P2: A documented integration command can succeed while skipping database verification

**Documentation:** `docs/workflows/testing.md:56` runs generation and image integration files directly without `--config vitest.integration.config.ts`.

**Implementation:** the dedicated integration config installs `ensure-test-database.setup.ts` and per-file isolation. `tests/integration/generation.integration.test.ts:46` and the corresponding image test select `describe.skip` when `TEST_DATABASE_URL` is absent. The guide's prerequisite mentions the variable, but the command does not provide the self-provisioning behavior advertised for the normal test workflow.

**Reproduction:** with `TEST_DATABASE_URL` unset, invoked the same two root test files through the installed Vitest entry point, excluding nested worktrees. Exit status was 0: **1 test passed, 71 skipped; 1 file passed, 1 skipped**. This is not PostgreSQL verification.

**Correction:** document the integration config or the isolated integration runner, including how targeted files are selected. Make skipped database tests an explicit non-pass condition for release verification.

### D09 — P2: The normal unit command discovers nested worktrees

**Evidence:** `package.json` runs `vitest run tests/unit` without a root-only include configuration or worktree exclusion. The initial documented `pnpm test:unit` command ran tests from `.worktrees/campaign-export-delete`, `.worktrees/campaign-startup-fix`, and `.worktrees/nexus-prompt-memory-remediation`, among others. Output included failures in those other revisions. The run was interrupted rather than attributed to this checkout.

**Impact:** in this repository layout the documented command does not isolate the revision being verified, adds substantial duplicate work, and can report unrelated failures.

**Controlled verification:** `pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**' --reporter=dot` passed all 233 executed test files: **2,739 passed, 44 skipped**.

**Correction:** constrain unit discovery to the root suite and document the worktree behavior. This requires a test-runner/configuration change, not a claim that the unmodified command passed. CI without nested worktrees may not reproduce this local issue.

### D10 — P3: Development requirements pin an obsolete pnpm version

**Documentation:** `README.md:93` and `docs/installation/requirements.md:16` specify pnpm 11.14.0.

**Implementation:** `package.json:6`, `Dockerfile:4`, and the CI/documentation workflows pin 11.24.0.

**Correction:** align the contributor requirements with the package-manager declaration and deployment tooling. This review verified repository consistency, not upstream release availability.

### D11 — P3: Runtime configuration coverage omits world sharing

**Evidence:** `.env.example:28` exposes `WORLD_SHARING_ENABLED=false`; `compose.yaml` and the Swarm API environment pass the flag. `packages/database/src/config.ts:251` reads it and `services/api/src/server.ts:926` onward conditionally exposes sharing operations. No mention of the flag was found in the active installation, operating, concept, architecture, or user guides scanned for environment-setting coverage. `ASSET_STORAGE_DRIVER` is also absent, although its filesystem-only implementation makes that a smaller omission.

**Impact:** the claimed runtime-setting reference does not explain a gate that changes the available API surface.

**Correction:** document the default, affected operations, restart/deployment behavior, and sharing authority boundary. Do not imply that enabling sharing adds interactive authentication.

## Verification record

| Check | Result | What it establishes |
| --- | --- | --- |
| `pnpm check` | Passed | Repository/data boundaries, package and application type/static checks. Boundary tool reported 1,243 candidate files. |
| `pnpm build` | Passed | Service and both web application builds complete. Vite emitted a non-fatal large-chunk warning. |
| `pnpm --filter @infinite-quest/docs build` | Failed | Two dead links in pre-existing local documentation edits; see D01. |
| Unmodified `pnpm test:unit` | Interrupted | Nested worktree discovery makes this unsuitable as current-checkout evidence; see D09. |
| Unit suite with explicit nested-worktree exclusions | Passed with skips | 233 files passed; 2,739 tests passed, 44 skipped. Skips include Windows-inapplicable POSIX/Linux and secure filesystem capability cases; skipped cases were not verified. |
| Documented direct integration selection with no database variable | Demonstrated false-success risk | Exit 0, 1 passed, 71 skipped. No real PostgreSQL claim. |
| `docker-compose config --quiet` | Passed | Local manifest renders. The `docker compose` plugin was unavailable through the restricted CLI configuration, so the installed standalone Compose binary was used. |
| `docker stack config -c deploy/swarm/stack.yaml` | Passed | Base Swarm manifest renders. No Swarm deployment was started. |
| `git diff --check` before report creation | Passed | Existing tracked diff has no whitespace errors. |

Docker commands warned that the user's Docker configuration file was inaccessible. Successful manifest rendering does not prove daemon access, container startup, shared filesystem behavior, or readiness.

## Coverage and remaining uncertainty

| Area | Review coverage | Limits |
| --- | --- | --- |
| Documentation site and references | Enumerated current documentation; exercised VitePress link/build validation; scanned source references. | Build stops on the two links. External links, published deployment status, full rendered accessibility, and every anchor were not independently checked. |
| Setup, storage, operations | Compared README/guides with package scripts, runtime configuration, Compose, Swarm, migration setup, and recovery guidance. | No deployment, upgrade, rollback, reset, or Restore Drill executed. |
| Identity, worlds, campaigns, portability | Checked terminology, bootstrap, owner resolution guidance, creation defaults, transfer/import documentation, and relevant source references. | Unit evidence is not real PostgreSQL isolation or archive round-trip proof. |
| Story, mechanics, Chronicle, illustrations | Traced prompt budget handling, safe continuity handling, streaming image creation, retrieval defaults, and provider distinctions. | No paid/live generation or embedding calls; no full adversarial integrity audit. |
| UI and user procedures | Compared guide labels and available provider/application surfaces with current source and build output. | No rendered browser walkthrough, mobile/accessibility audit, or screenshot evidence. |
| Tests and build tooling | Executed static checks, builds, root-scoped unit suite, and integration-skip reproduction. | Full PostgreSQL integration, browser E2E, Linux-specific filesystem checks, container image build, and live provider suites not run. |
| Historical plans, ADRs, prior reviews | Classified dated material separately; checked concrete conflicts with current claims. | Dated implementation plans are not completion evidence. Old file paths alone were not promoted to defects. |

The dated UI feature matrix, for example, says import progress is an in-memory map (`docs/ui/FEATURE_IMPLEMENTATION_MATRIX.md:37`), while current composition wires `createPostgresImportProgressRepository` (`services/runtime/src/api-portable-import-export-composition.ts:220`). That is a reason to mark or retain the matrix as historical, not to treat its old implementation assessment as current. Similarly, ADRs and target-architecture statements need explicit supersession where accepted decisions conflict; their age alone does not make them invalid.

The pending `scene-context-mechanics-review.md` correctly says tracker routing has not been verified by that note. Current source distinguishes safe fiction-only continuity from private mechanics. This review does not convert that open question into an unsupported claim that all trackers leak or that all privacy boundaries have passed.

## Recommended correction order

1. Repair the two site links and rerun documentation compilation.
2. Resolve the illustration lifecycle contract conflict, preserving the required validation boundary.
3. Correct storage/reset effects, System Archive defaults, and Chronicle new-campaign behavior across all entry-point guides.
4. Split Sogni guidance, correct the CSP description, and document the sharing flag.
5. Repair test discovery and integration-command guidance, then update pnpm requirements.
6. After corrections, rerun the relevant checks and perform disposable PostgreSQL/browser/deployment verification before claiming end-to-end accuracy.

The passing application checks do not remove the documentation findings or certify the unexecuted operating procedures.
