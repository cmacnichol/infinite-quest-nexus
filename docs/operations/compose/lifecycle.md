# Compose lifecycle

## Start or reconcile

```powershell
docker compose up --build
```

Compose recreates services as needed and preserves named volumes.

## Inspect

```powershell
docker compose ps
docker compose logs infinitequest-app
docker compose logs postgres
```

## Stop while preserving data

```powershell
docker compose down
```

## Development database port

Copy or explicitly select `compose.override.example.yaml` only when direct host database access is required. It publishes port 5432 and sets application log level to debug. Do not expose that port on an untrusted interface.
