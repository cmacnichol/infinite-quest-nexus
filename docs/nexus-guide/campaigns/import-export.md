# Import or export campaigns

## Export

Select a campaign and choose **Export campaign**. The portable file contains campaign story data and provenance but excludes provider profiles and credentials.

The player menu also provides `.story`, Markdown, and HTML exports. Those formats serve portability or reading; they do not replace a coordinated PostgreSQL, asset, and encryption-key backup.

## Import

Use **Import a world or campaign**, preview the file or pasted content, and select **Import validated content** only after the format and destination are correct.

During the pre-authentication phase, imported content belongs to the database-backed initial owner. A source-system `user_id` is provenance, not authorization on this installation.

Import is not an in-place selective update of an arbitrary existing campaign. Matching Infinite Worlds story TXT uses its explicit selected-version workflow; deferred selective campaign-update proposals are not current functionality.
