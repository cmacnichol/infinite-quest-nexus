# Quiet Leaf implementation acceptance

Status: implementation in progress; **not released or default-enabled**.

## Retired vendor-dialog compatibility finding — 2026-08-30

The pinned `@awesome.me/webawesome` 3.12.0 dialog renders a visible title but
does not assign an accessible name to its internal native `<dialog>`. The
installed `dist/chunks/chunk.WNMOBTJK.js` render function supplies neither
`aria-label` nor `aria-labelledby` on that element. Adding `aria-label` to the
custom-element host did not label the internal dialog in Chromium.

The production-build fixture reproduced this with the unchanged application
CSP. The strict browser assertion is deliberately retained:

```ts
page.getByRole("dialog", { name: "Campaign Settings" })
```

Historically, it failed after opening the visible dialog. The in-app browser
independently showed an unnamed dialog containing the named heading. No vendor
shadow-tree mutation or weakened accessible-name assertion was accepted as a
fix.

The user accepted a bounded fallback: retain Core 3.12.0 for controls and use
the application-owned native `mountDialog()` wrapper for overlays. The wrapper
creates a labelled native `<dialog>`, uses `showModal()`/`close()`, provides an
explicit Close button, and restores a connected opener after native closure.
It does not manipulate the vendor shadow tree or implement a custom focus trap.
The incompatible `wa-dialog` import has been removed from the selected Core
stack. The upstream Core finding remains relevant if `wa-dialog` is considered
again.

An earlier fixture-only bootstrap deadlock was resolved: a top-level awaited
loader and Vite's shared-entry exports formed an evaluation cycle. Starting an
async `main()` without awaiting it at module top level allows initialization to
complete. This is separate from the retired vendor-dialog accessibility path.

## Current evidence

| Gate | Status | Evidence |
| --- | --- | --- |
| G1 Core/CSP | **Pass (scoped compatibility gate)** | Chromium production fixture passes the strict named native-dialog assertion, Close-button focus entry, Escape close, and opener restoration. It also proves the unchanged CSP, no console/CSP errors, no external requests, the exact same-origin `regular/circle-question.svg` request and rendered SVG, input host value, disabled behavior, and one dropdown selection callback. |
| G2 theme/preferences | Partial | Theme suite:43 passed. Display preferences:14 passed. Token adapter browser state/contrast verification remains pending. |
| G3 component behavior | Partial | Draft-field suite:8 passed; input-mode suite:5 passed. Both leaf components reviewed. Real sizing/caret/IME and radio keyboard checks remain pending. |
| G4 Story regression | Baseline only | Existing composer and route suites:28 passed before Story integration. No Core Story integration has been performed. |
| G5 runtime/visual approval | Not run | No disposable runtime parity run or implemented-design approval yet. Existing smoke rows remain unchanged. |
| G6 bundle/rollback | Not run | Native default retained; no default-on change or deployment. Comparative bundle and container rollback verification pending. |

The scoped G1 evidence is `pnpm exec playwright test --config
playwright.web-awesome.config.ts tests/e2e/web-awesome-core.e2e.test.ts`, run
after `pnpm --filter '@infinite-quest/web-next' exec vite build --config
../../tests/ui/vite.config.ts`; it passed 1 test on 2026-08-30. The wrapper's
focused LinkeDOM suite passed 4 tests. These are focused implementation
results, not an assertion that the entire repository, PostgreSQL integration
suite, provider workflow, or browser matrix has passed. Final candidate SHA,
browser/package versions, screenshots, full smoke evidence, and bundle deltas
remain required for later gates.

Latest coordinator verification: the seven focused suites (theme, display
preferences, draft field, input mode, feature policy, existing Story composer,
existing Story route) passed **99 tests** together. The web-next package's documented
TypeScript check also passed after workspace dependency links were repaired.
`git diff --check` was clean. These checks preceded and are independent from
the now-passed focused G1 browser gate.

## Scope and safety

- Work is confined to linked worktree `823c`; main and deployed services are unchanged.
- Core is pinned; no CDN, Pro dependency, new backend API, or CSP exception added.
- Browser display preferences do not modify authoritative campaigns or profile APIs.
- Existing design artifacts and unrelated untracked files are preserved.
- Production Docker services were inspected read-only; no private campaign or volume was modified.
