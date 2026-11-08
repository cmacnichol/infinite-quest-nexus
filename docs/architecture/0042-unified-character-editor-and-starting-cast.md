# ADR 0042: Unified character editor and starting cast

## Status

Accepted 2026-11-08.

## Context

World characters can serve as a campaign's protagonist, supporting cast, or both. A campaign needs independent character state without changing the immutable world version it started from. Existing archives and integrations already use `playableCharacters`, and older readers assume every entry is selectable.

## Decision

Keep the world content schema at version 6 and retain the `playableCharacters` storage name. Each roster entry declares `campaignUse` as `playable`, `supporting`, or `both`; absent values default to `playable`. Starting-cast defaults and context preferences default to true and false respectively. Only playable and both entries may be selected as protagonists. A separate complete-roster reader serves starting cast and identity matching. Mechanics retained on supporting entries are not applied to a campaign unless that character is selected as its protagonist.

The pinned world version is the immutable source for authored profiles. Campaign-owned events record activation, subsequent edits and their provenance; they do not mutate the world. A shared editor presents these distinct authorities through context-specific adapters. Imports, transfers and archives preserve the roster and enforce destination ownership and selection rules. Accepted campaign protagonist snapshots remain independent of later world changes.

Ship compatible readers before exposing supporting authoring or writing new cast formats. The first supporting roster and the first v3 cast value each establish a downgrade boundary; disable new writes and retain compatible readers after activation. Lifecycle operations and v4 portability are a separate release.

## Consequences

Legacy rosters remain selectable without migration, and starting cast can be introduced without conflating world canon and campaign state. Consumers must use the appropriate selectable or complete roster and preserve additive fields through portable formats. Older binaries cannot safely select from a mixed roster, so rollback across the reader boundary requires a rehearsed restore and accounting for subsequent writes.

The [confirmed design](../superpowers/specs/2026-11-08-unified-character-editor-and-starting-cast-design.md) specifies field policy, compatibility, and release evidence. This decision refines ADR 0013's assumption that every roster entry is selectable while retaining its pinned protagonist snapshot and ownership boundaries.
