# Feature Implementation Matrix — Infinite Quest Nexus

Implementation states used (per the audit skill definition):
**Implemented and wired** · **Implemented but incomplete** · **UI present, backend not wired** ·
**Mock or prototype only** · **Backend available, UI absent** · **Specified but not implemented** ·
**Unable to confirm** · **Not applicable**

This product does not follow a "findings/deterministic-check/AI-check"
document-review paradigm (see `REPOSITORY_UI_MAP.md` product-identity note),
so the rows below substitute Infinite Quest Nexus's real domains — World
Library, Campaigns, Story Engine (turn generation), Chronicle memory,
Providers, Illustrations, Dashboard, Import/Export — for the generic
template's document/finding rows. Every "Data source" is **live API** unless
noted; no mock-data mode exists for the running app (`REPOSITORY_UI_MAP.md` §10).

## World Library

| Feature | Product-spec ref | Backend | Frontend route/component | State | Data source | Limitations | Evidence | Replacement-UI treatment |
|---|---|---|---|---|---|---|---|---|
| Create draft world | `docs/nexus-guide/worlds/create.md` | `POST /api/v1/worlds` | `#world-library`, create-world flow, `nexus.js` | Implemented and wired | Live API | — | `server.ts:407-409`, `world-service.ts:263` | Retain; give its own screen (`WORLD-CREATE`) |
| AI-generate world preview | not in nexus-guide by that name; inferred from endpoint | `POST /api/v1/worlds/generate-preview` | world creation flow | Implemented and wired | Live API | — | `server.ts:411-417` | Retain, make provider/model choice visible before triggering (cost-bearing) |
| Edit draft world content | `docs/nexus-guide/worlds/edit-drafts.md` | `PUT /api/v1/worlds/:worldId/draft` | World Management panel | Implemented and wired | Live API | Optimistic-revision conflicts per capabilities.md; UI conflict handling not independently verified | `server.ts:431-433`, `world-service.ts:301` | Retain; surface conflict/staleness explicitly (see `INTERACTION_FLOWS.md`) |
| Author playable character manually or AI-assisted, explicit review-before-save | ADR 0016 "Reviewed character authoring" | `POST /api/v1/worlds/:worldId/draft/playable-characters/generate`, `.../organize` | `characterDialog`, `characterProfileReviewDialog` (`index.html:788,884`) | Implemented and wired | Live API | ADR 0016 requires explicit human save before persistence — the *only* documented human-review-before-commit pattern in the product | `server.ts:435-451` | Retain as the closest analog to "adjudicate AI output before it becomes canonical" — model this pattern explicitly in `PRODUCT_UX.md` |
| Publish immutable world version | `docs/nexus-guide/worlds/publish.md` | `POST /api/v1/worlds/:worldId/publish` | Publish action in World Management | Implemented and wired | Live API | — | `server.ts:453-455`, `world-service.ts:327` | Retain; require explicit confirmation (irreversible, monotonic version numbers) |
| Version history | `docs/nexus-guide/worlds/version-history.md` | `GET /api/v1/worlds/:worldId` (includes versions) | `worldDetailsDialog` | Implemented and wired | Live API | — | `server.ts:427-429` | Retain as dedicated `WORLD-VERSIONS` screen |
| Fork a world version | `docs/nexus-guide/worlds/fork.md` | `POST /api/v1/worlds/:worldId/fork` | `forkWorldDialog` | Implemented and wired | Live API | — | `server.ts:474-476`, `world-service.ts:409` | Retain |
| Archive / restore / status change | `docs/nexus-guide/worlds/archive-restore.md` | `PATCH /api/v1/worlds/:worldId` | World Management status control | Implemented and wired | Live API | — | `server.ts:457-459` | Retain |
| Delete world version (guarded) | ADR 0015 | `DELETE /api/v1/worlds/:worldId/versions/:worldVersionId` | `deleteDialog` | Implemented and wired | Live API | Backend checks 5 blocker categories, each covered by integration tests (`tests/integration/world-library.integration.test.ts`) | `server.ts:465-472`, `world-service.ts:795` | Retain UI; render the returned `blockers` object generically rather than hardcoding a subset of categories |
| Delete whole world | — | `DELETE /api/v1/worlds/:worldId` | `deleteDialog` | Implemented and wired | Live API | — | `server.ts:461-463` | Retain, typed-confirmation pattern already used (`nexus.js:819`) — keep |
| Export world JSON | `docs/nexus-guide/worlds/import-export.md` | `GET /api/v1/worlds/:worldId/export` | export action | Implemented and wired | Live API | — | `server.ts:478-483` | Retain |
| Import world JSON (+ preview) | `docs/nexus-guide/worlds/import-export.md` | `POST /api/v1/imports/world`, `/preview` | Imports panel (`#imports`) | Implemented and wired | Live API | — | `server.ts:375-382` | Retain |
| Import "Infinite Worlds" legacy doc (AI-assisted conversion, + preview + progress) | `docs/nexus-guide/worlds/import-export.md` | `POST /api/v1/imports/infinite-worlds`(+`/preview`), `GET /api/v1/imports/progress` | Imports panel | Implemented but incomplete | Live API | Progress tracked in an **in-memory map, not persisted** — progress is lost on API restart mid-conversion; long-running AI conversion with no durable recovery | `infinite-worlds-import-service.ts:37-50`, `server.ts:384-403` | Flag prominently in the replacement UI: warn users not to navigate away / that a restart loses progress, until backend durability is addressed |
| Playable characters for a world version | — | `GET /api/v1/world-versions/:worldVersionId/playable-characters` | campaign creation character picker | Implemented and wired | Live API | — | `server.ts:489-491` | Retain |

## Campaigns

| Feature | Product-spec ref | Backend | Frontend route/component | State | Data source | Limitations | Evidence | Replacement-UI treatment |
|---|---|---|---|---|---|---|---|---|
| List / create campaign (basic + advanced) | `docs/nexus-guide/campaigns/create.md` | `GET/POST /api/v1/campaigns` | `#campaigns`, `quickCampaignDialog`, `createCampaignDialog` | Implemented and wired | Live API | — | `server.ts:485-495` | Retain, unify basic/advanced entry into one flow with a mode toggle |
| Configure campaign (title, provider, response length, turn-control style) | `docs/nexus-guide/campaigns/configure.md` | `PATCH /api/v1/campaigns/:campaignId` | campaign detail / settings | Implemented and wired | Live API | — | `server.ts:497-499` | Retain |
| Character profile (get/update/AI-organize) | — | `GET/PUT /api/v1/campaigns/:campaignId/character-profile`, `.../organize` | character profile editor | Implemented and wired | Live API | — | `server.ts:501-520` | Retain |
| Select / load / resume campaign | `docs/nexus-guide/campaigns/select-and-load.md` | `GET /api/v1/campaigns/:campaignId/sync-status` | Story Player boot | Implemented and wired | Live API | — | `server.ts:601-688` | Retain — this is the resume/recovery snapshot endpoint, critical path |
| Same-world version upgrade | `docs/nexus-guide/campaigns/upgrade-world-version.md` | `POST /api/v1/campaigns/:campaignId/migrate-world` | campaign detail | Implemented and wired | Live API | Blocked while a generation job is active (by design) | `server.ts:526-528`, `world-service.ts:924` | Retain; make the "blocked while generating" state explicit rather than a generic error |
| Cross-world transfer (preview + commit) | `docs/nexus-guide/campaigns/transfer-world.md`, ADR 0019 | `POST .../transfer-world/preview`, `POST .../transfer-world` | `transferCampaignDialog` | Implemented and wired | Live API | — | `server.ts:530-545` | Retain two-step preview→commit pattern — good precedent for other risky/expensive operations |
| Archive / delete campaign | `docs/nexus-guide/campaigns/archive-delete.md` | `DELETE /api/v1/campaigns/:campaignId` | `deleteDialog` | Implemented and wired | Live API | — | `server.ts:522-524` | Retain |
| Export campaign (zip w/ assets or JSON) | `docs/nexus-guide/campaigns/import-export.md` | `GET /api/v1/campaigns/:campaignId/export` | export action | Implemented and wired; recently fixed | Live API | Asset-collection UUID-matching bug fixed 2026-07-30 (`eee36e1`) — dropped assets referenced by non-canonical URL forms now included | `server.ts:547-556`, `world-service.ts:966-1063` | Retain |
| Import legacy `.story`/zip campaign | `docs/nexus-guide/campaigns/import-export.md` | `POST /api/v1/imports/legacy-story` (+`/preview`) | Imports panel | Implemented and wired | Live API | Dedup by `source_hash`; decompression-bomb risk flagged by prior review (backend hardening, not a frontend gap) | `server.ts:333-373` | Retain; surface the 200-duplicate vs 201-new distinction to the user explicitly |
| Update existing campaign from a newer Infinite Worlds TXT export | — | — | — | **Specified but not implemented** | — | Explicitly deferred: "Status: Deferred. Do not implement as part of the current import workflow." | `docs/operations/deferred-improvements.md:5-7`, `docs/nexus-guide/campaigns/import-export.md:19` | Do not build in the replacement UI; note as a known gap if users ask |
| Turns list (accepted-turn ledger) | `docs/concepts/campaigns-and-turns.md` | `GET /api/v1/campaigns/:campaignId/turns` | Story Player scene/history views | Implemented and wired | Live API | — | `server.ts:558-579` | Retain |
| Runtime state (get/update trackers, scratchpad) | ADR 0026 | `GET/PATCH /api/v1/campaigns/:campaignId/state` | `editStateDialog` (4 tabs) | Implemented and wired | Live API | Optimistic concurrency (revision-based) per ADR 0026 — UI conflict-handling not independently verified | `server.ts:581-595` | Retain; make revision-conflict outcome explicit (don't silently overwrite) |
| Cost summary (story/image/memory breakdown) | `docs/nexus-guide/campaigns/configure.md:14` | `GET /api/v1/campaigns/:campaignId/cost-summary` | campaign detail cost panel | Implemented and wired | Live API | Costs shown only when a provider reports cost data | `server.ts:597-599`, `cost-service.ts:137` | Retain, this is a genuinely well-specified feature — keep the category breakdown |
| Player-side config sync (stats/triggers) | — | `PUT /api/v1/campaigns/:campaignId/player-config` | Story Player boot | Implemented and wired | Live API | — | `server.ts:690-696` | Retain |
| Rewind campaign | `docs/player-guide/campaign-continuity.md` | `POST /api/v1/campaigns/:campaignId/rewind` | `turnHistoryDialog` | Implemented and wired | Live API | Destructive, ledger-boundary operation | `server.ts:698-704` | Retain; require explicit typed/two-step confirmation given destructiveness |
| Branch campaign from a turn | `docs/player-guide/campaign-continuity.md` | `POST /api/v1/campaigns/:campaignId/branch` | `branchStoryDialog` | Implemented and wired | Live API | — | `server.ts:706-714` | Retain |
| Turn-input classification (Action/Scene/Auto) | ADR 0021, `docs/player-guide/turn-input-modes.md` | `POST /api/v1/campaigns/:campaignId/turn-input/classify` | Story Player input bar | Implemented and wired | Live API | Auto is a request-selection state only, resolved before job creation, never a third prompt mode | `server.ts:716-723` | Retain; make the resolved mode visible after Auto is chosen |

## Story Engine (turn generation)

| Feature | Product-spec ref | Backend | Frontend route/component | State | Data source | Limitations | Evidence | Replacement-UI treatment |
|---|---|---|---|---|---|---|---|---|
| Enqueue turn generation | `docs/concepts/generation-integrity.md` | `POST /api/v1/campaigns/:campaignId/generations` | Story Player input submit | Implemented and wired | Live API | One active job per campaign at a time (unique index) | `server.ts:725-729`, `generation-service.ts:280` | Retain |
| Retry-latest (replace accepted turn) | ADR 0017 | `POST .../generations/retry-latest` | retry-latest control | Implemented and wired | Live API | Staged: only overwrites accepted turn after new output validates in a transaction | `server.ts:731-735`, `generation-service.ts:340` | Retain; make "staged, won't overwrite until validated" explicit in the UI copy |
| Poll/stream generation job status | ADR 0025 | `GET .../generation-jobs/:jobId`, `GET .../stream` (SSE) | `pollGenerationJob` (`story.js:1165-1310`) | Implemented and wired | Live API | SSE primary, 900-attempt poll fallback; **narration-text streaming to the UI is contradicted between sources — see `OPEN_QUESTIONS.md` Q1** | `server.ts:737-780` | Retain SSE-first/poll-fallback pattern; resolve Q1 before specifying incremental-narration UI |
| Get finished job result | — | `GET .../generation-jobs/:jobId/result` | post-completion fetch | Implemented and wired | Live API | — | `server.ts:782-784` | Retain |
| Retry / discard recoverable or failed job | `docs/player-guide/recovering-a-generation.md` | `POST .../retry`, `POST .../discard` | recovery UI in Story Player | Implemented and wired | Live API | — | `server.ts:786-792` | Retain — this is the product's real "review a flagged issue and decide" analog; treat `recoverable` as a distinct, human-actionable status (see `PRODUCT_UX.md`) |
| Cancel an actively-running generation job | `docs/operations/deferred-improvements.md:230` | none | none | **Specified but not implemented** | — | "a future explicit Cancel generation action" requiring further durable infrastructure | `docs/operations/deferred-improvements.md:230` | Do not build; if included in a roadmap doc, mark clearly as future |
| Resume pending generation after page refresh | `docs/reference/capabilities.md` "pending-job resume" | `GET .../sync-status`, `localStorage` pending-submission cache | Story Player boot | Implemented and wired | Live API + localStorage | 15-minute staleness window on the local cache | `story.js:833-858` | Retain |

## Chronicle (memory)

| Feature | Product-spec ref | Backend | Frontend route/component | State | Data source | Limitations | Evidence | Replacement-UI treatment |
|---|---|---|---|---|---|---|---|---|
| Chronicle metrics | `docs/nexus-guide/chronicle/inspect.md` | `GET /api/v1/campaigns/:campaignId/memory/metrics` | Chronicle inspection panel | Implemented and wired | Live API | — | `server.ts:939-941`, `memory-service.ts:675` | Retain as its own `CHRONICLE-HEALTH` screen |
| Context preview | `docs/nexus-guide/chronicle/context-preview.md` | `GET .../memory/context-preview` | context preview panel | Implemented and wired | Live API | — | `server.ts:943-949`, `memory-service.ts:795` | Retain |
| Reindex Chronicle | `docs/nexus-guide/chronicle/reindex.md` | `POST .../memory/reindex` → polled via `GET /api/v1/jobs/:jobId` | reindex action | Implemented and wired | Live API | Poll-only, no SSE | `server.ts:951-954,973-984` | Retain |
| Semantic embedding config (get/update) | `docs/nexus-guide/chronicle/embeddings.md` | `GET/PUT .../memory/embedding-config` | embedding settings panel | Implemented and wired | Live API | — | `server.ts:956-965` | Retain |
| Embedding reindex | — | `POST .../memory/embeddings/reindex` | embedding job trigger | Implemented and wired | Live API | Returns 409 if already running | `server.ts:967-971` | Retain |
| Retrieval-mode selection (complete/balanced/compact/summary/automatic) | `docs/nexus-guide/chronicle/retrieval-modes.md` | part of embedding/campaign config | settings UI | Implemented and wired | Live API | — | capabilities.md §Chronicle | Retain, make the 5 modes' tradeoffs legible (this is meaningfully complex for a user to reason about) |

## Providers

| Feature | Product-spec ref | Backend | Frontend route/component | State | Data source | Limitations | Evidence | Replacement-UI treatment |
|---|---|---|---|---|---|---|---|---|
| List / create / update / delete provider profile | `docs/nexus-guide/providers/*.md` | `GET/POST/PATCH/DELETE /api/v1/providers` | `#providers`, `providerDialog` | Implemented and wired | Live API | 4 roles: text, image, embedding, intent | `server.ts:301-331` | Retain |
| Set default provider per role | — | `PUT /api/v1/providers/:providerId/default` | provider list default toggle | Implemented and wired | Live API | — | `server.ts:313-315` | Retain |
| Model discovery (saved profile, and ad hoc) | `docs/nexus-guide/providers/model-discovery.md` | `GET .../models`, `POST /discover-models` | `providerModelDialog` | Implemented and wired | Live API | Includes pricing metadata where provider exposes it | `server.ts:309-311,325-327` | Retain |
| Ad hoc text generation (test a provider) | — | `POST /api/v1/provider-text/generate` | provider test action | Implemented and wired | Live API | — | `server.ts:321-323` | Retain |
| Provider health status | `docs/nexus-guide/providers/health-and-errors.md` | tracked server-side, surfaced in list response | provider list badges | Implemented and wired | Live API | `unknown/healthy/degraded/unavailable`, auto-degrades after 3 consecutive failures | `provider-service.ts:62-85` | Retain — model as a genuine status indicator, see `DESIGN_SYSTEM.md` |
| Provider `configuration` field redaction | AGENTS.md Security | Credential-like values redacted on provider reads | provider edit form | Implemented and wired | Live API | Create/update responses preserve submitted configuration for write round-trips; read responses recursively redact credential-like keys | `provider-service.ts:58-62`, `packages/domain/src/redaction.ts` | Retain; do not log configuration values unnecessarily |

## Illustrations

| Feature | Product-spec ref | Backend | Frontend route/component | State | Data source | Limitations | Evidence | Replacement-UI treatment |
|---|---|---|---|---|---|---|---|---|
| Illustration campaign config | `docs/nexus-guide/providers/images.md` | `GET/PUT .../illustration-config` | illustration settings panel | Implemented and wired | Live API | — | `server.ts:794-819` | Retain |
| World cover generation (+ select existing asset) | README "durable world-cover generation" | `POST/GET .../worlds/:worldId/cover`, `cover-job`, `PUT .../cover-asset` | world card / details cover control | Implemented and wired | Live API | — | `server.ts:798-811` | Retain |
| Segmented turn illustrations (generate, regenerate variant, remove variant) | ADR 0025, ADR 0033 migration | `POST /turns/:turnId/illustration-segments`, `POST/DELETE .../images` | Story Player illustration panel | Implemented and wired | Live API | Up to 2 variants per segment | `server.ts:842-867` | Retain |
| Legacy single turn illustration | — | `POST /turns/:turnId/illustrations`, `PUT .../illustration-asset` | legacy illustration path | Implemented and wired (legacy path co-exists with segmented) | Live API | Two illustration systems coexist (legacy single + newer segmented) | `server.ts:869-878` | Consolidate to one illustration model in the replacement UI — flag in `OPEN_QUESTIONS.md` whether legacy path is still user-reachable |
| Illustration library match / re-match | — | `GET .../illustration-resolution`, `POST .../illustration-match` | asset library picker | Implemented and wired | Live API | — | `server.ts:880-888` | Retain |
| Illustration backfill (preview + run) | — | `POST .../illustration-backfill/preview`, `POST .../illustration-backfill` | backfill action | Implemented and wired | Live API | Two-step preview→commit, consistent with campaign-transfer pattern | `server.ts:829-840` | Retain |
| Poll image job | — | `GET /api/v1/image-jobs/:jobId`, `POST .../retry` | `pollImageJobs` (`story.js:1527-1556`) | Implemented and wired | Live API | Poll-only, polling errors silently swallowed | `story.js:1554` | Fix silent error-swallowing in the replacement UI — surface a retry/backoff-exhausted state instead |
| Asset library browse/search/facets | image-library-enhancement-proposal Phases 1-5 | `GET /api/v1/assets`, `/facets` | `assetLibraryDialog`, `image-library-browser.js` | Implemented and wired | Live API | — | `server.ts:918-926` | Retain |
| Asset metadata edit (title/caption/tags) | — | `PATCH /api/v1/assets/:assetId/library-metadata` | asset library edit | Implemented and wired | Live API | — | `server.ts:929-937` | Retain |
| Semantic image matching, sharing/publication, moderation, advanced browsing | image-library-phase-6 proposal | none | none | **Specified but not implemented** | — | Explicitly "Future enhancement. Not scheduled or approved for implementation," gated behind auth/OIDC and other prerequisites | `docs/architecture/image-library-phase-6-future-enhancement.md:3,21-29` | Do not build; do not imply availability in the replacement UI |

## Dashboard / cross-cutting

| Feature | Product-spec ref | Backend | Frontend route/component | State | Data source | Limitations | Evidence | Replacement-UI treatment |
|---|---|---|---|---|---|---|---|---|
| Dashboard activity stats | `docs/nexus-guide/dashboard.md` | `GET /api/v1/dashboard/stats` | `#dashboard` | Implemented and wired | Live API | — | `server.ts:270` | Retain, redesign layout — see `CURRENT_UI_AUDIT.md` |
| World/campaign search carousels | `docs/nexus-guide/navigating-nexus.md` | client-side filter over `GET /worlds`, `/campaigns` | dashboard carousels | Implemented and wired | Live API (client-filtered) | Search is client-side substring filtering, not a server search endpoint | `nexus.js:573-574,648-649` | Retain for current data volume; flag server-side search as a future need if world/campaign counts grow (see `OPEN_QUESTIONS.md`) |
| Campaign-card artwork on dashboard | `docs/reference/capabilities.md` | — | dashboard campaign card | **Specified but not implemented** | — | Explicitly called out as deferred alongside implemented world-card covers | `docs/reference/capabilities.md` §Nexus dashboard | Do not build without a corresponding backend decision |
| Prompt library (view, override, reset, preview) | — | `GET/PUT/DELETE /api/v1/prompt-library`, `POST /preview` | `#prompt-library` | Implemented and wired | Live API | — | `server.ts:293-299` | Retain |
| User profile / settings (turn-control prefs) | — | `GET/PATCH /api/v1/users/me`(`/profile`) | `nexusUserProfileDialog`, `userProfileDialog` | Implemented and wired | Live API | Single-owner only — no user list/switcher, by design | `server.ts:277-291` | Retain, single-user framing intentional (see `PRODUCT_UX.md` roles) |
| Session/identity | AGENTS.md User Identity | `GET /api/v1/session` returns `{authentication:"deferred"}` | — | Implemented and wired (deliberately minimal) | Live API | No login exists; this is correct current behavior, not a gap | `server.ts:272-275` | Do not add a login screen; the replacement UI must be designed for pre-auth, single-owner use (see `PRODUCT_UX.md` §Roles) |
| Interactive login / OIDC | AGENTS.md (future design sketch) | none | none | **Specified but not implemented** (deferred at product level) | — | Explicit product-level deferral, not a frontend gap | `docs/reference/capabilities.md:116`, `AGENTS.md:88-119` | Do not build; design the shell so auth can be added later without a rewrite (see `FRONTEND_IMPLEMENTATION_PLAN.md`) |

## Search and filtering — assessed separately per skill checklist

Client-side substring search exists only for the two dashboard carousels
(world/campaign name). No filtering exists for turns, assets (beyond the
asset-library facets), providers, or Chronicle content beyond what
`context-preview` exposes. **State: Implemented but incomplete** relative to
the surface area a mature management tool would need — see
`CURRENT_UI_AUDIT.md` for the usability judgment.

## Not applicable to this product

The generic template's "deterministic vs. AI check," "finding
categorization," "severity/confidence badges on flagged content," and
"citation/evidence panel for a document finding" rows have no direct
backend or frontend equivalent in Infinite Quest Nexus — **Not applicable**.
The closest structural analogs, reused throughout this audit, are:
generation-job **status** (queued/generating/validating/committed/
recoverable/failed) in place of finding severity, and the **recoverable vs.
failed** distinction in place of confidence/certainty. See `PRODUCT_UX.md`
§"Adapting the review paradigm" for the full mapping and its limits.
