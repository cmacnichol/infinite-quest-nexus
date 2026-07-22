# Save and export a campaign

The database is authoritative, so ordinary play does not require a browser save to preserve accepted turns.

## Readable exports

The **Export** menu appears only in the Story view:

- **Markdown** downloads a readable `.md` story and includes image references for turns with available illustrations.
- **PDF with images** opens a print-ready story containing available illustrations. Choose **Save as PDF** in the browser print dialog.

Generated Markdown, PDF output, and referenced images must be treated as untrusted content when opened or republished.

## Nexus campaign export

The selected campaign in **Setup → Campaign Management** provides **Export campaign** for a portable campaign backup. Portable exports omit saved provider profiles and credentials. Provenance does not grant ownership or authorization on another installation; imported content belongs to the receiving installation's server-resolved user. Use **Setup → Import** to preview and validate a portable world or campaign before importing it.

Current portable exports retain the campaign turn-control style and each accepted turn's resolved Action or Scene direction mode. They do not include Intent provider assignments, classifier audit records, model names, confidence values, or provider credentials. Older imports without mode metadata use Action.

Exports complement database and asset backups but do not replace a complete operator backup.
