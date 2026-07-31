# Repository UI Map — Infinite Quest Nexus

**Audit date:** 2026-07-31 · **Repository commit:** `d1e6bde` (main) · **Produced by:** repository-grounded UI audit (`ui-review-repo` skill)

This document is the entry point for the audit. It inventories every piece of
the existing frontend surface, the specs that constrain it, and how to run it
— before any usability judgment is made (that judgment is in
`CURRENT_UI_AUDIT.md`).

> **Product identity (Phase 0):** the platform is **Infinite Quest Nexus**
> (management platform: World Library, Campaigns, Chronicle, Story Engine);
> the player-facing experience within it is **Infinite Quest**
> (`README.md:7-9`, `AGENTS.md:21-23`). This audit does not concern a
> document-review/findings product — Infinite Quest Nexus is an AI campaign
> and story-generation platform. Its closest analog to a "review paradigm" is
> the durable, automatically-validated turn-generation pipeline (queued →
> generating → validating → committed/recoverable/failed), not a
> human-adjudicated findings system. See `PRODUCT_UX.md` §"Adapting the
> review paradigm" for how this audit reframes concepts like severity/
> confidence/review-status for this product.

## 1. Relevant specifications

| Document | What it defines |
|---|---|
| `README.md` | Product framing, deployment quick start, current-status feature summary |
| `AGENTS.md` | Canonical contributor/governance spec: domain rules, persistence rules, identity model, security rules, naming rules |
| `docs/development-standards.md` | Source-of-truth precedence order, build/test/lint status, toolchain, open decisions |
| `docs/architecture/index.md` + `docs/architecture/0001`–`0027*.md` | 27 ADRs — accepted architectural decisions, several directly UI-relevant (0016 reviewed character authoring, 0017 staged latest-turn replacement, 0020 retirement of the legacy client, 0021 turn-input intent classification, 0025 streaming illustration pipeline, 0026 editable campaign runtime state) |
| `docs/architecture/image-library-enhancement-proposal.md` | Design proposal for the asset/image library UI, Phases 1–5 implemented, Phase 6 explicitly future |
| `docs/architecture/image-library-phase-6-future-enhancement.md` | Explicitly unscheduled future work — semantic image matching, sharing, moderation |
| `docs/concepts/*.md` | Domain glossary: worlds-and-versions, campaigns-and-turns, chronicle-memory, story-engine, provider-model, generation-integrity, authoritative-state, security-boundaries, identity-and-ownership |
| `docs/nexus-guide/**/*.md` | User-facing how-to documentation for every Nexus workflow (worlds, campaigns, chronicle, providers) — the closest thing this repo has to a functional spec for the management UI |
| `docs/player-guide/**/*.md` | User-facing how-to documentation for the Story Player (turn input modes, actions/choices, generation recovery, continuity, saving/exporting, troubleshooting) |
| `docs/reference/capabilities.md` | Authoritative "what is implemented today" list, explicitly not a roadmap |
| `docs/operations/deferred-improvements.md` | Authoritative "reviewed but intentionally not implemented" list |
| `docs/operations/security.md`, `docs/installation/requirements.md` | Trust-boundary and deployment constraints (pre-authentication, trusted-network-only) |
| `docs/review/2026-07-30-codebase-review.md` | An independent, prior full-repo audit (one commit behind this one) covering spec-traceability, security, and code health — cited here for grounded context, not re-derived. Notably: CORS defaults to reflect-any-origin-with-credentials (`server.ts:184-196`), two SSRF-class gaps in provider `baseUrl`/artifact-redirect handling, `apps/web/public/nexus.js` and `services/api/src/asset-service.ts` are the repo's two lowest-health/highest-churn files. These are backend/security findings, out of scope to fix here, but they matter to a replacement frontend's threat model (see `ACCESSIBILITY_SPEC.md` is unaffected; `API_UI_CONTRACTS.md` §Security notes flags this). |
| No accessibility or design-system specification exists anywhere in the repo | Confirmed by direct search — no file titled accessibility/design-system/tokens; the only accessibility language found is inside the *not-yet-fully-built* image-library Phase 6 proposal. `DESIGN_SYSTEM.md` and `ACCESSIBILITY_SPEC.md` in this audit are therefore **design recommendations**, not transcriptions of an existing spec. |

## 2. Frontend entry points

There is **no frontend build system, bundler, or JS framework**. The client is
hand-written vanilla HTML/CSS/JS, confirmed by: no `apps/web/package.json`;
root `package.json` has zero frontend-framework/bundler dependencies; the only
frontend "build" step is `node --check apps/web/public/nexus.js` /
`story.js` (syntax check only, `package.json` `scripts.check`); `nexus.js` is
loaded as a native ES module (`<script type="module" src="/nexus/nexus.js">`,
`apps/web/public/index.html:998`) and `story.js` as a classic script.

Two live entry points, served by Fastify static hosting:

| Path | File | Served by |
|---|---|---|
| `GET /nexus/` | `apps/web/public/index.html` | `@fastify/static`, prefix `/nexus/`, `index: ["index.html"]` (`services/api/src/server.ts:207-213`) |
| `GET /story`, `GET /story/:campaignId` | `apps/web/public/story.html` (cached in memory after first read) | `services/api/src/server.ts:230-236` |
| `GET /`, `GET /index.html` | — | 308 redirect to `/nexus/` (`server.ts:238-239`) |

**Retired legacy client:** the repository-root `/index.html` (10,838 lines,
inline CSS+JS, first committed `2c2fe78`, last touched `de58b7e`) is a
**dead, unshipped historical artifact**, not part of the served application.
It is explicitly retired per ADR `0020-retire-legacy-player-runtime.md`,
whitelisted as an intentional exception in
`scripts/check-repository-boundaries.mjs:15`
(`HISTORICAL_CLIENT_ALLOWLIST`), never copied into the Docker image
(`Dockerfile:40` copies only `apps/web/public`), and its routes
(`/`, `/index.html`) are hard-redirected server-side and tested as such
(`tests/unit/server-security.test.ts:45`). **Do not treat this file as part
of the current UI surface** — it is included here only so a replacement-UI
implementer doesn't mistake it for the active app.

## 3. Route map

No client-side router library is used. Navigation between the two HTML
documents is plain `<a href>` full-page loads. Inside `/nexus/`, "pages" are
implemented as `location.hash`-driven visibility toggles on a single
document, via `applyManagementView()` toggling `body[data-management-view]`
(`apps/web/public/nexus.js:235-264`, CSS rules in `nexus.css:32-42`).

| Hash | View | Notes |
|---|---|---|
| `#dashboard` (default) | Nexus dashboard | Activity stats, world/campaign carousels |
| `#world-library` | World Library + Imports panel | World cards, draft editing entry, Imports panel shares this view |
| `#campaigns` | Campaign management | Campaign list/detail, creation, transfer |
| `#providers` | Provider Management | Text/embedding/image/intent provider profiles |
| `#prompt-library` | Prompt Library | View/override generation prompt templates |

`/story` and `/story/:campaignId` load the same `story.html` (single-campaign
Story Player); `:campaignId` is read client-side, not routed server-side
differently. After creating a campaign from within Story Player,
`story.js:2660` uses `window.history.pushState` once to set a clean
campaign URL without a reload — the only client-side history manipulation
found.

Both documents host many native `<dialog>` elements as sub-screens (15 in
`index.html`, 12 in `story.html`, one of which — `editStateDialog` — is
itself tabbed into 4 sub-panels). See `SCREEN_INVENTORY.md` for the full
per-dialog breakdown.

## 4. Page inventory

| Page | File(s) | Approx. size |
|---|---|---|
| Nexus (dashboard/world-library/campaigns/providers/prompt-library, 5 hash-views + 15 dialogs) | `index.html` (1,000 lines), `nexus.js` (4,788 lines), `nexus.css` (474 lines) | largest single surface |
| Story Player (gameplay, + 12 dialogs incl. 4-tab state editor) | `story.html` (518 lines), `story.js` (2,827 lines), `story.css` (541 lines) | second-largest |
| Shared navigation bar | `navigation.css` (182 lines), imported by both page stylesheets | — |
| Reusable image-library/asset-picker widget | `image-library-browser.js`, `image-library-browser.css` (36 lines) | used from both pages, backed by vendored `jszip.min.js` and npm `photoswipe` |
| Design tokens | `tokens.css` (31 lines) | shared `@import` from both page stylesheets |

## 5. Component inventory

`nexus.js` and `story.js` are each flat scripts (no classes, no framework
components) — see `CURRENT_UI_AUDIT.md` §Architecture for the maturity
assessment. Reusable "components" in practice are:

- **Native `<dialog>` modals** — 27 total across both pages, opened via
  shared helpers `openManagedModal`/`requestModalDismissal`
  (`nexus.js:139-168`); no focus-trap library, relies on native `<dialog>`
  semantics.
- **`image-library-browser.js`** — the one genuinely reusable, importable
  component (`export function createImageLibraryBrowser(...)`), used by both
  the asset-library dialog in Nexus and the illustration pickers in Story
  Player.
- **`elements` DOM registry** (`nexus.js:3`) — every element with an `id`
  attribute is auto-collected into a flat lookup object used as the de facto
  "component ref" pattern throughout `nexus.js`.
- **Ad hoc UI primitives** repeated by hand rather than factored into
  shared functions in places: status/message banners, carousel empty states,
  card rendering — see `CURRENT_UI_AUDIT.md` for duplication specifics.

## 6. Styling architecture

- `tokens.css` (31 lines) — a **partial** design-token layer: `:root`-scoped
  color tokens (`--bg`, `--bg2`, `--panel`, `--panel-2`, `--text`, `--muted`,
  `--dim`, `--line`, 5 semantic accents `--gold`/`--purple`/`--success`/
  `--danger`/`--accent2`, one `--shadow`, one `--radius: 22px`), plus
  backward-compat aliases evidencing an in-flight token rename
  (`--border → var(--line)`, etc., `tokens.css:19-23`). **No spacing scale,
  no typography scale, no z-index scale, no breakpoint tokens exist.**
- `navigation.css` — shared top nav bar, `@import`ed by both page
  stylesheets (not linked separately in HTML).
- `nexus.css` / `story.css` — page-specific, hand-written, no naming
  convention (not BEM/utility-first/CSS-modules); font sizes and breakpoints
  hardcoded per-rule (`clamp()`/`px`) rather than referencing shared tokens.
- `image-library-browser.css` — small, scoped to the shared asset-picker
  widget.
- 14 `@media` breakpoints found across 4 CSS files, all `max-width`,
  **no two files share the same breakpoint scale** (e.g. 340/520/760 in
  `navigation.css` vs. 520/820 in `nexus.css` vs. 560/720/820/1120 in
  `story.css`) — see `CURRENT_UI_AUDIT.md` and `DESIGN_SYSTEM.md`.

## 7. State-management architecture

No state-management library. Two independent, inconsistent patterns:

- **`nexus.js`**: ~40 independent top-level mutable `let` variables
  (`nexus.js:11-66`) act as global state (`worlds`, `campaigns`,
  `selectedCampaign`, `providers`, `promptLibrary`, etc.). Two `localStorage`
  keys: `infiniteQuestLastCampaignId` and a read-only legacy-detection key
  `infiniteQuestNexusClientState.v1`.
- **`story.js`**: one centralized `const state = {...}` object
  (`story.js:31-62`, ~24 fields), plus durable `localStorage`-backed
  generation-recovery (`infiniteQuestPendingGeneration:${campaignId}`,
  `story.js:833-858`, with a 15-minute staleness check) so an in-flight
  generation job survives a page reload.
- URL state: `location.hash` only, for the 5 Nexus views. No query-string
  state, no deep-linkable finding/filter state anywhere.

## 8. API-client architecture

Two independently hand-rolled `api()` helpers — **not shared** between the
two pages:

- `nexus.js:266-282` — caller supplies full path incl. `/api/v1/...`
  prefix; parses JSON; throws a structured `Error` with `.name`,
  `.statusCode`, `.correlationId`, `.details` on non-OK responses.
- `story.js:124-139` — prepends `/api/v1` itself; forces
  `cache: "no-store"`; returns `null` on 204; simpler `Error` shape
  (`.status`, `.body`).

Long-running-job handling (the closest analog to "analysis progress" in a
review-tool sense) is real and reasonably sophisticated:

- **Turn generation**: `story.js` prefers **Server-Sent Events**
  (`new EventSource('/api/v1/generation-jobs/:jobId/stream')`,
  `story.js:1191`) and falls back to plain polling (900 attempts, ad hoc
  ~400ms interval, `story.js:1268-1305`) if `EventSource` is unsupported or
  errors. Submission itself is idempotent-retry-safe
  (`enqueueGenerationSubmission`, `story.js:868-909`).
- **Image jobs**: plain polling only, self-scheduled every 5s
  (`pollImageJobs`, `story.js:1527-1556`), polling errors swallowed
  silently.
- **Embedding/Chronicle jobs**: plain polling only, in `nexus.js`
  (`monitorEmbeddingJob`, `nexus.js:3606-3623`, up to 1200 attempts at 1s).
- No endpoint anywhere offers SSE except the one generation-job stream —
  image jobs, Chronicle jobs, and world-cover jobs are poll-only with no
  push channel. See `API_UI_CONTRACTS.md`.

## 9. Test inventory

| File | What it actually verifies | Real DOM/behavior? |
|---|---|---|
| `tests/unit/management-ui.test.ts` (588 lines) | `readFileSync` + string `.toContain()` assertions against `nexus.js`/`index.html`/`nexus.css`/`story.html`/`story.js`/`image-library-browser.js` source text — DOM ids, function names, literal copy | **No** — no JSDOM, no rendering, no event simulation |
| `tests/unit/dashboard-ui.test.ts` (95 lines) | Same string-matching pattern, scoped to dashboard markup/nav order | **No** |
| `tests/unit/story-player-ui.test.ts` (419 lines) | Same string-matching pattern, scoped to Story Player markup/dialogs/functions | **No** |
| `tests/unit/story-settings.test.ts` | Mostly real unit tests of `packages/contracts/src/story-settings.ts`; one string-match check against `story.js` | Mixed |
| `tests/unit/server-security.test.ts` (148 lines) | **Real** in-process Fastify requests via `app.inject()` against the actual `buildServer()` (DB mocked) — redirects, security headers, CORS, UUID validation | **Yes**, real server code path (backend, not UI rendering) |
| `tests/integration/*.test.ts` (12 files) | Real-Postgres backend integration tests — campaign transfer, generation, image pipeline, world library, Chronicle memory, migrations, etc. None are UI/DOM tests | Yes, but backend-only |

**No JSDOM/happy-dom environment is configured anywhere** (no root
`vitest.config.ts` sets a DOM environment; only `vitest.integration.config.ts`
exists, for the separate Postgres-backed integration suite). **No
Playwright/Cypress/Puppeteer/Selenium exists in the repo** — confirmed via
`package.json` dependencies and full-repo search.
`compose.ui-test.yaml` exists but defines no application or test-runner
container (only a `name`/`volumes`/`networks` block with a `-ui-test`
suffix) and is not referenced anywhere else in the repo (no workflow, no
script, no doc) — it is unused scaffolding, not functioning UI-test
infrastructure. CI (`​.github/workflows/ci.yml`) runs the string-match UI
tests and the real server-security test as part of `pnpm test`, but performs
**no browser-driven verification of the frontend at all**.

## 10. Mock-data inventory

- `tests/fixtures/cyoa_writing_com_sample.json` and
  `tests/fixtures/legacy-story.json` — synthetic, sanitized import-format
  fixtures used only by import-related tests, not by the running app.
- `local-data/assets` — an empty runtime mount point for the filesystem
  asset store; no seed content is checked in.
- **No seed/demo-data script exists** to populate a fresh local database
  with sample worlds/campaigns for manual UI exploration — a developer must
  create everything through the UI/API from an empty database (see
  `docs/getting-started` for the documented first-run path).
- **No mock backend, no MSW, no fixture-served frontend mode** — the
  frontend always talks to the real API; there is no way to run the UI
  against canned data.

## 11. Feature flags

**None exist.** A full-repo case-insensitive search for
`feature flag`/`featureFlag`/`FEATURE_FLAG`/`isEnabled`/`flags\.` produced
only two false positives (`RegExp.prototype.flags` usage in
`packages/domain/src/text.ts:48`, and a locally-scoped `imageFlags` capability
-detection array in `packages/story-engine/src/providers.ts:864`, unrelated
to feature gating). There is no environment-driven UI toggle mechanism.

## 12. Incomplete or stubbed functionality

No `TODO`/`FIXME`/`mock`/`stub` markers exist in the frontend JS (verified by
grep — zero hits). Incompleteness in this codebase is tracked at the
product-spec level instead, in `docs/operations/deferred-improvements.md`
and ADR status lines, not as inline code markers:

- **Incremental/streamed narration display** — explicitly deferred
  (`docs/operations/deferred-improvements.md`); the SSE stream that does
  exist is consumed for job *status*, not to progressively render narration
  text in the UI as it's produced. `docs/reference/capabilities.md` and the
  deferred-improvements doc arguably contradict each other on this point
  (see `OPEN_QUESTIONS.md`).
- **Explicit generation cancellation** — described only as future work
  requiring more durable infrastructure (`docs/operations/deferred-improvements.md:230`).
  Today's UI can retry/discard a `recoverable`/`failed` job but cannot cancel
  a job that is actively `generating`.
- **Image Library Phase 6** (semantic image matching, sharing/publication,
  moderation, advanced browsing) — explicitly "Future enhancement. Not
  scheduled" (`docs/architecture/image-library-phase-6-future-enhancement.md`).
  Phases 1–5 of that same proposal are implemented.
- **Campaign-card artwork** on the dashboard — `docs/reference/capabilities.md`
  states world-card covers are implemented while campaign-card artwork
  "remains deferred."
- **Updating an existing campaign from a newer Infinite Worlds TXT export**
  — explicitly deferred (`docs/operations/deferred-improvements.md:5-7`).
- **Interactive login/OIDC** — explicitly deferred at the product level, not
  merely a frontend gap (`docs/reference/capabilities.md:116`); every screen
  in the replacement UI must be designed for the current single-owner,
  pre-authentication model unless/until that changes (`AGENTS.md:88-119`
  sketches, but does not implement, a future `user_identities`/OIDC design).

## 13. Important assets

- `apps/web/public/nexus-mark.png` — brand logo, used with `alt=""` (correctly decorative).
- `apps/web/public/jszip.min.js` — vendored (non-npm) zip library for client-side import handling.
- `photoswipe` (npm dependency) — served from `node_modules/photoswipe/dist` via Fastify static (`server.ts:213-218`) for the image-library lightbox.

## 14. Runtime instructions

**Docker Compose (documented primary path):**
```
cp .env.example .env      # set POSTGRES_PASSWORD and CREDENTIAL_ENCRYPTION_KEY
docker compose up --build
```
- Nexus: `http://localhost:8080/nexus/`
- Story Player: `http://localhost:8080/story`
- Liveness/readiness: `http://localhost:8080/health/live` / `/health/ready`
- Default host port **8080** (`APP_PORT`); default two containers: `infinitequest-app` (`APP_ROLE=all`) + `postgres` (`pgvector/pgvector:0.8.5-pg18-trixie`).

**Source/dev mode:**
```
pnpm install --frozen-lockfile
pnpm dev     # tsx watch services/runtime/src/main.ts
```
Requires a reachable Postgres/pgvector instance and `DATABASE_URL`; no
separate frontend dev server exists (the API process serves the static
files directly).

**No seed data ships** — a fresh database has no worlds/campaigns/providers.
Exercising the full review-analogous workflow (world → campaign → turn
generation → illustration → export) requires either manual creation through
the UI or a configured external text-generation provider (LM Studio /
OpenRouter / Manifest / OpenAI-compatible), since story generation requires
a reachable provider endpoint (image/embedding providers are optional).

## 15. Known audit limitations

- **No live runtime inspection was performed for this document set.** This
  audit is code-grounded (static reading of `apps/web/public/*`,
  `services/api/src/*`, `packages/*`, and documentation), consistent with
  Phase 3's fallback path: "when the application cannot be run, document the
  exact blocker and continue with a code-based audit." The blocker here is
  scope/environment, not a technical inability to run Compose — no browser
  session, screenshots, or console-error capture were taken. Every UI claim
  in `CURRENT_UI_AUDIT.md` is therefore sourced from HTML/CSS/JS source
  reading, not observed rendering; anywhere runtime behavior could plausibly
  differ from source-level appearance, that is flagged explicitly rather
  than asserted as observed fact.
- Endpoint request/response field lists in `API_UI_CONTRACTS.md` are as
  complete as static reading allows but were not verified against live HTTP
  responses.
- The prior independent review at `docs/review/2026-07-30-codebase-review.md`
  (commit `069da72`, one commit behind this audit's `d1e6bde`) is cited
  where directly relevant (asset-service.ts health score, nexus.js hotspot
  status, CORS/SSRF gaps) but was not re-verified line-by-line by this
  audit; treat those specific citations as secondary evidence.
- This audit did not execute `pnpm test`/`pnpm build` itself; test-inventory
  claims are from direct source reading of the test files, cross-checked
  against `.github/workflows/ci.yml` step order.
