# Work with world-version history

Use **Published version** to inspect **Latest published version** or an explicit numbered version.

Version history supports:

- Creating a campaign from an exact version
- Exporting the selected immutable version
- Forking the selected version
- Inspecting whether a version can be deleted
- Explicitly migrating a campaign to a newer version

Version numbers are monotonic and never reused. Deleting an unused version leaves a gap so provenance and historical references remain unambiguous.

Selecting an older version does not make it the editable draft.
