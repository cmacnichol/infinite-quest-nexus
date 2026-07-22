# Infinite Quest Nexus

[![CI](https://github.com/cmacnichol/infinite-quest-nexus/actions/workflows/ci.yml/badge.svg)](https://github.com/cmacnichol/infinite-quest-nexus/actions/workflows/ci.yml)
[![Documentation](https://github.com/cmacnichol/infinite-quest-nexus/actions/workflows/docs.yml/badge.svg)](https://github.com/cmacnichol/infinite-quest-nexus/actions/workflows/docs.yml)
[![AI Assisted](https://img.shields.io/badge/AI-Assisted-7c3aed?style=flat-square)](#ai-assisted-development)

Infinite Quest Nexus is a self-hosted platform for creating reusable, versioned story worlds and running persistent AI-assisted campaigns. PostgreSQL preserves worlds, immutable world versions, campaigns, accepted turns, state, and Chronicle memory independently of a browser session or model context window.

The player-facing experience is **Infinite Quest**. The management platform is **Infinite Quest Nexus**, organized around World Library, Campaigns, Chronicle, and Story Engine.

## Current status

The repository contains a production-shaped pre-authentication deployment for a trusted network. It includes:

- A database-backed World Library and campaign manager
- The Infinite Quest player experience
- Durable, validated Story Engine jobs and recovery
- Campaign-scoped Chronicle memory and optional embeddings
- Independent text, embedding, and illustration provider profiles
- A two-container local Compose deployment
- Separate API and worker roles for Docker Swarm

See the [current capabilities](docs/reference/capabilities.md) for the complete implemented feature set.

## Start locally

Requirements:

- Docker Desktop with Linux containers and the Compose plugin
- At least 2 GB of available memory
- A reachable compatible text provider when you are ready to generate a story

Create the local configuration file and replace the example values:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set a database password and a long random `CREDENTIAL_ENCRYPTION_KEY`. The encryption key is required before Nexus can safely store provider credentials.

Start the application and PostgreSQL:

```powershell
docker compose up --build
```

Open:

- Nexus World Management: `http://localhost:8080/nexus/`
- Infinite Quest player: `http://localhost:8080/story`
- Readiness check: `http://localhost:8080/health/ready`
- Application metadata: `http://localhost:8080/api/v1/meta`

Requests to `/` or `/index.html` redirect permanently to the active Nexus application at `/nexus/`.

The Nexus header displays the application release version. Published container images also expose their source commit and build timestamp in the player view's **About Infinite Quest Nexus** dialog. World versions, database migrations, export formats, and prompt protocols retain their own independent version numbers.

The first startup creates the database schema and credential-free initial owner. Configure a text provider in **Providers**, create or import a world, publish a version, create a campaign, and select **Load story**.

Stop the containers while preserving the database and generated assets:

```powershell
docker compose down
```

> [!WARNING]
> `docker compose down --volumes` permanently removes both the local PostgreSQL data and generated asset volumes unless they were backed up separately.

## Documentation

The [published documentation](https://cmacnichol.github.io/infinite-quest-nexus/) is built with VitePress from the source under [`docs/`](docs/index.md). It includes:

- Getting Started and player guides
- World Library, Campaigns, Chronicle, and provider workflows
- Installation and operational procedures
- Architecture concepts and accepted decision records
- Documentation contribution rules

Run the documentation site locally:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @infinite-quest/docs dev
```

Maintainers can follow the [GitHub Pages publishing guide](docs/contributing/github-pages.md) to enable, verify, or troubleshoot documentation deployment.

## Development

Source-level development requires Node.js 22.13 or newer and pnpm 11.14.0.

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

Integration tests require PostgreSQL with pgvector. The application and documentation have separate CI build checks.

The active code is organized under:

```text
apps/web/             browser client
services/api/         HTTP API and management services
services/worker/      durable Story Engine and Chronicle work
packages/contracts/   shared validated payloads
packages/domain/      world and campaign rules
packages/story-engine prompt, provider, mechanics, and memory logic
database/migrations/  ordered PostgreSQL migrations
deploy/swarm/         replicated deployment manifest
docs/                 guides, concepts, operations, and ADRs
```

The root `index.html` is retained only as an unshipped historical reference. It is not copied into the application image, served by the API, or kept in parity with the active application.

## Security

Interactive authentication and OIDC are not implemented yet. The server resolves requests to the database-backed `initial-owner`; browser-supplied identity values are not authorization. Restrict the web/API surface and provider endpoints to the intended trusted network.

Keep these values separate and out of source control:

- Database credentials
- Credential-encryption key
- Text-provider credentials
- Embedding-provider credentials
- Image-provider credentials
- Private campaign exports and database backups

Provider profiles, imported content, rendered model output, and generated Markdown or HTML are untrusted input. See the documentation security and operations sections before exposing or operating a deployment.

## AI-assisted development

This project is developed with AI assistance. All changes remain subject to repository review, automated tests, architecture rules, and human approval.
