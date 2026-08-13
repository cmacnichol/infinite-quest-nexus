# Task 2 Report — Opaque expiring single-consumer handoff

## Status

Implemented Task 2 with RED/GREEN TDD. The session adapter provides an opaque same-origin route, exact 30-minute session expiry, a 512 KiB UTF-8 bound on serialized writes and raw reads, validated return tombstones, recursive identity/secret-field removal, workflow/origin isolation, one result, and fail-closed single consumption.

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
- Bounds every serialized write and every raw session/result/tombstone read to 512 KiB using UTF-8 byte length before JSON decoding, and rolls back partial session creation writes.
- Validates all decoded record envelopes, editable world drafts, character summaries, and playable characters.
- Recursively strips `user_id`, `userId`, `owner_user_id`, and `ownerUserId`, plus credential/token/secret/password/API-key-shaped fields, while preserving unrelated passthrough lore.
- Allows completion only for the owning workflow and only when no result record already exists.
- Allows consumption only for the owning origin and workflow, replaces the accepted result with a consumed marker before cleanup, verifies all removals, and returns no result if cleanup fails.
- Represents cancellation as a normal single-consumer result.
- Preserves a separately validated same-origin `/app` return tombstone when a session record is missing or malformed.

## Files Changed

- `apps/web-next/src/character-workspace-session.ts` — Added the bounded session handoff adapter and exported contracts.
- `tests/unit/web-next-character-workspace-session.test.ts` — Added thirteen focused tests covering Task 2 lifecycle, bounds, recovery, and security requirements.
- `.superpowers/sdd/2026-08-12-character-creation-workspace/task-2-report.md` — Recorded TDD and verification evidence.

## Verification

The original pre-fix Task 2 verification reported 39 passing tests. That historical result is superseded by the final verification below after both fix rounds.

```bash
pnpm vitest run tests/unit/world-library.test.ts tests/unit/web-next-character-workspace-model.test.ts tests/unit/web-next-character-workspace-session.test.ts
```

Final result: 3 files passed; 43 tests passed, 0 failed.

```bash
pnpm exec tsc --ignoreConfig --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck apps/web-next/src/character-workspace-model.ts apps/web-next/src/character-workspace-session.ts packages/contracts/src/world-library.ts tests/unit/web-next-character-workspace-model.test.ts tests/unit/web-next-character-workspace-session.test.ts
```

Final result: exit 0 with no diagnostics.

```bash
git diff --check
```

Final result: exit 0 with no diagnostics after the round-two report update.

## Concerns

- Projectmem was explicitly unavailable, so `precheck_file` and event logging could not be performed.
- The repository-wide suite was not rerun for this scoped task. Task 1 already documents unrelated existing Windows/platform and web-next failures; the Task 2 suite plus consumed Task 1 suites and strict scoped compilation are green.
- The pre-existing untracked `.superpowers/brainstorm/` directory remains untouched and will not be staged.

## Fix Round 1

Resolved every round-one finding test-first.

### RED evidence

`pnpm vitest run tests/unit/web-next-character-workspace-session.test.ts` initially failed 4/13 tests. The failures reproduced acceptance of an oversized raw result, retention of nested secret-shaped fields, returning an accepted result despite a `Storage.removeItem()` failure, and the previously missing exact-byte raw-read behavior.

### Corrections

- Recursively remove identity fields and credential/token/secret/password/API-key-shaped keys from created sessions, decoded drafts, candidates, and accepted results while retaining safe unknown lore.
- Enforce the 512 KiB UTF-8 limit in the shared decode boundary before `JSON.parse` for session, result, and return-tombstone records.
- Cover an exact 512 KiB record containing multibyte lore, a one-byte-over record, direct oversized injection for every record type, and oversized create rollback.
- Replace a result with a synchronous consumed marker before cleanup, verify all three records are absent, and fail closed if any removal fails. A repeated consume cannot recover the accepted result.
- Add recovery coverage for a genuinely absent session with a separately valid same-origin tombstone.
- Correct the report's earlier serialized-write-only bound, owner-only sanitization, and unconditional cleanup claims.

### Verification

- `pnpm vitest run tests/unit/world-library.test.ts tests/unit/web-next-character-workspace-model.test.ts tests/unit/web-next-character-workspace-session.test.ts` — 3 files passed, 43 tests passed.
- `pnpm exec tsc --ignoreConfig --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck apps/web-next/src/character-workspace-model.ts apps/web-next/src/character-workspace-session.ts packages/contracts/src/world-library.ts tests/unit/web-next-character-workspace-model.test.ts tests/unit/web-next-character-workspace-session.test.ts` — exit 0, no diagnostics.
- `git diff --check` — exit 0, no diagnostics after the report update.

### Files changed

- `apps/web-next/src/character-workspace-session.ts`
- `tests/unit/web-next-character-workspace-session.test.ts`
- `.superpowers/sdd/2026-08-12-character-creation-workspace/task-2-report.md`

### Concerns

Projectmem MCP remains unavailable, so required file prechecks and event logging could not be performed. The pre-existing untracked `.superpowers/brainstorm/` directory remains untouched and excluded from the commit.

## Fix Round 2

Resolved the remaining credential-key boundary and cleanup-coverage findings test-first.

### RED evidence

`pnpm vitest run tests/unit/web-next-character-workspace-session.test.ts` failed 1 of 13 tests after adding safe lore keys. The session incorrectly removed `secretary`, `tokenizer`, and `passwordlessSociety`, confirming that normalized substring matching treated fragments inside unrelated words as credentials.

### Corrections

- Tokenize handoff keys at camelCase, Pascal/acronym, snake_case, kebab-case, and other non-alphanumeric boundaries before matching credential terms.
- Preserve unrelated semantic tokens such as `secretary`, `tokenizer`, and `passwordlessSociety` while continuing to remove `accessToken`, `client_secret`, `api-key`, `password`, `credentials`, and existing API-key variants.
- Exercise fail-closed consumption independently when removal of the session, return tombstone, or result record throws; no case can return the accepted result on a later consume.
- Mark the original 39-test verification as pre-fix and superseded, and make the primary final verification consistent with the 43-test result.

### Verification

- `pnpm vitest run tests/unit/world-library.test.ts tests/unit/web-next-character-workspace-model.test.ts tests/unit/web-next-character-workspace-session.test.ts` — 3 files passed, 43 tests passed, 0 failed.
- `pnpm exec tsc --ignoreConfig --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck apps/web-next/src/character-workspace-model.ts apps/web-next/src/character-workspace-session.ts packages/contracts/src/world-library.ts tests/unit/web-next-character-workspace-model.test.ts tests/unit/web-next-character-workspace-session.test.ts` — exit 0, no diagnostics.
- `git diff --check` — exit 0, no diagnostics after the round-two report update.

### Files changed

- `apps/web-next/src/character-workspace-session.ts`
- `tests/unit/web-next-character-workspace-session.test.ts`
- `.superpowers/sdd/2026-08-12-character-creation-workspace/task-2-report.md`

### Concerns

Projectmem MCP remains unavailable, so required file prechecks and event logging could not be performed. The pre-existing untracked `.superpowers/brainstorm/` directory remains untouched and excluded from the commit.
