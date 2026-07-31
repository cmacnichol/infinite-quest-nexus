# Screen Inventory — Infinite Quest Nexus

Every screen is listed with its current implementation state and its
disposition in the replacement UI (retained / replaced / removed / new).
"Current" screens are drawn from the two live HTML documents' hash-views
and `<dialog>` elements (`REPOSITORY_UI_MAP.md` §3–§5); several current
dialogs are consolidated into fewer, better-organized proposed screens per
`PRODUCT_UX.md` §Information architecture.

Legend for **Disposition**: **Retained** (same concept, new implementation)
· **Replaced** (concept kept, structure changes materially) · **Removed**
(not carried forward) · **New** (no current equivalent).

---

## NEX-DASH — Dashboard

- **Route (proposed):** `/` · **Route (current):** `#dashboard` (default hash-view)
- **Current implementation state:** Implemented and wired
- **Disposition:** Retained
- **Purpose:** Orient the user — recent activity, quick access to worlds/campaigns, launch a new campaign quickly.
- **Primary user:** The (single) owner/operator.
- **Entry points:** App load with no hash; shell nav "Dashboard" link.
- **Primary actions:** Open a world; resume a campaign; quick-create a campaign; navigate to World Library/Campaigns/Providers.
- **Data displayed:** Activity summary, searchable world carousel, searchable campaign carousel.
- **API dependencies:** `GET /api/v1/dashboard/stats`, `GET /api/v1/worlds`, `GET /api/v1/campaigns`.
- **Major components:** Stat summary, two card carousels, quick-campaign dialog.
- **Required states:** Loading (skeleton, replacing current "Loading your worlds…" text placeholder), empty (no worlds yet vs. no search matches — both copy variants already exist and should be kept, `nexus.js:573-574`), error (stats/list fetch failure), populated.
- **Loading state:** Skeleton cards for carousels; stat row shows a loading placeholder, not zeros (avoid implying "0 activity" while still loading).
- **Empty state:** First-run guidance ("No worlds yet — create your first world") distinct from "no search results."
- **Error state:** Inline retry affordance per failed data source (stats vs. worlds vs. campaigns can fail independently).
- **Permission behavior:** None (single-owner, no role gating).
- **Responsive behavior:** Carousels reflow to a vertical list under the mobile breakpoint; stat row wraps to 2 columns.
- **Accessibility requirements:** `aria-live="polite"` on the stat region and both carousels (already present today — preserve; `index.html:57,64,71`).
- **Acceptance criteria:** A first-time user with an empty database sees clear "get started" guidance, not a blank or perpetually-loading dashboard; a returning user can resume their last campaign in one click.

## NEX-WORLDS — World Library (list)

- **Route (proposed):** `/worlds` · **Route (current):** `#world-library`
- **Current implementation state:** Implemented and wired
- **Disposition:** Retained (split from the Imports panel it currently shares a hash-view with)
- **Purpose:** Browse, search, and manage the world catalog.
- **Primary user:** Owner/operator, in "world author/curator" mode.
- **Entry points:** Shell nav "World Library"; Dashboard world card.
- **Primary actions:** Create world, search/filter, open a world, archive/restore, delete, fork, export.
- **Data displayed:** World cards (title, status, cover, version count).
- **API dependencies:** `GET /api/v1/worlds`; mutation endpoints listed in `FEATURE_IMPLEMENTATION_MATRIX.md` §World Library.
- **Major components:** Card grid/carousel, search input, status filter, create/import entry points.
- **Required states:** Loading, empty (no worlds vs. no matches), error, populated.
- **Permission behavior:** None.
- **Responsive behavior:** Grid collapses to single column under mobile breakpoint; search remains reachable (not hidden behind a desktop-only control).
- **Accessibility requirements:** Search input has a real (visually-hidden if needed) `<label>`, matching the current `sr-only` pattern (`index.html:80`) — preserve.
- **Acceptance criteria:** User can find a specific world by name in under 2 interactions regardless of catalog size shown; archived/draft/published status is visible without opening the world.

## NEX-WORLD-DETAIL — World detail

- **Route (proposed):** `/worlds/:worldId` · **Current:** `worldDetailsDialog` modal
- **Current implementation state:** Implemented and wired
- **Disposition:** Replaced (modal → full screen with tabs, since it hosts substantial content: overview, draft editor, version history, characters)
- **Purpose:** View/edit a world's draft, publish new versions, manage characters, view version history, fork/export/delete.
- **Primary user:** Owner/operator.
- **Entry points:** World Library card click; Dashboard world card; Campaign detail "view world."
- **Primary actions:** Edit draft fields, generate/organize characters (AI-assisted, ADR 0016 review-before-save), publish, view version N, fork version N, delete version/world, export.
- **Data displayed:** World overview (title/genre/tone/premise/rules), entities/relationships/triggers/assets, playable characters, version history list.
- **API dependencies:** `GET/PUT /api/v1/worlds/:worldId(/draft)`, `POST .../publish`, `POST .../fork`, `DELETE .../versions/:id`, `DELETE /worlds/:worldId`, `GET .../export`, character-generation endpoints.
- **Major components:** Tabbed layout (Overview / Draft Editor / Version History / Characters), character review panel (ADR 0016 explicit-save pattern), publish confirmation, typed-delete confirmation (preserve `nexus.js:819`'s typed-confirmation pattern for destructive delete).
- **Required states:** Loading, draft-vs-published-version viewing mode (must be visually distinct per `PRODUCT_UX.md` Principle 5), save-in-progress/conflict (optimistic revision), error, empty (no versions published yet).
- **Permission behavior:** None.
- **Responsive behavior:** Tabs collapse to an accordion or select-driven single-panel view under tablet width.
- **Accessibility requirements:** Tab widget follows WAI-ARIA Tabs pattern (`role="tablist"`/`tab`/`tabpanel`, arrow-key navigation) — not currently implemented as true tabs (current dialogs are not ARIA tabs); dialog-embedded forms get real `<label>`s (fixes part of `CURRENT_UI_AUDIT.md` UI-002's pattern, applied here proactively).
- **Acceptance criteria:** User can tell at a glance whether they're viewing the mutable draft or an immutable published version; publishing requires explicit confirmation and is never reachable by a single accidental click.

## NEX-IMPORTS — World/Campaign import

- **Route (proposed):** `/worlds/import`, `/campaigns/import` · **Current:** `#imports` panel (shared with `#world-library`), `clipboardImportDialog`
- **Current implementation state:** Implemented and wired (world/legacy-story imports); Implemented but incomplete (Infinite Worlds import progress durability — `CURRENT_UI_AUDIT.md` UI-004)
- **Disposition:** Replaced (own route per import target, split from World Library's shared hash-view)
- **Purpose:** Import a world (JSON), a legacy `.story`/zip campaign, or convert an "Infinite Worlds" legacy document via AI-assisted conversion.
- **Primary user:** Owner/operator.
- **Entry points:** World Library "Import"; Campaign list "Import"; clipboard-paste shortcut.
- **Primary actions:** Choose import type, preview, confirm import; for Infinite Worlds, monitor AI-conversion progress.
- **Data displayed:** Import preview (parsed content summary), progress (Infinite Worlds only), result (200 duplicate vs. 201 new — must be shown, not silently treated the same).
- **API dependencies:** `POST /api/v1/imports/{world,legacy-story,infinite-worlds}` (+`/preview`), `GET /api/v1/imports/progress`.
- **Major components:** File/clipboard input, preview panel, progress indicator with the UI-004 durability caveat surfaced in copy.
- **Required states:** Idle, previewing, converting/importing (with the UI-004 caveat for Infinite Worlds specifically), success (new vs. duplicate, distinguished), error (parse failure, validation failure).
- **Permission behavior:** None.
- **Responsive behavior:** File-picker and preview stack vertically under tablet width.
- **Accessibility requirements:** File input has a real label; progress region is an ARIA live region.
- **Acceptance criteria:** A duplicate import is never presented identically to a genuinely new import; if Infinite Worlds progress stalls, the user sees the UI-004 disclosure rather than an indefinite spinner.

## NEX-CAMPAIGNS — Campaign list

- **Route (proposed):** `/campaigns` · **Current:** `#campaigns`
- **Current implementation state:** Implemented and wired
- **Disposition:** Retained
- **Purpose:** Browse, search, create, and resume campaigns.
- **Primary user:** Owner/operator.
- **Entry points:** Shell nav; Dashboard campaign card.
- **Primary actions:** Quick-create, advanced-create, search, open detail, resume into Story Player, archive/delete.
- **Data displayed:** Campaign cards (title, world+version, status, last-played).
- **API dependencies:** `GET/POST /api/v1/campaigns`.
- **Major components:** Card grid, search, quick-create dialog, advanced-create flow.
- **Required states:** Loading, empty (no worlds published yet → prompt to publish a world first, vs. no campaigns yet, vs. no search matches — three distinct empty states), error, populated.
- **Permission behavior:** None.
- **Responsive behavior:** Grid → single column under mobile breakpoint.
- **Accessibility requirements:** Same search-label pattern as NEX-WORLDS.
- **Acceptance criteria:** A user with zero published world versions is told exactly why they can't create a campaign yet, not shown a generic empty form.

## NEX-CAMPAIGN-DETAIL — Campaign detail

- **Route (proposed):** `/campaigns/:campaignId` · **Current:** spread across `createCampaignDialog`, `transferCampaignDialog`, `editStateDialog`, cost display, etc.
- **Current implementation state:** Implemented and wired
- **Disposition:** Replaced (consolidated into one tabbed detail screen — currently split across multiple disconnected dialogs)
- **Purpose:** Configure, monitor, and manage a single campaign outside of active play.
- **Primary user:** Owner/operator.
- **Entry points:** Campaign list card; Dashboard campaign card.
- **Primary actions:** Edit config (title, provider, response length, turn-control style), edit character profile, view/edit runtime state (scratchpad/trackers/mechanics — 4-tab equivalent of current `editStateDialog`), view cost summary, migrate/transfer world version (preview → commit), rewind/branch, export, archive/delete, "Play" (→ Story Player).
- **Data displayed:** Config, character profile/snapshot, runtime state, cost-by-category, turn history summary, pending-job indicator if one is active.
- **API dependencies:** `GET/PATCH /api/v1/campaigns/:id`, character-profile endpoints, `GET/PATCH .../state`, `GET .../cost-summary`, `GET .../sync-status`, migrate/transfer endpoints, `POST .../rewind`, `POST .../branch`, `GET .../export`, `DELETE /campaigns/:id`.
- **Major components:** Tabbed layout (Overview / State / Cost / History), world-version migration preview panel, transfer preview panel, rewind/branch confirmation (destructive-action pattern), pending-job banner (links into Story Player if a job is active).
- **Required states:** Loading, viewing, editing, migration/transfer-blocked-while-generating (explicit message per `FEATURE_IMPLEMENTATION_MATRIX.md`), error, a job-in-progress banner state.
- **Permission behavior:** None.
- **Responsive behavior:** Tabs → accordion under tablet width; cost table becomes horizontally scrollable within its own container, never causing page-level horizontal scroll.
- **Accessibility requirements:** True ARIA tabs; cost table uses real `<table>` semantics with `<th scope>`.
- **Acceptance criteria:** The pinned world version is visible on every tab, not just Overview; a blocked migration (active job) states why, not just that it failed.

## NEX-PROVIDERS — Provider management

- **Route (proposed):** `/providers` · **Current:** `#providers`, `providerDialog`, `providerModelDialog`, `illustrationPromptDialog`
- **Current implementation state:** Implemented and wired
- **Disposition:** Retained
- **Purpose:** Configure AI provider profiles for text, intent, embeddings, and illustrations.
- **Primary user:** Owner/operator.
- **Entry points:** Shell nav.
- **Primary actions:** Create/edit/delete a provider profile, discover models, set default per role, test (ad hoc generate), view health.
- **Data displayed:** Provider list grouped/filterable by role, health badge, default indicator, discovered models + pricing where available.
- **API dependencies:** Full CRUD + discovery endpoints in `FEATURE_IMPLEMENTATION_MATRIX.md` §Providers.
- **Major components:** Provider list, edit form (per-`providerType` fields, incl. Sogni-specific config), model-discovery picker, health badge.
- **Required states:** Loading, empty (no providers configured — block downstream generation actions elsewhere with a clear link back here), error, populated, credential-saved-but-untested.
- **Permission behavior:** None. Note: `configuration` field is returned unredacted by the API (`CURRENT_UI_AUDIT.md` UI backend note) — the UI must not add its own display/log surfaces that make this worse (e.g., don't echo `configuration` into browser console logs or error toasts).
- **Responsive behavior:** Provider edit form fields stack vertically; role filter remains reachable via a select on narrow viewports.
- **Accessibility requirements:** Every field has a real label (this screen already has comparatively strong labeling per `REPOSITORY_UI_MAP.md` §8 — preserve, don't regress).
- **Acceptance criteria:** A user can tell, without opening edit, which provider is the default for each role and its current health.

## NEX-PROMPTS — Prompt Library

- **Route (proposed):** `/prompt-library` · **Current:** `#prompt-library`
- **Current implementation state:** Implemented and wired
- **Disposition:** Retained
- **Purpose:** View and override the generation prompt templates.
- **Primary user:** Owner/operator (advanced use).
- **Entry points:** Shell nav.
- **Primary actions:** View template, edit override, preview rendered output, reset to default.
- **Data displayed:** Template list, current override (if any), live preview.
- **API dependencies:** `GET/PUT/DELETE /api/v1/prompt-library(/overrides)`, `POST .../preview`.
- **Major components:** Template list, override editor, preview pane.
- **Required states:** Loading, default (no override), overridden, previewing, error.
- **Permission behavior:** None.
- **Responsive behavior:** Editor/preview stack vertically under tablet width instead of side-by-side.
- **Accessibility requirements:** Editor textarea has a real label; preview updates announced via a live region.
- **Acceptance criteria:** A user can always tell whether a template is at its default or overridden, and revert in one action.

## STORY-PLAYER — Story Player (the "Infinite Quest" experience)

- **Route (proposed):** `/play/:campaignId` · **Current:** `/story`, `/story/:campaignId`
- **Current implementation state:** Implemented and wired
- **Disposition:** Retained (highest-priority screen — see `FRONTEND_IMPLEMENTATION_PLAN.md` vertical slice)
- **Purpose:** Play the campaign — read narration, submit turns, view illustrations.
- **Primary user:** Owner/operator, in "player" mode.
- **Entry points:** Campaign detail "Play"; Dashboard campaign card; direct URL.
- **Primary actions:** Submit Action/Scene/Auto input, choose a generated choice, view/regenerate illustrations, open turn history, open activity log, edit runtime state, undo/retry-latest, rewind/branch, export.
- **Data displayed:** Current scene narration, choices, illustrations, cost-so-far, campaign status.
- **API dependencies:** `POST .../generations`(`/retry-latest`), `GET .../generation-jobs/:id`(`/stream`,`/result`), `POST .../retry`,`/discard`, turn/illustration/state endpoints, `GET .../sync-status`.
- **Major components:** Scene/narration panel, choice buttons, input bar (mode selector), generation-progress indicator (SSE-first), illustration panel, turn-history drawer, activity-log drawer, state-editor dialog (4 sub-panels), export action.
- **Required states:** Idle/awaiting input, generating (staged progress per `PRODUCT_UX.md` status model), recoverable (retry/discard decision), failed, illustration-loading/failed-silently-today (fix per UI-003), resuming-after-reload (pending-generation recovery), empty (brand-new campaign, first turn).
- **Loading state:** Staged progress copy ("Reading state" → "Resolving action" → "Writing scene" → "Saving turn") per `docs/concepts/generation-integrity.md`.
- **Empty state:** First-turn / world-setup framing for a campaign with zero turns yet.
- **Error state:** Distinct recoverable-vs-failed treatment (§Status model); illustration failures surfaced, not silent (fixes UI-003).
- **Permission behavior:** None.
- **Responsive behavior:** Must remain fully usable at 390×844 (`PRODUCT_UX.md` §Responsive behavior) — narration, input, and choices are the non-negotiable mobile-usable core; illustration panel and drawers may collapse behind a toggle.
- **Accessibility requirements:** Materially improve label coverage vs. current (`CURRENT_UI_AUDIT.md` UI-002); add live regions for generation-progress and toast notifications matching Nexus's existing pattern; honor `prefers-reduced-motion` (fixes UI-011).
- **Acceptance criteria:** A user can submit a turn, watch progress, and read the result without leaving the screen; a `recoverable` job always presents a clear, immediate retry/discard choice; reloading mid-generation resumes correctly (except the documented Infinite-Worlds-import caveat, which doesn't apply here).

## CHRONICLE-HEALTH — Chronicle memory management

- **Route (proposed):** `/campaigns/:campaignId/chronicle` (tab within Campaign detail, or standalone route) · **Current:** not a dedicated screen — reachable via settings/config areas per `docs/nexus-guide/chronicle/*`
- **Current implementation state:** Implemented and wired at the API level; dedicated-screen status not confirmed from source (see `OPEN_QUESTIONS.md`)
- **Disposition:** New (elevated to its own screen — currently distributed, per docs, across settings-style panels rather than one dedicated view)
- **Purpose:** Inspect Chronicle health, preview assembled context, configure semantic embeddings/retrieval mode, trigger reindex.
- **Primary user:** Owner/operator (advanced use, especially for long-running campaigns).
- **Entry points:** Campaign detail tab.
- **Primary actions:** View metrics, preview context, change retrieval mode, configure embeddings, trigger reindex/embedding-reindex.
- **Data displayed:** Chronicle metrics, context preview, current embedding config, job status for any active reindex.
- **API dependencies:** `GET .../memory/metrics`, `GET .../memory/context-preview`, `POST .../memory/reindex`, `GET/PUT .../memory/embedding-config`, `POST .../memory/embeddings/reindex`, `GET /api/v1/jobs/:jobId`.
- **Major components:** Metrics summary, context-preview panel, retrieval-mode selector (5 modes — make tradeoffs legible per `FEATURE_IMPLEMENTATION_MATRIX.md`), reindex action with job-status feedback.
- **Required states:** Loading, healthy, needs-reindex (if metrics indicate staleness), reindexing (poll-only progress), error, embedding-disabled (feature is optional).
- **Permission behavior:** None.
- **Responsive behavior:** Metrics summary reflows to a stacked list under tablet width.
- **Accessibility requirements:** Reindex progress is an ARIA live region (poll-only, no SSE — must still announce updates).
- **Acceptance criteria:** A user can tell whether Chronicle is healthy or needs attention without reading raw metric numbers unassisted (contextualize them).

## SYS-ERROR — System error / unavailable state

- **Route (proposed):** shell-level overlay, not a routed page · **Current:** no dedicated screen found in source
- **Current implementation state:** Unable to confirm (no dedicated unavailable-state screen was found in the evidence gathered; `/health/live`,`/health/ready` exist as API endpoints but no frontend consumer of them was identified)
- **Disposition:** New
- **Purpose:** Tell the user clearly when the API is unreachable, rather than letting every widget fail independently and silently (as image-job polling does today, UI-003).
- **Primary user:** Owner/operator.
- **Entry points:** Automatic, on repeated API failure at the shell level.
- **Primary actions:** Retry connection.
- **Data displayed:** Plain-language "can't reach the server" message; optionally surfaces `/health/ready` detail if available.
- **API dependencies:** `GET /health/live`, `GET /health/ready`.
- **Major components:** Full-shell error state, retry button.
- **Required states:** Checking, unavailable, recovered (auto-dismiss).
- **Permission behavior:** None.
- **Responsive behavior:** Same message at all widths.
- **Accessibility requirements:** Announced via an ARIA live region / `role="alert"` at the moment connectivity is lost.
- **Acceptance criteria:** A user never sees a silently-broken app; a global outage produces one clear message, not many broken per-widget states.

---

## Screens explicitly not carried forward or not applicable

- **Root legacy `/index.html` monolithic client** — Removed. Already
  retired server-side (ADR 0020); not part of the frontend surface to
  reimplement (`REPOSITORY_UI_MAP.md` §2).
- **Section/contradiction comparison views, citation/evidence panel** (from
  the generic template) — Not applicable; no analog exists in this product
  (`PRODUCT_UX.md` §Adapting the review paradigm).
- **Reviewer work queue** — Not built; no current equivalent, and whether
  one is needed is an open question (`OPEN_QUESTIONS.md`).
- **Login/administration/user-management screens** — Not applicable by
  design (`PRODUCT_UX.md` §User roles).

---

## Traceability: product requirement → screen(s)

| Product requirement (source) | Screen(s) |
|---|---|
| World create/edit/publish/version/fork/archive/delete (`AGENTS.md`, ADR 0007/0013/0015) | NEX-WORLDS, NEX-WORLD-DETAIL |
| Reviewed AI-assisted character authoring (ADR 0016) | NEX-WORLD-DETAIL (Characters tab) |
| World import/export incl. Infinite Worlds conversion | NEX-IMPORTS, NEX-WORLD-DETAIL (export action) |
| Campaign create/configure/select-resume (`docs/nexus-guide/campaigns/*`) | NEX-CAMPAIGNS, NEX-CAMPAIGN-DETAIL |
| Same-world upgrade / cross-world transfer (ADR 0019) | NEX-CAMPAIGN-DETAIL |
| Campaign rewind/branch (`docs/player-guide/campaign-continuity.md`) | NEX-CAMPAIGN-DETAIL, STORY-PLAYER |
| Campaign cost tracking | NEX-CAMPAIGN-DETAIL |
| Campaign import/export | NEX-IMPORTS, NEX-CAMPAIGN-DETAIL |
| Turn generation incl. Action/Scene/Auto (ADR 0021) | STORY-PLAYER |
| Retry-latest / staged replacement (ADR 0017) | STORY-PLAYER |
| Generation recovery (`docs/player-guide/recovering-a-generation.md`) | STORY-PLAYER |
| Illustration generation/segments/backfill (ADR 0008/0025/0033) | STORY-PLAYER, NEX-CAMPAIGN-DETAIL (backfill), asset library component (shared) |
| Chronicle inspect/reindex/embeddings/retrieval modes | CHRONICLE-HEALTH |
| Provider profile management, model discovery, health | NEX-PROVIDERS |
| Prompt library override | NEX-PROMPTS |
| Dashboard activity/discovery | NEX-DASH |
| Deferred: cancellation, campaign-card artwork, Image Library Phase 6, TXT campaign update | Not built — see `FEATURE_IMPLEMENTATION_MATRIX.md` "Specified but not implemented" rows |
| System availability | SYS-ERROR |
