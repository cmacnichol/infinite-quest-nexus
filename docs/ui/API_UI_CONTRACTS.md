# API–UI Contracts — Infinite Quest Nexus

Focused on what a frontend implementer needs: not a full API reference (see
`services/api/src/server.ts` and `packages/contracts/src` for that), but the
contract shape, wiring status, and behavior every screen depends on.
Endpoint purpose/one-line descriptions already listed per-feature in
`FEATURE_IMPLEMENTATION_MATRIX.md` are not repeated in full here except
where request/response field detail adds implementer value.

## Authentication behavior

**There is none, by design, today.** Every request resolves server-side to
one bootstrapped `initial-owner` user (`packages/database/src/pool.ts:33-40`).
`GET /api/v1/session` returns `{user, authentication: "deferred"}` —
literally an explicit signal that interactive auth doesn't exist yet
(`server.ts:272-275`). `X-User-Id` is CORS-allowlisted but never read
server-side (`server.ts:194`) — **do not build any frontend logic that
treats a client-supplied identity value as authoritative**, and do not
persist or display it as if it were a real session identity.

**Known contract-relevant security caveat** (backend-owned, not a frontend
fix, but the frontend must not make it worse): the default CORS
configuration reflects any origin with credentials enabled
(`server.ts:184-196`) — see `CURRENT_UI_AUDIT.md` UI-001. Do not add
patterns that widen this (e.g., storing more sensitive data than necessary
in `localStorage`, which is readable by anything that can execute script in
the same origin).

## Error envelope

Every `/api/v1/*` handler funnels through one global error handler
(`server.ts:222-236`) returning:
```json
{ "error": "ErrorName", "message": "human-readable text", "correlationId": "uuid", "details": {}, "issues": [], "blockers": [] }
```
`details`/`issues`/`blockers` are optional and endpoint-specific (`issues`
for Zod validation failures, `blockers` for guarded-delete rejections e.g.
world-version deletion). All `/api/v1/*` responses set
`Cache-Control: no-store` (`server.ts:182`) — never cache API responses
client-side beyond in-memory app state.

The shared HTTP adapter in `packages/client-web` validates adopted request and
response bodies and preserves `statusCode`, domain error code, `details`, and
`correlationId` in `NexusApiError`/`ApiContractError`. Callers must keep
surfacing the correlation ID in error UI. Caller-supplied `user_id` and
`X-User-Id` are not identity and are never synthesized from session state.

Endpoint adoption is incremental. C8 adopts the Story Player prerequisite,
campaign-projection, generation, rewind, and branch routes through named typed
methods. It does not claim every server route is adopted. The eight temporarily
retained illustration routes are isolated behind the named
`legacy-illustration-api.ts` adapter; each has a concrete success schema and the
same standard error/correlation behavior.

## Polling / streaming behavior

| Job family | Mechanism | Endpoint(s) | Interval/limits | Notes |
|---|---|---|---|---|
| Turn generation | **SSE preferred**, poll fallback | `GET /api/v1/generation-jobs/:jobId/stream` (SSE), `GET .../generation-jobs/:jobId` (poll) | Server writes a frame only on change; `packages/client-web` owns bounded backoff/fallback | The **only** endpoint family with a push channel. The legacy app no longer owns an EventSource, poll loop, or timeout policy. |
| Image jobs | Poll only | `GET /api/v1/image-jobs/:jobId` | Client self-schedules every 5s (`story.js:1527-1556`) | No SSE counterpart. Current implementation swallows poll errors silently — **do not carry this forward** (`CURRENT_UI_AUDIT.md` UI-003). |
| Chronicle jobs | Poll only | `GET /api/v1/jobs/:jobId` | No fixed client interval observed in source; implement a bounded poll with visible failure state | No SSE counterpart. |
| World-cover jobs | Poll only | `GET /api/v1/worlds/:worldId/cover-job` | Same as above | No SSE counterpart. |
| Infinite Worlds import conversion | Poll only, **non-durable** | `GET /api/v1/imports/progress?key=...` | In-memory server-side map, lost on API restart | See `CURRENT_UI_AUDIT.md` UI-004 — disclose this limitation in UI copy. |
| Resume/reconnect snapshot | Plain fetch, called on load/resume | `GET /api/v1/campaigns/:campaignId/sync-status` | Not a poll loop — called once per page load/resume to detect an in-flight `pendingGeneration` | Use this to reconcile state after a reload before deciding whether to open a new SSE/poll loop. |

**Contract detail for the SSE stream:** wire frames are runtime-validated by
`packages/client-web` before the workflow observes them. The headless workflow
emits progressive text as `GenerationEvent.narration`; the Story Player does
not read raw `partialNarration` or `partialOutput`. Q1 is resolved: progressive
narration remains visible, but only through that typed event. Terminal stream
statuses are `completed|failed|recoverable|cancelled|discarded`.

## Screen → endpoint index

Cross-reference `SCREEN_INVENTORY.md` for full per-screen detail; this is a
quick index for implementers wiring one screen at a time.

| Screen | Primary endpoints |
|---|---|
| NEX-DASH | `GET /dashboard/stats`, `GET /worlds`, `GET /campaigns` |
| NEX-WORLDS | `GET /worlds`, world CRUD/status/delete |
| NEX-WORLD-DETAIL | `GET/PUT /worlds/:id(/draft)`, `POST .../publish`, `POST .../fork`, `DELETE .../versions/:id`, character-generation endpoints, `GET .../export` |
| NEX-IMPORTS | `/imports/{world,legacy-story,infinite-worlds}(/preview)`, `/imports/progress` |
| NEX-CAMPAIGNS | `GET/POST /campaigns` |
| NEX-CAMPAIGN-DETAIL | `PATCH /campaigns/:id`, character-profile endpoints, `GET/PATCH .../state`, `GET .../cost-summary`, `GET .../sync-status`, migrate/transfer endpoints, `/rewind`, `/branch`, `GET .../export`, `DELETE /campaigns/:id` |
| NEX-PROVIDERS | full `/providers` CRUD + `/models` + `/discover-models` + `/provider-text/generate` |
| NEX-PROMPTS | `/prompt-library`, `/prompt-library/overrides`, `/prompt-library/preview` |
| STORY-PLAYER | `/generations`(`/retry-latest`), `/generation-jobs/:id`(`/stream`,`/result`,`/retry`,`/cancel`,`/discard`), `/turns/:id/illustration*`, `/illustration-segments/*`, `/campaigns/:id/turns`, `/campaigns/:id/state`, `/campaigns/:id/sync-status`, `/turn-input/classify` |
| CHRONICLE-HEALTH | `/memory/metrics`, `/memory/context-preview`, `/memory/reindex`, `/memory/embedding-config`, `/memory/embeddings/reindex`, `/jobs/:jobId` |
| SYS-ERROR | `GET /health/live`, `GET /health/ready` |
| Shell (all screens) | `GET /api/v1/meta`, `GET/PATCH /api/v1/users/me`(`/profile`) |

## Key request/response fields by domain

### Worlds
- `WorldContent` (`packages/contracts/src/world-library.ts:89-102`):
  `schemaVersion` (currently 5), `world{title,genre,tone,premise,
  backgroundStory,firstAction,rules}`, `playableCharacters[]`, `entities[]`,
  `relationships[]`, `rpgStats[]`, `defaultTriggers[]`, `eventTriggers[]`,
  `assets[]`, `defaults{}`.
- `PlayableCharacter`: `id, name, characterText, profile?, rpgStats[],
  defaultTriggers[], source{}`.
- `CharacterProfile` (structured, ADR 0016): `identity{aliases,pronouns},
  story{role,background,personality,motivations,goals,fearsAndConflicts,
  keyRelationships,narrativeHooks,voiceAndMannerisms,otherGuidance},
  appearance{...}, unclassifiedNotes`.
- World status values: `draft | active | archived`.

### Campaigns / turns
- Campaign fields surfaced at `server.ts:602-618` include
  `story_length_profile`, `turn_control_style`, `selected_character_id`,
  `character_snapshot`, `character_profile`, `character_profile_revision`.
- Turn fields (`GET .../turns`, `server.ts:558-579`): `id, turnNumber,
  action, inputMode, inputModeSource, narration, choices, imagePrompt,
  imageUrl, acceptedAt, reportedCost`.
- `sync-status` response: `{campaign, world, playerConfig,
  pendingGeneration}` — the resume snapshot; `pendingGeneration` is present
  only if a job is actively in flight.

### Generation jobs
- Status values (current, `generation.ts:397` + `0023_durable_generation_replacement.sql:15-18`):
  `queued, replacement_queued, assessing, generating, validating,
  committing, completed, recoverable, failed, cancelled, discarded`.
- `operation_kind`: `append | replace_latest`.
- Job fields for polling: `id, status, action, partialOutput,
  partialNarration, errorMessage, errorCode, recoveryMetadata,
  resultTurnId`.
- **Concurrency contract**: only one active (non-terminal) job per campaign
  — the UI must not allow submitting a second turn while one is in flight.
  On the structured active-job 409, attach/resume the authoritative job from
  `details.pendingGeneration`, show exactly "a turn is already generating",
  and do not mint or submit another idempotency key.
- **Completed result contract**: if `/result` is temporarily unavailable after
  a completed snapshot, keep the accepted preview visible in a
  complete-but-loading state. Retry only `GenerationRun.fetchResult()`; never
  restart generation or its watcher.
- **Cancel versus detach**: `POST .../cancel` is an explicit durable server
  action on the active `GenerationRun`. Aborting a watch merely detaches this
  browser observer and must not cancel the server job. Discard is likewise a
  command on the active run, not a raw path call.

### Image jobs / illustration
- Image job status: `queued, generating, provider_pending, downloading,
  completed, recoverable, failed, cancelled, expired`.
- `provider_progress`: 0–100 numeric where the provider reports it — use
  for a determinate progress bar when present, indeterminate otherwise.
- Segment set status (turn illustration sets): `provisional, queued,
  refining, generating, completed, partial, failed, superseded, orphaned`.
- Up to 2 variants per segment (`variant_index BETWEEN 0 AND 1`).

### Chronicle jobs
- Status: `queued, running, completed, failed`. Polled via
  `GET /api/v1/jobs/:jobId`.

### Providers
- `providerProfileInputSchema` (`generation.ts:17-47`): `name,
  providerType (lmstudio|openrouter|manifest|openai_compatible|sogni|
  sogni_sdk), providerRole (text|image|embedding|intent), baseUrl
  (http/https only), defaultModel, contextWindowTokens (1024–4,000,000),
  maxOutputTokens (128–262144), temperature (0–2), requestTimeoutMs
  (5s–1h), apiKey (write-only, never returned), enabled, isDefault,
  configuration (freeform; credential-like values are redacted from read
  responses — see caveat below)`.
- **Validation constraint the UI must mirror client-side** (for fast
  feedback, in addition to server enforcement): for `providerRole: text`,
  `maxOutputTokens + 512 < contextWindowTokens` (`generation.ts:32-34`,
  enforced again server-side at `provider-service.ts:180-182`).
- Provider read responses never include `apiKey` — only `hasApiKey: boolean`
  (`provider-service.ts:51`). Credential-like keys in `configuration` are
  recursively redacted by `publicProviderForRead()` (`provider-service.ts:58-62`).
  List (`GET`), `PUT .../default`, and `PATCH` responses where the request body
  omits `configuration` all go through this redaction, since they would
  otherwise echo a previously-stored value the caller didn't just submit.
  `POST` and `PATCH` responses where the request body *includes*
  `configuration` return it unredacted — that's the caller's own just-submitted
  input, not a leak — so legitimate write values round-trip. The UI should
  still avoid logging configuration values unnecessarily.
- Health status: `unknown | healthy | degraded | unavailable`, auto-degrades
  after 3 consecutive failures (`provider-service.ts:62-85`).

### Assets
- `GET /api/v1/assets` supports filters + pagination, returns `{items,
  total, facets, cursor}`; `GET /api/v1/assets/facets` returns facet counts
  only (for building filter UI without fetching results).

## Confirmed contract constraints

- One active generation job per campaign at a time (unique index).
- World version numbers are monotonic and never reused, even after
  deletion — the UI must never imply a deleted version's number could be
  reissued.
- Provider text-role token budget constraint (above) — validate client-side
  for UX speed, but the server is the source of truth (don't rely on
  client validation alone).
- World-version deletion is blocked by 5 server-side categories (current
  campaigns, campaign migrations, campaign transfers, Chronicle memories,
  model chains) surfaced via the error envelope's `blockers` field — the UI
  must render `blockers` specifically, not just a generic "can't delete"
  message, since the reason materially changes what the user should do
  next.
- Zip campaign export/import dedups by `source_hash`; a re-import of
  identical content returns 200 (duplicate) not 201 (new) — the UI must
  distinguish these two outcomes, not treat both as generic "import
  succeeded."

## Suspected gaps / open questions

See `OPEN_QUESTIONS.md` for the full write-up of each. Summarized here for
implementers who only need the API angle:
- **Q1 is resolved**: progressive narration is retained through typed
  `GenerationEvent.narration`; raw transport fields are not app inputs.
- **Q2**: whether the legacy single-image illustration endpoints
  (`POST /turns/:turnId/illustrations`, `PUT .../illustration-asset`) are
  still frontend-reachable, or vestigial — resolve before deciding whether
  the replacement UI needs to support two illustration interaction models.
- **Q3**: no server-side search/filter endpoint exists for worlds,
  campaigns, turns, or providers beyond asset-library facets — confirm
  whether current catalog sizes make client-side substring filtering
  sufficient for the replacement UI, or whether a backend search endpoint
  should be requested as a follow-up (do not silently invent one).
