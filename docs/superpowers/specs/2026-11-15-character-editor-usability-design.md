# Character editor usability: Nexus and Web-Next

**Status:** Proposed, revised 2026-11-15 after design and implementation-plan review. All eight review findings are addressed below and mapped to implementation tasks. No deployment or capability activation is implied.

Builds on, and must not regress, [unified character editor](2026-11-08-unified-character-editor-and-starting-cast-design.md), [Nexus character authoring workspace](2026-11-14-nexus-character-authoring-workspace-design.md) and [character review dismissal and retraction](2026-11-14-character-review-dismissal-and-retraction-design.md). Precedence decision: [ADR 0045](../../architecture/0045-current-state-edits-yield-to-newer-story-evidence.md).

## Language

The terms used here are defined in `CONTEXT.md` under *Characters and cast*: Cast, Main Character, Supporting Character, Starting Cast Character, Discovered Character, Added Character, Observation, Correction, State Edit and Retraction. User-facing copy never says "protagonist", "preset" or "override". Badges say "Your edit" and "From story".

## Surfaces

| Surface | App and route | Files |
|---|---|---|
| Nexus campaign cast | `apps/web`, `/nexus/` | `campaign-cast-panel.ts`, `character-editor/*` |
| Nexus world character dialog | `apps/web`, `/nexus/` | `nexus.js` character dialog, `character-editor/renderer.ts`, `workspace.ts` |
| Web-Next in-story Characters dialog | `apps/web-next`, `/app/` | `characters-workspace.ts`, `character-profile-form.ts` |
| Web-Next world character workspace | `apps/web-next`, `/app/` | `character-workspace-page.ts`, `character-workspace-model.ts` |

Nexus already has lifecycle actions (Remove, Restore, Merge, Undo merge, Add to world draft), a Removed filter, Add from world, Draft from story, a detailed section workspace, Organize and duplicate-name protection. Web-Next has none of these. Nexus is delivered first.

## Problems

P1. Rosters in both apps render each character as a button followed by one dot-joined text line, so every fact has the same weight.
P2. Tracking diagnostics, attention counts and tool buttons sit above search and the roster.
P3. Character sheets are read-only text. Every change goes through a separate editor form.
P4. Conflicts read "Conflicting observations" without the competing values, and there is no way to say an Observation is wrong from the sheet.
P5. Pin and Ignore exist only in the edit form.
P6. Search runs only on submit.
P7. Every user edit locks its field, so current location, condition, clothing and goals go stale as the story moves on (ADR 0045).
P8. The roster labels Starting Cast Characters "Discovered", the same label as characters found by tracking (`characterProvenanceLabel`).
P9. Web-Next lacks lifecycle actions, the Removed filter, Add from world and Draft from story.
P10. The Web-Next supporting editor's groups do not match the sheet, every field is a textarea, labels are not associated, and a save gives no confirmation.
P11. The Web-Next world workspace opens existing characters on Method with later stages locked.
P12. Web-Next Character use is only on Method. `startingCastDefault` and `alwaysInContext` have no control.
P13. Web-Next mechanics use a list/detail editor, and unnamed items read "Item N".
P14. Web-Next fields show no guidance, although the registry has a `world.title` and `world.placeholder` for each.
P15. Web-Next retained guidance cannot be organized into fields.
P16. Neither world editor can refine one section with AI.
P17. Web-Next saved AI proposals are labelled by raw job ID.

## Behavior

### Precedence (domain)

B1. **State Edit precedence.** A State Edit (`state.location`, `state.condition`, `state.clothing`, `story.goals`) stays in force until a fact Observation of that field exists from a turn strictly later than the edit's turn. Same-turn Observations never replace it. Retracted, superseded and invalidated Observations never count. A Correction (any other field) stays in force until cleared. The rule covers every Supporting Character type and existing edits, and the sheet, roster summaries and narrator context all use it.
B2. **Tracking gaps.** Under V3, fields with a State Edit follow B1 in every tracking status. `pending` covers the normal lag after each accepted turn, and any replacing Observation is strictly later than the edit, so it is never older evidence. Current-state fields *without* an edit keep today's gap behavior: they are omitted while tracking is `pending` or `failed`. Narrator authority and evidence come from the same replacement predicate: a replaced State Edit is sent with observation authority and the Observation's evidence, never with `authority: "user"`. Stable facts still honor retractions and supersession. Discovery `off` retains its distinct last-known-state behavior. Fiction is frozen at job capture; retries and resumes do not consult live tracking. V2 capture and recapture keep "edit always wins", selected by the frozen context version, so pre-upgrade V2 jobs resume with unchanged fingerprints.
B3. **Narrator wording.** The authority contract and cast notice state both kinds of edit, under new V3 prompt-protocol and context-policy versions. Complete tracking: *"User corrections are portrayal authority from their effective turn. User state edits are authority until later story evidence. Older conflicting facts remain historical evidence."* Incomplete tracking: *"Tracking is incomplete. User corrections remain portrayal authority; user state edits are authority until later recorded story evidence. Stable observations are dated historical evidence. Other dynamic observations are omitted. Use accepted history for intervening events."*

V3 must be recognized through policy pairing, prompt-snapshot validation and identity selection, mandatory contracts, context/history classifiers, context preview, generation capture/planning, and continuity review/repair. The frozen job policy selects the version explicitly; a default or live setting must not upgrade an existing job. Reader support ships before V3 enqueue is enabled, and enabling enqueue is its own final change after the end-to-end proof. Phase 0 activation requires `observationDecisions`, the only remedy for a wrong later Observation (ADR 0045). Verify enqueue → frozen snapshot → provider request → review/repair → restart/resume for V3, plus V2 replay and incompatible-pair rejection. Discovery-off copy is: *"Character discovery is off. User corrections guide portrayal; state edits yield to later recorded story evidence. Observations are dated last-known state; use accepted history for later events."*

### Rosters (both apps)

B4. **Roster rows.** The name is the primary action. Each row has a one-line role summary of at most 120 code points and badges for Main, Pinned, Ignored, Removed, Needs review (count) and Conflict (count), with a muted "Last seen turn N". Provenance labels: Main Character "Main character", Starting Cast Character **"From world"**, Discovered Character "Discovered", Added Character "Added by you". The Main Character is listed first; otherwise server order.
B5. **Tracking status.** One status line (tone and headline) above the roster. Details, gap recovery, retry, Scan earlier story and Likely included sit in a collapsed "Tracking and tools" disclosure. Beside search: "Needs attention (N)", "Add character" and, when `castPresets` is enabled, "Add from world" as a secondary action.
B6. **Live search.** Filtering runs 250 ms after the last keystroke and immediately on filter change or submit. A response for an older query never replaces a newer one.

### Character sheet (both apps)

B7. **Editing on the sheet.** Each editable field has Edit, which swaps the value for the registry control (single-line for `input: "text"`, otherwise textarea) with Save and Cancel. Save sends exactly one field change through the character's existing write path and fences:
   - Added and Discovered Characters: cast edit.
   - Starting Cast Characters: the existing authored-profile edit (`buildPresetRequest` → `editAuthoredProfile`), which already carries stable fields as `set`/`reset` and current-state fields as `setOverrides`/`clearOverrides`.
   - Main Character: the revisioned profile endpoint.

   On success the sheet refreshes and announces "Saved {label} · Undo". The controller retains this notice and Undo across a same-character refresh; refresh is not navigation. Leaving the character/campaign or closing the dialog invalidates pending results and clears Undo. On 409 the typed value stays and Compare latest (Load latest version for the Main Character) is offered. Fields are read-only while generation is active, editing is disabled, the character is removed or merged away, or another sheet save is pending. One inline editor is open at a time, and switching away from a dirty one asks to discard. Main Character writes use the existing revisioned full-profile contract, preserving untouched values; the exact sparse-payload rule applies to Supporting Character paths.
B8. **Undo.** Undo is a compensating write through the same endpoint, not journal deletion or restoration of an old event timestamp. Define its inverse by write path: Main Character fields restore their previous concrete value; name and aliases restore only their own previous value, never a combined identity reset; toggles restore their prior boolean; Starting Cast stable fields restore a prior campaign edit or reset only that authored path when it was inherited; cast/state overrides restore an edit that was in force or clear that one override when none was in force. Undo of a replaced State Edit clears the new override instead of reviving the stale value. It covers field saves, toggles, "Use story value", "Use discovered value" and "Reset to world", and stays available until the next edit, navigation, or 30 seconds.

Undo is bound to the cast revision, character revision and boundary returned by its own successful write (Main Character: returned profile revision). A detail refresh must match those fences before Undo is offered, and the inverse uses those same fences. If another write lands before refresh, withdraw Undo; if it lands afterward, Undo must conflict without side effects. Never adopt a later revision automatically. Character tracking advances the cast revision after accepted turns, so Undo is often withdrawn during play. Withdrawal reads *"Saved {label}. Undo expired: the character was updated after your save."*, not a save failure. Preserve the saved notice if refresh fails, explain that the save succeeded but the view could not refresh, and do not offer Undo until matching authority is available.
B9. **Provenance.**
   - A field in force from the user reads "Your edit · turn N".
   - A field from story reads "From story · turn M".
   - A State Edit replaced by newer evidence reads "From story · turn M" with the note "Replaced your edit from turn N".
   - On an Added or Discovered Character, a Correction with a newer disagreeing Observation shows "Story differs: {value} · turn M" and "Use story value", which clears the Correction.
   - A Starting Cast Character's stable fields never show "Story differs", because the authored value outranks Observations and matching candidates are hidden (`isSeededFixedCandidateHidden`). A campaign edit there offers "Reset to world", which resets only that authored path.
   - An unverified claim reads "Unverified claim"; a static conflict reads "Conflict".
   - The Main Character's fields have no provenance badges.

Client provenance derives active retracted IDs from `detail.observationDecisionStatus`; retained Observations are history, not proof of eligibility. Pass that set to replacement and supplying-fact selection and exclude it from conflict choices and "Story differs". Keep supersession edges even when the superseding Observation is retracted. Retraction controls require both the capability and an `eligible` decision status. Tests cover retract → reload → restored State Edit, repeated values, and a retracted superseding fact.
B10. **"This is wrong".** A "From story" field offers "This is wrong" when the `observationDecisions` capability is present and its supplying Observation has decision status `eligible`. It opens the existing Retraction preview (current → resulting value, quote and turn); confirming applies it and refreshes. Read-only evidence stays visible without the Retraction action. Edit stays available beside it.
B11. **Conflict picker.** A conflicting field lists each distinct competing value with its latest turn and quote. Each value whose displayed Observation is eligible has "This is wrong" (Retraction), and the field has "Write my own" (opens B7). Without `observationDecisions`, each value has "Use this" instead, which saves a Correction with that value. Quotes are text, never HTML.
B12. **Quick toggles.** Pin and Ignore are toggle buttons in the sheet header with `aria-pressed`, saved immediately and covered by Undo. They are not offered for the Main Character.

### Web-Next parity

B13. **Lifecycle.** Remove from cast, Restore, Merge with another character, Undo merge and Add to world draft, with the same capability gates, previews and copy as Nexus, plus the Removed filter when `castLifecycle` is defined.
B14. **Editor form.** Groups and order follow the registry sections used by the sheet. Text fields are single-line, every control has a visible associated label, and a successful save opens the sheet and announces "Saved {name}".
B15. **Draft from story.** The Add/Edit character editor offers the existing evidence-backed draft review (`draftPreview`), as in Nexus.
B16. **Add from world.** As in Nexus (`castPresets`), from the roster action in B5.

### Web-Next world workspace

B17. **Entry.** Editing an existing character opens on Review with every stage unlocked. Creating keeps the step flow. An existing character's Method stage reads "Regenerate with AI".
B18. **Use and context flags.** Identity holds Character use and, for supporting/both, "Select by default in starting cast" and "Always include in narrator context".
B19. **Mechanics table.** Statistics (Name, Value, Note) and Trackers (Name, Condition, Effect), with per-row Remove, one-step Undo remove and Add row. Unnamed rows read "Unnamed statistic"/"Unnamed tracker". Extension keys and order are preserved.
B20. **Field guidance.** Each field shows the registry `world.title` as help text and uses `world.placeholder`.
B21. **Organize.** For world-editor origin, Story offers "Organize notes with AI…" using the existing world-draft organize endpoint. Proposals show evidence, and Apply selected changes only the chosen fields. For world-creation origin it shows "Organize is available after the world is saved."
B22. **Proposal labels.** "{New character | Edit existing character} · {status} · expires {local date}".

### AI refine (both world editors, last and separately releasable)

B23. Identity, Story and Appearance offer "Refine with AI". It takes an instruction, calls the existing character-preview generation, and shows current vs proposed for that section's paths only. Apply changes only those paths; ID, name, source, use flags and mechanics never change. Cancel or failure leaves the character unchanged.

Capture the current unsaved candidate when Generate is pressed. In a cloned, validated world-content request, replace its roster entry by ID or append it for a new character; send that candidate's ID in either mode. Never mutate the live world roster just to create a preview. The provider must receive the current candidate, including unsaved changes, rather than the original session roster. If the candidate changes while generation/review is pending, discard the proposal and ask for regeneration; navigation, Cancel and disposal also invalidate late results. Test both new and existing characters and inspect the request received by the provider adapter.

## Constraints

- Phase 0 (B1–B3) changes the domain projection, repository field sources, frozen narrator-context selection and protocol consumers under V3 versions (ADR 0045). No phase adds a database migration, API endpoint, provider operation, capability flag or storage-format change; V3 capture uses the existing snapshot envelope with version-selected fiction values.
- Writes keep their existing revision, boundary, idempotency, generation-lock and capability fences.
- Untrusted text is rendered with `textContent` only.
- Field labels, inputs and limits come from `CHARACTER_FIELD_DESCRIPTORS`, with no second registry. The current-state field set is defined once, in contracts.
- `packages/client-core` stays DOM-free (`pnpm check:client-boundaries`).
- Shared DOM components live in `apps/web/src/character-editor/` and are imported by Web-Next, following the `observation-review.js` precedent.
- `cast-review-queue.ts` (both copies) and the review-decision code are not modified.
- Minimum target 44×44 CSS px; usable at 390 px width and native 200% zoom.

## Acceptance

- **A0** Precedence: strictly-later replacement, same-turn retention, gap behavior in actual captured/provider fiction (edited fields replaced by later tracked facts, unedited dynamic fields omitted, replaced edits never sent as user authority), V2 pre-upgrade capture → post-upgrade resume with unchanged fingerprint, discovery-off behavior, retraction interplay and V3 wording (B1–B3). Real PostgreSQL plus a deterministic provider proves V3 enqueue, review/repair and restart/resume, unchanged V2 replay, and campaign isolation.
- **A1** Rosters, status, live search and provenance labels in both apps (B4–B6).
- **A2** Sheet editing for all four character types, with exact sparse Supporting Character requests and revisioned full-profile Main Character requests that preserve untouched values (B7).
- **A3** Undo, provenance, "This is wrong", conflict picker and toggles (B8–B12), including every inverse write path, notice/Undo survival through refresh, both intervening-write races, refresh failure, retracted retained evidence and stale navigation results.
- **A4** Web-Next parity (B13–B16).
- **A5** World workspace (B17–B22).
- **A6** AI refine in both world editors (B23), with unsaved existing/new candidate payloads, section-only application and stale-candidate rejection.
- **A7** Existing unit, browser and PostgreSQL suites for cast, character workspace, story memory policy and world library pass, updated only where B1–B4 intentionally change the expected result.

Browser acceptance includes Nexus and Web-Next sheets and world workspaces at desktop and 390 px, keyboard interactions, and actual native 200% browser zoom. Extend the dedicated Nexus native-zoom suite and add a Web-Next counterpart; CSS zoom is not equivalent. Record screenshots under `docs/review/assets/character-editor-usability/`. Run the opt-in composed PostgreSQL/browser proof in `world-library.integration.test.ts` through real API saves, reload, Undo and retraction in both clients. The acceptance record distinguishes fixture-browser, composed database/browser, native-zoom and deterministic-provider evidence; mark skips and physical-mobile-keyboard/live-provider limitations explicitly.

## Review finding coverage

| Finding | Requirement | Plan owner |
|---|---|---|
| 1. Incomplete V3 rollout | B3, A0 | Tasks 3, 3c |
| 2. Gap-aware context and authority attribution | B2, A0 | Tasks 3a, 3b |
| 3. Retractions omitted from client provenance | B9–B11, A3 | Tasks 5, 6 and 9 |
| 4. Refresh loses Saved/Undo | B7–B8, A3 | Tasks 9, 11 and 15 |
| 5. Incomplete inverse operations | B7–B8, A2–A3 | Task 6 |
| 6. Undo adopts intervening writes | B8, A3 | Tasks 6, 11 and 15 |
| 7. Refine omits unsaved candidate | B23, A6 | Tasks 7, 24 and 25 |
| 8. Missing browser evidence | A4–A7 | Owning Tasks 11, 15–23 and 25; Task 26 runs and records them |
