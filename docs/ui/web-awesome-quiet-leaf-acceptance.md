# Quiet Leaf implementation acceptance

Status: implementation in progress; **not released or default-enabled**.

## Compatibility finding — 2026-08-30

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

It fails after opening the visible dialog. The in-app browser independently
showed an unnamed dialog containing the named heading. No vendor shadow-tree
mutation or weakened accessible-name assertion is accepted as a fix.

The user has been asked whether to retain native dialogs while using Core for
other controls. Until that decision and a passing compatibility check, do not
migrate the application or enable Core by default.

An earlier fixture-only bootstrap deadlock was resolved: a top-level awaited
loader and Vite's shared-entry exports formed an evaluation cycle. Starting an
async `main()` without awaiting it at module top level allows initialization to
complete. This is separate from the remaining accessibility failure.

## Current evidence

| Gate | Status | Evidence |
| --- | --- | --- |
| G1 Core/CSP | **Blocked** | Production fixture builds; controls render and text input works in the in-app browser. Named-dialog assertion fails in Chromium. Full Core/CSP interaction suite is not passed. |
| G2 theme/preferences | Partial | Theme suite:43 passed. Display preferences:14 passed. Token adapter browser state/contrast verification remains pending. |
| G3 component behavior | Partial | Draft-field suite:8 passed; reviewed unique description IDs and composition conflict policy. Real sizing/caret/IME checks remain pending. |
| G4 Story regression | Baseline only | Existing composer and route suites:28 passed before Story integration. No Core Story integration has been performed. |
| G5 runtime/visual approval | Not run | No disposable runtime parity run or implemented-design approval yet. Existing smoke rows remain unchanged. |
| G6 bundle/rollback | Not run | Native default retained; no default-on change or deployment. Comparative bundle and container rollback verification pending. |

These are focused implementation results, not an assertion that the entire
repository, PostgreSQL integration suite, provider workflow, or browser matrix
has passed. Final candidate SHA, browser/package versions, exact commands,
screenshots, full smoke evidence, and bundle deltas must be recorded after the
compatibility decision and remaining implementation tasks.

Latest coordinator verification: the six focused suites (theme, display
preferences, draft field, feature policy, existing Story composer, existing
Story route) passed **94 tests** together. The web-next package's documented
TypeScript check also passed after workspace dependency links were repaired.
`git diff --check` was clean. These checks do not include the incomplete input
mode component or resolve the failing browser gate.

## Scope and safety

- Work is confined to linked worktree `823c`; main and deployed services are unchanged.
- Core is pinned; no CDN, Pro dependency, new backend API, or CSP exception added.
- Browser display preferences do not modify authoritative campaigns or profile APIs.
- Existing design artifacts and unrelated untracked files are preserved.
- Production Docker services were inspected read-only; no private campaign or volume was modified.
