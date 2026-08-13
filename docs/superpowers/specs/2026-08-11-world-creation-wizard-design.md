# World Creation Wizard Design

## Purpose

Add a production-ready New World Creation Wizard to the replacement web application. Authors can build a complete non-character world manually or ask the configured text provider to fill an editable local preview. No world record is created before final review and explicit confirmation.

## Entry and route

- Add a visible **Create world** action to the World Library.
- Route the action to `/app/worlds/new`.
- Keep `/app/worlds/:worldId` reserved for the existing World Editor.
- Retain the shared application header, theme control, and primary navigation.

## Selected structure

Use the approved **Atlas Workspace** in Operate mode:

- a dedicated full-page workflow;
- a persistent vertical stage index on desktop;
- a broad editing canvas;
- a horizontal stage switcher on compact screens;
- a bottom progress/action ledger;
- compact 48px Manual and AI-assisted method controls.

Stages are Method, Foundation, Canon, Mechanics, Cover, and Review. Both methods converge on the same local draft, validation, navigation, and final submission.

## Manual path

Manual creation begins with an empty canonical schema-version-5 draft and guides authors through:

- Foundation: title, genre, tone, premise, background story, first action, and rules;
- Canon: entities and relationships;
- Mechanics: world RPG stats, default triggers, event triggers, and defaults;
- Cover: no cover, retained asset id, or optional generated-cover prompt;
- Review: complete validation and creation summary.

The wizard always submits `playableCharacters: []`. Character creation and character generation are excluded.

## AI-assisted path

The AI-assisted Method stage provides one synchronized concept value in a compact textarea and an optional expanded dialog.

The prompt toolbar includes accessible Copy, Paste, and Expand controls using authored SVG icons. Copy announces success or failure without moving focus. Paste requests clipboard access and inserts at the current selection; denied or unavailable access produces adjacent recovery copy. Expand opens a labelled focus-trapped dialog using the same value, closes with Escape or Return to wizard, and restores focus to Expand.

**Generate editable preview** calls `POST /api/v1/worlds/generate-preview` with `{ title, prompt, progressKey }`. Progress is read from `/api/v1/worlds/generate-progress?key=...` while active. The response must be validated before use. The browser canonicalizes it to schema version 5, discards every generated playable character, and keeps all non-character world, canon, mechanics, trigger, default, and asset data as local editable state.

Generation never calls create, draft-update, publish, campaign, or cover endpoints. Failure, cancellation, provider unavailability, malformed output, or retry preserves the concept and existing local fields. When replacing non-empty local fields with a new generated preview, the user must confirm the replacement.

## Local workflow and validation

- Back and Continue preserve local state.
- Authors may revisit completed stages.
- Stage navigation validates only the requirements needed to leave that stage; final Review validates the complete submission.
- Pending collection removals remain undoable until creation.
- Any authored or generated local state installs an unsaved-navigation warning.
- Validation identifies and focuses the exact field or collection with visible associated recovery copy.
- The Review stage reports manual/AI provenance, readiness by stage, warning count, and cover intent.
- Double submission is prevented.

## Authoritative creation and cover handling

**Create world** is the only action that sends authoritative world content. It calls `POST /api/v1/worlds` with title and owner-safe canonical content. The browser sends no owner or user identity and strips the same prohibited root identity keys as the World Editor.

After successful creation:

1. optional retained-cover attachment uses `PUT /api/v1/worlds/:worldId/cover-asset`, or
2. optional generated-cover work uses `POST /api/v1/worlds/:worldId/cover`.

Cover operations remain independent. Cover failure never rolls back the new world and never repeats world creation. The browser navigates to `/app/worlds/:worldId` with an accessible success or cover-recovery message.

## States and recovery

The surface includes loading, manual-empty, AI-ready, provider-unavailable, generating, progress, cancellation, retry, malformed response, clipboard denied, validation failure, unsaved navigation, creating, duplicate-submit prevention, creation failure with local-state preservation, successful creation, cover pending, and cover failure states.

No source file or HTML contains sample worlds. Demonstration content belongs only in tests and visual-review fixtures.

## Accessibility and responsive behavior

- All controls retain at least 44px targets.
- Method controls behave as one labelled radio group.
- Stage controls expose current and completed state without relying on color.
- Progress uses semantic status and progress elements with live announcements.
- The expanded prompt dialog traps focus, closes with Escape, and restores focus.
- Copy, Paste, and Expand have accessible names and consistent SVG icon treatment.
- Compact screens use a horizontal stage switcher, single-column fields, full-width prompt dialog, and a two-cell bottom action ledger.
- Reduced motion removes stage, progress, and dialog transitions.

## Boundaries

The wizard does not create or generate playable characters, publish a world version, create a campaign, autosave an authoritative draft, accept browser-provided identity, silently overwrite non-empty local work, or require image-provider availability for world creation.
