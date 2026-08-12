# Task 3 Report — Sanitized preview generation and bounded progress

## Status

Implemented Character Workspace Task 3 with strict RED/GREEN TDD. Character generation remains preview-only: the browser boundary calls the existing owner-scoped preview route and shared world-generation progress read route, and no create, update, publish, campaign, asset, or save endpoint was added.

## RED Evidence

1. `pnpm vitest run tests/unit/web-next-character-workspace-api.test.ts`
   - Expected failure: Vitest could not resolve the new `apps/web-next/src/character-workspace-api.js` module.
2. `pnpm vitest run tests/unit/world-library.test.ts tests/unit/client-api-routes.test.ts`
   - The contract test failed because `progressKey` was an unrecognized strict request key.
   - Route tests could not execute on this Windows host because the pre-existing secure filesystem composition rejects non-Linux platforms with `filesystem_platform_unsupported`.
3. `pnpm vitest run tests/unit/world-library.test.ts`
   - Progress tests failed because no progress rows or updates were emitted.
4. `pnpm vitest run tests/unit/web-next-character-workspace-api.test.ts`
   - The added malformed-character test failed because browser sanitization was initially shallow; canonical contract validation was then added before transport.

## Implementation

- Added a Character Workspace browser API boundary that:
  - calls only `/api/v1/worlds/playable-characters/generate-preview` for generation;
  - reuses `/api/v1/worlds/generate-progress` for owner-scoped progress reads;
  - canonicalizes and validates current world content before transport;
  - removes root identity keys from the draft, world overview, and each character while retaining nested provenance and unknown safe lore;
  - sends only content, prompt, optional trusted edit ID, and the caller's unique progress key;
  - strictly parses preview and progress success responses;
  - strips root owner keys from the returned character and revalidates it against the playable-character contract;
  - classifies missing/default-provider failures separately, preserves ordinary request failures, and propagates aborts unchanged.
- Extended the shared strict preview request with an optional trimmed 1–512 character `progressKey`.
- Reused the existing owner-scoped world-generation progress repository collaborators for character previews.
- Records `preparing` 10%, `generating` 35%, `validating` 80%, `completed` 100%, or `failed` 100% with bounded public failure copy that does not include raw provider details.
- Added strict API response projection so malformed collaborator output cannot cross the server response boundary.
- Preserved application-owned owner scope throughout route and runtime composition.

## Files Changed

- `apps/web-next/src/character-workspace-api.ts` — Added the sanitized, abort-aware preview and progress browser boundary.
- `packages/contracts/src/world-library.ts` — Added optional bounded `progressKey` to the strict preview request.
- `services/runtime/src/provider-world-generation-adapter.ts` — Added owner-scoped character preview progress lifecycle updates.
- `services/runtime/src/world-campaign-composition.ts` — Reused existing progress repository collaborators for character preview generation.
- `services/api/src/server.ts` — Added strict character preview response projection.
- `tests/unit/web-next-character-workspace-api.test.ts` — Added browser route, sanitization, strict parsing, error, and abort coverage.
- `tests/unit/world-library.test.ts` — Added contract bounds and runtime progress lifecycle/security coverage.
- `tests/unit/client-api-routes.test.ts` — Added server-owner composition, spoof rejection, progress-key forwarding, and strict projection coverage.
- `.superpowers/sdd/2026-08-12-character-creation-workspace/task-3-report.md` — Recorded Task 3 implementation and verification evidence.

## Verification

- `pnpm vitest run tests/unit/world-library.test.ts tests/unit/web-next-character-workspace-api.test.ts` — 2 files passed; 32 tests passed.
- `pnpm vitest run tests/unit/world-generator-service.test.ts tests/unit/runtime-provider-lifecycle.test.ts` — 2 files passed; 33 tests passed.
- Scoped strict TypeScript command covering all changed TypeScript and test files — exit 0 with no diagnostics.
- `pnpm vitest run tests/unit/world-library.test.ts tests/unit/client-api-routes.test.ts tests/unit/web-next-character-workspace-api.test.ts` — browser and contract tests execute, but the full command is blocked on this Windows host by the repository's pre-existing Linux-only secure filesystem composition (`filesystem_platform_unsupported`) in all `client-api-routes` tests.
- `pnpm build` — blocked by pre-existing web-next TypeScript failures in unchanged files, including extensionless NodeNext imports and existing strictness errors. The scoped strict TypeScript command is green.
- `git diff --check` — run immediately before commit.

## Concerns

- Projectmem was explicitly unavailable, so mandatory `precheck_file` and event-log calls could not be performed.
- The two new `client-api-routes` cases could not execute on Windows because `buildServer` eagerly creates the Linux-only secure filesystem adapter. They compile under the scoped strict TypeScript check and are included for Linux CI.
- The repository-wide build remains blocked by documented pre-existing web-next TypeScript issues outside Task 3 scope.
- The pre-existing untracked `.superpowers/brainstorm/` directory remains untouched and excluded from the commit.
