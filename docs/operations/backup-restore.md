# Back up and restore Nexus

## Complete recovery set

A useful backup requires three coordinated components:

1. PostgreSQL, containing authoritative worlds, campaigns, turns, state, and jobs
2. Generated asset storage, containing image files referenced by the database
3. The original credential-encryption key, stored separately and securely

Database-only recovery loses generated files. Database and assets without the original key leave stored provider credentials unreadable.

## Create a logical database backup

Example for the local Compose database:

```powershell
docker compose exec -T postgres pg_dump -U infinitequest -d infinitequest -Fc -f /tmp/infinitequest.dump
docker compose cp postgres:/tmp/infinitequest.dump ./infinitequest.dump
```

Copy the asset volume through an operator-approved volume-backup process and back up the encryption key outside the repository and outside the database dump.

## Restore drill

Restore into an isolated test environment, never over the only production copy. Restore PostgreSQL, restore the asset tree at the same logical root, supply the original encryption key, then verify:

- Readiness and migration inventory
- Initial-user UUID and ownership
- World and campaign counts
- Accepted-turn continuity
- Representative generated assets
- Provider credential decryption through a safe model-discovery check
- Chronicle rebuild from accepted history

::: warning Verification status
The repository does not yet automate or certify this complete restore drill. Treat these steps as the required operator runbook and record an environment-specific successful restore before relying on the backup for production recovery.
:::
