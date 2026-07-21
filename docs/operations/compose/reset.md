# Reset a local Compose installation

::: danger Permanent data loss
This procedure deletes the local PostgreSQL and generated-asset volumes. Recovery is possible only from a separately verified database, asset, and encryption-key backup set.
:::

1. Confirm the resolved Compose project is `infinitequest`.
2. Export any portable worlds or campaigns you need.
3. Verify the complete backup set and restore location.
4. Run:

```powershell
docker compose down --volumes
```

5. Run `docker volume ls --filter label=com.docker.compose.project=infinitequest` and confirm only the intended volumes were removed.
6. Start again with `docker compose up --build`; Nexus initializes a new database and new initial-user UUID.
