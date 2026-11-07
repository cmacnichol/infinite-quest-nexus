---
target: Complete character creation and editing GUI
total_score: 21
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 2
timestamp: 2026-11-06T23-54-33Z
slug: apps-web-src-campaign-cast-panel-ts
---
# Character creation and editing GUI review

Date: November 6, 2026. Method: two independent assessments, character_usability (design and live read-only inspection) and character_controls (control/data-flow audit). No implementation or campaign changes in this review.

Scope: World Library character creation/editing, AI generation and organization, campaign protagonist profiles, supporting-character creation/editing and match review, and the replacement character workspace. Live inspection used localhost:8080; replacement-workspace findings are source-verified, not a claim of live reproduction. No save, generation, deletion, or attachment was submitted. No usage analytics were available: “unused” means inert, redundant, or inapplicable in a specific state, not unused by users.

## Overall judgment

The dark visual system fits the product. Fiction/mechanics separation, explicit draft-application wording, and evidence-based match previews work well. The largest opportunity is to make authoring match the user's task instead of exposing the entire data model at once. Functional inconsistencies deserve priority over visual polish.

## Findings

1. **P1 — Required Narrative guidance may not affect the story.** The replacement workspace requires characterText, but character-fiction authority excludes that legacy text when a structured profile exists. A person can supply their intended characterization in a required field that is not used as authoritative narrative context. Make the field explicitly source-only, or explicitly map reviewed content into the structured profile; do not silently combine the two. Sources: apps/web-next/src/character-workspace-page.ts:417; character-workspace-model.ts:262; packages/domain/src/character-fiction-authority.ts:81; packages/domain/src/world-characters.ts:232.

2. **P1 — Compare latest does nothing for a new-character conflict.** In the replacement supporting-character editor, the recovery button is displayed but returns immediately without a character ID. Port the existing legacy new-draft recovery behavior so users can refresh roster authority and reapply without losing their draft. Sources: apps/web-next/src/characters-workspace.ts:162–173; apps/web/src/campaign-cast-panel.ts:430–432.

3. **P2 — Paste can leave Generate disabled.** The replacement workspace's Paste button changes concept text without updating Generate availability; typing follows a different path that does update it. Use one prompt-state update path for typing and pasting. Sources: apps/web-next/src/character-workspace-page.ts:569–578 and 772–782.

4. **P2 — Mechanics can be added but not removed in the replacement workspace.** Add a remove action for the selected statistic/tracker, preserving a safe way to undo accidental additions and discard unwanted generated entries. Legacy mechanics already have removal. Source: apps/web-next/src/character-workspace-page.ts:437–469, 837–839.

5. **P2 — Validation requirements are hidden.** The legacy modal needs a name and at least one story field or legacy source text, but only Name visibly indicates its requirement. Errors can leave focus at the bottom. Explain the minimum and focus/link the relevant section. AI organization also calls full save validation, so notes-only source material cannot be organized until another story field exists. Give organization its own input validation. Sources: apps/web/src/nexus.js:3346–3352, 4336–4350, 4435–4444.

6. **P2 — AI creation is placed under Imported and legacy guidance.** Its source-defined position is below ten story textareas and nested inside a migration-oriented section. It disappears entirely without a configured provider. Offer Manual / Generate with AI at the start and show useful setup guidance when generation is unavailable. Live inspection confirmed the form hierarchy and empty imported area; generation itself was not invoked. Sources: apps/web/public/index.html:1189–1205; apps/web/src/nexus.js:3101–3108.

7. **P2 — Review shows counts rather than the character being approved.** The replacement review page lists alias/story/appearance counts and technical ID. Show the actual readable profile and section-level Edit links. Source: apps/web-next/src/character-workspace-page.ts:479–489.

8. **P2 — Empty Mechanics disclosure in campaign-profile mode.** Only its contents are hidden, leaving an expandable heading with nothing useful inside. Hide the entire disclosure or link to the appropriate mechanics editor. Sources: apps/web/public/index.html:1174; apps/web/src/nexus.js:4416.

9. **P2 — Reset controls appear where there is nothing useful to reset.** Every existing supporting-character field offers Use discovered value, even without an override. The replacement editor clears its display without explaining that reset is pending until save. Show reset for actual overrides, explain pending changes, and preview the discovered value where available. Sources: apps/web/src/campaign-cast-panel.ts:406–410; apps/web-next/src/characters-workspace.ts:154–156; packages/client-core/src/campaign-cast-editor.ts:25–31.

10. **P2 — Optional detail overwhelms initial creation.** The legacy modal puts ten equally prominent story textareas before optional tools; distinctions rely heavily on hover hints. Start with Name, Role, Background, and Personality; group remaining detail under meaningful optional sections, with visible short explanations. For a new supporting character, open Story profile rather than Appearance by default. Sources: apps/web/public/index.html:1139–1151; apps/web/src/campaign-cast-panel.ts:399–401.

11. **P3 — Technical and ineffective controls add noise.** Move the replacement workspace's read-only Character ID out of primary authoring. Omit or disable Back on the first stage. Hide empty imported-source material for newly authored characters. Sources: apps/web-next/src/character-workspace-page.ts:344–355, 400–402, 830; apps/web/public/index.html:1189–1197.

## Controls to retain

- Pin changes context priority; Ignore excludes supporting characters from retrieval. Explain these effects instead of removing them.
- Search, existing-character selection, and the match preview perform different tasks: find, choose, verify.
- Appearance, stats, trackers, aliases, and profile fields are connected to retained data. Their optional nature does not make them dead controls.
- Imported guidance is intentionally read-only source material. Hide it when empty; retain it for imported characters.
- AI organization and character generation are different operations. Organization proposes supported field assignments; generation creates an editable character preview.
- Apply to world draft and Save world are separate persistence steps. Retain that distinction and reinforce unsaved status.

## Indicative heuristic assessment

Subjective design score, not an accessibility certification: 21/40. Status visibility 3; familiar language 2; control/freedom 2; consistency 2; error prevention 2; recognition 2; efficiency 2; minimalism 2; error recovery 2; help 2. Source-confirmed functional gaps lower control, prevention, and recovery relative to the independent visual review.

First-time authors risk missing AI creation and misunderstanding required fields. Experienced authors face excessive fields and repeated reset buttons. Keyboard/touch users need visible help and focused errors rather than hover-only guidance. Screen-reader conformance was not tested.

## Evidence and limits

Read-only desktop screenshots: a-character-desktop.png and a-character-generator.png in the same output directory. No complete mobile or screen-reader audit was run for this review; the earlier bugfix's browser tests are separate evidence.

The automated detector ran on five targets in degraded regex mode because parser modules were unavailable. Its single warning was a hidden dynamic world-cover image without an initial src, outside the character controls; this is not an actionable character-UI finding. Computed contrast and selector matching were not verified. No user-visible detector overlay was injected. The review browser was closed and no new review server was started.

Recommended order: repair narrative-field semantics and new-draft recovery; repair Paste and mechanics removal; fix validation/organization; simplify entry points and contextual controls; improve final review and responsive/accessibility presentation.

Decision for follow-up: repair functional defects first, simplify the interface first, or do both in that order?
