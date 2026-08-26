# Back up and restore Nexus

## Complete recovery set

A useful backup requires three coordinated components:

1. PostgreSQL, containing authoritative worlds, campaigns, turns, state, and jobs
2. Generated asset storage, containing image files referenced by the database
3. The original credential-encryption key, stored separately and securely

Database-only recovery loses generated files. Database and assets without the original key leave stored provider credentials unreadable.

## Recovery Set versus System Archive

These are separate products with different restore contracts:

| | Operator Recovery Set | System Archive |
| --- | --- | --- |
| Goal | Recover the same installation and its exact operational state after loss. | Move one Current Owner's portable application data to another compatible installation. |
| Contents | Coordinated PostgreSQL, Original Asset storage, application/migration/environment inventory, and separately escrowed credential-encryption material. | Versioned logical worlds, campaigns, accepted history/state, portable settings, and all retained originals. |
| Secrets and access | The operator preserves required encryption material and deployment authority under separate custody. | Credentials, encryption material, sessions, share capabilities, OIDC bindings, and deployment configuration are excluded. |
| Destination | Isolated empty storage with a matching or explicitly compatible application/PostgreSQL/extensions environment. | An initialized, fully migrated installation with its generated initial owner and no authoritative owner data. |
| Compatibility | Restore exact storage first, then use normal reviewed application migrations. | Logical payload adapters handle supported archive versions; it never executes SQL or source migrations. |

A System Archive is unencrypted and cannot recover encrypted provider credentials or exact jobs, leases, model chains, vectors, chunks, thumbnails, host policy, or deployment state. It does not replace this Recovery Set. Conversely, a Recovery Set is not the supported cross-version owner-portability format. See [System data transfer](../nexus-guide/operations/system-data-transfer.md).

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
The repository does not yet automate or certify this complete restore drill. Treat these steps as the required operator runbook and record an environment-specific successful restore before relying on the backup for production recovery. A successful System Archive import is not evidence that this disaster-recovery drill passed.
:::
