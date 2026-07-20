# ADR 0013: Versioned playable-character rosters and campaign snapshots

## Status

Accepted.

## Context

Infinite Worlds exports may define several playable characters. The original importer required one character during world import and discarded the others. It then stored the chosen character, skills, and starting trackers as world-level values. Campaign creation therefore had no character choice and every campaign from that version inherited the same player character.

A world version is immutable shared canon, while a campaign must remain isolated from later world edits and migrations. Reading a selected character dynamically from a mutable draft or newer version would violate that boundary.

## Decision

World content schema version 3 adds a `playableCharacters` array. Each entry has an opaque ID, name, prompt-ready character text, character-specific RPG statistics, character-specific starting trackers, and sanitized source metadata. World-wide statistics, trackers, and event triggers remain separate.

Campaign creation resolves a character against the exact selected world version. Multi-character versions require an explicit selection; single-character and legacy versions select automatically. The campaign stores both the selected ID and an immutable JSON snapshot. Campaign state is seeded from world-wide defaults plus only the selected character's defaults.

Story context overlays the campaign snapshot onto the pinned world's legacy `world.character` field and does not expose the complete roster to the narrative model. Campaign exports likewise emit the snapshotted character. World-version migration retains the campaign character snapshot; changing protagonists is a separate future audited operation.

Legacy world content synthesizes one `legacy-default` character. Migration 0017 backfills existing campaigns from their pinned world version without modifying accepted turns, Chronicle memory, or mutable campaign state. Portable world format version 1 remains valid because the roster is an additive content field; new converted worlds use content schema version 3.

Matching Infinite Worlds story TXT imports select or unambiguously match a character when creating their campaign. World JSON and TXT imports retain every playable character instead of choosing one during world creation.

## Consequences

- Multiple campaigns can use different protagonists from one immutable world version.
- Character-specific stats and trackers cannot leak between campaigns.
- Model chains include the effective selected character through the context fingerprint; prompt protocol version 6 invalidates incompatible saved chains.
- Previously discarded character options cannot be reconstructed from stored data. Users must explicitly re-import the original source to recover them, producing a new world or reviewed world version rather than rewriting published canon.
