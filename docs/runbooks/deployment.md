# Deployment Runbook

Extracted from `AGENTS.md` during the 2026-08-01 instruction-file migration. Operational detail for Compose/Swarm deployment and ongoing ops; see `AGENTS.md` for the load-bearing architecture rules that stayed there.

## Compose and Swarm Deployment Modes

Build one versioned Nexus application image and use the same runtime configuration contract in both deployment modes. Do not create Compose-only application logic or a separate local implementation. The image should expose explicit roles such as `all`, `api`, `worker`, and `migrate` through its entrypoint or command.

The default local `compose.yaml` steady state contains two containers:

1. **`infinitequest-app`**: runs the web/API and worker roles together for simple local development and testing.
2. **`postgres`**: runs the pinned PostgreSQL major version and required extensions with a health check and named persistent volume.

The application must connect to PostgreSQL through the Compose service name, retry database readiness with bounded backoff, and expose application liveness and readiness checks. Do not rely solely on startup ordering. Do not publish the PostgreSQL port to the host by default; add an explicit development override when direct database access is needed.

The Swarm stack uses the same application image but runs API and worker roles as separate services so they can scale and roll independently. It receives the external PostgreSQL connection through Swarm secrets/configuration and contains no `postgres` service. Static web assets may be served by the API service or an explicitly introduced web service, but this choice must not change API contracts or persistence behavior.

Use `node-pg-migrate` from the same application image. The combined Compose role and every Swarm API replica run the standard migration check before serving traffic; PostgreSQL advisory locking serializes schema changes so exactly one replica applies pending work while the others wait. Worker-only replicas verify and wait for the current schema rather than applying migrations. A new database is initialized automatically, including the initial user. Online migrations apply automatically; migrations explicitly named with the `.maintenance.sql` suffix require a reviewed backup and operator opt-in on an existing database.

Keep local PostgreSQL compatible with the Swarm database: pin the same supported major version, enable the same required extensions, apply the same migrations, and test the same transaction and isolation behavior. If vector search uses a PostgreSQL extension, include the same extension and version in both environments.

Maintain separate deployment manifests where orchestrator behavior differs:

- Root `compose.yaml` for the two-container local environment.
- Optional `compose.override.yaml` for developer-only ports or mounts.
- `deploy/swarm/stack.yaml` for replicated services, configs, secrets, health checks, placement, updates, and rollback policy.

Compose credentials may come from an ignored local environment/secrets file with a committed redacted example. Swarm credentials must use Swarm secrets. The application should support file-based secret inputs so the same image can consume either mechanism without placing credentials in image layers or source control.

## Deployment and Operations

Swarm services must define health checks, resource expectations, restart behavior, and conservative rolling-update and rollback policies. API and worker replicas must coordinate through the database or an explicitly introduced durable queue; do not rely on process-local locks or memory for correctness.

Compose and Swarm must use the same schema migrations, initial-user bootstrap, provider configuration, job semantics, and API contracts. Add deployment smoke tests that start the two-container Compose environment, wait for PostgreSQL and application readiness, verify migrations and initial-user ownership, and exercise one database-backed API operation. Validate the Swarm stack configuration separately even when CI cannot launch a full multi-node swarm.

Use structured logs with correlation IDs for campaign, generation job, model request, and accepted turn. Record prompt size, retrieved-memory identifiers, context utilization, model and endpoint identity, recovery attempts, validation results, and latency without logging credentials, private reasoning, or unnecessary sensitive story content.

Database migrations must be ordered, repeatable, reviewed, and safe for the deployed application version. Prefer backward-compatible expand/contract changes so rolling API replicas can coexist. Applied online migrations are automatic; destructive or downtime-requiring `.maintenance.sql` migrations must remain exceptional and require an explicit operator opt-in on an existing database. Back up authoritative database data and test restoration. Treat embeddings and summaries as rebuildable unless operational requirements later make their backup worthwhile.

## Worker Concurrency and Graceful Shutdown

`WORKER_GENERATION_CONCURRENCY` controls the number of story generations that one worker process may execute concurrently. It accepts integers from `1` through `4` and defaults to `1`. Keep it at `1` for behavior equivalent to the original serial worker; raise it only after checking text-provider capacity and database connection headroom. Illustration, Chronicle, and asset work use separate scheduler lanes with capacity `1` each, so an unavailable image provider cannot block or invalidate a completed story turn.

Size `DATABASE_MAX_CONNECTIONS` for the runtime role:

- Worker-only process: at least `WORKER_GENERATION_CONCURRENCY + 4`; the committed default is `8`.
- Combined `all` process: at least `WORKER_GENERATION_CONCURRENCY + 8`; the committed default is `12`.
- API-only process: size for API traffic independently; it does not use the worker-concurrency formula.

Startup rejects an invalid concurrency value or a pool below the applicable minimum and names both settings in the error. The limits are per process, so multiply the configured pool by replica count when checking the database server's global connection allowance. Also count migrations, administrative access, observability, and other services before selecting a PostgreSQL `max_connections` value.

Both the combined Compose application and the Swarm worker use a ten-minute stop grace period. On termination, the runtime stops claiming new work, waits for every active story and optional-lane promise to settle, and only then closes provider clients and the database pool. Do not reduce the orchestrator grace period below the longest supported provider request unless the corresponding lease-recovery behavior has been revalidated. If a worker is killed after its grace period, another worker may reclaim the expired lease; the guarded commit and unique turn constraints prevent the stale worker from committing the same turn a second time.

For a rolling worker change:

1. Confirm the database connection budget for the old and new replica sets during overlap.
2. Confirm the text provider permits `replicas × WORKER_GENERATION_CONCURRENCY` concurrent requests, or configure a lower provider-side limit.
3. Deploy one worker at a time and retain `stop_grace_period: 10m`.
4. Observe generation queue latency, active and peak story generations, optional-lane activity, database connections, expired-lease reclaims, and duplicate-commit rejections.
5. Roll back concurrency independently from application code by returning the value to `1` if provider throttling, database pressure, or latency worsens.

Image retries remain independent of story generation in every deployment mode. Exhausting image attempts leaves the accepted narration and campaign state intact; retry or disable the image provider without rerunning the narration job.
