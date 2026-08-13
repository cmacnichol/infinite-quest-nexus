# Infinite Quest Nexus As-Built Specification

> **Status: recovered, not approved.** This document records what the repository
> demonstrably does at the reviewed revision. It is not a statement of product
> intent and must not be treated as an approved target-state specification.
> Behaviors recorded here may be defective, accidental, or obsolete.

## 1. Review Metadata

| Field | Value |
| --- | --- |
| Repository root | `C:/Git/InfiniteQuest` |
| Repository identity | `https://github.com/cmacnichol/infinite-quest-nexus.git` (origin) |
| Branch | `main` |
| Revision (`HEAD`) | `58d0aa2f93749d03a1982e6f907fd0f13ff83a4c` |
| Baseline comparison | None supplied |
| Working-tree state | Not clean; **no application code modified** |
| — modified | `AGENTS.md` (Repowise auto-generated block only, between `REPOWISE_AGENTS` markers) |
| — untracked | `docs/prompts/claude-repowise-undocumented-codebase-review-prompt.md` (this review's instructions) |
| — staged | None |
| Submodules | None |
| Review scope | Entire repository (431 tracked files) |
| RepoWise indexed commit | `58d0aa2f9374` — exact match to `HEAD` |
| RepoWise index age | 0 days; not stale |
| Generated | 2026-07-29 |

Because the only tracked modification is a generated documentation block, the
reviewed state is equivalent to `HEAD` for all executable code, schema, tests,
and deployment artifacts.

## 2. Evidence Classification

| Class | Meaning |
| --- | --- |
| **Documented** | Stated in current repository documentation, formal schemas, public API contracts, or authoritative configuration. |
| **Observed** | Directly demonstrated by live source, executed commands, current tests, migrations, or schemas. |
| **Historically supported** | Supported by Git history or prior design records, but not established as a current requirement. |
| **Inferred** | Suggested by structure, naming, repeated patterns, or RepoWise context; not proven. |
| **Desired** | Supplied by a human stakeholder as intended behavior. *(None supplied for this review.)* |
| **Unknown** | Requires human confirmation or a business decision. |

No **Desired** evidence exists in this review: the project inputs recorded
`Known users or system purpose: UNKNOWN`. Every requirement-like statement below
is therefore Documented, Observed, Historically supported, or Inferred.

## 3. System Purpose

**Documented.** `README.md:7-9` states Infinite Quest Nexus is a self-hosted
platform for creating reusable, versioned story worlds and running persistent
AI-assisted campaigns, with PostgreSQL preserving worlds, immutable world
versions, campaigns, accepted turns, state, and Chronicle memory independently
of a browser session or model context window. The player-facing experience is
"Infinite Quest"; the management platform is "Infinite Quest Nexus".

**Documented.** `README.md:13` describes the current state as "a production-shaped
pre-authentication deployment for a trusted network."

**Observed.** The codebase is a pnpm workspace of TypeScript services and
packages plus a static browser client, ~55.9k LOC across 431 tracked files:
174 Markdown, 159 TypeScript, 50 SQL migrations.

## 4. Users, Roles, and External Actors

| Actor | Evidence | Class |
| --- | --- | --- |
| Single implicit owner (`initial-owner`) | `services/api/src/user-service.ts:6-23` resolves every session to `initialOwnerId(pool)`; `server.ts:292-311` exposes it as the session user | Observed + Documented (`README.md:122`) |
| Browser client (Nexus dashboard, Story player) | `apps/web/public/nexus.js`, `story.js`, served at `/nexus/` and `/story` (`server.ts:244-271`) | Observed |
| Background worker | `services/worker/src/worker.ts:23`; role selected by `APP_ROLE` (`config.ts:154-157`) | Observed |
| External model providers (text, embedding, illustration) | `packages/story-engine/src/providers.ts`, `providers/illustration/sogni*` | Observed |
| PostgreSQL 18 + pgvector | `compose.yaml:4`, readiness probe asserts `vector` extension (`server.ts:275-281`) | Observed |
| Container orchestrator (Compose / Swarm) | `compose.yaml`, `deploy/swarm/stack.yaml` | Observed |

**No authenticated multi-user roles exist.** `README.md:122` states interactive
authentication and OIDC are not implemented and that browser-supplied identity
values are not authorization. This is a documented current limitation, not an
inferred one.

## 5. Architecture Overview

**Observed.** Two executable entry points share one codebase:

- `services/runtime/src/main.ts` — process entry; `lifecycle.ts` creates the DB
  pool and provider transport, dispatches by role, and guarantees ordered
  teardown of transport then pool (`lifecycle.ts:22-28`).
- `services/api/src/server.ts` — Fastify HTTP surface (`buildServer`, 1009 lines).

Layers, by directory:

| Layer | Path | Responsibility (Observed) |
| --- | --- | --- |
| Browser client | `apps/web/public/` | Nexus dashboard and Story player; static assets |
| API | `services/api/src/` | ~29 service modules + route registration |
| Worker | `services/worker/src/` | Durable job loop |
| Runtime | `services/runtime/src/` | Composition, role dispatch, lifecycle |
| Contracts | `packages/contracts/src/` | Zod schemas shared across boundaries |
| Domain | `packages/domain/src/` | World/campaign rules, text, canon |
| Story engine | `packages/story-engine/src/` | Prompting, providers, mechanics, memory |
| Database | `packages/database/src/` | Config, pool, migration |
| Security | `packages/security/src/` | CSP, origin policy, provider network policy |
| Schema | `database/migrations/` | 50 ordered SQL migrations |

`APP_ROLE` selects `all | api | worker | migrate` (`config.ts:154-157`),
permitting single-container local operation and split API/worker replicas in
Swarm.

## 6. Components and Responsibilities

Selected components material to this review.

### 6.1 Request security (`services/api/src/request-security.ts`)
**Observed.** A single `onRequest` hook sets `X-Content-Type-Options`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`,
and CSP on every response; adds HSTS when `request.protocol === "https"`; sets
`Cache-Control: no-store` for `/api/v1/` (lines 18-27). It then rejects requests
with no `Host` header and evaluates the `Origin` header (lines 29-48).

### 6.2 Origin policy (`packages/security/src/exact-origins.ts`)
**Observed.** `normalizeExactOrigin` rejects `*`, non-HTTP(S) schemes,
credentials, paths, queries, and fragments. `evaluateRequestOrigin` allows a
request with **no** `Origin` header, allows same-origin loopback
(`localhost`/`127.0.0.1`/`[::1]`), and otherwise requires exact membership in
`CORS_ALLOWED_ORIGINS`.

### 6.3 Content Security Policy (`packages/security/src/content-security-policy.ts`)
**Observed.** `default-src 'none'`, `script-src 'self'`, `style-src 'self'`,
`object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`,
`form-action 'self'`; `img-src` extended only by configured origins. No
`unsafe-inline` or `unsafe-eval`.

### 6.4 Admission control (`services/api/src/admission-service.ts`)
**Observed.** A complete PostgreSQL-backed fixed-window rate limiter plus
concurrency leases: advisory-lock serialization
(`pg_advisory_xact_lock`, line 101), expired-lease reclamation, request-id
idempotency, conditional bucket increment, and expired-bucket cleanup.
**Observed: it is not invoked by any route or service.** See §22 and finding
REV-001.

### 6.5 Worker loop (`services/worker/src/worker.ts`)
**Observed.** One generation job runs concurrently with a short-circuit chain of
illustration-prompt, illustration-resolution, image, chronicle, and asset
backfill jobs. Errors are logged and the loop continues (lines 57-63). Shutdown
drains the in-flight generation (lines 67-70).

### 6.6 Generation claiming (`services/api/src/generation-service.ts`)
**Observed.** `claimGeneration` selects `FOR UPDATE SKIP LOCKED LIMIT 1` over
queued jobs *and* lease-expired in-flight jobs, then atomically stamps
`lease_owner` and `lease_expires_at`. This is a correct multi-worker claim
pattern with crash recovery via lease expiry.

### 6.7 Archive I/O (`services/api/src/archive-io.ts`)
**Observed.** Layered path-traversal defense: rejects backslashes, absolute
paths, and drive letters (line 188); NFC-normalizes and schema-validates
(197-198); rejects `..` segments (209, 540); `realpath`-verifies that resolved
directories contain no symlink indirection (292-295, 322-331, 551-556);
`assertUnderRoot` containment; duplicate normalized-path detection (625).

### 6.8 Credential encryption (`packages/story-engine/src/credentials.ts`)
**Observed.** AES-256-GCM with a fresh 12-byte random nonce per encryption,
stored auth tag, and a `keyVersion` field. The key is derived as
`sha256(secret)` — a single unsalted pass, no KDF (line 12). See REV-003.

## 7. Public Interfaces

**Observed.** All HTTP routes are registered in `services/api/src/server.ts`
plus `archive-routes.ts`. Surface summary:

| Group | Representative routes |
| --- | --- |
| Health / meta | `GET /health/live`, `GET /health/ready`, `GET /api/v1/meta` |
| Session / user | `GET /api/v1/session`, `GET|PATCH|PUT /api/v1/users/me/profile` (plus `/api/v1/user/profile` aliases) |
| Providers | `GET|POST /api/v1/providers`, `:id/models`, `:id/default`, `PATCH|DELETE :id`, `POST /api/v1/provider-text/generate`, `POST /api/v1/providers/discover-models` |
| Imports | `POST /api/v1/imports/{legacy-story,world,infinite-worlds}[/preview]`, `GET /api/v1/imports/progress` |
| Worlds | CRUD, `generate-preview`, `draft`, `publish`, `fork`, `export`, versions, covers |
| Campaigns | CRUD, `state`, `turns`, `sync-status`, `rewind`, `branch`, `migrate-world`, `transfer-world`, `cost-summary`, `player-config`, `character-profile` |
| Generation | `POST :campaignId/generations`, `retry-latest`, `GET /generation-jobs/:id`, `/stream` (SSE), `/result`, `retry`, `cancel`, `discard` |
| Illustrations | turn/segment illustration routes, backfill, image jobs, resolution/rematch |
| Assets | `GET /api/v1/assets`, `:id`, `:id/thumbnail`, `facets`, `PATCH :id/library-metadata` |
| Memory | metrics, `context-preview`, `reindex`, `embedding-config`, embeddings reindex |
| Archives | registered by `archive-routes.ts` |

**Observed.** Validation is uniform: path IDs go through `uuidSchema.parse`,
bodies and queries through Zod schemas from `packages/contracts`. Static
duplicate alias routes exist for the user profile (`/users/me/profile` and
`/user/profile`, both `PATCH` and `PUT` — `server.ts:300-311`).

**Observed.** `GET /api/v1/session` returns `{ user, authentication: "deferred" }`
(line 294), explicitly signalling the pre-auth posture to clients.

## 8. Primary Workflows

**Observed — turn generation.** Client `POST`s to
`/api/v1/campaigns/:id/generations`; `enqueueGeneration` persists a job and
returns `202` (or `200` when de-duplicated). The worker claims it
(`claimGeneration`), executes provider calls, and advances status through
`assessing → generating → validating → committing → completed`. The client
observes progress via SSE `GET /api/v1/generation-jobs/:jobId/stream`
(`server.ts:724-794`), which polls the database every 350 ms and writes a frame
only when the serialized snapshot changes.

**Observed — recovery.** Terminal states include `completed`, `failed`,
`recoverable`, `discarded`, `cancelled`. Jobs whose lease expires are re-claimed
by any worker.

**Observed — world lifecycle.** Worlds are drafted, then `publish` creates an
immutable version; campaigns bind to a `world_version_id` and can be migrated or
transferred to another version explicitly.

**Observed — import.** Legacy story, world, and Infinite Worlds imports each
have a preview route and a commit route, both raised to
`API_IMPORT_BODY_LIMIT_BYTES`.

## 9. Data Model and Persistence

**Observed.** PostgreSQL with pgvector; 50 ordered migrations
`0001_initial_nexus.sql` … `0050_cancel_provisional_illustration_children.sql`.
Applied via `node-pg-migrate` (`packages/database/src/migrate.ts`), gated by
`MIGRATION_WAIT_SECONDS` and `ALLOW_MAINTENANCE_MIGRATIONS`.

**Observed.** Every reviewed query filters by `owner_user_id`, including joins
(`server.ts:602-614` joins `world_versions` and `worlds` on both id *and*
`owner_user_id`). Migration `0019_multi_tenant_hardening.sql` and
`0002_owner_scope_constraints.sql` indicate this scoping is enforced at the
schema level. **Inferred:** the ownership column exists to permit future
multi-tenancy; today it always holds `initial-owner`.

**Observed.** Accepted `turns` are the recovery ledger; `campaign_state` and
`campaign_state_revisions` hold runtime state; `generation_jobs`,
`chronicle_jobs`, and image job tables hold durable work.

## 10. Authentication and Authorization

**Documented + Observed.** There is none. `README.md:122` states it explicitly;
`user-service.ts` resolves all requests to `initial-owner`. Authorization is
reduced to a constant owner id applied as a SQL predicate.

**Observed.** The practical access control is network placement plus the origin
policy in §6.2. Because there is no session or credential, classical CSRF has no
privilege to escalate; the `Origin` check nonetheless blocks cross-site
state-changing requests from a browser, and CSP sets `form-action 'self'`.

**Unknown.** Whether authentication is a committed roadmap requirement, and what
role model it would use.

## 11. Trust Boundaries

| Boundary | Control | Class |
| --- | --- | --- |
| Browser → API | Origin allowlist, CSP, security headers, body limits, Zod validation | Observed |
| API → PostgreSQL | Parameterized queries throughout reviewed code; pool from `DATABASE_URL` | Observed |
| API/worker → model providers | `packages/security/src/provider-network-policy.ts` allowlist (defaults `localhost`, `127.0.0.0/8`, `::1/128`, plus `PROVIDER_NETWORK_ALLOWLIST`) — SSRF control | Observed |
| Untrusted content | Provider output, imports, and generated Markdown/HTML are declared untrusted (`README.md:133`) | Documented |
| Archive extraction | Path normalization + realpath containment (§6.7) | Observed |
| Secrets | `_FILE` indirection supported (`config.ts:55-61`); `.env*` gitignored except examples | Observed |
| Container | Non-root uid/gid 10001, no shell service exposure (`Dockerfile`) | Observed |

## 12. Configuration and Feature Flags

**Observed.** All configuration is environment-driven via
`packages/database/src/config.ts`, with bounded integer parsing that clamps or
throws. Notable settings: `APP_ROLE`, `APP_HOST`, `APP_PORT`, `DATABASE_URL`,
`DATABASE_MAX_CONNECTIONS`, `MIGRATION_*`, `WORKER_*`, `WEB_ROOT`,
`ASSET_STORAGE_ROOT`, `ARCHIVE_STORAGE_ROOT`, archive limits,
`CREDENTIAL_ENCRYPTION_KEY`, `CORS_ALLOWED_ORIGINS`,
`PROVIDER_NETWORK_ALLOWLIST`, `CSP_IMAGE_ALLOWED_ORIGINS`, body limits, and
`TRUST_PROXY_HOPS`.

**Observed — accepted but not consumed.** Six settings are parsed and validated
into `config.security` but read by no production code path:
`API_RATE_LIMIT_WINDOW_SECONDS`, `API_RATE_LIMIT_PROVIDER_REQUESTS`,
`API_RATE_LIMIT_GENERATION_REQUESTS`, `API_RATE_LIMIT_IMPORT_REQUESTS`,
`API_CONCURRENCY_PROVIDER_REQUESTS`, `API_CONCURRENCY_IMPORT_REQUESTS`
(`config.ts:196-201`). See REV-001.

**Observed.** Default `API_IMPORT_BODY_LIMIT_BYTES` is 2 GiB and default
campaign archive limits allow 2 GiB compressed / 20 GiB uncompressed / 100 000
entries (`config.ts:178-187, 194`). **Historically supported:** commit `eee172b`
"Raise campaign archive import limit" shows these were deliberately increased.

There are no runtime feature flags; behavior is selected by role and config.

## 13. External Integrations

**Observed.** Text, embedding, and illustration providers are configured as
independent profiles with encrypted credentials. Sogni has two implementations:
an HTTP provider (`providers/illustration/sogni/index.ts`) and an SDK provider
(`providers/illustration/sogni-sdk/index.ts`, using `@sogni-ai/sogni-client`).
OpenRouter image-model discovery and image-unit pricing are documented
(`README.md:21`). Egress is constrained by the provider network allowlist.

## 14. Background and Scheduled Processing

**Observed.** One polling worker loop (§6.5); no cron or external scheduler.
Two opportunistic cleanups run inline: expired world-generation progress is
deleted at most once per 60 s, gated by a module-level timestamp
(`server.ts:405-408`), and expired admission buckets are trimmed 100 rows at a
time inside `acquireAdmission` (which never runs — §6.4).

**Observed.** `lastWorldGenerationProgressCleanupAt` is per-process module state,
so with multiple API replicas the cleanup runs once per replica per minute.

## 15. Error Handling and Recovery

**Observed.** A single `setErrorHandler` (`server.ts:207-226`) derives a status
code, logs `request_failed` with the error, and returns a correlation id.
Responses expose the message only when `code < 500` or the error opts in with
`expose === true` (line 182-184); otherwise the client receives
"Internal server error". `safeErrorDetails` (169-180) strips keys containing
`path` (other than exactly `path`) and `rawpayload` before serialization.

**Observed — exception to the above.** The SSE stream writes
`error instanceof Error ? error.message : String(error)` directly to the client
(`server.ts:776`), bypassing `exposeError`. See REV-005.

**Observed.** `acquireAdmission` wraps its whole body in a bare `catch` that
discards the original error and throws `AdmissionControlUnavailableError`
without logging (`admission-service.ts:198-206`). See REV-007.

**Observed.** Job recovery is lease-based; the worker logs
`worker_loop_error` and continues rather than exiting.

## 16. Concurrency and Idempotency

**Observed — sound patterns.**
- Job claiming uses `FOR UPDATE SKIP LOCKED` with lease expiry (§6.6).
- Admission control (unused) serializes per owner+operation with
  `pg_advisory_xact_lock` and de-duplicates by `request_id`.
- Generation, illustration, cover, and transfer routes return a `duplicate`
  flag and switch `200` vs `201/202` accordingly, indicating idempotent enqueue.
- The worker runs at most one generation per process.

**Observed — unbounded.** The SSE endpoint has no maximum duration, no cap on
concurrent streams, and no admission gate; each open stream issues a database
query every 350 ms (`server.ts:744-782`). See REV-004.

## 17. Logging, Metrics, and Observability

**Observed.** Structured logging via Pino (`packages/logger/src/index.ts`).
Correlation ids come from the `x-correlation-id` request header or a generated
UUID (`server.ts:203-204`) and are returned in error bodies. Generation stream
connect/close events record `finalStatus`, `snapshotsSent`, and `durationMs`.
`safeLogErrorCode` constrains logged error codes to a safe charset.

**Observed.** Health endpoints: `/health/live` (role echo) and `/health/ready`
(asserts DB reachable *and* pgvector installed, else `503`). Both Dockerfile and
Compose healthchecks probe `/health/ready`.

**Observed — gap.** There is no metrics endpoint (no Prometheus/OpenTelemetry
exporter) and no tracing.

## 18. Deployment and Operational Model

**Observed.** Multi-stage `Dockerfile`: build → `pnpm prune --prod` → slim
runtime on `node:24-bookworm-slim`. Runtime creates a system user
`infinitequest` (uid/gid 10001), chowns `/app` and the asset root, and runs
`USER infinitequest`. Version, commit, and build date are baked as build args
and surfaced under **About**.

**Observed.** `compose.yaml` runs PostgreSQL (`pgvector/pgvector:0.8.5-pg18-trixie`)
plus the app with `APP_ROLE: all`; `POSTGRES_PASSWORD` is required via
`${POSTGRES_PASSWORD:?…}`; `CREDENTIAL_ENCRYPTION_KEY` is passed through with an
empty default. `deploy/swarm/stack.yaml` provides split API/worker roles.

**Observed.** Named volumes hold the database and assets; `README.md:69-70`
warns that `docker compose down --volumes` destroys both.

**Observed.** CI (`.github/workflows/ci.yml`) has `permissions: contents: read`
and runs, in order: `pnpm check:data`, `pnpm check`, `pnpm test:unit`,
`pnpm test:integration` (10-min timeout), `pnpm build`, `docker compose config`,
`docker stack config`, and `docker build`.

## 19. Tests and Validation

**Observed.** 56 unit test files (`tests/unit/`) and 20 integration files
(`tests/integration/`), the latter scoped by
`vitest.integration.config.ts` with `include: ["tests/integration/**/*.test.ts"]`,
`fileParallelism: false`, and a global setup that provisions a dedicated
PostgreSQL container.

**Observed (executed for this review).** With collection correctly scoped to the
reviewed revision: **56 files, 664 tests passed, 2 skipped, 0 failed (3.99 s).**
`pnpm check` (repository boundaries + data scan + `tsc --noEmit` + `node --check`
on both browser bundles) **passed, exit 0**.

**Observed — collection defect.** `pnpm test:unit` is `vitest run tests/unit`
with no root Vitest config, so the argument acts as a substring filter against
the default `**/*.test.ts` glob. It collected **323** files — the 56 real ones
plus **267** from five gitignored `.worktrees/` checkouts — and reported 8
failures belonging to other revisions. See REV-002.

**Not validated.** `pnpm test:integration` did not execute: the persistent
volume `infinitequest-test_infinitequest-integration-postgres-data` was
initialized with credentials that no longer match `.env.test.local`, so
authentication failed for 150 s. This is environmental and has a documented
reset procedure (`docs/contributing/integration-test-database.md`); the reset
was **not** performed because it destroys a volume and is outside a read-only
review.

## 20. Known System Invariants

| # | Invariant | Evidence | Class |
| --- | --- | --- | --- |
| I-1 | Every persisted row is scoped by `owner_user_id`, including through joins | `server.ts:602-614`; migrations 0002, 0019 | Observed |
| I-2 | World versions are immutable once published; campaigns bind to a version | `world-service.ts` publish/fork; `campaigns.world_version_id` | Observed |
| I-3 | Accepted turns are the canonical recovery ledger | `README.md`, `turns` table, rewind/branch routes | Documented + Observed |
| I-4 | At most one generation job per worker process | `worker.ts:27-38` | Observed |
| I-5 | A job whose lease expires may be re-claimed by any worker | `claimGeneration` | Observed |
| I-6 | Archive entries never resolve outside the archive root | `archive-io.ts` (§6.7) | Observed |
| I-7 | Readiness requires both database reachability and pgvector | `server.ts:273-286` | Observed |
| I-8 | The historical root `index.html` is never loaded or served | `scripts/check-repository-boundaries.mjs` enforces this in CI | Documented + Observed |
| I-9 | Provider egress is restricted to the allowlist | `provider-network-policy.ts` | Observed |

## 21. Documented Requirements

- Self-hosted, versioned worlds and persistent campaigns (`README.md:7-9`).
- Pre-authentication posture for a trusted network; browser identity is not
  authorization (`README.md:13, 122`).
- Provider profiles, imports, and model output are untrusted input
  (`README.md:133`).
- Secrets must stay out of source control (`README.md:124-131`).
- **P0 network security design** (`docs/superpowers/specs/2026-07-23-p0-network-security-design.md`)
  requires: exact-origin policy; provider destination policy; explicit body-size
  *and admission policies on sensitive routes* (line 53-54); PostgreSQL-backed
  rate and concurrency admission shared across replicas (line 30, 344);
  `429 REQUEST_LIMIT_EXCEEDED` with `Retry-After` when limits are exhausted
  (line 283, 311); fail-closed `503 ADMISSION_CONTROL_UNAVAILABLE` (line 290);
  and acceptance criteria that "Multiple API replicas enforce one
  PostgreSQL-backed rate/concurrency limit" (line 382).
- Node.js ≥ 22.13, pnpm 11.17.0 (`package.json:6-9`).

## 22. Observed Behaviors

Behaviors that are true of the current code but are **not** established as
intended requirements.

| # | Behavior | Evidence |
| --- | --- | --- |
| B-1 | No route performs rate limiting or concurrency admission; `429` is never returned and `REQUEST_LIMIT_EXCEEDED` appears nowhere in the repository | `server.ts` (no import of `admission-service`); repo-wide grep |
| B-2 | Six rate-limit/concurrency env settings are validated then ignored | `config.ts:196-201`; no consumer |
| B-3 | Requests with **no** `Origin` header are allowed, including state-changing methods | `exact-origins.ts:34` |
| B-4 | SSE generation stream polls the DB every 350 ms indefinitely with no server-side timeout or stream cap | `server.ts:744-782` |
| B-5 | SSE error frames contain raw internal error messages | `server.ts:776` |
| B-6 | `activeProgressMap` entries are written but never deleted in production code | `infinite-worlds-import-service.ts:52, 470-533` |
| B-7 | Import progress is keyed by `sourceName + ":" + sourceText.length` and readable by anyone who supplies the key | same file, line 467; `server.ts:380-385` |
| B-8 | Admission failures are reported as an opaque `503` with the cause discarded and unlogged | `admission-service.ts:198-206` |
| B-9 | Duplicate alias routes exist for the user profile (`/users/me/profile`, `/user/profile` × `PATCH`/`PUT`) | `server.ts:300-311` |
| B-10 | Default import body limit is 2 GiB; campaign archives allow 20 GiB uncompressed | `config.ts:178-187, 194` |
| B-11 | `story.html` is read once and cached in memory for the process lifetime | `server.ts:265-269` |
| B-12 | Progress/admission cleanup timers are per-process, not cluster-wide | `server.ts:405-408` |

## 23. Historically Supported Intent

- Commit `bb7e067` "Add shared API admission control" introduced the admission
  module, migration `0044`, and its integration tests. `git log -S acquireAdmission -- services/api/src/server.ts`
  returns **no commits**: the enforcement layer was never wired in at any point
  in history. The omission is an incomplete implementation, not a regression.
- Commit `eee172b` "Raise campaign archive import limit" and the sequence
  `be454c6`, `5e6a4f7`, `8f8fb70` show sustained recent work hardening campaign
  archive import/export.
- `f3f0038`, `a67330e`, `2e6d877`, `4d4a7ea` added turn-generation phase
  diagnostics, indicating active investment in generation observability.

## 24. Inferred Requirements

Not proven; each requires confirmation.

- **INF-1** `owner_user_id` scoping exists to enable future multi-tenancy.
- **INF-2** The pre-auth posture is a deliberate staged milestone, not an
  oversight, given `authentication: "deferred"` is an explicit API field.
- **INF-3** Very large archive limits target self-hosted single-operator use
  where the operator is trusted with their own resources.
- **INF-4** The absence of paired unit-test files for large API services is a
  deliberate choice to test through integration suites rather than a coverage gap.

## 25. Unknowns Requiring Human Decisions

See `code-review-report.md` §8 for the full decision table. Principal unknowns:
whether admission enforcement is still required; whether the 2 GiB/20 GiB
archive defaults are intended for untrusted networks; whether authentication is
committed; whether `.worktrees` contamination of local test runs is known;
whether a metrics/tracing exporter is required.

## 26. Evidence Index

| Evidence | Location |
| --- | --- |
| Repository state | `git rev-parse HEAD` → `58d0aa2f…`; `git status --short` |
| Route surface | `services/api/src/server.ts:198-1005` |
| Origin/CSP policy | `packages/security/src/{exact-origins,content-security-policy}.ts` |
| Admission implementation | `services/api/src/admission-service.ts`; `database/migrations/0044_api_admission_control.sql` |
| Admission non-use | grep: `acquireAdmission` → only `admission-service.ts` + `tests/integration/admission-control.integration.test.ts` |
| Rate-limit config | `packages/database/src/config.ts:196-201` |
| Documented admission requirement | `docs/superpowers/specs/2026-07-23-p0-network-security-design.md:30,53-54,283,290,311,344,382` |
| SSE stream | `services/api/src/server.ts:724-794` |
| Credential crypto | `packages/story-engine/src/credentials.ts:10-35` |
| Archive safety | `services/api/src/archive-io.ts:187-209,276-360,537-556` |
| Job claiming | `services/api/src/generation-service.ts` (`claimGeneration`) |
| Test collection defect | `pnpm test:unit` → 323 files; `ls tests/unit/*.test.ts` → 56; `find .worktrees -path '*tests/unit*' -name '*.test.ts'` → 267 |
| Corrected unit run | `npx vitest run --dir tests/unit` → 56 files, 664 passed, 2 skipped, 0 failed |
| Type/boundary check | `pnpm check` → exit 0 |
| Integration blocker | `pnpm test:integration` → `password authentication failed for user "infinitequest_test"` |
| Deployment | `Dockerfile`, `compose.yaml`, `deploy/swarm/stack.yaml`, `.github/workflows/ci.yml` |

## 27. Coverage and Limitations

**Reviewed in depth:** `services/api/src/server.ts`, `request-security.ts`,
`admission-service.ts`, `user-service.ts`; `packages/security/src/*`;
`packages/database/src/config.ts`; `packages/story-engine/src/credentials.ts`;
`services/worker/src/worker.ts`; `services/runtime/src/lifecycle.ts`;
`Dockerfile`; `compose.yaml`; `compose.test.yaml`; `.github/workflows/ci.yml`;
`scripts/ensure-test-database.mjs`.

**Reviewed for interfaces and targeted behavior:** `archive-io.ts` (path safety),
`generation-service.ts` (claiming only — 2 263 lines, max CCN 146),
`infinite-worlds-import-service.ts` (progress store only),
`check-repository-boundaries.mjs`.

**Execution validated:** `pnpm check`; unit suite (corrected scope).

**Not reviewed / sampled only:** `apps/web/public/nexus.js` (5 077 lines) and
`story.js` (2 902 lines); the bulk of `generation-service.ts`,
`memory-service.ts`, `image-service.ts`, `world-service.ts`,
`asset-service.ts`, `segmented-illustration-service.ts`,
`world-generator-service.ts`; the 50 SQL migrations (listed and ordered, not
read line by line); the 174 documentation files; `packages/domain/*` and most of
`packages/contracts/*`.

**Blocked:** the PostgreSQL integration suite (environmental, §19).

**Material limitations.** No stakeholder supplied intended behavior, so no
Desired evidence exists and product-intent questions remain Unknown. Browser
client code — the largest and lowest-health area — was not reviewed in depth.
Runtime behavior under load, provider failure, and multi-replica deployment was
not exercised. This specification therefore does not claim complete coverage.
