# Nexus quick-create and detailed character editor design

**Status:** Implemented in the Nexus working tree. The user selected quick-create plus a dedicated detailed editor, with usability first. See [acceptance results](../../review/nexus-character-workspace-acceptance.md) for verification and remaining device-level limits.

**Date:** 2026-11-14

**Scope:** Nexus (`apps/web`) World Library and campaign management. Shared code must remain compatible with Story and Web-Next; this release does not redesign either client's Story experience.

**References:** [Current critique](../../../.impeccable/critique/2026-11-14T21-02-32Z__apps-web-src-character-editor-renderer-ts.md), [conformance review and fixes](../../review/2026-11-14-character-editor-tracker-conformance.md), [approved character design](2026-11-08-unified-character-editor-and-starting-cast-design.md), [ADR 0042](../../architecture/0042-unified-character-editor-and-starting-cast.md), [implementation plan](../plans/2026-11-14-nexus-character-authoring-workspace.md).

## Outcome and boundaries

An author can create a useful character quickly, then edit a long profile without losing orientation, draft content or access to completion controls. Existing characters open directly in the detailed editor. A new character's quick and detailed views share one unsaved editing session.

Retain the current Nexus palette, typography, familiar controls and gold primary action. This is an Operate surface: the character, destination and next action take precedence over decorative containers. Reduce nested borders and repeated optional explanations. Do not introduce a new visual identity or dependency.

This phase changes presentation and local editing orchestration, not character authority. No database migration, new API, prompt-protocol change, new provider call, new capability flag or storage-format change is planned. The existing design's field policy, validation and round-2 amendments remain authoritative.

Explicitly deferred: full-profile expansion for manual/discovered supporting characters, field-scoped creative generation, persistent draft recovery after refresh, templates, portraits, NPC image conditioning, structured relationships and Web-Next editor parity. Existing smaller supporting profiles remain fully editable; do not invent new stored fields to fill the new navigation.

## Entry points and ownership

| Entry | Initial surface | Commit destination | Return |
|---|---|---|---|
| World roster: Add character | Quick-create | Current in-memory world draft | Same roster, new row focused |
| World roster: Edit character | Detailed editor | Current in-memory world draft | Same roster/filter/scroll position |
| Suggest cast: edit a finished suggestion | Detailed editor | Unsaved suggestion via its existing callback | Same suggestion row; no roster insertion |
| Campaign page: edit protagonist | Detailed editor | Existing campaign profile API | Same campaign selection |
| Campaign page: new manual supporting character | Quick-create | Existing create-cast API | New character sheet |
| Campaign page: edit supporting/preset character | Detailed editor | Existing cast or atomic authored-profile API | Same character sheet |
| Story main/supporting editors | Existing presentation | Existing contracts | Existing Story location |

Use a dedicated full-viewport workspace inside the existing native dialog host, not a larger version of the old scrolling modal. The host supplies focus containment and parent suspension; the interior is a header, section navigation, working area and action bar. No new addressable editor route is introduced in this phase. This avoids serializing unsaved fiction in a URL or implicitly saving a world to navigate to another page. Existing world/campaign links and Open in Story keep working.

The underlying world dialog can remain open behind the character dialog as it does today, but it is inert to input while the character editor owns focus. Switching quick/detailed presentation must not close the host, dismiss the parent, change its edit-session epoch, issue a save or replace the draft with a server reload. Closing restores the invoking control; if it was removed, focus the roster heading or campaign sheet heading.

## Quick-create

The world form shows Name, Use in campaigns, Role and Personality. Playable remains the default. Supporting/Both exposes the existing starting-cast and context-preference checkboxes in one secondary disclosure. A manual campaign character omits world-use and world-only settings. Keep the existing context-specific validation: a world Supporting character can be name-only; selectable world characters need guidance; campaign creation uses its current contract.

Use a compact dialog, at most 42rem wide on desktop and fitting the available mobile viewport. Keep the small primary form above AI tools. When a default text provider is available, a secondary “Draft with AI” disclosure exposes the existing concept/generation workflow; manual entry always works. Generated values outside the quick fields are retained and summarized as additional details, not discarded or implicitly approved.

Actions:

- Primary: **Add to world draft** or **Create campaign character**, matching the actual operation.
- Secondary: **Continue in detailed editor**. This performs no write and allows incomplete input; validation belongs to commit, not navigation.
- Tertiary: **Cancel**, using the existing dirty-edit guard.

Once continued, the detailed editor becomes the authoring surface until close. A Back-to-quick action is unnecessary; section navigation provides the concise essentials view. Repeated clicks must not allocate another ID or create another character. Preserve stable IDs under AI generation and save retries.

## Detailed workspace

Desktop layout:

```text
Back to world / character sheet    Mira Vale           World draft: Example
                                  Unsaved changes
----------------------+-------------------------------------------------
Overview              | Section heading and compact explanation
Identity              | Labeled fields / current values / provenance
Personality and voice | [optional read-only sheet preview]
Appearance            |
Current situation     |
History and notes     |
Mechanics             |
Sources and history   |
----------------------+-------------------------------------------------
More actions          | Status              Cancel   Apply to world draft
```

Navigation contains only sections available in the current context. Use the shared field registry rather than copying field lists into each renderer. Overview contains the existing core fields; each editable field appears in one location, without duplicate IDs or independent values. Goals, identity, authored appearance, observed appearance, mechanics and provenance retain their existing semantics even if grouped differently.

On desktop, use a 12–15rem section rail and a fluid working area with a readable text measure. On narrow screens, replace the rail with a labeled Section selector and previous/next section actions. Keep the name/destination header and compact action bar visible. Use available dynamic viewport height and safe-area insets; ensure the action bar does not cover fields, validation, focus outlines or an open software keyboard. At 200% zoom, collapse to the narrow layout rather than force horizontal scrolling.

Section summaries describe actual content: “6 details,” “2 statistics, 3 trackers,” or “Not added.” Count populated editable fields, not every array item, except mechanics counts. Do not present an overall percentage or imply optional fields are required. Show an error indicator on sections with validation failures. Choosing a section focuses its heading; an error jump focuses the specific invalid field and reveals its section.

Keep section selection and expansion state for the active session, including AI review and conflict recovery. Do not persist fiction or draft values in localStorage/sessionStorage. Reopening a saved character starts at Overview; parent roster search/scroll is retained while navigating into and out of the editor.

Read-only **Preview sheet** uses effective local draft values, renders user text safely, and offers a way back to editing. It is not a narrator prompt preview and must not expose hidden mechanics in a fiction preview, private reasoning or system prompts. Existing context estimation remains separately labeled as an estimate.

## Save state, closing and failure handling

| Context/state | Visible status | Primary action / outcome |
|---|---|---|
| New or changed world character | Changes not applied to world draft | Apply/Add to world draft; return to roster |
| Character applied, parent world dirty | Applied to draft — save world to keep changes | Existing parent Save world; no false “saved” toast |
| Existing campaign character unchanged | No unsaved changes | Save disabled |
| Changed campaign character | Unsaved campaign changes | Save character/profile through the existing API |
| Saving | Saving… | Disable duplicate commits; retain draft |
| Failed request | Save failed; your changes are kept | Retry or review conflict; no navigation |
| Conflict | Character/world changed; compare latest | Existing compare, reapply and discard-latest behavior |
| Generation/capability lock | Existing contextual reason | Follow existing lock rule; keep draft and recovery action |
| Archived world | Read-only world | No authoring writes |

Never infer a saved state from a dialog closing. Parent-world save state comes from the existing world save result and revision, not merely the character callback. A parent save conflict leaves the whole edited roster available for the current recovery workflow.

Cancel, header Back, Escape, section-independent navigation and attempted campaign/world switches share one leave guard. If dirty, offer Keep editing, Apply/Save and leave, or Discard. “Apply and leave” for a world character still leaves the parent world unsaved. An invalid or failed commit cannot leave. Do not nest duplicate confirmation prompts. Browser Back/Forward must not silently move the selected owner under an open draft; intercept through the existing navigation guards or request dismissal before navigation. Add a beforeunload warning for unsaved world/character editing; it is a warning, not refresh recovery.

Existing browser-close limitations remain: this phase does not promise recovery after reload or crash. No autosave to authoritative records is introduced.

## Roster and mechanics usability

World roster search matches name, alias and role. Use filters All, Playable, Supporting and Both; filters match the stored use exactly. “Both” is separately visible, not silently excluded from selection rules elsewhere. Preserve authored order; no automatic reordering. Reordering is available only in the unfiltered All view, with an explanation when disabled. Duplicate creates an independent ID through the current path. At the 1,000-character contract limit, keep existing validation and block another addition without losing the draft.

Each row shows name, use, role and a structured summary of at most 160 Unicode code points, followed by an ellipsis when truncated. Summary preference: personality, background, then retained legacy guidance; omit the empty-description message when structured details exist. Truncate display only, with no mutation of stored content. Use consistent Edit, Duplicate, Move up and Move down controls. Supporting name-only rows are valid and say optional details can be added. Search has distinct no-characters and no-matches states and a Clear filters action.

Statistics retain compact name/value controls. Notes and tracker rules use expanding textareas; tracker starting values support multiline text without increasing existing limits. Each row removal names its subject, e.g. “Remove Resolve statistic.” Offer one local Undo for the most recent removal until the next removal, successful commit or editor close; restore the exact row/extension data and its position. Adding another row must not accidentally resurrect removed data. Removals and multiline edits participate in dirty state.

Supporting hides mechanics while retaining both stored and unsaved edited values. No-change round trips preserve original extension fields and hidden mechanics exactly. The recent conformance regressions remain required.

## Capability preservation checklist

| Capability / safeguard | Required preservation |
|---|---|
| Full world/main/preset profiles | All existing fields, limits, source text, unknown extensions and IDs survive quick/detailed transitions and saves |
| Manual/discovered cast | Existing field set, aliases, overrides, pin/ignore and duplicate-name behavior remain available |
| Generate | Current provider selection, validation, replace confirmation, error retention and manual fallback; no automatic invocation |
| Organize | Exact evidence/review controls, selected-field application and protocol provenance through conflict/reapply |
| Suggest/Convert | Existing independent expansion/retry/stop, collision handling, conversion links and local draft boundaries |
| Draft from story | Eligibility, blank-only proposals, citations, creative-guidance labels and save-time evidence fences |
| Field authority | Fixed versus updating values, authored/observed appearance, reset identity pair, restore goals and clear semantics unchanged |
| Campaign concurrency | Revision, boundary, idempotency, stale-response fencing and appropriate generation locks unchanged |
| Lifecycle | Existing preview/confirmation and gates; protagonist prohibitions; remove/restore/merge/undo/promote remain on the sheet/action menu |
| Persistence/isolation | World edits never alter a campaign; campaign edits never mutate a world; no silent seed/reapply/migration |
| Compatibility | Story callers default to existing panel presentation; Web-Next readers/writers and both builds remain compatible |

Use AI controls in their relevant section/action area, with clear discoverability; do not remove them for simplicity. Lifecycle actions stay on the character sheet or More actions with their existing review screens. Opening review preserves the editing session; actions that would invalidate its identity/seed require Apply/Save or explicit discard first.

## Accessibility and content ranges

Use native buttons, inputs, labels and dialog semantics. Section navigation is navigation, not a tab ARIA pattern unless its complete keyboard behavior is implemented. Minimum interactive target is 44×44 CSS pixels. Announce save/validation state through an existing or single appropriate live region; avoid duplicate announcements on every keystroke. Help essential to making a decision must be visible or keyboard/touch-accessible, not title-only.

Exercise empty/name-only characters, a populated profile, maximum legal field lengths, 20 aliases, a 1,000-character roster, hidden mechanics with extension keys, multiline tracker text, duplicate names, CJK/emoji/RTL text and long unbroken content. No horizontal page overflow at 390px or a 320px/200%-zoom smoke check. Preserve safe DOM rendering for all profile, source and preview text.

## Acceptance criteria and traceability

| ID | Observable acceptance | Plan task |
|---|---|---|
| U1 | Quick-create shows only context-appropriate core controls; existing characters open detailed | 2, 3, 4 |
| U2 | Continue changes no authority and preserves all fields, extensions, mechanics and AI provenance | 1, 3 |
| U3 | Full-screen editor has persistent identity/destination/actions, section navigation and local preview | 2 |
| U4 | Mobile/zoom/keyboard flows reach every field and finish without overlap or lost focus | 2, 6 |
| U5 | World Apply and parent Save expose separate truthful states, including parent failure/conflict | 3 |
| U6 | All exit paths preserve a dirty draft unless the author commits or discards it | 2, 3, 4 |
| U7 | Campaign locks, conflicts, idempotency and evidence fences still use existing contracts | 4, 6 |
| U8 | Generate/Organize/Suggest/Convert keep their review and no-write-before-commit semantics | 3, 6 |
| U9 | Reset/clear/restore and authored/observed differences remain correct and accessible | 4 |
| U10 | Roster summary/search/filter/reorder/duplicate work without mutating hidden rows | 5 |
| U11 | Mechanics edits, removal Undo and use switches preserve exact intended data | 1, 5 |
| U12 | Story/Web-Next remain compatible; no prompt, schema or provider behavior change | 4, 6 |
| U13 | Lifecycle actions remain gated and cannot invalidate a dirty editor without a decision | 4, 6 |
| U14 | Large/untrusted content remains bounded in display and safely rendered without storage loss | 2, 5, 6 |
| U15 | Existing conformance fixes and real persistence/isolation tests remain green | 6 |

## Delivery and decision record

Ship as one Nexus usability release after the adapters and compatibility tests pass, using the implementation plan's independently testable steps. This is a presentation refinement of ADR 0042, not a replacement authority model; no new ADR or glossary term is required. If implementation requires API/schema/prompt changes or persistent browser drafts, stop that expansion and revise the design first.

No new flag is needed for the final UI. During development the workspace is opt-in at mount sites until both world and campaign adapters pass; remove the temporary wiring branch before release. Keep Story's intentional panel presentation. Rollback uses the previous compatible UI/runtime and requires no new data downgrade: this phase must not introduce a format boundary.

Design defaults chosen for review: full-screen native-dialog workspace rather than a new route; full mobile editing rather than mobile read-only; Nexus-only presentation rollout; no refresh recovery. These are explicit implementation constraints, not hidden prerequisites for the builder to decide.
