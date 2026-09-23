# Campaign cast phase 03 handoff

Implemented 2026-09-23 on `codex/campaign-cast`, based on `acc67a93`. The user explicitly requested the legacy UI first; the replacement Story panel is deferred. Phases 04–06 remain required work under the active goal.

## Delivered

Legacy **Setup → Characters** opens a searchable, paginated roster and sparse profile editor. Supporting characters can be added, renamed, given aliases, pinned, ignored, and edited. Explicit blanks differ from **Use discovered value**. The protagonist routes to its existing editor. Evidence uses safe text rendering, labels claims, and links to accepted turns. Native dialogs contain keyboard focus; Close/Escape restores focus to Setup and prompts before discarding changes.

`packages/client-core/src/campaign-cast-editor.ts` holds draft and revision behavior. Failed requests retain the draft and exact idempotent submission. Conflicts require comparing current server authority and explicitly reapplying only touched values. New-character conflicts refresh roster authority without pretending an unsaved ID exists. `packages/client-web/src/campaign-cast-api.ts` validates requests and responses through the existing transport. Both modules are exported through their package barrels.

`apps/web/src/campaign-cast-panel.ts` is the focused legacy renderer; `composition.ts`, `story.js`, `story.html`, and `story.css` supply integration. Fields use the established Story styling and expandable sections. Server capability loss removes save actions while preserving the open draft. Active generation blocks editing. The phase 02 error responses now use the standard typed error envelope so browser callers retain domain codes.

No database migration or provider behavior changed. `CAST_EDITING_ENABLED` remains false by default; no deployment or live campaign edits occurred.

## Verification

- RED/GREEN: missing shared editor/adapter/renderer, new-character conflict reapplication, typed API error envelopes, and the reviewed keyboard-focus regression.
- Focused shared-client/renderer tests: **7 passed**. Associated legacy Story tests also passed.
- Full unit suite: **343 files, 4,333 tests passed; 44 existing skips**.
- Browser selection: **6 passed**, comprising four cast tests and two existing legacy Story Memory tests. Cast flows cover 1440px and 390px, add/edit, aliases, blanks/reset, pin/ignore, conflicts, capability loss, duplicate names, reload, pagination, claims/source navigation, protagonist navigation, Escape, discard prompts, and focus return. No uncaught page errors or horizontal overflow in the tested cast flows.
- `corepack pnpm check`, `corepack pnpm build`, and diff/link checks passed. Existing Vite bundle-size warnings remain.
- Independent review identified focus return to a hidden menu item; a browser RED reproduced it and the fix passed. Final re-review found no remaining concrete blockers.

Browser tests run the actual legacy app through Vite with synthetic HTTP fixtures. They prove browser behavior and request wiring, not a new end-to-end PostgreSQL run; phase 02 separately verified database persistence/lifecycle. No real-provider testing applies to this editor phase. Browser plugin was unavailable, so regular Playwright was used.

Screenshots were saved outside the repository under `C:/Users/chris/.codex/visualizations/2026/09/22/01a0c782-556d-7b32-8b5d-3e61b5399891/cast/`: `roster-390.png`, `roster-1440.png`, `detail-390.png`, `detail-1440.png`, `conflict-390.png`, and `conflict-1440.png`. Roster and detail were visually inspected; the dialog remains scrollable for long profiles.

## Next phase

Phase 04 must implement durable accepted-turn discovery, evidence validation, unresolved identity decisions, retry/status controls, and lifecycle cancellation. Phase 05 must connect bounded cast authority to the actual generation request; phase 06 adds explicit history scanning. Do not claim the stored pin/ignore preferences already influence prompts.

Rollback disables editing and retains reads and portable authority. The replacement UI remains a separate deferred surface. Find this checkpoint with `git log --oneline -- docs/review/campaign-cast/phase-03.md`.
