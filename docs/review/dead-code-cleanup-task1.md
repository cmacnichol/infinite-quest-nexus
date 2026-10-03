# Dead-code cleanup Task 1 report

Task 1 removed only the 11 audited private callables and four private constants/schema aliases from the 13 named source files. All edits are deletions; public contracts, prompt templates, runtime paths, and the audit report remain unchanged. The live `portableRecord` in `services/runtime/src/portable-import-export-composition.ts` and identically named helpers in neighboring modules were preserved.

## Changed-file and test review

| Changed source file(s) | Related tests reviewed | Focused run |
| --- | --- | --- |
| `packages/database/src/authoring-job-repository.ts` | `tests/unit/authoring-jobs.test.ts`; `tests/integration/authoring-job-repository.integration.test.ts` | Unit passed; original focused PostgreSQL run skipped; later controller run covered this file (see follow-up) |
| `packages/database/src/chronicle-chunk-repository.ts` | `tests/unit/chronicle-chunking.test.ts`, `tests/unit/chronicle-chunk-worker-execution.test.ts`; `tests/integration/chronicle-chunk-repository.integration.test.ts`, `tests/integration/chronicle-chunk-retrieval.integration.test.ts` | Unit passed; original focused PostgreSQL run skipped; later controller run covered this file (see follow-up) |
| `packages/database/src/durable-filesystem-repository.ts` | `tests/integration/durable-filesystem-repository.integration.test.ts` | Original focused run skipped; later controller run covered this file (see follow-up) |
| `packages/database/src/portable-import-family-repository.ts` | `tests/unit/task-14e3d-portable-composition.test.ts`, `tests/unit/portable-accepted-policy-metadata.test.ts`; `tests/integration/task-14e3b2c-portable-repository.integration.test.ts` | Unit passed; PostgreSQL integration skipped |
| `services/runtime/src/portable-import-export-composition.ts` | `tests/unit/task-14e3d-portable-composition.test.ts`; `tests/integration/task-14e3d-portable-composition.integration.test.ts` | Unit passed; original focused PostgreSQL run skipped; later controller run covered `import-repository.integration.test.ts` (see follow-up) |
| `services/runtime/src/illustration-image-job-adapter.ts`; `services/runtime/src/illustration-platform-adapter.ts` | `tests/unit/illustration-application-adapter.test.ts`, `tests/unit/runtime-illustration-composition.test.ts`; illustration publication integration tests | Unit passed; PostgreSQL integration skipped |
| `packages/domain/src/world-fiction-reference.ts` | `tests/unit/world-fiction-reference.test.ts` | Passed |
| `services/runtime/src/provider-world-generation-adapter.ts` | `tests/unit/source-world-generation.test.ts`; `tests/integration/world-generation.integration.test.ts`, `tests/integration/world-generation-repository.integration.test.ts`, `tests/integration/world-generation-progress.integration.test.ts` | Unit passed; PostgreSQL integrations skipped |
| `packages/database/src/generation-execution-repository.ts` | `tests/integration/generation-execution-repository.integration.test.ts` | Original focused run skipped; later controller run covered `generation-response-contract.integration.test.ts` (see follow-up) |
| `packages/contracts/src/client-api.ts` | `tests/unit/client-api-contracts.test.ts` | Passed |
| `packages/contracts/src/prompt-library.ts` | `tests/unit/prompt-library.test.ts` | Passed |
| `packages/story-engine/src/openrouter-presets.ts` | `tests/unit/openrouter-presets.test.ts` | Passed |

## Commands and results

- Focused final unit run:
  `pnpm exec vitest run tests/unit/authoring-jobs.test.ts tests/unit/chronicle-chunking.test.ts tests/unit/chronicle-chunk-worker-execution.test.ts tests/unit/client-api-contracts.test.ts tests/unit/openrouter-presets.test.ts tests/unit/prompt-library.test.ts tests/unit/world-fiction-reference.test.ts tests/unit/illustration-application-adapter.test.ts tests/unit/runtime-illustration-composition.test.ts tests/unit/source-world-generation.test.ts tests/unit/task-14e3d-portable-composition.test.ts tests/unit/portable-accepted-policy-metadata.test.ts`
  Result: passed, 12 files and 214 tests.
- `pnpm check`
  Result: passed, including repository boundary/data checks, workspace package checks, web checks, root TypeScript check, and legacy JavaScript syntax checks.
- `git diff --check`
  Result: passed after trimming the extra end-of-file blank lines left by deleting the two final helpers.
- Baseline unit comparison: not available. The baseline replay attempt failed to apply the saved diff cleanly, so no claim is made about pre-edit test results.
- Original focused PostgreSQL run: skipped; no database was started for that focused mechanical cleanup.

## Controller-provided PostgreSQL follow-up

This is separate evidence from the focused unit run and from the original skip results above. The controller reports that six isolated integration files ran against PostgreSQL: `authoring-job-repository.integration.test.ts`, `chronicle-chunk-repository.integration.test.ts`, `durable-filesystem-repository.integration.test.ts`, `import-repository.integration.test.ts`, `generation-response-contract.integration.test.ts`, and `image-pipeline.integration.test.ts`. Result: 144 passed, 14 skipped. The 14 skips are image-pipeline cases gated on secure filesystem Linux support, unavailable on Windows. This evidence does not mean every integration suite mapped above was run.

## Self-review and limits

The final Task 1 source diff contains 93 deleted lines across exactly the 13 Task 1 files and no additions, including two trailing blank lines removed at end of file. A symbol scan found none of the 15 audited names in their target files. It also confirmed the live runtime `portableRecord` call sites and same-named transaction/error helpers in their owning modules remain. The full `pnpm check` passed after the removals. Focused tests establish current behavior in related unit-covered areas; the original run had no PostgreSQL evidence, which is recorded separately in the controller-provided follow-up above. No behavior change was intended or observed.
