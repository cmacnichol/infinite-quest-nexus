# ADR 0016: Reviewed playable-character authoring

## Status

Accepted.

## Context

World drafts store their playable-character roster in `WorldContent.playableCharacters`, but World Management previously rendered that roster as static import output. Authors could not add, edit, or remove characters from a new or imported world. Provider-assisted character creation also needs to respect the existing separation between untrusted model output and authoritative world state.

Published world versions and campaign character snapshots are immutable. Character authoring must therefore update only the current revisioned draft and must not introduce a second character store or mutate existing campaigns.

## Decision

World Management uses one character dialog for manual creation and editing. Character names and prompt-ready guidance are required; character-specific RPG statistics and starting trackers are structured repeatable fields. Stable character IDs are generated independently of names, preserved across edits, and never changed by model output. Imported source metadata and unknown extension fields survive ordinary edits.

Adding, editing, and deleting a character writes the complete world draft through the existing optimistic-revision contract. Deleting the final character is permitted because incomplete drafts and published reference versions remain valid, but the resulting version is not campaign-ready. Existing published versions and campaign snapshots are unaffected.

When an effective default text provider and model are available, the dialog may request one generated character from a dedicated owner-scoped endpoint. The server owns the versioned prompt, supplies bounded world and roster context, resolves only the default text provider, validates and normalizes the response, and returns a candidate without persisting it. The user must review and explicitly save the populated fields. Provider credentials, raw responses, private reasoning, and generation lifecycle data never enter world content.

The generation control is absent when no effective default text model is configured. Manual authoring remains available regardless of provider state.

## Consequences

- New and imported worlds share one roster-authoring workflow.
- Provider-assisted output cannot bypass draft revision checks or the normal world-content schema.
- Character renames do not invalidate campaign selection identifiers.
- No relational schema migration or character-specific persistence API is required.
- Published canon and active campaigns remain isolated from later character edits.
