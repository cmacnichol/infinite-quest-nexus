# Character Creation Workspace Design

## Status

Approved interaction design for implementation planning.

## Job and Audience

World authors need to create one playable character at a time while assembling a new world or editing an existing mutable world draft. The workflow must support deliberate manual authoring and AI-assisted organization without allowing generated content to bypass review or mutate authoritative world data.

The surface operates as a dedicated Character Workspace. It is invoked from:

- the New World Wizard's character roster; and
- the World Editor's Characters section.

The workspace authors one local character candidate, lets the author inspect and edit every field, and returns the accepted candidate to the originating unsaved world draft.

## Outcome and Proof

Success means the author can:

1. choose Manual or AI-assisted creation;
2. complete or generate one character;
3. revise every generated or manually entered field;
4. resolve exact validation issues;
5. review provenance, readiness, warnings, and factual field counts; and
6. activate **Add to world draft** to append the reviewed character to the originating local world draft.

The World Editor continues to use its existing **Save draft** action as the only authoritative persistence boundary. In the New World Wizard, characters remain local until **Create world** submits the reviewed world and roster together.

## Selected Direction

### Dedicated Character Workspace

Use one reusable full-page workspace rather than an embedded editor or side sheet. Both parent surfaces open the same route and pass an opaque local session handoff identifying the origin and parent state. The workspace preserves the Constructed Atlas Grid and Operate mode:

- a persistent six-stage index on desktop;
- a broad authoring canvas;
- a dense sticky progress/action ledger;
- square semantic surfaces and visible construction rules; and
- a horizontal stage switcher on compact screens.

Controls must remain compact. Ordinary actions use the smallest practical layout while retaining at least a 44px target. Method choices remain two 48px controls. The ledger must not allocate oversized button cells or allow actions to dominate the authoring canvas.

## Stage Sequence

The workspace has six stages:

1. **Method**
2. **Identity**
3. **Story**
4. **Appearance**
5. **Mechanics**
6. **Review**

Completed stages are revisitable. Forward navigation validates the current stage, retains invalid pending input, and focuses the exact issue. Upcoming unavailable stages expose disabled semantics. There is no direct authoritative save action in this workspace.

### Method

The author selects Manual or AI-assisted in one labelled radio group.

Manual starts from a canonical empty playable character candidate. AI-assisted exposes one synchronized character-concept prompt in compact and expanded forms, with only Copy, Paste, and Expand prompt tools. Generation starts only through an explicit **Generate character** action.

The AI request receives:

- the authored character concept;
- a sanitized snapshot of the current unsaved world foundation;
- sanitized world canon, entities, and relationships;
- sanitized world mechanics and defaults; and
- existing playable-character summaries needed to avoid accidental duplicates.

The request must not contain caller-supplied ownership identity, credentials, provider secrets, or unrelated parent UI state. World and character content are untrusted reference data, never model instructions.

One generation request returns one complete candidate covering Identity, Story, Appearance, and Mechanics. It may not mutate the parent world, save a draft, publish a version, create a campaign, or attach assets.

### Identity

Identity includes:

- name;
- aliases;
- pronouns; and
- a stable character ID.

The workspace generates a collision-safe local ID for a new character. AI output cannot choose or replace that trusted ID. The author may edit character-facing identity fields but not introduce duplicate IDs within the parent roster.

### Story

Story includes:

- narrative guidance (`characterText`);
- role;
- background;
- personality;
- motivations;
- goals;
- fears and conflicts;
- key relationships;
- narrative hooks;
- voice and mannerisms;
- other guidance; and
- unclassified notes.

Long-form fields use readable measures and may grow vertically. Unknown passthrough properties survive structured edits unless prohibited by the security boundary.

### Appearance

Appearance includes:

- ancestry or species;
- apparent age;
- gender presentation;
- build;
- skin or complexion;
- face;
- eyes;
- hair;
- distinguishing features;
- clothing;
- equipment and accessories; and
- other visual details.

Distinguishing features use a bounded structured collection. No character illustration workflow is introduced by this feature.

### Mechanics

Mechanics includes bounded master-detail editors for:

- RPG statistics; and
- default triggers.

Editors reuse the World Editor's validated field adapters and preserve unknown properties. Collection limits must follow the shared playable-character contract rather than introducing looser browser-only bounds.

### Review

Review presents:

- Manual or AI-assisted provenance;
- readiness for every stage;
- total warning count;
- the character name and ID;
- factual completion and collection counts;
- a concise world-context summary identifying the target world draft;
- an explicit statement that the result remains unsaved world-draft content; and
- a complete linked error summary that returns to and focuses the exact stage and control.

The final action is **Add to world draft**. Duplicate activation is impossible. Invalid activation performs no handoff and focuses validation recovery.

## Parent Integration

### New World Wizard

Add a Characters stage or roster step before Review. Its empty state explains that playable characters are optional and offers **Add character**. Each accepted character is appended immutably to the wizard's local `playableCharacters` roster. The author may edit an existing local character by reopening the same Character Workspace and may remove a character with undo before world creation.

After returning from the Character Workspace, the roster offers **Add another**. Creating a world submits only characters explicitly reviewed and added to this local roster.

This feature supersedes the New World Wizard's earlier invariant that `playableCharacters` must always be empty. The replacement invariant is:

- generation of the world itself never generates or injects playable characters;
- only the Character Workspace may add a character to the wizard roster; and
- final world creation canonicalizes and submits exactly that reviewed local roster.

### World Editor

The Characters section retains its roster and existing structured editing behavior. **Add character** opens the Character Workspace. Acceptance appends the character to the editor's unsaved aggregate and marks the draft dirty. No character-specific API write occurs. The existing revision-checked **Save draft** action remains the only persistence boundary.

Editing a character from the roster may use the same workspace initialized with a local copy. **Update world draft** replaces only that character in local state and still requires **Save draft**.

### Local Session Handoff

Use an opaque, same-origin local session key rather than serializing parent draft content in a URL. The handoff record contains:

- origin (`world-creation` or `world-editor`);
- parent route and local workflow identity;
- sanitized world-context snapshot;
- current roster identifiers and summaries;
- optional character candidate for edit mode;
- an expiration timestamp; and
- a single-consumer return channel or result record.

The route contains only the opaque handoff key. The session is scoped to the current browser context, bounded in size, expires automatically, and is deleted after successful return or explicit cancellation. Sensitive credentials and authoritative ownership identity are never stored in it.

The parent must remain recoverable if browser history, reload, or BFCache lifecycle events occur. An unavailable or expired session shows **Character session unavailable**, explains that no world data was changed, and offers a safe return to the originating world surface. It must never construct a blank authoritative write from a missing handoff.

## State and Generation Integrity

Character generation is a preview-only workflow with unique progress keys and bounded polling. It supports generating, progress, cancellation, provider-unavailable recovery, malformed-output recovery, retry, and replacement confirmation.

Required safeguards:

- typing performs no network request;
- generation begins only on explicit action;
- changing method or leaving Method invalidates active generation;
- cancellation stops polling and aborts the preview request;
- terminal progress settles the UI even if the preview transport remains pending;
- late or stale results cannot overwrite newer edits;
- generation failure preserves the concept and all local character fields;
- replacing non-empty local work requires confirmation immediately before applying the result;
- generated output is strictly parsed and canonicalized at the browser boundary;
- generated IDs, identity-shaped owner fields, and prohibited root identity properties are discarded;
- duplicate roster IDs are rejected or regenerated locally; and
- disposal prevents stale messages, navigation, or parent handoff.

## Validation and Data Contract

The local candidate conforms to the shared `playableCharacterSchema` shape:

- `id`;
- `name`;
- `characterText`;
- structured `profile` with identity, story, appearance, and unclassified notes;
- `rpgStats`;
- `defaultTriggers`; and
- passthrough `source` and unknown properties where safe.

Minimum readiness requires a non-empty name and non-empty narrative guidance. Structured profile fields may remain empty when unknown; the UI must not fill them with placeholders or inferred facts. Collection rows validate their shared field contracts and bounds.

Outbound candidates strip root `user_id`, `userId`, `owner_user_id`, and `ownerUserId` while preserving unrelated unknown imported properties. No browser field or handoff value establishes authorization.

The shared generation-preview contract should evolve from the existing playable-character preview endpoint rather than adding an authoritative character-save endpoint. The browser provides sanitized world content and prompt; the server resolves user/provider scope and returns one strict candidate envelope with safe progress and error metadata.

## Interaction and Layout

Desktop uses a left stage index, broad editor canvas, and bottom Character Progress Ledger. The ledger contains concise stage position and validation status followed by compact **Back** and **Continue** actions; Review replaces Continue with **Add to world draft**.

At 720px and below:

- the stage index becomes a horizontally scrollable 52px switcher;
- fields stack as complete cells;
- master-detail mechanics editors stack without nested cards or modals;
- prompt tools remain compact and labelled accessibly;
- the expanded prompt dialog becomes full-width and bottom-aligned; and
- ledger status spans above two equal compact action cells.

The workspace uses semantic theme tokens only, supports both themes, and preserves the existing flat square visual language. There are no ambient shadows, rounded cards, character portraits, decorative fantasy manuscript styling, or oversized calls to action.

## Accessibility and Motion

- Method is a labelled radio group.
- Stage controls expose current, completed, and unavailable state semantically and visibly.
- All controls retain at least 44px targets and visible `:focus-visible` treatment.
- Validation uses `aria-invalid`, associated recovery copy, linked summaries, and exact focus restoration.
- Generation progress uses status/progress semantics and live announcements.
- Clipboard completion does not move focus; paste preserves selection and content on failure.
- The expanded prompt dialog traps focus, closes with Escape, and restores focus to Expand.
- Dirty navigation warnings apply when local character work would be lost.
- Reduced motion removes dialog, stage, progress, and ledger transitions.

## States and Ranges

The implementation must cover:

- new Manual character;
- new AI-assisted character;
- editing an existing local character;
- empty, partial, and complete candidates;
- provider unavailable;
- generating and bounded progress;
- cancellation;
- malformed or rejected generation;
- replacement confirmation;
- validation failure;
- duplicate ID or duplicate name warning;
- successful parent handoff;
- expired or missing handoff;
- parent disposal and BFCache restoration;
- roster sizes from zero through the shared world maximum; and
- long content up to shared schema limits without horizontal page overflow.

## Testing Requirements

Tests must prove:

- both parent entry points open the same Character Workspace contract;
- generation receives sanitized current local world context;
- no generation action performs an authoritative write;
- every generated field remains editable before acceptance;
- stale, failed, cancelled, or disposed generation cannot alter local or parent state;
- exact validation focus works from fields, stages, and Review links;
- Add to world draft is duplicate-proof;
- New World receives the reviewed roster and no generated-by-world characters;
- World Editor acceptance changes only the unsaved aggregate and still requires Save draft;
- cancel and expired sessions leave the parent unchanged;
- identity spoofing and owner-shaped fields are stripped;
- unknown safe properties survive structured edits and handoff;
- responsive stage, action, focus, dialog, and reduced-motion contracts hold; and
- one parent's character session cannot be consumed by another parent workflow.

## Scope Boundaries and Anti-goals

In scope:

- one-character Manual and AI-assisted creation;
- editing before adding to the world draft;
- reusable invocation from New World and World Editor;
- local roster integration and existing Save draft semantics; and
- strict generation, validation, lifecycle, and accessibility behavior.

Out of scope:

- bulk character generation;
- AI generation of a roster by the World Wizard;
- campaign character-profile editing;
- character images or portrait generation;
- publishing a world version;
- creating a campaign;
- direct character persistence outside the world draft; and
- changing published worlds or existing campaigns.
