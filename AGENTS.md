# Infinite Quest Nexus Repository Guidelines

## Project Goal

Infinite Quest Nexus is a self-hosted platform for creating reusable, versioned story worlds and running persistent AI-assisted campaigns within them. The platform must preserve authoritative world and campaign state independently of any LLM context window, model instance, browser session, or LM Studio response chain.

Text generation and image generation must be independent provider concerns. Story text uses the configured text-LLM endpoint, while optional illustrations use a separately configured compatible image endpoint with its own base URL, credentials, model inventory, selected model, health state, and retry policy. Never assume that the text endpoint also serves images or automatically reuse its credentials. A missing or unavailable image endpoint must disable or defer illustration work without preventing story generation.

The product domains are:

- **World Library**: author, import, export, fork, version, publish, archive, and browse reusable worlds.
- **Campaigns**: run isolated, evolving stories from an immutable world version.
- **Chronicle**: retain accepted turns, canonical facts, state snapshots, summaries, and searchable long-term memory.
- **Story Engine**: coordinate mechanics assessment, prompt construction, LM Studio generation, validation, recovery, and memory indexing.
- **Illustration Pipeline**: optionally turn validated fiction-only image prompts into campaign artwork through a separately configured compatible endpoint.

The existing `index.html` application is the migration baseline and initial web client. Preserve its working experience while moving authoritative state and generation orchestration into backend services incrementally.

Do not embed sample worlds, campaign records, accepted turns, story history, imported lore, or other user content in `index.html` or application source. Runtime world and campaign data belongs in the authoritative database; sanitized regression content belongs only in test fixtures. Legacy exports may be imported through explicit migration code but must not be silently bundled or restored by the client.

## Naming

Use **Infinite Quest Nexus** for the platform and **Infinite Quest** for the player-facing story experience. Use the domain names World Library, Campaigns, Chronicle, and Story Engine in UI and architecture documentation.

Use these deployment names unless an infrastructure constraint requires otherwise:

- `infinitequest-app` for the combined local Compose role
- `infinitequest-web`
- `infinitequest-api`
- `infinitequest-worker`

Use `infinitequest` as the Docker stack name and as the prefix for related networks, configs, and secrets.

## Target Architecture

Infinite Quest Nexus is a server-backed application packaged for both local Docker Compose and Docker Swarm deployment:

1. **Web client**: serves the browser UI and communicates only with the Nexus API for authoritative operations.
2. **API service**: owns the request identity context, future authentication boundary, world and campaign APIs, validation, job submission, model inventory, and live generation status. API replicas must be stateless. Until login or OIDC exists, the API resolves every request to the database-backed initial user rather than trusting a browser-supplied user identifier.
3. **Worker service**: performs LM Studio requests, recovery, summarization, embeddings, retrieval, and other durable background work.
4. **PostgreSQL database**: the authoritative store for users, worlds, immutable world versions, campaigns, accepted turns, state, memories, jobs, and model-chain metadata. Local Compose starts a dedicated PostgreSQL container. Swarm uses the existing dedicated database infrastructure and must not deploy its own database service.
5. **Text and embedding endpoint**: LM Studio remains an external inference service reached through a stable private-network DNS name. It supplies story models and embedding models but is never the authoritative memory store.
6. **Optional image endpoint**: a second compatible endpoint supplies image-capable model discovery and generation. Configure it independently from LM Studio and do not route image requests through the text endpoint unless a future provider profile explicitly supports and selects both roles.
7. **Vector search**: prefer the existing database's supported vector capability. Add a dedicated vector service only when the database cannot meet measured retrieval requirements.

Store database credentials, text-endpoint tokens, image-endpoint tokens, and other credentials as separate Docker Swarm secrets. Store non-sensitive endpoint and runtime settings in Swarm configs or environment configuration. Do not assume `host.docker.internal` is available from Swarm nodes.

## Compose and Swarm Deployment Modes

Build one versioned Nexus application image and use the same runtime configuration contract in both deployment modes. Do not create Compose-only application logic or a separate local implementation. The image should expose explicit roles such as `all`, `api`, `worker`, and `migrate` through its entrypoint or command.

The default local `compose.yaml` steady state contains two containers:

1. **`infinitequest-app`**: runs the web/API and worker roles together for simple local development and testing.
2. **`postgres`**: runs the pinned PostgreSQL major version and required extensions with a health check and named persistent volume.

The application must connect to PostgreSQL through the Compose service name, retry database readiness with bounded backoff, and expose application liveness and readiness checks. Do not rely solely on startup ordering. Do not publish the PostgreSQL port to the host by default; add an explicit development override when direct database access is needed.

The Swarm stack uses the same application image but runs API and worker roles as separate services so they can scale and roll independently. It receives the external PostgreSQL connection through Swarm secrets/configuration and contains no `postgres` service. Static web assets may be served by the API service or an explicitly introduced web service, but this choice must not change API contracts or persistence behavior.

Use `node-pg-migrate` from the same application image. The combined Compose role and every Swarm API replica run the standard migration check before serving traffic; PostgreSQL advisory locking serializes schema changes so exactly one replica applies pending work while the others wait. Worker-only replicas verify and wait for the current schema rather than applying migrations. A new database is initialized automatically, including the initial user. Online migrations apply automatically; migrations explicitly named with the `.maintenance.sql` suffix require a reviewed backup and operator opt-in on an existing database.

Keep local PostgreSQL compatible with the Swarm database: pin the same supported major version, enable the same required extensions, apply the same migrations, and test the same transaction and isolation behavior. If vector search uses a PostgreSQL extension, include the same extension and version in both environments.

Maintain separate deployment manifests where orchestrator behavior differs:

- Root `compose.yaml` for the two-container local environment.
- Optional `compose.override.yaml` for developer-only ports or mounts.
- `deploy/swarm/stack.yaml` for replicated services, configs, secrets, health checks, placement, updates, and rollback policy.

Compose credentials may come from an ignored local environment/secrets file with a committed redacted example. Swarm credentials must use Swarm secrets. The application should support file-based secret inputs so the same image can consume either mechanism without placing credentials in image layers or source control.

## Domain and Persistence Rules

Keep these concepts distinct:

- A **world** is a reusable authored project.
- A **world version** is an immutable snapshot of its lore, rules, entities, relationships, triggers, assets, and defaults.
- A **campaign** is a mutable story instance created from one world version.
- A **turn** is append-only after acceptance.
- **Campaign state** contains the current mutable facts produced by accepted turns.
- **Derived memory** contains embeddings and summaries that can be rebuilt from authoritative data.

Editing a world must not silently alter existing campaigns. Moving a campaign to a newer world version requires an explicit migration. Campaign discoveries may be promoted into a new world draft only through an explicit, reviewable action.

Every campaign-owned row and memory record must be scoped by `campaign_id`; reusable canon must be scoped by `world_id` and `world_version_id`. Retrieval must never cross these boundaries accidentally.

## User Identity and Future Authentication

Design ownership now even though interactive login and OIDC are deferred. Use a stable, non-semantic internal UUID `user_id` as the application identity. Never use an email address, display name, username, OIDC `sub`, or provider-specific identifier as a primary or foreign key.

The first database migration must idempotently create one credential-free **initial user** identified by a stable system key such as `initial-owner`. The database generates and retains its UUID; every API and worker replica looks it up by that system key. Until authentication is implemented, the server assigns all created, generated, and imported content to this initial user. Do not accept an arbitrary `user_id` header, query value, or request field from the browser as proof of identity.

User-owned root records must have a non-null `owner_user_id`, including worlds, world versions where ownership is materialized, campaigns, assets, provider profiles, and imports. Operational and retrieval records such as memories, generation jobs, image jobs, and model chains must carry or reliably derive the same user scope so queries cannot cross ownership boundaries. Turns and other children must remain protected through their campaign relationship and database constraints.

Plan for these identity tables and constraints:

```text
users
  id UUID primary key
  system_key unique nullable
  display_name
  status
  created_at / updated_at

user_identities                added when authentication is implemented
  id UUID primary key
  user_id foreign key -> users.id
  provider
  issuer
  subject
  unique (issuer, subject)
```

OIDC identities must link to the internal user rather than replace it. When authentication is introduced, use an explicit administrative claim or configured migration to attach the intended OIDC `(issuer, subject)` to the existing initial user. Do not automatically grant all legacy content to whichever account happens to log in first. After the link succeeds, the same internal `user_id` continues to own all existing content without rewriting world, campaign, turn, or memory ownership.

Legacy browser saves and portable exports do not establish authorization. During the pre-auth phase, imports belong to the initial user. After authentication exists, imports belong to the authenticated user unless an administrator explicitly performs an ownership migration. Export formats may contain provenance but must not rely on a source-system `user_id` being valid in another installation.

Keep repository, service, and database APIs user-scoped from their first implementation even when only one user exists. This provides a clean future path to authorization, sharing, collaborators, and database row-level policies without a broad ownership backfill.

## Story Memory Model

Build prompts from three controlled scopes:

1. **World canon**: relevant facts from the campaign's immutable world version.
2. **Campaign canon**: structured current state, open threads, and relevant accepted events from this campaign.
3. **Current scene**: the latest action, present entities, current location, trackers, and recent verbatim turns.

The complete accepted turn ledger is the recovery source of truth. Summaries and embeddings are derived indexes, not canonical records. Use hybrid retrieval that can combine semantic similarity, entity and keyword matches, recency, chronology, and open-thread relevance.

Treat LM Studio `previous_response_id` as a short-term continuation and caching optimization. Scope every response chain to the campaign, world version, model, LM Studio endpoint or instance, prompt protocol version, and context configuration. Never reuse a chain across campaigns or worlds. If a chain is missing or incompatible, bootstrap a new one from database state and retrieved Chronicle memory.

## Generation Integrity

Story generation must be a durable, idempotent workflow such as:

```text
queued -> assessing -> generating -> validating -> indexing -> committed
                                  \-> recoverable or failed
```

Only validated, accepted output may mutate campaign state. Use database transactions and uniqueness constraints to prevent duplicate next turns. Persist enough job and LM Studio response metadata to resume, retry, or safely discard incomplete work after a browser, service, or model restart.

Illustration generation must run as an optional child job after the associated narration and fiction-only image prompt have passed validation. Image success or failure must not change whether the story turn is accepted. Persist image job status independently so it can be retried, replaced, or disabled without rerunning the story turn. Never send rolls, private reasoning, scratchpads, hidden trackers, raw model responses, or rejected narration to the image endpoint.

Keep mechanics and fiction in separate typed prompt paths. Rolls, dice, checks, stats, scores, targets, modifiers, difficulty labels, parser diagnostics, rejected output, and internal reasoning must never enter story narration, story memory, embeddings, or fiction-only prompt history. The Story Engine may pass only a sanitized diegetic outcome to the narrative model. Continue validating narrative output for mechanic leakage before display or persistence.

## Repository Structure

The repository currently contains the legacy self-contained client:

- `index.html`: primary Infinite Quest application and migration reference.
- `demo_version.html`: smaller demonstration variant.

As the service is scaffolded, prefer this organization:

```text
compose.yaml             local two-container application and PostgreSQL stack
compose.override.example.yaml
apps/
  web/                 browser client
services/
  api/                 HTTP API and live job status
  worker/              Story Engine and Chronicle jobs
packages/
  contracts/           shared request, response, event, and schema definitions
  domain/              world, campaign, turn, and memory rules
  story-engine/        prompts, sanitization, parsing, validation, and recovery
database/
  migrations/          ordered relational schema migrations
deploy/
  swarm/               stack, config, health check, and rollout definitions
docs/
  architecture/        diagrams, ADRs, schemas, and operational guidance
tests/
  fixtures/            sanitized model responses and story regressions
```

Prefer TypeScript for new application services and shared packages so validated logic can move out of the current JavaScript without maintaining separate implementations. Record meaningful architecture changes as short ADRs under `docs/architecture/`.

## Development and Migration

No backend scaffold or package build currently exists. Until it does, serve the existing client with:

```powershell
python -m http.server 8000
```

Open `http://localhost:8000/index.html`. When introducing the application scaffold, document exact local, test, migration, container-build, and Swarm-deployment commands here and in the root README. Do not leave undocumented scripts as the only way to operate the project.

The future baseline commands should support `docker compose up --build` for local startup and `docker stack deploy` for Swarm using the same built image. Validate both rendered configurations in CI before deployment.

Migrate incrementally:

1. Serve the existing UI and proxy LM Studio through the API.
2. Add World Library, immutable world versions, campaigns, and a browser-save importer.
3. Move prompt construction, generation, validation, and recovery into the worker.
4. Add Chronicle indexing, structured memory, embeddings, and retrieval.
5. Add multi-replica hardening, migrations, monitoring, backup verification, and rolling deployment policy.

Keep JSON import and export as a portable backup and migration format even after the database becomes authoritative.

## Coding and Contract Conventions

Match the existing two-space indentation in the legacy HTML. Use `camelCase` for JavaScript and TypeScript values, `PascalCase` for types and components, and `UPPER_SNAKE_CASE` for constants. Prefer `const`; use `let` only for reassignment. Avoid wholesale formatting of `index.html`.

Define shared schemas for API payloads, database-derived events, model responses, and job states. Validate untrusted data at every boundary: browser to API, database to domain model, worker to LM Studio, and model output to accepted turn. Keep prompts versioned and make prompt-protocol changes explicit because they invalidate saved LM Studio chains.

Favor pure domain functions for state transitions, prompt assembly, retrieval ranking, and output sanitization. The API and worker should call the same shared implementations rather than duplicating rules.

## Testing Requirements

Until automated infrastructure exists, manually exercise startup, world and character selection, story generation, choice handling, model switching, output-limit recovery, save/load, import/export, and responsive layout.

New services should introduce:

- Unit tests for domain transitions, prompt sanitization, parser recovery, retrieval ranking, and context budgeting.
- Contract tests for browser/API, worker/text endpoint, worker/image endpoint, and database boundaries.
- Integration tests using a real test database and a deterministic mock LM Studio server.
- End-to-end tests for world creation, version publication, campaign switching, turn generation, restart recovery, and export/import.
- Regression fixtures for truncated output, malformed JSON, reasoning-only output, missing stateful responses, model switching, duplicate submissions, and RPG-mechanic leakage.

Tests must verify that rejected or incomplete generations do not mutate campaign state or Chronicle memory and that one campaign's data cannot appear in another campaign's prompt.
Tests must also cover images disabled, image endpoint unavailable, incompatible image models, independent image retries, and successful story completion when illustration generation fails.
Identity tests must verify initial-user bootstrap idempotency, automatic ownership of pre-auth content, import ownership, rejection of caller-supplied identity spoofing, cross-user query isolation, and explicit OIDC linking to the existing initial user without changing its internal UUID.

## Deployment and Operations

Swarm services must define health checks, resource expectations, restart behavior, and conservative rolling-update and rollback policies. API and worker replicas must coordinate through the database or an explicitly introduced durable queue; do not rely on process-local locks or memory for correctness.

Compose and Swarm must use the same schema migrations, initial-user bootstrap, provider configuration, job semantics, and API contracts. Add deployment smoke tests that start the two-container Compose environment, wait for PostgreSQL and application readiness, verify migrations and initial-user ownership, and exercise one database-backed API operation. Validate the Swarm stack configuration separately even when CI cannot launch a full multi-node swarm.

Use structured logs with correlation IDs for campaign, generation job, model request, and accepted turn. Record prompt size, retrieved-memory identifiers, context utilization, model and endpoint identity, recovery attempts, validation results, and latency without logging credentials, private reasoning, or unnecessary sensitive story content.

Database migrations must be ordered, repeatable, reviewed, and safe for the deployed application version. Prefer backward-compatible expand/contract changes so rolling API replicas can coexist. Applied online migrations are automatic; destructive or downtime-requiring `.maintenance.sql` migrations must remain exceptional and require an explicit operator opt-in on an existing database. Back up authoritative database data and test restoration. Treat embeddings and summaries as rebuildable unless operational requirements later make their backup worthwhile.

## Security

Never commit API keys, database credentials, exported private campaigns, or secrets. Until login or OIDC is implemented, restrict the web/API surface to the intended trusted network and consistently bind requests to the server-resolved initial user; this is a migration bridge, not authentication. Restrict text and image endpoints to trusted networks and allow only the API or worker paths that require them. Do not expose one provider's credentials to another provider or return either secret to the browser.

Treat imported worlds, rendered model output, prompt templates, MCP integrations, and generated HTML or Markdown as untrusted input. Preserve safe DOM rendering, schema validation, authorization checks, campaign/world ownership boundaries, and explicit tool allowlists. Do not allow an LLM or MCP tool to write authoritative world or campaign state without application validation and an auditable operation.

## Commit and Review Guidelines

Use short imperative commit summaries naming the affected domain or service. Keep schema, prompt-protocol, deployment, and unrelated UI changes in separate commits when practical. Pull requests must describe user-visible behavior, architecture impact, migration or rollback requirements, tests performed, and changes to models, prompts, schemas, secrets, or external APIs.

Before submitting, run the documented tests, check `git diff --check`, review the complete diff for unrelated changes, and include screenshots for visible UI changes.
