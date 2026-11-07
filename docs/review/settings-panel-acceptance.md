# Settings panel release acceptance

## Packaged migration and rollback

An isolated Compose project upgraded the database and named volumes initialized by the actual pre-Settings image `e42b2cb8`. Before upgrade there was one bootstrapped owner and no Settings singleton. The candidate image `9d126caa` reached readiness with optional policy and management inputs absent. All 40 effective settings exported from the candidate matched a configuration probe running inside the old image. Both had digest `d5ef2e1e201816b3b88348ca96f395821c23e4702da4e87e92247dc3090c5bff`. Source configuration and existing volumes were preserved throughout the rehearsal.

| Local rehearsal | Observation |
| --- | --- |
| Upgrade and one-time seed | Environment mode, epoch 0, no active revision. Two packaged seed commands returned requested revision 1. |
| Real HTTPS browser | A loopback-only TLS proxy forwarded the exact trusted origin. Chromium unlocked the installed API and restored its session after reload. The API cookie had HttpOnly, Secure, SameSite Strict and a Settings-only path. A PATCH missing CSRF returned 403. GUI Save changed log level to warn in requested revision 2 while the running level stayed info. |
| Activation | Online activation was rejected. After verifying the combined process stopped, maintenance activation succeeded. A database-mode process without policy and one with a mismatched installation ID both rejected startup. An explicitly broken policy path also rejected environment-mode startup. |
| Restart | The packaged operator and second TLS browser check saw active/requested revision 2, epoch 1, warn, and all 40 descriptors. The effective digest was `b57330a655d93c7bae0cdbe9b2e18407901bcffbabbd77be8c55d229877eab20`. |
| Pre-Settings rollback | The original image interpreted all 40 generated environment overrides with the same new digest. Offline verification and the guarded transition succeeded after shutdown. The original image served the owner-scoped campaign list (HTTP 200) with log level warn. Its original PostgreSQL admission insert and conflict-update ran twice, lowering the generation budget from 12 to 11 to 10. The old writes produced count 2, accounted count 0. |
| Historical rollback | The candidate proposed initial snapshot 1 as new revision 3. After old-image shutdown, epoch-checked activation and restart produced active/requested 3, epoch 3, ready, and the original effective digest. The audit retained seed, proposal, activation, environment rollback, historical rollback and reactivation. |
| Four processes and start-first update | A separate Linux + PostgreSQL test started two complete API and two complete worker processes, observed both HTTP readiness endpoints and four ready reports, added a fifth API process within the approved bound, then stopped its predecessor and verified readiness at four. |
| Deployment manifests | Docker rendered the base Compose, base Swarm and optional Swarm override with synthetic inputs. Swarm retained two application services, external database, hard-disabled System Archive on both roles, separate secrets, operator secret on API only, a shared policy config, ten-minute worker stop grace and resource limits. Provider network policy, CORS and Docker socket exposure did not widen. |

The installed browser evidence shows the [staged revision](assets/settings-panel/packaged-tls-stage.png) and [active revision after restart](assets/settings-panel/packaged-tls-active.png). The separate renderer evidence includes [native desktop](assets/settings-panel/native-performance-1440.png), [Web Awesome mobile](assets/settings-panel/web-awesome-performance-390.png), [native User Profile](assets/settings-panel/native-user-profile-desktop.png), and [Web Awesome User Profile](assets/settings-panel/web-awesome-user-profile-mobile.png).

The actual network was loopback-only with a test-local certificate and browser trust scoped to its isolated context. The Compose upgrade used a combined application process. The four-process test used one Linux host. Multi-node Swarm, production ingress, and live provider traffic were outside the executed rehearsal.

## Runtime coverage

Each row is a validated Settings field, stored in the immutable installation revision and applied on activation/restart. The [registry and resolver](../../packages/domain/src/instance-settings.ts), [contract](../../packages/contracts/src/instance-settings.ts), and [browser control tests](../../tests/e2e/settings-panel.e2e.test.ts) cover the complete field set. Every numeric control requires operator-approved bounds, request rates also require an approved tuple, and feature preferences remain subject to deployment/parent gates.

The table's evidence keys refer to [P: scheduler, shared capacity and logging](../../tests/integration/instance-settings-performance.integration.test.ts), [T: transfer limits, frozen policies and expiry](../../tests/integration/instance-settings-transfers.integration.test.ts), [R: request admission and concurrency](../../tests/integration/instance-settings-request-limits.integration.test.ts) with [request body regressions](../../tests/unit/instance-settings-request-limits.test.ts), and [F: active feature preferences and owner boundaries](../../tests/integration/instance-settings-features.integration.test.ts).

| Environment setting | Persisted field | Section | Runtime consumer | Evidence |
| --- | --- | --- | --- | --- |
| `LOG_LEVEL` | `logLevel` | diagnostics | Runtime logger after registration | P |
| `WORKER_POLL_INTERVAL_MS` | `workerPollIntervalMs` | performance | Worker scheduler poll interval | P |
| `TEXT_PROVIDER_CONCURRENCY` | `textProviderConcurrency` | performance | Shared PostgreSQL text-capacity leases for discovery-dependent text paths | P |
| `ARCHIVE_PREVIEW_TTL_SECONDS` | `archivePreviewTtlSeconds` | sharing | Expiry on newly created portable campaign/world previews | T |
| `SYSTEM_ARCHIVE_ARTIFACT_TTL_SECONDS` | `systemArchiveArtifactTtlSeconds` | sharing | System Archive download artifact retention | T |
| `SYSTEM_ARCHIVE_UPLOAD_TTL_SECONDS` | `systemArchiveUploadTtlSeconds` | sharing | Resumable upload expiry | T |
| `SYSTEM_ARCHIVE_CHUNK_BYTES` | `systemArchiveChunkBytes` | sharing | Resumable upload chunk size and maximum upload dependency | T |
| `AI_AUTHORING_JOBS_ENABLED` | `aiAuthoringJobsEnabled` | characters | API intake and worker authoring claims | F |
| `AI_STORY_SOURCE_AUTHORING_ENABLED` | `aiStorySourceAuthoringEnabled` | characters | Story-source intake and source-kind worker handling | F |
| `CAST_EDITING_ENABLED` | `castEditingEnabled` | characters | Cast editing commands and dependent features | F |
| `CAST_DISCOVERY_ENABLED` | `castDiscoveryEnabled` | characters | Discovery admission, claims and publication | F |
| `CAST_AUTO_MATCH_ENABLED` | `castAutoMatchEnabled` | characters | Admission-time identity matching policy and optional mention processing | F |
| `CAST_CONTEXT_ENABLED` | `castContextEnabled` | characters | Cast context contribution in story generation | F |
| `CAST_BACKFILL_ENABLED` | `castBackfillEnabled` | characters | Explicit backfill admission and worker lane | F |
| `WORLD_SHARING_ENABLED` | `worldSharingEnabled` | sharing | Link creation/redemption with owner list/revoke retained | F |
| `SYSTEM_ARCHIVE_ENABLED` | `systemArchiveEnabled` | sharing | System Archive API and worker lane with base Swarm veto | T, F |
| `WORKER_GENERATION_CONCURRENCY` | `workerGenerationConcurrency` | performance | Story slots per worker with role-specific pool floor | P |
| `API_DEFAULT_BODY_LIMIT_BYTES` | `apiDefaultBodyLimitBytes` | performance | Default Fastify request body limit | R |
| `API_IMPORT_BODY_LIMIT_BYTES` | `apiImportBodyLimitBytes` | performance | Portable import request and aggregate multipart bytes | R |
| `API_ASSET_BODY_LIMIT_BYTES` | `apiAssetBodyLimitBytes` | performance | Asset request and original-image byte ceiling | R |
| `API_RATE_LIMIT_WINDOW_SECONDS` | `apiRateLimitWindowSeconds` | performance | Distributed overlapping admission windows | R |
| `API_RATE_LIMIT_PROVIDER_REQUESTS` | `apiRateLimitProviderRequests` | performance | Distributed provider window maximum | R |
| `API_RATE_LIMIT_GENERATION_REQUESTS` | `apiRateLimitGenerationRequests` | performance | Distributed generation window maximum | R |
| `API_RATE_LIMIT_IMPORT_REQUESTS` | `apiRateLimitImportRequests` | performance | Distributed import window maximum | R |
| `API_CONCURRENCY_PROVIDER_REQUESTS` | `apiConcurrencyProviderRequests` | performance | Provider HTTP reservations through upstream/stream termination | R |
| `API_CONCURRENCY_IMPORT_REQUESTS` | `apiConcurrencyImportRequests` | performance | Portable import HTTP reservations through completion | R |
| `CAMPAIGN_ARCHIVE_MAX_COMPRESSED_BYTES` | `campaignArchiveLimits.maxCompressedBytes` | sharing | Campaign archive compressed upload/ZIP byte limit | T |
| `CAMPAIGN_ARCHIVE_MAX_UNCOMPRESSED_BYTES` | `campaignArchiveLimits.maxUncompressedBytes` | sharing | Campaign archive total decompressed byte limit | T |
| `CAMPAIGN_ARCHIVE_MAX_ENTRIES` | `campaignArchiveLimits.maxEntries` | sharing | Campaign archive ZIP entry count | T |
| `CAMPAIGN_ARCHIVE_MAX_EXPANSION_RATIO` | `campaignArchiveLimits.maxExpansionRatio` | sharing | Campaign archive decompression ratio | T |
| `CAMPAIGN_ARCHIVE_MAX_MANIFEST_BYTES` | `campaignArchiveLimits.maxManifestBytes` | sharing | Campaign archive manifest byte count | T |
| `CAMPAIGN_ARCHIVE_MAX_JSON_ENTRY_BYTES` | `campaignArchiveLimits.maxJsonEntryBytes` | sharing | Campaign archive individual JSON entry bytes | T |
| `CAMPAIGN_ARCHIVE_MAX_ORIGINAL_IMAGE_BYTES` | `campaignArchiveLimits.maxOriginalImageBytes` | sharing | Campaign archive original image bytes | T |
| `SYSTEM_ARCHIVE_MAX_COMPRESSED_BYTES` | `systemArchiveLimits.maxCompressedBytes` | sharing | System archive compressed upload/ZIP byte limit | T |
| `SYSTEM_ARCHIVE_MAX_UNCOMPRESSED_BYTES` | `systemArchiveLimits.maxUncompressedBytes` | sharing | System archive total decompressed byte limit | T |
| `SYSTEM_ARCHIVE_MAX_ENTRIES` | `systemArchiveLimits.maxEntries` | sharing | System archive ZIP entry count | T |
| `SYSTEM_ARCHIVE_MAX_EXPANSION_RATIO` | `systemArchiveLimits.maxExpansionRatio` | sharing | System archive decompression ratio | T |
| `SYSTEM_ARCHIVE_MAX_MANIFEST_BYTES` | `systemArchiveLimits.maxManifestBytes` | sharing | System archive manifest byte count | T |
| `SYSTEM_ARCHIVE_MAX_JSON_ENTRY_BYTES` | `systemArchiveLimits.maxJsonEntryBytes` | sharing | System archive individual JSON entry bytes | T |
| `SYSTEM_ARCHIVE_MAX_ORIGINAL_IMAGE_BYTES` | `systemArchiveLimits.maxOriginalImageBytes` | sharing | System archive original image bytes | T |


## Compatibility boundaries

Portable campaign/world import previews now use the configured `ARCHIVE_PREVIEW_TTL_SECONDS` for newly created previews. The preceding constructor used 900 seconds even though the configured default was 1800. Existing expiries are preserved; System Archive preview authority retains its separate fixed 1800 seconds.

New admissions now enforce already configured budgets on these production paths; capacity exhaustion can return 429 and Retry-After. The [exact allowlist](../../services/api/src/request-admission.ts) includes:

- Provider GET/HEAD for a provider's models, presets and preset slug; provider POST for direct text generation, model discovery, preset discovery and preset resolution.
- Generation POST for world generation preview, playable-character generation preview, world draft playable-character generate/organize, campaign character-profile organize, turn-input classify, campaign generations, retry-latest and generation-job retry.
- Portable import POST for preview and commit on legacy-story, world, infinite-worlds and campaign-archive. Existing authoring admission remains separate. Provider configuration CRUD and import progress stay outside these newly admitted routes.

Old buckets with no historical maximum conservatively block new admissions until their existing expiry. Existing accepts can continue to count in overlapping longer windows. An idempotent in-flight duplicate keeps its existing lease when supported. HTTP provider/import reservations remain pinned until actual handler and stream work finish; a stale clock or disconnected client cannot free a live slot. A pre-Settings image cannot enforce those new route and window protections, even with matching environment values. The [rollback procedure](../runbooks/instance-settings.md#return-to-a-pre-settings-binary) therefore requires shutdown, resolved pins and expired new policy windows before transition, with affected traffic kept drained unless equivalent external enforcement is verified.

The [archive round-trip](../../tests/integration/system-archive.integration.test.ts) placed distinctive installation, revision/audit, heartbeat, session and attempt values in the exporting database. The real ZIP excluded them. The destination held a different requested revision; production import preserved all six Settings tables byte-for-byte at the row level, restored providers disabled and issued zero observed fetch calls. The supported Linux suite passed 53/53. Management sessions and attempt buckets no longer make an otherwise empty owner destination appear populated. Other security authority, owner records and live-work exclusions continue to protect restore.

## Final branch checks

The final application changes at `195cbf38` built from a clean Git archive into a production image. The operator in that image exported the role seed. The complete packaged upgrade/rollback rehearsal above was run at its stated earlier checkpoint. The repository checks and both web builds passed. The full unit run passed 5,450 tests (44 skipped). The Settings module is loaded on demand: 30.8 KiB compressed; the main entry is 245.5 KiB, still over the report-only 200 KiB target (the original main entry was 238.4 KiB).

The final Settings, provider, prompt, campaign and User Profile browser selection passed 33/33 with native controls and 33/33 with Web Awesome. The built dashboard integration passed 8/8. The synthetic-provider Story runtime selection passed 42/42 in each renderer. The final Linux image passed all 21 import repository tests and all seven historical adapter matrix tests. Expired imports are refused by timestamp. If a rejected import rolls back its transaction, persisted status retirement is left to cleanup.

The earlier full browser runs were not green. After correcting stale navigation and fixture assumptions, six distinct legacy Story cases also failed on the unchanged starting commit: typing while initial sync is held, keeping the saved turn offset, retaining the pinned resumed turn, two sparse-history draft cases, and intermittent keyboard focus while paging history. These are not covered by the green Settings-only totals.

## Implementation decisions and tradeoffs

| Decision | Consequence |
| --- | --- |
| A deployment veto can suppress a feature; out-of-range numbers reject activation. | Operators must revise invalid settings; numbers never silently change. |
| Rehearse activation only in the disposable installation. | Production activation still needs the operator's maintenance procedure. |
| Keep all personal and device preferences in the user-icon menu. | Users visit a second destination for shared controls; scope stays clear. |
| Work in an isolated Git worktree. | Changes stay on a separate branch until deliberately integrated. |
| Classify each new Settings table in the portability registry immediately. | A transfer cannot silently start carrying installation authority. |
| Use separate disposable PostgreSQL storage. | The rehearsal does not establish compatibility with a particular existing deployment. |
| Require a guard inside the locked activation transaction. | Offline operations must also establish drain and compatibility. |
| A changed policy digest needs a new revision even with identical values. | Revalidating policy can create another history entry. |
| Reuse the domain policy resolver through the application boundary. | New consumers must supply that dependency; there is only one validator. |
| Reset drafts from the original seed under current policy. | Reset can be unavailable if policy no longer allows the original numbers. |
| Apply configured preview lifetime to new portable previews only. | The default changes from the old 900-second fallback to 1,800 seconds; existing expiries stay intact. |
| Validate enabled System Archive chunk size against upload capacity. | Some combinations of individually valid values cannot activate. |
| Block new admissions on old unexpired buckets with unknown maxima. | Some requests may wait through the old window after upgrade. |
| Enforce approved limits on the enumerated production operations. | Previously unmetered requests can now return HTTP 429; cleanup and management remain available. |
| Hold slots for outstanding upstream work; recover a single orphan only after verified shutdown. | Recovery may require operator intervention; a disconnected browser cannot free a running slot. |
| Replace duplicate legacy editors with links to their canonical editors. | Bookmarks continue to work but some workflows navigate to Settings. |
