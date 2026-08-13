# Repository Overview

Descriptive project context extracted from `AGENTS.md` during the 2026-08-01 instruction-file migration (see `AGENT_INSTRUCTIONS_AUDIT.md` in `~/repos`). This is background/context, not enforceable instruction — the load-bearing rules stayed in `AGENTS.md`.

## Product domains

The product domains are:

- **World Library**: author, import, export, fork, version, publish, archive, and browse reusable worlds.
- **Campaigns**: run isolated, evolving stories from an immutable world version.
- **Chronicle**: retain accepted turns, canonical facts, state snapshots, summaries, and searchable long-term memory.
- **Story Engine**: coordinate mechanics assessment, prompt construction, LM Studio generation, validation, recovery, and memory indexing.
- **Illustration Pipeline**: optionally turn validated fiction-only image prompts into campaign artwork through a separately configured compatible endpoint.

The legacy `index.html` application no longer needs to be kept in parity with the new application (`apps/web`). It is kept for reference only now.

## Naming

Use **Infinite Quest Nexus** for the platform and **Infinite Quest** for the player-facing story experience. Use the domain names World Library, Campaigns, Chronicle, and Story Engine in UI and architecture documentation.

Deployment names, unless an infrastructure constraint requires otherwise:

- `infinitequest-app` for the combined local Compose role
- `infinitequest-web`
- `infinitequest-api`
- `infinitequest-worker`

Use `infinitequest` as the Docker stack name and as the prefix for related networks, configs, and secrets.

## Target architecture

Infinite Quest Nexus is a server-backed application packaged for both local Docker Compose and Docker Swarm deployment:

1. **Web client**: serves the browser UI and communicates only with the Nexus API for authoritative operations.
2. **API service**: owns the request identity context, future authentication boundary, world and campaign APIs, validation, job submission, model inventory, and live generation status. API replicas must be stateless. Until login or OIDC exists, the API resolves every request to the database-backed initial user rather than trusting a browser-supplied user identifier.
3. **Worker service**: performs LM Studio requests, recovery, summarization, embeddings, retrieval, and other durable background work.
4. **PostgreSQL database**: the authoritative store for users, worlds, immutable world versions, campaigns, accepted turns, state, memories, jobs, and model-chain metadata. Local Compose starts a dedicated PostgreSQL container. Swarm uses the existing dedicated database infrastructure and must not deploy its own database service.
5. **Text and embedding endpoint**: LM Studio remains an external inference service reached through a stable private-network DNS name. It supplies story models and embedding models but is never the authoritative memory store.
6. **Optional image endpoint**: a second compatible endpoint supplies image-capable model discovery and generation. Configure it independently from LM Studio and do not route image requests through the text endpoint unless a future provider profile explicitly supports and selects both roles.
7. **Vector search**: prefer the existing database's supported vector capability. Add a dedicated vector service only when the database cannot meet measured retrieval requirements.

(The instruction derived from this — storing credentials as separate secrets, never assuming `host.docker.internal` — remains in `AGENTS.md`.)

## Repository structure

The repository contains the legacy self-contained client for reference only:

- `index.html`: legacy self-contained Infinite Quest application, kept for reference only and no longer kept in parity with the new application (`apps/web`).
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

## Development and migration roadmap

To inspect the legacy client directly without the full backend stack, serve it statically:

```powershell
python -m http.server 8000
```

Open `http://localhost:8000/index.html` to view the legacy client (kept for reference only). For the active application and API, run the containerized stack or local development services as documented in the root README.

The future baseline commands should support `docker compose up --build` for local startup and `docker stack deploy` for Swarm using the same built image. Validate both rendered configurations in CI before deployment.

Migrate incrementally:

1. Serve the existing UI and proxy LM Studio through the API.
2. Add World Library, immutable world versions, campaigns, and a browser-save importer.
3. Move prompt construction, generation, validation, and recovery into the worker.
4. Add Chronicle indexing, structured memory, embeddings, and retrieval.
5. Add multi-replica hardening, migrations, monitoring, backup verification, and rolling deployment policy.

Keep JSON import and export as a portable backup and migration format even after the database becomes authoritative.

> **Note (2026-08-01 migration check):** this roadmap is about legacy-client-to-new-app migration phases (steps 1–5 above). It does not overlap with `docs/review/2026-07-30-implementation-plan.md`, which is a separate, unrelated 7-phase security/reliability remediation plan. Both documents are current and neither supersedes the other.
