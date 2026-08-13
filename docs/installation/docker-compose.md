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

This removes containers and the network but preserves named database and asset volumes.
