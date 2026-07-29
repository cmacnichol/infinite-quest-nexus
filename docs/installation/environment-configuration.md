# Effective runtime configuration

The application supports the following runtime settings, but a deployment manifest must explicitly pass them into the container.

| Setting | Default | Purpose |
| --- | --- | --- |
| `APP_ROLE` | `all` | `all`, `api`, `worker`, or `migrate` |
| `APP_HOST` | `0.0.0.0` | API bind address |
| `APP_PORT` | `8080` | Container listen port |
| `DATABASE_URL` / `_FILE` | Required | PostgreSQL connection secret |
| `DATABASE_MAX_CONNECTIONS` | 12 API/all, 8 worker | Per-process pool maximum |
| `MIGRATION_DIRECTORY` | `database/migrations` | Ordered migration directory |
| `MIGRATION_WAIT_SECONDS` | `120` | Worker/schema wait bound |
| `ALLOW_MAINTENANCE_MIGRATIONS` | `false` | Existing-database maintenance opt-in |
| `WORKER_POLL_INTERVAL_MS` | `2000` | Durable queue polling interval |
| `WORKER_LEASE_SECONDS` | `60` | Job lease duration |
| `WEB_ROOT` | `apps/web/public` | Active web assets |
| `ASSET_STORAGE_ROOT` | `local-data/assets` | Filesystem asset root |
| `CREDENTIAL_ENCRYPTION_KEY` / `_FILE` | Empty | Provider-key encryption secret |
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated browser origins |
| `API_DEFAULT_BODY_LIMIT_BYTES` | `1048576` | Default request-body limit in bytes |
| `API_IMPORT_BODY_LIMIT_BYTES` | `2147483648` | Import request and multipart field/file limit in bytes (2 GiB) |
| `API_ASSET_BODY_LIMIT_BYTES` | `33554432` | Asset request-body limit in bytes |

Direct secret environment values take precedence over `_FILE` values.

World-generation progress is stored as short-lived, owner-scoped PostgreSQL state so API replicas can serve polling requests interchangeably. Generation logs record operational metadata but omit prompt bodies, imported lore, raw model output, private reasoning, and credentials.

::: warning Compose-effective values
The root `compose.yaml` currently passes fixed role, container port, constructed database URL, asset root, and credential-encryption key. Host `APP_PORT` changes only the published host port. Other values listed in `.env.example`, including log level, worker interval, migration wait, and maintenance opt-in, are not automatically injected into the Compose application container. Add an explicit reviewed Compose override before claiming those values are effective.
:::
