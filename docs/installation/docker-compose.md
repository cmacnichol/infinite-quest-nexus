# Install with Docker Compose

## Configure

```powershell
Copy-Item .env.example .env
notepad .env
```

Set:

- `POSTGRES_PASSWORD` to a unique database password
- `CREDENTIAL_ENCRYPTION_KEY` to a long random value stored in the deployment's secret backup
- `APP_PORT` when host port 8080 is unavailable

## Start

```powershell
docker compose up --build
```

Compose starts `postgres`, waits for its health check, then starts `infinitequest-app` with role `all`. The application applies online migrations before listening and retries database readiness with bounded waits.

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
