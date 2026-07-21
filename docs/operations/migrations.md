# Database migrations

Migrations are ordered under `database/migrations/` and recorded in `schema_migrations`.

## Role behavior

- `all` and `api` acquire migration coordination and apply pending online work before serving.
- `worker` verifies migration inventory and waits for the current schema without applying it.
- `migrate` applies pending migrations, including explicitly approved maintenance work, then exits.

PostgreSQL advisory locking and node-pg-migrate coordination serialize changes across replicas. Applied migration files are forward-only history and must not be edited.

## Maintenance migrations

Files ending `.maintenance.sql` require special handling on an existing database. Normal startup stops unless operator opt-in is effective; a new empty database may apply them during initialization.

Before opting in:

1. Review the migration and downtime requirements.
2. Create and verify a complete backup set.
3. Confirm application-version compatibility.
4. Schedule the maintenance window.
5. Use the explicit migrate role or an effective `ALLOW_MAINTENANCE_MIGRATIONS=true` deployment setting.
