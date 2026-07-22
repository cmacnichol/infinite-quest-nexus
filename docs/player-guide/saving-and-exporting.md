# Save and export a campaign

The database is authoritative, so ordinary play does not require a browser save to preserve accepted turns.

## Portable story file

Open the player menu and select **Save Story File** to download a portable `.story` representation. Treat it as private campaign data. Store it securely and inspect the destination before sharing it.

## Readable exports

- **Export to Markdown** creates a text-oriented story document.
- **Export to HTML** creates a browser-readable story document.

Generated HTML and Markdown must be treated as untrusted content when opened or republished.

## Nexus campaign export

The selected campaign management panel also provides **Export campaign**. Portable exports omit saved provider profiles and credentials. Provenance does not grant ownership or authorization on another installation; imported content belongs to the receiving installation's server-resolved user.

Current portable exports retain the campaign turn-control style and each accepted turn's resolved Action or Scene direction mode. They do not include Intent provider assignments, classifier audit records, model names, confidence values, or provider credentials. Older imports without mode metadata use Action.

Exports complement database and asset backups but do not replace a complete operator backup.
