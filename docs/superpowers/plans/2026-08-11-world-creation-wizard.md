# World Creation Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a routed Atlas Workspace wizard that creates a complete non-character world manually or from a validated provider-generated local preview, with no authoritative mutation before final confirmation.

**Architecture:** Keep wizard routing in `bootstrap.ts`, isolate pure creation state and response canonicalization from DOM rendering, and give the wizard its own API boundary. Reuse the World Editor’s strict draft parser, collection adapters, semantic shell, and owner-safe outbound policy while keeping creation, generation, and optional cover operations independently testable.

**Tech Stack:** TypeScript, DOM APIs, Vite, Vitest, LinkeDOM, existing world-generation/create/cover REST endpoints, existing semantic CSS theme contract.

## Global Constraints

- Build in `C:/Git/InfiniteQuest/.worktrees/web-theme-system` on `feature/world-creation-wizard`; do not modify the legacy application.
- Use two-space indentation and preserve the Constructed Atlas Grid, square controls, self-hosted typography, semantic light/dark tokens, 44px targets, visible focus, and reduced-motion behavior.
- The creation route is `/app/worlds/new`; `/app/worlds/:worldId` remains the World Editor.
- No authoritative request occurs before final **Create world**. Provider generation only creates a local preview.
- Every created or generated world submits `playableCharacters: []`; character creation and generation are excluded.
- Never send caller-provided owner or user identity. Strip root `user_id`, `userId`, `owner_user_id`, and `ownerUserId` outbound while preserving other unknown properties.
- Text and image providers remain independent. Missing or failed image generation never blocks world creation.
- Follow TDD for every behavior: write a failing test, verify the expected failure, add minimal implementation, rerun to green, then refactor.
- Use one bounded desktop/mobile inspection batch, one correction batch, and at most one confirmation batch.

---

### Task 1: Creation route and local workflow state

**Files:**
- Create: `apps/web-next/src/world-creation-model.ts`
- Create: `apps/web-next/src/world-creation-page.ts`
- Modify: `apps/web-next/src/world-editor-model.ts`
- Modify: `apps/web-next/src/world-library-page.ts`
- Modify: `apps/web-next/src/bootstrap.ts`
- Test: `tests/unit/web-next-world-creation-model.test.ts`
- Modify: `tests/unit/web-next-world-library.test.ts`
- Modify: `tests/unit/web-next-world-editor-model.test.ts`

**Interfaces:**
- Produces `WORLD_CREATION_PATH`, `isWorldCreationPath(pathname)`, `worldCreationPath()`.
- Produces `CreationMethod = "manual" | "ai"` and `CreationStage = "method" | "foundation" | "canon" | "mechanics" | "cover" | "review"`.
- Produces `WorldCreationState`, `createWorldCreationState()`, `selectCreationMethod`, `editCreationDraft`, `setCreationStage`, `validateCreationStage`, `creationReadiness`, `applyGeneratedPreview`, `beginCreation`, `completeCreation`, and `failCreation`.
- Consumes `EditableWorldDraft` and `parseEditableWorldDraft` from the World Editor model.

- [ ] **Step 1: Write failing route and initial-state tests**

```ts
expect(worldCreationPath()).toBe("/app/worlds/new");
expect(isWorldCreationPath("/app/worlds/new")).toBe(true);
expect(worldIdFromPath("/app/worlds/new")).toBeNull();

const state = createWorldCreationState();
expect(state.stage).toBe("method");
expect(state.method).toBeNull();
expect(state.draft.schemaVersion).toBe(5);
expect(state.draft.playableCharacters).toEqual([]);
expect(state.status).toBe("pristine");
```

Update World Library DOM tests to require one **Create world** link pointing at `/app/worlds/new` while existing cards still point at encoded editor routes.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm exec vitest run tests/unit/web-next-world-creation-model.test.ts tests/unit/web-next-world-editor-model.test.ts tests/unit/web-next-world-library.test.ts
```

Expected: FAIL because the creation route and model do not exist and `new` is still interpreted as a world id.

- [ ] **Step 3: Implement route precedence and empty canonical state**

Make `worldIdFromPath` reject the reserved `new` segment. Render the Library action through the existing shared shell. In `bootstrap.ts`, choose creation before editor detail:

```ts
const mountedPage = isWorldCreationPath(location.pathname)
  ? mountWorldCreationPage(root)
  : worldId === null
    ? mountWorldLibraryPage(root)
    : mountWorldEditorPage(root, worldId);
```

Create `world-creation-page.ts` with an exported `mountWorldCreationPage(root)` initial routed shell that renders `data-page="world-creation"`, the shared shell, and a disabled loading state; Task 2 replaces its interior without changing the bootstrap interface.

- [ ] **Step 4: Write failing local-transition tests**

Cover method selection, immutable field edits, allowed stage transitions, Foundation title validation, undoable collection removal, readiness across six stages, generation replacement confirmation metadata, create-status transitions, and navigation-dirty state.

Assert provider content is canonicalized and characters are removed:

```ts
const generated = applyGeneratedPreview(state, {
  title: "Generated Atlas",
  content: { ...providerDraft, playableCharacters: [{ id: "forbidden" }] }
});
expect(generated.draft.playableCharacters).toEqual([]);
expect(generated.provenance).toBe("ai");
expect(generated.status).toBe("unsaved");
```

- [ ] **Step 5: Implement pure state transitions and verify GREEN**

Use immutable clones and the World Editor’s existing removal semantics where possible. Final validation requires a title and structurally valid object/array roots but does not invent required lore volume. Every transition preserves `playableCharacters: []`.

```bash
pnpm exec vitest run tests/unit/web-next-world-creation-model.test.ts tests/unit/web-next-world-editor-model.test.ts tests/unit/web-next-world-library.test.ts
pnpm --filter @infinite-quest/web-next check
```

Expected: all selected tests and TypeScript checks pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web-next/src/world-creation-model.ts apps/web-next/src/world-creation-page.ts apps/web-next/src/world-editor-model.ts apps/web-next/src/world-library-page.ts apps/web-next/src/bootstrap.ts tests/unit/web-next-world-creation-model.test.ts tests/unit/web-next-world-editor-model.test.ts tests/unit/web-next-world-library.test.ts
git commit -m "Add world creation workflow state"
```

---

### Task 2: Generation/create API boundary and prompt authoring

**Files:**
- Create: `apps/web-next/src/world-creation-api.ts`
- Modify: `apps/web-next/src/world-creation-page.ts`
- Modify: `apps/web-next/src/bootstrap.ts`
- Test: `tests/unit/web-next-world-creation-api.test.ts`
- Test: `tests/unit/web-next-world-creation-page.test.ts`

**Interfaces:**
- Produces `generateWorldPreview(request, signal?)`, `loadWorldGenerationProgress(progressKey, signal?)`, `createWorld(draft, signal?)`, `attachCreatedWorldCover(worldId, assetId, signal?)`, and `generateCreatedWorldCover(worldId, prompt, signal?)`.
- Produces typed `WorldCreationApiError` with `network`, `unavailable`, `invalid_response`, and `request_failed` kinds.
- Produces `mountWorldCreationPage(root, dependencies?) -> { dispose(): void }`.
- Clipboard dependencies are injectable as `readClipboardText()` and `writeClipboardText(value)` for deterministic tests.

- [ ] **Step 1: Write failing API contract tests**

Assert exact requests and strict responses:

```ts
await generateWorldPreview({ title: "", prompt: "A glass city", progressKey: "world-gen:key" });
expect(fetch).toHaveBeenCalledWith("/api/v1/worlds/generate-preview", expect.objectContaining({
  method: "POST",
  body: JSON.stringify({ title: "", prompt: "A glass city", progressKey: "world-gen:key" })
}));
```

Test progress-key encoding, malformed generated content, 503 provider unavailability, abort propagation, create response parsing, owner-identity stripping, forced empty `playableCharacters`, independent cover-asset PUT, and generated-cover POST.

- [ ] **Step 2: Run API tests and verify RED**

```bash
pnpm exec vitest run tests/unit/web-next-world-creation-api.test.ts
```

Expected: FAIL because the API module does not exist.

- [ ] **Step 3: Implement the strict API boundary**

Reuse `parseEditableWorldDraft` and the existing cover response parser where practical. Parse generated preview as `{ title: string, content: EditableWorldDraft }`, then canonicalize and clear characters before returning it. Create sends only `{ title, content }` with owner-safe content.

- [ ] **Step 4: Write failing Method-stage DOM tests**

Test shared shell/theme presence, compact 48px method radio controls, AI prompt visibility, Manual behavior, synchronized compact/expanded values, authored SVG controls, accessible icon names, dialog focus trap, Escape close/focus restore, Copy success/failure, Paste insertion at selection, clipboard denied recovery, Generate disabled for blank prompt, and no network call from ordinary typing.

- [ ] **Step 5: Implement the Method stage and prompt dialog**

Use a native `<dialog>` where supported with a tested fallback role/dialog behavior for LinkeDOM. Keep one concept value in state. Copy and Paste must preserve typing focus; Expand opens the same value, not a second draft. Provider Setup recovery links to `/nexus/?view=setup`.

- [ ] **Step 6: Verify Task 2 GREEN**

```bash
pnpm exec vitest run tests/unit/web-next-world-creation-api.test.ts tests/unit/web-next-world-creation-page.test.ts tests/unit/web-next-theme.test.ts
pnpm --filter @infinite-quest/web-next check
```

Expected: all selected tests and checks pass.

- [ ] **Step 7: Commit**

```bash
git add apps/web-next/src/world-creation-api.ts apps/web-next/src/world-creation-page.ts apps/web-next/src/bootstrap.ts tests/unit/web-next-world-creation-api.test.ts tests/unit/web-next-world-creation-page.test.ts
git commit -m "Build world creation method stage"
```

---

### Task 3: Generation progress and convergent editing stages

**Files:**
- Modify: `apps/web-next/src/world-creation-page.ts`
- Modify: `apps/web-next/src/world-creation-model.ts`
- Reuse: `apps/web-next/src/world-editor-fields.ts`
- Modify: `tests/unit/web-next-world-creation-page.test.ts`
- Modify: `tests/unit/web-next-world-creation-model.test.ts`

**Interfaces:**
- Consumes Task 2 API functions and existing `collectionItemSummary`, `structuredFieldsFor`, `mergeStructuredFields`, `parseAdvancedJson`, and `serializeAdvancedJson`.
- Produces one shared Foundation/Canon/Mechanics editing path for both methods.

- [ ] **Step 1: Write failing generation-flow tests**

Cover unique progress keys, visible semantic progress, progress polling while active, cancellation via AbortController, malformed response recovery, provider retry, preservation of concept/local fields on failure, confirmed replacement when local fields are non-empty, and no authoritative create/update request during generation.

Assert generated characters never reach state or DOM:

```ts
await clickGenerate();
expect(state.draft.playableCharacters).toEqual([]);
expect(document.body.textContent).not.toContain("Generated Character");
```

- [ ] **Step 2: Run generation tests and verify RED**

```bash
pnpm exec vitest run tests/unit/web-next-world-creation-page.test.ts tests/unit/web-next-world-creation-model.test.ts
```

Expected: FAIL on generation orchestration and progress behavior.

- [ ] **Step 3: Implement generation orchestration**

Poll progress at a bounded interval, stop on settle/dispose/cancel, and make stale generations unable to overwrite a newer request. After valid generation, advance to Foundation and announce that all fields require review.

- [ ] **Step 4: Write failing shared-stage tests**

Cover manual blank Foundation, generated Foundation values, stage index current/completed state, Back/Continue preservation, exact validation focus, Canon entity/relationship collection editing, Mechanics stat/default/event trigger editing, defaults JSON, advanced unknown-property preservation, bounded 100-row lists, undoable removal, and stage navigation without network calls.

- [ ] **Step 5: Implement Foundation, Canon, and Mechanics**

Reuse existing pure field adapters and the World Editor’s master-detail behavior rather than copying alias rules. Keep selected records mounted during filtering. Characters must not appear as a stage, collection, generated result, or submitted field beyond the required empty array.

- [ ] **Step 6: Verify Task 3 GREEN**

```bash
pnpm exec vitest run tests/unit/web-next-world-creation-model.test.ts tests/unit/web-next-world-creation-page.test.ts tests/unit/web-next-world-editor-fields.test.ts
pnpm --filter @infinite-quest/web-next check
```

Expected: all selected tests and checks pass.

- [ ] **Step 7: Commit**

```bash
git add apps/web-next/src/world-creation-page.ts apps/web-next/src/world-creation-model.ts tests/unit/web-next-world-creation-page.test.ts tests/unit/web-next-world-creation-model.test.ts
git commit -m "Complete world creation editing stages"
```

---

### Task 4: Cover, final review, and authoritative creation

**Files:**
- Modify: `apps/web-next/src/world-creation-page.ts`
- Modify: `apps/web-next/src/world-creation-model.ts`
- Modify: `apps/web-next/src/world-creation-api.ts`
- Modify: `tests/unit/web-next-world-creation-page.test.ts`
- Modify: `tests/unit/web-next-world-creation-model.test.ts`
- Modify: `tests/unit/web-next-world-creation-api.test.ts`

**Interfaces:**
- Cover intent is `none | retained_asset | generated` with an asset id or prompt only for the matching mode.
- Successful creation yields `{ id, title, status: "draft", draftRevision, draftContent, imageUrl, ... }` parsed through a narrow response boundary.

- [ ] **Step 1: Write failing Cover and Review tests**

Cover no-cover default, retained id validation, generated prompt validation, image-provider-unavailable guidance without world blocking, Review provenance/readiness/warnings, Back preserving every field, complete error summary links, and `playableCharacters: []` in the serialized review.

- [ ] **Step 2: Implement Cover and Review stages**

Show cover work as optional and independent. Review presents factual counts for entities, relationships, stats, triggers, assets, and zero characters. Do not claim provider success beyond actual generated state.

- [ ] **Step 3: Write failing creation-orchestration tests**

Assert one Create click makes exactly one POST, disables duplicate activation, focuses validation before requests, preserves all local state on create failure, and navigates only after success. For cover modes assert:

```ts
expect(createWorld).toHaveBeenCalledTimes(1);
expect(attachCreatedWorldCover.mock.invocationCallOrder[0]).toBeGreaterThan(createWorld.mock.invocationCallOrder[0]);
expect(navigate).toHaveBeenCalledWith(`/app/worlds/${created.id}`);
```

Also prove cover failure does not repeat or roll back create, and a cover retry calls only its cover endpoint.

- [ ] **Step 4: Implement explicit creation and independent cover recovery**

Create uses a submission snapshot with characters cleared and forbidden root identity stripped. Persist the new id before optional cover work. On cover failure, show **Open world** and **Retry cover**; retry never repeats POST `/api/v1/worlds`.

- [ ] **Step 5: Add navigation and lifecycle tests**

Install `beforeunload` only while local work exists, retain BFCache listeners on persisted pagehide, abort generation/creation on non-persisted disposal, and prevent stale async completion from navigating after disposal.

- [ ] **Step 6: Verify Task 4 GREEN**

```bash
pnpm exec vitest run tests/unit/web-next-world-creation-model.test.ts tests/unit/web-next-world-creation-api.test.ts tests/unit/web-next-world-creation-page.test.ts tests/unit/web-request-security.test.ts
pnpm --filter @infinite-quest/web-next check
```

Expected: all selected tests and checks pass.

- [ ] **Step 7: Commit**

```bash
git add apps/web-next/src/world-creation-page.ts apps/web-next/src/world-creation-model.ts apps/web-next/src/world-creation-api.ts tests/unit/web-next-world-creation-page.test.ts tests/unit/web-next-world-creation-model.test.ts tests/unit/web-next-world-creation-api.test.ts
git commit -m "Create reviewed world drafts"
```

---

### Task 5: Atlas Workspace styling, documentation, and bounded verification

**Files:**
- Modify: `apps/web-next/src/styles.css`
- Modify: `apps/web-next/DESIGN.md`
- Modify: `apps/web-next/.impeccable/design.json`
- Create: `apps/web-next/.impeccable/surfaces/src-world-creation-page-ts.md`
- Create: `tests/unit/web-next-world-creation-design.test.ts`
- Modify: `tests/unit/web-next-theme.test.ts`

**Interfaces:**
- Consumes the DOM contract from Tasks 2–4.
- Produces the final desktop stage rail/canvas/bottom ledger and compact horizontal-stage/full-width-dialog layout.

- [ ] **Step 1: Write failing design-contract tests**

Assert route styling includes `.creation-stage-index`, `.creation-method-control`, `.creation-prompt-tools`, `.creation-progress-ledger`, and `.creation-prompt-dialog`; controls are at least 44px; method controls are compact rather than card-sized; desktop and `720px` layouts recompose as specified; Copy/Paste/Expand use SVG; the dialog has full-width compact behavior; reduced-motion rules remove dialog/stage/progress transitions; and all creation selectors consume semantic color tokens without theme literals.

- [ ] **Step 2: Run design tests and verify RED**

```bash
pnpm exec vitest run tests/unit/web-next-world-creation-design.test.ts tests/unit/web-next-theme.test.ts
```

Expected: FAIL because the Atlas Workspace design contract and documentation do not exist.

- [ ] **Step 3: Implement the selected visual system**

Keep the method selector as two compact 48px controls. Give the prompt toolbar only Copy, Paste, and Expand, with icon-only Copy/Paste and a compact labelled Expand action. Keep the wizard flat, square, rule-separated, and free of nested cards or ambient shadows. The bottom ledger carries stage progress and the primary Back/Continue/Create action without covering focused content.

- [ ] **Step 4: Update durable design records**

Document Creation Stage Index, Compact Method Control, Prompt Toolbar, Expanded Prompt Dialog, and Creation Progress Ledger in `DESIGN.md` and `.impeccable/design.json`. Add the Operate-mode surface brief with manual/AI convergence, no-character rule, explicit create boundary, provider/clipboard states, and responsive behavior.

- [ ] **Step 5: Run automated verification**

```bash
pnpm exec vitest run tests/unit/web-next-*.test.ts tests/unit/web-request-security.test.ts
pnpm --filter @infinite-quest/web-next check
pnpm --filter @infinite-quest/web-next build
node -e "JSON.parse(require('fs').readFileSync('apps/web-next/.impeccable/design.json','utf8'))"
git diff --check
```

Expected: all targeted tests, type checking, build, JSON parsing, and diff checks pass. Existing unresolved font warnings may remain warnings only.

- [ ] **Step 6: Perform bounded visual verification**

Use request interception for provider and creation endpoints so no database is required. In one batch capture desktop 1440×1000 and mobile 390×844 in light and dark themes for Manual Foundation, AI prompt, expanded dialog, generated Canon, validation, progress, and final Review. Apply one batched correction, then capture one confirmation batch and stop.

- [ ] **Step 7: Run detector and final verification**

```bash
node C:/Git/InfiniteQuest/.agents/skills/impeccable/scripts/detect.mjs --json apps/web-next/src/world-creation-page.ts apps/web-next/src/styles.css
pnpm exec vitest run tests/unit/web-next-*.test.ts tests/unit/web-request-security.test.ts
pnpm --filter @infinite-quest/web-next check
pnpm --filter @infinite-quest/web-next build
git diff --check
```

Expected: no unaddressed mechanical detector errors; all targeted tests and build checks pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web-next/src/styles.css apps/web-next/DESIGN.md apps/web-next/.impeccable/design.json apps/web-next/.impeccable/surfaces/src-world-creation-page-ts.md tests/unit/web-next-world-creation-design.test.ts tests/unit/web-next-theme.test.ts
git commit -m "Polish world creation wizard"
```
