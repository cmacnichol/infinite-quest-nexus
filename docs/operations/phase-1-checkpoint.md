# Phase 1 checkpoint

Phase 1 establishes the publishable, database-backed baseline for Infinite Quest Nexus. This checkpoint records behavior and verification without retaining runtime campaigns, generated fiction, credentials, provider responses, or database contents in the repository.

## Delivered baseline

- One application image supports `all`, `api`, `worker`, and `migrate` roles.
- Local Compose runs the application and PostgreSQL 18 with pgvector.
- The Swarm manifest separates replicated API and worker services and uses external PostgreSQL configuration.
- Ordered migrations create the initial owner, world/campaign ownership, append-only accepted turns, durable jobs, typed private orchestration, and semantic Chronicle indexes.
- Portable imports create database-owned worlds, immutable versions, campaigns, turns, state, and rebuildable memory.
- Each story request is bootstrapped from the authoritative database snapshot. A provider response chain is only a scoped optimization.
- LM Studio model discovery uses an already-loaded instance and its advertised context length without requesting a duplicate load.
- Chronicle retrieval supports campaign-scoped lexical and semantic ranking, configurable history budgets, compression previews, and rebuild jobs.
- Invalid, truncated, and mechanics-contaminated model output cannot mutate accepted turns or Chronicle memory. Recovery reuses persisted private orchestration state.
- Repository and container-publish workflows reject likely secrets, local saves, exports, backups, and story-shaped JSON outside the named synthetic fixture area.

## Verification performed

The local checkpoint was verified with:

```powershell
pnpm check:data
pnpm check
pnpm test
pnpm build
pnpm test:integration
docker compose config --quiet
docker stack config -c deploy/swarm/stack.yaml
docker build --tag infinitequest-nexus:phase1 .
```

The PostgreSQL integration suite runs against an isolated database with the same PostgreSQL major version and pgvector extension as Compose. It verifies imports, ownership, Chronicle rebuilds, semantic and lexical retrieval, typed private mechanics, event handling, output-limit recovery, retry safety, mechanics cleanup, and unchanged canonical state after rejected output.

A live local LM Studio smoke test also verified:

- loaded-instance discovery and advertised context selection;
- text generation from a complete database snapshot through a fresh provider profile;
- embedding indexing and hybrid retrieval;
- schema-guided repair after a recoverable response;
- application restart while a generation is in flight;
- lease reclamation by the replacement worker and exactly-once accepted-turn insertion;
- automatic embedding of the accepted turn;
- no mechanics language in accepted fiction; and
- no duplicate text-model instance across calls, profile switching, or restart.

## Data-safety boundary

Runtime database volumes, backups, logs, local environment files, provider credentials, model responses, imported worlds, campaign saves, and generated story content are deployment data and are not repository artifacts. The only portable story-shaped JSON permitted by the automated check is the explicitly named synthetic regression fixture under `tests/fixtures`.

Run `pnpm check:data` immediately before staging and again against the staged tree. The check reports only file paths and rule categories; it never prints matched credential values.

## Next checkpoint

The next phase can deepen the World Library and campaign-management UI, introduce independently configured image-generation jobs, and add production operations such as metrics, backup/restore drills, and Swarm rollout validation. These additions must preserve the Phase 1 ownership, memory, idempotency, and data-separation contracts.
