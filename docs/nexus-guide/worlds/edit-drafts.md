# Edit a world draft

Select a world in World Library and edit its current draft.

## Authoring tabs

- **Overview**: title, genre, tone, and release notes
- **Overview → World cover**: optional fiction-only cover prompt and durable cover generation through the default image provider
- **Lore**: premise, background and canon, and opening action
- **Mechanics & Characters**: rules and the playable-character roster

Additional structured world data can include entities, relationships, events, statistics, and trackers where exposed by the current editor/import contract.

Select **Save draft** to persist changes. Nexus uses an optimistic revision value: if another save has already advanced the draft, reload and reconcile rather than silently overwriting it.

Saving a draft never edits a published version and never changes an existing campaign.

Character editing has two steps: **Add/Apply to world draft** updates the roster in the open world form, and saving that parent form persists it. Applying a character does not publish or save the world. If the parent save fails or encounters a revision conflict, the edited roster remains in the form; review the error and reconcile before retrying. Do not reload to resolve a conflict until you have accounted for unsaved edits, because manual drafts are not recovered after reload.

Generating or replacing a cover stores a world-level asset without changing the draft's content revision. A failed cover can be generated again; it does not prevent draft edits or publication.
