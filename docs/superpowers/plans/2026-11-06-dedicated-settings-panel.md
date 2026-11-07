# Dedicated Settings Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document authorizes no deployment; execute only when implementation is requested.

**Goal:** Deliver a dedicated general Settings destination while keeping all personal preferences under the user icon's User Profile menu, and migrate all 40 reviewed environment candidates into a protected, database-backed installation-settings workflow.

**Architecture:** Keep personal and device preferences in User Profile, separate from general Settings; retain campaign, provider and prompt ownership in their existing authorities. Add strictly typed installation revisions constrained by deployment policy, with separate requested and active revisions. In release one, every installation-setting change is staged and activated through an operator-controlled drain/restart procedure; no UI action edits environment files, accesses Docker, or silently changes running jobs.

**Tech Stack:** Existing TypeScript, Zod, PostgreSQL, Fastify, vanilla TypeScript/Vite clients, native and Web Awesome UI adapters, Vitest, and Playwright. Follow the repository's pinned Node and pnpm versions; add no framework.

**Spec:** [Refreshed environment review](../../review/2026-11-06-environment-settings-gui-review.md), supplemented by the concrete design decisions below. Source: local main `e42b2cb8`; inspected checkout `d565746f`. Remote main currently advertises `555e97da`. Do not reset or switch this working tree to implement the plan. Start an isolated implementation branch from the reviewed local main after checking whether newer authoritative work exists.

## Global Constraints

- Preserve the existing initial-owner UUID and idempotent bootstrap behavior.
- A world is reusable authored content; a world version is immutable; campaigns and accepted turns must not be rewritten by settings changes.
- Text generation and image generation must remain independent provider concerns.
- Credentials remain separate deployment secrets or existing encrypted provider credentials, never general settings values.
- The base Swarm stack's System Archive hard-disable remains authoritative.
- Keep `/story` and `/app/story` separate and working. Do not modify the reference root `index.html`.
- Do not treat the server-resolved initial owner as an authenticated administrator.
- Preserve mechanics-separation, prompt-version, chain-compatibility, and frozen-job safeguards.
- Installation configuration is nonportable; System Archive remains portable owner data, not deployment recovery.
- All 40 installation controls are restart-required in release one. Personal/provider/campaign behavior retains its existing save semantics.
- Preserve source configuration during migration. No deletion of `.env`, no automatic enablement, no paid provider probe, no historical scan, and no automatic credential transfer.
- All personal preferences remain under User Profile in the user icon menu, in both active clients. General Settings must not duplicate or relocate those controls. User identity is resolved on the server; installation management permission never grants ownership of another user's settings or content.

## Review Focus

1. Two editors save different values from the same revision: one succeeds; the other receives a conflict without losing its draft (Tasks 2, 4, 5).
2. Replicas start with different policy files, old binaries, or different active revisions: settings activation/readiness must not report a healthy consistent installation (Tasks 3, 6, 12).
3. Automatic matching is turned off with admitted discovery work outstanding: frozen identity policy survives while new relaxed matching and lexical mention work stop after activation (Task 9).
4. Browser storage is unavailable or a campaign changes during a settings request: no cross-campaign save, stale render, or destructive preference reset (Tasks 5, 10, 11).
5. A revision reduces archive limits or disables sharing while old authority exists: fail closed without deleting accepted state, silently extending authority, or reviving revoked access (Tasks 7, 8, 9).

## Decisions and scope

### Separate User Profile and general Settings destinations

Canonical general route: `/app/settings`. Use `section` and optional `campaignId` query parameters with an allowlisted section parser. The page remains accessible in native and Web Awesome builds. Add Settings navigation to the replacement shell and the active legacy Nexus/Story surfaces. The user icon continues to open User Profile; it must not redirect to general Settings. Preserve old nonpersonal deep links as compatibility entry points until their editors have parity; final links open the equivalent Settings section with explicit campaign identity and a safe return destination.

User Profile contains display name, automatic choice submission, continuous reading, default turn style, all reader typography/width/theme preferences, and an **On this device** subsection for replacement theme, story width and artwork visibility. Keep quick reader controls as shortcuts to the same personal authority. These controls are available independently of operator unlock and never create installation revisions.

| Section | Authority and scope | Included controls |
| --- | --- | --- |
| Providers | Existing owner-scoped provider APIs | Separate text, embedding and image profiles; endpoint/model/preset/default/structured-output controls; supported Sogni and embedding options; write-only credential entry |
| Prompts | Existing Prompt Library APIs | Application and selected-campaign overrides, preview/reset, inherited values and protected validation |
| Campaign | Existing campaign APIs; explicit selector | Story behavior, Story Memory and continuity review, context budget, Chronicle, illustrations, provider assignments; no implicit bulk edits |
| Characters and AI Authoring | Protected installation revisions | Character editing, discovery, automatic matching, context and backfill; durable and source authoring; workspace review actions remain in Characters |
| Sharing and Data Transfer | Protected installation revisions | Share-link capability, archive capability, retention, chunk sizes and archive limits; actual import/export workflows remain in Data Transfer |
| Performance and Requests | Protected installation revisions | Queue timing, generation/provider capacity, body/rate/concurrency limits |
| Diagnostics and Deployment | Protected sanitized status | Log level, requested/active revisions, application status, effective locks/limits and build identity; no environment dump |

Do not collapse device theme into server reader theme: the stores have different current semantics and values, including sepia in reader preferences. Clearly label their scope within User Profile. Consolidation means shared reusable editors and navigation, not copying everything into an installation JSON blob. Provider and prompt content should be loaded only when their sections open. The general panel's provider/prompt/campaign sections remain explicitly owner- or campaign-scoped; placing them here does not make credentials, profiles or overrides shared across users. Do not introduce shared provider access as part of this plan.

### Multiple-user readiness

Keep profile reads/writes through the server-resolved current-user APIs; never accept a browser-supplied owner UUID as authorization. Retain the initial-owner bridge today, with a replaceable request-identity port for future login. Add two-user integration fixtures now to prove ownership isolation without implementing OIDC or transferring initial-owner content to the first future login.

Partition device preferences and caches by the server-returned internal user UUID, including campaign/turn artwork keys. Preserve legacy preference values through a one-time migration for the existing initial owner only; do not import the same unscoped values for every future user. Mark the migration per user, retain legacy data for rollback, and ignore legacy fallback for other users. Before identity loads, use neutral/default presentation rather than displaying a previous user's preference cache. On identity changes, cancel requests, dispose profile/campaign/provider/prompt editors, clear in-memory drafts and sensitive data, and reload the new identity's preferences. Scope cross-tab events to the active user. Operator sessions must be bound to the current server-resolved actor and rejected when it changes; an operator unlock must not survive account switching.

The advantage of one combined panel would be a single search/navigation surface, but it would mix everyday personal controls with privileged installation changes. That benefit does not outweigh the ownership clarity of the two destinations here. Shared editor components can still avoid duplicate implementation without combining their navigation.

### Protection of installation management

Introduce a narrowly scoped operator unlock; do not implement full OIDC as part of this feature. New bootstrap controls are deployment-only:

- `SETTINGS_MANAGEMENT_ENABLED=false` by default.
- `SETTINGS_MANAGEMENT_KEY_FILE`: separately provisioned high-entropy operator secret, at least 32 random bytes, never auto-derived from database/provider keys. No browser-readable value and no plaintext database copy.
- `INSTANCE_SETTINGS_POLICY_FILE`: read-only, nonsecret JSON policy, explicitly mounted into all API/worker roles. Version 1 policy includes installation ID, allowed feature gates, numeric bounds, approved rate tuples, expected role configuration, and minimum settings protocol version. No arbitrary executable content or secret references inside this policy.

The settings UI exchanges a manually supplied management key at `POST /api/v1/settings/operator-session` for a random 256-bit opaque session token. Persist only its SHA-256 digest with server-resolved actor UUID, creation/expiry, and the keyed secret-version fingerprint. Use an HttpOnly, Secure, SameSite=Strict cookie scoped to `/api/v1/settings`, absolute lifetime 15 minutes, no sliding renewal. Require HTTPS for management; use TLS locally through the supported deployment path. All installation reads/writes require the operator session. Key rotation immediately invalidates sessions by fingerprint comparison. Ordinary personal/provider/campaign endpoints retain their current trusted-network/ownership model.

Require an exact same-origin Origin header for session creation and mutations, reject missing/null/cross-origin values, and do not expand CORS. Require a per-session CSRF token held in page memory for authenticated mutations. Rate-limit unlock attempts durably per trusted client identity and globally, with fixed operator limits independent of editable request controls. Redact management keys, cookies, CSRF tokens and session bodies. Record audit attribution as the initial-owner UUID plus operator-session ID; this is a shared operator credential, not proof of an individual person's identity. A future authenticated administrator can replace this port without rewriting ownership.

Without the deployment flag, secret, policy, or HTTPS, installation controls are locked and no management session is created. Personal and campaign settings remain usable. Do not trust a browser header claiming an admin role or a proxy identity not established by configured trusted infrastructure.

### Persistence and revisions

Add the next additive migration after `0120` at implementation time; planned name `0121_instance_settings.sql` must be renumbered if another migration lands first. Do not edit existing migrations.

Tables:

- `instance_settings_state`: singleton installation UUID, active revision, requested revision, schema version, mode (`environment` or `database`), activation epoch, timestamps.
- `instance_settings_revisions`: immutable full allowlisted settings snapshot, monotonic bigint revision, actor UUID (server resolved), operator-session identifier or operator CLI provenance, previous revision, schema version, seed/proposal/rollback kind, timestamp. No credential fields.
- `instance_settings_events`: append-only audit of seed, proposal, activation, cancellation and rollback; allowlisted key names/revisions/reason codes, not raw environment or provider values.
- `instance_settings_runtime_reports`: opaque process UUID, role, build/protocol version, active revision, policy digest, activation epoch, heartbeat time, effective configuration digest, readiness state. Do not expose hostnames, addresses or paths in the ordinary UI.
- `settings_operator_sessions` and `settings_unlock_attempts`: expiring security authority, excluded from all portable exports. Bound cleanup so failed login traffic cannot grow these indefinitely.

Settings snapshots contain all 40 keys in camelCase, including both archive-limit groups. Validation is strict; unknown keys and secret-shaped extra properties are rejected. Booleans never accept string coercion. Integers must be finite safe integers, in bounds, and in the correct unit. Use bigint revisions as decimal strings in JSON.

`InstanceSettingsView` returns `{ activeRevision, requestedRevision, active, requested, fields, activationStatus }`. Revision references are nullable until initialized/activated: while in environment mode, `activeRevision` is null and `active` is a sanitized effective environment projection. Seed creates requested revision `1` without switching mode; first activation sets the active revision and database mode atomically. Each field has label, section, scope, unit, effective value, permitted range, source and deployment-lock reason, and `applyMode: 'restart'`. Never report a requested value as active. `InstanceSettingsPatch` is `{ expectedRequestedRevision, changes, reason }`, with a strict partial of the 40-key schema. Empty changes and no-op submissions do not generate revisions. Patch/CAS and audit insertion are one transaction. Conflicts return HTTP 409 plus current revision, never silently merge drafts.

### Migration and precedence

Resolve effective configuration in this order: immutable deployment security/bootstrap settings; deployment capability ceilings and numeric/rate policy; active persisted preferences; legacy effective runtime defaults only while mode is `environment`. Explicit emergency disablement always wins. The UI cannot change any source above persisted preferences.

Retain existing feature environment switches as hard permission gates, including `CAST_AUTO_MATCH_ENABLED`. A true persisted preference cannot override a false deployment gate. An operator may permit a capability and leave the GUI preference off; changing a deployment gate alone must not silently turn that preference on after migration.

For numeric settings, the policy's default ceiling is the effective pre-migration value unless an operator explicitly approves another ceiling within reviewed runtime bounds. For the rate-limit window, approve full window/count tuples or validated ranges with a maximum effective rate; reducing a window is not automatically safer. Legacy environment values become one-time seeds, not recurring overrides. Reset means the documented safe seeded default constrained by current policy, not re-reading the latest shell environment.

Never seed from the first arbitrary API replica. Provide an operator CLI to export an allowlisted effective snapshot per runtime role using the actual container configuration. Compare shared values and explicitly reconcile role-specific pool/topology information. Hash and review the sanitized seed. A single transaction under an advisory lock imports the seed once. Existing settings win on repeated seed; mismatched repeat import fails with a fixed error. Test `.env.example` values that Compose does not forward: they must not become accidental seeds.

New installations follow the same explicit initialization workflow. Until initialized, runtime stays in environment mode and installation edits remain locked. No automatic database-mode transition occurs merely because a new binary starts.

### Application and rollback

All installation changes are staged in release one. Save returns “Saved — restart required”; the GUI does not activate, restart, or deploy. This deliberately avoids modifying Fastify parser limits, worker lanes, provider constructors and frozen admissions in place. Even log/poll settings use this common behavior initially; hot reload can be a separate later change.

Operator activation uses `scripts/instance-settings.ts` with commands `export-seed`, `seed`, `status`, `validate`, `activate`, and `propose-rollback`. It reads only the normal database/bootstrap secrets and the policy; it never controls Docker. The activation procedure must:

1. Validate the desired revision against every intended role's policy, database pool and implementation protocol; verify image identities externally. Reports are evidence, not proof that an uninstrumented old process is absent.
2. Stop new application intake at ingress and stop/drain every API and worker/combined process using the deployment runbook. Retain the ten-minute worker stop grace. Verify no old processes and no active leases/invocations remain; explicitly paused/recoverable work retains its frozen inputs.
3. Supply an operator-recorded maintenance reference and expected active/requested revision to `activate`. The CLI rejects mismatches, live runtime heartbeats, active relevant leases, incompatible schema/protocol or policy. Check generation, cast, authoring, illustration, archive and other relevant lanes, not only story jobs.
4. Under an advisory lock, recheck the guards and activate the desired immutable revision/epoch. Start only compatible binaries with the same policy and current epoch. A process must validate the database mode/revision before it becomes ready or claims work.
5. Check reports from the deployment's expected API/worker roles and replica counts, effective settings digest and `/health/ready`; then restore ingress. A missing or stale report never counts as an acknowledgment. A restarted process cannot resurrect an old revision.

No rolling activation with different active revisions in release one. Do not use a timeout as proof that all old binaries stopped. Startup policy mismatches fail readiness rather than silently clamping an active revision differently across replicas. Deployment emergency disables may force a capability off, but report divergence and require coordinated restart before healthy service resumes.

Rollback proposes the prior allowed snapshot as a new revision, validates against the current stricter deployment policy, and uses the same drain/restart procedure. Keep all additive tables, revisions and authoritative story data. A pre-settings binary ignores the new store: rolling back to it requires exporting a compatible nonsecret environment override, verifying effective parity offline, disabling database mode under maintenance, and restarting all roles. Never claim an image rollback alone restores GUI-managed settings. Cast v2 authority requires a v2-aware rollback binary independently of this feature.

## Complete candidate ownership matrix

Every row is installation-scoped, nonportable and restart-required. The original review supplies exact defaults and bounds; preserve them unless the row specifies additional constraints. IDs are the exact schema property names, not arbitrary UI input names.

| Environment setting | Persisted field | Implement/verify in task |
| --- | --- | --- |
| `LOG_LEVEL` | `logLevel` | 6 |
| `WORKER_POLL_INTERVAL_MS` | `workerPollIntervalMs` | 6 |
| `TEXT_PROVIDER_CONCURRENCY` | `textProviderConcurrency` | 6 |
| `ARCHIVE_PREVIEW_TTL_SECONDS` | `archivePreviewTtlSeconds` | 7 |
| `SYSTEM_ARCHIVE_ARTIFACT_TTL_SECONDS` | `systemArchiveArtifactTtlSeconds` | 7 |
| `SYSTEM_ARCHIVE_UPLOAD_TTL_SECONDS` | `systemArchiveUploadTtlSeconds` | 7 |
| `SYSTEM_ARCHIVE_CHUNK_BYTES` | `systemArchiveChunkBytes` | 7 |
| `AI_AUTHORING_JOBS_ENABLED` | `aiAuthoringJobsEnabled` | 9 |
| `AI_STORY_SOURCE_AUTHORING_ENABLED` | `aiStorySourceAuthoringEnabled` | 9 |
| `CAST_EDITING_ENABLED` | `castEditingEnabled` | 9 |
| `CAST_DISCOVERY_ENABLED` | `castDiscoveryEnabled` | 9 |
| `CAST_AUTO_MATCH_ENABLED` | `castAutoMatchEnabled` | 9 |
| `CAST_CONTEXT_ENABLED` | `castContextEnabled` | 9 |
| `CAST_BACKFILL_ENABLED` | `castBackfillEnabled` | 9 |
| `WORLD_SHARING_ENABLED` | `worldSharingEnabled` | 9 |
| `SYSTEM_ARCHIVE_ENABLED` | `systemArchiveEnabled` | 7, 9 |
| `WORKER_GENERATION_CONCURRENCY` | `workerGenerationConcurrency` | 6 |
| `API_DEFAULT_BODY_LIMIT_BYTES` | `apiDefaultBodyLimitBytes` | 8 |
| `API_IMPORT_BODY_LIMIT_BYTES` | `apiImportBodyLimitBytes` | 8 |
| `API_ASSET_BODY_LIMIT_BYTES` | `apiAssetBodyLimitBytes` | 8 |
| `API_RATE_LIMIT_WINDOW_SECONDS` | `apiRateLimitWindowSeconds` | 8 |
| `API_RATE_LIMIT_PROVIDER_REQUESTS` | `apiRateLimitProviderRequests` | 8 |
| `API_RATE_LIMIT_GENERATION_REQUESTS` | `apiRateLimitGenerationRequests` | 8 |
| `API_RATE_LIMIT_IMPORT_REQUESTS` | `apiRateLimitImportRequests` | 8 |
| `API_CONCURRENCY_PROVIDER_REQUESTS` | `apiConcurrencyProviderRequests` | 8 |
| `API_CONCURRENCY_IMPORT_REQUESTS` | `apiConcurrencyImportRequests` | 8 |
| `CAMPAIGN_ARCHIVE_MAX_COMPRESSED_BYTES` | `campaignArchiveLimits.maxCompressedBytes` | 7 |
| `CAMPAIGN_ARCHIVE_MAX_UNCOMPRESSED_BYTES` | `campaignArchiveLimits.maxUncompressedBytes` | 7 |
| `CAMPAIGN_ARCHIVE_MAX_ENTRIES` | `campaignArchiveLimits.maxEntries` | 7 |
| `CAMPAIGN_ARCHIVE_MAX_EXPANSION_RATIO` | `campaignArchiveLimits.maxExpansionRatio` | 7 |
| `CAMPAIGN_ARCHIVE_MAX_MANIFEST_BYTES` | `campaignArchiveLimits.maxManifestBytes` | 7 |
| `CAMPAIGN_ARCHIVE_MAX_JSON_ENTRY_BYTES` | `campaignArchiveLimits.maxJsonEntryBytes` | 7 |
| `CAMPAIGN_ARCHIVE_MAX_ORIGINAL_IMAGE_BYTES` | `campaignArchiveLimits.maxOriginalImageBytes` | 7 |
| `SYSTEM_ARCHIVE_MAX_COMPRESSED_BYTES` | `systemArchiveLimits.maxCompressedBytes` | 7 |
| `SYSTEM_ARCHIVE_MAX_UNCOMPRESSED_BYTES` | `systemArchiveLimits.maxUncompressedBytes` | 7 |
| `SYSTEM_ARCHIVE_MAX_ENTRIES` | `systemArchiveLimits.maxEntries` | 7 |
| `SYSTEM_ARCHIVE_MAX_EXPANSION_RATIO` | `systemArchiveLimits.maxExpansionRatio` | 7 |
| `SYSTEM_ARCHIVE_MAX_MANIFEST_BYTES` | `systemArchiveLimits.maxManifestBytes` | 7 |
| `SYSTEM_ARCHIVE_MAX_JSON_ENTRY_BYTES` | `systemArchiveLimits.maxJsonEntryBytes` | 7 |
| `SYSTEM_ARCHIVE_MAX_ORIGINAL_IMAGE_BYTES` | `systemArchiveLimits.maxOriginalImageBytes` | 7 |

Remain deployment-owned: every exclusion in the refreshed review, plus the three new management/bootstrap controls. In particular, do not migrate `HISTORY_COVERAGE_ENABLED`, native-plan admission, Story Memory capability/enforcement ceilings, schema-verification evidence, network allowlists, trust-proxy/CORS/CSP rules, root encryption material, lease duration, database pool sizing or filesystem roots. Existing campaign Story Memory controls stay editable only under their ceilings.

## File structure and boundaries

New filenames below are proposed; existing files are named at their current paths. Export new public types/functions from each package's existing `src/index.ts`, and update package/type-check entrypoints only when required. Keep `packages/application` free of Fastify, filesystem and database imports.

- `packages/contracts/src/instance-settings.ts`: strict snapshot, patch, policy-projection and response schemas; operator-session request/response schema kept separate from settings values.
- `packages/domain/src/instance-settings.ts`: pure registry, dependency and capacity/rate-policy resolution.
- `packages/application/src/settings/{types,ports,use-cases,index}.ts`: orchestration and ports, revision/activation decisions.
- `packages/database/src/instance-settings-repository.ts`: atomic revision/state/audit persistence and reporting.
- `packages/database/src/settings-operator-repository.ts`: sessions and bounded login-attempt accounting.
- `services/runtime/src/instance-settings-{policy,composition}.ts`: mounted policy parsing, startup merge and role/readiness reports.
- `services/api/src/instance-settings-routes.ts`, `settings-operator-session.ts`: protected HTTP adapter and unlock boundary.
- `scripts/instance-settings.ts`: documented offline seed/activation/status/rollback operator command.
- `packages/client-web/src/instance-settings-api.ts`: typed browser adapter; provider/prompt API adapters added alongside it, not copied into views.
- `packages/client-core/src/settings-session.ts`: draft/revision/conflict state machine without DOM or storage.
- `apps/web-next/src/settings/{page,sections,instance-editor,provider-editor,prompt-editor,campaign-editor}.ts` and `settings.css`: thin general/contextual editors over shared authorities and existing adapters. Personal editors stay under the existing `preferences/` and user-profile modules.
- `docs/architecture/instance-settings.md`: accepted architecture at implementation; `docs/runbooks/instance-settings.md`: seed/activation/recovery procedures. Do not mark this planning proposal as implemented architecture yet.

## Execution tasks

Tasks 1–6 provide a protected but initially nonactivated foundation. Tasks 7–9 complete all runtime mappings before enabling database mode. Tasks 10–11 complete consolidation; Task 12 is the release gate. Each task is a reviewable commit. Do not ship a control whose runtime consumer is not connected and tested.

### Task 1: Define the registry and deployment policy

**Files:** Create the contract and domain modules above; modify their package exports; add `tests/unit/instance-settings-contract.test.ts` and `instance-settings-policy.test.ts`. Read current `packages/database/src/config.ts` and existing `tests/unit/security-config.test.ts` for every range.

**Interfaces:** Export `InstanceSettings`, `InstanceSettingsPatch`, `InstanceSettingsView`, `DeploymentSettingsPolicy`, `RuntimeRoleCapacity`, and `SettingsFieldDescriptor`. Export `resolveInstanceSettings(requested: InstanceSettings, policy: DeploymentSettingsPolicy, capacity: RuntimeRoleCapacity): SettingsResolution`, where the discriminated result is `{ ok: true, effective, fields }` or `{ ok: false, errors }`. `RuntimeRoleCapacity` carries role and database pool maximum; policy carries existing hard feature gates and operator-approved bounds.

- [ ] Write failing tests with assertions `expect(INSTANCE_SETTING_FIELDS).toHaveLength(40)` and `expect(resolveInstanceSettings(autoMatchOn, editingOffPolicy, workerCapacity).effective.castAutoMatchEnabled).toBe(false)` after narrowing the successful result. Assert every reviewed environment name maps exactly once; unknown keys, numeric strings, NaN, negative sizes and secret keys fail.
- [ ] Run `pnpm exec vitest run tests/unit/instance-settings-contract.test.ts tests/unit/instance-settings-policy.test.ts`; confirm a meaningful failure before implementation.
- [ ] Implement strict schemas, enum log levels (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`), 40 descriptors, dependency resolution and typed error codes. Validate worker concurrency 1–4 and pool headroom (`+4` worker, `+8` combined). Reject policy/rate incompatibilities; show feature suppression as locked effective false without overwriting the saved preference. Preserve reviewed maximum ceilings unless an explicit deployment exception already permits them.
- [ ] Re-run the focused tests and existing security configuration tests; all pass. Commit `Define installation settings contracts and policy`.

### Task 2: Persist immutable revisions and security state

**Files:** Add the next migration, both database repositories, application settings modules/exports, `tests/integration/instance-settings.integration.test.ts`, and `tests/unit/instance-settings-application.test.ts`.

**Interfaces:** `SettingsRepositoryPort.read(): Promise<SettingsState>`; `propose(input: { expectedRequestedRevision: string; snapshot: InstanceSettings; actor: SettingsActor; reason: string }): Promise<SettingsState>`; `seed(input: SettingsSeed): Promise<SettingsState>`; `activate(input: ActivationRequest): Promise<SettingsState>`. Define `SettingsState` as persisted mode/state and immutable revision references, `SettingsActor` as server-resolved actor plus operator session/CLI provenance, `SettingsSeed` as snapshot/policy digest/seed digest, and `ActivationRequest` as expected revisions, policy digest and maintenance reference. Keep all validation in shared use cases before repository commit, with database CAS as final authority.

- [ ] Write tests asserting two concurrent proposals from revision `1` yield exactly one revision `2` and one conflict; no-op has no extra audit row; rollback appends a revision; changing an existing revision fails; invalid snapshots never persist; repeated seed is idempotent only when its digest matches.
- [ ] Run the new unit test and `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/instance-settings.integration.test.ts`; confirm expected failures with actual PostgreSQL tests executing.
- [ ] Implement constraints, immutable revision protection, transactional CAS/audit/seed, server actor attribution, expiring operator sessions and bounded attempt records. Initial migration creates environment mode only; it does not read an environment file or enable features.
- [ ] Re-run tests and migration/initial-owner coverage. Commit `Persist installation settings revisions`.

### Task 3: Build seed and activation tooling

**Files:** Create runtime policy/composition modules and CLI; modify `packages/database/src/config.ts`, `services/runtime/src/main.ts`, `runtime-role.ts`, `lifecycle.ts`, package exports and `package.json`; add `tests/unit/instance-settings-cli.test.ts`, `instance-settings-runtime.test.ts`, and `tests/integration/instance-settings-activation.integration.test.ts`.

**Interfaces:** `loadDeploymentSettingsPolicy(path: string): DeploymentSettingsPolicy`; `loadActiveRuntimeSettings(pool: DatabasePool, bootstrap: RuntimeConfig, policy: DeploymentSettingsPolicy): Promise<ResolvedRuntimeSettings>`; `ResolvedRuntimeSettings` includes the resulting `RuntimeConfig`, mode, active revision, policy digest and epoch. `runInstanceSettingsCommand(args: readonly string[], ports: SettingsOperatorPorts): Promise<number>` supplies testable filesystem/database/status ports. Settings reports and lifecycle disposal are wired through composition, not global timers in domain code.

- [ ] Test seed from effective role config rather than `.env` text, false-valued gates, inconsistent API/worker snapshots, missing required policy, repeat starts, unsupported schema, and rollback under tightened policy. Assert `activate` refuses live reports/leases and stale expected revisions and never calls a process-execution port.
- [ ] Run the named new tests, including the integration configuration; verify expected failures.
- [ ] Implement the mode switch and documented activation transaction. Add runtime reports every 10 seconds, stale after 30 seconds; a stale report is missing evidence, never proof of safe shutdown. Require operator maintenance reference plus database guards. Refuse database-mode startup without the matching policy/protocol. In environment mode preserve current startup behavior. Bootstrap pool/migrations remain environment-based; only load persisted application settings after schema readiness and before constructing server/worker/provider components.
- [ ] Add `pnpm settings:operator` mapped to the CLI. Exercise `export-seed → seed → propose → activate → restart → status → propose-rollback` against an isolated database; inspect only sanitized output. Re-run runtime lifecycle/shutdown suites. Commit `Add controlled settings initialization and activation`.

### Task 4: Protect and expose installation APIs

**Files:** Add protected route/session modules; modify `services/api/src/server.ts`, logger redaction and runtime secret loading; add `tests/unit/instance-settings-routes.test.ts`, `settings-operator-session.test.ts`, and `tests/integration/settings-operator-session.integration.test.ts`.

**Interfaces:** `registerInstanceSettingsRoutes(app, { settings, operatorSessions, resolveActor }): void` binds `GET/PATCH /api/v1/settings/instance`, `GET /api/v1/settings/instance/history`, session POST and DELETE. `SettingsOperatorSessionPort` exposes `unlock`, `authorize`, `revoke` with server-owned expiration/CSRF checks. There is deliberately no activation/restart HTTP endpoint. GET/PATCH return the contract from Task 1; history is paginated, at most 100 entries per response.

- [ ] Test unauthenticated denial, wrong/absent origin, missing CSRF, expired cookie, HTTP refusal, disabled management, mismatched secret fingerprint, concurrent edits, hostile unknown input, and failed unlock across two API replicas. Assert the response/logs contain none of a planted management key, database URL or provider secret. The fixed unlock limit is 5 failures per trusted client per 15 minutes and 50 globally per 15 minutes; management sessions expire after 900 seconds.
- [ ] Run new unit/integration tests and existing `server-security.test.ts`/`request-security.test.ts`; confirm new tests fail for the intended reasons.
- [ ] Implement durable attempt/session storage, constant-time secret comparison, exact-origin checks, cookie/CSRF protection, redaction and strict response projection. Return safe 401/403/409/422/503 distinctions; do not return raw parsing/SQL errors. Keep management body limit fixed at 64 KiB independently of GUI request limits.
- [ ] Re-run all focused tests; verify profile/campaign endpoints still resolve ownership as before. Commit `Protect installation settings management`.

### Task 5: Create the dedicated Settings destination

**Files:** Add client-core session, browser API, Settings page/sections/instance editor/styles; modify `apps/web-next/src/bootstrap.ts`, `app-shell.ts`, `app-shell-menus.ts`, `app-shell-lifecycle.ts`; add `tests/unit/settings-session.test.ts`, `settings-page.test.ts`, `tests/e2e/settings-panel.e2e.test.ts`.

**Interfaces:** `createSettingsSession(api: InstanceSettingsApi): SettingsSession` supports `load`, `edit`, `save`, `discard`, `subscribe`, `dispose`; `mountSettingsPage(root: HTMLElement, route: SettingsRoute): MountedPage`; `parseSettingsRoute(url: URL): SettingsRoute | null`. Route fields use an allowlisted `SettingsSection` and validated optional campaign UUID. The session tracks draft, requested and active values separately.

- [ ] Write tests asserting Save leaves active values unchanged, shows “Saved — restart required”, 409 retains the draft, logout clears operator drafts/secrets, and route disposal prevents late response rendering. Verify a foreign campaign UUID cannot become a writable campaign through the route alone.
- [ ] Run new unit/browser fixture tests and confirm expected failures.
- [ ] Implement categorized sections, visible scope labels, contextual help, unit labels, default/reset preview, blocked dependency reasons, requested-versus-active diff and accessible validation summaries. Use explicit Save/Discard per installation section. Show a review summary before saving changes to sharing or resource policy; never imply that Save activates them. Keep operator key only in the unlock form memory and clear it after submission.
- [ ] Verify keyboard navigation, focus restoration, reload/deep links, blocked storage, 390px mobile and desktop, native and Web Awesome builds. Save screenshots under `docs/review/assets/settings-panel/`. Commit `Add dedicated Settings panel`.

### Task 6: Connect performance and diagnostics consumers

**Files:** Modify runtime composition/main, `packages/logger/src/index.ts`, `services/worker/src/worker.ts`, `services/runtime/src/provider-application-composition.ts`, and `packages/database/src/text-provider-capacity-repository.ts` only if the existing capacity API requires revision metadata; add `tests/unit/instance-settings-performance.test.ts` and `tests/integration/instance-settings-performance.integration.test.ts`.

**Interfaces:** Consumers receive the active `ResolvedRuntimeSettings` from Task 3. Do not introduce a second settings cache inside workers/providers. Logger bootstrap uses the environment until the active installation snapshot loads, then adopts that snapshot before accepting work.

- [ ] Test all four fields: log enum/redaction, polling bounds, generation slots and shared text capacity. Assert combined concurrency 4 requires pool ≥12, worker-only concurrency 4 requires pool ≥8, and a staged concurrency revision changes neither active slots nor admitted requests. Assert text capacity retains current cast-discovery-dependent semantics and does not falsely claim to cap unrelated provider routes.
- [ ] Run new tests plus `worker-concurrency.test.ts`, `runtime-shutdown.test.ts`, `text-provider-capacity.test.ts` and logger tests; establish expected failing coverage first.
- [ ] Connect active values before constructing scheduler/capacity/logger clients; update diagnostics labels to show per-worker versus shared request capacity. Report each process's active digest without exporting private process details.
- [ ] Re-run tests with two worker processes and a deterministic provider. Preserve separate illustration/Chronicle/asset lanes, drain behavior and unique accepted-turn guards. Commit `Apply persisted performance settings at startup`.

### Task 7: Connect all transfer settings and pin transfer policy

**Files:** Modify `services/api/src/archive-routes.ts`, `system-archive-routes.ts`, `services/runtime/src/system-archive-composition.ts`, archive upload/export repositories and archive contracts as needed; add a separate additive migration for transfer-policy snapshots if current durable records cannot retain them. Add `tests/integration/instance-settings-transfers.integration.test.ts` and extend related archive unit tests.

**Interfaces:** `ArchivePolicySnapshot` is `{ version: 1, settingsRevision: string, previewTtlSeconds, artifactTtlSeconds, uploadTtlSeconds, chunkBytes, limits }`; use separate campaign/system snapshot values. New transfer authority stores the applicable snapshot. Existing historical records use their persisted expiration and baseline policy, not a silently extended lifetime.

- [ ] Test the four TTL/chunk fields, both seven-field limit groups, and archive enablement. Assert campaign/world preview 1,800-second default remains independent of System Archive's fixed 1,800-second database-clock authority. Assert a previously issued artifact keeps its recorded expiry, and resumed upload renewals use the session's original inactivity TTL.
- [ ] Test policy tightening across restart: reject oversized new chunks before buffering, preserve prior staged files, require fresh preview for incompatible commit policy, never relax a historical preview from a later increase, and never bypass insufficient space. Run with the integration config to establish failing cases.
- [ ] Apply current hard ceilings and the stricter of stored transfer policy/current active policy where safety limits interact. TTLs and chunk contracts for a session are retained; if a new hard limit makes continuation impossible, return a recoverable restart-transfer requirement, not silent corruption. Keep cleanup running for previously issued authority when admission is disabled. Base Swarm stays locked off.
- [ ] Run archive route, worker, preview-hardening, upload reconciliation and portability suites; use actual streamed multipart data for size tests. Commit `Migrate transfer settings with durable policy snapshots`.

### Task 8: Connect request resource controls

**Files:** Modify `services/api/src/server.ts`, route limit construction and existing rate/concurrency consumers found by their RuntimeConfig fields; add `tests/unit/instance-settings-request-limits.test.ts` and `tests/integration/instance-settings-request-limits.integration.test.ts`.

**Interfaces:** Build Fastify and route options only from the active snapshot. `resolveRequestPolicy(settings: InstanceSettings, policy: DeploymentSettingsPolicy): RequestPolicy` returns validated limits for all nine fields; `RequestPolicy` is the request-limit subset already consumed by `RuntimeSecurityConfig`, excluding CORS/CSP/proxy/network controls.

- [ ] Assert all nine mappings, out-of-policy rejection, shortening a window without a compensating count reduction rejection, independent management unlock limits, request-body boundaries before buffering, and unchanged active behavior after Save but before restart. Exercise requests of exactly the limit and limit+1 bytes.
- [ ] Run focused tests and request/server-security suites; verify failures precede wiring.
- [ ] Wire parsed active values at construction. Preserve existing distributed limiter semantics and reservations; do not clear rate history merely because a revision changes. For a changed window, preserve enforcement at least as strict as both old and new policy until the old window expires; test this explicitly to avoid a restart rate-limit reset.
- [ ] Re-run with two API replicas and both old/current rate history. Verify campaign archive limits still intersect import/asset limits. Commit `Migrate bounded request limits`.

### Task 9: Connect feature gates and automatic matching

**Files:** Modify runtime provider/cast/authoring composition, worker/API gate consumers and metadata; extend `tests/unit/security-config.test.ts`, `provider-application-composition.test.ts`, `campaign-cast-discovery-worker.test.ts`; add `tests/integration/instance-settings-features.integration.test.ts`.

**Interfaces:** All gates derive from `ResolvedRuntimeSettings`; cast admission continues to use existing frozen execution-plan contracts. New generation/discovery admissions record the settings revision where their protocol supports metadata; if adding it changes serialized contracts, version and retain older readers explicitly. No consumer reads requested settings.

- [ ] Test each of the nine feature toggles (the tenth conditional candidate is worker concurrency in Task 6). Assert editing→discovery→auto-match/context/backfill dependencies; hard gate false always wins; disabling authoring preserves cleanup; disabling source authoring permits eligible world/character jobs; enabling scans never enqueues a scan.
- [ ] Add auto-match regression assertions: default strict/v1, enabled `unique_name`/v2, admitted v2 job remains v2 after disabling auto-match, unchanged output protocol `cast-discovery-v1`, no new lexical mentions when disabled, ambiguous identities require review, detach/undo survives, and mention failure cannot reject accepted narration. Disabling discovery retains its existing claims/publication stop behavior; distinguish it from disabling only auto-match.
- [ ] Test sharing disable/re-enable with existing valid, expired and revoked tokens, and confirm revocation/management access remains available to the authorized owner while redemption is disabled. Test System Archive capability agreement across API/worker and topology hard-disable. Run the new integration suite to capture meaningful failures.
- [ ] Wire effective gates; preserve frozen queued-job behavior and existing recoverable/paused semantics, character history, campaign isolation and image independence. Ensure narrowing prompts/character context invalidates incompatible continuation chains via existing compatibility rules, not by editing accepted turns. Do not turn History Coverage or native-plan rollout switches into preferences.
- [ ] Run cast, authoring, sharing, generation-integrity and illustration-independent-failure coverage. Commit `Migrate feature preferences behind deployment gates`.

### Task 10: Preserve User Profile and consolidate Providers and Prompts

**Files:** Add Settings provider/prompt editors and shared typed API adapters; keep personal controls in `apps/web-next/src/preferences/profile-editor.ts`, `preferences-dialog.ts`, `display-preferences.ts`, `theme.ts` and `user-profile-menu.ts`. Reuse `packages/client-core/src/providers/selection-editor.ts`, `packages/client-web/src/provider-presets-api.ts`; carefully extract reusable logic from `apps/web/src/nexus.js` and `legacy-management-entry.ts`. Add `tests/unit/settings-existing-editors.test.ts`, `tests/unit/profile-user-isolation.test.ts`, `tests/integration/profile-user-isolation.integration.test.ts` and `tests/e2e/settings-provider-prompt-parity.e2e.test.ts`.

**Interfaces:** Existing `/api/v1/users/me/profile`, `/api/v1/providers*` and `/api/v1/prompt-library*` contracts remain authoritative. New `ProviderSettingsApi` and `PromptSettingsApi` are typed adapters over these routes, not duplicate business services. Each editor exposes `mount(root, ports): { dispose(): void }` and owns request cancellation.

- [ ] Build a parity checklist from actual legacy controls before extraction: all provider roles/adapters/options, blank-key-retains-secret behavior, health/model refresh, default profile, model/preset selection, explicit/inherited parameters, schema policy/evidence display, prompt inheritance/override/reset/preview and personal reader preferences. Every supported existing control must have a row and a test or a deliberate preserved entry point until its replacement passes.
- [ ] Write tests for retained blank keys, no returned credentials, independent image/text errors, provider role isolation, unchanged omitted policy fields, stale discovery response rejection, prompt protected validation and no cross-campaign override. Assert no installation revision is created by saving a personal/provider/prompt setting.
- [ ] Run new tests and existing profile/preferences, structured-output and provider-preset browser suites; confirm migration-related test failures before moving code.
- [ ] Implement provider/prompt editors in general Settings using the existing APIs and shared pure models; keep every personal/device control under the user icon's User Profile. Do not iframe the old management page or render untrusted markup. Migrate device keys to the user-scoped scheme described above with preserved legacy values, scoped cross-tab events and storage failure fallback. Provider preview/discovery occurs only on explicit user action, never on generic page load.
- [ ] Add two-user tests: A's profile update cannot change B's profile; spoofed owner IDs do not change authorization; account switch cancels an in-flight save/render; B cannot inherit A's device preferences, provider records or prompt overrides; unscoped preference migration runs only for the initial owner; operator sessions fail after actor change. Run the new unit and real-PostgreSQL isolation suites, and verify blocked browser storage still permits profile use without leaking prior-user state.
- [ ] Verify feature parity in native/Web Awesome, desktop/mobile and legacy entry links. Capture screenshots proving the user icon opens User Profile and general Settings contains no personal-preference section. Route old Provider Setup/Prompt Library entry points to completed general panels, while preserving profile entry points and deep-link campaign scope. Commit `Preserve user profile and consolidate general editors`.

### Task 11: Consolidate campaign settings and navigation

**Files:** Add Settings campaign editor; refactor `apps/web-next/src/campaign-editor-page.ts`, `campaign-editor-api.ts`, `campaign-continuity-editor.ts`, and existing legacy campaign settings sections into reusable adapters/views; update active `apps/web/public/index.html`, `story.html`, `apps/web/src/nexus.js`, `story.js` navigation only as needed. Add `tests/e2e/settings-campaign-parity.e2e.test.ts` and `tests/unit/settings-campaign-scope.test.ts`.

**Interfaces:** `CampaignSettingsContext` contains validated campaign ID and an abortable load epoch; use existing owner-scoped campaign routes for writes. All editors share this context. No global Save submits across campaigns or provider/prompt/instance authorities.

- [ ] Inventory and pin parity for story behavior, Story Memory/review, context budgets, Chronicle retrieval/indexing controls, illustration/art style/negative prompt, provider assignments and creation defaults. Keep character review/undo/scans in Characters and transfer actions in Data Transfer; provide contextual links from Settings rather than duplicate execution controls.
- [ ] Test switching A→B while A loads or saves; A's response cannot populate B and a B form cannot submit A's ID. Test inherited defaults, explicit campaign overrides, server-enforced limits and permission failures; no edit silently modifies another campaign or world version. Run the new tests to verify expected failures.
- [ ] Implement section-level saves, dirty-navigation protection and explicit campaign selector. Existing quick controls may remain but invoke the same shared editor/API logic. Preserve Story route coexistence and safe relative return links; reject external return URLs.
- [ ] Run both Story navigation suites, existing Story Memory and reader-preference browser tests, then full campaign-settings parity screenshots. Remove duplicate old form ownership only after parity is demonstrated. Commit `Consolidate campaign settings and entry points`.

### Task 12: Verify deployment migration, portability and rollback

**Files:** Update `.env.example`, `compose.yaml`, `deploy/swarm/stack.yaml`, validation override only if needed for explicit policy mount, installation environment/provider docs and deployment runbook. Add the new architecture/runbook documents and `docs/review/settings-panel-acceptance.md`; extend System Archive portability classification/tests for every new table. Add `tests/integration/instance-settings-rollout.integration.test.ts` and `tests/e2e/settings-panel-restart.e2e.test.ts`.

**Interfaces:** Deployment passes only bootstrap secrets/policy and retained gates. Document every remaining environment setting as seed, permanent gate, ceiling/bootstrap or obsolete. Keep old candidate variables accepted during the compatibility window; do not silently remove effective configuration from an existing deployment.

- [ ] Test a pre-settings database upgraded into environment mode with identical effective behavior; one-time seed; GUI Save; maintenance activation; two API/two worker startup; pending versus active status; concurrent restart; policy mismatch; absent old process evidence; safe rollback to an earlier snapshot. Include a separate old-binary rollback rehearsal using the generated compatible environment override.
- [ ] Verify System Archive omits installation revisions, management sessions, attempt counters, runtime reports and policy files. Import must not change destination configuration or trigger discovery/provider calls. Confirm all 40 controls are represented, enforced, and applied only from the active revision.
- [ ] Run focused tests, then `pnpm test:unit`, `pnpm test:integration`, `pnpm check`, `pnpm build`, `pnpm check:web-bundle-budget` and `git diff --check`. Run the new browser suites with both renderer configurations and current legacy regression suites. Record pass/fail/skip separately; no silently skipped PostgreSQL cases count as passes.
- [ ] Render Compose and Swarm with synthetic nonsecret inputs; verify base Swarm archive remains false, separate secrets, no database service added to Swarm, no Docker socket, no widened CORS/provider network policy, API/worker policy consistency, preserved stop grace and resource limits. Run a disposable Compose restart smoke test; actual multi-node Swarm checks must be recorded separately if unavailable.
- [ ] Publish the acceptance record with screenshots, a 40-row coverage checklist, effective seed comparison, restart/rollback evidence and limitations. Live-provider testing is separate and requires authorization if it incurs cost; deterministic-provider tests prove workflow behavior. Commit `Document and verify Settings migration and rollback`.

## Completion criteria

- Every candidate in the matrix has a validated GUI control, a database field, a runtime consumer, deployment constraints and a regression test. No setting is UI-only.
- New auto-match behavior preserves frozen admissions and optional mention tracking boundaries.
- Existing provider, prompt, personal/device and campaign settings have functional parity and retain their original authority and ownership.
- Personal/device preferences remain under the user icon's User Profile in every supported renderer. Two-user fixtures verify profile, local cache and account-switch isolation; general Settings never promotes owner-scoped resources into shared authority.
- No active value changes on installation Save; activation/restart and requested/active status are truthful across processes.
- Secrets, topology, security exceptions and protocol rollout gates remain outside editable settings.
- Migration and rollback preserve effective behavior, queued/recoverable work, accepted story authority and destination import policy.
- Rendered native/Web Awesome and legacy entry flows pass with desktop/mobile evidence.

## Planning verification

This plan refreshes the inventory from current source and records the single newly added environment candidate. It does not implement the panel, run application tests, change deployment configuration, activate flags, commit, or publish. Validate document links, the 40-name matrix against the review, and whitespace before handoff. The unrelated legacy Previous-navigation change and other untracked review documents remain outside this task.
