# Phase 03 handoff: pure fact-format repair planner

Base: requested code baseline `1f4e9fb94090bd283380a691f0a80d632e88c107`. This worktree started Phase 03 on the coordinator's unrelated documentation checkpoint `82557229fc9df06e6d0d7d0cc5147a0a8af761f5`; the Phase 03 commit follows that checkpoint.

## Scope and interfaces

`packages/story-engine/src/fact-format-repair.ts` adds a pure `planFactFormatRepair` boundary. It accepts the exact raw provider output plus the supplied visible fact inventory and returns either a version-1 private plan or one explicit ineligibility reason. It makes no database, provider, acceptance, or UI call.

The plan binds `rawOutputHash` to the exact raw bytes, `visibleFactsHash` to stable inventory serialization, `protectedFieldsHash` to the source object with only `canonical_facts` replaced by an empty array, and `resultHash` to the proposed strict story. Its transformation journal records only inert ID-label conversion, exact redundant visible-reference removal, metadata-to-addition conversion, and explicit misplaced-update movement.

The planner uses `extractJsonObject` as its only raw extraction boundary, then uses `parseStoryOutput` first to preserve ordinary acceptance and again to validate protected fields and the resulting strict story. It does not modify `parseStoryOutput`, invent missing full replacement fields, infer fact authority, normalize ID labels, or perform repair execution.

## Decision coverage

The synthetic fixture and unit matrix cover every transformation-table row: strings and content-only wrappers remain normal-parser behavior; null, empty, short ASCII, and UUID-shaped inert labels become additions; exact visible references are removed; changed visible content rejects; finite nonnegative `estimatedTokens` metadata becomes an addition; empty supersession metadata becomes an addition; valid explicit visible replacements move into updates.

The adverse matrix rejects unknown keys, non-record items, malformed content and metadata, whitespace/control/Unicode/overlong/nested ID labels, unseen or malformed replacements, duplicate targets, collisions with existing updates, invalid visible inventories, excess facts, incomplete JSON, missing required fields, invalid trackers, and mechanics contamination. UUID comparisons are case-insensitive only while protecting an inert ID label from being mistaken for a visible UUID; supersession IDs remain exact supplied visible UUIDs. Tests also prove no partial plan for mixed arrays, content mass balance, deterministic plans, and all four hash bindings.

## Verification

- **RED:** `corepack pnpm exec vitest run tests/unit/fact-format-repair.test.ts` failed before production code existed. Vitest reported that `packages/story-engine/src/fact-format-repair.js` could not be resolved; no tests ran because the required planner API was absent.
- **GREEN:** `corepack pnpm exec vitest run tests/unit/fact-format-repair.test.ts tests/unit/story-output.test.ts tests/unit/story-only-output.test.ts` passed: 3 files, 94 tests. This includes unchanged direct-parser rejection coverage for `{id,content}`.
- **GREEN:** `corepack pnpm check` passed repository/data boundaries and all TypeScript/web checks. The only output was the pre-existing inaccessible Windows global Git-ignore warning.
- **GREEN:** `git diff --check` passed for the Phase 03 staged diff.

PostgreSQL, browser, and live-provider checks are skipped because this patch has no persistence, rendered UI, or provider behavior. They are not represented as passed evidence.

## Risks and Phase 04 contract

The result is a proposal only. Phase 04 must bind its explicit, revision-scoped decision and durable journal to all four hashes; reload current authority at commit; rerun mode-specific choice validation; and preserve the original raw candidate. The supplied visible inventory is sufficient only to propose a replacement mapping; it does not prove that a target fact remains active at commit time.

## Review correction

Independent review found four planner defects in the first Phase 03 commit: a content-only wrapper failed when mixed with a malformed object; a mechanics-bearing exact visible reference was removed before mechanics validation; Zod trimming could silently change protected strings, additions, and existing updates; and a broad UUID shape accepted an invalid visible inventory variant that the shared fact-update contract rejects.

The follow-up rejects any candidate whose protected non-narration values or fact content would change under strict parsing. It preserves content-only wrappers in a mixed canonical-fact array, checks mechanics in every supported source fact before removing or moving it, and uses the shared `canonicalFactUpdateSchema` UUID validator for visible and supersession authority. Raw UUID shape matching remains limited to case-insensitive collision protection for inert ID labels.

- **RED:** the first correction matrix added five tests and failed all five; the UUID-inventory regression then failed separately before shared-schema validation.
- **GREEN:** `corepack pnpm exec vitest run tests/unit/fact-format-repair.test.ts tests/unit/story-output.test.ts tests/unit/story-only-output.test.ts` passed: 3 files, 100 tests.
- **GREEN:** `corepack pnpm check` passed.
