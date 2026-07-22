# Current capabilities

This page summarizes behavior implemented in the current repository. It is not a roadmap.

## Platform and persistence

- PostgreSQL 18.4-compatible local deployment with pgvector 0.8.5
- Idempotent initial-user bootstrap through the stable `initial-owner` system key
- Automatic online schema migrations coordinated with PostgreSQL advisory locking
- File-based secret inputs for database and credential-encryption values
- User ownership and campaign/world isolation constraints
- Content-addressed generated-asset storage

## World Library

- Editable world drafts with optimistic revisions
- Structured overview, lore, rules, entities, relationships, events, statistics, trackers, and playable-character rosters
- Manual and provider-assisted reviewed character authoring
- Immutable numbered world-version publication
- Version history with version numbers that are never reused
- Safe deletion of unused published versions
- Fork provenance and independent editable forks
- Archive, restore, guarded permanent deletion, and portable export/import
- Infinite Worlds JSON and TXT import workflows with preview and validation

## Campaigns

- Campaign creation from an exact immutable world version
- Selected playable-character snapshots isolated from later world edits
- Campaign switching and latest-turn resume in the player experience
- Independent default story response length
- Explicit campaign migration to a newer version of the same world
- Append-only accepted-turn history across migration
- Archive, guarded deletion, rewind, and branch workflows
- Credential-free portable campaign export
- Provider-reported campaign cost ledger when a provider supplies cost data

## Chronicle

- Accepted-turn ledger as the recovery source of truth
- Fiction-only Chronicle records derived from accepted action and narration
- Complete, balanced, compact, summary, and automatic context modes
- Typed living summaries, canonical facts, open threads, and summary checkpoints
- Budgeted world canon, campaign canon, and current-scene prompt scopes
- PostgreSQL full-text, entity, recency, relevance, and chronology retrieval
- Optional campaign-scoped semantic retrieval with lexical fallback
- Independent embedding provider, model, task-prefix, batch, health, and reindex configuration
- Durable replica-safe Chronicle rebuild and embedding jobs
- Context metrics and sanitized context preview

## Story Engine

- Durable PostgreSQL-backed generation jobs with leases and idempotency keys
- Database-state prompt bootstrap for every turn and model switch
- Typed private assessment, percentile resolution, triggers, and retry-stable mechanics
- Strict structured-output validation and mechanic-leak detection
- Output-limit recovery and recoverable job states
- Atomic accepted-turn, campaign-state, and Chronicle commits
- Pending-job resume after a browser refresh
- Streaming narration progress where the provider supports it
- Rejected or incomplete generations cannot mutate accepted campaign state

## Providers

- User-owned encrypted provider profiles
- Separate roles for story text, Chronicle embeddings, and illustrations
- LM Studio native text generation and loaded-model discovery
- OpenRouter, Manifest, and generic OpenAI-compatible text adapters
- LM Studio and compatible embedding requests
- OpenRouter image generation and generic compatible image endpoints
- Independent endpoints, credentials, models, health, timeouts, and defaults for every role
- Safe transport diagnostics that exclude credentials and prompt bodies

## Illustrations

- Optional image child jobs after a story turn is accepted
- Independent campaign image provider, model, format, size, aspect, quality, and retry settings
- Replica-safe retries that never rerun or reject story narration
- Fiction-only image prompts that exclude mechanics, scratchpads, and private reasoning
- Base64 PNG, JPEG, and WebP validation
- Stored-asset display, prompt editing, and regeneration
- Successful story completion when images are disabled or generation fails

## Deployment

- Local two-container Compose steady state: `infinitequest-app` and PostgreSQL
- Combined `all` role plus explicit `api`, `worker`, and `migrate` roles
- Liveness and database/pgvector readiness endpoints
- Swarm stack with independently scalable API and worker services
- External PostgreSQL and Swarm-secret configuration
- Shared generated-asset path and conservative rolling update policies
- VitePress documentation validation on pull requests and automatic GitHub Pages deployment from `main`

## Deliberate current limitations

- Interactive login and OIDC are deferred; deployments must remain on the intended trusted network.
- Image and embedding providers are optional and never required for accepted text generation.
- The root legacy client remains for historical reference and is not kept in feature parity.
