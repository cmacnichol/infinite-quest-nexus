# Unified Character Editor and Starting Cast Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` for task-by-task implementation with independent review, or an execution workflow for carrying out the same tasks in order. Track progress with the checkboxes below.

**Goal:** Give Nexus one character editor across World, campaign and Story, with optional campaign-owned starting NPCs that retain their authored origin and evolve under explicit field rules.

**Architecture:** The World version supplies immutable source data. Campaign-scoped events supply each NPC’s activation, edits and portable history. A DOM-free editor model drives Nexus, and both clients use the same typed contracts at the API boundary.

**Tech stack:** TypeScript, Zod, Fastify, PostgreSQL, the existing Nexus and Web-Next clients, Vitest and Playwright.

**Spec:** [Confirmed design and acceptance criteria](../specs/2026-11-08-unified-character-editor-and-starting-cast-design.md). Use its [route summary](../specs/2026-11-08-unified-character-editor-and-starting-cast-design.md#route-summary), [field policy](../specs/2026-11-08-unified-character-editor-and-starting-cast-design.md#field-policy) and [review regression cases](../specs/2026-11-08-unified-character-editor-and-starting-cast-design.md#review-regression-cases) as the detailed contracts. File paths below are relative to the repository root, checked at `0b1891c9`. Capture the confirmed spec with the plan when publishing the work.

## Delivery sequence

| Phase | Deliverable | Criteria | Depends on |
|---|---|---:|---|
| 1 | Shared model, World renderer, typed previews and Organize provenance | 9 | Existing World and campaign paths |
| 2 | Main character in both entry points, accessible Story sheet and inbox | 8 | Phase 1 |
| 3 | Authority, settings, archives, provider-safe context and compatibility readers | 29 | Phase 1 model and phase 2 surfaces |
| 4 | Starting cast creation, first appearance, Add/Apply and complete preset editing | 31 | Phase 3 readers, writers and effective flags |
| 5 | Reviewed suggestions, entity conversion and evidence-backed drafting | 16 | Phase 4 editor and normal save paths |
| **6 · separate release** | **Merge/undo, Remove/Restore and Promote to world** | **14** | **Accepted phase 5 baseline, then v4 readers before lifecycle writes** |

Phases 1–5 can ship incrementally. Their release criteria end at cast format v3. Phase 6 has its own release evidence, activation and rollback decision. A lifecycle-only campaign can require v4 even with presets disabled.

## Global constraints

- A native campaign created with effective presets off keeps `firstAppearanceEligible: false` for its lifetime. After presets are enabled, explicit Add from world still works. Persist eligibility outside cast events, including for empty campaigns.
- Reapplying a detached roster profile keeps the cast ID and creates a fresh activation from the pinned World version. Earlier seed-scoped hand edits remain visible in history. Preserve independent identity edits and updating overrides under their own event rules.
- Use the server-resolved owner and campaign/world scopes on every read, preview, publication and write. Check expected revisions, timeline boundary, generation/recovery lock and idempotency where the spec requires them. A stale or foreign request leaves authority unchanged.
- Starting cast is optional, unique and capped at 30. Warn above five Always include selections. The narrator admits records into its actual headroom, capped at 3,000 tokens. Bound the joined appearance or any other authored field to 600 characters at capture.
- Keep full-fidelity source text separate from field-specific detail, compact summaries, observations and provider payloads. Use the approved fiction projection for each provider-bound feature. Keep illustration generation and the existing auto-match default outside this rollout.
- Use `apps/web/public/index.html` for the Nexus dialog. Use `apps/web/src` for DOM rendering and `packages/client-core` for platform-independent model logic. Preserve Web-Next compatibility and its settings panel without undertaking its editor redesign.

## Review focus

1. A stale Organize proposal is reapplied after a concurrent hand edit. Preserve unrelated changes and the actual reviewed protocol version (1C, 2A).
2. A blank World role meets a manual role on a same-name target. Compare exactly what Apply will preserve or displace, then reject a changed preview (3E, 4D).
3. A discovery job resumes after migration or presets shutdown. Check frozen and live permission, current identity and the reserved protagonist under the write lock (3H, 4C).
4. A restored archive has no cast events, or has a lone long goal override. Preserve eligibility and choose the minimum format that can represent every stored value (3C, 3F).
5. A later edit re-enters an alias or changes a target after merging. Undo only the merge-owned changes and preserve source identity and evidence for replay (6A, 6B).

## Working and verification conventions

Each task gives its **acceptance IDs**, **implementation files**, and **test files** in runnable commands. Write or extend the named cases first, run the relevant focused command and confirm the intended failing assertion. Keep characterization cases green during extraction. Implement the listed change, rerun all commands for that task, and commit the verified slice with a short imperative summary. Group dependent changes that must land together to keep a phase deployable.

Run commands from the repository root. PostgreSQL tests use the isolated integration configuration. Browser tests use the repository Playwright configuration and Chromium. Record passed, failed and skipped evidence by layer. A browser fixture proves an interaction; a database-backed test proves the transaction. See the [test matrix](../../workflows/testing.md), [identity and ownership rules](../../concepts/identity-and-ownership.md), [deployment runbook](../../runbooks/deployment.md) and [scene-context mechanics review](../../architecture/scene-context-mechanics-review.md).

## Phase 1 · Extract the editor

Start from the current World dialog. Keep both clients building throughout the extraction.

### 1A · Extract field descriptors and draft state

**Acceptance** 1.1, 1.4, 1.8

**Modify** `packages/client-core/src/characters/profile-fields.ts`, `packages/client-core/src/campaign-cast-editor.ts`, `packages/client-core/src/index.ts`.

**Create** `packages/client-core/src/characters/editor-model.ts`.

**Interface.** Have `createEditorDraft(context, loaded)` return editable values, changed paths, accepted Organize provenance and conflict state. Derive the existing `PROFILE_FIELDS` and `SUPPORTING_FIELDS` exports in their current order and shape.

- [x] **Regression cases.** Characterize the existing ordered PROFILE_FIELDS and SUPPORTING_FIELDS exports. Add a DOM-free test for aliases containing commas, dirty-path tracking, untouched passthrough fields and a supplied idempotency key. A generated payload must contain only the edited paths.
- [x] **Implementation.** Derive both legacy exports from one descriptor list. Define CharacterEditorContext and createEditorDraft(context, loaded) with typed adapters for world-draft, campaign-main, campaign-preset and campaign-supporting. Keep DOM nodes, random IDs and network calls at the application boundary.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/campaign-cast-editor.test.ts tests/unit/character-profiles.test.ts
```

### 1B · Mount the shared World dialog

**Acceptance** 1.2, 1.3, 1.5

**Modify** `apps/web/public/index.html`, `apps/web/public/nexus.css`, `apps/web/src/nexus.js`.

**Create** `apps/web/src/character-editor/renderer.ts`.

**Interface.** Let `renderCharacterEditor(host, draft, actions)` mount the controls. The caller supplies save/close/generate handlers and retains the World draft. Browser actions must still find `#characterDialog`.

- [x] **Regression cases.** Move static markup/source assertions to rendered controls before removing markup. Exercise add, open existing character, Generate, Organize, mechanics rows, Delete, dismiss and resume. One alias per line must round-trip in both World and campaign modes.
- [x] **Implementation.** Mount renderCharacterEditor before Nexus captures dialog elements. Preserve #characterDialog, control IDs, nesting and busy-lock behavior with delegated disclosure handlers. Keep local Apply distinct from Save world. Preserve the campaign path until phase 2.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/management-ui.test.ts
pnpm exec playwright test tests/e2e/legacy-ui-authoring-disclosures.e2e.test.ts tests/e2e/ai-assist-resume.e2e.test.ts tests/e2e/legacy-ui-campaign-edits.e2e.test.ts
```

### 1C · Move preview calls and Organize provenance to the typed client

**Acceptance** 1.6, 1.7, 1.9

**Modify** `packages/contracts/src/client-api.ts`, `packages/client-web/src/api-client.ts`, `packages/client-web/src/http-client.ts`, `packages/client-web/src/index.ts`, `apps/web-next/src/character-workspace-api.ts`, `apps/web/src/nexus.js`, `packages/client-core/src/characters/editor-model.ts`.

**Interface.** Move `generateCharacterPreview` and `loadCharacterGenerationProgress` into `client-web`. The campaign save builder emits `editSource: "ai_organized"` with the accepted `organizerProtocolVersion`.

- [x] **Regression cases.** Use a 429 partial envelope, legacy input without profile, optional progressKey, and an Organize result with a recorded protocol version. Stage through Nexus, force a stale revision, reapply with the draft model and save through the API into PostgreSQL. Exercise the visible conflict controls in 2A. Assert recorded editSource and organizerProtocolVersion match the reviewed proposal. A discarded proposal followed by a manual save has manual provenance.
- [x] **Implementation.** Move generateCharacterPreview and progress parsing from Web-Next to client-web, preserve pre-call Web-Next sanitization, and add typed world/campaign Organize methods. Preserve status, code, message, details and reference ID in the HTTP parser. Store the accepted proposal version with its staged changes and carry both through the campaign PUT. Phase 2 reuses this conflict test.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/client-web/http-client.test.ts tests/unit/web-next-character-workspace-api.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/world-library.integration.test.ts
pnpm exec playwright test tests/e2e/legacy-ui-authoring-disclosures.e2e.test.ts
```

**Phase 1 exit.** Run `pnpm check:client-boundaries`, `pnpm build:web:legacy` and `pnpm build:web:next`. Compare desktop and narrow-screen disclosure, AI review and resume behavior to the pre-extraction cases.

**Phase 1 verification, 2026-11-08.** All five mapped unit suites passed. The World library integration suite checked the reviewed protocol in PostgreSQL after a stale campaign save, explicit model reapply and API reload. To include the rendered Nexus client in that test, build both web clients and set `NEXUS_EDITOR_BROWSER_PROOF=1` before running the 1C integration command. The visible conflict controls belong to 2A. The campaign audit holds one organizer protocol version per save. A review from another version can replace all earlier reviewed changes, or the author can save the earlier changes first.

Chromium covered Generate, Organize, aliases, mechanics, Delete, dismiss, resume and local Apply versus persisted Save. The screenshots show the [World editor](../../review/assets/unified-character-editor-phase-1/new-character-basic.png), [desktop review](../../review/assets/unified-character-editor-phase-1/campaign-organize-review-1440.png), [390px review](../../review/assets/unified-character-editor-phase-1/campaign-organize-review-390.png), [keyboard focus](../../review/assets/unified-character-editor-phase-1/character-appearance-keyboard-200-percent.png) and [error recovery](../../review/assets/unified-character-editor-phase-1/character-organization-error-retains-form.png). The fixtures used deterministic AI responses.

## Phase 2 · Share main-character editing and repair the Story panel

Use phase 1’s draft model, renderer and typed HTTP error adapter. Existing campaign authority supplies this phase.

### 2A · Share main-character editing and recover the draft after conflicts

**Acceptance** 2.1, 2.2, 2.6, 2.7, 2.8

**Modify** `apps/web/src/story.js`, `apps/web/src/nexus.js`, `apps/web/src/character-profile-form.ts`, `apps/web/src/character-editor/renderer.ts`, `packages/client-core/src/characters/editor-model.ts`, `packages/client-web/src/api-client.ts`.

**Interface.** Adapt `getCharacterProfile` and `updateCharacterProfile` to the shared editor. Reapply overlays only changed fields on the newest revision and carries the accepted Organize version.

- [x] **Regression cases.** Open the same protagonist from the campaign page and Story. Verify grouped fields, typed GET/PUT, a generation/recovery lock beginning while dirty, one close prompt with three outcomes, and Compare latest/Reapply or Discard after 409. Assert focus and field values after each outcome.
- [x] **Implementation.** Wire campaign-main to getCharacterProfile and updateCharacterProfile. Preserve changed paths during reapply to the latest revision. Keep campaign Organize on the campaign page and restore focus to the opener after Save.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/character-profiles.test.ts tests/unit/campaign-main-editor.test.ts tests/unit/management-ui.test.ts tests/unit/client-web/api-client.test.ts tests/unit/client-web/http-client.test.ts
pnpm exec playwright test tests/e2e/legacy-ui-campaign-edits.e2e.test.ts tests/e2e/legacy-ui-dialog-dismissal.e2e.test.ts tests/e2e/unified-character-editor.e2e.test.ts tests/e2e/editor-draft-recovery.e2e.test.ts tests/e2e/legacy-ui-authoring-disclosures.e2e.test.ts
```

### 2B · Consolidate the cast inbox and make sheet states accessible

**Acceptance** 2.3, 2.4, 2.5

**Modify** `apps/web/src/campaign-cast-panel.ts`, `apps/web/src/cast-review-queue.ts`, `packages/client-core/src/characters/sheet.ts`, `apps/web/src/character-editor/renderer.ts`, `apps/web/public/story.css`.

**Interface.** Use the existing workspace counts and sheet field descriptors. A conflict selects the character and focuses the field, while candidate actions still identify a specific candidate.

- [x] **Regression cases.** Exercise duplicate names in both editors without blocking Save. Verify counts and order of identity questions, details and conflicts, focus on the conflict field, aria-current, Show empty fields, and readable source labels. Cover a newly seeded, subsequently edited and imported main profile at 1440px and 390px using only the keyboard.
- [x] **Implementation.** Keep one panel-level inbox, scans and sources. Label protagonist provenance at profile level using stored-profile versus snapshot information, with an unknown fallback. Delegate editing to the shared renderer. Make reset/validation announcements and large touch targets follow the spec interaction matrix.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/campaign-cast-panel.test.ts tests/unit/cast-review-queue.test.ts tests/unit/campaign-cast-editor.test.ts tests/unit/character-review-decisions.test.ts
pnpm exec playwright test tests/e2e/campaign-cast.e2e.test.ts tests/e2e/legacy-ui-accessibility.e2e.test.ts tests/e2e/character-duplicate-warning.e2e.test.ts
```

**Phase 2 exit.** Run a complete keyboard edit in Story and on the campaign page. Attach 1440px and 390px screenshots for the editor, inbox, conflict, and focused validation message. Record database provenance separately from browser behavior.

**Phase 2 verification, 2026-11-08**

231 unit tests, 115 Chromium tests across the eight suites above, six additional Story generation-recovery browser cases and 30 World Library PostgreSQL integration tests passed. Both clients built, and the repository, TypeScript and client-boundary checks passed.

To rerun the six recovery cases on Windows, set `$env:NODE_OPTIONS = "--import=tsx"` for the Playwright process so its database fixture resolves workspace TypeScript sources. Run `pnpm exec playwright test tests/e2e/generation-integrity-diagnostics.e2e.test.ts --grep "revision-checked character profile|character profile form and story draft"`.

| Criteria | Evidence |
|---|---|
| 2.1, 2.2, 2.6–2.8 | Chromium exercised both editor entry points by keyboard, inline validation, all three dirty-close actions, generation and recovery locks, and both ways to resolve a revision conflict. A concurrent rename survived reapplying a local role edit. Save restored focus to the opener. |
| 2.3–2.5 | Browser fixtures covered case-insensitive duplicate aliases without blocking a save, selected cast state, empty fields, sources and direct inbox actions. Four provenance cases covered snapshot fallback, the initial stored copy, a subsequent edit and an unknown imported source. |
| Organize provenance | With both web clients built and `NEXUS_EDITOR_BROWSER_PROOF=1`, the World Library integration suite drove the campaign editor through a real PostgreSQL revision conflict. After Compare, Reapply and Save, the API reload and audit row retained the accepted proposal version. Organize used a deterministic provider fixture. |

| Screenshot | 1440px | 390px |
|---|---|---|
| Story editor | [Desktop](../../review/assets/unified-character-editor-phase-2/Story-editor-1440.png) | [Mobile](../../review/assets/unified-character-editor-phase-2/Story-editor-390.png) |
| Campaign editor | [Desktop](../../review/assets/unified-character-editor-phase-2/campaign-editor-1440.png) | [Mobile](../../review/assets/unified-character-editor-phase-2/campaign-editor-390.png) |
| Needs attention inbox | [Desktop](../../review/assets/unified-character-editor-phase-2/cast-inbox-1440.png) | [Mobile](../../review/assets/unified-character-editor-phase-2/cast-inbox-390.png) |
| Story conflict | [Desktop](../../review/assets/unified-character-editor-phase-2/Story-conflict-1440.png) | [Mobile](../../review/assets/unified-character-editor-phase-2/Story-conflict-390.png) |
| Campaign conflict | [Desktop](../../review/assets/unified-character-editor-phase-2/campaign-conflict-1440.png) | [Mobile](../../review/assets/unified-character-editor-phase-2/campaign-conflict-390.png) |
| Story validation focus | [Desktop](../../review/assets/unified-character-editor-phase-2/Story-validation-1440.png) | [Mobile](../../review/assets/unified-character-editor-phase-2/Story-validation-390.png) |
| Campaign validation focus | [Desktop](../../review/assets/unified-character-editor-phase-2/campaign-validation-1440.png) | [Mobile](../../review/assets/unified-character-editor-phase-2/campaign-validation-390.png) |

## Phase 3 · Introduce campaign authority and compatible readers

Write ADR 0042 first. Implement the compatible storage, policy and application contracts before exposing any seeding UI. Tasks 3D–3H share versioned event and snapshot contracts. Land their reader changes before activating writers.

### 3A · Record authority and protect roster and import readers

**Acceptance** 3.19, 3.29

**Modify** `docs/architecture/index.md`, `packages/contracts/src/world-library.ts`, `packages/domain/src/world-characters.ts`, `packages/domain/src/campaign-transfer.ts`, `packages/database/src/world-repository.ts`, `packages/database/src/campaign-transfer-character-repository.ts`, `services/runtime/src/portable-import-export-composition.ts`, `packages/database/src/portable-import-family-repository.ts`, `apps/web-next/src/character-workspace-model.ts`, `apps/web-next/src/character-workspace-page.ts`, `apps/web-next/src/authoring-character-parent.ts`, `packages/database/src/authoring-world-apply-adapter.ts`.

**Create** `docs/architecture/0042-unified-character-editor-and-starting-cast.md`.

**Interface.** Keep `resolvePlayableCharacters` selectable-only. Expose the complete roster separately for starting cast. A legacy roster entry parses as `playable`, `startingCastDefault: true`, `alwaysInContext: false`.

- [x] **Regression cases.** First record ADR 0042. Test a defaulted legacy entry, a name-only Supporting entry, a Supporting-only roster, and one selectable plus several NPCs. Import preview must auto-select the sole playable and reject a forged Supporting ID at apply. Regenerate Both synchronously and via durable review/resume, including old jobs.
- [x] **Implementation.** Keep world schema version 6 and playableCharacters storage. Extend campaignUse/startingCastDefault/alwaysInContext, provide separate all-roster and selectable resolvers, and validate IDs/readiness across the proper scopes. Audit generated assembly, source proposals, import, transfer and archive readers. Preserve ID, source, use, defaults and hidden mechanics at the shared apply boundary. Guard new Supporting generation until phase 5.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/world-library.test.ts tests/unit/web-next-character-workspace-model.test.ts tests/unit/web-next-character-workspace-page.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/task-14e3d-portable-composition.integration.test.ts tests/integration/campaign-transfer.integration.test.ts
pnpm exec playwright test tests/e2e/character-authoring-simplification.e2e.test.ts
```

### 3B · Migrate installation gates and load old policies

**Acceptance** 3.9, 3.17, 3.18

**Modify** `packages/contracts/src/instance-settings.ts`, `packages/domain/src/instance-settings.ts`, `packages/database/src/instance-settings-repository.ts`, `packages/database/src/config.ts`, `services/runtime/src/instance-settings.ts`, `services/runtime/src/local-single-user-settings.ts`, `services/api/src/instance-settings-composition.ts`, `apps/web-next/src/settings/page.ts`, `apps/web-next/src/settings/instance-editor.ts`, `compose.yaml`, `deploy/swarm/stack.yaml`.

**Create** `database/migrations/0129_character_settings_keys.sql`.

**Interface.** Read `castPresetsEnabled` and `castContextWithoutDiscoveryEnabled` from the versioned effective settings. The patch parser treats an absent key as unchanged. Local activation and managed policy activation feed the same runtime composition.

- [x] **Regression cases.** Start from a real pre-upgrade policy digest, seed, settings snapshot and event constraint. Boot, enable both flags locally, apply/restart, then patch an unrelated key and check history. Managed settings remain deployment_disabled until env and reissued policy permit them. Exercise the discovery-off upgrade case.
- [x] **Implementation.** Add castPresetsEnabled and castContextWithoutDiscoveryEnabled to the Characters registry, config and both manifests, default false. Version policy parsing without changing historical digests. Supply old snapshot defaults on reads only. Derive the history-key cap and widen the SQL constraint. Context requires editing, context enabled, and discovery or opt-in. Recheck migration numbering before creating the file.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/instance-settings-contract.test.ts tests/unit/instance-settings-policy.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/instance-settings-audit-upgrade.integration.test.ts tests/integration/instance-settings-features.integration.test.ts
pnpm exec playwright test tests/e2e/settings-panel.e2e.test.ts
```

### 3C · Capture eligibility outside cast events

**Acceptance** 3.24

**Modify** `packages/database/src/world-repository.ts`, `packages/database/src/campaign-state-repository.ts`, `packages/database/src/campaign-transfer-character-repository.ts`, `packages/database/src/portable-import-family-repository.ts`, `packages/database/src/system-archive-import-repository.ts`, `packages/database/src/system-archive-export-repository.ts`, `services/runtime/src/campaign-archive-export-composition.ts`, `packages/contracts/src/archives.ts`, `packages/contracts/src/system-archives.ts`, `packages/application/src/system-archives/portability-registry.ts`.

**Create** `database/migrations/0130_campaign_first_appearance_eligibility.sql` and `database/migrations/0131_selected_character_world.sql`. The second migration records the source world of a newly selected protagonist. Branches, transfers and archives carry this comparison-only provenance. A historical campaign with unknown provenance conservatively reserves its selected roster ID.

**Interface.** Read/write `firstAppearanceEligible` on the campaign root and in the enclosing Campaign/System Archive record. Copy the persisted value independently of `copyCampaignCast` or the number of cast events.

- [x] **Regression cases.** Create otherwise identical empty native campaigns with effective presets on/off. Enable presets, branch, migrate, transfer, export and import each into another scope. Verify true/false even without a cast payload. Legacy rows, story-text imports and old archives missing the marker read false. Against those restored scopes, invoke the seed decision and explicit-Add service when 3E and 3H are available, before phase 3 ships.
- [x] **Implementation.** Write firstAppearanceEligible at native campaign creation in its existing transaction. Preserve it across every copy path and in versioned enclosing archive records. Classify as portable authority. Use the same eligibility decision for automatic discovery and held approval. Verify the persisted marker at the phase 3 boundary, then repeat these fixtures through normal publication and explicit Add in phase 4.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/world-library.integration.test.ts tests/integration/campaign-transfer.integration.test.ts tests/integration/campaign-archive.integration.test.ts tests/integration/system-archive.integration.test.ts
```

### 3D · Project a full seeded profile and bind edits to its activation

**Acceptance** 3.1, 3.2, 3.16, 3.21, 3.22, 3.25

**Modify** `packages/contracts/src/campaign-cast.ts`, `packages/domain/src/campaign-cast.ts`, `packages/database/src/campaign-cast-repository.ts`, `packages/database/src/campaign-cast-lifecycle.ts`, `packages/domain/src/campaign-cast-attachments.ts`, `packages/client-core/src/characters/profile-fields.ts`, `packages/client-core/src/characters/editor-model.ts`.

**Interface.** Project `(events, observations, boundary)` into `originProfile`, `campaignProfile` and effective values with their sources. Scope authored edits to `seedEventId`. Expose distinct detail, roster-summary, observation, override and snapshot schemas.

- [x] **Regression cases.** Exercise fixed, blank discoverable, updating and observed fields using conflicting facts, claims, an intentional blank appearance override and restored goals followed by a new observation. Include 3,000-character background, 20,000-character goals and distinct legacy text. Check sheet, detail, receipts, source badges and rewind before an existing-row seed.
- [x] **Implementation.** Add seed_profile with immutable roster identity, world evidence, structured profile and legacy guidance. Bind edit_authored_profile to seedEventId. Use one effective resolver with a domain/client policy parity test. Keep full-fidelity detail separate from 200-character roster summaries, 2,000-character observations and bounded prompt fields. Apply restore-goals cutoff after supersession. Ensure a corrected-away identity cannot be kept alive just by its seed.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/campaign-cast-contract.test.ts tests/unit/campaign-cast-projection.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-repository.integration.test.ts tests/integration/campaign-cast-lifecycle.integration.test.ts
```

### 3E · Make Apply and authored edits atomic across API and clients

**Acceptance** 3.5, 3.11, 3.12, 3.13, 3.27, 3.28

**Modify** `packages/contracts/src/campaign-cast.ts`, `packages/contracts/src/campaign-cast-discovery.ts`, `packages/application/src/campaign-cast/ports.ts`, `packages/application/src/campaign-cast/use-cases.ts`, `packages/database/src/campaign-cast-repository.ts`, `packages/database/src/campaign-cast-candidate-repository.ts`, `services/api/src/campaign-cast-routes.ts`, `services/api/src/request-admission.ts`, `packages/client-web/src/campaign-cast-api.ts`, `apps/web/src/cast-review-queue.ts`, `services/runtime/src/campaign-cast-composition.ts`.

**Interface.** Expose `GET cast/from-world-preview`, `POST cast/from-world` and `POST cast/:id/authored-profile` through `createCampaignCastApi`. A preview returns the pin, target, revisions, boundary and fingerprint. An identical committed replay returns the stored `castWriteResult`.

- [x] **Regression cases.** Preview two same-name targets, a blank versus authored world role, independent goal/appearance overrides and different identity aliases. A new pin, target edit or stale revision must cause 409 without partial mutation. Replay an identical request and compare receipts. Send a worst-case escaped/multibyte multi-field body and an illegal confirm on a seeded stable field through HTTP.
- [x] **Implementation.** Implement GET from-world-preview, POST from-world and POST :id/authored-profile with the spec request/response shapes. Recompute the preview fingerprint under lock and validate owner, generation lock, revisions, path classes, allowlisted errors and byte limits. One event covers Apply transitions or all authored/override/identity edits. Return allowedActions per review item for both clients and recheck on write. Register typed methods, request admission and error mappings for each new route.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/campaign-cast-application.test.ts tests/unit/cast-review-queue.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-api.integration.test.ts
pnpm exec playwright test tests/e2e/campaign-cast.e2e.test.ts
```

### 3F · Preserve v3 events through replay and portable copies

**Acceptance** 3.3, 3.4, 3.14, 3.15, 3.20

**Modify** `packages/contracts/src/campaign-cast.ts`, `packages/contracts/src/archives.ts`, `packages/contracts/src/system-archives.ts`, `packages/database/src/campaign-cast-portability.ts`, `packages/database/src/campaign-cast-lifecycle.ts`, `packages/database/src/campaign-transfer-character-repository.ts`, `services/runtime/src/campaign-archive-export-composition.ts`, `packages/database/src/system-archive-export-repository.ts`, `packages/database/src/system-archive-import-repository.ts`, `packages/application/src/system-archives/portability-registry.ts`.

**Interface.** Extend `portableCampaignCastSchema`, `portableCastReferences` and `copyCampaignCast`. The v2/v3 selector inspects commands, values and receipts after validating them against their declared format.

- [x] **Regression cases.** Load historical v1 and v2 fixtures and verify original fingerprints. Export/import v2-compatible data as v2, a lone long ordinary goal override as v3, and a seeded character with receipts and world roster defaults as v3. Try an unknown version, a v3-only value labeled v2, a dangling activation and cross-owner references. Assert no partial import.
- [x] **Implementation.** Select cast format by commands and values including receipts. Extend enclosing archive readers before new writes. Remap seed event and world evidence IDs, preserving historical provenance on cross-world transfers. Gate existing-record seeds/edits by turn, retain lagged same-event create/seed together when appropriate, and exercise archive, branch and rewind independently. Verify metadata (/meta in task 3G) and captured-world filtering (task 3H).
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-portability.integration.test.ts tests/integration/campaign-cast-lifecycle.integration.test.ts tests/integration/campaign-archive.integration.test.ts tests/integration/system-archive.integration.test.ts
```

### 3G · Version and budget narrator context

**Acceptance** 3.6, 3.7, 3.23, 3.26

**Modify** `packages/contracts/src/story-memory-policy.ts`, `packages/contracts/src/story-prompt.ts`, `packages/contracts/src/campaign-cast-context.ts`, `packages/domain/src/campaign-cast-context.ts`, `packages/domain/src/character-fiction-authority.ts`, `packages/database/src/generation-authority.ts`, `packages/database/src/story-memory-policy-repository.ts`, `services/runtime/src/generation-context-planner.ts`, `services/runtime/src/campaign-cast-context-preview.ts`, `packages/contracts/src/client-api.ts`, `services/api/src/server.ts`, `packages/contracts/src/campaign-cast-discovery.ts`.

**Interface.** Keep `captureCastGenerationSnapshotWithClient` and `selectCastContext` as the capture/selection boundary. Admit the new matching frozen prompt and context protocols together. Preserve the historical pair for previously admitted work.

- [x] **Regression cases.** Retry a stored pre-upgrade admission after restart and compare the rendered prompt, source IDs and fingerprint. New admissions must bootstrap an incompatible chain. Exercise zero headroom, one identity and 30 long pins plus recently active characters. Capture actual requests with synthetic credentials, private reasoning, mechanics, extension fields and a foreign campaign canary.
- [x] **Implementation.** Freeze the new prompt/context pair together. Retain the old parser, selector and renderer. Capture allowlisted fiction, validate and cap each field at 600 characters including joined appearance. Reserve tokens for the serialized envelope and admitted identities, fill core fields in rounds, then optional fields, with deterministic omission reasons and a 3,000-token ceiling. Send restored goals and dated lower-authority state according to discovery/enrollment status. Expose castContext and castPresets in strict /meta and verify both through the API.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/campaign-cast-generation-protocol.test.ts tests/unit/campaign-cast-context.test.ts tests/unit/generation-context-planner.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-generation.integration.test.ts tests/integration/generation-budget-growth.integration.test.ts
```

### 3H · Freeze discovery hints and rehearse the reader rollout

**Acceptance** 3.8, 3.10

**Modify** `packages/contracts/src/campaign-cast-discovery.ts`, `packages/domain/src/campaign-cast-world-identities.ts`, `packages/domain/src/campaign-cast-discovery.ts`, `packages/database/src/campaign-cast-discovery-publication.ts`, `packages/database/src/campaign-cast-job-repository.ts`, `services/runtime/src/campaign-cast-discovery-adapter.ts`, `apps/web/public/story.html`, `docs/runbooks/campaign-cast.md`.

**Interface.** Pass frozen `identityHints` with the captured character IDs. The second publication validation pairs those hints with the current scoped identities and still checks identity changes.

- [x] **Regression cases.** Use strict-policy fixtures with a seeded identity that has a qualifying role/appearance hint. Confirm once at capture and again at publication, with no duplicate roster hint and no review item. Replay an older snapshot without hints. Rehearse boot/read on old data and incompatible-write boundaries on an isolated installation.
- [x] **Implementation.** Feed sanitized bounded role, pronoun and appearance hints into both validation passes and omit represented world identities by scoped origin. Update the rewind notice. Document deploy order for Compose and Swarm and the effective presets-off cutoff. Record when newer settings, a Supporting world, new cast values and subsequent lifecycle writes restrict rollback. Phase 3 exits with compatible API, worker, rewind/copy and archive readers everywhere.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/campaign-cast-world-identities.test.ts tests/unit/campaign-cast-discovery.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-discovery.integration.test.ts tests/integration/instance-settings-rollout.integration.test.ts
```

**Phase 3 exit.** Verify both settings are off after an unconfigured upgrade, historical archive fixtures import, old admissions retry, and every API/worker/restore role understands v3. Test Apply, skip, revision conflicts and eligibility through application boundaries using isolated fixtures. Rehearse the settings-save, roster-publication and v3-only write boundaries on a disposable recovery set.

**Phase 3 verification, 2026-11-08**

The full unit run passed 5,559 tests with 44 skips. The 17-suite PostgreSQL run passed 257 tests with 46 platform skips. The secure Linux archive, transfer and upgrade run passed 159 tests across eight suites without skips. The three mapped Chromium suites passed 77 tests. Both web builds, repository and TypeScript checks, and client boundaries passed. The provider checks used a deterministic text provider.

| Tasks | Observed behavior |
|---|---|
| 3A–3C | The selectable roster excludes Supporting entries. Existing local settings retain their policy digest and can activate both new gates. Managed gates require a reissued policy and deployment permission. Campaign and System Archive imports preserve eligibility with zero cast events. |
| 3D–3F | The HTTP service rejected a stale preview without changing the cast and replayed the original receipt after a later edit. PostgreSQL checks covered seeded field authority, field-specific review decisions, rewind, branch, transfer, v2/v3 selection and activation remapping. |
| 3G | A retried v17 job reproduced its recorded cast content, field sources and fingerprint. A new v18 request used the bounded fiction projection. Synthetic model requests verified that private reasoning, credentials, extension fields and mechanics stayed out of provider input. |
| 3H | Strict discovery matched a seeded identity using its frozen hints at extraction and publication. Disposable database copies exercised current and baseline API and worker processes. See the [reader and recovery rehearsal](../../review/unified-character-editor-phase-3-rehearsal.md). |

| Chromium interaction | Desktop | 390px |
|---|---|---|
| Character authoring and review | [Review](../../review/assets/character-reader/character-review-1440.png) | [Keyboard focus](../../review/assets/character-reader/character-review-390.png) |
| Installation gates | [Settings](../../review/assets/settings-panel/native-character-options-1440.png) | [Settings](../../review/assets/settings-panel/native-character-options-390.png) |
| Fixed-field review in Nexus | [Review](../../review/assets/unified-character-editor-phase-3/fixed-field-legacy-1440.png) | [Review](../../review/assets/unified-character-editor-phase-3/fixed-field-legacy-390.png) |
| Fixed-field review in Web-Next | [Review](../../review/assets/unified-character-editor-phase-3/fixed-field-next-1440.png) | [Review](../../review/assets/unified-character-editor-phase-3/fixed-field-next-390.png) |

## Phase 4 · Enable authoring and starting cast in Nexus

Use the phase 3 reads, transitions, flags and versioned writers. Enable presets only on a compatible installation.

### 4A · Expose world authoring and the starting-cast picker

**Acceptance** 4.1, 4.2, 4.3, 4.4, 4.5, 4.14, 4.18, 4.21, 4.23

**Modify** `apps/web/src/nexus.js`, `apps/web/public/index.html`, `apps/web/public/nexus.css`, `apps/web/src/character-editor/renderer.ts`, `packages/client-core/src/campaign-creation-draft.ts`, `packages/contracts/src/client-api.ts`, `packages/database/src/world-repository.ts`, `packages/application/src/world-campaign/types.ts`, `docs/nexus-guide/worlds/characters.md`.

**Interface.** Keep `characters` selectable-only in the world-version list response and add `startingCastCandidates`. `buildCampaignCreateRequest` reads selected roster IDs and per-entry `alwaysInContext` from the open dialog.

- [x] **Regression cases.** Open an old world and then one with Playable, Supporting and Both. Switch use twice and compare mechanics byte-for-byte. Check name-only save, hidden Supporting Generate, completeness, duplicate/new ID, reorder and prepublish readiness. Switch protagonists at 30 selections, then back. Verify cap, selections, warning above five pins, empty/retry states and dialog-close reset.
- [x] **Implementation.** Expose use/defaults/pin controls in World. Return selectable characters and unfiltered startingCastCandidates in one typed world-version read. Keep local selections and pins keyed by roster ID until the dialog closes. Exclude the selected main character, cap preselection in roster order, drop stale IDs with a notice, and keep disabled presets hidden with their explanation.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/campaign-creation-draft.test.ts tests/unit/legacy-campaign-creation-ui.test.ts
pnpm exec playwright test tests/e2e/legacy-ui-world-readiness.e2e.test.ts tests/e2e/legacy-ui-campaign-creation.e2e.test.ts
```

### 4B · Create campaign and starting cast in one transaction

**Acceptance** 4.6, 4.9, 4.12, 4.13, 4.15, 4.22, 4.24, 4.31

**Modify** `packages/contracts/src/world-library.ts`, `packages/contracts/src/client-api.ts`, `packages/database/src/world-repository.ts`, `packages/database/src/campaign-cast-repository.ts`, `services/api/src/world-campaign-application-adapter.ts`, `services/api/src/server.ts`, `packages/client-web/src/api-client.ts`, `packages/client-core/src/campaign-creation-draft.ts`, `apps/web/src/nexus.js`, `docs/nexus-guide/campaigns/create.md`.

**Interface.** `POST /api/v1/campaigns` accepts optional `startingCast`. Return `skippedStartingCast` with the successful campaign ID when applicable. A non-empty selection with presets disabled returns the public `cast_presets_disabled` 503.

- [x] **Regression cases.** Inject failure midway through a multi-seed create and verify rollback. Send invalid/duplicate/main IDs, omit startingCast, disable presets with a non-empty list, and load a Supporting-only roster. Inspect the typed 503 code/reference and safe readiness issue. On Create and Create and start verify that an invalid name/alias is reported, the campaign exists exactly once and the result cannot submit again. Edit the source draft and one of two campaigns copied from the same pin. Assert the other campaign and published version retain their original values.
- [x] **Implementation.** Extend native create with the spec’s optional list of at most 30 entries. Resolve all IDs against the locked pin and call seedCampaignCastWithClient at turn/revision zero with preallocated IDs, one event per chosen character and deterministic keys. Use common fiction eligibility and skippedStartingCast reporting. Map only the specified safe HTTP errors. Use the typed create method. Drive notices independently from seeding and effective narrator capability/enrollment, linking to the created campaign.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/client-web/api-client.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/world-library.integration.test.ts tests/integration/world-campaign-route-application.integration.test.ts
pnpm exec playwright test tests/e2e/legacy-ui-campaign-creation.e2e.test.ts
```

### 4C · Publish first appearances and restore detached records

**Acceptance** 4.10, 4.17, 4.26, 4.30

**Modify** `packages/database/src/campaign-cast-job-repository.ts`, `packages/database/src/campaign-cast-discovery-publication.ts`, `packages/database/src/campaign-cast-candidate-repository.ts`, `packages/domain/src/campaign-cast-world-identities.ts`, `packages/domain/src/campaign-cast-attachments.ts`, `packages/database/src/campaign-cast-repository.ts`, `packages/database/src/world-repository.ts`.

**Interface.** Call the shared internal seed writer with the database client already holding the campaign lock. Attach a suppressible seed only to the attachment that established this automatic match.

- [x] **Regression cases.** Pause publication across migration, shutdown of presets and restart. Exercise strict and unique matches to a renamed Both protagonist’s old name, held approval and direct Add/Apply. Use the eligible/ineligible empty-campaign copies from 3C. Detach a corroborated first appearance and a later unrelated match separately.
- [x] **Implementation.** Under the campaign lock require the frozen permission, live gate and campaign eligibility for automatic seeding. Re-resolve the scoped roster ID against the current pin, route ambiguous or changed identities to review, reserve the protagonist, and use plain discovery where allowed. Use roster identity for create, tie seed suppression only to its establishing attachment, and keep explicit Add available for ineligible campaigns with presets on.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-discovery.integration.test.ts tests/integration/campaign-cast-lifecycle.integration.test.ts tests/integration/campaign-cast-api.integration.test.ts tests/integration/campaign-cast-portability.integration.test.ts
```

### 4D · Finish preset editing in Story and on the campaign page

**Acceptance** 4.7, 4.8, 4.11, 4.16, 4.19, 4.20, 4.25, 4.27, 4.28, 4.29

**Modify** `apps/web/src/nexus.js`, `apps/web/src/story.js`, `apps/web/src/composition.ts`, `apps/web/src/campaign-cast-panel.ts`, `apps/web/src/character-profile-form.ts`, `apps/web/src/character-editor/renderer.ts`, `packages/client-core/src/characters/editor-model.ts`, `packages/client-core/src/characters/sheet.ts`, `packages/client-web/src/campaign-cast-api.ts`, `docs/player-guide/characters-and-stats.md`.

**Interface.** Use `campaign-preset` for a currently seeded NPC and `campaign-supporting` for a manual or discovered NPC. `open(characterId)` in the Story panel consumes the `character` query parameter.

- [x] **Regression cases.** Seed Ferryman, hand-edit to Guide, detach the mistaken match, then explicitly reapply the same profile. Require the same cast ID, a fresh activation, effective Ferryman and Guide only in prior history. Rewind before detach and verify Guide. Repeat for a different profile. Also check reset of canonical aliases, restore-goals timing, all badge/action states, stale Apply preview, both form factors and deep-link focus. Assert the exact field badges, reset/clear/restore actions, accessible focus and lock retention on both entry points. Confirm ordinary NPCs still expose their 11 fields.
- [x] **Implementation.** Implement Add/Apply using 3E on both surfaces, with full detail on demand. Use shared editors for all campaign characters, including archived campaigns. Lock on pending or recoverable generation via sync-status before open/save and preserve the draft on a live lock. Open in Story targets the specified character. Remove obsolete form maps/panel renderer once imports from both clients are checked. Finish the phase 4 guide and build both clients.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/campaign-cast-panel.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-api.integration.test.ts
pnpm exec playwright test tests/e2e/campaign-cast.e2e.test.ts tests/e2e/legacy-ui-campaign-edits.e2e.test.ts
```

**Phase 4 exit.** Run the create → Story → edit → migration/rewind → reopen sequence against an isolated database. Exercise both enabled and disabled configurations. Capture the skipped-entry result, Add/Apply preview, reset/restore controls and campaign-to-Story deep link at both widths.

**Phase 4 verification, 2026-11-08.** All 106 tests in the four mapped Chromium suites passed, covering Nexus World, campaign creation, the campaign page and Story. The real PostgreSQL browser proof creates a campaign with a skipped name, follows its character deep link, edits and resets the profile, migrates, rewinds and reopens it. It also applies a second world profile to an existing same-name cast member and verifies the cast ID. Both web clients build. The preset and narrator settings remain opt-in.

- To repeat the real browser proof, start the legacy Vite server, set `PLAYWRIGHT_LEGACY_PORT` to that port and set `NEXUS_CAST_BROWSER_PROOF=1` for the mapped World Library integration command. `CAST_SCREENSHOT_ROOT` selects the evidence directory.
- The six mapped integration suites passed 154 tests on Windows. The secure-filesystem import case requires POSIX and passed in the supplemental three-suite Linux run (94 tests). Both runs used disposable PostgreSQL databases. The 15 related unit suites passed 482 tests, including a field-badge matrix and a combined identity reset, role reset, goal restore and observed-appearance clear.
- Desktop and 390px evidence covers the [starting cast picker](../../review/assets/unified-character-editor-phase-4/starting-cast-390.png), [skipped-entry result](../../review/assets/unified-character-editor-phase-4/skipped-result-390.png), [Apply preview](../../review/assets/unified-character-editor-phase-4/apply-preview-1440.png), [reset and restore controls](../../review/assets/unified-character-editor-phase-4/reset-restore-controls-390.png) and [Story deep link](../../review/assets/unified-character-editor-phase-4/story-deep-link-1440.png).

## Phase 5 · Add reviewed bulk and AI authoring

Use phase 4’s local World draft and normal campaign saves. Suggest, conversion and Draft from story are independently testable.

### 5A · Suggest and expand a reviewed cast

**Acceptance** 5.1, 5.2, 5.3, 5.4, 5.10, 5.11, 5.12, 5.13, 5.15

**Modify** `packages/contracts/src/world-library.ts`, `packages/contracts/src/prompt-library.ts`, `packages/contracts/src/provider-output-schema.ts`, `packages/contracts/src/text-response-format.ts`, `packages/contracts/src/generation-response-contract.ts`, `packages/story-engine/src/provider-output-schema.ts`, `packages/database/src/prompt-repository.ts`, `packages/domain/src/character-authoring.ts`, `services/runtime/src/provider-world-generation-adapter.ts`, `services/api/src/server.ts`, `services/api/src/request-admission.ts`, `packages/client-web/src/api-client.ts`, `apps/web/src/nexus.js`.

**Interface.** `POST /api/v1/worlds/playable-characters/suggest-cast-preview` accepts `{ content, direction?, count }`. Expansion uses generate-preview with `{ seed, campaignUse: "supporting" }`. Bound the reviewed seed list to the requested count.

- [x] **Regression cases.** Request 3–8 suggestions, including an all-duplicate response and a collision absent from a 100-name/4,000-character sample of a 20,000-entity world. Verify zero through requested count, no automatic refill, bounded repair on name mismatch, independent row retry/stop and close warning. Assert provider outage leaves manual entry and drafts intact. Capture serialized requests and logs with synthetic private and instruction-like input.
- [x] **Implementation.** Add the typed suggest-cast-preview method and bounded non-legacy prompt/operation/repair schemas. Expand selected seeds serially via generate-preview. Use a separate Supporting contract, retain reviewed name, ignore generated mechanics and preserve hidden mechanics on existing targets. Keep old snapshots and the shared durable character-authoring protocol valid. Only Add selected mutates the local draft and only Save world persists.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/direct-authoring-response-contract.test.ts tests/unit/authoring-prompts.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/world-generation.integration.test.ts
pnpm exec playwright test tests/e2e/character-authoring-simplification.e2e.test.ts tests/e2e/legacy-ui-authoring-disclosures.e2e.test.ts
```

### 5B · Convert entities and unify identity lookup

**Acceptance** 5.5, 5.6, 5.14, 5.16

**Modify** `packages/domain/src/entity-references.ts`, `packages/domain/src/campaign-cast-world-identities.ts`, `packages/contracts/src/world-library.ts`, `packages/database/src/world-repository.ts`, `packages/contracts/src/system-archives.ts`, `packages/database/src/system-archive-export-repository.ts`, `packages/database/src/system-archive-import-repository.ts`, `apps/web/src/nexus.js`, `docs/nexus-guide/worlds/characters.md`, `packages/database/src/chronicle-entity-catalog.ts`.

**Interface.** A valid `linkedCharacterId` references an entry in the same World content. Both catalogs consume the same linked occurrence and explicit retained alias set. A new converted entry has `startingCastDefault: false`.

- [x] **Regression cases.** Convert one description-only and one name-colliding NPC locally without a provider. Keep or retire the former name explicitly. Check ambiguous and unique matches in discovery and Chronicle before/after campaign copy, relationship endpoints with context off, stale-link rejection on save/publish, and archive round-trip of typed conversion provenance.
- [x] **Implementation.** Implement the spec’s pure field mapping, preserve unconverted values in the preview and keep the entity ID as the relationship endpoint. Append Supporting with startingCastDefault false. Resolve linked aliases through one shared occurrence rule. Clear links on roster deletion and validate against the current draft at every write. Handle map-shaped legacy input only in the pure mapper. Verify one character has been added for each approved row, original relationships still resolve when cast context is disabled, and cancelling the local draft persists no conversion.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/entity-references.test.ts tests/unit/campaign-cast-world-identities.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/system-archive.integration.test.ts
pnpm exec playwright test tests/e2e/legacy-ui-world-readiness.e2e.test.ts
```

### 5C · Draft only from attributable accepted story evidence

**Acceptance** 5.7, 5.8, 5.9

**Modify** `packages/contracts/src/campaign-cast.ts`, `services/api/src/campaign-cast-routes.ts`, `packages/client-web/src/campaign-cast-api.ts`, `services/api/src/request-admission.ts`, `packages/domain/src/campaign-cast-discovery.ts`, `packages/database/src/campaign-cast-repository.ts`, `packages/contracts/src/prompt-library.ts`, `packages/contracts/src/provider-output-schema.ts`, `packages/contracts/src/text-response-format.ts`, `services/runtime/src/campaign-cast-composition.ts`, `apps/web/src/character-editor/renderer.ts`, `docs/player-guide/characters-and-stats.md`, `packages/application/src/campaign-cast/ports.ts`.

**Create** `services/runtime/src/cast-draft-preview.ts`.

**Interface.** `POST cast/:id/draft-preview` returns proposals, evidence spans, omitted paths and server-verifiable fences. Both existing campaign PATCH and authored-profile POST accept `draftEvidenceFences` on reviewed factual edits.

- [x] **Regression cases.** Test a valid attributed quote, wrong subject, negation, dialogue claim, detached evidence and a mention-only passage. Assert zero provider calls with no eligible spans. Verify citation and value support, reject malformed whole output, and label the creative otherGuidance exception. Correct accepted narration after preview and attempt both save paths. Expect cast_draft_evidence_changed (409), preserved draft, no observation or partial edit.
- [x] **Implementation.** Add cast/:id/draft-preview and a versioned non-legacy campaign prompt without campaign override. Bound to 40 citations / 24,000 characters and assign exact server-scoped span IDs. Send only safe projected text using the selected campaign provider. Offer proposals only on blank eligible fields. Attach server-verifiable fences to selected factual draft edits, revalidate on PATCH and authored-profile save, and repeat 5A’s provider outage, privacy and logging checks for this endpoint. Raise the normal save-route body limits to include legitimate evidence fences and preserve generic error redaction.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/campaign-cast-provider-contract.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-api.integration.test.ts
pnpm exec playwright test tests/e2e/campaign-cast.e2e.test.ts
```

**Phase 5 exit.** Demonstrate each preview with deterministic provider fixtures, no-provider behavior and cancellation where applicable. Confirm zero automatic writes or observation creation. Record live provider quality separately if an operator validates it. Publish the guides for Suggest, Convert and Draft from story. The first delivery track can close here.

**Phase 5 verification, 2026-11-08.** The 20 affected unit suites passed 394 tests, including the five files mapped above. All 78 tests in the three mapped integration suites passed against isolated Linux PostgreSQL (10 World generation, 54 System Archive, 14 cast API). The archive test exported and imported converted entity links and provenance. The final Linux cast discovery, repository and API run passed 110 tests, including the 14 cast API tests. The opt-in Chromium proof also edited an actual seeded cast from the Nexus campaign page using PostgreSQL.

All 109 Chromium tests in the four mapped browser suites passed. The rendered checks cover no-provider manual entry, empty seeds, serial expansion, stop and retry, edits before adding, explicit world save, entity conversion and retained relationships. Story tests cover generation locks, per-field suggestions, cited turns, creative guidance, manual edits, stale citations, and comparing and reapplying across a changed campaign revision. Both clients exercise new and existing Supporting characters with hidden mechanics. Model responses in these checks use deterministic fixtures. Live-provider output quality is unassessed.

[Screenshot evidence](../../review/assets/unified-character-editor-phase-5) includes Nexus cast suggestions and entity conversion at desktop and phone widths, both Story editors, and Web-Next Supporting generation.

## Phase 6 · Release reversible lifecycle operations

Start a separate release branch or PR series from the accepted phase 5 baseline. First distribute the v4 readers. Keep lifecycle writes inactive until all readers are compatible and the operations below have passed their release tests.

### 6A · Ship lifecycle readers and rehearse v4 portability

**Acceptance** 6.4, 6.14

**Modify** `packages/contracts/src/campaign-cast.ts`, `packages/database/src/campaign-cast-lifecycle.ts`, `packages/database/src/campaign-cast-portability.ts`, `packages/database/src/campaign-cast-repository.ts`, `packages/contracts/src/archives.ts`, `packages/contracts/src/system-archives.ts`, `packages/database/src/system-archive-import-repository.ts`, `packages/database/src/campaign-transfer-character-repository.ts`, `docs/runbooks/campaign-cast.md`.

**Interface.** Phase 6 adds portable v4. `mergeEventId`, `sourceCharacterId`, seed references and source evidence must resolve after remapping. Lower-format payloads must continue to round-trip after v4 support is installed.

- [x] **Regression cases.** Start from v1–v3 fixtures and a lifecycle-only v4 fixture without presets. Test import into the new reader and rejection before mutation by the phase 5 reader. Verify valid command order, both IDs on copy, stale merge references, rewind before/after events, branch, transfer and both archive families.
- [x] **Implementation.** Define v4 discriminants merge/unmerge/remove/restore, including merge choices, scope checks and alias provenance. Extend live projection and portable reference remapping. Keep all new writers disabled during reader distribution. Repeat these tests with actual events from 6B–6D before activation.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/campaign-cast-contract.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-lifecycle.integration.test.ts tests/integration/campaign-cast-portability.integration.test.ts tests/integration/campaign-archive.integration.test.ts tests/integration/system-archive.integration.test.ts
```

### 6B · Merge and undo with traceable choices

**Acceptance** 6.1, 6.2, 6.3, 6.11

**Modify** `packages/domain/src/campaign-cast.ts`, `packages/database/src/campaign-cast-repository.ts`, `packages/database/src/campaign-cast-discovery-publication.ts`, `packages/database/src/campaign-cast-candidate-repository.ts`, `packages/domain/src/campaign-cast-attachments.ts`, `services/api/src/campaign-cast-routes.ts`, `packages/client-web/src/campaign-cast-api.ts`, `packages/application/src/campaign-cast/ports.ts`, `apps/web/src/campaign-cast-panel.ts`.

**Interface.** `POST cast/:id/merge` takes the target in the URL, both character revisions, `sourceCharacterId`, `reviewedAliases` and field choices. `unmerge` identifies the original `mergeEventId`.

- [x] **Regression cases.** Preview 21 candidate aliases, conflicting manual goals and an intentional blank appearance override. Reject a forged alias, wrong target, missing choice or stale source revision. Undo after an independent target edit and alias removal/re-entry. Verify pending candidates, outstanding jobs and detach follow the effective identity, and Resolve does not recreate the source.
- [x] **Implementation.** Compute preview from two full detail reads. Submit reviewedAliases and source/target choices, revalidate both records with revision/boundary and generation checks, require the seeded target when only one is seeded and reject the protagonist. Persist manual precedence, earlier alias ownership and merge-owned changes. Resolve chains on projected copies; undo replays independent edits while respecting subsequent active merge dependencies.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run tests/unit/campaign-cast-projection.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-discovery.integration.test.ts tests/integration/campaign-cast-api.integration.test.ts
pnpm exec playwright test tests/e2e/campaign-cast.e2e.test.ts
```

### 6C · Remove and restore across discovery, context and Chronicle

**Acceptance** 6.5, 6.9, 6.10, 6.12

**Modify** `packages/database/src/campaign-cast-repository.ts`, `packages/database/src/campaign-cast-status-repository.ts`, `packages/database/src/campaign-cast-review-sql.ts`, `packages/database/src/campaign-cast-candidate-repository.ts`, `packages/database/src/campaign-cast-chronicle-metadata.ts`, `packages/database/src/chronicle-context-repository.ts`, `packages/domain/src/campaign-cast-context.ts`, `packages/database/src/campaign-cast-discovery-publication.ts`, `services/api/src/campaign-cast-routes.ts`, `packages/client-web/src/campaign-cast-api.ts`, `apps/web/src/campaign-cast-panel.ts`.

**Interface.** `remove` and `restore` operate on the supporting character with the standard cast write fences. Use the `removed` list filter and return `cast_character_removed` on stale pending-item resolution.

- [x] **Regression cases.** Remove with pending identity and resolved-detail items. Resolve from a stale tab, complete a paused job and invalidate one old quote before Restore. Assert 409 on stale resolution, silent valid updates, name held for uniqueness, no context/catalog/attention entry while removed, and only valid pending items on restore. Run catalog assertions for merge/unmerge as well.
- [x] **Implementation.** Write turn-gated soft remove/restore events and refresh Chronicle on all four lifecycle commands. Filter read, count and resolve using the current merge-resolved target. Include a Removed roster filter, confirmation, and Restore on duplicate name. Preserve the seed, evidence and valid post-removal updates.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-discovery.integration.test.ts tests/integration/campaign-cast-api.integration.test.ts tests/integration/campaign-cast-generation.integration.test.ts
pnpm exec playwright test tests/e2e/campaign-cast.e2e.test.ts
```

### 6D · Promote selected fields to an owned world draft

**Acceptance** 6.6, 6.7, 6.8, 6.13

**Modify** `packages/contracts/src/campaign-cast.ts`, `services/api/src/campaign-cast-routes.ts`, `packages/client-web/src/campaign-cast-api.ts`, `packages/application/src/campaign-cast/ports.ts`, `packages/database/src/authoring-world-apply-adapter.ts`, `packages/database/src/world-repository.ts`, `packages/database/src/system-archive-export-repository.ts`, `packages/database/src/system-archive-import-repository.ts`, `packages/contracts/src/system-archives.ts`, `packages/application/src/system-archives/portability-registry.ts`, `apps/web/src/campaign-cast-panel.ts`, `docs/player-guide/characters-and-stats.md`.

**Create** `database/migrations/0132_campaign_cast_promotion_receipts.sql`. Migration 0131 already belongs to selected-character world identity.

**Interface.** `GET cast/:id/promotion-preview?worldId=...` returns destination-keyed candidates. `POST cast/:id/promote` receives the selected source for each destination, both scopes’ revision fences and the idempotency key.

- [x] **Regression cases.** Target a foreign or archived world, a stale target revision and a protagonist. Verify client and server reject prohibited lifecycle actions. On Add, omit a valid name or supply two sources for one destination. On Replace, send a single approved appearance choice, leave goals unticked and retry the request. Assert one draft revision, immutable published/campaign data and no exported campaign IDs.
- [x] **Implementation.** Implement typed promotion-preview and promote. Build destination-keyed choices, require an Add name and resolve authored versus observed appearance explicitly. In one owner-scoped transaction lock the draft and campaign as needed, check revisions/lock, permit only confirmed fields and store an idempotency receipt with the draft write. Preserve target ID, mechanics and use on Replace. Classify receipt as operational, and only the typed campaign-promotion provenance as portable. Add a draft-write receipt migration in the phase 6 release, keyed by owner, destination draft and idempotency key. Compare the request fingerprint on replay, return the original result before checking stale revisions for an identical retry, and reject key reuse with a different payload.
- [x] Run the focused verification commands and record the result for each layer.

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-api.integration.test.ts tests/integration/world-library.integration.test.ts tests/integration/system-archive.integration.test.ts
pnpm exec playwright test tests/e2e/campaign-cast.e2e.test.ts
```

**Phase 6 exit.** Record the reader versions in use by the API, worker, CLI/import and recovery paths. Exercise a no-presets campaign whose first lifecycle write is Remove. Rehearse v4 import, replay and rollback before writer activation. Capture merge/undo, Removed/Restore and promotion screens at both widths. Publish the lifecycle guide and updated cast runbook with this release.

**Phase 6 verification, 2026-11-08.** The separate release branch starts at the Phase 5 commit `1006fa71`. New installations and upgrades start with `CAST_LIFECYCLE_ENABLED=false`. The compatible reader can display removed records while the writer cutoff is in effect.

- The four mapped Linux PostgreSQL archive and lifecycle suites passed all 117 tests. Coverage includes lifecycle-only v4 data, invalid alias deltas before import, rewind, branch, cross-world transfer and both archive families. A separate recovery drill opened a restored pre-boundary database with the exact Phase 5 reader and accounted for the later Remove. [Reader inventory and recovery drill](../../runbooks/deployment.md#cast-lifecycle-reader-rollout-and-rollback)
- All 426 tests in the 35 affected unit suites passed. Six additional PostgreSQL suites passed 174 tests covering cast API, discovery, generation, repository, merge and world library behavior. The cast browser suite passed 74 checks, and the campaign editor browser suite passed 10.
- The PostgreSQL-backed campaign-page browser proof merged, previewed undo, restored both identities, removed and restored a supporting character, and promoted selected fields to a world draft. It checked the persisted draft revision and provenance. To repeat, run the World Library integration suite with the opt-in browser settings documented under Phase 4.
- Story browser checks cover the side-by-side character fields, explicit conflict resolution, alias limits, keyboard cancellation, Removed and Restore, Add and Replace, stale draft refresh and writer cutoff. [Desktop and phone screenshots](../../review/assets/unified-character-editor-phase-6)
- The repository checks, client boundary checks and both web builds passed. Production rollout starts with the operator verifying all deployed readers and the installation’s own backup set. [Lifecycle operations](../../runbooks/campaign-cast.md)

## Phase 7 · Remediate review findings

Applies the [round-2 amendments](../specs/2026-11-08-unified-character-editor-and-starting-cast-design.md#round-2-amendments) and the review of the built code. An item is ticked once it is implemented and the affected suites pass. Dedicated regression tests exist for A1, A2, A3, D1, D15, Convert and D13; the other ticked items rely on the existing cast suites. D5, D7, D11, D12 and D14 already matched the decisions in the built code, and D17's name release is covered by the updated merge discovery test.

### 7A · Cast authority and lifecycle

- [x] **A2** Lag-published seeds keep their evidence turn and survive rewind and branch.
- [x] **A1** Approving a held match writes a suppressing attachment.
- [x] **A4** Seed lookups exclude merged-away and removed records.
- [x] **A5** World entities with no roster entry go through plain discovery.
- [x] **D16** A seed carried from another world does not count as represented.
- [x] **D18** Not this character is blocked while the target has an active merge.
- [x] **D19** Undo merge is rejected on a removed target.
- [x] **D20** Promoted NPCs get `startingCastDefault: false`.
- [x] A world version referenced by seed evidence cannot be deleted.

### 7B · Narrator context

- [x] **D1** New ordering applies only to campaigns with an active seed.
- [x] **D2** Goals use the latest observation during gaps.
- [x] **D3** Goal truncation is recorded.
- [x] **D4** Legacy guidance is not sent for seeded NPCs.
- [x] **D6** Linked entity prose is dropped for seeded NPCs when context is on.
- [x] **A6** Authored fields use the canon semantic role.

### 7C · Clients and settings

- [x] **D13** Only skipped characters interrupt Create and start.
- [x] **D10** Main-character save needs no guidance in Nexus.
- [x] **D14** A `failed` generation does not lock character edits.
- [x] **D15** Local installs can unlock context and editing gates from the panel.
- [x] **D9** Web-Next's world summary lists selectable characters only.
- [x] **A3** Removing a Web-Next character clears its entity links.
- [x] **A7** The preset editor shows legacy source text read-only.
- [x] Convert writes notes to one editable field.
- [x] `loadWorldVersionPlayableCharacters` uses the typed client (4.22).

### 7D · Standards and documentation

- [x] **A8** Draft from story validates world content and shares its rules.
- [x] **D8** The runbook requires replacing all nodes at once.

### 7E · Legacy cleanup

- See [8G](#8g--legacy-cleanup-428) for **4.28**: remove the panel's `renderEditor`, Story's `character-profile-form.ts` use and `CHARACTER_PROFILE_FIELDS`.

**Moved.** 4.28 is broken into ordered steps in [8G](#8g--legacy-cleanup-428).

**Known failures.** Six unit tests fail on the phase-6 commit before this remediation. They are closed in [8A](#8a--restore-a-green-unit-suite).

## Phase 8 · Close remaining open items

Every item left open after phase 7. Tick an item only after its check has passed.

### 8A · Restore a green unit suite

- [x] **8.1** `csp-ui`: the inline-handler guard matches the `onClose =>` parameter in `nexus.js`. Rename the parameter and leave the guard as it is.
- [x] **8.2** `legacy-provider-modal`: update the assertion to the current `Apply to suggestion` or `Apply to world draft` label.
- [x] **8.3** `client-web/api-client`: update the `client.worlds` key list to include the added method.
- [x] **8.4** `probe-structured-output` (3 tests): align the probe's call budget and expected plan with the operations added in phase 5, and fix the synthetic response behind `invalid_json` at call 8.

### 8B · Server rules and contracts

- [x] **8.5** `parseHttpError` keeps a server `message` only for recognized error shapes. Any other JSON body gets the generic message.
- [x] **8.6** `restoreAuthoredGoals` is rejected with no authored goal (repository), and with any goal override operation (contract).
- [x] **8.7** An empty `""` on an updating field is rejected by the shared override schema on both the PATCH and the authored-edit routes. Clients send a clear instead. Observed appearance keeps its intentional empty override.
- [x] **8.8** `generationRouteIds` validates `characterId` as a UUID.
- [x] **8.9** `skippedStartingCast` is always present and bounded in the campaign response.
- [x] **8.10** Promote with Replace keeps the replaced character's `source`.
- [x] **8.11** Promote marks mechanics-like text unselectable and gives the reason.
- [x] **8.12** The legacy `playableCharacters` reader in `campaign-state-repository.ts` returns selectable characters only.
- [x] **8.13** Seeded observed appearance: no change. The spec makes it latest-wins and never a conflict (criterion 3.16), which `resolveSeededCastProfile` and the repository's conflict count already do.

### 8C · Client behavior

- [x] **8.14** The "Left blank, this can be filled from the story" text appears only on paths with a discoverable cast field.
- [x] **8.15** Suggest cast blocks duplicate names within a batch and after a seed is edited, and its cost text states the true provider-call bound.

### 8D · Audit items to confirm or fix

Each item is either confirmed with a pointer to the code or test, or fixed.

- [x] **8.16** The alias textarea has one limit, from one helper.
- [x] **8.17** The async leave guard covers every exit: Back, Cancel, Close, Escape, story links and page unload all pass through `requestNavigation` or `beforeunload` (`campaign-cast-panel.ts`). No change.
- [x] **8.18** Story deep links open after the campaign and startup checks. The `character` parameter is now removed before opening, so a reload does not reopen the editor. A failed load shows the panel's own error.
- [x] **8.19** The main-character list uses `worlds.playableCharacters`, not the cast API. No change.
- [x] **8.20** Both error branches in `campaign-cast-routes.ts` send `details.fields` and a named code. The panel and world picker read them. No change.
- [x] **8.21** Restoring a tick above the 30 cap leaves it unticked with a notice (A10).
- [x] **8.22** Displaced values are returned by the from-world preview as `changes` with an `effect`, and manual overrides are kept. No change.
- [x] **8.23** The spec has no `activeSeed` field. `originProfile.seedEventId` carries the active seed and the contract validates it. No change.
- [x] **8.24** `allowedActions` and per-field data are served by the candidate repository and honored by `cast-review-queue.ts`. No change.
- [x] **8.25** Every error code named in the spec exists in the server code. No change.
- [x] **8.26** `previewEntityConversions` joins notes and keeps over-limit originals as unconverted data. No change.
- [x] **8.27** Add from world candidates: `GET cast/from-world` (`worldChoices`) already covers this, under a different route name than the review expected. No change needed.

### 8E · Regression tests

- [x] **8.28** D18: Not this character is blocked while a merge depends on the seed.
- [x] **8.29** D19: Undo on a removed target and Promote of a removed character are both blocked.
- [x] **8.30** D6: a seeded NPC's linked entity prose is dropped and the relationship endpoint is kept.
- [x] **8.31** A12: seed, turn presets off, confirm edit and context still work and from-world routes return 503.

### 8F · Standards

- [x] **8.32** Scope the id-only `UPDATE` in `campaign-cast-candidate-repository.ts` to the owning campaign.
- [x] **8.33** Key receipt lookups by owner or campaign as well as `job_id`.
- [x] **8.34** Move the SQL in `cast-draft-preview.ts` into a repository.

### 8G · Legacy cleanup (4.28)

Do these in order, because each step leaves the app working. Web-Next has its own `character-profile-form` and is unaffected.

- [x] **8.35** Moved the module to `apps/web/src/character-editor/campaign-main-form.ts` and repointed `nexus.js`, `story.js` and `campaign-main-editor.test.ts`.
- [x] **8.36** `createCharacterProfileForm` already built its controls with the shared renderer, so it moved unchanged. `apps/web/src/character-profile-form.ts` no longer exists.
- [x] **8.37** The panel's field markup now comes from the shared renderer (`createCastTextField`, `renderSupportingEditorFields`). `renderEditor` remains only as the panel's orchestration of duplicate warnings, pin and ignore, conflict recovery and focus.
- [x] **8.38** Removed `CHARACTER_PROFILE_FIELDS`. `nexus.js` reads `WORLD_PROFILE_FIELDS` directly.
- [x] **8.39** `index.html` has no static character fields. `#characterDialog` is an empty host that the renderer fills. No change.
- [x] **8.40** Run client boundaries, both web builds, unit tests, and the campaign-cast, legacy-ui-campaign-edits, authoring-disclosures and unified-character-editor browser suites.
- [x] **4.28** Tick once 8.35 to 8.40 pass.

## Release evidence and rollback

| First incompatible change | Evidence before activation | Recovery after activation |
|---|---|---|
| Phase 3 settings save | Load old policy/seed/digest, save and restart in local and managed modes. Verify every live reader understands the added keys. | Retain compatible settings readers. Earlier binaries can reject the complete stored snapshot even with presets off. |
| First published Supporting/Both world | Verify every selection, transfer, import and authoring reader against the mixed roster. | Keep compatible readers. Earlier selection logic can offer an NPC as the protagonist. |
| First seed, authored edit or other v3-only cast value | Rehearse read, retry, rewind, branch, transfer and both archive families on disposable data. | Disable new seeding at the effective writer cutoff and retain v3 readers. Existing seeded characters remain editable under cast editing and eligible for context. |
| **Separate phase 6 release, first v4 lifecycle event** | Deploy v4-capable readers with lifecycle writers inactive, verify every role and rehearse a lifecycle-only campaign before activation. | Disable lifecycle writers and retain v4 readers. A downgrade across this boundary requires a rehearsed pre-boundary restore and an explicit accounting of intervening writes. |

Before submitting each phase, run the applicable task suites, `pnpm check`, `pnpm check:client-boundaries`, the affected web builds, and `git diff --check`. For visible changes attach desktop and 390px screenshots, including keyboard focus and failure states. Use a disposable PostgreSQL database and deterministic provider for end-to-end state assertions. Record live-provider quality separately. Keep production activation, announcements and cutover evidence with the corresponding release.
