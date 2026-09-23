# Campaign cast phase 03: cast editor implementation plan

> **For agentic workers:** Implement task-by-task with strict TDD. Use `superpowers:subagent-driven-development` when delegation is selected; otherwise execute natively. Do not start a later phase in this patch.

**Status:** Legacy implementation completed 2026-09-23. The user explicitly deferred the replacement UI. All paired-surface items below are satisfied for legacy only; see the [phase 03 handoff](../../review/campaign-cast/phase-03.md).

**Goal:** Let users create and correct supporting characters from either Story interface.

**Architecture:** Put request/state behavior in shared client modules and keep each Story surface's rendering thin. Provide a compact roster and sparse profile editor with provenance, not a relationship graph.

**Tech Stack:** TypeScript, existing native Story UI, Vitest, Playwright.

**Spec:** [Shared specification](2026-09-22-campaign-cast.md). Dependency: phase 02 accepted.

## Global constraints

Shared constraints apply. Respect server capabilities, existing navigation, safe text rendering, and protagonist editor ownership. No redesign of the reader or character authoring workspace. No browser-held authoritative cast state.

## Files and ownership

- Create `packages/client-web/src/campaign-cast-api.ts`, `packages/client-core/src/campaign-cast-editor.ts`, `apps/web-next/src/campaign-cast-panel.ts`.
- Modify `apps/web-next/src/story-player-tools.ts`, `apps/web-next/src/story-player-composition.ts`, `apps/web-next/src/story-player.css`, and `apps/web/src/story.js`; add a focused legacy renderer module if needed instead of copying the editor state machine.
- Add `tests/unit/campaign-cast-editor.test.ts`, `tests/unit/campaign-cast-api.test.ts`, and `tests/e2e/campaign-cast.e2e.test.ts`; extend affected Story composition/UI tests.
- Update `docs/player-guide/campaign-continuity.md` with cast controls and the distinction between edits and historical narration.

## Interfaces and screen behavior

```ts
type CastEditorState = {
  characterId: Id | null; draft: { name: string; aliases: string[]; profile: CastProfile };
  dirty: boolean; saving: boolean; conflict: boolean; error: string | null;
};
function canSaveCastEditor(state: CastEditorState): boolean;
```

The browser adapter consumes phase 02 routes and revisions. A **Characters** entry opens a paginated/searchable list with name, role, last seen turn, and manual/discovered source. Protagonist row links to its existing editor. Supporting-character detail includes identity/aliases, sparse profile fields, source-turn links, pin/ignore controls, Save and Cancel. Empty cast offers **Add character**. Do not show absent field values as generated suggestions.

## Review focus

Unsaved edits on navigation; stale revision conflicts; mobile long names; unsafe narrative markup; server capability disabled during an open editor.

## Task 1: shared editor behavior and HTTP adapter

- [x] Test empty name, blank override, dirty state, saving state, conflict state, and cancellation before implementing the state model.

```ts
expect(canSaveCastEditor({
  characterId: null, draft: { name: "Mara", aliases: [], profile: {} },
  dirty: true, saving: false, conflict: true, error: null
})).toBe(false);
```

- [x] Ensure every write carries the loaded revision, boundary, and a stable per-submit idempotency key. Retry the same request with the same key; an intentionally changed submission receives a new key.
- [x] Keep user drafts on network failure or 409. Offer reload/latest comparison and explicit reapplication; never silently overwrite a newer server record. Distinguish clearing a field from removing an override with **Use discovered value**.
- [x] Run the two new unit suites RED/GREEN and commit the shared model/adapter.

## Task 2: render both Story surfaces

- [x] Add Characters to both tool menus and connect the same API/state behavior. Handle loading, empty, disabled, not-found, failed, ignored, and active-generation edit-blocked states.
- [x] Render evidence as text and links to existing turn navigation. Display claims as claims and unresolved identity information without suggesting automatic merges. No raw HTML insertion from names, field values, or quotes.
- [x] Provide labeled controls, keyboard focus containment/return, Escape behavior, readable validation errors, and unsaved-draft navigation protection. Preserve draft values across expandable sections.
- [x] Add browser tests for manual add/edit, aliases, explicit blank/reset override, duplicate display names, conflict draft preservation, protagonist navigation, pin/ignore, and capability loss.
- [x] Run `corepack pnpm exec playwright test tests/e2e/campaign-cast.e2e.test.ts` against both `/story` and `/app/story`, desktop and 390px mobile width. Capture screenshots of roster, detail, and conflict states. Use disposable fixtures, not private campaign data.
- [x] Run affected Story UI/composition unit tests and type/build checks; commit with screenshot paths in the handoff.

## Exit gate and rollback

A user can add, find, edit, clear, restore discovered values, pin, and ignore a supporting character on both surfaces. Reload proves persistence. No relationships or auto-discovery are claimed. Disabling `castEditing` removes mutation actions and preserves readable data; all saved character information remains exportable.
