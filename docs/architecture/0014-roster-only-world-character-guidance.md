# ADR 0014: Roster-only world character guidance

## Status

Accepted. This decision supersedes the legacy-character compatibility portions of ADR 0013. ADR 0013 remains the record of why versioned playable-character rosters and immutable campaign snapshots were introduced.

## Context

World content historically stored one unstructured player-character prompt in `world.character`. Schema version 3 added `playableCharacters`, but the domain continued to synthesize a `legacy-default` roster entry when that array was empty. New producers also copied one selected character back into the overview field. The duplicate representations made it possible for imports, editing, campaign creation, and story context to disagree about the playable character.

Importing worlds from releases that predate structured rosters is no longer a product requirement. Portable campaign backups still need an explicit compatibility conversion because their selected campaign character is serialized separately from reusable world canon.

World authoring must also support incomplete drafts. In particular, a later LLM-assisted new-world workflow may generate and review a world in stages. Persisted content therefore needs one canonical shape shared by manual authoring, deterministic importers, and future assisted generation without making every intermediate draft campaign-ready.

## Decision

World content schema version 4 removes `character` from the declared world overview. Structured `playableCharacters` entries are the only reusable source of player-character guidance. Reading an older positive schema version remains supported, but normal domain behavior never synthesizes a roster from `world.character`.

All newly created or updated content passes through one pure canonicalization boundary. Canonicalization validates and defaults the content, sets `schemaVersion` to 4, and explicitly removes `world.character`. The overview and root schemas remain passthrough so unknown lore fields survive round trips and can be adopted by later authoring features.

Content validity and campaign readiness are separate concerns:

- A draft with no playable characters is valid and may be saved, generated incrementally, reviewed, and published.
- Campaign readiness requires a non-empty structured roster with unique stable IDs, names, and non-empty character guidance.
- Campaign creation checks readiness and character selection against the exact immutable world version. Zero-character, ambiguous multi-character, and unknown-character selections produce distinct client errors.

World-wide statistics and triggers are merged with only the selected roster entry's defaults when a campaign is created. The campaign's immutable character snapshot remains the runtime authority for prompts, player APIs, and campaign exports. New snapshots omit the retired `legacy` marker. Existing stored snapshots may retain it as harmless historical metadata.

Portable campaign import may explicitly convert its selected-character compatibility field into one structured roster entry at the import boundary. That conversion is not a general world fallback and is not available to ordinary world reads or campaign creation.

Manual editors, importers, existing generators, and the future LLM-assisted new-world function must all produce the same version-4 `WorldContent`. Generation-provider request state, credentials, raw responses, and job lifecycle do not belong in world content. LLM output is untrusted input: it must pass through the same schemas, canonicalizer, and readiness assessment, may be retained as an incomplete draft, and becomes authoritative only through an explicit revision-checked save.

Existing published world-version JSON is not rewritten. World versions are immutable, and altering their JSON would also invalidate recorded source hashes. No SQL or maintenance migration is part of this decision; drafts converge on the canonical representation when next saved, while new versions and exports stop propagating the obsolete key.

## Consequences

- There is one reusable representation of playable characters and no precedence rule between overview text and roster entries.
- Incomplete manual or generated drafts remain possible without being mistaken for campaign-ready worlds.
- Future assisted authoring can evolve generation-specific schemas independently, then finalize through the same persistence contract used by every other producer.
- Older published versions containing only `world.character` remain inspectable but cannot start a new campaign unless explicitly converted into a new structured-roster draft and published version.
- Existing campaigns continue to use their stored character snapshots and are unaffected by later world edits.
- Physical cleanup of historical JSON, if ever required, needs a separately reviewed maintenance design that reconciles immutability and source hashes.
