# Install with Docker Compose

## Configure

```powershell
Copy-Item .env.example .env
notepad .env
```

Set:

- `POSTGRES_PASSWORD` to a unique database password
- `APP_PORT` when host port 8080 is unavailable

## Start

```powershell
docker compose up --build
```

Compose starts `postgres`, waits for its health check, then starts `infinitequest-app` with role `all`. The application applies online migrations before listening and retries database readiness with bounded waits.

Docker Compose generates and persists a local credential-encryption key on first start. Supply `CREDENTIAL_ENCRYPTION_KEY` only when restoring an existing local deployment or when the operator needs to control the value. Back it up securely: changing or losing it makes saved provider credentials unreadable.

## Local single-user Settings

For a personal installation on this computer, use the local override with the same project name and database password as your existing Compose deployment:

```powershell
docker compose -f compose.yaml -f compose.local-single-user.yaml up -d --build
```

Open `http://127.0.0.1:8080/app/settings?section=diagnostics` (use your published `APP_PORT` if different). The override sets `INSTANCE_SETTINGS_ACCESS_MODE=local-single-user`, publishes the app on IPv4 loopback only, and uses a project-specific backend network. Anyone who can use the local app can edit installation Settings. Keep other containers off its private network. Use the same pair of Compose files for later operations on this deployment.

On first use, the combined API/worker process seeds Settings from its effective configuration. A Save records a requested revision under the initial owner's identity. The active values change only after guarded activation and restart. See the [installation Settings runbook](../runbooks/instance-settings.md) for existing installations and activation.

For a reverse-proxied deployment, use the standard management configuration. Terminate HTTPS at the proxy, keep the backend HTTP listener private, and forward the public host and scheme. The browser uses HTTPS and Operator Unlock; the app container can serve HTTP.

## Open

- Nexus: `http://localhost:8080/nexus/`
- Player: `http://localhost:8080/story`
- Liveness: `http://localhost:8080/health/live`
- Readiness: `http://localhost:8080/health/ready`

Replace `8080` with the configured host `APP_PORT`.

## Stop

```powershell
docker compose down
```

This removes containers and the network but preserves all four named volumes: database, assets, archives, and the generated encryption key. See [Storage layout](./storage.md).
