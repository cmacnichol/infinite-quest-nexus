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

### System Archive validation topology

The base Swarm stack deliberately sets `SYSTEM_ARCHIVE_ENABLED` to `false`, even when an environment variable has another value. Its API and worker replicas use node-local bind mounts and may be scheduled on different nodes, so enabling System Archive in that topology could leave durable transfer files visible to only one role.

For a reviewed, non-production source-to-empty-destination validation drill only, render `deploy/swarm/stack.yaml` together with `deploy/swarm/system-archive-validation.override.yaml`. The override requires an explicit gate value and `SYSTEM_ARCHIVE_VALIDATION_NODE`; it places exactly one API and one worker replica on that hostname. Before deploying such a reviewed drill, ensure the named node has both `ASSET_STORAGE_ROOT` and `ARCHIVE_STORAGE_ROOT` host roots mounted with the required permissions. Returning to the base stack disables System Archive again.

Do not use the validation override for multi-node production. A future multi-node enablement needs shared asset and archive storage mounted identically on every eligible API and worker node, not merely identical container path strings, plus separate explicit production approval. Root Compose remains false-by-default through its environment expansion and does not have this split-role, node-local bind-mount topology.

Compose credentials may come from an ignored local environment/secrets file with a committed redacted example. Swarm credentials must use Swarm secrets. The application should support file-based secret inputs so the same image can consume either mechanism without placing credentials in image layers or source control.

## Deployment and Operations

Swarm services must define health checks, resource expectations, restart behavior, and conservative rolling-update and rollback policies. API and worker replicas must coordinate through the database or an explicitly introduced durable queue; do not rely on process-local locks or memory for correctness.

Compose and Swarm must use the same schema migrations, initial-user bootstrap, provider configuration, job semantics, and API contracts. Add deployment smoke tests that start the two-container Compose environment, wait for PostgreSQL and application readiness, verify migrations and initial-user ownership, and exercise one database-backed API operation. Validate the Swarm stack configuration separately even when CI cannot launch a full multi-node swarm.

### Replacement Story UI build selection and rollback

`VITE_UI_COMPONENTS` is a Docker **build argument** consumed while Vite compiles the replacement Story static bundle. It is not a runtime service setting: changing a container or server environment after image creation cannot switch the already-built bundle. The current application default remains native until separately approved release gates are complete.

Build a native rollback image without starting a service, changing a database, or removing browser preference keys:

```powershell
docker build --build-arg VITE_UI_COMPONENTS=native -t infinitequest-nexus:ui-native .
```

For Compose image creation only:

```powershell
docker compose build --build-arg VITE_UI_COMPONENTS=native infinitequest-app
```

Both commands create images only. Deploying either image requires separate approval. A Swarm update must use a prebuilt, tested image; do not rely on a runtime environment value to choose the renderer.

Use structured logs with correlation IDs for campaign, generation job, model request, and accepted turn. Record prompt size, retrieved-memory identifiers, context utilization, model and endpoint identity, recovery attempts, validation results, and latency without logging credentials, private reasoning, or unnecessary sensitive story content.

Database migrations must be ordered, repeatable, reviewed, and safe for the deployed application version. Prefer backward-compatible expand/contract changes so rolling API replicas can coexist. Applied online migrations are automatic; destructive or downtime-requiring `.maintenance.sql` migrations must remain exceptional and require an explicit operator opt-in on an existing database. Back up authoritative database data and test restoration. Treat embeddings and summaries as rebuildable unless operational requirements later make their backup worthwhile.

## Chronicle chunked retrieval staged rollout

Chunked Chronicle retrieval is an explicit campaign-level opt-in. Database migrations add only derived chunk, fencing, observability, and query-cache schema and jobs; they do not rewrite accepted turns or change a campaign's production retrieval implementation.

Use this sequence:

1. Back up the authoritative database and prove restoration. Deploy compatible API and worker code before enabling shadow comparison. Apply migrations `0072` through `0077` under the normal migration lock, then confirm both old and new replicas tolerate the expanded schema during any rolling overlap. All of these are ordinary online migrations; none carries the `.maintenance.sql` suffix, so none requires operator opt-in.

   Upgrading a database that already holds a chunk index is additive and does not rebuild it. `0076` narrows `embedding_skip_reason` to the closed sanitized set, which every previously written value already satisfies, and `0077` adds a nullable `processed_signature`. No turn, Chronicle memory, chunk, or vector is rewritten. Indexing is incremental, so the first job enqueued after the upgrade finds no parent needing work on an already-covered campaign. Two bounded one-time effects are expected. A job that was queued or running at upgrade time has no recorded prefix, so its durable cursor is cleared and it rescans from the first parent; because indexing is incremental this rescans rather than re-embeds, and parents already chunked at their current content are skipped. Separately, a job resumed with a capability fingerprint recorded before the batching default changed clears that campaign's chunk vectors and re-embeds them once, which is the existing behaviour for any capability change. The campaign continues on its complete legacy retrieval path while either completes. Older replicas tolerate the new schema during a rolling overlap because they only write values the new constraint accepts and ignore the added column.
2. Leave every campaign on the default `legacy_hybrid` production implementation with shadow disabled. Enqueue `index_memory_chunks_v2` only after the compatible worker is live.
3. Monitor job leases, progress, provider health, fixed fallback codes, and compatible coverage. Wait for 100% terminal coverage: every current parent hash has at least one current `chronicle-chunk-v1` chunk in terminal `embedded` or sanitized `skipped` status, every current chunk is terminal, at least one current chunk is embedded, and the latest chunk job is completed or absent. A fully sanitized-skipped index uses the complete legacy path with the existing `chunk_index_not_ready` fallback; a partially ready campaign also continues through the complete legacy path.
4. Establish the deterministic label-only legacy baseline, calibrate the generated production profile, and verify the final chunked result:

   ```powershell
   pnpm evaluate:chronicle -- --implementation legacy_hybrid --output tmp/chronicle-evaluation/legacy-baseline.json
   pnpm evaluate:chronicle -- --calibrate --baseline tmp/chronicle-evaluation/legacy-baseline.json --write-profile packages/domain/src/generated/chronicle-retrieval-profile-v2.ts
   pnpm evaluate:chronicle -- --implementation chunked_hybrid --output tmp/chronicle-evaluation/final-chunked.json
   ```

   Run these commands only against a dedicated non-production calibration database. Never point `TEST_DATABASE_URL` at a production or shared authoritative database: the fixture data is rolled back, but the evaluator applies pending migrations before opening that transaction. When `TEST_DATABASE_URL` is unset, the evaluator starts the repository's dedicated local test PostgreSQL service and uses its test database. Calibration evaluates the deterministic fixture corpus in a PostgreSQL transaction, writes a source profile only when requested, and does not update campaign configuration. Review recall, NDCG, duplicate rate, leakage, prompt-token efficiency, latency, and embedding-request gates before deploying a changed generated profile.
5. Enable shadow comparison for a small set of ready campaigns while keeping their production implementation on `legacy_hybrid`. Compare lexical, legacy-hybrid, and proposed chunked ranks, fixed fallback codes, selection flags, latency, token estimates, and provider/cache cost identifiers. Shadow execution and telemetry are best-effort and never change production selection.
6. After diagnostics meet the release criteria, explicitly set only the selected ready campaigns to `chunked_hybrid`. Recheck context previews, production selection flags, provider health, fallback rate, generation latency, and continuity. Do not automatically convert existing or newly created campaigns.

There is no reranking stage and no reranker provider dependency. The generated chunked profile combines semantic, lexical, entity, recency, and chronology ranks with weighted reciprocal-rank fusion, followed by deterministic duplicate and diversity controls.

### Retention and sensitive-data boundary

The independent query-embedding cache retains entries for 7 days and enforces at most 256 entries per campaign. Safe retrieval telemetry retains runs for 30 days and enforces at most 5,000 runs per campaign. Cache and telemetry cleanup are derived-data operations and must not lock or rewrite accepted turns.

Telemetry may contain hashes, scoped IDs, ranks, fixed reason and fallback codes, protocol/profile versions, latency, token estimates, provider fingerprints, selection flags, and cost identifiers. It must not contain raw queries, actions, narration, prompts, responses, credentials, provider endpoints, or raw errors. Logs follow the same boundary.

### Configuration rollback

Rollback does not require a down migration or deletion. Return all opted-in campaigns to legacy production and disable shadowing:

```sql
UPDATE campaign_memory_configs
   SET retrieval_implementation = 'legacy_hybrid',
       retrieval_shadow_enabled = false,
       updated_at = now()
 WHERE retrieval_implementation <> 'legacy_hybrid' OR retrieval_shadow_enabled;
```

This leaves accepted turns, parent Chronicle memories, chunk rows, and vectors intact. Keep legacy vectors until a separately reviewed removal plan is approved; their presence preserves immediate configuration-only recovery. Repair or rebuild derived chunks after the application is stable, shadow selected campaigns again, and require a new explicit opt-in before returning to chunked production.

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
