# Import or export worlds

## Export a published world version

1. Select a world and explicit **Published version**.
2. Open **More actions**.
3. Select **Export version**.

The portable export contains the immutable world snapshot and provenance needed for portability. It does not contain campaigns or provider credentials.

## Import content

Open **Import a world or campaign**. Choose a file or **Paste copied content**, then preview and validate before selecting **Import validated content**.

Supported workflows include:

- Infinite Quest `.story` or portable campaign content
- Portable world exports
- Infinite Worlds CYOA Writing.com JSON
- Infinite Worlds raw world JSON
- Infinite Worlds world-editor TXT converted with a selected text model
- Matching story TXT attached to a selected published version

World JSON imports world canon only. Matching story TXT is a separate campaign/history attachment workflow. Legacy `.story` content can contain both its world and accepted history.

Optional import controls can select a character, generate missing final-turn choices, or queue an illustration for the latest imported turn. Text conversion and image work remain independent provider operations.

Imports are content-addressed or idempotent where the format supports it. Provider credentials are removed, and the imported records belong to the receiving server's current user. Treat every imported file and pasted value as untrusted input.
