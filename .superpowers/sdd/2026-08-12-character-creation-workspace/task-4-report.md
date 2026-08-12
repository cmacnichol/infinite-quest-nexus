# Task 4 Report — Full-page Character Workspace

## Status

Implemented the reusable `/app/characters/:sessionKey` Character Workspace using strict RED/GREEN TDD. The route resolves before world detail routes and consumes the Task 1 model, Task 2 session lifecycle, and Task 3 preview/progress API.

## RED Evidence

### Page behavior RED

```bash
pnpm vitest run tests/unit/web-next-character-workspace-page.test.ts
```

Observed expected failure: Vitest could not resolve `apps/web-next/src/character-workspace-page.js`; zero tests ran because the production page module did not exist.

### Design contract RED

```bash
pnpm vitest run tests/unit/web-next-theme.test.ts -t "compact Character Workspace"
```

Observed expected failure: the `.character-method-control` rule was absent, so the required 48px compact control assertion failed.

## Completed

- Added missing/expired-session recovery with a validated return destination.
- Added all six semantic stages: Method, Identity, Story, Appearance, Mechanics, and Review.
- Added compact Manual/AI radio controls and a synchronized compact/expanded prompt editor.
- Kept prompt typing local; generation starts only from the explicit action.
- Added bounded progress polling, cancellation, retry, terminal failure copy, abort propagation, stale-result isolation, and disposal cleanup.
- Applied generated output only after completion and asks for replacement confirmation only when candidate fields already contain local content.
- Kept generated fields editable and the trusted local character ID read-only.
- Added exact validation recovery with `aria-invalid`, adjacent error copy, and focus on the affected control.
- Added clipboard copy/paste announcements while preserving prompt focus and copy selection.
- Added protected dialog focus, Tab wrapping, Escape closure, and focus restoration to Expand.
- Added mechanics master-detail editing using the existing structured field adapters so unknown item fields survive edits.
- Added factual Review counts, provenance, warnings, and safe return links.
- Added duplicate-proof, single-attempt acceptance and explicit cancellation through the session store.
- Added dirty-navigation guarding and complete listener/controller/timer/theme disposal.
- Added scoped semantic-token-only `.character-*` CSS with 48px methods, 44px actions, 52px stages, stacked fields, equal compact ledger actions, full-width mobile bottom dialog, visible focus, horizontal compact stages, square geometry, and reduced motion.
- Added route precedence in `bootstrap.ts` before world editor route handling.

## Files Changed

- `apps/web-next/src/character-workspace-page.ts` — Added the reusable Character Workspace page and lifecycle orchestration.
- `apps/web-next/src/bootstrap.ts` — Mounted the character route before world detail routes.
- `apps/web-next/src/styles.css` — Appended scoped Character Workspace layout, controls, states, responsive behavior, and accessibility rules.
- `tests/unit/web-next-character-workspace-page.test.ts` — Added page behavior, concurrency, lifecycle, passthrough, and accessibility coverage.
- `tests/unit/web-next-theme.test.ts` — Added the Character Workspace design contract.
- `.superpowers/sdd/2026-08-12-character-creation-workspace/task-4-report.md` — Recorded TDD and verification evidence.

## Verification

```bash
pnpm vitest run tests/unit/web-next-character-workspace-model.test.ts tests/unit/web-next-character-workspace-session.test.ts tests/unit/web-next-character-workspace-api.test.ts tests/unit/web-next-character-workspace-page.test.ts tests/unit/web-next-theme.test.ts
```

Result: 5 files passed; 80 tests passed, 0 failed.

```bash
pnpm --filter @infinite-quest/web-next check
```

Result: exit 0 with no TypeScript diagnostics.

```bash
git diff --check
```

Result: exit 0 with no whitespace diagnostics.

The Impeccable mechanical detector was run once over all changed UI/test targets. Its new side-tab warning was corrected by replacing the Character Workspace current-stage border with an inset orientation rule. New off-ramp typography values were aligned to the documented type ramp. Remaining detector advisories point to pre-existing stylesheet lines outside the appended Character Workspace block.

## Concerns

- Projectmem was explicitly unavailable, so required projectmem prechecks and event logging could not be performed.
- The harness exposes no subagent tool, so the optional external visual finish reviewer could not be invoked. Verification used the contract tests, mechanical detector, and in-thread diff review.
- No browser screenshot harness was available in this task environment; responsive and accessibility behavior is covered through DOM and CSS contract tests rather than screenshot comparison.
- The pre-existing untracked `.superpowers/brainstorm/` directory remains untouched and excluded from the commit.

## Fix Round 1

Addressed every review finding test-first:

- Replaced Review interpolation of candidate values with DOM construction and `textContent`; hostile character names now remain literal text and cannot create elements.
- Made terminal failed progress authoritative: it aborts and invalidates the preview request, stops polling, preserves prompt/candidate data, displays fixed safe retry copy, restores Generate, hides Cancel, and ignores late preview completion.
- Uses native `showModal()` / `close()` when available. The fallback isolates the background with `inert`, blocks background pointer actions, redirects programmatic focus, retains keyboard trapping, and restores focus on close.
- Excludes the current candidate ID from the edit-mode duplicate roster.
- Maps mechanics collection bound errors to their visible Stats or Trackers target, with `aria-invalid`, `aria-describedby`, adjacent copy, and exact focus recovery.
- Named and disposal-guarded listeners, removed root/dialog/document listeners on disposal, and verified detached input cannot restore the `beforeunload` guard.
- Added a bootstrap integration regression proving `/app/characters/:sessionKey` wins route selection.

### RED evidence

`pnpm vitest run tests/unit/web-next-character-workspace-page.test.ts` initially reported 6 expected failures covering hostile markup, terminal progress, modal protection, edit duplication, mechanics error focus, and post-disposal input. The route precedence test was then added before final verification.

### Fix-round verification

```bash
pnpm vitest run tests/unit/web-next-character-workspace-model.test.ts tests/unit/web-next-character-workspace-session.test.ts tests/unit/web-next-character-workspace-api.test.ts tests/unit/web-next-character-workspace-page.test.ts tests/unit/web-next-world-library.test.ts tests/unit/web-next-theme.test.ts
```

Result: 6 files passed; 95 tests passed, 0 failed.

```bash
pnpm --filter @infinite-quest/web-next check
```

Result: exit 0 with no TypeScript diagnostics.

```bash
git diff --check
```

Result: exit 0 with no whitespace diagnostics.
