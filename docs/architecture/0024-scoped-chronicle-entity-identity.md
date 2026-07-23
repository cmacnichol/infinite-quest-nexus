# ADR 0024: Chronicle entity identity is scoped and derived

## Status

Accepted

## Context

Chronicle supplements lexical retrieval with entity matches extracted largely from capitalization patterns. That heuristic can miss aliases, titles, possessives, and names whose capitalization changes, while identical names can refer to different entities in different worlds or campaigns. Better entity recall must not make Chronicle authoritative, expose internal identifiers to the narrative model, or weaken ownership and campaign isolation.

## Decision

Chronicle records carry derived `entity_ids` metadata for retrieval. These identifiers refer to a catalog built from the campaign's pinned immutable world version, selected-character snapshot, and campaign character profile. Schema-v5 aliases under `characterProfile.profile.identity.aliases` augment the selected character's snapshot aliases without changing its stable scoped identity.

The catalog is reconstructed from authoritative world and campaign data and is therefore rebuildable alongside the rest of Chronicle. Migration `0039_chronicle_entity_identity.sql` adds GIN-indexed arrays to Chronicle memories and canonical facts, then requests a deduplicated Chronicle reindex for every existing campaign.

Indexing resolves known names and aliases deterministically before applying capitalization-based extraction as a fallback for newly discovered or otherwise uncatalogued names. An alias is resolved only when it identifies one catalog entry within the applicable scope. Ambiguous aliases remain unresolved text and must not be guessed or attached to every matching entity.

Queries resolve mentioned names and aliases through the same scoped catalog. Exact `entity_ids` overlap participates in candidate selection and relevance scoring alongside lexical, semantic, chronological, and recency signals. Owner, campaign, and historical turn-cutoff predicates still constrain every candidate query.

Entity identifiers participate only in derived indexing, ranking, provenance, and diagnostics. Narrative prompts contain relevant human-readable names and fiction, never internal `entity_ids`. Entity matching does not grant an LLM or retrieval plugin authority to create, merge, rename, or otherwise mutate world entities, character data, campaign state, or accepted history.

Every catalog construction, entity resolution, index write, and retrieval query is constrained by owner and campaign. World-derived entries additionally come only from the campaign's pinned world version. Identical identifiers, names, or aliases in another owner, campaign, or world version cannot become candidates.

## Consequences

- Known aliases and character references improve Chronicle recall without changing prompt contracts or authoritative state.
- Campaigns remain stable when a world draft or later world version changes its entity catalog.
- Campaign profile aliases can improve character recall while retaining the snapshot-derived stable character identity.
- Ambiguous aliases favor missed enrichment over incorrect identity joins.
- Newly discovered names still receive best-effort keyword coverage through the fallback heuristic until an authoritative, reviewed identity exists.
- Entity metadata can be deleted and rebuilt from pinned world and campaign data plus accepted fiction.
- Generation, import, canonical-fact projection, summaries, open threads, and reindexing must all use the same resolver.
- Tests cover aliases, ambiguity, capitalization changes, campaign isolation, historical cutoffs, prompt non-disclosure, and deterministic rebuilds.
