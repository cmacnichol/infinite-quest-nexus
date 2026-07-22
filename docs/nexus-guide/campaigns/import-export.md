# Import or export campaigns

## Export

Select a campaign and choose **Export campaign**. The portable file contains campaign story data and provenance but excludes provider profiles and credentials.

Format version 2 also carries the complete campaign character snapshot and state revision needed for a high-fidelity attachment to another world. Older version 1 files remain importable with a compatibility warning when they do not contain the full snapshot.

The player menu also provides `.story`, Markdown, and HTML exports. Those formats serve portability or reading; they do not replace a coordinated PostgreSQL, asset, and encryption-key backup.

## Import

Use **Import a world or campaign**, preview the file or pasted content, and select **Import validated content** only after the format and destination are correct.

For a campaign backup, choose either **Create or reuse the world embedded in this backup** or **Attach a new campaign to an existing world version**. The latter creates a separate campaign, preserves the exported character, accepted history, and accumulated state, and does not merge target-world defaults automatically. Review the exact target version in the preview before importing.

During the pre-authentication phase, imported content belongs to the database-backed initial owner. A source-system `user_id` is provenance, not authorization on this installation.

Import is not an in-place selective update of an arbitrary existing campaign. Matching Infinite Worlds story TXT uses its explicit selected-version workflow; deferred selective campaign-update proposals are not current functionality.
