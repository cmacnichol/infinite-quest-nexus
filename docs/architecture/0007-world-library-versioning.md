# ADR 0007: Separate mutable world drafts from immutable campaign versions

## Status

Accepted for Phase 2.

## Decision

Each World Library record owns one mutable `world_drafts` row and zero or more immutable `world_versions` rows. Draft writes use an expected revision so concurrent browser sessions cannot silently overwrite one another. Publishing snapshots the complete draft into the next numbered version and does not move any campaign automatically.

A campaign remains pinned to its selected world version. Moving it to a newer version is an explicit transaction recorded in `campaign_world_migrations`. The migration is allowed only within the same world and only when no generation job is active. It changes the campaign's current world version and invalidates saved provider response chains; accepted turns and historical Chronicle memories are not rewritten.

Forking copies a selected immutable version into a new independent draft and records source-world and source-version provenance. Subsequent edits and publications affect only the fork.

Portable world and campaign exports are server-generated, user-scoped JSON. They never include provider profiles, credentials, rejected generations, private model responses, or operational job records. Imports are schema-validated and previewed before their transactional write, and content hashes make repeated imports idempotent.

## Consequences

- World authors can revise canon without changing running campaigns.
- Campaign upgrades are auditable and intentionally invalidate short-term LLM continuation state.
- Draft conflicts are visible rather than last-write-wins.
- Published versions are safe campaign and export references.
- World and campaign management remain compatible with stateless API replicas because PostgreSQL owns revisions, locks, and migration records.
