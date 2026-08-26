# Import or export worlds

## Choose the portable format

Infinite Quest uses separate portable formats for different jobs:

| Format | Contains | Does not contain |
| --- | --- | --- |
| **World JSON** | One explicit immutable world-version snapshot and its portability provenance. | Campaigns, campaign history, Chronicle records, or campaign images. |
| **Campaign Archive** | One campaign, its exact pinned world version, accepted turns, state, portable Chronicle content, and associated original images. | Other campaigns, other world versions, provider profiles and credentials, jobs, thumbnails, and vectors. |
| **System Archive** *(planned release; default-off)* | One Current Owner's portable worlds, campaigns, settings, and every retained Original Asset. | Credentials, access authority, operational work, derived indexes/thumbnails, and deployment configuration. |

None of these files proves that the source user is authorized on the receiving installation. Imported content is owned by the receiving server's resolved user; source IDs are provenance only.

## Export a published world version

1. Select a world and explicit **Published version**.
2. Open **More actions**.
3. Select **Export version**.

World JSON is the right choice when you want to transfer or reuse one immutable world snapshot. It contains world canon only; it does not include a campaign or its progress. Use a Campaign Archive from Campaign Management when the campaign and its pinned world version must travel together.

## Import content

Open **Import a world or campaign**. Choose a file or **Paste copied content**, then preview and validate before selecting **Import validated content**.

Supported workflows include:

- Infinite Quest `.story` or portable campaign content
- Portable world exports
- Infinite Worlds CYOA Writing.com JSON
- Infinite Worlds raw world JSON
- Infinite Worlds world-editor TXT converted with a selected text model
- Matching story TXT attached to a selected published version

World JSON imports one world snapshot only. Matching story TXT is a separate campaign/history attachment workflow. Legacy `.story` content can contain both its world and accepted history. Campaign Archive ZIPs have their own preview and destination choice: they can create or reuse their attached world snapshot, or attach a new campaign to a compatible existing world version.

Optional import controls can select a character, generate missing final-turn choices, or queue an illustration for the latest imported turn. Text conversion and image work remain independent provider operations.

Imports are content-addressed or idempotent where the format supports it. Provider credentials are removed, and the imported records belong to the receiving server's current user. Treat every imported file and pasted value as untrusted input.

## System Archive is separate and release-gated

**System Archive** is implemented as a separate owner-wide portability format, but its production release remains planned and the capability is default-off until its round-trip gate is approved. Its server-owned workflow requires an empty initialized destination, preserves portable non-user UUIDs, remaps ownership to that destination's initial owner, and never merges a world into populated data.

See [System data transfer](../operations/system-data-transfer.md) for exact operation and current release blockers. Do not use World JSON or Campaign Archive as an owner-wide migration substitute. Do not use System Archive as a disaster-recovery substitute: none of these portable formats restores credentials, encryption material, deployment configuration, or exact operational state.
