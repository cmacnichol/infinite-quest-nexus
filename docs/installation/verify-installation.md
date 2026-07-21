# Verify an installation

## Container state

```powershell
docker compose ps
```

Both services should be running and healthy.

## Liveness

```powershell
Invoke-RestMethod http://localhost:8080/health/live
```

Liveness confirms that the API process can answer. It does not probe PostgreSQL, providers, workers, or asset writability.

## Readiness

```powershell
Invoke-RestMethod http://localhost:8080/health/ready
```

Readiness queries PostgreSQL and requires the `vector` extension. It returns database and pgvector versions. It does not test provider connectivity, durable job progress, or generated-asset writes.

## Product smoke test

Open Nexus, create an enabled text profile, discover a model, and create a draft world. This verifies application writes and provider reachability more completely than the health endpoints alone.
