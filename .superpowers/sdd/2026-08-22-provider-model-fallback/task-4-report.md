# Task 4 Report: Provider Routing Source Editor

## Summary

Replaced the legacy Nexus single-model workflow for OpenRouter text and intent profiles with an accessible routing-source editor. It maintains an explicit ordered primary-plus-fallback plan separately from an OpenRouter preset selection, sends only the active source to the existing save API, and renders preset-derived effective models and policy as read-only information.

## Files

- `apps/web/public/provider-model-selection.js`
- `apps/web/public/index.html`
- `apps/web/public/nexus.js`
- `apps/web/public/nexus.css`
- `tests/unit/provider-model-selection.test.ts`
- `tests/unit/management-ui.test.ts`
- `tests/unit/legacy-provider-modal.test.ts`

## RED / GREEN evidence

- RED: `tests/unit/provider-model-selection.test.ts` initially failed with the requested helpers absent (7 failures), while the existing management tests remained green.
- RED: the added legacy-modal and management-editor contracts failed before the editor markup and save integration were added (2 failures).
- GREEN: the focused suite passed with 79 tests after implementation.

## Verification

- `pnpm vitest run tests/unit/provider-model-selection.test.ts tests/unit/management-ui.test.ts tests/unit/legacy-provider-modal.test.ts` could not start because the environment's `pnpm` fallback could not find `vitest`.
- Equivalent local dependency invocation passed: `./node_modules/.bin/vitest.cmd run tests/unit/provider-model-selection.test.ts tests/unit/management-ui.test.ts tests/unit/legacy-provider-modal.test.ts` — 3 files / 79 tests passed.
- `node --check apps/web/public/nexus.js` and `node --check apps/web/public/provider-model-selection.js` passed.
- `apps/web/node_modules/.bin/vite.cmd build` passed (133 modules transformed).
- `git diff --check` passed.

## Impeccable detector

`node C:\Users\chris\.agents\skills\impeccable\scripts\detect.mjs --json apps/web/public/index.html apps/web/public/nexus.js apps/web/public/nexus.css apps/web/public/provider-model-selection.js`

The detector ran in degraded regex mode because parser modules were unavailable. It reported three pre-existing warnings outside the Task 4 editor: the conditional world-cover image element in `index.html`, a transfer-finding left border in `nexus.css`, and an existing decorative grid background in `nexus.css`. No Task 4-specific detector finding was reported.

## Commit

`Add provider routing source editor` (final SHA is reported in the handoff).

## Limitations

The local Vite server ran at `http://127.0.0.1:5176/nexus/`, but the available in-app browser blocked loopback navigation with `net::ERR_BLOCKED_BY_CLIENT`; therefore the requested rendered smoke scenarios were not executed in this environment. The focused DOM contracts, pure-helper behavior, syntax checks, and production legacy build passed, but do not replace a browser smoke run.

## Fix round 1 — 2026-08-22

### Summary

Addressed the Task 4 review findings in the legacy Nexus provider editor without changing the Story Player or root historical `index.html`.

- Selecting **Import OpenRouter preset** on a new or empty profile now retains the requested preset source even before a slug is chosen, so the preset controls are immediately visible.
- A distinct manual context draft is retained when a known selection temporarily derives a minimum. Adding an unknown/custom fallback restores that draft and shows the existing manual-context warning.
- Selected models are reconciled with live discovery: unavailable models are clearly identified, and a saved-versus-draft order difference is explicitly reported.
- Resolving a preset now clears the resolved snapshot, interlocks Save, and uses a monotonic request sequence so a stale earlier response cannot replace a later selection. Check-for-update restores its prior resolved snapshot after the check.
- Moving a fallback returns keyboard focus to that model at its new index.

### Files

- `apps/web/public/provider-model-selection.js`
- `apps/web/public/nexus.js`
- `tests/unit/provider-model-selection.test.ts`
- `tests/unit/management-ui.test.ts`

### RED / GREEN evidence

- RED: new source-normalization and DOM/state-transition regressions failed before the fix, including empty OpenRouter preset activation, context-draft restoration, unavailable/order feedback, resolve interlock/race protection, and moved-item focus.
- RED: the later check-for-update preservation assertion failed before restoring the pre-check resolved snapshot.
- GREEN: `./node_modules/.bin/vitest.cmd run tests/unit/provider-model-selection.test.ts tests/unit/management-ui.test.ts tests/unit/legacy-provider-modal.test.ts` — 3 files / 84 tests passed.

### Verification

- `node --check apps/web/public/nexus.js` and `node --check apps/web/public/provider-model-selection.js` passed.
- `apps/web/node_modules/.bin/vite.cmd build` passed: Vite 7.3.6, 133 modules transformed, legacy client emitted successfully.
- `git diff --check` passed.

### Impeccable detector

Ran:

`node C:\Users\chris\.agents\skills\impeccable\scripts\detect.mjs --json apps/web/public/index.html apps/web/public/nexus.js apps/web/public/nexus.css apps/web/public/provider-model-selection.js`

The detector was degraded because parser modules (`htmlparser2`, `css-select`, `css-tree`, and `domutils`) were unavailable. It reported only the same non-Task-4 warnings: the world-cover image in `index.html`, a transfer-finding border in `nexus.css`, and an existing decorative grid background in `nexus.css`. No Task 4-specific detector finding was reported.

### Commit

- `87ad2af4d7c0a97bfa69887df9c335d724382440` — `Fix provider routing editor state`

### Limitations

The local Vite server/browser loopback smoke remains blocked by `net::ERR_BLOCKED_BY_CLIENT`; this was not bypassed. The focused DOM/state tests, syntax checks, and legacy production build passed, but a rendered browser smoke remains outstanding.
