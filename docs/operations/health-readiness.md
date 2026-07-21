# Health and readiness

## API liveness

`GET /health/live` returns process status and role. It does not query dependencies.

## API readiness

`GET /health/ready` queries PostgreSQL and requires pgvector. Because API roles migrate before listening, a successful response also implies startup migration completed. It does not verify providers, worker progress, or asset writability.

## Worker health

The Swarm worker health check runs a basic `SELECT 1`. The worker verifies migration inventory before processing. A healthy worker check does not prove that a provider is reachable or that a particular job is making progress.

Monitor job age, lease/retry behavior, provider diagnostics, and asset writes separately. Do not use one green health check as an end-to-end service-level assertion.
