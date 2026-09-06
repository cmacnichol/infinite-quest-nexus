# Storage layout

The Compose stack uses four named volumes:

| Volume | Container path | Content |
| --- | --- | --- |
| `infinitequest-postgres` | `/var/lib/postgresql` | Authoritative PostgreSQL cluster |
| `infinitequest-assets` | `/var/lib/infinitequest/assets` | Original images and regenerable derivatives |
| `infinitequest-archives` | `/var/lib/infinitequest/archives` | Durable archive uploads, previews, temporary exports, and published downloads |
| `infinitequest-secrets` | `/var/lib/infinitequest/secrets` | Automatically generated local credential-encryption key |

PostgreSQL owns worlds, versions, campaigns, accepted turns, campaign state, jobs, and Chronicle records. The asset volume stores content-addressed raster files referenced by the database.

`docker compose down` preserves all four volumes. A complete recovery set also requires the original credential-encryption key; database and assets alone cannot decrypt stored provider keys. The generated key is stored at `/var/lib/infinitequest/secrets/credential-encryption-key`; escrow it separately and securely as described in [Backup and restore](../operations/backup-restore.md).

Archive staging and downloads are operational state with their own expiry. They do not replace retained originals or an operator Recovery Set. Monitor archive capacity as well as database and asset capacity. `docker compose down --volumes` deletes all four stores, including the generated key.

The example development override publishes PostgreSQL on host port 5432. Do not enable that port on an untrusted network.
