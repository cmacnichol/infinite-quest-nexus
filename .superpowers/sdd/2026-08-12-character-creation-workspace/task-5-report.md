# Task 5 Report — New World Reviewed Character Roster

## Status

Implemented the reviewed character roster in New World creation using strict RED/GREEN TDD. The intentionally superseded forced-empty invariant is removed: reviewed characters persist through editing and submission, while generated world previews cannot inject characters.

## RED Evidence

### Model and API RED

```bash
pnpm vitest run tests/unit/web-next-world-creation-model.test.ts tests/unit/web-next-world-creation-api.test.ts
```

Observed 7 expected failures: the reviewed transition exports were absent and authoritative creation still forced `playableCharacters` to an empty array.

### Page RED

```bash
pnpm vitest run tests/unit/web-next-world-creation-page.test.ts
```

Observed the expected Characters-stage failures: the stage, empty state, roster actions, handoff creation, result consumption, and reviewed-roster submission were absent. Existing Cover-to-Review tests also exposed the required new intermediate stage.

### Remove/undo edge-case RED

```bash
pnpm vitest run tests/unit/web-next-world-creation-model.test.ts -t "restores multiple character removals"
```

Observed the reproducible order defect `b, a, c` instead of `a, b, c`. Character removals were recording current indexes rather than original roster indexes. The implementation now shares the existing original-index translation.

## Completed

- Added immutable append, replace, remove, and restore transitions for reviewed characters.
- Canonicalized reviewed candidates through the shared playable-character schema and shared roster bound.
- Rejected duplicate IDs, mismatched replacements, malformed candidates, missing targets, and overflow.
- Recursively stripped owner/credential-shaped fields while preserving safe passthrough character lore.
- Preserved reviewed rosters through normal canonicalization and authoritative submission.
- Added a generated-preview canonicalization path that always removes provider-supplied characters.
- Restored the existing reviewed roster after AI world generation.
- Added the optional Characters stage before Review, including empty guidance, factual roster entries, Add/Edit/Remove/Undo, and Add another.
- Delegated roster rendering and Character Workspace session creation to `world-creation-character-roster.ts`.
- Created exact world-creation handoffs with parent draft/context, roster summaries, candidate mode, opaque session route, and null world revision.
- Consumed only the active world-creation origin/workflow result on BFCache return.
- Restored `session.parentDraft` before accepted append or replace and consumed accepted results only once.
- Left cancellation and expired/missing results unchanged.
- Updated Review counts, readiness, serialized draft, and final creation to use the exact reviewed roster.

## Files Changed

- `apps/web-next/src/world-creation-character-roster.ts` — Added roster markup, actions, and Character Workspace session handoff creation.
- `apps/web-next/src/world-creation-model.ts` — Added the Characters stage, reviewed roster canonicalization/transitions, generated-preview isolation, review counts, and immutable undo ordering.
- `apps/web-next/src/world-creation-api.ts` — Applied the explicit generated-preview canonicalizer so provider characters remain excluded at the API boundary.
- `apps/web-next/src/world-creation-page.ts` — Integrated the Characters stage, roster module, session lifecycle, BFCache result consumption, and parent-draft restoration.
- `tests/unit/web-next-world-creation-model.test.ts` — Added reviewed roster, bounds, sanitization, generation preservation, submission, and multi-undo coverage.
- `tests/unit/web-next-world-creation-api.test.ts` — Updated generation and authoritative submission contracts for the reviewed roster.
- `tests/unit/web-next-world-creation-page.test.ts` — Added stage, handoff, append/replace, cancel/expiry, remove/undo, BFCache, restoration, and exact submission coverage.
- `.superpowers/sdd/2026-08-12-character-creation-workspace/task-5-report.md` — Recorded Task 5 implementation and evidence.

## Verification

- `pnpm vitest run tests/unit/web-next-world-creation-model.test.ts tests/unit/web-next-world-creation-api.test.ts tests/unit/web-next-world-creation-page.test.ts` — targeted model/API/page suite passed.
- `pnpm --filter @infinite-quest/web-next check` — TypeScript check passed.
- Impeccable detector over the two changed UI production targets — returned `[]`.
- Final broader verification, staged diff checks, and commit evidence are recorded in the handoff response.

## Concerns

- Projectmem was explicitly unavailable, so projectmem prechecks and event logging could not be performed.
- The persisted Impeccable World Creation surface brief still describes the superseded six-stage, forced-empty character invariant. It was left unchanged because Task 5's scoped file list and patch-stage instructions do not include design documentation.
- `world-creation-api.ts` required a narrow production change beyond the brief's initial file list to keep generated provider characters excluded after general canonicalization began preserving reviewed rosters.
- The pre-existing untracked `.superpowers/brainstorm/` directory remains untouched and must not be committed.
