# Import or export campaigns

## Campaign Archive export

Select a campaign and choose **Export campaign** to download a Campaign Archive ZIP. It is a portable copy of exactly one campaign and the immutable world version currently pinned to it—not a backup of every campaign that uses the world.

The archive includes:

- the attached world metadata and exact immutable world-version snapshot;
- the campaign's character snapshot and profile history, current state and revision, state-edit history, and relevant transfer/migration provenance;
- every accepted turn through the active turn, illustration settings, visible illustration sets and segments, and provider-reported campaign or turn costs;
- portable Chronicle summaries and non-vector memory, including imported history checkpoints; and
- the original bytes and library metadata for each image bound to the campaign, its accepted turns, illustration sets or segments, completed campaign images, attached world cover, or pinned world version.

Original images are stored by content hash and carry explicit bindings, so a cover, selected turn image, and alternate segment variants can be restored as their original files. Export stops with an error if a required original asset is missing or no longer matches its recorded metadata; it never produces a knowingly incomplete archive.

Campaign Archives deliberately exclude other world versions, other campaigns, unrelated owner-library images, provider profiles and prompt overrides, credentials, provider response chains, operational job rows, thumbnail derivatives, and vector/embedding records. Provider credentials, Intent assignments, classifier records, confidence values, and any credential-shaped metadata are not portable. The excluded derived data can be rebuilt after import; the accepted-turn ledger and portable Chronicle content remain the recovery record.

The Story-only **Export** menu still provides readable Markdown and print-to-PDF exports for the active story. Use **Export campaign** when you need a portable Campaign Archive.

## Campaign Archive import

Open **Import a world or campaign**, select **Campaign Archive**, choose the ZIP, and preview it before committing the import. Preview validates the ZIP structure, required payloads, checksums, image bytes, scope, and selected destination without writing authoritative records. It shows the campaign and attached world, accepted-turn and Chronicle counts, original-image count and bytes, selected character, the destination operation, and any compatibility warnings. The commit uses the preview token rather than uploading the ZIP a second time; the token expires, and changing the selected destination requires a new preview.

Choose one destination:

- **Create or reuse the world embedded in this backup** creates the attached world/version when its canonical content is absent, or reuses an identical version already owned by the destination installation.
- **Attach a new campaign to an existing world version** is available only when the selected destination version has the same portable world content. It creates a separate campaign; it does not merge imported history or state into an existing campaign and does not copy target-world defaults into the imported one.

Import assigns fresh destination IDs for campaign, world records created by the import, turns, Chronicle records, and segments, then rewrites known relationships and image links. Original images are content-addressed for the receiving owner: an image with matching bytes may reuse that owner's existing destination asset, and every source asset reference is remapped to the resulting destination asset ID. Re-importing the same content fingerprint with the same destination choice returns the completed import instead of duplicating it. Importing that archive into a different compatible destination is a separate new campaign.

The importer validates the archive again before one transactional write. Corrupt, unsafe, over-limit, checksum-mismatched, or scope-invalid archives fail before authoritative records are committed. If a write fails, database changes roll back and only newly written, unreferenced original files are cleaned up.

### Compatibility

Current Campaign Archives use a versioned root manifest with checksums and explicit asset bindings. Existing portable campaign JSON remains available through the legacy import path. Earlier campaign ZIPs containing `campaign.json` and `assets/` but no `manifest.json` are also accepted through a compatibility adapter. Their preview warns that source checksums, MIME declarations, and explicit image-binding guarantees were unavailable; inferred legacy bindings should be reviewed after import. Older portable campaign format data without a turn mode defaults to **Action**.

## Safety and limits

Treat a Campaign Archive as private, unencrypted content. It can contain world lore, campaign history, character and state data, Chronicle content, and original images. Store and transfer it only through trusted, encrypted channels; anyone who can read the ZIP can read that content.

The default limits are 2 GiB compressed, 20 GiB uncompressed, 100,000 entries, a 100:1 maximum per-entry expansion ratio, a 5 MiB manifest, 1 GiB per JSON payload, and 25 MiB per original image. Deployments may set lower runtime limits. ZIP paths, duplicate names, special files, and invalid image payloads are rejected, and uploads are staged beneath the application data root rather than using the supplied filename as a filesystem path.

During the pre-authentication phase, imported records belong to the database-backed initial owner. Source owner IDs and other source provenance do not grant access or establish authorization on the receiving installation.

## What a Campaign Archive is not

A Campaign Archive is a portable, single-campaign transfer. It is not an in-place campaign update, a coordinated disaster-recovery backup, or the planned owner-wide **System Archive**. For disaster recovery, use a coordinated PostgreSQL, asset-storage, and encryption-key backup. System Archive will be a separate future import/export option with its own owner-wide scope and safeguards.

Matching Infinite Worlds story TXT continues to use its explicit selected-version workflow; deferred selective campaign-update proposals are not current functionality.
