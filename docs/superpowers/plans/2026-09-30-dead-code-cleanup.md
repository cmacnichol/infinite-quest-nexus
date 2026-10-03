# Dead Code Cleanup Implementation Plan

> For agentic workers: use subagent-driven-development task by task with Luna implementers and Luna reviewers.

**Goal:** Implement the audit's behavior-preserving private deletions and safe dependency/tooling cleanup in an isolated worktree.

**Architecture:** Keep both active clients, all public interfaces, frozen protocols, authoritative state, and operational topology. Delete proven unused private declarations; do not replace them with abstractions.

**Tech Stack:** TypeScript, pnpm, Vitest, Vite, PostgreSQL/Docker.

**Spec:** docs/review/dead-code-audit-2026-09-30.md, especially DEAD-001 through DEAD-009, DEAD-012, sections 9 and 11.

## Global Constraints

- Do not change intended runtime behavior, prompts, schemas, job/checkpoint semantics, ownership, retry policy, or provider separation.
- Preserve migrations, legacy clients, historical protocol readers, browser JSZip, and external APIs.
- Do not prune exported functions/types or evaluated unused initializers without separate evidence.
- Review tests associated with every changed source file; existing regression expectations stay intact unless a changed test actually references a deleted private declaration.
- User explicitly requested a new worktree and Luna subagents; implement and review with Luna. The initial implementation stops before commit, push, publish, or deployment. The user later authorized commit/push/PR on 2026-10-03; deployment remains outside scope.
- Keep cleanup reversible and preserve the source audit unchanged as historical evidence.

## Review Focus

- Private helper deletion must not remove a live same-named helper elsewhere.
- Unused type imports erase at compile time; removing a last runtime import may change module evaluation.
- Keep npm JSZip available for tests and the vendored browser bundle available for legacy UI.
- Dependency relocation must preserve frozen installation/build and production archive capability.
- Any unavailable PostgreSQL, browser, container, or provider validation is reported as skipped, never passed.

### Task 1: Remove proven private declarations

**Files:** The 13 files identified in audit DEAD-001 through DEAD-008.
**Consumes:** Exact audited symbols; confirm each against current source/compiler evidence.
**Produces:** Same public interfaces and behavior, with 11 private callables and four constants/schema aliases removed.

- [x] Review related tests and attempt focused baseline (baseline replay failed; final verification is recorded without baseline proof).
- [x] Remove only listItem, STAGE_RETURNING, claimParameters from authoring-job-repository; transactionClient from chronicle-chunk-repository; claimClassification from durable-filesystem-repository; portableRecord from portable-import-family-repository; isLegacyExternalImageUrl from portable-import-export-composition; withoutTemporaryUrls from illustration-image-job-adapter; notFound from illustration-platform-adapter; escapePointer from world-fiction-reference; callGeneratedWorldProvider from provider-world-generation-adapter; pendingFor from generation-execution-repository; operationKindSchema from client-api; generatedWorldCharacterSeedRequirements from prompt-library; MAX_CONFIG_DEPTH from openrouter-presets.
- [x] Preserve neighboring live helpers and all caller behavior; remove directly orphaned type imports only when proven unused.
- [x] Run focused related unit tests, compiler/boundary check and git diff --check.
- [x] Record exact commands, results, changed-file/test mapping, and remaining concerns in Task 1 report; obtain independent Luna review before Task 2.

### Task 2: Prune stale type coupling, tooling entry and dependency placement

**Files:** Production TypeScript files with compiler-proven unused type imports; scripts/check-repository-boundaries.mjs; docs/architecture/repository-overview.md; package.json; pnpm-lock.yaml.
**Consumes:** Reviewed Task 1 tree and diagnostic appendix.
**Produces:** Same runtime API and behavior; jszip and @types/archiver in devDependencies, removed nonexistent story.js allowlist row and missing demo inventory entry, fewer unused type imports.

- [x] Remove only compiler-proven unused type imports in production apps/packages/services. Retain value imports unless module evaluation is demonstrably preserved. Keep parameters, exported aliases, computed locals and test sources outside this mechanical cleanup.
- [x] Remove nonexistent apps/web/public/story.js network allowlist row and obsolete demo_version.html inventory entry; review boundary-test expectations and update if needed.
- [x] Move jszip and @types/archiver from dependencies to devDependencies with unchanged versions; update lockfile importer metadata using pnpm. Preserve vendored JSZip and all test imports.
- [x] Run affected tests, pnpm check and pnpm build; validate a frozen lockfile install and production dependency classification.
- [x] Obtain independent Luna task review, then a Luna whole-change review. Record any unavailable container/PostgreSQL/browser evidence separately.

## Completion

- [x] Confirm the main checkout was not changed beyond its existing audit report.
- [x] Save verification results with completed tasks, review verdicts, and deferred audit items.
- [x] Leave the cleanup branch/worktree available for review. Initial implementation did not publish; commit/push/PR was separately authorized on 2026-10-03.

## Scope decision

Uncertain exports/config members, route retirement, test-oracle retirement and four consolidation groups remain deferred. They require additional consumer/compatibility evidence or a separately designed behavior-preserving change; safe deletion does not depend on them.
