# Dead and Unneeded Code Audit

Audited 2026-09-30. Target: `b982a0a5f2dbad8f0c18741fcf3522446929859f` in `C:\Git\InfiniteQuest`. The working tree was clean at the start. Application code, tests, manifests, migrations, and deployment configuration were not changed. This report is the only intended repository change.

## 1. Executive Summary

The production tree has modest local dead-code residue, rather than evidence of large abandoned production subsystems. Confirmed candidates comprise 11 private callables and four private constants/schema aliases across 13 files: 82 declaration lines measured from their source spans. Unused imports offer additional small cleanup. Exported symbols with no identified consumers are reported separately because barrel exports and externally imported interfaces prevent unconditional removal claims.

The highest-value safe work is deleting unused private helpers and removing unused type imports. Next, move two test/build dependencies out of the production dependency set. Four active duplication groups merit consolidation review, especially identical response-format eligibility and provider-request conversion routines.

Large historical code does exist: root `index.html` is about 10,839 lines, and five `tests/legacy-api/src` files total about 4,207 lines. Neither is included in the safe deletion estimate. Repository instructions explicitly retain the former for reference; the latter still supplies regression consumers. Both active browser applications and compatibility readers remain required.

The principal risk is confusing source age, default-disabled gates, identical-looking serialization, or absent browser consumers with proof of obsolescence. In particular, deleting historical prompt readers or changing hash preimages could invalidate durable queued work. No API route, migration, worker lane, or entire production module is recommended for unconditional removal.

## 2. Architecture Observed

| Component | Entry points and loading | Consequence for this audit |
| --- | --- | --- |
| Runtime | `services/runtime/src/main.ts`; `package.json` dev/start; `Dockerfile` CMD; explicit `all`, `api`, `worker`, `migrate` role dispatch | Composition adapters are architecture seams, even when single-use. |
| API | `services/api/src/server.ts`, explicit Fastify registrations and route modules | Registered routes are live interfaces; lack of an internal client does not establish lack of external clients. |
| Worker | `services/worker/src/worker.ts`, runtime-injected generation, illustration, Chronicle, maintenance, System Archive, authoring, and cast applications | Optional job lanes are reached through injected application objects and feature gates. |
| Browser clients | Legacy Vite entries `legacy-client-entry.ts` and `legacy-management-entry.ts`; replacement `apps/web-next/src/bootstrap.ts` and route-selected mounts | `/nexus/`, `/story`, and `/app/` coexist. Public files are copied by Vite; HTML URLs and dynamic browser imports also count as consumers. |
| Shared code | ESM `.js` specifiers resolve to TypeScript sources; workspace package exports and extensive `export *` barrels | An exported declaration with no named import is an investigation lead, not proof that its interface can disappear. |
| Persistence | PostgreSQL repositories; `packages/database/src/migrate-cli.ts`; SQL migration directory loaded by `node-pg-migrate` | Migration files are directory-discovered and preserve fresh-install and upgrade behavior. |
| Tools/tests/docs | Root scripts; direct `tsx`/Node CLI commands; Vitest discovery and integration setup; Playwright configurations; VitePress and Mermaid | Scripts and fixtures need no production inbound import to be useful. Documentation has its own build and CI job. |
| Deployment | One Docker image; Compose combined role; Swarm API/worker roles; readiness/shutdown and secret-file configuration | Runtime dependency and flag decisions must account for both topologies. |

Architecture references: [repository overview](../architecture/repository-overview.md), [modular boundaries ADR](../architecture/0028-modular-client-and-application-boundaries.md), [deployment runbook](../runbooks/deployment.md), and [test matrix](../workflows/testing.md).

### Investigation method and limits

Inventoried 2,012 tracked files and parsed all 1,128 tracked JavaScript/TypeScript source/declaration files using the installed Babel parser with TypeScript/JSX support and recovery mode. Recovery mode tolerates syntactic constructs rejected by a strict initial parse; this was an inventory, not a substitute for compiler validation. Searched relative module paths, string references, manifests, HTML assets, CLI scripts, CI, deployment configuration, route registration, worker composition, and test consumers. Compared function bodies after whitespace normalization to locate exact-body duplication, then read the relevant implementations and types.

Ran the normal repository check and additional TypeScript `noUnusedLocals`/`noUnusedParameters` probes. Private removal candidates below have compiler-level unused-binding evidence plus source inspection: they are not exported, returned as callbacks, registered dynamically, or passed to collaborators. Their bodies execute only if called. This is stronger than a global name search alone.

The root diagnostic graph includes tests and imported shared modules but excludes portions of the replacement UI by configuration; its entry graph was checked separately. No installed analyzer, runtime tracing, production access-log review, browser exercise, database query, migration, deployment, or live provider request was used. Public API retirement and runtime-specific reachability remain limited by that absence of evidence. No code was deleted to test a proposed removal.

## 3. High-Confidence Removal Candidates

Line references below refer to the audited revision. Each listed symbol is independently reviewable. All private declarations here are compiler-confirmed unused; delete only the named declarations, preserving adjacent live implementations.

### DEAD-001 — Authoring repository residue

**Location:** `packages/database/src/authoring-job-repository.ts:514,557,633`

**Symbol:** `listItem`, `STAGE_RETURNING`, `claimParameters`

**Category:** Dead private functions and SQL constant

**Evidence:** Unused-binding diagnostics for all three. `listItem` builds a detail-derived list projection, but the active list path uses `metadataListItem`; stage queries use the live select/projection strings. The nested `claimParameters` function is never called or returned.

**Replacement:** Existing `metadataListItem`, live SQL projections, and active claim parameter construction.

**Risk:** Low

**Recommended Action:** Remove these three declarations.

**Expected Impact:** Remove 17 declaration lines and an obsolete alternative projection/claim helper.

### DEAD-002 — Unused Chronicle transaction cast

**Location:** `packages/database/src/chronicle-chunk-repository.ts:137`

**Symbol:** `transactionClient`

**Category:** Dead private helper

**Evidence:** Compiler confirms no read of this local function. Its only behavior is validating/casting its argument; no module initialization behavior is involved. Other repositories' identically named helpers are live and are outside this finding.

**Replacement:** None needed by this module.

**Risk:** Low

**Recommended Action:** Remove this declaration only.

**Expected Impact:** Five lines removed.

### DEAD-003 — Retired local-clock lease classifier

**Location:** `packages/database/src/durable-filesystem-repository.ts:368`

**Symbol:** `claimClassification`

**Category:** Obsolete private helper

**Evidence:** Compiler confirms unused. The helper combines identity checks with `Date.now()`. Live operations instead call `claimIdentityClassification` and `operationAuthorityIsFresh`, whose SQL uses PostgreSQL `clock_timestamp()`; live sites include lines 547–548 and 599–600.

**Replacement:** Existing identity check plus database-clock freshness check.

**Risk:** Low for deleting this helper; high for altering live lease policy.

**Recommended Action:** Delete only `claimClassification`.

**Expected Impact:** Six lines and a misleading competing clock policy removed.

### DEAD-004 — Unused portable-import helpers

**Location:** `packages/database/src/portable-import-family-repository.ts:911`; `services/runtime/src/portable-import-export-composition.ts:996`

**Symbol:** `portableRecord`; `isLegacyExternalImageUrl`

**Category:** Dead private validation helpers

**Evidence:** Both are compiler-confirmed unused and have no export/registration path. A different `portableRecord` in the runtime composition remains used; the URL helper's dead status does not retire external-image import support.

**Replacement:** Keep current import validation, companion-key handling, and the live runtime `portableRecord`.

**Risk:** Low

**Recommended Action:** Remove these two declarations only.

**Expected Impact:** Fourteen lines removed.

### DEAD-005 — Unused illustration helpers

**Location:** `services/runtime/src/illustration-image-job-adapter.ts:873`; `services/runtime/src/illustration-platform-adapter.ts:369`

**Symbol:** `withoutTemporaryUrls`; `notFound`

**Category:** Dead private helpers

**Evidence:** Compiler confirms neither function is read. `withoutTemporaryUrls` is an uncalled recursive sanitizer at the end of its module; `notFound` is an uncalled error constructor. Other sanitization and error-projection paths remain live.

**Replacement:** None needed for these declarations.

**Risk:** Low

**Recommended Action:** Remove only the unused declarations; retain provider metadata redaction and publication checks.

**Expected Impact:** Thirteen lines removed and one misleading dormant sanitizer eliminated.

### DEAD-006 — Unused pointer encoder

**Location:** `packages/domain/src/world-fiction-reference.ts:35`

**Symbol:** `escapePointer`

**Category:** Dead private helper

**Evidence:** Compiler confirms unused. Actual entity/relationship source paths use their fixed collection name and numeric index, rather than this encoder.

**Replacement:** Existing source-path construction.

**Risk:** Low

**Recommended Action:** Remove the helper.

**Expected Impact:** One declaration line removed.

### DEAD-007 — Uncalled provider error wrapper

**Location:** `services/runtime/src/provider-world-generation-adapter.ts:344`

**Symbol:** `callGeneratedWorldProvider`

**Category:** Dead pass-through wrapper

**Evidence:** Compiler confirms unused. This private wrapper invokes a callback and translates an error; it is not the live provider dispatch entry. Exported `generatedWorldProviderError` has real consumers and tests.

**Replacement:** Keep the current execution paths and shared error projector.

**Risk:** Low

**Recommended Action:** Remove the wrapper, not the error projector.

**Expected Impact:** Nine lines removed.

### DEAD-008 — Unused checkpoint closure and private constants

**Location:** `packages/database/src/generation-execution-repository.ts:366`; `packages/contracts/src/client-api.ts:30`; `packages/contracts/src/prompt-library.ts:302`; `packages/story-engine/src/openrouter-presets.ts:8`

**Symbol:** `pendingFor`, `operationKindSchema`, `generatedWorldCharacterSeedRequirements`, `MAX_CONFIG_DEPTH`

**Category:** Dead private closure, schema alias, prompt text, and constant

**Evidence:** Compiler confirms all four unused. Creating `pendingFor` does not execute its body. `operationKindSchema` only reads an existing schema field. The prompt literal and numeric constant have no effects. Active checkpoint validation still uses `completedFor`; live prompt templates and preset limits remain independent.

**Replacement:** Existing active validation/templates/limits.

**Risk:** Low

**Recommended Action:** Remove these declarations. Do not infer that preset depth is enforced by `MAX_CONFIG_DEPTH`: it currently is not consumed.

**Expected Impact:** Seventeen declaration lines removed.

### DEAD-009 — Unused import bindings

**Location/Symbol:** Full production diagnostic inventory in Appendix A, including `GenerationResponseFormatProjection` in `packages/client-core/src/generation/projection.ts:10`, `GenerationSubmissionInput` in `workflow.ts:8`, and unused imported types in database/runtime adapters.

**Category:** Unused imports

**Evidence:** Compiler binding analysis rather than name-only search.

**Replacement:** None for unused type bindings.

**Risk:** Low for type-only imports; Medium for removal of the last runtime import from a module.

**Recommended Action:** Remove unused type import specifiers. Remove unused value specifiers while preserving any still-needed module evaluation; inspect the last runtime import before dropping its whole declaration. Do not delete the exported schemas themselves merely because a particular import is unused.

**Expected Impact:** Less stale coupling and clearer actual dependencies; exact import-line savings depend on shared declarations.

## 4. Medium-Confidence Candidates

### DEAD-010 — Unconsumed eager Data Transfer singleton

**Location:** `apps/web-next/src/data-transfer-api.ts:406`

**Symbol:** `dataTransferApi`

**Category:** Unused exported instance

**Evidence:** AST and source searches found only the declaration. `data-transfer-page.ts:272` creates its injected/default API with `createDataTransferApi`; tests call the factory too. The singleton nevertheless evaluates that factory at import time, resolving `fetch` and reading `localStorage`.

**Replacement:** `createDataTransferApi` remains canonical.

**Risk:** Medium

**Recommended Action:** Verify there is no external module importer relying on the export or initialization, then remove only the singleton.

**Expected Impact:** Avoids an unnecessary eager allocation/storage read; no whole file removal.

**Before removal:** Run Data Transfer tests and browser upload/resume/import/export flows with restricted storage.

### DEAD-011 — Unconsumed exported wrappers and types

**Location/Symbol:** `canonicalPortableAssetReservationCommand` in `packages/application/src/imports/private-portable-composition.ts:73`; `readSceneCoverageReplayCheckpoint` in `packages/contracts/src/generation-response-contract.ts:468`; `validateSourceWorldProposal` in `packages/domain/src/source-world-proposal.ts:222`; `characterTextFromSnapshot` in `packages/domain/src/world-characters.ts:147`.

**Category:** Apparently unused exports; speculative abstraction

**Evidence:** Each name occurred only at its declaration in the source inventory and targeted repository search. The first two wrap serialization/schema parsing. Source authoring actively uses `assembleSourceWorldProposalWithEvidence` and `validateSourceWorldSelection`. Barrels expose contract symbols and types; external consumption is not disproven.

**Replacement:** Existing schema/factory/use-case paths; preserve the checkpoint schema and validated current source-authoring path.

**Risk:** Medium

**Recommended Action:** Confirm export consumers and desired contract coverage before removing individual exports.

**Expected Impact:** Four small functions potentially removable; measured deletion is deferred.

**Before removal:** Audit package namespace consumers and external scripts; verify retained source-authoring validation. An unused validation function does not prove its intended invariant is obsolete.

Related exported type leads include deprecated `AssetIdempotencyKey` (`packages/application/src/assets/types.ts:37`, replacement `AssetMutationIdempotencyKey`), `TurnAssetScope`, `WorldVersionAssetScope`, `IllustrationPromptSnapshotPort`, and several `GenerationContext*` aliases. These are compile-time interfaces, not runtime dead code. Keep live schemas and `MemoryGenerationAuthorityContext`; confirm package-interface policy before pruning aliases. Likewise, historical protocol constants without named consumers are not evidence that corresponding durable protocol readers can disappear.

### DEAD-012 — Dependencies placed in the production set

**Location:** Root `package.json:42,45`

**Symbol:** `@types/archiver`, `jszip`

**Category:** Dependency classification cleanup

**Evidence:** `@types/archiver` supplies compile-time declarations. npm `jszip` import consumers are tests; production archive code uses `archiver` and `unzipper`. The browser's checked-in `apps/web/public/jszip.min.js` is a separate asset, not a runtime npm import. Docker builds before pruning production dependencies.

**Replacement:** Move both to `devDependencies`; retain browser asset and test imports.

**Risk:** Medium until the pruned image is verified.

**Recommended Action:** Relocate, not uninstall.

**Expected Impact:** Smaller production dependency installation; byte savings unmeasured.

**Before removal from production set:** Frozen-lockfile installation, both web builds, archive tests, and pruned-container export/import smoke.

### DEAD-013 — Unread fixed runtime configuration member

**Location:** `packages/database/src/config.ts:51,256`

**Symbol:** `RuntimeConfig.assetStorageDriver`

**Category:** Unused configuration member

**Evidence:** Production occurrences are the type member and fixed assignment `"filesystem"`; other occurrences are test/benchmark fixture construction. No active configuration consumer was found. This is not an unused environment variable.

**Replacement:** None required by current runtime config consumers; persisted asset `storage_driver` remains essential.

**Risk:** Medium

**Recommended Action:** Verify operator/tooling use of the config object, then remove the redundant member and update fixtures together.

**Expected Impact:** Smaller config contract and less misleading extensibility.

**Before removal:** Config tests, runtime-role startup coverage, and build checks. Do not remove asset storage drivers from archive/database contracts.

## 5. Needs Verification

| Lead | Evidence and missing proof | Recommendation |
| --- | --- | --- |
| Profile API aliases, `services/api/src/server.ts:756–768` | GET aliases and PUT/PATCH variants share profile helpers. Both checked-in clients update through PATCH `/api/v1/users/me/profile`. Registered aliases remain externally callable; production access logs and consumer inventory were not available. | Retain until external-use/deprecation policy is established. Consolidate implementation if useful without removing routes. |
| Root `index.html` | Not copied into the application image; `/` and `/index.html` redirect to Nexus. ADR 0020 and repository instructions explicitly retain it as historical source. | Exclude from executable cleanup; retirement requires changing the retention decision. |
| `tests/legacy-api/src/*` | Production authorities moved out of API. Five files remain imported by archive, import, prompt, and legacy regression tests. Boundary guards explicitly permit historical test oracles and reject retired production authorities. | Map each test to replacement-path coverage before retiring any oracle. Their age alone is insufficient. |
| Historical v1/v2/v3/v4/v5 reader/response paths | Durable jobs, saved chains, archive formats, and rollback readers select behavior from persisted discriminants, not merely current default flags. | Inspect queued/recoverable job populations and supported rollback/import policy before retirement. No database inspection occurred here. |
| Native/Web Awesome renderer coexistence | `VITE_UI_COMPONENTS` is consumed; accepted Web Awesome ADR retains the native rollback path and requires separately approved retirement. | Retain both paths and vendor package. |
| Unused evaluated values | `entityMetadata` (`generation-execution-repository.ts:1807`), `extensionSentFactIds` (`generation-executor-adapter.ts:4129`), unused test setup results | Binding unused does not establish that computation, validation, database writes, exceptions, or effects can disappear. | Inspect initializer effects before deletion; preserve calls if their effect matters. |

The compiler also reports unused parameters in functions implementing ports or callbacks. Remove parameter names or prefixes only where that preserves signatures; do not infer that the whole port or its argument semantics are dead.

## 6. Duplicate or Redundant Implementations

All groups below have active consumers. They are consolidation opportunities, not safe deletions of functionality.

| Group | Canonical implementation | Redundant implementation / differences | Consumers and approach |
| --- | --- | --- | --- |
| DUP-001: Response-format eligibility | Shared policy in `packages/application/src/providers/response-format.ts` | `resolveResponseFormatEligibility:22` and `resolveResponseFormatEligibilityV2:67` have identical bodies. Inputs/outputs differ by protocol and operation types. | Runtime capability resolver calls both; v2 tests check exact tuple behavior. Factor only the common internal policy, retain both typed/versioned entry points and historical evidence semantics. |
| DUP-002: Canonical JSON | One contract-local implementation could become canonical; none is currently established | Identical bodies at `generation-response-contract.ts:41`, `provider-output-schema.ts:175`, `text-execution-plan.ts:64`; another equivalent-shaped pair at `continuity-review-execution.ts:61` and `story-memory-policy.ts:170`. | Frozen contracts/plans/policy hashing. Consolidate exact preimage behavior only, with golden hashes and key-order cases. Domain `stableStringify` is **not** interchangeable: it filters undefined fields and uses locale comparison. |
| DUP-003: Turn-input guard | Shared story-input policy after confirming package dependency boundaries | `services/api/src/turn-input-safety.ts:3` and private `safeTurnInput` in `services/runtime/src/generation-executor-adapter.ts:833` have identical bodies. | API enqueue/retry and worker execution. Share the implementation but keep enforcement at both untrusted boundaries; preserve exact error shape and mechanics sanitization. |
| DUP-004: Provider request conversion | A shared provider-layer conversion is the prospective canonical location | `canonicalRequest` in `packages/story-engine/src/providers.ts:1063` and `services/runtime/src/prepared-text-executor.ts:25` have identical bodies. | Checked serialization and prepared execution. Consolidate conversion while preserving fields, optional-field omission, callbacks, and frozen contract binding. |

Smaller UI duplication includes byte/version formatting in Data Transfer versus legacy Nexus, character-pointer checks, dirty guards, and labelled controls in creation/editor pages. No canonical implementation is established. These copies have real per-page and per-client consumers; consolidate only small stable policies that measurably reduce maintenance. Do not introduce a general UI abstraction for a few short helpers.

Private filesystem/import modules also repeat descriptor/lease/snapshot helper bodies. These operate within distinct authority scopes and types. Treat them as lower-priority review leads; a generic abstraction that erases scope distinctions could cost more than the duplication.

## 7. Unnecessary Complexity

1. Remove the unused pass-through wrapper in DEAD-007 rather than replacing it with another abstraction.
2. DEAD-010's eager singleton duplicates the factory's role. The mounted page already owns API construction/injection; removing the unused instance preserves that lifecycle after import-time behavior is verified.
3. `readSceneCoverageReplayCheckpoint` and `canonicalPortableAssetReservationCommand` in DEAD-011 add only parsing/renaming to existing operations and currently have no identified caller. Individual deletion is preferable to inventing another interface, subject to export review.
4. DEAD-013 advertises a runtime storage choice that is fixed and unread. Removing the member would clarify the actual configuration without changing persisted driver semantics.
5. Do not flatten application ports or runtime composition merely because an adapter is instantiated once. Those seams isolate persistence, ownership, providers, transactions, retries, and worker/API topology as required by the accepted architecture.

## 8. Dependency Cleanup

Every root and workspace direct dependency was checked against source, scripts/configuration, build commands, tests, or framework loading. No dependency is proven completely uninstallable.

| Dependency | Current Purpose | Evidence of Usage | Confidence | Recommendation |
| --- | --- | --- | --- | --- |
| `jszip` | Test ZIP generation/inspection | Imports in ten tracked test source files; separate checked-in browser bundle | High: test use; Medium: production-set removal | Move npm package to dev dependencies; keep test package and browser bundle. |
| `@types/archiver` | Archive build declarations | Type resolution for `archiver`; build precedes Docker prune | High | Move to dev dependencies; verify pruned image. |
| `archiver`, `unzipper` | Streaming archive output/input | `services/api/src/archive-io.ts`, runtime portable import | High | Keep. |
| `photoswipe` | Legacy image viewer assets | Fastify `/vendor/photoswipe/`; CSS links; dynamic imports in `image-library-browser.js` | High | Keep; import-only analysis would misclassify it. |
| `pino`, `pino-pretty` | Structured logging/dev transport | Logger creates Pino; string-based `target: "pino-pretty"` | High | Keep. Moving pretty transport requires a separate supported-runtime decision. |
| `node-pg-migrate`, `pg` | Migrations/database | Migration runner, pool, notifications, test provisioning | High | Keep. |
| `@fastify/static`, `@fastify/multipart`, `fastify` | HTTP, static and upload support | API registrations and test server | High | Keep. |
| `@sogni-ai/sogni-client`, `sharp`, `undici` | Optional provider SDK, image processing, network transport | SDK adapter; image normalization/publication; provider transport/downloads | High | Keep; optional feature use still counts. |
| `sentence-splitter`, `zod` | Narration processing and boundary validation | Narration formatting and shared contracts/adapters | High | Keep. |
| `@awesome.me/webawesome`, `vite` | Replacement controls and both browser builds | Explicit control/assets imports; Vite configuration; build/dev commands | High | Keep both renderers and builders. |
| `mermaid`, `vitepress-plugin-mermaid`, `vitepress` | Documentation diagrams/site | `withMermaid` config, fenced diagrams, docs scripts/CI | High | Keep. Mermaid need not have a direct application import. |
| `@babel/parser`, `typescript`, `tsx` | Boundary analysis, compilation, CLI/test tooling | Guard scripts; compiler/check commands; CLI entry points | High | Keep. |
| `ajv`, `linkedom`, `vitest`, `@playwright/test` | Contract probes, DOM tests, unit/integration/browser tests | Probe/evaluation code, mocks, configurations and suites | High | Keep. |
| `@types/node`, `@types/pg`, `@types/unzipper` | Type declarations | Compiler type discovery and corresponding modules | High | Keep as development dependencies. |
| Workspace application/client/contracts packages | Shared policies and boundary contracts | Relative source imports plus workspace package exports | High | Keep; package-name import counts alone undercount use. |

## 9. Configuration and Feature Flag Cleanup

DEAD-013 is the clearest configuration cleanup lead. No unused environment variable was confirmed. Each root `.env.example` key had a corresponding literal in relevant code, scripts, or deployment inventory; that check is an orientation aid, not proof of runtime consumption. Archive setting names and secret `_FILE` variants are constructed dynamically and cannot be judged by direct `process.env.KEY` searches alone.

Retain `AI_AUTHORING_JOBS_ENABLED`, `AI_STORY_SOURCE_AUTHORING_ENABLED`, `NATIVE_TEXT_EXECUTION_PLAN_ADMISSION`, cast gates, sharing gates, history coverage, and Story Memory capability controls. They have configuration/compose/runtime consumers and serve rollout or compatibility purposes. Default `false` is not permanent unreachability.

Retain `SYSTEM_ARCHIVE_ENABLED`: Compose defaults it on; base Swarm forces it off because node-local files may not be shared across roles. The validation override supports a reviewed same-node drill. This is a topology constraint, not dead feature infrastructure.

One high-confidence stale tooling entry is `scripts/check-repository-boundaries.mjs:65`: the network allowlist still names nonexistent `apps/web/public/story.js`. The active Story module is `apps/web/src/story.js`, loaded by the Vite legacy entry. The guard keys its allowlist against inventoried source paths; this old row cannot match an existing file. Remove that row and verify boundary tests/checks; do not weaken the active guard or add a replacement exemption without proving it is needed.

## 10. Test Cleanup

No whole test file is recommended for unconditional deletion. Compiler diagnostics identify 77 entries outside `apps`, `packages`, and `services`, primarily test imports/locals plus one script parameter. Safe cleanup starts with unused type import bindings, not removal of test bodies or setup calls.

Examples: stale imports in `tests/unit/chronicle-runtime-adapter.test.ts`; unused `CorpusScenario`/`CapturedDispatch` types and import bindings in `tests/integration/story-continuity-review.integration.test.ts`; unused imports in source-authoring, campaign transfer, and provider route suites. Preserve fixture calls whose returned binding is unused but whose write/setup effect is essential.

The five legacy API files still have active test consumers. Useful migration work would first map each old assertion to current application/repository/composed behavior and then replace the old test dependency where equivalent coverage exists. Pure assertions against old implementations alone do not prove current behavior, but do not establish that their regression intent can be discarded either.

Cross-client tests and unit-versus-PostgreSQL tests are not redundant merely because they exercise the same feature: they establish distinct browser/transport/state-integrity evidence.

## 11. Documentation and Comment Cleanup

Confirmed stale current inventory: `docs/architecture/repository-overview.md:65` lists `demo_version.html`; the tracked inventory and working tree have no such file. Remove or qualify that entry as historical, then check documentation links/build.

Do not treat every old ADR baseline as current operating guidance. ADR 0028 records the historical 350 ms SSE polling loop and its intended replacement; current runtime uses event-source composition. Preserve the historical context, clarifying current status only where wording misleads operators. ADR 0020 predates `/app/` coexistence; cross-reference the current overview rather than deleting the accepted decision to retire root `index.html` as a runtime artifact.

The `LEGACY_STORY_PROMPT_PROTOCOL_VERSION` and `PREVIOUS_STORY_PROMPT_PROTOCOL_VERSION` comments describe retained durable identities. Lack of current named consumers does not establish that supported historical wire values, templates, or readers should be removed. Do not combine protocol retirement with comment cleanup.

No abandoned TODO/FIXME block was substantiated as a safe removal. User-visible messages containing “no longer” and variables named “obsolete” in stage cancellation are active behavior, not deprecated code.

## 12. Recommended Cleanup Order

### Phase 1: Very Safe Cleanup

Remove unused type import bindings, the stale nonexistent-file allowlist row, and the missing demo-file inventory entry. Review evaluated unused locals separately. Keep each patch small enough to review against the diagnostic inventory.

### Phase 2: High-Confidence Dead Code

Delete DEAD-001 through DEAD-008 by symbol, retaining all neighboring active validation and helpers. Review related tests, rerun focused checks and normal type/boundary checks. This phase does not depend on choosing an export-retirement policy.

### Phase 3: Consolidation

Address DUP-001, DUP-003, and DUP-004 independently. Consider DUP-002 only after proving frozen canonical-byte/hash equivalence. Preserve both protocol entry points and both boundary calls; do not combine with prompt/schema version changes.

### Phase 4: Dependency and Configuration Cleanup

Move DEAD-012's packages to dev dependencies and validate the pruned image. Resolve DEAD-013's tooling/config contract before removing it and updating fixtures. Runtime package reduction depends on preserving the browser JSZip asset and compiled archive code.

### Phase 5: Architecture Simplification

Resolve export consumers for DEAD-010/011. Audit legacy test coverage before retiring test oracles. Public route/client/protocol retirement requires external-use, parity, durable-job, and rollback evidence. These are separate decisions, not prerequisites for safe private deletion.

## 13. Suggested Validation

| Change | Required follow-up evidence |
| --- | --- |
| Authoring helpers | Authoring repository/stage tests; real PostgreSQL claim/list/apply coverage; type/boundary checks. |
| Chronicle/helper or generation checkpoint deletion | Chronicle/generation unit coverage; composed PostgreSQL rejection, reclaim, commit, and cross-campaign isolation. |
| Lease classifier deletion | Durable filesystem integration lease/work-version/expiry cases; retain database-clock checks. |
| Portable helper or dependency cleanup | Portable composition/unit coverage plus PostgreSQL import/export/publication tests; pruned-image archive smoke. |
| Illustration helpers | Image provider/publication/retry tests; independent illustration failure cannot change accepted story state. |
| Prompt private literal/schema alias/preset constant | Prompt-library/client contract/preset tests; ensure frozen prompts and schemas do not change. |
| Data Transfer singleton | Factory tests; rendered browser export/import/upload resume, disposal, restricted storage, and screenshots if visible behavior changes. |
| Canonical serialization consolidation | Golden persisted hash vectors, key-order/array/optional-field cases; resumed frozen contracts and rollback readers. |
| Turn-input guard consolidation | API and worker boundary tests; mechanic leakage rejection and campaign isolation. |
| API alias retirement | Access logs and consumer inventory; deprecation policy; API route tests and supported-client/browser smoke. |
| Docs/allowlist entry | Boundary guard regression/check; local links, documentation build where affected, scoped diff and `git diff --check`. |

### Checks performed during this audit

| Check | Result | What it proves |
| --- | --- | --- |
| Tracked-file/source inventory and reference scans | Passed; 2,012 files, 1,128 parsed source/declaration files | Search coverage and candidate generation; not exhaustive runtime reachability. |
| `corepack pnpm check` | Passed | Repository/data guards, package/browser compiler checks, root type check, legacy JS syntax checks. |
| Root TypeScript unused probe | Diagnostic failure as expected: 150 entries, 73 in production paths | Compiler-confirmed unused bindings in the selected graph. These optional flags are not the normal project gate. |
| Replacement UI unused probe | Diagnostic failure: 16 entries, 12 overlap root and four additional UI bindings | Entry-graph coverage for excluded UI code; 154 unique diagnostic entries across these two probes. |
| Focused existing unit suites | Passed: 11 files, 204 tests | Current unit/API-injection baseline, not proof of a deletion patch. |
| Report local links and diff whitespace checks | Passed | All four relative documentation links resolve; tracked and untracked-report whitespace checks are clean. |
| PostgreSQL, browser, container builds/deployment, live providers | Skipped | Read-only source audit did not require them; no claims of parity, database safety, deployed reachability, or live-provider behavior. |

The first unit invocation selected eight existing files (134 tests); one supplied filter, `tests/unit/world-generation.test.ts`, matched no file. The actual world-generation/character suites were subsequently located and run: three files, 70 tests. The eleven executed files were `world-fiction-reference`, `openrouter-presets`, `preset-response-format`, `web-next-data-transfer`, `task-14e3h-legacy-authority-removal`, `client-api-routes`, `generation-response-contract`, `runtime-illustration-composition`, `world-generator-service`, `generated-world`, and `character-generator-service` under `tests/unit/`.

Reproduce the unused probes:

```powershell
corepack pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters --pretty false
corepack pnpm --filter @infinite-quest/web-next exec tsc --ignoreConfig --noEmit --noUnusedLocals --noUnusedParameters --target ES2023 --module ESNext --moduleResolution Bundler --lib ES2023,DOM --types vite/client,node src/bootstrap.ts vite.config.ts
```

## 14. Estimated Cleanup Impact

| Measure | Evidence-based estimate |
| --- | --- |
| Entire production files safely removable | 0 confirmed |
| Private functions/closures safely removable | 11; 63 declaration lines |
| Private constants/schema aliases safely removable | 4; 19 declaration lines |
| Combined named private candidates | 82 declaration lines across 13 existing files, excluding imports/blank-line adjustments |
| Entire dependencies safely uninstallable | 0 confirmed |
| Production dependency placements removable | 2, by relocation to dev dependencies; bytes unmeasured |
| Exported functions needing consumer review | 4, plus one unused singleton and exported type leads |
| Principal consolidation groups | 4; all active; savings not counted without a concrete patch |
| Unused-code diagnostic inventory | 154 unique entries; not 154 proven deletions |
| Historical source/test-oracle retirement | About 15,046 lines across six files; expressly excluded from safe savings |

Expected immediate benefit is clarity and fewer stale alternatives, not a major runtime speedup. Bundlers may already erase unused private code. Runtime/container savings from dependency relocation require measurement after the actual patch.

## Appendix A. Compiler evidence

The inventory below records existing unused-binding diagnostics, not blanket permission to delete every initializer, parameter, exported type, or module. DEAD-001–008 were separately inspected. Test/script diagnostics are retained so later cleanup can review their side effects individually.

Root probe:

```text
packages/client-core/src/generation/projection.ts(10,8): error TS6133: 'GenerationResponseFormatProjection' is declared but its value is never read.
packages/client-core/src/generation/workflow.ts(8,8): error TS6133: 'GenerationSubmissionInput' is declared but its value is never read.
packages/contracts/src/authoring.ts(16,3): error TS6133: 'sourceFactReviewSchema' is declared but its value is never read.
packages/contracts/src/client-api.ts(4,3): error TS6133: 'campaignBranchSchema' is declared but its value is never read.
packages/contracts/src/client-api.ts(5,3): error TS6133: 'campaignRewindSchema' is declared but its value is never read.
packages/contracts/src/client-api.ts(19,10): error TS6133: 'generationReviewSummarySchema' is declared but its value is never read.
packages/contracts/src/client-api.ts(25,29): error TS6133: 'userProfileUpdateSchema' is declared but its value is never read.
packages/contracts/src/client-api.ts(26,42): error TS6133: 'campaignCreateSchema' is declared but its value is never read.
packages/contracts/src/client-api.ts(26,89): error TS6133: 'worldCreateSchema' is declared but its value is never read.
packages/contracts/src/client-api.ts(30,7): error TS6133: 'operationKindSchema' is declared but its value is never read.
packages/contracts/src/prompt-library.ts(6,3): error TS6133: 'PREVIOUS_STORY_MEMORY_PROMPT_PROTOCOL_VERSION' is declared but its value is never read.
packages/contracts/src/prompt-library.ts(302,7): error TS6133: 'generatedWorldCharacterSeedRequirements' is declared but its value is never read.
packages/database/src/asset-publication-repository.ts(10,3): error TS6196: 'PrivatePreparedAssetPublication' is declared but never used.
packages/database/src/authoring-job-repository.ts(11,8): error TS6133: 'AuthoringApplyReceipt' is declared but its value is never read.
packages/database/src/authoring-job-repository.ts(16,8): error TS6133: 'AuthoringExecutionSnapshot' is declared but its value is never read.
packages/database/src/authoring-job-repository.ts(17,8): error TS6133: 'AuthoringFailure' is declared but its value is never read.
packages/database/src/authoring-job-repository.ts(29,8): error TS6133: 'SourceFactReview' is declared but its value is never read.
packages/database/src/authoring-job-repository.ts(39,3): error TS6196: 'AuthoringWorldApplyPort' is declared but never used.
packages/database/src/authoring-job-repository.ts(514,10): error TS6133: 'listItem' is declared but its value is never read.
packages/database/src/authoring-job-repository.ts(557,7): error TS6133: 'STAGE_RETURNING' is declared but its value is never read.
packages/database/src/authoring-job-repository.ts(633,12): error TS6133: 'claimParameters' is declared but its value is never read.
packages/database/src/authoring-world-apply-adapter.ts(1,40): error TS6196: 'AuthoringTransaction' is declared but never used.
packages/database/src/authoring-world-apply-adapter.ts(3,15): error TS6196: 'OwnerScope' is declared but never used.
packages/database/src/authoring-world-apply-adapter.ts(6,15): error TS6196: 'AuthoringTarget' is declared but never used.
packages/database/src/chronicle-chunk-repository.ts(137,10): error TS6133: 'transactionClient' is declared but its value is never read.
packages/database/src/chronicle-state-correction-repository.ts(4,10): error TS6133: 'chronicleContentHash' is declared but its value is never read.
packages/database/src/durable-filesystem-repository.ts(16,3): error TS6196: 'DurableFilesystemReserveRequest' is declared but never used.
packages/database/src/durable-filesystem-repository.ts(368,10): error TS6133: 'claimClassification' is declared but its value is never read.
packages/database/src/generation-execution-repository.ts(12,3): error TS6133: 'readFrozenResponseContracts' is declared but its value is never read.
packages/database/src/generation-execution-repository.ts(14,3): error TS6133: 'readQueuedResponsePolicy' is declared but its value is never read.
packages/database/src/generation-execution-repository.ts(16,3): error TS6133: 'queuedResponsePolicyHash' is declared but its value is never read.
packages/database/src/generation-execution-repository.ts(37,8): error TS6133: 'QueuedResponsePolicy' is declared but its value is never read.
packages/database/src/generation-execution-repository.ts(366,11): error TS6133: 'pendingFor' is declared but its value is never read.
packages/database/src/generation-execution-repository.ts(1807,11): error TS6133: 'entityMetadata' is declared but its value is never read.
packages/database/src/generation-repository.ts(3,3): error TS6196: 'GenerationReviewDecisionRequest' is declared but never used.
packages/database/src/generation-repository.ts(362,3): error TS6133: 'client' is declared but its value is never read.
packages/database/src/generation-repository.ts(363,3): error TS6133: 'ownerUserId' is declared but its value is never read.
packages/database/src/generation-repository.ts(364,3): error TS6133: 'campaignId' is declared but its value is never read.
packages/database/src/generation-review-summary-projection.ts(2,112): error TS6133: 'GenerationReviewSummary' is declared but its value is never read.
packages/database/src/portable-import-family-repository.ts(911,10): error TS6133: 'portableRecord' is declared but its value is never read.
packages/domain/src/world-fiction-reference.ts(35,10): error TS6133: 'escapePointer' is declared but its value is never read.
packages/story-engine/src/openrouter-presets.ts(8,7): error TS6133: 'MAX_CONFIG_DEPTH' is declared but its value is never read.
packages/story-engine/src/output.ts(185,51): error TS6133: 'memoryDefaults' is declared but its value is never read.
packages/story-engine/src/provider-transport.ts(96,17): error TS6133: 'profile' is declared but its value is never read.
packages/story-engine/src/providers.ts(7,142): error TS6133: 'serializeProviderRequest' is declared but its value is never read.
scripts/report-turn-validation.ts(181,44): error TS6133: 'ledger' is declared but its value is never read.
services/api/src/portable-infinite-worlds-import-route.ts(5,3): error TS6133: 'convertInfiniteWorldsWorld' is declared but its value is never read.
services/runtime/src/generation-api-composition.ts(17,47): error TS6133: 'TextExecutionRouteBasis' is declared but its value is never read.
services/runtime/src/generation-executor-adapter.ts(19,3): error TS6196: 'MemoryGenerationAuthorityContext' is declared but never used.
services/runtime/src/generation-executor-adapter.ts(21,3): error TS6196: 'StreamingIllustrationConfig' is declared but never used.
services/runtime/src/generation-executor-adapter.ts(33,8): error TS6133: 'MemoryContextQuery' is declared but its value is never read.
services/runtime/src/generation-executor-adapter.ts(36,3): error TS6133: 'promptSnapshotSchema' is declared but its value is never read.
services/runtime/src/generation-executor-adapter.ts(120,8): error TS6133: 'TextProviderProfile' is declared but its value is never read.
services/runtime/src/generation-executor-adapter.ts(135,373): error TS6133: 'QueuedResponsePolicy' is declared but its value is never read.
services/runtime/src/generation-executor-adapter.ts(2787,11): error TS6133: 'formatRepairReceipt' is declared but its value is never read.
services/runtime/src/generation-executor-adapter.ts(3340,32): error TS6133: 'initialValidationErrors' is declared but its value is never read.
services/runtime/src/generation-executor-adapter.ts(4129,17): error TS6133: 'extensionSentFactIds' is declared but its value is never read.
services/runtime/src/generation-worker-composition.ts(26,15): error TS6196: 'QueuedResponsePolicyVersioned' is declared but never used.
services/runtime/src/illustration-image-job-adapter.ts(9,3): error TS6196: 'IllustrationImageProviderPort' is declared but never used.
services/runtime/src/illustration-image-job-adapter.ts(873,10): error TS6133: 'withoutTemporaryUrls' is declared but its value is never read.
services/runtime/src/illustration-platform-adapter.ts(10,3): error TS6196: 'IllustrationTransactionContext' is declared but never used.
services/runtime/src/illustration-platform-adapter.ts(369,10): error TS6133: 'notFound' is declared but its value is never read.
services/runtime/src/illustration-segment-job-adapter.ts(9,10): error TS6133: 'logger' is declared but its value is never read.
services/runtime/src/illustration-segment-job-adapter.ts(227,3): error TS6133: 'campaignId' is declared but its value is never read.
services/runtime/src/portable-import-export-composition.ts(26,10): error TS6133: 'legacyWorldContent' is declared but its value is never read.
services/runtime/src/portable-import-export-composition.ts(44,8): error TS6133: 'PrivatePortableFamilyMutationPort' is declared but its value is never read.
services/runtime/src/portable-import-export-composition.ts(996,10): error TS6133: 'isLegacyExternalImageUrl' is declared but its value is never read.
services/runtime/src/provider-application-composition.ts(40,15): error TS6196: 'SourceAuthoringModelInventory' is declared but never used.
services/runtime/src/provider-preset-resolution.ts(4,3): error TS6133: 'textExecutionPlanSchema' is declared but its value is never read.
services/runtime/src/provider-world-generation-adapter.ts(344,16): error TS6133: 'callGeneratedWorldProvider' is declared but its value is never read.
services/runtime/src/provider-world-generation-adapter.ts(576,49): error TS6133: 'index' is declared but its value is never read.
services/runtime/src/provider-world-generation-adapter.ts(975,3): error TS6133: 'pool' is declared but its value is never read.
services/runtime/src/secure-filesystem-adapter.ts(22,3): error TS6196: 'ReservedFilesystemOperation' is declared but never used.
services/runtime/src/system-archive-composition.ts(15,3): error TS6133: 'systemArchiveReportSchema' is declared but its value is never read.
tests/e2e/legacy-provider-presets.e2e.test.ts(390,7): error TS6133: 'releasePresetList' is declared but its value is never read.
tests/e2e/legacy-provider-presets.e2e.test.ts(394,7): error TS6133: 'releasePresetDetail' is declared but its value is never read.
tests/helpers/private-storage-lifecycle-fake.ts(20,3): error TS6196: 'PortableArchiveExportRetrieval' is declared but never used.
tests/helpers/private-storage-lifecycle-fake.ts(21,3): error TS6196: 'PortableStagedInput' is declared but never used.
tests/helpers/runtime-application-fixtures.ts(44,3): error TS6133: 'store' is declared but its value is never read.
tests/helpers/story-only-synthetic-provider.ts(2,29): error TS6133: 'Server' is declared but its value is never read.
tests/integration/authoring-stage-execution.integration.test.ts(12,10): error TS6133: 'createAuthoringWorkerApplication' is declared but its value is never read.
tests/integration/campaign-state-replay.integration.test.ts(38,11): error TS6133: 'firstTurn' is declared but its value is never read.
tests/integration/campaign-transfer-character-repository.integration.test.ts(16,3): error TS6133: 'worldCreateSchema' is declared but its value is never read.
tests/integration/chronicle-chunk-retrieval.integration.test.ts(2,10): error TS6133: 'createTurnCorrectionApplication' is declared but its value is never read.
tests/integration/chronicle-chunk-retrieval.integration.test.ts(4,10): error TS6133: 'rebuildCampaignMemories' is declared but its value is never read.
tests/integration/durable-filesystem-repository.integration.test.ts(7,3): error TS6196: 'AttachedFilesystemOperation' is declared but never used.
tests/integration/gameplay.integration.test.ts(14,10): error TS6133: 'runImageJob' is declared but its value is never read.
tests/integration/gameplay.integration.test.ts(25,3): error TS6133: 'generationStreamSnapshotSchema' is declared but its value is never read.
tests/integration/gameplay.integration.test.ts(133,7): error TS6133: 'imageProviderId' is declared but its value is never read.
tests/integration/gameplay.integration.test.ts(735,25): error TS6133: 'worldTitle' is declared but its value is never read.
tests/integration/generation-repository.integration.test.ts(359,35): error TS6133: 'scope' is declared but its value is never read.
tests/integration/generation-response-contract-failures.integration.test.ts(1336,97): error TS6133: 'operation' is declared but its value is never read.
tests/integration/generation-response-contract.integration.test.ts(475,21): error TS6133: 'fixture' is declared but its value is never read.
tests/integration/history-coverage-context.integration.test.ts(332,11): error TS6133: 'baseTurn' is declared but its value is never read.
tests/integration/image-pipeline.integration.test.ts(1998,11): error TS6133: 'ownerUserId' is declared but its value is never read.
tests/integration/import-memory.integration.test.ts(4,8): error TS6133: 'JSZip' is declared but its value is never read.
tests/integration/import-memory.integration.test.ts(1093,11): error TS6133: 'ownerUserId' is declared but its value is never read.
tests/integration/import-repository.integration.test.ts(22,8): error TS6133: 'DatabaseClient' is declared but its value is never read.
tests/integration/import-repository.integration.test.ts(181,21): error TS6133: 'staged' is declared but its value is never read.
tests/integration/provider-routes.integration.test.ts(9,10): error TS6133: 'createProviderNetworkPolicy' is declared but its value is never read.
tests/integration/provider-routes.integration.test.ts(10,10): error TS6133: 'createProviderTransport' is declared but its value is never read.
tests/integration/provider-routes.integration.test.ts(416,13): error TS6133: 'owner' is declared but its value is never read.
tests/integration/source-authoring-jobs.integration.test.ts(1049,11): error TS6133: 'chunk' is declared but its value is never read.
tests/integration/source-authoring-jobs.integration.test.ts(1099,11): error TS6133: 'chunk' is declared but its value is never read.
tests/integration/source-world-portability.integration.test.ts(277,11): error TS6133: 'chunk' is declared but its value is never read.
tests/integration/story-continuity-evaluator.integration.test.ts(9,51): error TS6133: 'DatabaseClient' is declared but its value is never read.
tests/integration/story-continuity-evaluator.integration.test.ts(278,19): error TS6133: 'index' is declared but its value is never read.
tests/integration/story-continuity-review.integration.test.ts(14,10): error TS6133: 'mkdir' is declared but its value is never read.
tests/integration/story-continuity-review.integration.test.ts(14,27): error TS6133: 'writeFile' is declared but its value is never read.
tests/integration/story-continuity-review.integration.test.ts(24,10): error TS6133: 'loadPostgresChronicleGenerationAuthorityContext' is declared but its value is never read.
tests/integration/story-continuity-review.integration.test.ts(25,10): error TS6133: 'resolveGenerationAuthoritySnapshot' is declared but its value is never read.
tests/integration/story-continuity-review.integration.test.ts(41,1): error TS6192: All imports in import declaration are unused.
tests/integration/story-continuity-review.integration.test.ts(67,6): error TS6196: 'CorpusScenario' is declared but never used.
tests/integration/story-continuity-review.integration.test.ts(77,6): error TS6196: 'CapturedDispatch' is declared but never used.
tests/integration/story-continuity-review.integration.test.ts(1590,31): error TS6133: 'campaignId' is declared but its value is never read.
tests/integration/story-continuity-review.integration.test.ts(1920,92): error TS6133: 'invocationKey' is declared but its value is never read.
tests/integration/story-continuity-review.integration.test.ts(1920,107): error TS6133: 'routeBasis' is declared but its value is never read.
tests/integration/story-continuity-review.integration.test.ts(1920,119): error TS6133: 'frozenResponseContracts' is declared but its value is never read.
tests/integration/story-only-choice-repair.integration.test.ts(317,11): error TS6133: 'sourceFactId' is declared but its value is never read.
tests/integration/story-only-generation.integration.test.ts(16,10): error TS6133: 'DEDICATED_CHUNKED_AUDIT' is declared but its value is never read.
tests/integration/system-archive.integration.test.ts(18,3): error TS6133: 'systemArchiveReportSchema' is declared but its value is never read.
tests/integration/task-14e3b4-secure-storage-repository.integration.test.ts(11,8): error TS6133: 'PrivatePrewriteCleanupPreparation' is declared but its value is never read.
tests/integration/task-14e3b5-storage-composition.integration.test.ts(28,3): error TS6196: 'AssetPublicationCandidate' is declared but never used.
tests/integration/task-14e3b5-storage-composition.integration.test.ts(29,3): error TS6196: 'AttachedFilesystemOperation' is declared but never used.
tests/integration/task-14e3b5-storage-composition.integration.test.ts(32,3): error TS6196: 'ReservedFilesystemOperation' is declared but never used.
tests/integration/task-14e3e1c-normalized-publication-repository.integration.test.ts(282,13): error TS6133: 'legacyIdentity' is declared but its value is never read.
tests/integration/task-14e3e4-portable-normalized-publication.integration.test.ts(2138,58): error TS6133: 'row' is declared but its value is never read.
tests/integration/world-campaign-repository.integration.test.ts(21,10): error TS6133: 'createPostgresGenerationExecutionRepository' is declared but its value is never read.
tests/integration/world-generation.integration.test.ts(573,17): error TS6133: 'marker' is declared but its value is never read.
tests/legacy-api/src/campaign-archive-service.ts(865,9): error TS6133: 'embedded' is declared but its value is never read.
tests/legacy-api/src/infinite-worlds-import-service.ts(388,11): error TS6133: 'basePrompt' is declared but its value is never read.
tests/unit/application/world-campaign-use-cases.test.ts(242,60): error TS6133: 'owner' is declared but its value is never read.
tests/unit/asset-archive-service.test.ts(51,7): error TS6133: 'assetE' is declared but its value is never read.
tests/unit/chronicle-runtime-adapter.test.ts(11,1): error TS6192: All imports in import declaration are unused.
tests/unit/client-core/story-context-budget.test.ts(4,3): error TS6133: 'DEFAULT_STORY_CONTEXT_BUDGET_TOKENS' is declared but its value is never read.
tests/unit/client-web/api-client.test.ts(21,3): error TS6196: 'GenerationJobSnapshot' is declared but never used.
tests/unit/client-web/generation-poll-source.test.ts(9,3): error TS6196: 'Clock' is declared but never used.
tests/unit/preset-response-format.test.ts(14,3): error TS6133: 'stableJsonHash' is declared but its value is never read.
tests/unit/provider-api-adapter.test.ts(194,11): error TS6133: 'metadata' is declared but its value is never read.
tests/unit/provider-request-budget.test.ts(347,64): error TS6133: 'init' is declared but its value is never read.
tests/unit/runtime-illustration-composition.test.ts(337,11): error TS6133: 'store' is declared but its value is never read.
tests/unit/story-only-portability-contracts.test.ts(16,7): error TS6133: 'secondHash' is declared but its value is never read.
tests/unit/system-archive-contracts.test.ts(735,11): error TS6133: 'stateEditId' is declared but its value is never read.
tests/unit/task-14e2ar-persisted-filesystem.test.ts(19,3): error TS6196: 'DurableFilesystemJournalPort' is declared but never used.
tests/unit/task-14e3b1-contracts.test.ts(1,32): error TS6133: 'vi' is declared but its value is never read.
tests/unit/task-14e3b1-contracts.test.ts(6,8): error TS6133: 'AttachedFilesystemOperation' is declared but its value is never read.
tests/unit/task-14e3b4-secure-filesystem-adapter.test.ts(956,11): error TS6133: 'closeResolved' is declared but its value is never read.
tests/unit/task-14e3e7-maintenance-scheduler.test.ts(82,11): error TS6133: 'entered' is declared but its value is never read.
tests/unit/world-generator-service.test.ts(354,24): error TS6133: 'plan' is declared but its value is never read.
tests/unit/world-generator-service.test.ts(354,30): error TS6133: 'request' is declared but its value is never read.
```

Additional replacement UI bindings (shared diagnostics omitted):

```text
apps/web-next/src/app-shell-lifecycle.ts(43,9): error TS6133: 'profileToggle' is declared but its value is never read.
apps/web-next/src/character-workspace-page.ts(22,8): error TS6133: 'CharacterWorkspaceState' is declared but its value is never read.
apps/web-next/src/story-player-generation.ts(4,8): error TS6133: 'GenerationEvent' is declared but its value is never read.
apps/web-next/src/story-player-page.ts(153,9): error TS6133: 'theme' is declared but its value is never read.
```
