# Codebase Review Against Specifications

**Repository:** infinite-quest-nexus
**Reviewed commit:** `069da7219f24` (main, 2026-07-30)
**Reviewer:** AI-assisted staff-level review (multi-agent trace against ADRs/specs, automated test/build verification)
**Review date:** 2026-07-30

---

## 1. Executive Summary

Infinite Quest Nexus is a self-hosted, pre-authentication TypeScript platform for authoring versioned story worlds and running durable, AI-assisted campaigns. The repository is unusually well-documented: 25 ADRs, a `docs/development-standards.md` with an explicit source-of-truth precedence order, and an `AGENTS.md` governing file that a mechanically-enforced boundary script (`scripts/check-repository-boundaries.mjs`) partially backs. This review traced the major documented requirements from those specifications into the actual TypeScript implementation, ran the full documented validation pipeline, and audited five subsystems in depth: Story Engine/Chronicle, World Library/Campaigns, the illustration pipeline, the security/identity boundary, and test coverage/reliability.

**Overall implementation status:** The core domains (durable generation state machine, mechanics/fiction separation, world-version immutability, campaign isolation, cross-world transfer, Chronicle memory) are **substantially and correctly implemented**, with evidence traced to specific commit-transaction boundaries, not just interface stubs. This is a genuinely mature implementation of its own specification in the domains that matter most (data integrity of accepted story state).

**Estimated specification coverage:** ~85–90% of documented ADR/AGENTS.md requirements are implemented as specified. The gaps that exist are concentrated in three places: (1) a small number of real security hardening gaps around an explicitly pre-authentication, trusted-network threat model; (2) two disabled integration tests that are the *only* automated proof of a core resilience guarantee (illustration failure must not block story acceptance); and (3) test-coverage gaps around concurrency (races in job claiming and migration locking are correct by inspection of Postgres primitives, but never exercised under real concurrency in the suite).

**Release readiness:** The system is operating within its documented threat model (single trusted network, no authentication, single bootstrapped owner) and all CI-equivalent gates pass locally (`pnpm check:data`, `pnpm check`, `pnpm test:unit` — 300/300, `pnpm test:integration` — 86/89 passed, 3 skipped, `pnpm build`, Compose/Swarm config validation). It is **ready for continued operation under its stated trusted-network model with minor corrections**, contingent on fixing the CORS default and the disabled illustration-resilience tests before the next release, and on scheduling the SSRF fixes given they are exploitable even inside the "trusted network" boundary the docs assume.

**Findings by severity:** 0 Critical, 4 High, 8 Medium, 9 Low/Informational (see §4 and §6 for the full list).

**Five most important conclusions:**
1. The generation-integrity guarantee ("only validated output mutates campaign state") is real, transactionally enforced, and directly tested — this is the system's most safety-critical property and it holds up under inspection.
2. Two integration tests that are the sole automated proof that illustration failure cannot block story acceptance were disabled in commit `a4b661be` ("to allow CI to pass while the underlying issues are investigated") and never restored — this guarantee is currently **unverified by CI**.
3. The CORS default (`corsAllowedOrigins: ["*"]` with `Access-Control-Allow-Credentials: true`) combined with the documented absence of authentication means any web page a trusted-network browser visits can read and mutate all Nexus data — this is the single largest practical exploitability gap in the system today.
4. Two independent SSRF primitives exist: unrestricted provider `baseUrl` configuration (no host allowlist) and unvalidated redirect-following when downloading provider-returned image artifacts (`image-service.ts`, no re-validation of the redirect target). Both are reachable without authentication.
5. Code quality is uneven: the domain/story-engine/worker core is well-structured and well-tested, while `services/api/src/asset-service.ts` (health score 1.0/10, the worst in the 325-file repo) and `apps/web/public/nexus.js` (the repo's #1 refactor-first hotspot by the tool's own churn/complexity fault predictor) carry disproportionate defect risk and zero/thin test coverage.

**Confidence and limitations:** High confidence in the findings reported here — every claim below is backed by a specific file/line citation gathered by direct source reading (by me or by five parallel research agents instructed to grep/read actual code, not infer from names) and cross-checked against automated test/build runs I executed myself. Limitations: (a) I did not perform a manual UI/browser walkthrough of `apps/web/public/*.js` — that client is hand-written, untyped JavaScript validated only by `node --check`, and its behavior was assessed by static reading, not live interaction; (b) the "live" Sogni SDK test suite was not run (it calls a real paid external provider and is correctly excluded from CI); (c) I did not independently re-verify every citation from the five research agents byte-for-byte, though the citations are specific enough (file:line, quoted logic) to be checkable and several were cross-confirmed independently (e.g., the three skipped tests were found both by my own direct grep and by the test-coverage agent).

---

## 2. System Understanding

**Intended system behavior** (per `AGENTS.md`, `docs/development-standards.md`, `docs/concepts/platform-overview.md`): a browser client (`apps/web/public/*.js`, plain JS) talks only to a Fastify API (`services/api/`) which is the sole authority for identity, world/campaign management, and job submission. A separate durable worker (`services/worker/`) claims jobs from PostgreSQL and performs LLM text generation, embedding, and image generation against independently-configured provider endpoints. PostgreSQL (`packages/database/`) is authoritative for everything: users, worlds, immutable world versions, campaigns, the append-only accepted-turn ledger, campaign state, Chronicle memory, and durable job queues. A single combined container image runs different roles (`all`, `api`, `worker`, `migrate`) for Compose (local, two containers) or Swarm (independently scalable API/worker services) deployment.

**Major components:**
- `packages/contracts/` — Zod schemas validating every untrusted boundary (browser→API, DB→domain, worker→provider, model output→accepted turn).
- `packages/domain/` — pure functions for world/campaign/turn/character rules and text sanitization (mechanics-leak detection).
- `packages/story-engine/` — prompt construction, provider transport (text/embedding/illustration), sanitization, validation, recovery, retrieval.
- `packages/database/` — connection pool, runtime config loading, `node-pg-migrate` coordination with PostgreSQL advisory locking.
- `services/api/src/server.ts` — Fastify routes, static web serving, health endpoints, the single error-handling chokepoint.
- `services/api/src/*-service.ts` — world, campaign, import, asset, provider, generation, memory, image services.
- `services/worker/src/worker.ts` — durable job loop for generation, illustration, Chronicle indexing, and backfill work.
- `database/migrations/` — ordered, append-only SQL schema migrations.

**Key workflows traced:** (a) durable story generation: `queued → assessing → generating → validating → committing → completed`, with `recoverable`/`failed` branches, enforced by `FOR UPDATE SKIP LOCKED` job claiming, lease heartbeats, and a transactional commit that is the *only* code path allowed to write `turns`/`campaign_state`/`chronicle_memories`; (b) world authoring: mutable drafts → immutable numbered published versions → campaigns pinned to one version, with explicit migration required to move a campaign to a newer version; (c) illustration: an optional child job enqueued in the same transaction as turn acceptance but executed asynchronously and independently retryable; (d) cross-world campaign transfer: a deep, by-value copy of campaign-owned rows into a new campaign under the target world version.

**Data flow / trust boundaries:** Browser → `/api/v1/*` (Zod-validated) → services (owner-scoped SQL) → PostgreSQL. Worker → provider endpoints (text/embedding/image, each independently configured, each returning untrusted data that is schema-validated and sanitized before persistence). The most important trust boundary claimed by the docs — and the one most worth scrutinizing — is that **there is no authentication**: every request is resolved server-side to one bootstrapped `initial-owner` user, and the docs explicitly declare the deployment must stay on a trusted network. That boundary is enforced correctly at the identity-resolution layer (verified: no client-supplied identity value is read anywhere in the codebase), but the CORS and SSRF findings below show that "trusted network" is not, in practice, as tight a boundary as the docs assume, because a browser on that network can be made to act as a confused deputy.

---

## 3. Requirements Traceability Matrix

| Requirement | Specification Reference | Status | Implementation Evidence | Test Evidence | Notes |
|---|---|---|---|---|---|
| World versions immutable after publish | ADR 0007; AGENTS.md "Domain and Persistence Rules" | Complete | `world-service.ts:327-376` (`publishWorld` — insert-only); no `UPDATE world_versions` exists anywhere in repo (grep-verified) | `tests/integration/world-library.integration.test.ts:104,127` | Structurally guaranteed, not just convention |
| Editing a draft world cannot alter an existing campaign | ADR 0007/0013; AGENTS.md | Complete | `world-service.ts:570-624` snapshots character data into `campaigns.character_snapshot` at creation; nothing re-reads drafts afterward | `world-library.integration.test.ts:160` | — |
| Campaign migration to newer world version is explicit, non-silent | ADR 0007 | Complete | `migrateCampaignWorld`, `world-service.ts:924-964` — updates `world_version_id` only, preserves snapshot | `world-library.integration.test.ts:398` | — |
| Cross-world campaign transfer creates an independent copy | ADR 0019 | Complete | `campaign-transfer-service.ts:225-341` deep-copies all campaign-owned rows by value; `FOR UPDATE OF c, cs` + advisory lock on commit | `campaign-transfer.integration.test.ts:48,173` | Only shared object is immutable content-addressed asset bytes (by design) |
| World-version deletion refuses when referenced | ADR 0015 | Partial | `world-service.ts:795-925` checks 5 blocker categories in one aggregate query | 2 of 5 blockers tested (`world-library.integration.test.ts:292,307`); `campaign_transfers`/`chronicle_memories`/`model_chains` blockers untested | Implementation correct; test coverage incomplete |
| Zip import/export free of path traversal | Implied by "untrusted input" rule, AGENTS.md Security | Complete (by construction) | `asset-service.ts:210` guards writes with `rootPrefix` containment check; zip entry names never used to build filesystem paths | No dedicated test found | Recommend a regression test for defense-in-depth |
| Durable generation state machine with recoverable/failed branches | ADR 0002/0003; AGENTS.md Generation Integrity | Complete | `generation-service.ts` state transitions at lines 1055-1076, 1472, 1699, 1745-1760 | `generation.integration.test.ts:367` | — |
| Only validated output mutates campaign state/Chronicle | AGENTS.md Generation Integrity | Complete | `commitStory` (`generation-service.ts:1190-1383`) is the sole writer; gated by `parseStoryOutput` + `mechanicsLeakFields` empty check | `generation.integration.test.ts:894` (doubly-truncated response leaves ledger unchanged) | — |
| Duplicate/concurrent next-turn prevention | ADR 0002; AGENTS.md | Complete (by schema); Not Verifiable under real concurrency | Partial unique index `generation_jobs_one_active_campaign_idx`; `UNIQUE(campaign_id, turn_number)`; `FOR UPDATE` + idempotency-key uniqueness | No test races concurrent `runGenerationJob` calls | Postgres primitives are sound; never exercised under real concurrency |
| Mechanics never leak into narration/memory/embeddings/image prompts | AGENTS.md Generation Integrity; mechanics-and-fiction-separation.md | Complete | `containsMechanicsLanguage`/`mechanicsLeakFields` gate the only commit path (`generation-service.ts:1599-1670,1744`); illustration prompts also sanitized (`packages/domain/src/illustrations.ts:107-114`) | `generation.integration.test.ts:868,884`; `tests/unit/mechanics.test.ts` | Detector is deterministic regex, not a "contextual classifier" as ADR 0003's language implies — coverage gap for paraphrased leaks |
| Response chains scoped per campaign/world-version/model/endpoint/prompt-protocol | AGENTS.md Story Memory Model | Ambiguous / Stale spec | `model_chains` table exists (migration 0005) but is **never inserted into by production code** — only `DELETE`/deactivate statements exist; only test fixtures insert rows | Test fixtures seed rows against unused table | ADR 0010 supersedes AGENTS.md here ("chains are not written by the Story Engine"); AGENTS.md text was not updated to match — no leakage risk, but a doc/dead-code mismatch |
| Chronicle embeddings/summaries rebuildable, never block turn acceptance | ADR 0001/0006/0010 | Complete | `commitStory` only enqueues reindex job; `applySemanticRelevance` degrades to lexical fallback on provider error | `import-memory.integration.test.ts` | — |
| Cross-campaign Chronicle/memory isolation | ADR 0006/0018/0024 | Complete | Every retrieval query filters by `owner_user_id`/`campaign_id` | `import-memory.integration.test.ts:487-541` (colliding entity names across campaigns, explicit secret-leak assertion) | Directly tested for exactly the right failure mode |
| Illustration is an optional child job; failure never blocks turn acceptance | ADR 0008; AGENTS.md Generation Integrity | Partial | `commitStory` enqueues illustration in the same transaction as turn insert (`generation-service.ts:1358-1374`), **without a try/catch** around the enqueue call — a DB error there would roll back the whole accepted turn | **The one integration test proving this end-to-end is disabled**: `image-pipeline.integration.test.ts:587` (`it.skip`) | See Finding [High] in §4 |
| Fiction-only image prompts (no mechanics/reasoning/trackers) | AGENTS.md Generation Integrity; ADR 0023 | Complete | `composeIllustrationProviderPrompt` (`packages/domain/src/illustrations.ts:107-114`) runs `stripMechanicsLeakage`; multiple enqueue-time gates also call `containsMechanicsLanguage` | Unit-level sanitizer tests exist; no test drives a mechanics-laden prompt through the full composer to the provider payload | — |
| Downloaded illustration bytes are validated (signature, not just content-type) | capabilities.md "Illustrations" | Complete | `matchesImageSignature` (`asset-service.ts:16-22`), `artifactMimeType` (`image-service.ts:527-531`) check real magic bytes | — | — |
| Illustration/image job retries are idempotent and replica-safe | ADR 0022 | Complete (REST); Documented accepted risk (SDK) | `FOR UPDATE SKIP LOCKED` leasing + `Idempotency-Key` header for Sogni REST; SDK path lacks caller-controlled idempotency, documented in ADR 0022 as an accepted narrow window | `tests/live/sogni-sdk-durability.live.test.ts` | Accepted, documented limitation — not a silent defect |
| Identity resolves server-side only; no client-supplied identity accepted | AGENTS.md User Identity | Complete | `initialOwnerId()` (`packages/database/src/pool.ts:33-40`) used everywhere; `X-User-Id` appears only in a CORS header allowlist, never read | No explicit "spoofed header ignored" test, but no code path exists to spoof through | — |
| Provider credentials encrypted at rest, never returned to browser | AGENTS.md Security; development-standards.md §8 | Partial | `apiKey` correctly encrypted and never surfaced (`provider-service.ts:51,102`); but the free-form `configuration` JSONB field is stored and **returned unredacted** on every read | No test asserts `configuration` redaction | See Finding [Medium] in §6 |
| Web/API surface intended for trusted network only, but CORS should not itself grant cross-origin access | docs/installation/network-access.md; docs/operations/security.md | Incorrect (unsafe default) | Default `corsAllowedOrigins: ["*"]` reflects the literal request `Origin` with `Access-Control-Allow-Credentials: true` (`server.ts:184-196`, `packages/database/src/config.ts:67`) | `server-security.test.ts:79-102` validates the *mechanism* exists, not that the shipped default is safe | See Finding [High] in §4 |
| Provider endpoints independently configured; no SSRF into internal network | AGENTS.md (implied); no explicit SSRF spec exists | Missing (undocumented gap) | No host/IP allowlist on provider `baseUrl` (`packages/contracts/src/generation.ts:21`); `image-service.ts` follows redirects without re-validating the resolved host | No test | See Findings [High]/[Medium] in §4 |
| Migrations serialize via PostgreSQL advisory locking; worker-only replicas wait, never apply | development-standards.md §11; AGENTS.md | Complete (by code); Not Verifiable under real concurrency | `withMigrationLock` (`migrate.ts:49-64`) blocking `pg_advisory_lock`; `waitForDatabaseMigrations` (`migrate.ts:102-126`) only ever dry-runs, structurally cannot apply | `migrations.integration.test.ts` covers content, not concurrent-replica racing | — |
| Graceful shutdown drains in-flight work via AbortController | development-standards.md §11 | Partial | Generation jobs genuinely drained (`worker.ts:66-70`); illustration/chronicle/backfill jobs are awaited synchronously with no forced-exit timeout if a provider call hangs | No test | Soft finding; mitigated by lease/heartbeat reclaim |
| Orphaned job leases are reclaimed after worker death | development-standards.md §11; docs/operations/recovery/generation-jobs.md | Complete | `claimGeneration`/`claimImageJob`/`claimResolutionJob` all reclaim leases past `lease_expires_at`; heartbeat extends lease during live processing | Verified by code reading; not directly tested with a simulated crash | — |
| No secrets/backups/story exports committed | development-standards.md §10 | Complete | `pnpm check:data` passed in this review run | CI-enforced | — |
| Type safety, boundary enforcement, browser client network allowlist | development-standards.md §3 | Complete | `pnpm check` passed (boundary scan + `tsc --noEmit` + `node --check` on browser JS) | CI-enforced | — |

---

## 4. Critical and High-Severity Findings

No Critical findings were identified — no confirmed data-corruption, systemic-compromise, or complete-feature-failure defect was found in this review.

### [High] CORS ships an unsafe-by-default configuration given the documented no-authentication model

**Confidence:** High
**Release blocker:** Yes (before any deployment that isn't fully network-isolated)
**Specification reference:** `docs/installation/network-access.md` (server must stay on a trusted network); `docs/operations/security.md`; AGENTS.md Security ("restrict the web/API surface... to the intended trusted network")
**Code evidence:** `services/api/src/server.ts:184-196`; default `corsAllowedOrigins: ["*"]` in `packages/database/src/config.ts:67`, only overridden if an operator explicitly sets `CORS_ALLOWED_ORIGINS`
**Affected workflow:** every authenticated-by-network-position operation (world/campaign CRUD, generation, provider management, cost data)

**Problem**

When `CORS_ALLOWED_ORIGINS` is unset (the shipped default), the server reflects whatever `Origin` header a request carries and unconditionally sends `Access-Control-Allow-Credentials: true`. Since there is no authentication layer, the network boundary *is* the entire security model — but browsers do not restrict which origins a user's browser can attempt to contact on a network it can reach. Any page the user's browser loads (an ad, a compromised site, a phishing link, another tab) can issue `fetch()` calls to the Nexus API from that browser and receive full responses, because the server will reflect that page's origin as allowed and send credentials.

**Impact**

Given POST/PATCH/DELETE routes are exposed (world/campaign creation and deletion, generation triggering which burns provider API credits, cost/PII-adjacent data reads), a single malicious page loaded anywhere in the trusted network can silently read all Nexus content and mutate/delete it, or trigger paid generation/image jobs, entirely without the user's knowledge. This defeats the "trusted network" assumption the rest of the security model rests on, because the actual attack surface is "any origin the browser visits," not "any host on the network."

**Recommended correction**

Change the default to deny-all (empty allowlist) rather than `["*"]`, and require an explicit operator opt-in origin list in `.env.example`/installation docs before the app will serve cross-origin requests at all. If a wildcard-with-credentials mode is kept for convenience, gate it behind an explicit, loudly-documented flag (e.g., `CORS_ALLOW_ANY_ORIGIN_UNSAFE=true`) rather than making it the silent default.

**Required tests**

A test asserting the *default* (no `CORS_ALLOWED_ORIGINS` env var set) does NOT reflect an arbitrary origin with credentials; a test for the explicit-allowlist path continuing to work as today.

---

### [High] SSRF via unrestricted provider `baseUrl` with no authentication gate on provider registration

**Confidence:** High
**Release blocker:** Yes, in combination with the CORS finding above (a malicious page can register a provider profile pointed at an internal target and then trigger the request)
**Specification reference:** No explicit SSRF boundary is documented, but AGENTS.md's provider-independence rules imply provider endpoints are meant to be operator-configured, trusted external services, not an open request-relay primitive
**Code evidence:** `packages/contracts/src/generation.ts:21,51` (`baseUrl: z.url().refine(...)` with no host restriction); `packages/story-engine/src/providers.ts` (`rootUrl`/`lmStudioRoot`/`openAiRoot`) builds fetch URLs directly from operator/browser-supplied `baseUrl` with no allow/deny list
**Affected workflow:** `POST /api/v1/providers`, `POST /api/v1/providers/discover-models`, `POST /api/v1/provider-text/generate`

**Problem**

Any client that can reach the API (which, per the CORS finding, may include an arbitrary web page loaded by a browser on the trusted network) can register a provider profile whose `baseUrl` points at an internal-only address — a cloud metadata endpoint, another internal service, `host.docker.internal`, etc. — and then invoke model discovery or text generation against it, using the API/worker as a network relay and receiving the response back through the API.

**Impact**

This is a classic SSRF pivot: it lets anything that can reach the API probe or exfiltrate from network segments the requester itself cannot reach directly (e.g., cloud instance metadata, sibling containers, internal admin endpoints). Combined with the CORS gap, this is reachable from an untrusted web page, not just from someone who already has network access to the API.

**Recommended correction**

Add a host/IP validation step when a provider profile is created or discovery/generation is invoked: resolve the hostname, reject loopback/link-local/RFC1918/metadata-range targets unless an explicit operator override is set, and re-validate on every call (not just at profile-creation time, to prevent DNS-rebinding). Pseudocode:
```ts
function assertSafeProviderHost(url: URL): void {
  const ip = resolveHostSync(url.hostname); // or async pre-flight
  if (isPrivateOrLoopbackOrLinkLocal(ip) && !ALLOW_INTERNAL_PROVIDERS) {
    throw new ForbiddenProviderTargetError(url.hostname);
  }
}
```

**Required tests**

Registering/using a provider profile with `baseUrl` pointing at `127.0.0.1`, `169.254.169.254`, and an RFC1918 address should be rejected by default; an explicit operator override should be required to permit internal targets (useful for legitimate LAN-hosted LM Studio instances).

---

### [High] SSRF via unvalidated redirect when downloading provider-returned image artifacts

**Confidence:** High
**Release blocker:** No (narrower reach than the two findings above — requires a malicious/compromised image provider, not any web request), but should be fixed before scaling out illustration provider support
**Specification reference:** `docs/nexus-guide/providers/images.md`; the pre-check logic in `image-service.ts` itself implies a documented protection ("rejects URLs that directly name localhost, `.local`, or private literal IP ranges") which is only partially delivered
**Code evidence:** `services/api/src/image-service.ts:534-550` (`privateArtifactHost`, string-based pre-check) and `:552-578` (`downloadArtifact`, uses `redirect: "follow"` with no re-validation of the redirect target's host)
**Affected workflow:** illustration/image job completion (worker downloading a provider-returned artifact URL)

**Problem**

The private-host check inspects only the literal hostname string of the *initial* URL before connecting. It does not resolve DNS ahead of the request, and the actual fetch follows redirects (`redirect: "follow"`) without re-checking the resolved/redirected host. A malicious or compromised image provider (or a DNS-rebinding attacker controlling a hostname that resolves differently between check-time and connect-time) can supply an artifact URL that passes the string check but resolves to, or 30x-redirects to, an internal address at fetch time.

**Impact**

The worker process (which has network reach the browser does not, per ADR 0008's deployment topology) can be made to fetch and — depending on downstream handling — potentially expose the contents of an internal endpoint, bypassing the documented protection.

**Recommended correction**

Use `redirect: "manual"` and re-validate each hop's resolved host against the same private-range check, or resolve DNS before connecting and check the resolved IP (not just the hostname string) at each redirect step.

**Required tests**

An artifact URL that redirects from a public-looking host to a private/internal target should be rejected; a DNS-rebinding-style test (host resolves to a private IP at fetch time) should also be rejected.

---

### [High] The sole automated proof that illustration failure does not block story acceptance is disabled

**Confidence:** High
**Release blocker:** Yes — this is a core, explicitly documented resilience guarantee (AGENTS.md Generation Integrity: "Image success or failure must not change whether the story turn is accepted") with no current CI verification
**Specification reference:** AGENTS.md Generation Integrity; ADR 0008; `docs/operations/recovery/image-jobs.md`; `docs/development-standards.md` §6 ("illustration failure does not block story acceptance" is explicitly listed as behavior that must stay covered)
**Code evidence:** `tests/integration/image-pipeline.integration.test.ts:526` (`it.skip("queues after story commit, sends only the fiction prompt, and stores generated bytes")`) and `:587` (`it.skip("preserves the accepted story when the independent image endpoint fails")`)
**Affected workflow:** story turn acceptance when the image endpoint is unavailable or fails

**Problem**

Both tests were disabled in commit `a4b661be` ("ci: fix pnpm version and integration tests", 2026-07-21) with a commit message indicating this was done "to allow CI to pass while the underlying issues are investigated." Five sibling tests disabled in the same commit were later restored (commit `8503663`, "Restore Chronicle integration coverage"); these two were not. This means whatever caused them to fail was never confirmed fixed, and the guarantee itself — arguably the single most important reliability property of the illustration subsystem — has had zero CI coverage since that date.

**Impact**

A regression in the illustration-failure-isolation logic (which does exist in code — see §3's "Partial" determination on the unguarded `enqueueAcceptedTurnIllustrationSegments` call inside the turn-commit transaction) could ship undetected. If the underlying bug that caused the original failure is still present, users could be experiencing turn-acceptance failures tied to illustration provider outages right now, with no test signal.

**Recommended correction**

Re-enable both tests, diagnose and fix whatever caused the original failure (start by checking whether it relates to the missing try/catch around the illustration-enqueue call noted in §3), and do not merge further illustration-pipeline changes with these tests skipped.

**Required tests**

The two tests already exist and specify the exact required behavior — re-enabling them and making them pass is the required test work here.

---

## 5. Missing or Incomplete Requirements

Ordered by importance:

1. **Illustration-failure isolation test coverage disabled** (see §4) — highest priority because it's a regression risk on a documented guarantee, not merely an untested-but-correct path.
2. **World-version deletion: 3 of 5 documented blocker categories untested** (`campaign_transfers`, `chronicle_memories`, `model_chains`) — implementation is correct by code reading but a regression here would silently allow deleting a version still tied to transfer/memory history.
3. **CORS default and provider-`baseUrl` SSRF gaps** (see §4) — these are gaps against an *implied* hardening requirement rather than an explicit written spec, but they undermine the trusted-network assumption every other security claim in the docs depends on.
4. **No concurrency-race test for the generation job-claiming/commit path**, despite this being the most safety-critical property of the durable job system and despite `generation-service.ts` being a documented bug-fix hotspot (2 prior fixes, most recent 9 days before this review).
5. **No concurrency test for the migration advisory-lock mechanism** — correct by code reading, unverified under real multi-replica contention.
6. **`model_chains` table and its AGENTS.md description are stale** relative to ADR 0010, which superseded the scoped-response-chain design; the table is now written only by test fixtures, not production code. Low risk, but a documentation/dead-code hazard for future contributors.
7. **`configuration` field on provider profiles is stored and returned unredacted**, unlike the primary `apiKey`, creating a narrow but real gap against the stated "provider credentials... never returned to the browser" guarantee if an operator or preset puts a secondary secret-shaped value there.
8. **Zip decompression bomb in legacy-story import** — the 50MB compressed-upload cap does not bound uncompressed size during `JSZip.loadAsync`, allowing a small, highly-compressible upload to exhaust API process memory.
9. **No test for initial-user bootstrap idempotency under an actual re-run**, and no test asserting a caller-supplied `id`/`ownerUserId` field in a request payload is ignored rather than silently dropped — both are explicitly required by AGENTS.md Testing Requirements ("Identity tests must verify initial-user bootstrap idempotency... and rejection of caller-supplied identity spoofing").
10. **`semantic-memory-auto-enable.test.ts` has no integration counterpart** — it is the one mocked-database unit test in the suite with no real-Postgres equivalent, so a schema/column drift in the embedding-provider auto-selection SQL would pass CI undetected.
11. **`asset-service.ts` has zero test coverage** despite being the highest-churn, most-depended-on file in the illustration subsystem and the single lowest-health-score file in the entire 325-file repository (score 1.0/10), driven by one 118-line, cyclomatic-complexity-43 function (`queryAssets`) with duplicated filter logic between its paginated-results and facet-count branches.

---

## 6. Medium and Low-Severity Findings

### [Medium] `configuration` provider field stored/returned in plaintext, unlike `apiKey`
**Confidence:** Medium | **Release blocker:** No
`provider-service.ts:44,265,297,336,416` returns `configuration` (an arbitrary `z.record(z.string(), z.unknown())`) unredacted on every read, while `apiKey` is correctly encrypted and never surfaced. Only Sogni-typed profiles get schema validation on this field; all others pass through unfiltered. **Recommendation:** apply the same redaction pass used for world/campaign sensitive keys (`SENSITIVE_WORLD_KEYS` pattern already exists in `world-service.ts`) to provider `configuration` before returning it.

### [Medium] Zip decompression bomb in legacy-story import
**Confidence:** Medium | **Release blocker:** No (DoS only, no data compromise)
`server.ts:333-369`: `JSZip.loadAsync` and per-entry `.async(...)` calls decompress fully into memory with only a 50MB *compressed* upload cap and no per-entry/aggregate uncompressed-size limit. A trivially-constructed high-ratio zip can exhaust process memory. **Recommendation:** stream-decompress with a running uncompressed-byte counter and abort past a bounded threshold (e.g., 500MB).

### [Medium] Unguarded illustration-enqueue call inside the turn-commit transaction
**Confidence:** Medium | **Release blocker:** No (narrow: only triggers on a DB-level failure during enqueue, not a normal image-generation failure)
`generation-service.ts:1369,1372`: `enqueueAcceptedTurnIllustrationSegments` is called without a try/catch inside the same transaction that commits the accepted turn. An exception there (constraint violation, transient DB error) would roll back the entire accepted turn, narrowly contradicting ADR 0008's "cannot change accepted narration" guarantee. **Recommendation:** wrap in a try/catch that logs and defers illustration enqueue to a follow-up reconciliation job rather than failing the commit.

### [Medium] World-version deletion: 3 of 5 blocker categories untested
See §5 item 2. **Recommendation:** extend `world-library.integration.test.ts` with cases for `campaign_world_transfers`, `chronicle_memories`, and `model_chains` blockers, mirroring the existing `current_campaigns`/`campaign_migrations` tests at lines 292/307.

### [Medium] No concurrency test for generation job claiming
See §5 item 4. **Recommendation:** add an integration test that launches two `runGenerationJob`-equivalent calls via `Promise.all` against the same campaign and asserts exactly one commits, the other observes `active_generation_exists` or an equivalent conflict.

### [Medium] Mechanics-leak detection is a fixed regex pattern list, not a contextual classifier
`packages/domain/src/text.ts:9-41` (~30 hand-written patterns). Well-tested for the phrasing it covers, but any creatively paraphrased mechanics leakage outside those patterns would pass through silently. Not an exploitable defect today, but a coverage gap that will grow with new stat systems or trigger types. **Recommendation:** track this as a known heuristic limitation; consider a secondary model-based classifier pass if false negatives are observed in production.

### [Low] `apps/web/public/asset-service.ts` duplicated "load-or-404" boilerplate
The pattern "load asset, 404 if missing, validate storage driver" is duplicated near-verbatim 7 times across `asset-service.ts`, `image-service.ts`, `generation-service.ts`, and `campaign-state-service.ts`. **Recommendation:** extract a shared helper; a future auth/validation fix currently needs to be applied in 7 places.

### [Low] Magic-number parameter slicing in `queryAssets`
`asset-service.ts:589`: `params.slice(0, params.length - (cursor ? 3 : 1))` silently depends on exactly how many params preceding logic appended; a future edit to the WHERE-builder is likely to desync page results from facet counts with no compiler or runtime signal. **Recommendation:** replace with named parameter groups instead of positional slicing.

### [Low] `model_chains` table and AGENTS.md text are stale relative to ADR 0010
See §5 item 6. **Recommendation:** either update AGENTS.md's Story Memory Model section to match ADR 0010's narrower scope, or remove the unused table/columns and the test fixtures that seed it.

### [Low] Toolchain version statement inconsistency
`README.md` states "Node.js 22.13 or newer and pnpm 11.14.0"; `package.json` pins `packageManager: pnpm@11.16.0`; CI runs pnpm 11.16.0. Already logged as a known unknown in `docs/development-standards.md` §13. **Recommendation:** correct `README.md` to match the pinned version.

### [Low] Duplicate ADR numbers
`0011-editable-campaign-runtime-state.md` / `0011-provider-reported-campaign-costs.md`, and `0024-central-prompt-library.md` / `0024-scoped-chronicle-entity-identity.md`. Already logged as a known unknown in `docs/development-standards.md` §13. **Recommendation:** renumber the later ADR in each pair and fix inbound links.

### [Informational] `world-library.integration.test.ts:850` skipped (campaign-before-world deletion ordering)
Disabled in the same commit as the illustration tests above; lower priority than those because it doesn't guard a documented user-facing guarantee, but deletion-ordering bugs are exactly the class of defect that ships silently when CI is green. **Recommendation:** re-enable alongside the illustration tests.

### [Informational] No linter/formatter, no coverage threshold, no dependency vulnerability scan
All three are explicitly logged as open decisions in `docs/development-standards.md` §13 — not undocumented gaps, but worth flagging as they compound the risk of the other findings above (e.g., a linter would not have caught the CORS default, but a dependency scanner might catch a future vulnerable transitive package).

### [Informational] Single-maintainer bus factor
Repository-wide git health shows `avg_bus_factor: 0.4` and 122 of ~325 files with bus factor 1; one contributor ("Chris") owns 35.6% of files by the indexing tool's attribution. Not a code defect, but a project-continuity risk worth the maintainer's awareness.

---

## 7. Test Coverage Gaps

**Missing/disabled tests (highest priority):**
- `image-pipeline.integration.test.ts:526,587` — disabled, cover illustration-independence-from-story-acceptance (see §4).
- `world-library.integration.test.ts:850` — disabled, covers campaign-before-world deletion ordering.
- World-version deletion blockers for `campaign_transfers`, `chronicle_memories`, `model_chains` (implemented, untested).
- Zip import/export path-traversal regression test (implementation is safe by construction; no test proves it).

**Missing integration tests:**
- No concurrent-request test for generation job claiming/commit (race-condition coverage).
- No concurrent-replica test for migration advisory locking.
- `semantic-memory-auto-enable.test.ts` has no real-Postgres integration counterpart — the only mocked-DB unit test in the suite without one.

**Missing failure-path tests:**
- Illustration prompt sanitizer is unit-tested in isolation, but no test drives a mechanics-laden scene through the full `composeIllustrationProviderPrompt` pipeline and asserts the actual outbound provider payload is clean.
- No test for a hung/slow provider call during worker shutdown (SIGTERM while an illustration/chronicle job is mid-flight, no forced-exit timeout).

**Missing authorization/identity tests:**
- No test asserting a caller-supplied `id`/`ownerUserId` field on a mutation payload is ignored rather than silently dropped.
- No test re-running the initial-user bootstrap migration to prove idempotency at the migration level (only `ON CONFLICT DO NOTHING` is verified by code reading).

**Missing security tests:**
- No test for the CORS default (only the reflect-mechanism itself is tested, not that the *shipped default* is safe).
- No test for provider `baseUrl` SSRF rejection.
- No test for redirect-based SSRF in artifact download.
- No test asserting `configuration` field redaction on provider reads.
- No test for zip decompression-bomb rejection.

**Migration tests:** schema-evolution and maintenance-gating are well covered (`migrations.integration.test.ts`); concurrent-replica racing is not (see above).

**Tests that provide false confidence:** none identified as actively misleading, but `tests/unit/user-profile.test.ts` and `tests/unit/dashboard-stats.test.ts` mock the database pool via SQL-substring matching (`sql.includes(...)`), which is fragile against real schema drift; `dashboard-stats` is mitigated by a real-Postgres integration counterpart, `user-profile` and `semantic-memory-auto-enable` are not.

---

## 8. Specification Problems

1. **Possible contradiction on narration streaming.** `docs/reference/capabilities.md` lists "Streaming narration progress where the provider supports it" as a current Story Engine capability, while `docs/operations/deferred-improvements.md` explicitly states "Stream provisional story narration during generation — Status: Deferred. Do not implement as part of the current provider or Story Engine workflow." These may refer to different things (transport-level progress/heartbeat events vs. browser-facing incremental narration text), but as written they read as contradictory. **Recommended clarification:** capabilities.md should state precisely what "streaming narration progress" means (e.g., "provider transport progress events, not incremental narration text display") to avoid the ambiguity, or the deferred-improvements entry should be updated if streaming narration display has since shipped.
2. **AGENTS.md Story Memory Model section is stale relative to ADR 0010.** AGENTS.md describes an active, fully-scoped `model_chains` response-chain cache; ADR 0010 explicitly narrows this to same-job recovery only, and production code matches ADR 0010, not AGENTS.md. Per the documented precedence order (ADRs rank above AGENTS.md is *not* actually stated — AGENTS.md ranks #3, ADRs rank #5 in `docs/development-standards.md` §2 — so this is technically a case where the higher-precedence document is the stale one). **Recommended clarification:** update AGENTS.md's Story Memory Model section to match ADR 0010, since the precedence rule as written would otherwise require the (incorrect, unimplemented) AGENTS.md description to win.
3. **Duplicate ADR numbers** (`0011` and `0024`, each used twice) — already self-documented as an open decision in `docs/development-standards.md` §13; no action needed beyond what's already tracked there.
4. **Toolchain version mismatch** between README and package.json — already self-documented as an open decision; no action needed beyond what's already tracked.
5. **No explicit SSRF policy is documented anywhere**, despite the system's core function being "call operator-configured external HTTP endpoints." This isn't a contradiction, but it's a real gap: neither AGENTS.md nor `docs/operations/security.md` states whether provider endpoints are assumed to be non-adversarial by construction (in which case the SSRF findings in §4 are lower priority) or whether the system is expected to defend against a compromised/malicious provider (in which case they are not). **Recommended clarification:** state explicitly whether provider endpoints are a trusted-by-configuration input or an untrusted-by-design input, since this determines whether §4's SSRF findings are "harden against compromise" or "fix a documented guarantee violation."

---

## 9. Architecture and Future-Plan Risks

- **`services/api/src/asset-service.ts` and `apps/web/public/nexus.js` are the two highest-risk files in the repository** by the codebase's own churn/complexity/health tooling (`nexus.js` is the #1 "fix first" target, recovering the largest single share of the repo's health gap; `asset-service.ts` has the single worst score). Both are on the critical path for illustration/asset delivery, a subsystem already flagged for the illustration-test-coverage gap in §4/§5. Any near-term illustration-pipeline feature work (e.g., the documented Phase 6 image-library enhancement) should budget time to add characterization tests to `asset-service.ts` *before* extending it further — the `queryAssets` function's duplicated filter/facet logic is a latent-bug generator that will make future changes riskier, not less.
- **The two explicitly deferred features** (`docs/operations/deferred-improvements.md`: updating an existing campaign from a newer Infinite Worlds TXT export, and streaming provisional narration) are both substantial, carefully-specified pieces of future work with real dependencies on the current architecture (turn-revision history tables, a new `generation_stream_events` table, provider capability-detection extensions). Both documents are unusually thorough and internally consistent — this is a strength, not a risk, but implementers should note the streaming-narration deferred spec's explicit warning that "correctness takes priority over first-token display," which will require real discipline to preserve once implementation begins (the temptation to forward raw provider deltas for a snappier UI is exactly the anti-pattern the spec warns against).
- **No authentication is a foundational, load-bearing assumption** for nearly every other security property claimed in the docs (ownership scoping, ownership-based query isolation, credential secrecy). The CORS and SSRF findings in §4 show that this assumption is currently under-defended at its actual edges (a browser on the trusted network is not the same trust level as "a request originating from the trusted network with correct intent"). Before OIDC/login work begins (which AGENTS.md already plans for structurally — `user_identities` table, explicit linking flow), it would be worth hardening the *current* boundary rather than treating it as a stopgap not worth investing in, since the current boundary will remain the actual security perimeter until that work ships.
- **Single-maintainer bus factor** (§6 Informational) is worth noting for planning purposes: a large fraction of the codebase has exactly one historical author, which is a normal state for a project at this stage but worth tracking as a continuity risk if the project's scope or team grows.
- **No dependency vulnerability scanning is configured** (§6/§13 of development-standards.md, already self-documented). Given the project pulls in `undici`, `sharp`, `archiver`, `jszip`, and provider SDKs that all parse untrusted external input, this is a reasonable near-term addition to CI.

---

## 10. Recommended Remediation Order

1. **Immediate release blockers:**
   - Fix the CORS default (§4) — this undermines every other security claim in the system.
   - Re-enable and fix the two disabled illustration-independence integration tests (§4) — diagnose whether the underlying bug is the unguarded transaction-scoped enqueue call (§6) and fix that first, since it's a plausible root cause.

2. **Security and data-integrity corrections** (depends on #1 being done first, since CORS is the delivery mechanism for the SSRF findings to become browser-reachable):
   - Add host/IP validation for provider `baseUrl` (§4).
   - Fix redirect-following in artifact download to re-validate the resolved host (§4).
   - Redact the `configuration` provider field on read (§6).
   - Bound uncompressed size during zip import (§6).

3. **Missing core requirements:**
   - Wrap the illustration-enqueue call in a try/catch so a DB error there cannot roll back an accepted turn (§6) — directly related to fixing item #1's second bullet.
   - Extend world-version deletion tests to cover the remaining 3 blocker categories (§5/§6).

4. **Reliability and error handling:**
   - Add a concurrency-race test for generation job claiming and fix anything it reveals (§5/§6) — the underlying Postgres primitives look correct, but this should be proven, not assumed, given `generation-service.ts`'s bug-fix history.
   - Add a concurrent-replica test for migration advisory locking (§5).
   - Add a bounded forced-exit path for worker shutdown if a provider call hangs (§6).

5. **Test improvements:**
   - Re-enable the skipped `world-library.integration.test.ts:850` test.
   - Add the identity-spoofing-rejection and bootstrap-idempotency tests AGENTS.md already requires (§5).
   - Add a real-Postgres integration counterpart for `semantic-memory-auto-enable.test.ts` (§5).
   - Add a zip-path-traversal regression test even though the implementation is already safe (§3/§5).

6. **Architecture and maintainability improvements:**
   - Add characterization tests to `asset-service.ts` before further feature work touches it; consider splitting `queryAssets`'s dual filter/facet logic into a single shared builder to eliminate the desync risk (§6/§9).
   - Extract the duplicated "load-or-404" asset-loading helper (§6).
   - Address `apps/web/public/nexus.js` per the tool's own refactor-first directive if/when substantial frontend work is next planned (§9).

7. **Documentation clarifications:**
   - Resolve the capabilities.md vs. deferred-improvements.md narration-streaming ambiguity (§8).
   - Update AGENTS.md's Story Memory Model section to match ADR 0010 (§8).
   - Address the already-self-documented duplicate-ADR-number and toolchain-version items (§8) — low effort, already tracked, just needs execution.

---

## 11. Final Assessment

**Rating: Ready with minor corrections.**

The core product guarantees this system exists to provide — durable, idempotent story generation; mechanics/fiction separation; world-version immutability; campaign isolation; Chronicle memory integrity — are implemented correctly, transactionally enforced (not just claimed), and largely proven by targeted, well-designed tests that check the actual failure mode rather than merely exercising code paths. This is a stronger foundation than most systems at this stage of maturity, and the review found zero Critical findings.

What stands between this system and a clean "Ready for release" rating is narrow and well-defined: an unsafe CORS default and two SSRF primitives that together undermine the trusted-network assumption the rest of the security model depends on, and two disabled integration tests that are the only automated proof of a documented resilience guarantee. None of these require architectural rework — they are targeted fixes with clear acceptance criteria, all listed with required tests above. Once the four immediate/security items in §10 (steps 1–2) are addressed, this system would merit a "Ready for release" rating under its documented trusted-network, pre-authentication threat model.
