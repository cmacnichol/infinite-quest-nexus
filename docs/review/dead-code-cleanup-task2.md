# Dead-code cleanup Task 2 report

Task 2 removed only compiler-diagnosed unused type imports in production apps/, packages/, and services/ code. Runtime/value imports, local variables, parameters, public exports, tests, and interfaces were left intact. It also removed the stale browser-network allowlist row and obsolete repository inventory entry, and moved jszip plus @types/archiver to root devDependencies without changing versions.

## Changed-file and test review

| Changed file group | Related existing tests reviewed and run |
| --- | --- |
| packages/client-core/src/generation/projection.ts, packages/client-core/src/generation/workflow.ts, apps/web-next/src/character-workspace-page.ts, apps/web-next/src/story-player-generation.ts | tests/unit/client-core/story-context-budget.test.ts; web-next TypeScript check and build cover replacement UI entry graphs |
| packages/database/src/authoring-job-repository.ts, packages/database/src/authoring-world-apply-adapter.ts | tests/unit/authoring-jobs.test.ts |
| packages/database/src/asset-publication-repository.ts, packages/database/src/durable-filesystem-repository.ts, services/runtime/src/secure-filesystem-adapter.ts | Storage behavior tests were reviewed; focused units ran with compiler and production build. Database coverage is separately reported in Task 1's controller follow-up and does not imply every mapped integration suite ran. |
| packages/database/src/chronicle-chunk-repository.ts | tests/unit/chronicle-chunking.test.ts, tests/unit/chronicle-chunk-worker-execution.test.ts |
| packages/database/src/generation-execution-repository.ts, packages/database/src/generation-repository.ts, packages/database/src/generation-review-summary-projection.ts, services/runtime/src/generation-api-composition.ts, services/runtime/src/generation-executor-adapter.ts, services/runtime/src/generation-worker-composition.ts | Generation and response-contract integration behavior was reviewed; root compiler/build checks passed. Controller PostgreSQL results are listed separately in Task 1's report. |
| packages/database/src/portable-import-family-repository.ts, services/runtime/src/portable-import-export-composition.ts | tests/unit/task-14e3d-portable-composition.test.ts, tests/unit/portable-accepted-policy-metadata.test.ts |
| packages/contracts/src/client-api.ts, packages/contracts/src/prompt-library.ts, packages/domain/src/world-fiction-reference.ts, packages/story-engine/src/openrouter-presets.ts | tests/unit/client-api-contracts.test.ts, tests/unit/prompt-library.test.ts, tests/unit/world-fiction-reference.test.ts, tests/unit/openrouter-presets.test.ts |
| services/runtime/src/illustration-image-job-adapter.ts, services/runtime/src/illustration-platform-adapter.ts | tests/unit/illustration-application-adapter.test.ts, tests/unit/runtime-illustration-composition.test.ts |
| services/runtime/src/provider-application-composition.ts, services/runtime/src/provider-world-generation-adapter.ts | tests/unit/provider-api-adapter.test.ts, tests/unit/source-world-generation.test.ts |
| scripts/check-repository-boundaries.mjs | pnpm check:repository ran boundary and data-safety checks successfully |
| docs/architecture/repository-overview.md, package.json, pnpm-lock.yaml | Documentation and dependency placement were reviewed directly; frozen lockfile install and both builds were run |

Focused test command:

    pnpm exec vitest run tests/unit/authoring-jobs.test.ts tests/unit/chronicle-chunking.test.ts tests/unit/chronicle-chunk-worker-execution.test.ts tests/unit/client-api-contracts.test.ts tests/unit/openrouter-presets.test.ts tests/unit/prompt-library.test.ts tests/unit/world-fiction-reference.test.ts tests/unit/illustration-application-adapter.test.ts tests/unit/runtime-illustration-composition.test.ts tests/unit/source-world-generation.test.ts tests/unit/task-14e3d-portable-composition.test.ts tests/unit/portable-accepted-policy-metadata.test.ts tests/unit/provider-api-adapter.test.ts tests/unit/client-core/story-context-budget.test.ts

Result: 14 files passed, 243 tests passed.

## Commands and results

- pnpm install --lockfile-only --offline — passed; pnpm v12.4.1 updated the lockfile and verified supply-chain policies.
- pnpm install --frozen-lockfile --offline — passed; lockfile is up to date and workspace already installed.
- pnpm check — passed, including repository boundaries and data-safety checks, package checks, both web checks, root TypeScript, and legacy JavaScript syntax checks.
- Focused unit command above — passed, 14 files and 243 tests.
- pnpm build — passed; backend TypeScript build plus legacy and replacement web production builds. Vite reported unresolved-at-build font URLs and a chunk above 500 kB; neither failed the build.
- git diff --check — passed after removing whitespace-only lines from type import edits.
- Compiler evidence: pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals true --pretty false identified import diagnostics. A final pass still reports unrelated unused runtime schema/value imports and private locals in production code, plus test diagnostics. These were intentionally retained because this task excludes runtime/value imports and computed locals. Standard pnpm check passed.
- Production image evidence reported by the controller: image build passed; pruned runtime imported archive-io, archiver, and unzipper, and a ZIP round-trip passed. npm jszip and @types/archiver were absent from runtime install, and vendored /app/apps/web/dist/jszip.min.js remained available.
- Controller also reported the complete unit run: 365/366 files passed, 4,722 tests passed and 49 skipped. The initial web-build-contract failure came from nested global pnpm 11.15.1, below required 12.4.1; rerunning with a PATH shim to required Corepack pnpm passed that suite (1 file, 5 tests). No source fix was needed.

No browser interaction, live provider, or additional PostgreSQL suite was run for Task 2. The PostgreSQL figures in the Task 1 report are a separate controller-provided follow-up and cover only the six named integration files.

## Scope and limitations

The import deletions are compile-time-only; no runtime behavior, schema, prompt, API contract, or provider behavior was changed. The checked-in browser JSZip remains, and test imports remain unchanged. No commits or pushes were made.
