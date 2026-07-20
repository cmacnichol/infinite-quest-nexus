# ADR 0009: Automatic coordinated schema migrations

## Status

Accepted.

## Decision

Infinite Quest Nexus uses pinned `node-pg-migrate` for initial PostgreSQL schema creation and future ordered schema changes. The local combined application role and Swarm API replicas run the migration check before starting the API. `node-pg-migrate` uses a PostgreSQL advisory lock in wait mode, so one replica applies pending migrations and concurrent replicas continue only after the schema is current.

Worker-only replicas never apply schema changes. They use the same migration inventory in dry-run mode and wait with a bounded timeout until no migrations are pending. API readiness is unavailable until its migration check succeeds; worker processing does not begin until schema verification succeeds.

Migration files use ordered SQL under `database/migrations`, and `schema_migrations` is owned by `node-pg-migrate`. Online migrations are applied automatically. Files whose migration names end in `.maintenance` are reserved for destructive, long-running, or downtime-requiring changes. They apply automatically when the migration history is empty so a new installation always reaches the latest schema, but require the explicit migrate role or `ALLOW_MAINTENANCE_MIGRATIONS=true` on an existing database.

The explicit `APP_ROLE=migrate` command remains available for CI, recovery, and controlled maintenance upgrades, but normal Compose and Swarm installations do not deploy a dedicated migration service.

## Consequences

- Normal installation and online upgrades require no migration command from the user.
- Compose has only the application and PostgreSQL containers in steady state.
- Swarm replicas coordinate through PostgreSQL rather than process-local state or deployment ordering.
- Applied migration files are immutable; corrections are new forward migrations.
- Rolling releases must prefer backward-compatible expand/contract schema changes.
- A maintenance migration deliberately stops normal startup until an operator has backed up the authoritative database and opted in.
