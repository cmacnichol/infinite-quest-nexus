# Task 2 Report — Opaque expiring single-consumer handoff

## Status

Implemented Task 2 with strict RED/GREEN TDD. The session adapter provides an opaque same-origin route, exact 30-minute session expiry, a 512 KiB UTF-8 bound, validated return tombstones, recursive owner-key removal, workflow/origin isolation, one result, and one successful consumption.

## RED Evidence

Initial command:

```bash
pnpm vitest run tests/unit/web-next-character-workspace-session.test.ts
```

Observed expected failure: Vitest could not resolve `apps/web-next/src/character-workspace-session.js`; zero tests ran because the production module did not exist.

Two focused review cycles also produced expected RED failures before fixes:

- A directly tampered accepted-result record returned `ownerUserId` from a passthrough candidate.
- Session and result envelopes with an extra `credential` root field were accepted.

The final parsers sanitize decoded candidates and strictly reject unknown session, return, and result envelope fields.

## Implementation

- Added `CharacterWorkspaceSession`, `CharacterWorkspaceResult`, `CharacterSummary`, input/options, consumed-result, and store interfaces.
- Added `create`, `load`, `returnPath`, `complete`, and `consume` operations over browser `Storage`.
- Namespaced records under:
  - `iqn:character-workspace:session:*`
  - `iqn:character-workspace:return:*`
  - `iqn:character-workspace:result:*`
- Generates keys with `crypto.randomUUID()` by default and supports deterministic injected clocks/key factories in tests.
- Encodes exactly one opaque URL segment and safely rejects malformed paths and percent encoding.
- Sets session and tombstone expiry to exactly 30 minutes and rejects expired or artificially overlong decoded lifetimes.
- Bounds every serialized record to 512 KiB using UTF-8 byte length and rolls back partial session creation writes.
- Validates all decoded record envelopes, editable world drafts, character summaries, and playable characters.
- Recursively strips `user_id`, `userId`, `owner_user_id`, and `ownerUserId` while preserving unrelated passthrough properties.
- Allows completion only for the owning workflow and only when no result record already exists.
- Allows consumption only for the owning origin and workflow, then removes session, return, and result records synchronously.
- Represents cancellation as a normal single-consumer result.
- Preserves a separately validated same-origin `/app` return tombstone when a session record is missing or malformed.

## Files Changed

- `apps/web-next/src/character-workspace-session.ts` — Added the bounded session handoff adapter and exported contracts.
- `tests/unit/web-next-character-workspace-session.test.ts` — Added nine focused tests covering all Task 2 lifecycle and security requirements.
- `.superpowers/sdd/2026-08-12-character-creation-workspace/task-2-report.md` — Recorded TDD and verification evidence.

## Verification

```bash
pnpm vitest run tests/unit/world-library.test.ts tests/unit/web-next-character-workspace-model.test.ts tests/unit/web-next-character-workspace-session.test.ts
```

Result: 3 files passed; 39 tests passed, 0 failed.

```bash
pnpm exec tsc --ignoreConfig --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck apps/web-next/src/character-workspace-session.ts tests/unit/web-next-character-workspace-session.test.ts
```

Result: exit 0 with no diagnostics.

```bash
git diff --check
```

Result: exit 0 with no diagnostics before report creation; rerun before commit.

## Concerns

- Projectmem was explicitly unavailable, so `precheck_file` and event logging could not be performed.
- The repository-wide suite was not rerun for this scoped task. Task 1 already documents unrelated existing Windows/platform and web-next failures; the Task 2 suite plus consumed Task 1 suites and strict scoped compilation are green.
- The pre-existing untracked `.superpowers/brainstorm/` directory remains untouched and will not be staged.
