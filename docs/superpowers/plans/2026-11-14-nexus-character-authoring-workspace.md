# Nexus character authoring workspace implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Follow repository authorization and verification requirements; this plan does not authorize production deployment.

**Goal:** Deliver quick-create plus a dedicated detailed Nexus character editor, improving usability without losing existing authoring capabilities or safeguards.

**Architecture:** Preserve existing domain models and typed API adapters. Add a presentation-only workspace shell and explicit world-form draft handling; quick and detailed views share the same editing session. Reuse current campaign controllers, field policies and save contracts, and keep Story's existing panel presentation by default.

**Tech Stack:** TypeScript, existing Nexus DOM/native-dialog renderers and CSS, client-core/client-web, Vitest, Playwright Chromium, isolated PostgreSQL integration fixtures. No new dependency.

**Spec:** [Nexus quick-create and detailed editor design](../specs/2026-11-14-nexus-character-authoring-workspace-design.md). Read it together with the [earlier approved design](../specs/2026-11-08-unified-character-editor-and-starting-cast-design.md), including overriding amendments.

**Status:** Implemented in the existing topic checkout; whole-change review and scoped fix review passed with no unresolved findings. The original checklists below describe the planned work; the execution record and [acceptance report](../../review/nexus-character-workspace-acceptance.md) record actual outcomes. Production deployment is outside scope.

| Task | Execution result |
|---|---|
| 1 — Draft and presentation policy | Implemented; focused unit/type checks and independent review passed |
| 2 — Detailed shell | Implemented; browser checks and independent review passed |
| 3 — World integration | Implemented; unit/browser/type checks and independent review passed |
| 4 — Campaign integration | Implemented; unit/browser/type checks and independent review passed |
| 5 — Roster and mechanics | Implemented; unit/browser/type checks and independent review passed |
| 6 — Verification/documentation | Full units, checks, builds, 183 combined browser cases, native zoom and 37 world-library PostgreSQL tests passed; final 119-browser/141-unit fix verification and review passed |

Physical mobile software-keyboard verification is explicitly skipped because no device is available. Actual Chromium 200% zoom is verified. See the acceptance report for counts, failure fixes, screenshots and the distinction between mocked browser and PostgreSQL evidence.

## Global constraints

- Scope: Nexus (`apps/web`) World Library and campaign management. Story and Web-Next remain compatible; neither gets an unrequested redesign.
- No database migration, new API, prompt-protocol change, new provider call, new capability flag or storage-format change is planned.
- Quick/detailed transitions issue no writes, allocate no second identity, and preserve the entire draft, including hidden fields and provenance.
- World Apply modifies only the in-memory world draft; parent Save persists it. Campaign Save retains its existing authority, revision, boundary and idempotency contract.
- Existing character policy, generation locks, evidence fences, provider separation, lifecycle gates and mechanics/fiction separation remain authoritative.
- Detailed editing is a full-viewport native-dialog workspace; no new route and no fiction in URL/browser storage.
- Minimum interactive target is 44×44 CSS pixels. Verify desktop, 390px, keyboard, software-keyboard behavior and 200% zoom.
- Follow current shared schemas and limits, including the 1,000-character world roster limit. Do not copy numeric field limits into a second registry.
- Persistent refresh/crash draft recovery and new character capabilities are deferred.

## Review focus

1. Generated or imported fields not visible in quick-create survive navigation and commit, including opaque extension keys and Organize provenance — tasks 1 and 3.
2. Parent-world save conflicts after successful character Apply never imply the character is durably saved or clear the edited roster — tasks 3 and 6.
3. A late save/AI response after switching character, world or campaign cannot update the newly opened editor — tasks 3 and 4.
4. A software keyboard or 200% zoom cannot hide the focused field beneath persistent actions, trap scrolling or make Cancel unreachable — tasks 2 and 6.
5. Filtered roster reordering, duplicate names and a full roster cannot mutate the wrong identity or discard an unsaved new character — task 5.

## Baseline and preparation

The current working tree includes the prior three conformance fixes and their tests, plus review artifacts. Preserve them. Before execution, inspect `git status`, sync the intended base safely and record whether those fixes are committed/included. Do not reintroduce the old `profile.role` reader, merged-source mention matching or Supporting mechanics-loss behavior. Make an isolated implementation branch/worktree if appropriate; do not discard local work to obtain one.

Read `docs/agents/domain.md`, `CONTEXT.md`, ADRs 0016, 0023 and 0042, `docs/workflows/testing.md`, and `docs/architecture/scene-context-mechanics-review.md`. Deployment/identity docs are required only if scope expands into those boundaries, which this plan does not require.

## File responsibilities and interfaces

New modules:

| File | Responsibility |
|---|---|
| `packages/client-core/src/characters/authoring-presentation.ts` | Pure section assignment, populated summaries and world-roster filtering/summary; no DOM or transport |
| `apps/web/src/character-editor/world-form-session.ts` | World form's lossless profile/use/mechanics draft and local row-removal undo, including raw incomplete control values |
| `apps/web/src/character-editor/workspace.ts` | Full-screen shell, section navigation, local preview, footer/status, focus and viewport behavior |
| `apps/web/src/character-editor/quick-create.ts` | Compact creation view using the same fields/session/AI adapters |
| `tests/unit/character-authoring-presentation.test.ts` | Pure presentation policies and roster behavior |
| `tests/unit/character-world-form-session.test.ts` | Exact draft preservation, row undo and validation boundaries |
| `tests/e2e/nexus-character-workspace.e2e.test.ts` | Quick/detailed, destination, mobile, section navigation and failure workflows |

Keep `profile-fields.ts` as the field registry, `editor-model.ts` as profile-draft/provenance policy, `preset-editor.ts` as seeded authority policy, `campaign-main-form.ts` as protagonist commit/conflict controller, and `campaign-cast-panel.ts` as cast workflow owner. Do not fork these rules into the shell.

Agree these interfaces in task 1 and use them unchanged in subsequent tasks:

```ts
type EditorSectionId = 'overview' | 'identity' | 'personality' | 'appearance'
  | 'situation' | 'notes' | 'mechanics' | 'sources';
type EditorSectionSummary = { id: EditorSectionId; label: string; detail: string; populated: number; errors: number };
type EditorPresentationSnapshot = {
  name: string; destination: string; status: string;
  dirty: boolean; busy: boolean; locked: boolean; readOnly: boolean;
  sections: EditorSectionSummary[];
};
type EditorCommitResult = 'applied' | 'saved' | 'blocked';
type EditorPresentationPort = {
  snapshot(): EditorPresentationSnapshot;
  flush(): void; // capture raw controls; must not reject incomplete navigation
  commit(): Promise<EditorCommitResult>; // existing validation and save path
  requestClose(): Promise<boolean>; // existing staged leave decision
};
```

These are presentation interfaces, not new API payloads. Define the shell-facing types in `workspace.ts`; pure section types belong in client-core and are imported. Adapters retain their existing typed domain drafts and IDs. A blocked/failed commit does not reset the baseline. `flush` must capture all controls before a view switch, including hidden mechanics and flags, and must not mark a draft saved.

## Task 1 — Establish lossless draft and presentation policies

**Files:** Create `authoring-presentation.ts`, `world-form-session.ts` and the two unit files above. Modify `packages/client-core/src/index.ts`, `apps/web/src/nexus.js`, and associated `tests/unit/management-ui.test.ts` only as needed to route through the new session. Review existing `character-editor-rules.test.ts` and `entity-conversion.test.ts`.

**Interfaces:** Export `sectionsForContext(context: CharacterEditorContext): EditorSectionId[]`, `summarizeEditorSections(context: CharacterEditorContext, values: Record<string, EditorValue>, errorPaths: readonly string[], mechanics?: { statistics: number; trackers: number }): EditorSectionSummary[]`, `worldCharacterSummary(character: PlayableCharacter): string`, and `filterWorldCharacters(characters: readonly PlayableCharacter[], options: { query: string; use: 'all' | 'playable' | 'supporting' | 'both' }): PlayableCharacter[]`. Use `PlayableCharacter` from the existing contract. Assign each field once, with core fields in Overview. `detail` carries the human-readable populated summary, including the separate statistic/tracker counts; read-only source-history sections are appended by the campaign adapter, not inferred as editable fields. Bound roster summary display at 160 Unicode code points plus an ellipsis without modifying the input.

Define `createWorldFormSession(character: PlayableCharacter | null)` around the existing `CharacterEditorDraft` plus use/default flags and lossless mechanics rows. Export `WorldFormCapture` containing `profileDraft: CharacterEditorDraft`, name/guidance strings, the three world-use settings, and stat/tracker rows with stable UI row IDs, raw string control values and their retained original objects. The session exposes `capture(input: WorldFormCapture): void`, `read(): WorldFormCapture`, `projectForCommit(): PlayableCharacter`, `removeMechanic(kind: 'stat' | 'tracker', rowId: string): void`, `undoRemoval(): boolean`, and `markApplied(record: PlayableCharacter): void`. Capture stores incomplete raw strings; projection performs current validations. Session construction allocates a new ID once when needed; markApplied updates its baseline and clears removal Undo. UI row IDs must not leak into stored records. Preserve existing stored mechanics IDs and extensions.

- [ ] Write failing unit cases: generated hidden appearance and source extensions survive a quick/detailed round-trip; untouched mechanics retain exact original values/keys; edited statistic 12→55 and tracker old→edited survive Supporting; invalid raw numeric input survives a section change but fails commit; removal Undo restores exact row/position; a second removal replaces the single undo slot; Organize provenance remains attached to selected changes.

  Example assertions for the independent display policy (use the existing character fixture builder for required contract defaults):

  ```ts
  expect(worldCharacterSummary(characterWith({ personality: 'Patient guide', characterText: '' })))
    .toBe('Patient guide');
  expect(filterWorldCharacters([playable, supporting, both], { query: '', use: 'supporting' })
    .map(character => character.id)).toEqual([supporting.id]);
  // Capture incomplete numeric text, switch presentations, then assert it remains
  // in read(); only projectForCommit() rejects it. Never derive the expected
  // retained profile/extension values by calling the serializer under test.
  ```
- [ ] Run `node node_modules/vitest/vitest.mjs run tests/unit/character-authoring-presentation.test.ts tests/unit/character-world-form-session.test.ts` and verify expected behavioral failures.
- [ ] Implement the pure helpers and session. Move only the character-form ownership needed out of `nexus.js`; preserve existing identity, unknown-field, read-only and commit behavior. Derive field grouping from the existing descriptors and explicit Overview mapping; do not add a new schema.
- [ ] Run the new tests plus `tests/unit/management-ui.test.ts`, `tests/unit/character-editor-rules.test.ts`, `tests/unit/entity-conversion.test.ts` and `tests/unit/campaign-main-editor.test.ts`. Update extracted-function harness dependencies where functions move; do not replace behavioral assertions with source-string checks.
- [ ] Review the diff and commit the tested session/policy extraction separately.

## Task 2 — Build the dedicated detailed workspace shell

**Files:** Create `workspace.ts` and `nexus-character-workspace.e2e.test.ts`; modify `renderer.ts` and `apps/web/public/nexus.css`. Add `tests/unit/character-workspace.test.ts` for state/section behavior if not adequately exercised by the browser cases.

**Interfaces:** `mountCharacterWorkspace(host: HTMLElement, port: EditorPresentationPort, content: { sections: Map<EditorSectionId, HTMLElement>; preview(): HTMLElement }): { refresh(): void; reveal(section: EditorSectionId, control?: HTMLElement): void; dispose(): void }`. Existing adapters supply actual controls; the shell must not generate alternate authoritative drafts. Keep controls mounted or flush before remounting. No duplicate IDs in hidden quick/detailed forms.

- [ ] Add failing Chromium cases for persistent desktop/mobile actions, destination header, section navigation, populated/error summaries, preview return, focus restoration and dirty Back/Escape. Check an unsafe HTML string renders as text. Test 390px and 200% zoom; add a focused mobile keyboard/manual checklist when the automation cannot model a real keyboard.
- [ ] Run `node node_modules/@playwright/test/cli.js test tests/e2e/nexus-character-workspace.e2e.test.ts --workers=2` and confirm failures are from missing behavior rather than missing fixtures.
- [ ] Implement header, rail/narrow selector, single-section working area, preview and action bar using incumbent tokens. Route commit/close through the port. Put no lifecycle or transport logic in the shell. Disabled locks and errors must update without losing the current section or input.
- [ ] Verify no overflow at 320px/390px, no sticky overlay of focused fields, logical keyboard traversal and one clear live-status announcement. Record screenshots of filled desktop/mobile sections and error focus.
- [ ] Run affected renderer and browser suites, review and commit the shell without changing default Story presentation.

## Task 3 — Connect world quick-create and detailed editing

**Files:** Create `quick-create.ts`; modify `nexus.js`, `renderer.ts`, `suggest-cast.ts` as necessary for its existing edit callback, and `apps/web/public/nexus.css`. Extend `character-authoring-simplification.e2e.test.ts`, `legacy-ui-authoring-disclosures.e2e.test.ts`, `nexus-character-workspace.e2e.test.ts` and `management-ui.test.ts`.

**Interfaces:** `mountQuickCharacterCreate(host: HTMLElement, options: { context: 'world-draft' | 'campaign-supporting'; port: EditorPresentationPort; fields: HTMLElement; aiTools?: HTMLElement; onContinue(): void }): { dispose(): void }`. Continue calls `flush`, then switches presentation on the same host/session. Existing world `saveCharacterFromModal`, Generate/Organize and suggestion callbacks become adapters; no second save pipeline.

- [ ] Add failing browser cases: new world character starts quick; existing opens detailed; name-only Supporting works; selectable guidance remains required; Continue accepts incomplete fields with zero writes; hidden generated fields and identity survive; double Continue/Apply produces one roster entry; suggestion editing returns only to its suggestion; AI replacement remains explicit and errors retain input.
- [ ] Add a parent-save failure/conflict scenario: Apply changes the local roster, failed Save world leaves it dirty, retry sends the same authored values, and no success copy claims durability early. Also reject a late generation response after changing selection.
- [ ] Run the named cases red, then implement context-specific actions and persistent draft-state messages. Preserve all parent world edits, section/filter/scroll state and existing modal-session epochs. Extend unsaved unload/navigation guards to the active world/character session without duplicating prompts.
- [ ] Reuse the existing Generate/Organize review and provenance paths. In detailed mode make them discoverable in Overview/notes; quick mode may invoke the existing whole-character generator without losing unseen results. Do not add paid calls on open or mode change.
- [ ] Run the three affected browser suites and relevant unit tests. Capture quick-create, AI review, detailed full profile, parent unsaved state and parent save error at desktop/390px. Review and commit world integration.

## Task 4 — Connect campaign editing without changing authority

**Files:** Modify `campaign-main-form.ts`, `campaign-cast-panel.ts`, `preset-fields.ts`, `story-draft.ts` only where needed for placement, `nexus.js`, and `workspace.ts`. Review `story.js` callers; retain their default behavior. Extend `campaign-main-editor.test.ts`, `campaign-cast-panel.test.ts`, `campaign-cast-editor.test.ts`, `unified-character-editor.e2e.test.ts` and `campaign-cast.e2e.test.ts`.

**Interfaces:** Add `editorPresentation?: 'panel' | 'workspace'` to `createLegacyCastPanel` options, default `'panel'`. Nexus supplies `'workspace'`; Story remains default. Preset and ordinary cast adapters expose `EditorPresentationPort` over existing `PresetDraft`/`CastEditorState`, with the existing authored-profile/cast API methods. Protagonist adapter uses `createCampaignMainController` and its current validation/reapply logic.

- [ ] Add failing cases for each campaign context: save/close, invalid input, conflict compare/reapply, disabled capability, generation starting before commit, and late response after character/campaign switch. Keep the campaign-page open/save lock checks and Story live-lock distinction.
- [ ] Add reset/clear/restore and Draft-from-story cases with exact retained evidence fences and stale-evidence rejection. Manual/discovered supporting characters show their current smaller field set, not unsupported empty fields.
- [ ] Add a dirty-editor lifecycle boundary case: entering merge/remove/promotion requires saving or explicitly discarding the draft; cancellation preserves it. Existing capability checks, main-character prohibitions and all lifecycle previews remain in force.
- [ ] Run red, implement the adapters, then run the affected unit and campaign browser suites. Verify Open in Story reaches the selected character and default Story presentation has no changed save contract.
- [ ] Review payloads and commit campaign integration separately from world orchestration.

## Task 5 — Finish roster and mechanics usability

**Files:** Modify `authoring-presentation.ts`, `world-form-session.ts`, `nexus.js`, `renderer.ts`, `nexus.css`; extend the new unit/browser suites and `character-authoring-simplification.e2e.test.ts`.

**Interfaces:** Roster helper inputs are immutable; search uses normalized name, aliases and role, and use filters are exact. Summary truncation is display-only. Mechanics UI uses the session's removal/undo API and existing field limits.

- [ ] Add failing cases for structured summary with no legacy guidance, no-matches versus empty roster, exact use filters, preserved authored order, duplicate names with stable IDs, disabled filtered reordering, clear-filter focus, and rejected addition at the 1,000-character limit retaining the new draft.
- [ ] Add cases for multiline notes/rules and starting values, row-specific removal names, exact removal Undo, and Supporting round-trips with untouched imported extensions. Render a long unbroken/CJK/RTL summary safely without horizontal overflow or stored-content truncation.
- [ ] Run red, implement styled row actions, search/filter controls, summary/empty states and multiline mechanics. Avoid adding a second campaign search or changing protagonist-selection filtering.
- [ ] Run related unit/browser tests and confirm the prior six conformance browser cases still pass or have equivalent stronger assertions after deliberate locator updates. Capture roster, filter-empty state and multiline mechanics/Undo at desktop/390px.
- [ ] Review and commit usability refinements.

## Task 6 — Verify preservation, document and release the Nexus surface

**Files:** Update `docs/nexus-guide/worlds/characters.md`, `docs/nexus-guide/worlds/edit-drafts.md`, `docs/player-guide/characters-and-stats.md`, `docs/workflows/testing.md` only for new reproducible commands; add `docs/review/nexus-character-workspace-acceptance.md`. Extend the existing real-PostgreSQL browser proof in `tests/integration/world-library.integration.test.ts` (enabled by `NEXUS_CAST_BROWSER_PROOF=1`). Do not invent a second disposable-runtime harness.

- [ ] Map every U1–U15 criterion to an actual assertion or manual evidence entry. Test one composed disposable-database path: world quick-create → detailed edit → local Apply → parent Save → publish → create campaign → campaign edit/reset → reopen. Prove the world and another campaign remain unchanged by campaign edits; inspect receipts/provenance rather than relying on UI text alone.
- [ ] Run focused PostgreSQL repository, lifecycle, merge, portability, generation and API suites with `--config vitest.integration.config.ts`. Deterministic providers only; report provider quality as untested.
- [ ] Run `pnpm check`, `pnpm check:client-boundaries`, both web builds, and the full unit suite with `.worktrees`, `.codex` and `.claude` exclusions. Run affected Chromium suites: new workspace, character authoring, unified editor, campaign cast, authoring disclosures, campaign edits and campaign creation. Use fixture runtime/host permissions as documented in the conformance report; do not weaken sandbox or package-version checks in project configuration.
- [ ] Complete real mobile/software-keyboard and keyboard/zoom verification, or record a concrete skip and remaining release limitation. Keep screenshots of the final controls, source review, conflicts and saved result at desktop/390px. Do not count a mocked browser save as PostgreSQL evidence.
- [ ] Update guides with quick/detail entry, section navigation, the two world-save steps, AI review locations, lock/conflict recovery and lack of reload recovery. Record passed/failed/skipped counts, baseline, browser/DB distinction, full matrix and screenshot links in the acceptance report.
- [ ] Review the complete diff for capability omissions and unrelated changes, verify local documentation links and run `git diff --check`. Remove temporary Nexus mount toggles only after both adapters pass; keep Story's intentional panel default. Commit the final acceptance/docs change. Production deployment and flag activation are not part of this plan.

## Verification commands

Use `pnpm` directly for nested scripts in this environment; `corepack pnpm check` previously selected an incompatible nested global executable. The host cache contains the pinned pnpm version, whereas the sandbox-specific cache previously failed. Never change the lockfile merely to repair a local test invocation.

```powershell
pnpm check
pnpm check:client-boundaries
pnpm build:web:legacy
pnpm build:web:next
node node_modules/vitest/vitest.mjs run tests/unit --exclude '**/.worktrees/**' --exclude '**/.codex/**' --exclude '**/.claude/**'
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/campaign-cast-repository.integration.test.ts tests/integration/campaign-cast-lifecycle.integration.test.ts tests/integration/campaign-cast-lifecycle-merge.integration.test.ts tests/integration/campaign-cast-portability.integration.test.ts tests/integration/campaign-cast-generation.integration.test.ts tests/integration/campaign-cast-api.integration.test.ts
node node_modules/@playwright/test/cli.js test tests/e2e/nexus-character-workspace.e2e.test.ts tests/e2e/character-authoring-simplification.e2e.test.ts tests/e2e/unified-character-editor.e2e.test.ts tests/e2e/campaign-cast.e2e.test.ts tests/e2e/legacy-ui-authoring-disclosures.e2e.test.ts tests/e2e/legacy-ui-campaign-edits.e2e.test.ts tests/e2e/legacy-ui-campaign-creation.e2e.test.ts --workers=2
git diff --check
```

For the composed PostgreSQL/browser proof, start `pnpm --filter @infinite-quest/web-legacy exec vite --host 127.0.0.1 --port 43173 --strictPort` in a separate task-owned process. Set `NEXUS_CAST_BROWSER_PROOF=1`, `PLAYWRIGHT_LEGACY_PORT=43173` and `CAST_SCREENSHOT_ROOT` to the chosen evidence directory in the integration-test process, then run `node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/world-library.integration.test.ts`. Verify that the opt-in proof actually ran rather than skipped. Stop only the task-owned Vite process afterward and clear those temporary environment settings. Run this separately from Playwright's own managed web servers to avoid port ownership conflicts.

## Handoff

The design deliberately avoids new persistence or prompt behavior. Any proposal that needs either must return to design rather than be hidden inside a UI task. Execute tasks 1→2→3→4→5→6; tasks 3 and 4 share the shell and should not independently redefine its interfaces. Recommended execution is one implementation owner with focused independent reviews at the world and campaign integration boundaries, followed by a complete release review.
