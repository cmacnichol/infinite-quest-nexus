---
target: Nexus character editor UI and functionality
total_score: 25
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 1
timestamp: 2026-11-14T21-02-32Z
slug: apps-web-src-character-editor-renderer-ts
---
# Nexus character editor capability and improvement review

The Nexus editor has a strong functional foundation. The highest-value next step is to improve navigation, save-state clarity and review of existing characters before expanding the schema. Its storytelling model is specific to Infinite Quest, but the long modal still feels like an administrative form rather than a focused authoring workspace.

Method: independent design assessment A (`editor_design_critique`) and detector/evidence assessment B (`editor_evidence_critique`). Scope is the current local Nexus implementation, including the three recently verified fixes. This is advisory work, not a product change or production audit.

## Current capability

- World authors can create, edit, duplicate and reorder characters; select Playable, Supporting or Both; and configure starting-cast defaults and context preference.
- Structured profiles cover identity, story role, personality, motivations, goals, history, relationships as prose, voice, detailed appearance and retained source notes. RPG statistics and starting trackers remain separate from fiction.
- AI tools include reviewed character generation, organizing source notes into fields, cast suggestions and expansion. Entity conversion supplies a manual migration path.
- Campaign characters support campaign-only edits, source history, appropriate field provenance, reset and release of overrides. World-seeded NPCs have richer profile editing; manual/discovered supporting characters retain a smaller field set.
- Campaign workflows include evidence-backed Draft from story, Add/Apply world profile and gated merge, undo, remove, restore and promotion to a world draft. Availability depends on capabilities and character origin.
- Unsaved-change guards, revision-conflict comparison/reapplication, generation locks and validation focus already exist. These should be retained, not reinvented.

## Design assessment

Scores are provisional heuristic judgments from source and current screenshots, not measured usability or accessibility certification. Four is best.

| Heuristic | Score | Main opportunity |
|---|---:|---|
| System status | 3 | Persistent draft and destination state |
| Familiar language | 3 | Explain context preference and two-stage world saving |
| Control and freedom | 3 | Keep finishing actions visible on mobile |
| Consistency | 2 | Roster action styling and origin-dependent editing |
| Error prevention | 3 | Safer row removal and clearer save destination |
| Recognition over recall | 2 | Summaries for collapsed populated sections |
| Efficiency | 2 | Section navigation and roster search/filter |
| Visual simplicity | 2 | Reduce nested borders and repeated explanatory copy |
| Error recovery | 3 | Preserve existing strong conflict/reapply behavior |
| Help | 2 | Make key explanations discoverable without hover |
| **Total** | **25/40** | **Usable foundation; meaningful friction remains** |

The detector found zero issues in the renderer. Manual visual inspection still found mobile action visibility and roster consistency problems. A clean deterministic scan does not contradict those findings.

## Recommended UI priorities

1. **P1 — Make long mobile edits easy to finish.** Desktop has a sticky action footer; mobile explicitly makes it static. Keep Apply/Cancel available with safe-area and virtual-keyboard handling. Retain character name and editing destination in a compact header. Keep deletion secondary. Add section shortcuts for long profiles; avoid forcing a wizard on experienced authors.
2. **P2 — Show saving state continuously.** World editing has two valid steps: apply to the local world draft, then save the world. Show “Unsaved character changes” in the editor and “Applied to draft; world not saved” at the parent level. Display the destination world or campaign. Extend recovery with a recoverable draft checkpoint without silently publishing or changing authoritative campaign state.
3. **P2 — Make roster cards useful and consistent.** A character with a structured role currently shows both “Story details added” and “No character description” because the latter reads only legacy guidance. Show a short structured profile summary or omit the empty legacy message. Style Duplicate/Move consistently and provide an explicit Edit affordance. Add world-roster search and use filters as roster size grows; campaign search already exists.
4. **P2 — Expose existing content without opening every section.** Advanced sections close whenever the form is populated. Show summaries such as “Appearance · 6 details” and “Mechanics · 2 statistics, 3 trackers,” preserve section state during editing, and provide a compact sheet preview. Use readiness guidance rather than a completion percentage that encourages unnecessary fields.
5. **P2 — Use controls suited to long mechanics text.** Notes, tracker values and update rules can be long, yet currently use single-line inputs. Use expanding textareas for prose, concise controls for names/numbers, and row-specific removal labels with undo. The existing × buttons do have accessible names; the issue is discoverability and repeated generic labels, not missing labels.

## Functionality improvements

| Priority | Improvement | Scope and safeguards |
|---|---|---|
| Next | Full profile editing for manual/discovered campaign characters | Extend the smaller supporting profile without requiring a world preset. Retain origin, authored/observed distinctions, evidence and campaign isolation. This expands the approved scope rather than repairs an existing requirement. |
| Next | Field-scoped creative AI assistance | Offer “Generate selected fields,” “Fill blanks” and “Rewrite selection” with before/after review and explicit keep choices. Keep this separate from evidence-only Organize and Draft from story. Never silently replace authored fields. |
| Next | Reusable character templates | Start from a reusable authoring template or copy selected fields. Existing Duplicate already copies a whole roster entry; templates should solve repeated structure rather than duplicate that feature. |
| Later | Appearance reference workflow | Associate a reference image and preview fiction-only visual description, then evaluate NPC illustration consistency as the separately planned image-pipeline feature. Preserve separate image-provider configuration. |
| Later | Structured relationships | Replace free-text-only relationship navigation with explicit, reviewable links if users need it. Campaign facts, uncertain claims and reusable world relationships must remain distinct. This requires its own domain design. |

Prefer a safe read-only profile preview before a raw prompt inspector. Existing context estimation already addresses likely inclusion; any editor preview must distinguish profile contents from the final budgeted model request.

## Strengths and user risks

Preserve the shared field model, progressive disclosure, manual paths without a provider, mechanics/fiction separation, provenance badges and conflict recovery. The dark palette and strong primary-action color are coherent; improvement does not require a visual rebrand.

First-time authors are most likely to be confused by the two saving steps and contradictory-seeming roster summary. Power users lose time reopening sections and scrolling. Mobile authors lose visual access to finishing actions during deep edits. Keyboard and screen-reader users benefit from native labels and details controls, but hover-only help and repeated removal labels deserve targeted testing.

The creative journey starts well with a small set of story essentials. The difficult middle is the long form; the end should clearly confirm where the edits now live and whether another save remains.

## Suggested sequence and decisions

First improve mobile actions, draft state, section summaries and roster presentation. Then add full-profile parity and selective AI assistance. Keep illustration integration and structured relationships as separate designs.

Two decisions would guide a next implementation brief:

1. Editing surface: retain the modal, use a dedicated workspace, or use a small creation modal plus a dedicated detailed editor. Recommended: the hybrid if detailed authoring is a frequent task.
2. Next investment: usability first, selective AI first, or full-profile parity first. Recommended: usability first, then parity and selective AI.
