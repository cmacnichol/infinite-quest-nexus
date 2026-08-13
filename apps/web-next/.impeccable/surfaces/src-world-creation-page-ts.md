---
version: 1
slug: "src-world-creation-page-ts"
primary_target: "src/world-creation-page.ts"
related_targets: ["src/styles.css","src/world-creation-model.ts","src/world-creation-api.ts"]
---

## Scope and mode
World Creation at `src/world-creation-page.ts`. Mode: Operate. This is a dedicated Atlas Workspace for assembling one reusable world as local state. It does not create a world, publish a version, create a campaign, or start cover work until the author reaches Review and explicitly activates **Create world**.

## Audience and job
World authors choose a manual or AI-assisted starting method, shape the same canonical world draft through seven stages, optionally assemble a reviewed playable-character roster, resolve exact validation issues, review provenance and readiness, and intentionally cross the authoritative creation boundary.

## Content and task
The Creation Stage Index orders Method, Foundation, Canon, Mechanics, Cover, Characters, and Review. Manual begins with an empty schema-version-5 draft. AI-assisted authoring uses one synchronized concept value in the compact field and Expanded Prompt Dialog, then generates an editable local preview. Both paths converge on the same Foundation, Canon, Mechanics, Cover, optional reviewed Characters roster, validation, Review, and submission workflow. World generation never injects playable characters; only accepted Character Workspace results can append or replace candidates in the local roster.

The prompt toolbar contains only Copy, Paste, and Expand with authored SVG icons. The bottom Creation Progress Ledger keeps stage position with Back and the current Continue or Create action. Review presents provenance, stage readiness, warnings, cover intent, and exact recovery links before submission.

## Direction
Extend the Constructed Atlas Grid as a flat, square operational workspace. The desktop stage rail and broad canvas are divided by visible one-pixel rules. Method choice remains two compact 48px controls rather than cards. Prompt authoring is one bounded writing cell, not nested panels. Accent is reserved for checked/current state, focus, progress, and the decisive action. There are no ambient shadows, rounded sheets, character affordances, extra prompt tools, or page-specific theme literals.

## States
Manual empty and AI ready preserve the selected method and authored concept. Provider unavailable, generating, generation progress, cancellation, retry, malformed output, and replacement confirmation never mutate authoritative records and never discard existing local work. The optional Characters stage covers empty, add, edit, remove, undo, roster limit, accepted, cancelled, expired, mismatched, malformed, and rejected handoffs. Navigation stores only the opaque handoff key and workflow identity as the parent return pointer; a fresh mount validates the live session, restores its sanitized parent draft, applies at most one result, and clears terminal pointers. Copy announces success or failure without moving focus. Paste denial or unavailable clipboard access leaves content intact and exposes adjacent recovery copy.

Stage validation marks and focuses the exact field or collection with visible associated guidance. Review exposes complete validation and prevents duplicate submission. Creation failure preserves all local fields. Optional image-provider unavailability and cover failure never block or roll back world creation; cover retry remains independent and cannot repeat the world POST. Loading, busy, disabled, error, warning, completed, current, and upcoming states remain understandable without color alone.

## Authoritative boundary
**Create world** on Review is the only action that sends authoritative world content. Generation cannot call create, draft-update, publish, campaign, or cover endpoints. Submission strips prohibited identity keys, sends no caller-provided owner identity, canonicalizes schema version 5, and sends exactly the locally reviewed `playableCharacters` roster. Retained-cover attachment or generated-cover work starts only after successful world creation.

## Responsive behavior
Desktop uses a persistent left Creation Stage Index, broad editing canvas, and bottom progress/action ledger. At `720px` and below, the stage index becomes a horizontally scrollable 52px switcher, fields stack as complete cells, the prompt heading and toolbar recompose vertically, and the Expanded Prompt Dialog becomes full width and bottom aligned. The ledger places progress across the first row and Back plus Continue/Create in two equal action cells. It remains in document flow while sticky so focused controls and validation targets are not covered. All controls retain at least 44px targets.

## Accessibility and motion
The method selector is one labelled radio group. Stage controls expose current, completed, and unavailable state through semantics, visible structure, and completion text rather than color alone. Progress uses status and progress semantics with live announcements. Copy, Paste, Expand, Close, Back, Continue, and Create retain accessible names and visible `:focus-visible` treatment. The dialog traps focus, closes with Escape or Return to wizard, synchronizes the concept, and restores focus to Expand. Under `prefers-reduced-motion: reduce`, dialog, stage, progress, and ledger animations and transitions are removed.
