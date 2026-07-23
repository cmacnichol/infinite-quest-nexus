# ADR 0023: Structured world and campaign character profiles

## Status

Accepted

## Context

Playable-character identity, story guidance, and appearance previously shared one general `characterText` field. That format is readable but cannot reliably give the Story Engine targeted context or give the illustration pipeline canonical visual details. Character facts may also evolve through deliberate campaign editing without changing the immutable world version from which the campaign began.

Automatically extracting or expanding old prose during a migration would make an LLM an unaudited authority and could invent details. Replacing campaign snapshots would also destroy useful origin evidence.

## Decision

World content schema version 5 adds a structured profile to each playable character. The profile separates identity, story guidance, appearance, and unclassified source notes. Published world versions remain immutable and schema-version 4 content remains readable.

Campaign creation stores two distinct representations:

- `character_snapshot` remains the unchanged selected world-version character and records the campaign's origin.
- `character_profile` is a campaign-owned full copy of the character name and structured profile. It is editable through an optimistic revision, audit history, and explicit user save.

The effective-character resolver uses the campaign copy first, then a structured profile in the immutable snapshot, then bounded legacy guidance. Branches and cross-world transfers copy the current campaign profile. Same-world version migration retains it. Profile edits do not rebuild Chronicle memories because the profile is fixed authoritative context; they deactivate active model chains so the next request rebuilds its prompt.

Creative character generation may add new details. “Organize profile with AI” is a separate strict extraction workflow: every proposed populated field must cite an exact excerpt from submitted source text, unknown fields remain empty, conflicts and unassigned text remain visible, and selected proposals only update the unsaved editor. The ordinary Save action is the sole persistence boundary.

Story, mechanics, recovery, event-trigger, retrieval, and public context-preview paths consume the same targeted effective-character context. The story prompt protocol changes when this context shape changes.

Campaign illustration sets snapshot a bounded, fiction-only visual reference made from the effective character's name, aliases, and appearance fields. Both direct and AI-refined scene prompts pass through one final composer. It appends the canonical reference conditionally—only when the character is actually depicted—before library matching or provider delivery. Editable segment prompts remain scene-only, while resolution snapshots and durable image jobs store the composed provider prompt. Existing illustration sets therefore remain stable; rebuilding a set uses the latest explicit profile revision.

## Consequences

- Story and image prompts receive specific character facts without mixing RPG mechanics into prose.
- Existing worlds and campaigns continue to work without an automatic or lossy rewrite.
- Campaign character changes are explicit, revisioned, reviewable, and isolated from their source world.
- Campaign profiles duplicate world-version data by design so campaign continuity does not depend on later world edits.
- Structured NPC and entity appearances remain a future extension.

## Alternatives considered

Sparse campaign overrides were rejected because merging nested fields across imports, branches, and future schema versions would obscure the authoritative value. Rewriting the immutable snapshot was rejected because it would erase provenance. Automatic LLM migration was rejected because unsupported inference is not a safe schema migration. Allowing the refinement model alone to carry appearance details was rejected because it can omit them before the image provider call.
