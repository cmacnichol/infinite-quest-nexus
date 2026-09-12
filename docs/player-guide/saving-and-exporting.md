# Save and export a campaign

The database is authoritative, so ordinary play does not require a browser save to preserve accepted turns.

## Readable exports

The **Export** menu appears only in the Story view:

- **Markdown** downloads a readable `.md` story and includes image references for turns with available illustrations.
- **PDF with images** opens a print-ready story containing available illustrations. Choose **Save as PDF** in the browser print dialog.

Generated Markdown, PDF output, and referenced images must be treated as untrusted content when opened or republished.

## Nexus campaign export

The selected campaign in **Setup → Campaign Management** provides **Export campaign** for a portable campaign backup. Portable exports omit saved provider profiles and credentials. Provenance does not grant ownership or authorization on another installation; imported content belongs to the receiving installation's server-resolved user. Use **Setup → Import** to preview and validate a portable world or campaign before importing it.

Current Campaign Archives use root manifest version 2 and campaign payload
version 4. They retain the campaign turn-control style and redacted accepted
turn policy provenance, while excluding runtime prompt snapshots, provider
chains, checkpoints, retired Intent assignments, and credentials. Older imports
without mode metadata use Action.

## Owner-wide System Archive

The **System Archive** workflow is available in both Data Transfer interfaces and enabled by default in the direct runtime and single-node Compose deployment. The base replicated Swarm stack disables it because its node-local mounts are not shared archive storage. It moves the Current Owner's portable worlds, campaigns, stories, settings, and every retained original image to an empty initialized installation. It is not a way to merge content into another library. An operator may withdraw the capability by setting `SYSTEM_ARCHIVE_ENABLED=false`. Multi-node enablement requires a reviewed shared-storage topology.

System Archive files are sensitive, unencrypted ZIPs. They exclude credentials, external access, operational jobs, derived indexes and thumbnails, and deployment settings. Imported provider profiles remain disabled until an operator supplies and verifies new credentials. See [System data transfer](../nexus-guide/operations/system-data-transfer.md) for the release status and migration procedure.

Readable exports, Campaign Archives, and System Archives complement database and asset backups but do not replace a complete operator Recovery Set.
