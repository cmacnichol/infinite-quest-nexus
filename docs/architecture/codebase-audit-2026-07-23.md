# Infinite Quest Nexus codebase audit

**Date:** 2026-07-23
**Scope:** Active application code, database migrations, deployment manifests, browser clients, tests, documentation, and the retained legacy client.

## Executive assessment

Infinite Quest Nexus has a sound core: PostgreSQL is authoritative, worlds and campaigns are properly separated, accepted turns are durable, story and Chronicle jobs are leased and idempotent, provider credentials are server-side, and text and image providers are independent. The current product is best described as a **persistent AI storytelling platform with optional light percentile mechanics**, not yet a comprehensive RPG platform.

The main risk is inconsistency at the edges. Some newer features follow the durable worker architecture, while other paid or long-running provider operations still execute inside stateless API processes. Several browser features render data the API never returns, and several substantial functions are only reachable from tests. The world schema preserves RPG-shaped data but does not validate most of it, while the editor cannot author most of what the product documentation says it can.

Production or untrusted-network deployment should be blocked until the P0 items are corrected. Feature expansion should begin only after those items and the P1 contract gaps are addressed.

## Audit method and validation

The review covered the complete tracked source tree and followed active routes from both browser clients through API services, shared contracts, database state, workers, providers, deployment manifests, and tests. The 536 KB root `index.html` was classified separately because the repository explicitly retains it as historical reference.

| Validation | Result |
| --- | --- |
| Repository boundary/data checks and TypeScript check | Passed |
| JavaScript syntax checks | Passed |
| Unit tests | 32 files, 278 tests passed |
| PostgreSQL/pgvector integration tests | 9 files, 81 passed, 3 intentionally skipped |
| Application build | Passed |
| VitePress documentation build | Passed; Mermaid contributes a chunk-size warning |
| Database used for audit | Disposable PostgreSQL 18 + pgvector 0.8.5 container |

The integration test command silently skips its database tests when `TEST_DATABASE_URL` is absent. A green default test run therefore does not currently prove database behavior.

## Priority definitions

- **P0 — release blocker:** security, data exposure, duplicate paid work, or broken production health behavior.
- **P1 — high:** an architectural promise is bypassed, an active feature is disconnected, or authoritative data is insufficiently validated.
- **P2 — medium:** important RPG/storytelling capability, maintainability, observability, or documentation gap.
- **P3 — cleanup:** harmless legacy, duplicate surface, or low-risk quality issue.

## P0 findings

### P0-1: The default CORS policy grants arbitrary websites credentialed API access

**Evidence:** `packages/database/src/config.ts:67` defaults to `["*"]`. `services/api/src/server.ts:175-195` reflects any request origin, enables credentials, permits every mutating method, and advertises `X-User-Id`. There is no interactive authentication, and all calls resolve to the initial owner.

**Impact:** A malicious website opened in a browser can make cross-origin JSON requests to a local or LAN Nexus instance, read private campaigns, alter or delete content, and trigger provider work. Restricting the server to a trusted LAN does not prevent browser-based cross-origin requests.

**Correction:**

1. Default to same-origin only. Treat an empty allowlist as no cross-origin access, not wildcard access.
2. Reject unapproved `Origin` values before routing; do not merely omit the response header.
3. Remove `X-User-Id` from allowed headers and add explicit CSRF protection before credentialed cross-origin access is ever enabled.
4. Permit credentials only for a specific allowlisted origin that actually requires them.
5. Add tests for hostile origins on read, write, delete, import, generation, and provider routes.

**Acceptance:** With default settings, all foreign origins receive 403 for API requests and preflight. A configured exact origin works; subdomain, scheme, and port variants do not.

### P0-2: Provider URLs create a server-side request-forgery boundary

**Evidence:** `packages/contracts/src/generation.ts:19-31` validates that provider base URLs use HTTP or HTTPS but imposes no destination policy. Model discovery and provider calls accept saved and unsaved URLs and run from the API or worker network.

**Impact:** Anyone able to call the API can probe private network services, cloud metadata endpoints, or loopback addresses. Wildcard CORS makes this remotely triggerable through a victim's browser.

**Correction:**

1. Introduce a centralized outbound provider policy.
2. Resolve DNS and block loopback, link-local, multicast, metadata, and private ranges by default; make private inference networks an explicit administrator allowlist.
3. Revalidate every redirect and use connection-level address validation to reduce DNS rebinding risk.
4. Apply the same policy to discovery, health, text, embedding, and image calls.
5. Log the approved destination identity without credentials.

**Acceptance:** Tests cover literal IPs, IPv6, encoded addresses, redirects, DNS rebinding simulation, allowed private inference hosts, and public HTTPS hosts.

### P0-3: Streaming persists and returns raw partial model output

**Evidence:** `services/api/src/generation-service.ts:1434-1452` repeatedly stores the accumulating provider response in `generation_jobs.partial_output`. `services/api/src/server.ts:672-710` returns both `partialOutput` and `partialNarration`. `apps/web/public/story.js:1167-1177` falls back to a regular expression over raw partial JSON when safe narration is unavailable.

**Impact:** An incomplete structured response can expose scratch data, private state, parser diagnostics, mechanics, or future hidden fields to the player. Each SSE client also polls PostgreSQL about every 350 ms, creating a connection/query amplification path and no durable ordered replay.

**Correction:**

1. Never persist or transmit the raw provider stream.
2. Parse incrementally in the worker and emit only validated narration fragments.
3. Add a durable `generation_stream_events` table with monotonically increasing event IDs, bounded retention, replay through `Last-Event-ID`, batching, and heartbeats.
4. Remove `partialOutput` from the public contract and remove the client regex fallback.
5. Add proxy buffering controls, disconnect cleanup, per-user connection limits, and slow-client tests.
6. Update `docs/operations/deferred-improvements.md`, which describes an older all-buffered state and no longer matches the implementation.

**Acceptance:** A fixture containing private fields before, inside, and after narration proves that only narration bytes ever reach the browser or stream-event table.

### P0-4: Image and illustration-refinement leases are not renewed

**Evidence:** `services/api/src/image-service.ts:743-890` claims an image job and may submit, poll, and download under a fixed lease, but has no heartbeat. `services/api/src/segmented-illustration-service.ts:686-792` similarly performs a text-provider refinement call under one fixed lease. The default lease is 60 seconds (`packages/database/src/config.ts:64`).

**Impact:** A second worker may reclaim an in-progress job and issue a duplicate paid request. Synchronous image providers are most exposed because there may be no remote job ID to resume. Completion paths also need fencing so a stale worker cannot overwrite the new owner's result.

**Correction:**

1. Add a lease heartbeat shorter than one third of the lease duration.
2. Tie provider abort signals to lease loss and process shutdown.
3. Fence every state transition with `id`, `lease_owner`, and generation/revision.
4. Persist remote identity before lease release, then resume polling rather than resubmitting.
5. Do not enqueue child work unless the fenced completion update affected one row.

**Acceptance:** Two-worker tests stall each provider phase beyond lease duration and demonstrate one paid submission, one winning completion, and safe restart recovery.

### P0-5: The Swarm worker health command calls a nonexistent export

**Evidence:** `deploy/swarm/stack.yaml:82` calls `c.databaseConfig()`. The built `packages/database/src/config.js` exports only `loadRuntimeConfig`.

**Impact:** Healthy worker containers fail their health check, causing restart, rollout, or rollback instability.

**Correction:** Add a supported runtime `healthcheck` command that loads configuration, opens a bounded database connection, checks the expected schema, closes the pool, and exits. Use that command in Compose and Swarm and execute the exact built-image health command in CI.

**Acceptance:** The health command succeeds in a healthy built container, fails on database/schema failure, and leaves no open process or connection.

### P0-6: Security headers and request limits are too permissive for an unauthenticated API

**Evidence:** `services/api/src/server.ts:167` sets a global 64 MB body limit. `services/api/src/server.ts:175` permits inline script/style, arbitrary image origins, and arbitrary connection origins. There are no route-specific rate, concurrency, or provider-cost quotas.

**Impact:** An injection can exfiltrate data to any origin, and anonymous callers can consume memory, storage, worker capacity, and paid provider quota.

**Correction:** Use CSP nonces or hashes, restrict `connect-src` to same origin, proxy or explicitly allow image origins, define route-specific body limits, and add user/IP concurrency and rate limits for import, generation, discovery, and provider calls. Send HSTS only when TLS is actually terminated for the request.

**Acceptance:** CSP is enforced without `unsafe-inline`; oversized routes fail early; repeated generation/import calls are bounded and observable.

## P1 findings

### P1-1: Long-running provider work still runs in stateless API replicas

**Evidence:** World generation, character generation/organization, Infinite Worlds conversion/enrichment, generic text proxying, intent classification, and semantic context preview call providers from API request handlers. `services/api/src/infinite-worlds-import-service.ts:42` stores progress in a process-local `Map`; its key at line 435 is only `sourceName + sourceText.length`.

**Impact:** Restart loses progress, identical-length imports collide, another API replica returns no progress, browser retries can duplicate cost, and the API is no longer stateless.

**Correction:** Move all paid, mutating, or long-running provider operations to durable owner-scoped jobs with UUID IDs, idempotency keys, attempts, leases, progress, cost events, and restart recovery. Keep synchronous classification only if explicitly bounded, cheap, idempotent, and documented.

**Acceptance:** Submit through API replica A, poll through replica B, restart both API replicas and a worker, and receive one durable result with one provider attempt.

### P1-2: The worker can starve lower-priority job classes

**Evidence:** `services/worker/src/worker.ts:1-51` imports job implementations from `services/api` and processes generation, refinement, resolution, image, Chronicle, then asset backfill through a short-circuit chain. A continuous generation queue prevents lower classes from being sampled.

**Correction:** Move worker handlers to shared/domain worker packages. Add weighted round-robin scheduling or independent bounded queues/pools, per-class concurrency, queue age metrics, and graceful shutdown.

**Acceptance:** Under a saturated generation queue, image, Chronicle, and backfill jobs still meet documented maximum queue-age targets.

### P1-3: Published world content is largely untyped

**Evidence:** `packages/contracts/src/world-library.ts:89-100` validates `entities`, `relationships`, `rpgStats`, `defaultTriggers`, `eventTriggers`, and `assets` as arrays of `unknown`; defaults are arbitrary. Invalid mechanics are later safe-parsed and silently discarded.

**Impact:** A world can publish successfully while containing unusable mechanics or dangling relationships. The authoritative snapshot is syntactically valid but semantically unreliable.

**Correction:** Create versioned schemas for entities, relationships, stats, triggers, trackers, defaults, and asset references. Validate reference integrity and unique IDs at draft update and publication. Preserve older versions with explicit adapters/migrations and return field-level errors rather than dropping records.

**Acceptance:** Publishing rejects invalid IDs, dangling references, invalid trigger operators, duplicate keys, and incompatible schema versions; old exports migrate deterministically.

### P1-4: The World Library editor preserves but cannot author most structured world data

**Evidence:** `apps/web/public/nexus.js:678-702` edits overview/lore/rules and playable characters, while copying entities, relationships, world stats, triggers, and assets unchanged from the existing object.

**Impact:** Documentation presents a structured world-authoring surface that does not exist. Imported data may survive a save, but users cannot comprehensively create or maintain it.

**Correction:** Add structured editors for entities, relationships, world mechanics, events/triggers, trackers, assets, and defaults. Include stable IDs, search/reference pickers, validation, reorder support, and a publication readiness view. Until complete, documentation must distinguish “preserved/imported” from “editable.”

**Acceptance:** A user can create a world containing interconnected entities, mechanics, triggers, assets, and a playable character entirely through the UI, publish it, export/import it, and start a campaign without data loss.

### P1-5: Mechanics UI is disconnected from the turns API

**Evidence:** `apps/web/public/story.js:399-456` renders rolls and before/after events. `services/api/src/server.ts:489-508` does not select or return `mechanics_private`.

**Impact:** The implemented player mechanics panel never receives its data. Returning `mechanics_private` directly would be unsafe because it includes private rationale and trigger details.

**Correction:** Define a player-safe mechanics DTO containing only the roll outcome, disclosed modifiers, visible consequences, and public event labels. Map private mechanics to this DTO server-side and add browser behavior tests.

**Acceptance:** A generated mechanics turn displays its public roll and effects; hidden rationale and suppressed triggers never appear in the network response.

### P1-6: Cancellation is implemented in pieces but not as a product feature

**Evidence:** `packages/story-engine/src/providers.ts:764` exports image-provider cancellation and Sogni adapters support it, but no service route or UI calls it. Image jobs already include a `cancelled` state. `apps/web/public/story.js:922-974` creates an abort controller and reports “Generation cancelled,” but no generation cancel control invokes it.

**Correction:** Choose one explicit contract:

- finish durable cancellation with `cancel_requested`, provider cancellation where supported, lease fencing, terminal audit status, and clear billing caveats; or
- remove unreachable cancellation adapters/status/UI messages until it is scheduled.

Browser abort alone must never imply that durable provider work was cancelled.

**Acceptance:** Closing or aborting the browser leaves the job running; pressing an explicit cancel action produces a deterministic durable state and provider cancellation attempt.

### P1-7: Provider profiles allow incompatible type/role combinations

**Evidence:** The UI constrains roles, but the shared API schema does not reject combinations such as a Sogni image provider assigned to a text role.

**Correction:** Define a single provider capability matrix in shared contracts/domain code and enforce it in create, update, defaults, campaign assignment, discovery, and worker load paths.

**Acceptance:** Direct API tests reject every invalid provider type/role/model combination with an actionable field error.

### P1-8: Provider health, cost, and history are incomplete

**Evidence:** Story generation does not consistently update provider health. Cost tracking omits world/character generation, organization, Infinite Worlds conversion, and generic text proxy calls. `services/api/src/provider-service.ts:389-393` deletes generation and image jobs when a provider profile is deleted.

**Impact:** Health can be stale, spending is understated, and provider deletion destroys operational history.

**Correction:** Use one provider-attempt wrapper for health, latency, timeout, cost, correlation, and redaction across all operations. Replace destructive provider deletion with retirement/soft deletion; retain an immutable provider snapshot on historical attempts and block deletion while jobs are active.

**Acceptance:** Every provider call—successful or failed—creates an attributable attempt record, and retiring a profile preserves jobs, turns, image history, and cost totals.

### P1-9: Campaign mechanics configuration remains in an opaque legacy JSON field

**Evidence:** `services/api/src/generation-service.ts:1096-1097` reads active `useRpgStats` and `suppressEventTriggers` behavior from `legacy_settings`. A player-config endpoint exists at `services/api/src/server.ts:621`, but the active browser does not call it.

**Correction:** Migrate active settings into a typed campaign mechanics configuration with revision/audit history. Keep `legacy_settings` only as an import/export compatibility adapter. Add a campaign settings UI.

**Acceptance:** Settings are discoverable and editable in the active UI, validated by the shared schema, revision-protected, and round-trip through portable exports.

### P1-10: Model-authored tracker updates are too permissive

**Evidence:** Tracker updates are arrays of unknown records (`packages/contracts/src/generation.ts:376` and related schemas), and merge logic accepts arbitrary fields and synthesizes identifiers.

**Correction:** Replace snapshots with typed operations such as `{trackerId, operation, value}`. Permit only configured trackers and allowed value types unless the world explicitly allows creation. Validate limits and record before/after state.

**Acceptance:** The model cannot rename system trackers, inject fields, change types, or create trackers without permission.

### P1-11: Compose configuration and Swarm asset assumptions are misleading

**Evidence:** The environment guide acknowledges settings present in `.env.example` but not forwarded by root Compose. Swarm spreads API and worker replicas while bind-mounting the same `/srv/infinitequest/assets` path, which is only safe if operators provide genuinely shared storage.

**Correction:** Make the runtime environment contract identical in Compose and Swarm. Require a documented shared-volume driver/NFS configuration, or constrain all asset-consuming replicas to one node until shared storage is verified. Add an asset-writability readiness probe.

**Acceptance:** Every documented variable changes runtime behavior in both modes, and an asset written by any worker is immediately readable by every API replica.

## P2 findings: RPG and storytelling completeness

The recommended direction is a **system-neutral narrative RPG layer**. Do not hard-code one tabletop system into the Story Engine. Worlds should select an optional rules profile, and campaigns should persist typed state regardless of which provider writes the prose.

| Capability | Current state | Recommended addition | Priority |
| --- | --- | --- | --- |
| Core checks | One-stat percentile target with modifiers | Rules profiles, critical bands, opposed/group checks, advantage/disadvantage, degrees of success, transparent public outcomes | P1/P2 |
| Character state | Profile plus stats; limited runtime editing | Typed resources, conditions, abilities, inventory/equipment, currency, progression, and reviewed advancement | P1/P2 |
| Campaign objectives | Open threads and facts exist internally | Player-facing quests, objectives, clocks, milestones, rewards, and completion history | P2 |
| Relationships/factions | World arrays are opaque and not editable | Typed entity graph, faction reputation, relationship state, discoveries, and campaign-local overrides | P2 |
| Encounters | Narrative-only | Optional initiative/turn order, participants, threats, conditions, damage/resource operations, and escape/de-escalation; keep it rules-profile driven | P2 |
| Party play | One selected protagonist snapshot | Party roster, companions, active point of view, party resources, and explicit protagonist switching | P2 |
| Time and place | Mostly prose/facts | Scene records, location graph, campaign clock/calendar, travel, and current-presence state | P2 |
| Player Chronicle | Management/state surfaces | Journal, recap, codex, discovered lore, timeline, quest log, relationship view, bookmarks, and search | P1/P2 |
| Narrative controls | Fixed four choices plus custom action | Configurable choice count/style, pacing, POV, tense, genre intensity, recap cadence, and “no suggested choices” mode | P2 |
| Safety | No dedicated contract | Content rating, lines/veils, tone boundaries, phobias, fade-to-black controls, and safety-aware prompt/validation rules | P1 |
| Branching | Accepted ledger and replacement support | Explicit save points, alternate-timeline forks, branch comparison, and canonical-branch selection | P2 |
| GM/collaboration | Single initial owner | Authentication/OIDC, sharing, player/GM roles, private GM notes, invitations, and audit log after network security is hardened | P2/P3 |
| Accessibility | Responsive UI but no full evidence | Keyboard-first play, focus management, screen-reader live regions for streams, reduced motion, contrast themes, image alt-text workflow | P1/P2 |

### Product sequencing

1. First expose the strong existing Chronicle and campaign state through player-safe views.
2. Add typed inventory, resources, conditions, quests, and clocks; these create more value than a large combat engine.
3. Introduce rules profiles and operation-based state changes.
4. Add optional encounters, party play, and progression.
5. Add shared play only after authentication and authorization exist.

## P2 findings: testing, maintainability, and operations

### P2-1: Browser behavior is tested mostly as source text

Many tests assert that CSS classes, route strings, or SQL fragments occur in source. There is no comprehensive real-browser suite for world creation, campaign play, streaming, restart recovery, image failure, or mobile/accessibility behavior.

**Correction:** Add Playwright end-to-end tests using PostgreSQL and deterministic text/image mocks. Cover first run, provider setup, world authoring/publication, campaign creation/switching, generation/refresh/replay, mechanics disclosure, image failure/retry/cancel, import/export, responsive layouts, keyboard navigation, and cross-origin rejection.

### P2-2: Database tests can silently disappear

**Correction:** Make CI and the default comprehensive test command fail when the test database is unavailable. Keep a separately named `test:integration:optional` only for deliberately database-free local work. Report executed and skipped counts as CI artifacts.

### P2-3: No coverage/dead-code enforcement

**Correction:** Add ESLint, TypeScript unused checks where package entrypoints allow them, dependency-boundary checks, and behavior-oriented coverage thresholds. Avoid using coverage percentage as a substitute for failure-path tests.

### P2-4: Deployment smoke requirements are not automated

**Correction:** In CI, render both manifests, build the image, start the two-container Compose stack, wait for readiness, verify migrations/initial owner, perform a database-backed API operation, exercise `all`, `api`, `worker`, and `migrate` roles, and run the exact Swarm health commands.

### P2-5: Worker and queue observability is incomplete

**Correction:** Add worker heartbeat records and queue metrics for depth, oldest age, lease loss, retries, dead letters, provider latency, and per-operation cost. Expose an operator-only health summary without story content or credentials.

### P2-6: The active web clients are monolithic

`apps/web/public/nexus.js` is about 4,100 lines and `story.js` about 2,600 lines. This encourages shared mutable state, compatibility fallbacks, and string-based tests.

**Correction:** Incrementally split API clients, state stores, rendering components, forms, streaming, and domain mappers into ES modules. Establish browser unit tests around those modules before considering a framework rewrite.

### P2-7: API and documentation contracts are incomplete or stale

There is no generated OpenAPI reference for the large route surface. `docs/operations/deferred-improvements.md` contains obsolete streaming assumptions. Two ADRs use the `0011` number, and historical checkpoint documents remain mixed into operational guidance.

**Correction:** Generate OpenAPI from shared schemas, test route/schema conformance, update the streaming document, renumber/index ADRs, and move completed checkpoints to project history. Correct capabilities language until the structured World editor exists.

## P3 legacy and dead-code inventory

| Item | Classification | Action |
| --- | --- | --- |
| Root `index.html` | Intentional historical reference; not served as the active application | Keep unchanged and verify repository checks continue preventing bundled user data |
| `demo_version.html` in `AGENTS.md:153` | Stale repository description; file is absent | Remove the reference or explicitly restore/archive the file |
| `characterTextFromSnapshot` in `packages/domain/src/world-characters.ts:141` | Export has no production or test caller | Remove and let unused-export checks prevent recurrence |
| `enqueueAcceptedTurnIllustration` in `services/api/src/image-service.ts:319` | Older single-image workflow; only tests call it after segmented illustrations replaced it | Remove after confirming no migration path depends on it; update tests to the segmented workflow |
| `listAssets` in `services/api/src/asset-service.ts:617` | Compatibility wrapper used only by tests | Remove and test `queryAssets` |
| `listWorldVersionPlayableCharacters` in `services/api/src/world-service.ts:634` | Compatibility wrapper used only by tests | Remove and test the active summary query |
| `/api/v1/provider-text/generate` | Generic paid prompt proxy, unused by active UI/docs | Remove, or make it an authenticated administrator diagnostic with quotas and attempt logging |
| `/api/v1/assets/facets` | Unused duplicate; the assets query already returns facets | Remove after a deprecation check |
| User profile route aliases | Multiple GET/update forms for the same resource | Choose one canonical route, publish deprecation headers, then remove aliases |
| `player-config` API | Implemented and tested but not connected to UI | Finish the mechanics settings UI; do not remove |
| Story abort messages/controller | Suggest durable cancellation but no control invokes it | Implement P1-6 or remove misleading UI paths |
| `btnSaveScratch` / `btnCopyDiagnostics` fallbacks | References to absent older IDs | Remove after one DOM compatibility release |
| `legacy_settings` | Active behavior stored in a field intended for compatibility | Migrate per P1-9; retain only import adapters |

## Portable data contract issue

`services/api/src/world-service.ts:1019` exports the entire private mechanics object under a field named `roll`; `services/api/src/import-service.ts:490-507` restores that opaque value to `mechanics_private`. This currently round-trips but the name and nesting are semantically unstable.

Define a versioned portable `mechanics` DTO, export public and private portions deliberately, and accept the legacy `roll` shape through an explicit compatibility adapter. Add fixtures for every historical export version.

## Recommended delivery roadmap

### Phase 0: Make the current platform safe and operable

- P0-1 CORS/CSRF and P0-2 outbound provider policy.
- P0-3 safe durable streaming.
- P0-4 lease heartbeats and fencing.
- P0-5 worker health command.
- P0-6 CSP, request limits, and quotas.
- Add hostile-origin, SSRF, lease-reclaim, and exact-container-health tests.

**Exit criterion:** Safe trusted-network deployment with no known cross-origin takeover, raw stream leakage, duplicate-provider lease path, or false worker health failure.

### Phase 1: Complete existing architecture and features

- Durable jobs for API-side provider work.
- Fair worker scheduling and shared worker packages.
- Typed provider capabilities, complete health/cost records, provider retirement.
- Player-safe mechanics DTO, mechanics settings UI, durable cancellation decision.
- Typed tracker operations and typed campaign mechanics config.
- Correct Compose/Swarm configuration and shared asset requirements.

**Exit criterion:** Every paid or mutating provider operation is attributable, retry-safe, replica-safe, and represented honestly in the UI.

### Phase 2: Establish RPG foundations

- Versioned world/entity/relationship/mechanics schemas.
- Full structured World Library editor.
- Rules profiles.
- Inventory, resources, conditions, abilities, quests, clocks, factions, and advancement.
- Player Chronicle/journal/codex and safety controls.

**Exit criterion:** A user can author and run a mechanically coherent campaign without encoding core game state in prose or arbitrary JSON.

### Phase 3: Deepen storytelling and play

- Scene/time/location model, configurable narrative controls, recaps, bookmarks, branches.
- Optional encounters, party/companion play, relationship evolution, and alternate timelines.
- Accessibility-complete player experience and comprehensive browser tests.

**Exit criterion:** Long-running stories remain understandable, navigable, mechanically consistent, and accessible.

### Phase 4: Multi-user platform hardening

- OIDC linking to the existing initial owner, authorization, sharing, player/GM roles, private notes, and audit logs.
- Backup/restore drills, queue SLOs, operational dashboards, and multi-node asset verification.

**Exit criterion:** Shared deployments preserve ownership boundaries, privacy, recoverability, and operational visibility.

## Definition of done for corrective work

Every correction should include:

1. A shared, versioned contract and migration/compatibility plan where persisted data changes.
2. Unit tests for domain rules and boundary validation.
3. PostgreSQL integration tests for ownership, idempotency, leases, retries, and restart behavior.
4. Real-browser tests for user-visible behavior.
5. Compose and Swarm implications, health checks, rollback notes, and secret/config changes.
6. Structured logs and metrics that omit credentials, private reasoning, and unnecessary story content.
7. Updated capability documentation that distinguishes shipped, preserved/imported, experimental, and planned behavior.

The repository does not need a broad rewrite. The most effective correction is to make all edge workflows obey the durable core already present, remove misleading or unreachable surfaces, and then build RPG depth on typed authoritative state rather than adding more prompt-only behavior.
