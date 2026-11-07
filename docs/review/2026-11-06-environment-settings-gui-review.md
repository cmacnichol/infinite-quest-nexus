# Environment settings conversion review

Review date: November 6, 2026; refreshed against local main `e42b2cb8` and checkout `d565746f`. The checkout adds only the separate legacy Previous-navigation fix over local main. The remote main advertised by `git ls-remote` remains `555e97da`; this review uses the newer local main, not that older remote revision. This is a proposal, not an implemented settings migration.

The application can move substantial operational configuration into a dedicated Settings panel. The safe design is database-backed application settings constrained by deployment-owned permissions and resource ceilings. Moving every environment variable into an editable form would expose infrastructure and security decisions to every client that can currently reach the application.

The inventory covers `.env.example`, names in local `.env` and test environment files, the runtime configuration reader, additional application environment reads, Compose, Swarm, and build metadata. Private environment values were not included in this review. Test and development controls are separated from product settings. Deployment-effective values were assessed from committed manifests; running containers and production were not inspected.

## Decision summary

There are **40 named configuration candidates** for UI management in the tables below: seven relatively straightforward operational settings, ten conditional feature/capacity settings, and 23 bounded resource settings. This is a count of candidate names, not 40 controls ready to expose today. Conditional settings retain deployment gates; resource settings cannot exceed operator ceilings. Several candidates are absent from `.env.example` but are implemented in the runtime reader.

The refresh adds `CAST_AUTO_MATCH_ENABLED`, now present in the example, runtime reader, Compose, and both Swarm roles. Its default is false, and its effective value requires discovery and editing. It changes new discovery admission from strict matching with `cast-discovery-prompt-v1` to `unique_name` with `cast-discovery-prompt-v2`; admitted work keeps its frozen policy. It also gates lexical mention tracking after accepted narration/corrections. Mention tracking remains optional and cannot invalidate an accepted story. See [Characters operations](../runbooks/campaign-cast.md) and the [implementation plan](../superpowers/plans/2026-11-06-dedicated-settings-panel.md).

No existing environment value becomes live-editable simply by adding a form. Runtime configuration is loaded at startup, and several consumers capture values when constructing routes, workers, provider clients, or security middleware. A settings service and explicit application semantics are prerequisites.

## Operational settings suitable for conversion

These seven settings can become instance-wide settings after server validation, persistence, and propagation are implemented.

| Environment setting | Current default and bounds | Proposed UI and application behavior |
| --- | --- | --- |
| `LOG_LEVEL` | `info`; currently passed to Pino | Diagnostics → Log detail. Use a fixed supported enum; update every process logger. Preserve redaction. Debug logging must not enable private citation logging. Bootstrap logging still needs a startup default. |
| `WORKER_POLL_INTERVAL_MS` | 2,000; 250–60,000 ms | Performance → Queue polling interval. Apply on the next scheduling iteration; warn about latency/load. |
| `TEXT_PROVIDER_CONCURRENCY` | 2; 1–1,000 | Providers → Shared text request capacity. Constrain by an operator-reviewed capacity ceiling and apply consistently across replicas. Currently the shared capacity object is created only when cast discovery is enabled; do not label this as an unconditional limit on every provider request. |
| `ARCHIVE_PREVIEW_TTL_SECONDS` | 1,800; 60–86,400 seconds | Transfers → Campaign/world preview lifetime. Apply to newly created previews. This does not control System Archive preview authority. |
| `SYSTEM_ARCHIVE_ARTIFACT_TTL_SECONDS` | 86,400; 300–604,800 seconds | Transfers → Export download lifetime. Apply to new artifacts; retain existing recorded expirations. |
| `SYSTEM_ARCHIVE_UPLOAD_TTL_SECONDS` | 86,400; 300–604,800 seconds | Transfers → Inactive upload lifetime. Define policy for new uploads and renewal explicitly; do not unexpectedly expire active transfers. |
| `SYSTEM_ARCHIVE_CHUNK_BYTES` | 16 MiB; 1–64 MiB | Transfers → Maximum upload chunk size. Enforce operator and request-size limits and preserve resumable-session compatibility. |

Defaults and ranges above are from [runtime configuration](../../packages/database/src/config.ts); logging comes from [the logger](../../packages/logger/src/index.ts). Shared capacity is constructed in [provider composition](../../services/runtime/src/provider-application-composition.ts).

## Feature controls suitable only within deployment permissions

These ten settings can have UI controls, but an ordinary saved preference must never override deployment incompatibility or an operator disablement.

| Environment setting | Current default | Safe conversion |
| --- | --- | --- |
| `AI_AUTHORING_JOBS_ENABLED` | false | AI Authoring → Enable durable proposals, after compatible API/worker rollout. Disabling stops new admission and defines drain/pause behavior for queued work; retain proposal cleanup. |
| `AI_STORY_SOURCE_AUTHORING_ENABLED` | true | AI Authoring → Enable source authoring within the durable-authoring capability. Keep world/character jobs available when source intake is paused. This setting is implemented but absent from `.env.example` and base manifests. |
| `CAST_EDITING_ENABLED` | false | Characters → Enable campaign cast editing, within the deployed capability. Disabling must not delete cast records. |
| `CAST_DISCOVERY_ENABLED` | false | Characters → Automatic character discovery. Requires cast editing; show potential text-provider cost and queue effects. |
| `CAST_AUTO_MATCH_ENABLED` | false | Characters → Automatically match unambiguous character names. Requires editing and discovery. Turning it off stops new relaxed admissions and lexical mention work; existing admissions retain their frozen policy. Preserve ambiguity review, undo, narration-revision validation, and the distinction between mentions and physical presence. |
| `CAST_CONTEXT_ENABLED` | false | Characters → Include discovered cast in story context. Requires editing and discovery; affect new jobs only and preserve frozen prompt/continuation compatibility. |
| `CAST_BACKFILL_ENABLED` | false | Characters → Allow historical discovery scans. Requires editing and discovery. Enabling permits scans; it must not automatically launch an unbounded historical scan. |
| `WORLD_SHARING_ENABLED` | false | Sharing → Enable share links, only when the operator permits bearer-token access. Disabling should block creation and redemption while preserving revocation/management access where appropriate. Re-enabling must not silently revive revoked links. |
| `SYSTEM_ARCHIVE_ENABLED` | true in runtime/Compose; forced false in base Swarm | Transfers → Enable System Archive, only inside an operator-verified storage capability. Never let a GUI switch bypass the base Swarm hard-disable or enable API without a compatible worker. |
| `WORKER_GENERATION_CONCURRENCY` | 1; 1–4 per worker | Performance → Story generation slots, within each worker's available connection budget. Increase only after all applicable workers acknowledge capacity; lowering drains existing work and limits new claims. Show aggregate replica impact. |

The runtime requires worker database connections of at least `concurrency + 4` for worker-only and `concurrency + 8` for combined roles. Database pool sizing remains deployment-owned. Feature dependencies are already enforced by [the configuration reader](../../packages/database/src/config.ts), with runtime consumers in [the worker](../../services/worker/src/worker.ts), [API server](../../services/api/src/server.ts), and [cast composition](../../services/runtime/src/campaign-cast-composition.ts).

Retain independent deployment emergency stops for these capabilities. Treat deployment permission and user preference as separate values, with effective enablement requiring both. Do not reinterpret an existing rollout flag as a preference during a mixed-version deployment.

## Resource limits suitable for bounded advanced controls

These 23 settings can be edited in an advanced instance Settings section only within deployment-enforced resource policy. The policy must specify minima as well as maxima where needed: shortening a rate-limit window can increase allowed traffic even when the request count is unchanged. A saved UI value must not raise an operator ceiling or bypass resource review.

| Environment setting | Runtime default | Safe UI boundary |
| --- | --- | --- |
| `API_DEFAULT_BODY_LIMIT_BYTES` | 1 MiB | Runtime accepts 64 KiB–64 MiB; deployment can impose a lower maximum. |
| `API_IMPORT_BODY_LIMIT_BYTES` | 2 GiB | Runtime accepts 1 MiB–2 GiB; coordinate with archive limits. |
| `API_ASSET_BODY_LIMIT_BYTES` | 32 MiB | Runtime accepts 1–64 MiB; coordinate with original-image limits. |
| `API_RATE_LIMIT_WINDOW_SECONDS` | 60 | Runtime accepts 1–3,600 seconds; validate together with request counts. |
| `API_RATE_LIMIT_PROVIDER_REQUESTS` | 10 | Runtime accepts 1–10,000; cap effective request rate. |
| `API_RATE_LIMIT_GENERATION_REQUESTS` | 12 | Runtime accepts 1–10,000; cap effective request rate. |
| `API_RATE_LIMIT_IMPORT_REQUESTS` | 4 | Runtime accepts 1–10,000; cap effective request rate. |
| `API_CONCURRENCY_PROVIDER_REQUESTS` | 2 | Runtime accepts 1–1,000; preserve active reservations while lowering. |
| `API_CONCURRENCY_IMPORT_REQUESTS` | 1 | Runtime accepts 1–1,000; constrain by storage/memory capacity. |
| `CAMPAIGN_ARCHIVE_MAX_COMPRESSED_BYTES` | 2 GiB | Positive integer up to reviewed ceiling and effective API import limit. |
| `CAMPAIGN_ARCHIVE_MAX_UNCOMPRESSED_BYTES` | 20 GiB | Positive integer up to reviewed ceiling. |
| `CAMPAIGN_ARCHIVE_MAX_ENTRIES` | 100,000 | Positive integer up to reviewed ceiling. |
| `CAMPAIGN_ARCHIVE_MAX_EXPANSION_RATIO` | 100 | Positive integer up to reviewed ceiling. |
| `CAMPAIGN_ARCHIVE_MAX_MANIFEST_BYTES` | 5 MiB | Positive integer up to reviewed ceiling. |
| `CAMPAIGN_ARCHIVE_MAX_JSON_ENTRY_BYTES` | 1 GiB | Positive integer up to reviewed ceiling and effective import limit. |
| `CAMPAIGN_ARCHIVE_MAX_ORIGINAL_IMAGE_BYTES` | 25 MiB | Positive integer up to reviewed ceiling and effective asset limit. |
| `SYSTEM_ARCHIVE_MAX_COMPRESSED_BYTES` | 50 GiB | Positive integer up to operator ceiling. |
| `SYSTEM_ARCHIVE_MAX_UNCOMPRESSED_BYTES` | 200 GiB | Positive integer up to operator ceiling. |
| `SYSTEM_ARCHIVE_MAX_ENTRIES` | 1,000,000 | Positive integer up to operator ceiling. |
| `SYSTEM_ARCHIVE_MAX_EXPANSION_RATIO` | 100 | Positive integer up to operator ceiling. |
| `SYSTEM_ARCHIVE_MAX_MANIFEST_BYTES` | 16 MiB | Positive integer up to operator ceiling. |
| `SYSTEM_ARCHIVE_MAX_JSON_ENTRY_BYTES` | 1 GiB | Positive integer up to operator ceiling. |
| `SYSTEM_ARCHIVE_MAX_ORIGINAL_IMAGE_BYTES` | 25 MiB | Positive integer up to operator ceiling. |

Archive ceilings and parsing are defined in [runtime configuration](../../packages/database/src/config.ts). [Archive routes](../../services/api/src/archive-routes.ts) combine campaign archive and HTTP limits. Some HTTP limits are installed when routes/server are constructed: a first implementation can explicitly mark these as requiring an API restart. Genuine live changes require enforcement before buffering and consistent middleware reconfiguration, not merely a database update after a body has been accepted.

For in-progress archives, define compatibility before changing limits: do not silently relax an approved preview or invalidate staged authority. Enforce current safety ceilings and require a fresh preview when the effective policy materially changes. System Archive's independent 1,800-second database-clock preview expiration remains fixed.

## Settings that should remain outside normal GUI editing

The panel can show sanitized status for these settings. It should not write them to `.env`, update container manifests, rotate secrets, or restart deployment services.

| Environment setting or family | Reason |
| --- | --- |
| `DATABASE_URL`, `DATABASE_URL_FILE` | Bootstrap connection and secret; needed before database-backed settings can load. Never return connection strings. |
| `POSTGRES_PASSWORD`, `POSTGRES_USER`, `POSTGRES_DB` | Database/container provisioning. Root Compose fixes user/database and interpolates the password. Test files have separate provisioning values. |
| `CREDENTIAL_ENCRYPTION_KEY`, `CREDENTIAL_ENCRYPTION_KEY_FILE` | Root encryption authority. Changing it can make existing provider credentials unreadable; requires a separate rotation/recovery operation. |
| `APP_ROLE`, `APP_HOST`, `APP_PORT` | Process role, listener and published port topology. Compose `APP_PORT` changes the host port while the container stays on 8080. |
| `DATABASE_MAX_CONNECTIONS` | Per-process bootstrap pool and cluster-wide connection budget. GUI worker slots must stay below this deployment capacity. |
| `MIGRATION_DIRECTORY`, `MIGRATION_WAIT_SECONDS`, `ALLOW_MAINTENANCE_MIGRATIONS` | Startup/schema control; maintenance opt-in must remain an explicit operator action. |
| `WORKER_LEASE_SECONDS` | Recovery and lease safety. Keep separate from ordinary queue polling; changing it needs shutdown/reclaim/heartbeat validation. |
| `ASSET_STORAGE_ROOT`, `ARCHIVE_STORAGE_ROOT` | Durable mounts and asset authority; changing paths is a migration, not a preference. |
| `ASSET_STORAGE_DRIVER` | Currently hardcoded to `filesystem`; the environment entry does not select an implemented alternate driver. Show status, not a misleading dropdown. |
| `LEGACY_WEB_ROOT`, `NEXT_WEB_ROOT` | Built static asset paths and route coexistence. |
| `CORS_ALLOWED_ORIGINS` | Browser trust boundary; changing it can grant cross-origin access to the pre-auth application. |
| `PROVIDER_NETWORK_ALLOWLIST` | Server outbound network permission and SSRF boundary. Provider setup may choose only destinations allowed by deployment policy. |
| `CSP_IMAGE_ALLOWED_ORIGINS` | Browser content-security boundary. Keep operator-owned; a future UI may select a subset of preapproved origins. |
| `TRUST_PROXY_HOPS` | Deployment-specific client-IP trust affecting request controls. |
| `SYSTEM_ARCHIVE_ALLOW_UNKNOWN_FREE_SPACE` | Explicit override of fail-closed capacity measurement; do not offer an ordinary checkbox. |
| `SYSTEM_ARCHIVE_ALLOW_LIMIT_INCREASE` | Operator exception to reviewed ceilings. UI limits remain constrained even when this deployment exception exists. |
| `NATIVE_TEXT_EXECUTION_PLAN_ADMISSION` | Mixed-version execution/reader compatibility gate. Keep until the rollout is complete; retire separately when no longer needed. |
| `HISTORY_COVERAGE_ENABLED` | New-job prompt protocol/compatible-reader rollback gate, not a reader preference. |
| `STORY_MEMORY_CAPABILITY`, `STORY_MEMORY_ENFORCE_ENABLED` | Operator capability ceilings. Campaign memory level/review choices already belong in the GUI underneath these ceilings. |
| `TEXT_SCHEMA_VERIFICATION_FILE` | Operator-reviewed evidence registry. A normal settings save cannot establish verified model/schema support. Display status and expiration; importing verified evidence needs a separate reviewed workflow. |
| `AI_AUTHORING_CITATION_DEBUG_JOB_ID` | Targeted sensitive-content troubleshooting. Do not expose raw source/citation logging through ordinary Diagnostics. |
| `NODE_ENV` | Runtime/build mode and logging transport behavior. |
| `NEXUS_IMAGE`, `NEXUS_PORT` | Swarm image deployment and published port. |
| `SYSTEM_ARCHIVE_VALIDATION_NODE` | Validation-only Swarm placement constraint; selects the reviewed node for a transfer drill, not a product preference. |
| `NEXUS_VERSION`, `NEXUS_BUILD_COMMIT`, `NEXUS_BUILD_DATE`, `NEXUS_BUILD_DIRTY`, `npm_package_version` | Build identity; show read-only in About. |
| `VITE_UI_COMPONENTS`, Vite `BASE_URL` | Build-time UI implementation/base path; cannot be changed by a runtime settings save. |
| `TEST_DATABASE_URL`, `TEST_POSTGRES_PORT` | Test harness configuration; not application settings. Other benchmark, fixture, test-runner and CI-only environment controls likewise stay with tooling. |
| `WEB_ROOT`, `LEGACY_INDEX_PATH` | Names found in local environment files but not consumed as current application configuration. Treat as stale candidates for operator cleanup after checking external launch scripts; do not create UI settings for them. |

See [deployment guidance](../runbooks/deployment.md), [identity and ownership](../concepts/identity-and-ownership.md), [provider configuration](../installation/provider-configuration.md), and [the Swarm stack](../../deploy/swarm/stack.yaml).

## Existing UI settings to consolidate

The dedicated panel should reuse existing authorities rather than introduce a second settings store for them:

- **Providers:** existing separate Story text, Chronicle embedding, and Illustration profiles; endpoints, model selections and safe options. Credentials remain write-only through the existing encrypted server path, never returned or reused across roles. These are already UI-managed, not environment migrations.
- **Personal preferences stay under User Profile in the user icon menu:** reader width, font, spacing, theme, continuous reading, choice submission, and default turn-control style. Preserve user scope, as defined in [user contracts](../../packages/contracts/src/users.ts). Do not duplicate these controls in general Settings.
- **Device preferences also stay in User Profile**, under On this device: the replacement client's theme, story width and artwork visibility remain browser-local. Plan user-scoped keys and cross-tab handling, with one-time migration of existing unscoped values only for the initial owner; do not silently migrate them into server reader preferences or let later users inherit them.
- **Prompt Library:** reuse application/campaign override, preview and reset APIs; preserve inheritance, protected validation and campaign scope. It belongs in consolidated navigation without becoming installation configuration.
- **Campaign settings:** Story Memory, continuity review, context budgets, generation and illustration choices. Keep explicit campaign selection and existing campaign APIs; an installation preference must not silently overwrite campaigns or immutable world versions. [The Nexus UI](../../apps/web/src/nexus.js) already reads/writes campaign Story Memory.
- **About and deployment status:** effective capabilities, build identity, approved resource ceilings, restart requirements and masked provider credential presence. Never dump arbitrary environment variables or filesystem secrets into a diagnostics response.

General Settings navigation: Providers, Prompts, selected Campaign settings, Characters and AI Authoring, Sharing and Data Transfer, Performance and Requests, and Diagnostics and Deployment. Personal preferences remain exclusively under the user icon's User Profile. Label every general-panel field's scope: selected campaign, owner-scoped provider/prompt, or installation. Placement in the general panel must not grant cross-user access or make owned providers shared. Keep advanced resource controls collapsed by default. Show why a deployment-locked control is unavailable.

## Implementation requirements

1. Add a typed, explicitly allowlisted instance-settings contract and database repository. Do not place global security or worker controls into the existing permissive user-settings object. Keep user/provider/campaign ownership separate from installation policy.
2. Use code defaults, explicit legacy environment seeds, persisted preferences, and operator locks with documented precedence. Recommended model: preserve existing effective behavior during migration; import approved legacy values once; afterwards persist preferences in PostgreSQL while deployment gates and ceilings always win. Do not re-seed at every restart. Provide a separately documented emergency override.
3. Return requested value, effective value, permitted range, source/lock reason, revision and application status. Use revision checks to prevent lost updates and record an audit trail without credentials or private content.
4. Protect installation changes through an explicit management boundary. The current server-resolved initial user provides ownership scoping, not administrator authentication. Before broad instance/security controls are writable, require an operator-protected management surface or real administrative authorization. An admin-looking tab alone is not protection. Preserve the existing internal user identity.
5. Coordinate API and worker settings across replicas. Apply a revision at safe boundaries; retain it with new durable jobs where behavior affects generation. Do not change frozen response routes, accepted turns or active provider requests. Invalidate/rebuild compatible response chains when relevant prompt configuration changes.
6. Expose restart-required status honestly for startup-bound settings. Do not grant the application Docker socket access just to apply settings. Live toggles need dynamic route admission, worker-lane lifecycle and capability reporting rather than mutations to an object already captured at startup.
7. Fail closed on invalid security/resource settings; reject invalid form values instead of silently clamping them. Keep a last-known-valid snapshot with an explicit stale state where appropriate. Coordinate the effective rate and concurrency policy, rather than validating every field independently.
8. Keep installation policy nonportable by default. Importing a world, campaign or System Archive must not grant network access, enable sharing, raise capacity, activate credentials, or override destination deployment restrictions.

## Recommended delivery order

1. Build the dedicated general panel and settings service, consolidate provider/prompt/campaign entry points while preserving their ownership, keep personal/device settings under User Profile, and show deployment status read-only. Add multi-user isolation fixtures and user-scoped browser preferences before claiming readiness for later login support.
2. Move the seven operational candidates, starting with retention and logging. Implement cross-process revision application and safe transfer semantics before enabling saves.
3. Add bounded archive/resource controls. Explicitly mark startup-bound HTTP controls as restart-required until a live enforcement design is verified.
4. Add the ten conditional controls only after deployment capability checks, management authorization, drain behavior and mixed-version handling exist. Never remove rollout gates as incidental settings cleanup.

## Configuration discrepancies to resolve during implementation

- `.env.example` is not the full configuration contract: the reader implements additional TTLs, archive limits, rate limits, proxy trust, lease duration and source-authoring controls.
- A `.env` entry is not necessarily container-effective. Root [Compose](../../compose.yaml) does not forward `LOG_LEVEL`, `WORKER_POLL_INTERVAL_MS`, `MIGRATION_WAIT_SECONDS`, `ALLOW_MAINTENANCE_MIGRATIONS`, or the three example `API_*_BODY_LIMIT_BYTES` entries. It supplies fixed role, storage paths and web roots, and constructs `DATABASE_URL` from `POSTGRES_PASSWORD`.
- The base Swarm stack deliberately forces System Archive off. Matching path strings do not establish shared storage across nodes.
- `ASSET_STORAGE_DRIVER` is not actually parsed into a choice. Local `WEB_ROOT` and `LEGACY_INDEX_PATH` entries have no current runtime reader.
- `TEXT_PROVIDER_CONCURRENCY` currently becomes shared capacity only in the cast-discovery-enabled provider composition. UI wording must reflect that scope unless implementation broadens it deliberately.

## Verification and limitations

Passed: static inventory of application runtime reads and manifests; names-only inspection of local environment files; comparison with existing UI/contracts and related configuration tests; local report-link and whitespace checks.

Application tests, real PostgreSQL tests, rendered-browser screenshots, live-provider checks and deployment checks were not run: this change is a review document only. No runtime configuration, secrets, application behavior or UI was changed. Candidate safety is conditional on the implementation requirements above; this review does not certify current hot reload or production readiness.
