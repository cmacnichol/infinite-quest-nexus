# Persistent Legacy Story Activity Feed Design

Date: 2026-10-03
Status: Proposed implementation design; no product code implemented.
Baseline: `30a884a1230b80cf844879c027a380a374b849ac`.
Scope: the active legacy Story player in `apps/web`, served at `/story` and `/story/:campaignId`.

## Goal and boundaries

Implement option three from the review: database-backed operational history plus a bounded browser cache. Preserve background job events when the browser is closed, show useful safe errors, and restore history after reload without duplicating events. This is operational history, separate from accepted turns, campaign state, Chronicle, private provider evidence, and portable archives.

The first release covers Story generation and its review/retry/cancel/discard lifecycle, campaign illustration jobs and segment outcomes, and the legacy player's local API/monitoring observations. World authoring, Nexus dashboard-wide activity, cast/indexing job histories, the archived root `index.html`, and replacement-UI presentation are outside this release. Shared contracts and services should permit later clients. Keep both existing Story surfaces operational.

Previously lost browser entries cannot be recovered. Existing job snapshots are not a complete historical ledger: do not manufacture past transitions or silently backfill them. Record a campaign's durable-history start when its first new event is captured and explain this coverage limit in the UI. A first event for a pre-existing job may be a terminal event without its earlier phases.

## Product behavior

- Show recent cached activity immediately after current server identity and campaign access have been verified; reconcile with durable history in the background. On a cold offline reload, do not guess the user from remembered identity or expose another user's cache. Explain that identity verification is needed.
- Group server events by generation job or illustration job, preserving retries as distinct transitions. Link segment events using segment ID and their related job IDs when known. Keep independent browser observations visibly labeled `This browser`.
- Summary: local date/time, operation, severity, status, and turn when known. Expand to safe diagnostic code/message, job ID, attempt, verified phase, correlation ID, HTTP status, and available provider/model identifiers. Missing facts display as unavailable, never inferred.
- A timeout, refused request, invalid structured result, explicit review checkpoint, lost monitor connection, and unavailable completed result must have distinct explanations. Only server-confirmed job status determines whether generation failed or a turn was accepted.
- Recovery buttons use existing authoritative review/retry APIs and freshly re-read job state. Historical activity cannot authorize Keep, retry, discard, or replay a POST. Prefer a `View current recovery options` link to the existing recovery panel.
- Filters: All, Errors and warnings, Generation, Illustrations, This browser. Add job/turn/diagnostic-code search over loaded entries, explicitly labeled `Search loaded activity`. Older history loads on demand. No search claim over unseen history.
- Update an open dialog without closing expanded entries, stealing focus, resetting scroll, or announcing every event. Offer a new-activity indicator when the user is reading older records.
- `Copy diagnostics` copies the selected operation group, or loaded filtered entries if no group is selected, with a scope/coverage header. `Download diagnostics` exports the same bounded selection as versioned JSON. Neither fetches an unbounded history. Clipboard failures remain visible.
- Replace `Clear Log` with `Hide previous activity` and `Show previous activity`. This is a reversible, per-browser campaign view watermark, not server deletion. Use separate server sequence and browser observation sequence watermarks. Future and late-published events remain visible.
- Show `History may be delayed`, `Showing cached activity`, or `Local history storage unavailable` accurately. Activity failures must not disable the Story controls.

## Event contract and safety

Define a strict version-1 discriminated contract in `packages/contracts/src/activity.ts`.

`ActivityScope = { ownerUserId: UUID; campaignId: UUID }` is internal. The browser gets owner identity only from `/api/v1/session`; request parameters never choose an owner.

`ActivityEvent` fields:

- `version: 1`, `eventId: UUID`, `sequence: decimal-string`, `occurredAt: ISO date`, `publishedAt: ISO date`.
- `campaignId`, `source: generation | image | illustration_segment`, `kind` from the closed catalog below, `severity: info | warning | error | success`.
- `jobId`, `generationJobId`, `segmentId`, `turnId`: nullable UUIDs; `turnNumber`: nullable nonnegative integer; `attemptNumber`: nullable nonnegative integer.
- `status`: source-specific enum; `diagnostic`: nullable strict object. Allowed diagnostic fields: a closed public code, fixed catalog message, allowlisted phase, bounded correlation ID, HTTP status 100..599, optional public provider-profile UUID, bounded model ID, and measured nonnegative duration in milliseconds. All optional fields are absent when not recorded.
- No free-form payload/details bag. Title and suggested recovery copy are derived from a versioned catalog. Render all strings as text. Maximum serialized public event size: 4 KiB; correlation ID max 128 characters and model ID max 200 characters. Oversized optional metadata is omitted with a safe truncation marker; required IDs are never truncated.

Catalog: generation `queued`, `claimed`, `generating`, `validating`, `committing`, `review_required`, `review_decided`, `retry_queued`, `completed`, `failed`, `cancelled`, `discarded`; image `queued`, `generating`, `provider_pending`, `downloading`, `retry_queued`, `completed`, `recoverable`, `failed`, `cancelled`, `expired`; segment `refining`, `direct_fallback`, `completed`, `failed`. Prefix wire kinds with source, e.g. `generation.completed`. Repeated same-status lease renewals, partial narration, provider progress percentages, and queue-position changes create no durable event. A changed validated diagnostic may create a new terminal/recoverable event even if status stays the same.

Use the existing `generationFailureDiagnosticProjectionSchema` and `projectGenerationFailureDiagnostic` for safe failure codes/messages. Reuse the existing safe recovery projection for review context. Project additional phase/attempt fields explicitly from trusted structured records, never parse an arbitrary exception string. Normalize HTTP/contract errors by picking status, correlation ID, safe domain code, method, and a route template without query data. Do not serialize `details`, `issues`, `cause`, stack, raw messages, URLs, provider headers, or response bodies wholesale.

`BrowserActivityObservation` has version, UUID, local monotonic sequence, observedAt, campaignId, kind, severity, nullable related IDs and the same safe diagnostic shape. Kinds cover campaign load, submission failure, monitoring degraded/restored/detached, result load unavailable, recovery command failure, history-page failure, undo result, and illustration command failure. Session-level failures before owner/campaign validation remain memory-only. Browser observations are not uploaded and never masquerade as server events. Existing action-text logging is removed from persisted/exported diagnostics.

## Durable capture and publication

Use a transactional outbox, not client uploads or PostgreSQL notifications as a history store.

1. A successful job mutation creates a safe event snapshot in `activity_event_outbox` in the same transaction. Failed ownership/lease guards and rolled-back state changes create no event. Increment a dedicated `activity_revision bigint NOT NULL DEFAULT 0` on each participating generation job, image job, and segment only for captured transitions. Logical attempt counters are insufficient because image retries reset them.
2. Idempotency key: `(source, source_id, activity_revision, ordinal)`; ordinal defaults to zero. Generate one stable UUID per event on first insertion. Retry/replay that returns an already existing job must not increment revision or recapture queued. For multi-event transitions use catalog-defined ordinals.
3. A worker publisher reads committed outbox entries, validates the safe snapshot, and inserts immutable `activity_events`. It marks the outbox row published in the same transaction. Unique event ID prevents duplicates after retries.
4. A transaction-level PostgreSQL advisory lock serializes publishers before they allocate global publication sequences. Another publisher uses try-lock and exits if busy. This prevents an incremental cursor from skipping an event whose lower sequence commits later. A plain sequence allocated by concurrent source transactions would be unsafe.
5. Publication order is the pagination order; occurrence time is display context. Publish committed outbox rows oldest-first with UUID tie-break. Source revisions permit diagnosing late arrival; no claim of globally ordered occurrence times.
6. Captures already written remain publishable when a source job, provider, or turn is removed. Only deleting the owning campaign/user removes its feed. No cascading source-job/turn/provider foreign key on historical IDs.

Tables:

- `activity_event_outbox`: UUID primary key; owner/campaign; source/source ID/revision/ordinal uniqueness; occurred_at; strict safe snapshot JSONB; published_at nullable; quarantine code nullable. Index unpublished rows by occurred_at/event_id and campaign/owner. Quarantine is only a fixed code, not arbitrary error text.
- `activity_events`: event UUID primary key; global bigint publication sequence unique; owner/campaign; occurred_at, published_at, source, kind, severity, related IDs, validated safe snapshot. Index `(owner_user_id,campaign_id,sequence DESC)`. Serialize bigint as decimal strings, never JavaScript numbers.
- `campaign_activity_history`: owner/campaign primary key, captured_since, retention_floor_sequence, last_published_sequence. First capture creates it transactionally. Publisher and cleanup maintain metadata. Composite owner/campaign foreign keys prevent mismatched ownership; create the required parent unique constraint if absent. All three tables cascade only with their campaign/owner.

Do not make the publisher call providers or mutate job/campaign authority. Publisher failure only delays display. Outbox capture is part of the domain transaction: a database failure rolls back that transaction and is handled by the existing durable retry/idempotency machinery. Do not swallow capture failures and claim the state transition was logged; test this boundary. Keep payload projection pure and total so unfamiliar error codes map to `generation_failed` or another fixed generic code rather than causing a new generation failure.

Publisher batch: 100 events; eligible every 1 second; one in-flight activity maintenance lane per worker, with database locking across replicas. Corrupt outbox rows are marked quarantined and emit a fixed operational health/log signal; they do not poison the entire batch. API indicates incomplete history while quarantine exists. Preserve unpublished/quarantined rows for investigation rather than silently expiring them.

## Read API and synchronization

Add only `GET /api/v1/campaigns/:campaignId/activity` for v1. Query: `limit` default 100/max 200, mutually exclusive opaque `before` or `after` cursor. No browser event-write endpoint and no activity delete endpoint.

Return `{ version:1, events, nextBefore, nextAfter, hasMore, coverage }`. Coverage contains capturedSince nullable, retentionDays=30, oldestAvailableSequence nullable, latestPublishedSequence, pendingPublication boolean, incomplete boolean, and resetRequired boolean. `latestPublishedSequence` comes from campaign metadata even if all events have expired.

First page is newest-first. `before` walks older events descending; `after` drains newer publications ascending. Cursors encode version, campaign ID, direction, and decimal-string sequence; validate length (max 512 characters), shape, direction, campaign, and integer range. Owner comes exclusively from server context and scopes every query. A forged cursor cannot broaden access. Capture page and coverage in one read-only repeatable-read transaction. An empty incremental page preserves the supplied cursor; a nonempty page advances only to its last delivered sequence, never to an unseen high-water mark. The initial incremental anchor is the newest sequence actually returned (or metadata high-water if no rows exist).

If an incremental cursor precedes the retention floor, return `resetRequired: true` with no events; client drops server-cache coverage, loads a fresh first page, and displays the retention gap. Invalid cursors return 400. Missing or foreign campaigns return the existing indistinguishable not-found response. Do not serve cached data after an access denial.

Poll at 5 seconds while dialog is open or a known job is active; 30 seconds while the visible page is otherwise idle. Pause while document hidden/offline; refresh on visibility, online, dialog open, job terminal signal, and manual refresh. Drain at most 10 pages per pass, then reschedule immediately until caught up. Retry transport/server failures at 5/10/20/30 seconds with injected bounded jitter; reset backoff on success. An existing generation SSE signal can trigger reconciliation, but no new SSE endpoint is needed for v1.

Do not add a new member to the strict existing meta capability object merely to detect this feature: older clients reject unknown fields. An unsupported activity route falls back to browser-only history with an explicit notice; campaign access is validated independently before treating a route 404 as an older-server fallback. 401/403 or a failed campaign-access check clears the selected scope immediately. Malformed activity responses are a contract error, not proof the feature is unsupported.

## Cache, retention, and operations

Use native IndexedDB through an injectable adapter; no new browser dependency is required. Cache namespace includes API origin/base path, server-resolved owner UUID, and campaign UUID. Database schema version 1 has event, observation, and scope-metadata stores. Composite keys include scope plus event ID. Transactions merge by ID, update cursor only after records are saved, and prune atomically. BroadcastChannel invalidates another tab's view; receiving tabs reread IndexedDB. Never use a shared localStorage read/replace array.

Per campaign: at most 1,000 server events and 200 browser observations; observations expire after 7 days. Global cache: at most 10 recently used campaign scopes, prune least recently used inactive scopes. Enforce the public event size bound before caching. Store full coverage, last successful sync, incremental cursor, older-page cursor, and hide-watermarks; pruning cached events does not imply deleting server history. Older history always remains available through API pagination within retention. Clear invalid schema entries rather than trusting them. Cache exceptions fall back to memory and a visible storage notice; never block generation or repeatedly log the storage failure into itself.

Server events expire 30 days after publication (so delayed events receive a useful display window). Cleanup every 60 seconds in batches of 1,000; use database time. Prune published outbox receipts after 7 days; never prune pending or quarantined outbox rows automatically. Maintain retention floor conservatively so clients reset instead of claiming complete cache coverage. Keep the metadata row after history expires. Campaign deletion removes all three operational tables; ordinary job/turn/profile cleanup does not. System/Campaign Archives exclude all three tables as operational state; disaster-recovery database backups include them naturally. Restore-to-same-origin is reconciled by resetting cache if the saved cursor exceeds server high-water (database rollback) as well as on retention reset.

No retention settings or new secrets in v1: these are documented constants. Release is additive: migrate, deploy compatible API and workers, then serve legacy UI. Mixed old workers produce incomplete history; declare rollout coverage only after all producers are upgraded. Old clients continue without new strict meta fields. Roll back application binaries while retaining tables and rows; do not run a destructive down migration. During rollback, capture may stop and UI may use local-only mode. No live deployment is authorized by this planning task.

## Acceptance

Reload, closing/reopening the browser, two tabs, server restart, publisher crash/retry, and background completion produce no duplicate or missing captured server events. Foreign-owner/campaign history and private canaries never appear in API/cache/render/export. Image failure does not change story acceptance. Monitoring disconnection never fabricates generation failure. Retention and unsupported-server notices are honest. Tests separately establish pure/unit behavior, real PostgreSQL transactions, rendered-browser behavior with screenshots, and any live-provider evidence (not required to prove this feature).
