# Infinite Quest Nexus

[![AI Assisted](https://img.shields.io/badge/AI-Assisted-7c3aed?style=flat-square)](#ai-assisted-development)

Infinite Quest Nexus is the server-backed evolution of Infinite Quest. PostgreSQL owns worlds, campaigns, accepted turns, and Chronicle memory so story continuity no longer depends on a browser session, a model instance, or an LLM context chain.

This project was inspired by Infinite Worlds and the stand-alone [Infinite Quest project by Anostus](https://github.com/Anostus/InfiniteQuest).

The current implementation is a production-shaped vertical slice. It serves the existing Infinite Quest client, imports portable `.story` JSON into PostgreSQL, constructs fiction-only local Chronicle memory, and can generate validated database-backed turns through LM Studio, OpenRouter, Manifest, or another OpenAI-compatible text endpoint. The same application image runs in combined, API, worker, or recovery migration roles.

## What works now

- PostgreSQL 18.4 with pgvector 0.8.5.
- Idempotent initial-user migration using the stable system key `initial-owner`.
- Two-container Docker Desktop steady state: application plus PostgreSQL.
- Automatic, advisory-lock-coordinated PostgreSQL initialization and online schema migrations through `node-pg-migrate`.
- Legacy `.story` JSON import into world, immutable world version, campaign, state, and accepted turns.
- Separation of canonical narration, private mechanics, and private state snapshots.
- Chronicle memory rebuilt from accepted action and narration only.
- Filtering of explicit dice/check leakage before Chronicle indexing.
- Complete-history character and token estimates.
- Automatic, full, balanced, compact, and summary context modes.
- Optional campaign-scoped embeddings combined with PostgreSQL full-text relevance, recency, and chronological coverage.
- Typed living summaries, canonical facts with explicit supersession, current open threads, and hierarchical summary checkpoints rebuilt from accepted turn snapshots.
- Budgeted World Library rules/entities/relationships plus validated campaign trackers and fiction-only continuity state.
- Hard prompt-envelope budgeting that reserves provider output and prompt overhead, caps caller context hints, and records selected memory IDs and hashes.
- LM Studio and OpenAI-compatible `/v1/embeddings` support with hash-based freshness and deterministic lexical fallback.
- Model-aware embedding task prefixes, provider fingerprints, bounded semantic candidates, and work-versioned indexing that cannot lose concurrent accepted turns.
- Independently configured embedding providers, models, credentials, batch sizes, health failures, and rebuild jobs.
- Durable PostgreSQL-backed Chronicle reindex jobs claimed safely by worker replicas.
- Encrypted, user-owned text-provider profiles with independent endpoint, key, model, context, and output settings.
- LM Studio native `/api/v1/chat` support pinned to advertised loaded instance IDs without duplicate-loading context overrides.
- OpenRouter, Manifest, and generic OpenAI-compatible text-provider adapters.
- Loaded-model discovery with advertised LM Studio context length used as the generation context default.
- Durable, idempotent Story Engine jobs with leases, attempt records, compact output-limit recovery, and explicit recoverable state.
- Database-snapshot bootstrap on every turn and model switch; provider response chains are optional recovery optimizations only.
- Strict JSON/schema validation and all-field mechanics-leak detection before transactional turn and Chronicle commits.
- Opt-in player bridge from the legacy Infinite Quest UI to the durable Story Engine for main story turns.
- Automatic browser-story import/reconnection, campaign turn-count divergence detection, idempotent submission, and pending-job resume after reload.
- Typed backend RPG assessment, durable private percentile resolution, and retry-safe reuse without rerolling.
- Typed before/after event evaluation, trigger counters, deferred events, and validated fiction-only after-scene extensions.
- A migration, provider, generation, and memory-inspection UI at `/nexus/`.
- A database-backed World Library for editable drafts, reviewed manual or default-text-model character authoring, immutable publication, version history, safe deletion of unused published versions, fork provenance, archive/restore, and portable world export/import.
- Campaign creation from selected world versions, campaign switching, latest-turn resume into the player view, archive and guarded deletion controls, explicit audited upgrades to newer versions, and credential-free portable campaign exports.
- Guarded world deletion that refuses to remove canon still referenced by a campaign and clears only the deleted world's import/fork provenance after confirmation.
- Independently configured image-provider profiles and optional post-commit illustration jobs.
- OpenRouter's dedicated image API and generic OpenAI-compatible image endpoints with separate credentials and model discovery.
- Replica-safe image retries, base64 raster validation, content-addressed shared asset storage, and failure isolation from accepted story turns.
- Docker Swarm definitions for replicated API and worker services using CephFS assets.

The player UI can now use the Nexus Story Engine for main story turns from **Active Text Provider & Context**, including campaigns with RPG stats and before/after event triggers. Referee responses, random values, targets, trigger reasons, and orchestration diagnostics remain private. The narrative request receives only selected fictional consequences and authoritative trigger effects after independent sanitization. Illustrations are configured separately in Nexus and run only after accepted story completion.

The Nexus interface at `/nexus/` is the World Management surface. World drafts use optimistic revisions; publication creates immutable numbered versions. An explicitly selected published version can be permanently deleted only while it has no current or historical campaign dependency; draft, fork, and import provenance survives as detached metadata, and deleted version numbers are never reused. Creating or editing a world never alters an existing campaign. When a newer version is available, the campaign panel offers an explicit migration that preserves its append-only accepted-turn ledger and starts the next generation from a fresh database-backed model chain. The same panel stores the campaign's default story response length independently from the provider's maximum-output safety ceiling. Selecting **Load story** passes the server-generated accepted ledger through one-time session storage, reconnects the same campaign ID, and opens the player view at the latest accepted turn without persisting provider credentials in the handoff.

## Requirements

- Docker Desktop with Linux containers and the Compose plugin.
- At least 2 GB of available memory for the local stack.
- Node.js 22.13 or newer and pnpm 11.14.0 when running the source-level development commands directly.
- An external LM Studio, OpenRouter, Manifest, or OpenAI-compatible endpoint for Story Engine generation.

## Start locally

Copy the local configuration example, replace its database password, and set a long random credential-encryption key before saving provider API keys:

```powershell
Copy-Item .env.example .env
notepad .env
```

Start the application:

```powershell
docker compose up --build
```

Open:

- Infinite Quest: `http://localhost:8080/`
- Nexus migration and Chronicle inspector: `http://localhost:8080/nexus/`
- Readiness: `http://localhost:8080/health/ready`

The first startup downloads `pgvector/pgvector:0.8.5-pg18-trixie`, builds the application image, waits for PostgreSQL, creates the schema and initial owner, and starts the combined API/worker role. Later starts check the migration history and apply only pending online migrations.

Open `/nexus/`, save a text-provider profile, discover models, select a campaign, and enter the next action. For LM Studio running on the Docker Desktop host, the default endpoint is `http://host.docker.internal:1234`. Swarm deployments must use stable private-network DNS instead.

Model discovery uses an advertised context length as the provider and prompt-budget default. The context field becomes read-only while that API-supplied value is active; it remains editable when the endpoint omits context metadata. Hover text and the expandable help panel describe every Chronicle compression level.

For semantic Chronicle retrieval, save a separate provider profile with the **Chronicle embeddings** role. Select the campaign, enable hybrid semantic memory, choose an embedding-capable model, and save the configuration. LM Studio exposes embeddings through its OpenAI-compatible `/v1/embeddings` endpoint. Indexing runs as a durable worker job; story context continues with lexical retrieval while vectors are incomplete or the embedding endpoint is unavailable.

Document and query task prefixes are automatic when left blank. The default Nomic model uses `search_document: ` for stored Chronicle records and `search_query: ` for retrieval. Override them only when the selected embedding model documents a different instruction format.

For optional artwork, save a separate provider profile with the **Illustrations** role. Select a campaign, choose the image profile and model, configure the render options, and enable automatic illustrations. OpenRouter uses its dedicated Image API; other profiles use a compatible `/v1/images/generations` endpoint. Nexus accepts base64 PNG, JPEG, or WebP output and stores it in shared asset storage. Illustration retries and failures never rerun or reject the story turn.

To connect the player experience, open Infinite Quest **Active Text Provider & Context**, enable **Use the database-backed Nexus Story Engine**, select the saved backend provider and model, and generate the next turn. The client imports the current story on first use, synchronizes edited RPG stats and event triggers at the current accepted-turn boundary, records its campaign and idempotency linkage in the browser save, and resumes the same durable job after a reload. A model switch changes the next provider request but does not change the authoritative campaign snapshot sent to it. When that campaign enables Nexus illustrations, the player follows the independent image child job and displays the stored asset without calling the legacy browser image provider.

Stop the containers without deleting data:

```powershell
docker compose down
```

Delete the local database and asset volumes only when intentionally starting over:

```powershell
docker compose down --volumes
```

## Import an existing story

1. In the legacy app, use **Save Full Story** to produce a `.story` file.
2. Open `http://localhost:8080/nexus/`.
3. Select **Import current browser story** when the legacy save is detected, or choose the `.story` or JSON file.
4. Select **Import selected file** when using a portable file.
5. Select the resulting campaign to inspect history size and context construction.

The import is content-addressed. Importing the same content again returns the existing campaign. Provider keys are blanked before persistence and before the source hash is calculated.

Each imported turn produces:

- One canonical accepted-turn record containing the original narration.
- A private mechanics field for legacy RPG roll data.
- A private state snapshot for scratchpad and trackers.
- A fiction-only Chronicle record containing the action and sanitized narration.

Existing `fullHistory` data becomes a legacy summary checkpoint. It assists compressed context but never replaces the accepted-turn ledger.

## Chronicle context

The context-preview API builds controlled scopes:

1. Descriptive world canon.
2. Campaign identity and accepted-turn position.
3. Selected Chronicle memories.

The authoritative scopes include the World Library overview and rules, query-relevant versioned entities and relationships, current trackers, a validated fiction-only continuity scratchpad, the latest scene, the living campaign summary, current open threads, relevant facts/events, recent turns, and bounded chronological samples. Imported scratchpads stay private until a validated story turn replaces them.
4. The latest fiction-only current scene.

It excludes roll records, mechanics fields, private scratchpads, parser diagnostics, rejected output, and credentials.

Compression modes are:

- `full`: complete action and narration memories.
- `balanced`: complete actions with bounded older narration.
- `compact`: action and outcome excerpts.
- `summary`: the newest summary checkpoint plus recent and relevant turns.
- `auto`: the least compressed mode that fits the configured budget.

Useful endpoints:

```text
GET  /api/v1/campaigns
DELETE /api/v1/campaigns/:campaignId
GET  /api/v1/campaigns/:campaignId/turns
GET  /api/v1/campaigns/:campaignId/memory/metrics
GET  /api/v1/campaigns/:campaignId/memory/context-preview
POST /api/v1/campaigns/:campaignId/memory/reindex
GET  /api/v1/campaigns/:campaignId/memory/embedding-config
PUT  /api/v1/campaigns/:campaignId/memory/embedding-config
POST /api/v1/campaigns/:campaignId/memory/embeddings/reindex
GET  /api/v1/jobs/:jobId
POST /api/v1/imports/legacy-story
GET  /api/v1/providers
POST /api/v1/providers
GET  /api/v1/providers/:providerId/models
DELETE /api/v1/worlds/:worldId
DELETE /api/v1/worlds/:worldId/versions/:worldVersionId
POST /api/v1/campaigns/:campaignId/generations
GET  /api/v1/campaigns/:campaignId/sync-status
PUT  /api/v1/campaigns/:campaignId/player-config
GET  /api/v1/generation-jobs/:jobId
GET  /api/v1/generation-jobs/:jobId/result
POST /api/v1/generation-jobs/:jobId/retry
GET  /api/v1/campaigns/:campaignId/illustration-config
PUT  /api/v1/campaigns/:campaignId/illustration-config
GET  /api/v1/campaigns/:campaignId/image-jobs
POST /api/v1/turns/:turnId/illustrations
GET  /api/v1/image-jobs/:jobId
POST /api/v1/image-jobs/:jobId/retry
```

Example context query:

```text
/api/v1/campaigns/<id>/memory/context-preview?budgetTokens=128000&compression=auto&query=Marker%20One&recentTurns=8
```

## Development

Install dependencies and verify the code:

```powershell
pnpm install
pnpm check:data
pnpm check
pnpm test
pnpm build
```

Run integration tests against a PostgreSQL 18 database with pgvector:

```powershell
$env:TEST_DATABASE_URL = "postgresql://infinitequest:password@localhost:5432/infinitequest_test"
pnpm test:integration
```

The default Compose stack does not expose PostgreSQL. Copy `compose.override.example.yaml` to `compose.override.yaml` when direct host access is required for development.

The deterministic integration suites use mock compatible endpoints and verify full database context, typed private RPG assessment, fiction-only consequence handoff, before/after triggers, persisted-roll reuse after recovery, compact truncation recovery, mechanics cleanup, committed-result retrieval, unchanged campaign state after unrecoverable responses, fresh-vector indexing, hybrid ranking, and lexical fallback when embeddings are unavailable. The Docker build stage includes tests so it can be run on the Compose network without publishing PostgreSQL.

World Library integration coverage additionally verifies immutable published versions, optimistic draft conflicts, explicit campaign migration records, campaign story-length persistence and export, cross-world isolation, fork provenance, idempotent world import, editable drafts for legacy imports, and exports that omit provider configuration and credentials.

Runtime roles use the same image:

```text
APP_ROLE=all       web/API and worker in one process
APP_ROLE=api       web/API replica; coordinates automatic migrations before becoming ready
APP_ROLE=worker    durable worker; waits for the API-coordinated schema version
APP_ROLE=migrate   recovery/maintenance command that applies migrations and exits
```

Migration files are ordered SQL under `database/migrations`. `node-pg-migrate` records their application in `schema_migrations`, wraps pending work in a transaction, and uses a PostgreSQL advisory lock so only one API replica changes the schema. Files ending in `.maintenance.sql` are treated as destructive or downtime-requiring changes: they apply automatically to a new empty database, but an existing database requires `ALLOW_MAINTENANCE_MIGRATIONS=true` or the explicit `migrate` role after a verified backup.

## Local data and backups

Compose stores database and asset data in named volumes. Inspect them with:

```powershell
docker volume ls --filter name=infinitequest
```

Create a database backup:

```powershell
docker compose exec -T postgres pg_dump -U infinitequest -d infinitequest -Fc > infinitequest.backup
```

Test restoration into a separate database before relying on a backup procedure. Accepted turns and world versions are authoritative; Chronicle memories and embeddings are rebuildable.

## Docker Swarm

The stack file is `deploy/swarm/stack.yaml`. It contains no PostgreSQL service. The external database must be PostgreSQL 18.4 with pgvector and must be reachable from every eligible node.

Prepare the CephFS-backed asset directory on every node:

```bash
mkdir -p /srv/docker/appdata/infinite-quest-nexus/assets
chown 10001:10001 /srv/docker/appdata/infinite-quest-nexus/assets
```

Create the external database URL secret without putting it in shell history where possible:

```bash
printf '%s' 'postgresql://USER:PASSWORD@DATABASE_HOST:5432/DATABASE' | docker secret create infinitequest_database_url -
printf '%s' 'A-LONG-RANDOM-CREDENTIAL-ENCRYPTION-KEY' | docker secret create infinitequest_credential_encryption_key -
```

Deploy the stack:

```bash
export NEXUS_IMAGE=ghcr.io/cmacnichol/infinite-quest-nexus:VERSION
docker stack deploy -c deploy/swarm/stack.yaml infinitequest
```

The default stack runs two API replicas and two worker replicas. On a new database, the first API replica holding the PostgreSQL advisory lock creates the complete schema and initial owner. On normal upgrades, it applies pending online migrations before becoming ready; the other API replicas wait on the same lock, and workers wait until no migrations are pending. API state, worker leases, and job results are stored in PostgreSQL; no sticky session is required.

A migration named with the `.maintenance.sql` suffix intentionally blocks normal startup on an existing database. This is reserved for reviewed major upgrades that require a backup, downtime, or destructive schema work. Run those migrations explicitly with the same image's `APP_ROLE=migrate` recovery command or temporarily set `ALLOW_MAINTENANCE_MIGRATIONS=true` during the controlled rollout, then remove the override.

## Container publishing

The intended public image is:

```text
ghcr.io/cmacnichol/infinite-quest-nexus
```

The repository workflows validate the TypeScript project, migrations, PostgreSQL integration, Compose/Swarm configuration, and image build. Published GitHub releases build and push semantic-version, commit-SHA, and stable `latest` tags. Deployment to Swarm remains an explicit operation.

## Security notes

- Run `pnpm check:data` before committing. It rejects local story saves/exports, backups, non-example environment files, private-key files, high-confidence credential patterns, and story-shaped JSON outside the named synthetic fixture area. It reports paths and rule names without printing matched content.
- The service currently binds every request to the database-backed `initial-owner`; this is not authentication.
- Restrict the service to the trusted network until login or OIDC is implemented.
- The legacy community OpenRouter key has been removed. Users must provide their own provider key.
- Imported provider credentials are never persisted as campaign settings.
- Provider API keys are AES-256-GCM encrypted in PostgreSQL; the master key comes from `CREDENTIAL_ENCRYPTION_KEY` or its file-based secret and must be backed up separately.
- Text-provider credentials are not shared with the independently configured image provider.
- Rejected and incomplete generation output is retained only in private operational attempt records and never enters accepted turns or Chronicle memory.
- Do not commit `.env`, `.story` exports, database dumps, or provider keys.

## AI-assisted development

AI tools were used in the creation and ongoing development of Infinite Quest Nexus, including assistance with design exploration, implementation, testing, debugging, and documentation. AI-assisted contributions are reviewed and validated before they are accepted into the project.

## Next implementation milestones

1. Database-backed editing revisions, undo branches, richer recovery controls, the deferred [selective Infinite Worlds campaign update workflow](docs/operations/deferred-improvements.md#update-an-existing-campaign-from-an-infinite-worlds-story-txt-export), and [safe durable story streaming](docs/operations/deferred-improvements.md#stream-provisional-story-narration-during-generation).
2. OIDC identities linked to the existing initial owner without changing content ownership.
3. Production metrics, backup/restore verification, and staged Swarm rollout automation.
