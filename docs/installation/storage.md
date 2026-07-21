# Storage layout

The Compose stack uses two named volumes:

| Volume | Container path | Content |
| --- | --- | --- |
| `infinitequest-postgres` | `/var/lib/postgresql` | Authoritative PostgreSQL cluster |
| `infinitequest-assets` | `/var/lib/infinitequest/assets` | Generated image assets |

PostgreSQL owns worlds, versions, campaigns, accepted turns, campaign state, jobs, and Chronicle records. The asset volume stores content-addressed raster files referenced by the database.

`docker compose down` preserves both volumes. A complete recovery set also requires the original credential-encryption key; database and assets alone cannot decrypt stored provider keys.

The example development override publishes PostgreSQL on host port 5432. Do not enable that port on an untrusted network.
