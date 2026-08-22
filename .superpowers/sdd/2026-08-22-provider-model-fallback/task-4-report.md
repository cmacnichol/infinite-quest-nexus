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
