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
| `LEGACY_WEB_ROOT` | `apps/web/dist` | Built Nexus and Story Player assets served under `/nexus/` and `/story` |
| `NEXT_WEB_ROOT` | `apps/web-next/dist` | Built replacement application assets served under `/app/` |
| `ASSET_STORAGE_ROOT` | `local-data/assets` | Filesystem asset root |
| `ARCHIVE_STORAGE_ROOT` | `local-data/archives` | Private durable staging/export root for portable archives |
| `CREDENTIAL_ENCRYPTION_KEY` / `_FILE` | Empty | Provider-key encryption secret |
| `CORS_ALLOWED_ORIGINS` | Empty | Comma-separated exact browser origins; empty permits local same-origin access only |
| `PROVIDER_NETWORK_ALLOWLIST` | Loopback only | Comma-separated provider hostnames, IP addresses, or CIDRs in addition to loopback defaults |
| `CSP_IMAGE_ALLOWED_ORIGINS` | Empty | Comma-separated exact origins allowed for remote image sources |
| `API_DEFAULT_BODY_LIMIT_BYTES` | `1048576` | Default request-body limit in bytes |
| `API_IMPORT_BODY_LIMIT_BYTES` | `2147483648` | Import request and multipart field/file limit in bytes (2 GiB) |
| `API_ASSET_BODY_LIMIT_BYTES` | `33554432` | Asset request-body limit in bytes |

Direct secret environment values take precedence over `_FILE` values.

## System Archive settings

::: tip Released capability
System Archive is enabled by default for the direct runtime and single-node Compose deployment. Set `SYSTEM_ARCHIVE_ENABLED=false` to withdraw its API routes and worker lane for an instance; `/api/v1/meta` then reports the capability as false while the specialized transfer formats remain available. The replicated base Swarm stack stays disabled because its node-local bind mounts are not shared System Archive storage.
:::

| Setting | Default | Accepted range or behavior |
| --- | --- | --- |
| `SYSTEM_ARCHIVE_ENABLED` | `true` | Registers the System Archive API and worker lane. Separated API/worker deployments must pass the same value to both roles. |
| `SYSTEM_ARCHIVE_ARTIFACT_TTL_SECONDS` | `86400` (24 hours) | 300 through 604800; lifetime of a published downloadable export and its private authority. |
| `SYSTEM_ARCHIVE_UPLOAD_TTL_SECONDS` | `86400` (24 hours) | 300 through 604800; inactivity lifetime for resumable upload/staged input authority. |
| `ARCHIVE_PREVIEW_TTL_SECONDS` | `1800` (30 minutes) | 60 through 86400; controls Campaign and World Archive preview authority only. |
| `SYSTEM_ARCHIVE_CHUNK_BYTES` | `16777216` (16 MiB) | 1048576 through 67108864; server maximum per resumable upload chunk. |
| `SYSTEM_ARCHIVE_ALLOW_UNKNOWN_FREE_SPACE` | `false` | When false, unknown staging or asset-root capacity fails preview/commit closed. When true, only an unknown measurement may be accepted; a measured shortage still fails. |
| `SYSTEM_ARCHIVE_ALLOW_LIMIT_INCREASE` | `false` | Allows the limit settings below to exceed their reviewed ceilings. Set only after resource and denial-of-service review. Lower limits never require this flag. |

Campaign and World Archive previews remain configurable through `ARCHIVE_PREVIEW_TTL_SECONDS`. System Archive Preview authority always expires after an independent 1,800 seconds, evaluated from the PostgreSQL database clock; changing the Campaign/World setting does not change that System Archive invariant.

The private roots are not portable configuration. `ARCHIVE_STORAGE_ROOT` owns upload, preview, temporary export, and published-download lifecycle state; `ASSET_STORAGE_ROOT` owns retained Original Assets. Every API and worker replica involved in System Archive must use the same PostgreSQL authority and see the same durable roots. Do not use an OS temporary directory or a replica-local container layer.

### Archive safety limits

| Setting | Reviewed default/ceiling |
| --- | --- |
| `SYSTEM_ARCHIVE_MAX_COMPRESSED_BYTES` | `53687091200` (50 GiB) |
| `SYSTEM_ARCHIVE_MAX_UNCOMPRESSED_BYTES` | `214748364800` (200 GiB) |
| `SYSTEM_ARCHIVE_MAX_ENTRIES` | `1000000` |
| `SYSTEM_ARCHIVE_MAX_EXPANSION_RATIO` | `100` |
| `SYSTEM_ARCHIVE_MAX_MANIFEST_BYTES` | `16777216` (16 MiB) |
| `SYSTEM_ARCHIVE_MAX_JSON_ENTRY_BYTES` | `1073741824` (1 GiB) |
| `SYSTEM_ARCHIVE_MAX_ORIGINAL_IMAGE_BYTES` | `26214400` (25 MiB) |

Each setting can lower its limit. It cannot exceed the reviewed ceiling unless `SYSTEM_ARCHIVE_ALLOW_LIMIT_INCREASE=true` was explicitly configured before startup. Browser input, API request fields, archive metadata, and CLI flags cannot raise a server limit, approve unknown free space, choose a private root, or bypass Import Preview.

The root Compose manifest mounts and passes `ARCHIVE_STORAGE_ROOT` and expands `SYSTEM_ARCHIVE_ENABLED` to `true` by default for its single combined application role. The base Swarm stack deliberately hard-disables System Archive, even if a shell supplies a different value, because its replicated services use node-local bind mounts. For a reviewed source-to-empty-destination drill, combine `deploy/swarm/stack.yaml` with `deploy/swarm/system-archive-validation.override.yaml`, supply an explicit gate value and a named validation node, and make sure that node has both durable host roots mounted. The override pins one API and one worker replica to that same node. Return to the base stack to disable the capability again. Do not enable only the API: it exposes jobs that no System Archive worker can process.

Future multi-node Swarm enablement requires shared asset and archive storage mounted identically on every eligible API and worker node, not merely matching container path strings.

See [System data transfer](../nexus-guide/operations/system-data-transfer.md) for operation, exclusions, acknowledgements, and current release blockers.

For the root local `compose.yaml`, when neither form is supplied, the startup bootstrap creates a random credential-encryption key once in a private named volume and reuses it on later starts. Docker Swarm does not bootstrap this value; it requires the operator-provisioned external secret.

World-generation progress is stored as short-lived, owner-scoped PostgreSQL state so API replicas can serve polling requests interchangeably. Generation logs record operational metadata but omit prompt bodies, imported lore, raw model output, private reasoning, and credentials.

::: warning Compose-effective values
The root `compose.yaml` passes fixed role, container port, constructed database URL, asset root, credential-encryption key, and the browser/provider/image network controls above. Host `APP_PORT` changes only the published host port. Other values listed in `.env.example`, including log level, worker interval, migration wait, and maintenance opt-in, are not automatically injected into the Compose application container. Add an explicit reviewed Compose override before claiming those values are effective.
:::
