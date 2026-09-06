# Reset a local Compose installation

::: danger Permanent data loss
This procedure deletes all four local volumes: PostgreSQL, generated assets, archive staging/downloads, and the generated credential-encryption key. Recovery requires a separately verified Recovery Set containing the database, assets, compatible application/configuration inventory, and original encryption key. Download any completed portable exports you intend to keep before removing archive storage.
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
