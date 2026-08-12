# Task 6 Report — World Editor Character Workspace Integration

## Status

Implemented the World Editor unsaved-draft handoff using strict RED/GREEN TDD. Character Add/Edit now opens the shared Character Workspace with a sanitized clone of the current local draft. Accepted create/replace results update only the editor aggregate; the existing revision-checked **Save draft** remains the sole persistence boundary.

## RED Evidence

### World Editor handoff RED

```bash
pnpm vitest run tests/unit/web-next-world-editor-page.test.ts
```

Observed four expected failures: Add/Edit created no Character Workspace session, so accepted, cancellation/lifecycle, and malformed-result paths had no handoff to inspect or consume.

### Sanitized snapshot RED

```bash
pnpm vitest run tests/unit/web-next-world-editor-page.test.ts -t "opens Add from the current unsaved draft"
```

Observed the expected boundary failure: the injected store received `ownerUserId` and nested `accessToken` fields. The focused session helper now sanitizes before storage while preserving safe root, world, and character extensions.

## Completed

- Added `beginWorldEditorCharacterSession` and `applyWorldEditorCharacterResult` as the focused World Editor handoff boundary.
- Snapshot, clone, parse, and recursively sanitize the entire current unsaved draft before creating a session.
- Preserve safe unknown root, world, profile, and character fields.
- Open one opaque shared Character Workspace route from Characters **Add character** and **Edit in character workspace** actions.
- Apply accepted create/replace results immutably to the current local aggregate and mark it unsaved.
- Keep all character-specific API writes absent; **Save draft** still sends the expected world revision.
- Inspect before consume, validate the transition before consume, and consume accepted/cancelled results exactly once.
- Leave the draft unchanged for cancellation, expiry, origin/workflow mismatch, duplicate return, and disposal.
- Incorporate Task 5 malformed-result semantics: preserve invalid bytes/session state, show in-page recovery, reset only the invalid result before return, and fail closed if reset cannot be verified.
- Preserve existing collection editing, conflict recovery, revision checks, and cover behavior.
- Added durable Character Workspace rules to `DESIGN.md`, synchronized component records in `.impeccable/design.json`, corrected the World Creation stage count, and created the Character Workspace Operate-mode surface brief.

## Bounded Visual Verification

One request-intercepted Playwright batch inspected desktop/mobile and light/dark without a correction loop. Intercepted both character preview and generation-progress requests.

Verified:

- all six stages in order: Method, Identity, Story, Appearance, Mechanics, Review;
- Manual and AI-assisted controls and explicit AI generation;
- long Story and Appearance fields at 1440px with `body.scrollWidth === innerWidth`;
- Mechanics with Stats/Trackers and long detail copy in dark mode;
- Review at 390px with `body.scrollWidth === innerWidth`;
- expired-session recovery at 390px in dark mode;
- keyboard-focus paths used by generation, mechanics, review, and recovery controls.

Temporary evidence screenshots were written outside the repository under the system temp directory. No correction batch was required. The mobile stage rail intentionally scrolls within its owned region; the page itself did not overflow.

## Impeccable Detector

The required detector was run once against `character-workspace-page.ts` and `styles.css`. It reported warnings/advisories only and no feature-introduced errors:

- three side-tab warnings are intentional current-stage orientation rules documented by the Constructed Atlas design system;
- the grid advisory is the intentional atlas/measurement canvas treatment;
- type-ramp advisories are existing design-system literals in the pre-existing stylesheet.

Neither detector target changed in Task 6, so these established warnings were documented rather than churned.

## Files Changed

- `apps/web-next/src/world-editor-character-workspace.ts` — Added sanitized handoff creation and immutable accepted-result application.
- `apps/web-next/src/world-editor-page.ts` — Wired Characters Add/Edit, BFCache return handling, malformed-result recovery, exactly-once consumption, and explicit local-only announcements.
- `tests/unit/web-next-world-editor-page.test.ts` — Added Add/Edit, sanitization, accepted local apply, explicit save, cancellation, expiry, mismatch, duplicate, disposal, and malformed recovery coverage.
- `tests/unit/web-next-character-workspace-session.test.ts` — Added World Editor malformed inspect/reset/replacement/consume-once coverage.
- `apps/web-next/DESIGN.md` — Added Character Workspace stage, handoff, ledger, responsive, accessibility, and reduced-motion rules.
- `apps/web-next/.impeccable/design.json` — Added synchronized Character Workspace components and corrected World Creation to seven stages.
- `apps/web-next/.impeccable/surfaces/src-character-workspace-page-ts.md` — Added the Operate-mode surface brief.
- `.superpowers/sdd/2026-08-12-character-creation-workspace/task-6-report.md` — Recorded Task 6 evidence and concerns.

## Verification

- World Editor/session focused suite: 2 files, 63 tests passed.
- Required targeted list: 10 files passed with 267 tests; `client-api-routes.test.ts` produced its existing 48 Windows `filesystem_platform_unsupported` failures.
- `pnpm --filter @infinite-quest/web-next check` passed.
- `pnpm --filter @infinite-quest/web-next build` passed; Vite emitted only existing runtime font-resolution notices.
- `.impeccable/design.json` parsed successfully.
- `pnpm test`: 154 files passed, 13 failed; 1,810 tests passed, 131 failed, 2 skipped. Failures are the existing Windows/Linux filesystem and `/proc` incompatibilities, Windows path assumptions, and `spawnSync pnpm ENOENT` worker benchmark failure.

## Concerns

- Projectmem was explicitly unavailable, so required projectmem prechecks and event logging could not be performed.
- The repository-wide test suite remains platform-blocked on Windows; scoped web-next checks and feature tests are green.
- The pre-existing untracked `.superpowers/brainstorm/` directory was not modified and must not be committed.

## Round 1 Production-Remount Correction

### Status

Fixed the production navigation/remount gap. The World Editor now stores only an opaque `{ key, workflowId }` pointer in per-world `sessionStorage` before navigating to Character Workspace. No draft content is added to the URL or pointer. A fresh editor mount loads the authoritative world only as a safe base, validates the pointer against the live handoff, restores `session.parentDraft` and `expectedWorldRevision`, then inspects, applies, and consumes the result exactly once.

Accepted and cancelled results clear the matching pointer. Missing/expired sessions and origin, workflow, revision, or parent-route mismatches render an explicit safe editor recovery state and clear the terminal pointer without consuming a preserved mismatched session. A valid handoff with no result renders a recoverable pending state and preserves both pointer and session. Invalid or rejected results retain the existing non-destructive recovery path.

### TDD Evidence

The focused remount tests first failed 4/4 for the expected reason: no pointer was written and missing/mismatched/pending remounts rendered no recovery state. After the minimal implementation, focused World Editor and session coverage passed 72/72 tests across 2 files. Coverage includes disposal/remount, pre-handoff unsaved fields, accepted apply, cancelled restoration, expected revision 8 after an authoritative revision 11 load, conflict preservation and retry, exactly-once consume, malformed pointer rejection, missing, expired, origin mismatch, workflow mismatch, and pending-result recovery.

### Verification Correction

- `pnpm vitest run tests/unit/web-next-world-editor-page.test.ts tests/unit/web-next-character-workspace-session.test.ts`: passed, 2 files and 72 tests.
- `pnpm --filter @infinite-quest/web-next check`: passed.
- `pnpm --filter @infinite-quest/web-next build`: passed, 107 modules transformed; only the established runtime font-resolution notices were emitted.
- `pnpm check`: blocked before scoped checks by the pre-existing direct `console` write in unchanged `apps/web-next/src/world-library-page.ts`.
- `pnpm build`: blocked in the contracts root check by the repository's pre-existing NodeNext extension/configuration errors and unrelated baseline TypeScript errors. The changed web-next target builds successfully via its package command above.
- `git diff --check`: passed.
- Implementation diff before this report append: 4 files, 362 insertions, 8 deletions.
- Final correction diff: 5 files, 393 insertions, 8 deletions.
- Worktree status before commit: only the 5 intended correction files are modified; the pre-existing untracked `.superpowers/brainstorm/` directory remains excluded.

### Files Added to the Correction

- `apps/web-next/src/world-editor-character-workspace.ts` — Added strict per-world opaque pointer storage with conditional cleanup and malformed-record removal.
- `apps/web-next/src/world-editor-page.ts` — Persisted handoff identity before navigation and recovered/validated/restored it after a production remount.
- `tests/unit/web-next-world-editor-page.test.ts` — Added accepted, cancelled, conflict, missing, expired, mismatch, pending, disposal, and remount coverage.
- `tests/unit/web-next-character-workspace-session.test.ts` — Added production pointer serialization, matching-clear, and malformed-pointer tests.
