---
version: 1
slug: "src-character-workspace-page-ts"
primary_target: "src/character-workspace-page.ts"
related_targets: ["src/styles.css","src/character-workspace-model.ts","src/character-workspace-session.ts","src/world-editor-character-workspace.ts"]
---

## Scope and mode
Character Workspace at `src/character-workspace-page.ts`. Mode: Operate. This dedicated surface authors one reviewed local playable-character candidate for New World or World Editor; it never persists authoritative world or character data.

## Audience and job
World authors choose Manual or AI-assisted creation, shape one character through six revisitable stages, inspect exact readiness and provenance, and return an accepted candidate to the originating unsaved world draft.

## Content and task
A compact stage index orders Method, Identity, Story, Appearance, Mechanics, and Review. Manual and AI-assisted are two 48px radio controls. AI uses one synchronized concept with Copy, Paste, Expand, explicit generation, bounded progress, cancellation, and recovery. Long narrative and appearance fields remain editable; Mechanics uses bounded master-detail stats and tracker editors. Review reports factual field and collection counts, world context, warnings, and the local-only boundary. The sticky Character Progress Ledger keeps concise stage status beside compact Back and Continue actions; Review ends with Add to world draft or Update world draft.

## Direction
Extend the Constructed Atlas Grid as a focused operational writing surface. Use square semantic paper cells, visible one-pixel rules, restrained Literata headings, Geologica prose, and Chakra Petch actions. Accent identifies current stage, focus, generation state, and the final local handoff without becoming a passive fill. Do not add portraits, fantasy-manuscript decoration, ambient shadows, nested cards, oversized actions, or a persistence-shaped Save control.

## States and local handoff boundary
Cover empty, partial, complete, generating, cancelled, provider unavailable, malformed generation, replacement confirmation, validation failure, duplicate identity, and accepted review. Expired or missing sessions show Character session unavailable, state that no world data changed, and offer the validated same-origin return path. Parent Add/Edit sessions contain a sanitized clone of the current unsaved world draft behind one opaque key. Acceptance updates only the parent local aggregate; World Editor still requires Save draft and New World still requires Create world. Cancellation, expiry, disposal, wrong origin or workflow, malformed result, rejected application, and duplicate consumption change nothing. Malformed stored results use inspect/reset recovery and fail closed when invalid-result removal cannot be verified.

## Responsive behavior
Desktop uses a left six-stage rail, broad readable authoring canvas, and full-width bottom ledger. At `720px` and below, the rail becomes one horizontally scrollable switcher of complete 52px cells, fields and Mechanics master-detail editors stack as complete cells, and the ledger places status above two equal compact action cells. The expanded prompt dialog is full-width and bottom-aligned. Long names, narrative fields, appearance details, and mechanics rows wrap or scroll within their owned region without horizontal page overflow; every control retains at least a 44px target.

## Accessibility and motion
Use a labelled Method radio group, semantic current/completed/unavailable stage states, explicit labels, `aria-invalid`, adjacent recovery copy, linked Review errors, exact focus restoration, live generation and clipboard announcements, and a focus-trapped expanded prompt dialog that closes on Escape and restores focus to Expand. Keyboard focus remains visible in both themes and is never covered by the sticky ledger. Under `prefers-reduced-motion: reduce`, remove dialog, stage, progress, ledger, and generation transitions rather than substituting another reveal.
