---
version: 1
slug: "src-world-editor-page-ts"
primary_target: "src/world-editor-page.ts"
related_targets: ["src/styles.css","src/world-editor-state.ts","src/world-editor-fields.ts"]
---

## Scope and mode
World Editor at `src/world-editor-page.ts`. Mode: Operate. This surface is draft-only: it edits the current mutable world draft and never changes immutable published versions or existing campaigns.

## Audience and job
World authors review and shape one reusable world, make local changes across five sections, understand draft health, and explicitly activate Save draft when the work is ready.

## Content and task
The command row preserves the World Library return path and world identity, with immutable version and campaign context in a separated far-right reference rail. A Section Index selects Overview, Characters, Canon, Mechanics, or Assets. Collection sections use one searchable master list and one persistent detail editor. The selected Bottom Drawer direction is the Draft Ledger: a sticky state, revision, readiness, and warning summary with Save draft at the far right, expanding in document flow into section details.

## Direction
Extend the Constructed Atlas Grid into an operational authoring surface. Square rules, semantic paper surfaces, restrained literary headings, and compact technical labels expose how the workspace is constructed. Accent fill is reserved for the Save action, active section or collection state, and concise recovery actions. There are no ambient card shadows, nested cards, modals, section numbers, or theme literals outside shared palette blocks. User artwork remains the richest material; the editor uses the theme-invariant `--artwork-overlay` and never selects theme-specific image treatment.

## States
Loading keeps the command row and disabled draft fields visible with an announced busy state and retryable failure recovery. Empty collections preserve the toolbar and detail area with a direct add prompt. Validation marks the exact control with `aria-invalid`, a semantic error border and adjacent recovery copy, and returns focus to the affected field. Save conflict is an in-page recovery region that preserves local content and offers copy, download, or confirmed authoritative reload. Archived and no-draft states are visibly read-only. Saving, saved, unsaved, cover failure, and independent cover retry remain announced without allowing optional artwork work to block draft persistence.

## Responsive behavior
Desktop uses a left Section Index, a broad editor canvas with readable prose measure, and a full-width Draft Ledger that stays visible at the viewport edge. At `720px` and below, immutable context moves below the title, the index becomes a horizontal section switcher, master and detail cells stack, and the expanded ledger becomes a one-column full-width sheet. Save draft stays in the ledger's far-right bottom cell. Every control retains at least a 44px target, long textareas can grow vertically, and horizontal overflow is confined to the labelled section switcher.

## Accessibility and motion
Use visible `:focus-visible` treatment for section, drawer, collection, disclosure, and field controls. Preserve explicit labels, live status announcements, `aria-current`, `aria-pressed`, `aria-expanded`, `aria-controls`, `aria-busy`, read-only state, and programmatic validation recovery. Reduced motion removes Draft Ledger and other transitions rather than substituting a different reveal.
