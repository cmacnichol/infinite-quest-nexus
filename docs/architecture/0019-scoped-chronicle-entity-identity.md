# ADR 0019: Chronicle entity identity is scoped and derived

## Status

Accepted

## Context

Chronicle currently supplements lexical retrieval with entity matches extracted largely from capitalization patterns. That heuristic can miss aliases, titles, possessives, and names whose capitalization changes, while identical names can refer to different entities in different worlds or campaigns. Better entity recall must not make Chronicle authoritative, expose internal identifiers to the narrative model, or weaken ownership and campaign isolation.

## Decision

Chronicle records carry derived `entity_ids` metadata for retrieval. These identifiers refer to a catalog built from the campaign's pinned immutable world version and its immutable selected-character snapshot, including explicitly authored aliases where available. The catalog is reconstructed from authoritative world and campaign data and is therefore rebuildable alongside the rest of Chronicle.

Indexing resolves known names and aliases deterministically before applying the existing capitalization-based extraction as a fallback for newly discovered or otherwise uncatalogued names. An alias is resolved only when it identifies one catalog entry within the applicable scope. Ambiguous aliases remain unresolved text and must not be guessed or attached to every matching entity.

Entity identifiers participate only in derived indexing, ranking, provenance, and diagnostics. Narrative prompts contain the relevant human-readable names and fiction, never internal `entity_ids`. Entity matching does not grant an LLM or retrieval plugin authority to create, merge, rename, or otherwise mutate world entities, character snapshots, campaign state, or accepted history.

Every catalog construction, entity resolution, index write, and retrieval query is constrained by owner and campaign. World-derived entries additionally come only from the campaign's pinned world version. The selected character comes from the campaign snapshot rather than a mutable world draft or newer version. Identical identifiers, names, or aliases in another owner, campaign, or world version cannot become candidates.

## Consequences

- Known aliases and character references improve Chronicle recall without changing prompt contracts or authoritative state.
- Campaigns remain stable when a world draft or later world version changes its entity catalog.
- Ambiguous aliases favor missed enrichment over incorrect identity joins.
- Newly discovered names still receive best-effort keyword coverage through the fallback heuristic until an authoritative, reviewed identity exists.
- Entity metadata can be deleted and rebuilt from pinned world and campaign data plus accepted fiction.
- Tests must cover aliases, ambiguity, capitalization changes, possessives, identical names across campaigns, pinned-version behavior, and owner isolation.
