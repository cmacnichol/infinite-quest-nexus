# World Editor Design

## Purpose

Add a production-ready World Edit Page to the replacement web application. A reader opens it from a World Library entry to author the mutable draft behind that reusable world without altering published world versions or campaigns.

## Route and navigation

- Each World Library card links to `/app/worlds/:worldId`.
- The editor retains the shared application header, theme control, and primary navigation.
- An editor command row provides **Back to World Library**, the world title and draft state, and a far-right **Save draft** action.
- Published versions and campaigns are read-only context with links to their existing management surfaces.

## Information architecture

The page uses the approved **Draft Ledger with Bottom Drawer** structure:

- A compact section index selects one major area at a time.
- The editing canvas uses the remaining width.
- Desktop sections are **Overview**, **Characters**, **Canon**, **Mechanics**, and **Assets**.
- On narrow screens the section index becomes a horizontally available section switcher.
- A docked Draft Ledger bar shows saved/unsaved state, draft revision, readiness, and warning count. It expands upward into a full-width review drawer.

The sections edit:

- **Overview:** title, genre, tone, premise, background story, first action, and rules.
- **Characters:** playable-character roster, names, narrative guidance, profiles, stats, and default trackers.
- **Canon:** entities and relationships.
- **Mechanics:** world RPG stats, default triggers, event triggers, and defaults.
- **Assets:** current cover and world-associated draft assets.

Known fields receive structured controls. Unknown imported properties are preserved through ordinary saves and exposed in an advanced validated JSON editor. JSON is never the primary path.

## Draft behavior

- Saving is explicit; no authoritative request occurs merely because a field changed.
- The page tracks pristine, unsaved, saving, saved, invalid, and conflict states.
- Navigating away with unsaved changes prompts for confirmation.
- Removing collection records remains reversible until save.
- Save sends the complete canonical draft and `expectedRevision` to `PUT /api/v1/worlds/:worldId/draft`.
- A `409` revision conflict leaves local input intact and offers either copying/downloading the unsaved draft or discarding it and reloading the authoritative revision.
- Successful saving replaces the local revision with the server revision and returns the page to a pristine state.

## Data boundaries

- Parse the world aggregate response before rendering it.
- Preserve positive schema versions for reads and write the current schema version (`5`).
- Preserve passthrough world, character, collection-item, asset, and defaults properties.
- Never send a caller-supplied owner or user identity.
- Cover updates use the independent cover-asset endpoint and are not allowed to block ordinary story-world draft saves when optional image services are unavailable.

## States and scale

The page includes loading, retryable load error, not-found, archived read-only, empty collection, validation error, saving, save failure, and revision-conflict states. Collection lists support search and bounded rendering so imported worlds near contract maxima do not attempt to render every detail form at once.

Typical worlds contain 1–12 playable characters and tens to hundreds of canon records. Contract limits remain authoritative: 1,000 playable characters, 20,000 entities, 50,000 relationships, and 10,000 records in each mechanics or asset collection.

## Accessibility and visual system

- Inherit the Constructed Atlas Grid, Literata/Geologica/Chakra Petch typography, square controls, shared semantic theme roles, and artwork-priority rules.
- Every input has a visible label and associated error message.
- Section controls, collection lists, drawer controls, and save actions are keyboard operable.
- Dirty, saving, saved, error, and conflict updates are announced through polite or assertive live regions as appropriate.
- Focus moves to the first invalid field after failed validation and to the conflict heading after a revision conflict.
- Touch targets are at least 44px and reduced-motion preferences are respected.

## Boundaries

Publishing or deleting versions, campaign editing or migration, world import/export management, forking, archiving, permanent deletion, and AI generation are secondary surfaces rather than primary editor workflows. The page may link to them but does not reimplement them.
