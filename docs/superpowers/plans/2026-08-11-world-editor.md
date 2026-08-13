# World Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a routed, accessible World Edit Page that edits and explicitly saves every mutable world-draft area while preserving immutable published versions, campaign isolation, and unknown imported fields.

**Architecture:** Keep `bootstrap.ts` as a small route compositor, move page behavior into focused World Library and World Editor modules, and keep parsing/state transitions as pure testable functions. The editor loads the owner-scoped world aggregate directly from the existing API, edits a cloned canonical draft locally, and sends one revision-checked update only when the user activates Save draft.

**Tech Stack:** TypeScript, DOM APIs, Vite, Vitest, LinkeDOM, existing REST endpoints, existing semantic CSS theme contract.

## Global Constraints

- Build in `C:/Git/InfiniteQuest/.worktrees/web-theme-system` on `feature/world-editor`; do not modify the legacy `index.html` application.
- Use two-space indentation and preserve the established Constructed Atlas Grid, square controls, self-hosted typography, light/dark semantic tokens, reduced-motion behavior, and 44px minimum touch targets.
- Each World Library card links to `/app/worlds/:worldId`; no browser-provided `user_id` is accepted or sent.
- Published world versions are immutable and existing campaigns remain unchanged; the editor writes only the current draft through `PUT /api/v1/worlds/:worldId/draft` with `expectedRevision`.
- Saving is explicit. Unknown imported properties must survive structured edits and successful saves.
- Cover management remains independent of story-world draft persistence and optional image-provider availability cannot block draft saves.
- Follow TDD for every behavior: add one failing test, run it and verify the expected failure, add minimal implementation, and rerun to green before refactoring.
- Run only bounded visual verification: one batched desktop/mobile inspection, one batched correction, and at most one confirmation inspection.

---

### Task 1: Route and world-data boundary

**Files:**
- Create: `apps/web-next/src/world-editor-model.ts`
- Modify: `apps/web-next/src/world-library.ts`
- Modify: `apps/web-next/src/bootstrap.ts`
- Test: `tests/unit/web-next-world-editor-model.test.ts`
- Test: `tests/unit/web-next-world-library.test.ts`

**Interfaces:**
- Produces: `worldEditorPath(worldId: string): string`.
- Produces: `worldIdFromPath(pathname: string): string | null`.
- Produces: `parseWorldAggregate(value: unknown): WorldAggregate`.
- Produces: `cloneWorldDraft(world: WorldAggregate): EditableWorldDraft`.
- `WorldAggregate` includes root metadata, nullable `draftRevision`, nullable canonical `draftContent`, `versions`, and `campaigns` from `GET /api/v1/worlds/:worldId`.

- [ ] **Step 1: Write failing route and aggregate-boundary tests**

Add tests that express the public behavior:

```ts
expect(worldEditorPath("world / 1")).toBe("/app/worlds/world%20%2F%201");
expect(worldIdFromPath("/app/worlds/22222222-2222-4222-8222-222222222222")).toBe(
  "22222222-2222-4222-8222-222222222222"
);
expect(worldIdFromPath("/app/")).toBeNull();

const aggregate = parseWorldAggregate(worldAggregateFixture);
expect(aggregate.draftRevision).toBe(8);
expect(aggregate.draftContent?.world.title).toBe("The Glass Observatory");
expect(() => parseWorldAggregate({ id: "missing" })).toThrow("unexpected world response");

const draft = cloneWorldDraft(aggregate);
draft.world.title = "Changed locally";
expect(aggregate.draftContent?.world.title).toBe("The Glass Observatory");
```

Update the existing World Library test to expect its card destination helper to use the replacement route.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/web-next-world-editor-model.test.ts tests/unit/web-next-world-library.test.ts
```

Expected: FAIL because the route helpers, aggregate parser, and draft clone do not exist.

- [ ] **Step 3: Implement the minimal boundary**

Create strict root-field parsing without dropping nested passthrough data. Validate strings, status, draft revision, world overview, arrays, version summaries, and campaign summaries. `cloneWorldDraft` must use `structuredClone` when available and a JSON clone fallback, set `schemaVersion: 5`, and create an empty draft when the aggregate has no draft content.

Change World Library cards from the legacy query destination to:

```ts
link.href = worldEditorPath(world.id);
```

Add route recognition in `bootstrap.ts`, but do not render the editor yet; expose a temporary routed loading region containing `data-page="world-editor"` so the route test has a real integration seam.

- [ ] **Step 4: Run tests and checks to verify GREEN**

Run:

```bash
pnpm exec vitest run tests/unit/web-next-world-editor-model.test.ts tests/unit/web-next-world-library.test.ts
pnpm --filter @infinite-quest/web-next check
```

Expected: all selected tests and TypeScript checks pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/bootstrap.ts apps/web-next/src/world-library.ts apps/web-next/src/world-editor-model.ts tests/unit/web-next-world-editor-model.test.ts tests/unit/web-next-world-library.test.ts
git commit -m "Add world editor route boundary"
```

---

### Task 2: Explicit draft state and API operations

**Files:**
- Create: `apps/web-next/src/world-editor-state.ts`
- Create: `apps/web-next/src/world-editor-api.ts`
- Test: `tests/unit/web-next-world-editor-state.test.ts`
- Test: `tests/unit/web-next-world-editor-api.test.ts`

**Interfaces:**
- Consumes: `WorldAggregate` and `EditableWorldDraft` from Task 1.
- Produces: `createWorldEditorState(world: WorldAggregate): WorldEditorState`.
- Produces: pure `editWorldDraft`, `removeCollectionItem`, `restoreCollectionItem`, `validateWorldDraft`, `draftReadiness`, `beginDraftSave`, `completeDraftSave`, and `failDraftSave` transitions.
- Produces: `loadWorld(worldId, signal?)`, `saveWorldDraft(worldId, expectedRevision, draft, signal?)`, `setWorldCoverAsset(worldId, assetId, signal?)`, and typed `WorldEditorApiError`.

- [ ] **Step 1: Write failing state tests**

Cover one behavior per test:

```ts
const state = createWorldEditorState(worldAggregateFixture);
const edited = editWorldDraft(state, ["world", "premise"], "A changed premise");
expect(edited.status).toBe("unsaved");
expect(state.draft.world.premise).not.toBe("A changed premise");

const removed = removeCollectionItem(state, "entities", 0);
expect(removed.draft.entities).toHaveLength(0);
expect(removed.pendingRemovals).toHaveLength(1);
expect(restoreCollectionItem(removed, removed.pendingRemovals[0]!.id).draft.entities).toHaveLength(1);

expect(validateWorldDraft(editWorldDraft(state, ["world", "title"], "")).issues[0]?.path).toBe("world.title");
expect(beginDraftSave(state).status).toBe("saving");
expect(completeDraftSave(beginDraftSave(state), { revision: 9, content: state.draft }).status).toBe("saved");
expect(failDraftSave(beginDraftSave(state), "conflict", "Reload required").draft).toEqual(state.draft);
```

Verify `draftReadiness` reports all five sections, warning counts, and preserved-unknown-data notices.

- [ ] **Step 2: Run state tests and verify RED**

```bash
pnpm exec vitest run tests/unit/web-next-world-editor-state.test.ts
```

Expected: FAIL because the state module does not exist.

- [ ] **Step 3: Implement immutable state transitions**

Keep authoritative aggregate data separate from the editable clone. Removal records carry collection name, original index, value, and opaque local id so Undo restores the exact item before save. Validation requires a non-empty title, rejects malformed advanced JSON before it reaches state, and returns stable field paths for focus management. Readiness reports `{ section, ready, issueCount }` for Overview, Characters, Canon, Mechanics, and Assets.

- [ ] **Step 4: Run state tests and verify GREEN**

```bash
pnpm exec vitest run tests/unit/web-next-world-editor-state.test.ts
```

Expected: all state tests pass.

- [ ] **Step 5: Write failing API tests**

Stub `globalThis.fetch` and assert real request contracts:

```ts
await saveWorldDraft(worldId, 8, draft);
expect(fetch).toHaveBeenCalledWith(`/api/v1/worlds/${worldId}/draft`, expect.objectContaining({
  method: "PUT",
  body: JSON.stringify({ expectedRevision: 8, title: draft.world.title, content: draft })
}));
```

Also test encoded ids, `Accept`/`Content-Type` headers, abort propagation, a parsed 409 conflict with local draft untouched by the API layer, 404 distinction, malformed success responses, and cover requests using `PUT /api/v1/worlds/:worldId/cover-asset` independently.

- [ ] **Step 6: Run API tests and verify RED**

```bash
pnpm exec vitest run tests/unit/web-next-world-editor-api.test.ts
```

Expected: FAIL because the API module does not exist.

- [ ] **Step 7: Implement and verify the API boundary**

Implement dependency-free fetch functions and parse every JSON response through Task 1 boundaries or narrow response parsers. Never include owner identity in headers, query parameters, or bodies.

Run:

```bash
pnpm exec vitest run tests/unit/web-next-world-editor-state.test.ts tests/unit/web-next-world-editor-api.test.ts
pnpm --filter @infinite-quest/web-next check
```

Expected: all selected tests and checks pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web-next/src/world-editor-state.ts apps/web-next/src/world-editor-api.ts tests/unit/web-next-world-editor-state.test.ts tests/unit/web-next-world-editor-api.test.ts
git commit -m "Add explicit world draft state"
```

---

### Task 3: Routed editor shell, Overview, and save lifecycle

**Files:**
- Create: `apps/web-next/src/app-shell.ts`
- Create: `apps/web-next/src/world-library-page.ts`
- Create: `apps/web-next/src/world-editor-page.ts`
- Modify: `apps/web-next/src/bootstrap.ts`
- Test: `tests/unit/web-next-world-editor-page.test.ts`
- Modify: `tests/unit/web-next-world-library.test.ts`
- Modify: `tests/unit/web-next-theme.test.ts`

**Interfaces:**
- Consumes: route/model/state/API modules from Tasks 1–2.
- Produces: `renderAppShell(root, pageMarkup, currentNavigation)` and `initializeAppTheme(root)`.
- Produces: `mountWorldLibraryPage(root)` preserving existing World Library behavior.
- Produces: `mountWorldEditorPage(root, worldId, dependencies?)` returning `{ dispose(): void }` for listener and request cleanup.

- [ ] **Step 1: Write failing DOM tests for the routed shell**

Use LinkeDOM and injected API dependencies. Assert that the editor:

```ts
expect(document.querySelector('[data-page="world-editor"]')).not.toBeNull();
expect(document.querySelector('a[href="/app/"]')?.textContent).toContain("World Library");
expect(document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.disabled).toBe(true);
expect(document.querySelector('[data-editor-section="overview"]')).not.toBeNull();
expect(document.querySelector('[data-draft-ledger]')).not.toBeNull();
```

Test loading, retryable failure, not-found, no-draft initialization, archived read-only mode, populated Overview values, and preservation of the global theme toggle. Assert the library extraction keeps search, filtering, retry, artwork fallback, and theme lifecycle behavior.

- [ ] **Step 2: Run page tests and verify RED**

```bash
pnpm exec vitest run tests/unit/web-next-world-editor-page.test.ts tests/unit/web-next-world-library.test.ts tests/unit/web-next-theme.test.ts
```

Expected: FAIL because the shell and editor page modules do not exist.

- [ ] **Step 3: Extract the shared shell without behavior changes**

Move shared header/footer markup and theme initialization out of `bootstrap.ts`. Move current World Library loading and rendering into `world-library-page.ts`. Keep the same selectors and copy where existing tests depend on them. `bootstrap.ts` chooses exactly one page based on `worldIdFromPath(location.pathname)` and disposes the mounted page on non-persisted `pagehide`.

- [ ] **Step 4: Render the editor command row and Overview**

Render visible labels for title, genre, tone, premise, background story, first action, and rules. Keep Save draft in the far-right command cell. The left section index selects one major section with `aria-current="page"`; the collapsed bottom ledger exposes state, revision, readiness, warnings, and an `aria-expanded` drawer button.

- [ ] **Step 5: Wire dirty tracking, explicit save, and conflict recovery**

Input events update immutable state but never fetch. Save validates, focuses the first invalid field, announces saving, calls the API once, and adopts the returned revision/content. A 409 opens an in-page conflict region (not a modal), preserves local fields, focuses its heading, and provides **Copy unsaved draft**, **Download unsaved draft**, and confirmed **Reload authoritative draft** actions. Install and dispose `beforeunload` only while dirty.

- [ ] **Step 6: Run tests and checks to verify GREEN**

```bash
pnpm exec vitest run tests/unit/web-next-world-editor-page.test.ts tests/unit/web-next-world-library.test.ts tests/unit/web-next-theme.test.ts
pnpm --filter @infinite-quest/web-next check
```

Expected: all selected tests and checks pass.

- [ ] **Step 7: Commit**

```bash
git add apps/web-next/src/app-shell.ts apps/web-next/src/world-library-page.ts apps/web-next/src/world-editor-page.ts apps/web-next/src/bootstrap.ts tests/unit/web-next-world-editor-page.test.ts tests/unit/web-next-world-library.test.ts tests/unit/web-next-theme.test.ts
git commit -m "Build world draft editor shell"
```

---

### Task 4: Structured collections, preserved extras, and cover assets

**Files:**
- Create: `apps/web-next/src/world-editor-fields.ts`
- Modify: `apps/web-next/src/world-editor-page.ts`
- Modify: `apps/web-next/src/world-editor-state.ts`
- Modify: `apps/web-next/src/world-editor-api.ts`
- Test: `tests/unit/web-next-world-editor-fields.test.ts`
- Modify: `tests/unit/web-next-world-editor-page.test.ts`
- Modify: `tests/unit/web-next-world-editor-state.test.ts`
- Modify: `tests/unit/web-next-world-editor-api.test.ts`

**Interfaces:**
- Produces: `collectionItemSummary`, `structuredFieldsFor`, `mergeStructuredFields`, `parseAdvancedJson`, and `serializeAdvancedJson`.
- Structured aliases:
  - entity: `name|title`, `type|kind`, `description|notes`;
  - relationship: `source|from|sourceId`, `target|to|targetId`, `type|kind`, `description|notes`;
  - stat: `name|skill|stat`, `value|score|rating`, `note|covers`;
  - trigger: `name|title|label`, `condition|when`, `effect|then|rules`.
- Character structured fields include name, narrative guidance, profile groups, stats, and default trackers; all passthrough keys survive merges.

- [ ] **Step 1: Write failing field-adapter tests**

Assert aliases display without rewriting their original key, structured changes merge into cloned records, unknown keys survive, invalid JSON returns a field error rather than throwing through the UI, JSON roots have the expected object/array shape, and summaries remain useful for empty or legacy records.

- [ ] **Step 2: Run field tests and verify RED**

```bash
pnpm exec vitest run tests/unit/web-next-world-editor-fields.test.ts
```

Expected: FAIL because field adapters do not exist.

- [ ] **Step 3: Implement field adapters and verify GREEN**

Implement pure adapters without schema invention beyond the aliases listed above.

```bash
pnpm exec vitest run tests/unit/web-next-world-editor-fields.test.ts
```

Expected: all field tests pass.

- [ ] **Step 4: Write failing page tests for all editor sections**

Cover section switching, searchable bounded lists, selecting one item for editing, adding records, reversible removal, advanced JSON disclosure, character profile fields, Canon entity/relationship switches, Mechanics collection switches, defaults JSON, Assets JSON, cover keep/remove/select-by-authorized-asset-id, and independent cover failure messaging after a successful draft save.

Assert large fixtures render at most 100 list rows until the search narrows them, while result counts report the complete collection size.

- [ ] **Step 5: Run page/API/state tests and verify RED**

```bash
pnpm exec vitest run tests/unit/web-next-world-editor-page.test.ts tests/unit/web-next-world-editor-state.test.ts tests/unit/web-next-world-editor-api.test.ts
```

Expected: FAIL on the new collection and asset behaviors.

- [ ] **Step 6: Implement the five-section editor**

Use one reusable master-detail collection editor within the existing canvas, not nested cards or modals. Render at most 100 matching summaries and keep the selected record’s form mounted. Add/remove/update operations remain local until Save draft. The Assets section shows current artwork without retinting it, supports keeping/removing the cover and attaching an authorized retained asset id, and edits the draft `assets` array through structured summaries plus advanced JSON. Execute cover changes only after a successful draft save; report cover failure independently and keep the draft marked saved.

- [ ] **Step 7: Verify all editor behavior**

```bash
pnpm exec vitest run tests/unit/web-next-world-editor-fields.test.ts tests/unit/web-next-world-editor-page.test.ts tests/unit/web-next-world-editor-state.test.ts tests/unit/web-next-world-editor-api.test.ts
pnpm --filter @infinite-quest/web-next check
```

Expected: all selected tests and checks pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web-next/src/world-editor-fields.ts apps/web-next/src/world-editor-page.ts apps/web-next/src/world-editor-state.ts apps/web-next/src/world-editor-api.ts tests/unit/web-next-world-editor-fields.test.ts tests/unit/web-next-world-editor-page.test.ts tests/unit/web-next-world-editor-state.test.ts tests/unit/web-next-world-editor-api.test.ts
git commit -m "Complete world draft authoring"
```

---

### Task 5: Responsive visual system, documentation, and bounded verification

**Files:**
- Modify: `apps/web-next/src/styles.css`
- Modify: `apps/web-next/DESIGN.md`
- Modify: `apps/web-next/.impeccable/design.json`
- Create: `apps/web-next/.impeccable/surfaces/src-world-editor-page-ts.md`
- Test: `tests/unit/web-next-world-editor-design.test.ts`
- Modify: `tests/unit/web-next-theme.test.ts`

**Interfaces:**
- Consumes the DOM contract from Tasks 3–4.
- Produces the final desktop left-index/canvas/bottom-drawer layout and mobile command-row/section-switcher/full-width drawer recomposition.

- [ ] **Step 1: Write failing design-contract tests**

Assert the stylesheet provides:

```ts
expect(css).toMatch(/\.editor-command-row\s*\{/);
expect(css).toMatch(/\.draft-ledger\s*\{/);
expect(css).toMatch(/\.editor-section-index[^}]*min-height:\s*44px/s);
expect(css).toMatch(/@media\s*\(max-width:\s*720px\)/);
```

Also assert editor selectors consume semantic color tokens rather than literal theme colors, focus-visible states exist for section/drawer/collection controls, form controls use visible error styles, artwork uses `--artwork-overlay`, and reduced-motion rules include the drawer.

- [ ] **Step 2: Run design tests and verify RED**

```bash
pnpm exec vitest run tests/unit/web-next-world-editor-design.test.ts tests/unit/web-next-theme.test.ts
```

Expected: FAIL because editor styling and durable design documentation do not exist.

- [ ] **Step 3: Implement desktop and mobile styling**

Build the selected Draft Ledger composition with visible construction rules and no ambient card shadows. Keep prose controls within a readable measure, allow long-form textareas to grow, retain square borders, reserve accent fill for active/action states, and avoid section-number decoration. On mobile, place Save draft in the command row, convert the left index into a horizontal section switcher, and expand the ledger as a full-width sheet without covering the focused field.

- [ ] **Step 4: Update durable design records**

Document the reusable Editor Command Row, Section Index, Master-Detail Collection Editor, field/error behavior, and Draft Ledger in `DESIGN.md` and `.impeccable/design.json`. Write the surface brief with Operate mode, draft-only scope, selected Bottom Drawer direction, state requirements, and responsive behavior.

- [ ] **Step 5: Run automated verification**

```bash
pnpm exec vitest run tests/unit/web-next-world-library.test.ts tests/unit/web-next-theme.test.ts tests/unit/web-next-world-editor-model.test.ts tests/unit/web-next-world-editor-state.test.ts tests/unit/web-next-world-editor-api.test.ts tests/unit/web-next-world-editor-fields.test.ts tests/unit/web-next-world-editor-page.test.ts tests/unit/web-next-world-editor-design.test.ts tests/unit/web-next-build-contract.test.ts tests/unit/web-request-security.test.ts
pnpm --filter @infinite-quest/web-next check
pnpm --filter @infinite-quest/web-next build
git diff --check
```

Expected: all targeted tests, TypeScript checks, production build, and whitespace checks pass. Existing Vite unresolved font warnings may be reported but must not become new build failures.

- [ ] **Step 6: Perform bounded visual verification**

Start the API-backed application, capture desktop at 1440×1000 and mobile at 390×844 in both themes, and inspect them together for overflow, hierarchy, labels, focus, loading, empty collection, validation, expanded ledger, and artwork treatment. Apply one batched correction. Capture one final desktop/mobile confirmation and stop visual iteration.

- [ ] **Step 7: Run detector and final targeted verification**

```bash
node C:/Git/InfiniteQuest/.agents/skills/impeccable/scripts/detect.mjs --json apps/web-next/src/world-editor-page.ts apps/web-next/src/styles.css
pnpm exec vitest run tests/unit/web-next-world-editor-design.test.ts tests/unit/web-next-world-editor-page.test.ts tests/unit/web-next-theme.test.ts
pnpm --filter @infinite-quest/web-next check
pnpm --filter @infinite-quest/web-next build
git diff --check
```

Expected: no unaddressed mechanical detector errors; tests, checks, build, and diff check pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web-next/src/styles.css apps/web-next/DESIGN.md apps/web-next/.impeccable/design.json apps/web-next/.impeccable/surfaces/src-world-editor-page-ts.md tests/unit/web-next-world-editor-design.test.ts tests/unit/web-next-theme.test.ts
git commit -m "Polish world draft editor"
```
