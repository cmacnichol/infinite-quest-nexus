# Current UI Audit — Infinite Quest Nexus

**Method note:** this audit is code-grounded, not runtime-observed (see
`REPOSITORY_UI_MAP.md` §15, "Known audit limitations"). No screenshots exist;
every claim below cites source file paths/lines instead. Where source-level
appearance could plausibly differ from rendered behavior, that uncertainty is
stated explicitly rather than asserted as fact.

## Executive summary

Infinite Quest Nexus's frontend is a **hand-written, framework-free, two-page
vanilla JS/HTML/CSS application** (no bundler, no component library, no
client-side router) that is, nonetheless, **wired to essentially the entire
backend feature surface** — the Feature Implementation Matrix found only a
handful of genuinely absent features, and every one of them is a
deliberately, explicitly deferred product decision (documented in
`docs/operations/deferred-improvements.md` or an ADR status line), not a
silent frontend gap. This is a maturity profile the opposite of most
"partially wired" audits this skill is designed for: the risk here is almost
entirely in **consistency, maintainability, accessibility depth, and test
fidelity** — not missing functionality.

The two pages (`apps/web/public/index.html`+`nexus.js`, "Nexus", 4,788 lines
of JS; `story.html`+`story.js`, "Story Player", 2,827 lines of JS) were
built independently enough that they duplicate almost everything a shared
foundation would normally provide: two separate `api()` helpers with
different error shapes, two different error-surfacing UI patterns (status
banners vs. toasts), and CSS breakpoints that don't share a common scale
across the four stylesheets. `tokens.css` shows real intent toward a design
system (color roles, one radius token, one shadow token) but stops well
short of a spacing or typography scale, so most visual consistency in the
app today is coincidental rather than systematized.

The product's most distinctive UX pattern — and the one a replacement UI
should preserve most carefully — is its **staged/durable operation model**:
long-running or risky operations (turn generation, cross-world transfer,
illustration backfill, Infinite Worlds import) consistently use a
preview-then-commit or queued-then-poll/stream pattern with an explicit
`recoverable` state distinct from `failed`. This is architecturally the
closest thing this product has to "evidence before conclusion" /
"incomplete analysis is never mistaken for a clean result" — it should be
made more visible in the UI than it currently is (see findings UI-003, UI-006).

## Current frontend strengths

- **Real, structured error handling in the primary API client.** `nexus.js`'s
  `api()` helper (`nexus.js:266-282`) builds a proper `Error` with `.name`,
  `.statusCode`, `.correlationId`, and `.details`/`.issues`/`.blockers` —
  genuinely useful for support/debugging, not just a caught string.
- **Durable job model surfaced to the user, not hidden.** Generation jobs
  expose `queued/assessing/generating/validating/committing/completed/
  recoverable/failed/discarded` and the UI has real retry/discard controls
  (`server.ts:786-792`) rather than a generic spinner-then-error.
- **Preview-before-commit used consistently** for the product's riskiest
  operations: cross-world transfer (`server.ts:530-545`), illustration
  backfill (`server.ts:829-840`), and world/Infinite-Worlds import
  (`server.ts:371-396`) all expose a `/preview` endpoint before the
  mutating call — a real, reusable pattern the replacement UI should keep
  and generalize.
- **One genuinely reviewed-AI-output-before-commit flow exists.** ADR 0016
  requires the user to explicitly review and save AI-generated character
  profile fields before persistence (`docs/architecture/0016-reviewed-character-authoring.md:19`)
  — the closest analog in the product to human adjudication of AI output.
- **Meaningful accessibility groundwork in the Nexus page specifically**:
  111 `aria-*` attributes, 20 `role=` uses, 143 `<label>` elements, and
  `aria-live="polite"` regions on the dashboard stats and both carousels
  (`index.html:57,64,71`) — genuine, not decorative, live-region usage for
  async content.
- **Correct handling of the retired legacy client.** The old monolithic
  root `index.html` was cleanly retired (ADR 0020), hard-redirected
  server-side, excluded from the Docker image, and the redirect is
  regression-tested (`tests/unit/server-security.test.ts:45`) — a genuinely
  clean deprecation, not lingering dead code left half-wired.
- **A partial design-token layer already exists** (`tokens.css`) with
  sensible color-role naming — a real foundation to extend rather than
  replace from zero.

## Current implementation maturity

Per the Feature Implementation Matrix: the overwhelming majority of rows are
**Implemented and wired**. The only **Specified but not implemented** rows
are all explicit, documented product deferrals (generation cancellation,
campaign-card artwork, Image Library Phase 6, TXT-based campaign update) —
none are silent gaps discovered by this audit. One backend-only gap
(provider `configuration` field redaction) and one narrow durability gap
(in-memory Infinite Worlds import progress) were found; both are called out
below and are backend-owned, not frontend defects.

## Findings

Priority model: **P0** prevents a core workflow or creates serious data/
security/accessibility risk · **P1** substantially harms a primary workflow ·
**P2** noticeably reduces usability, consistency, or maintainability ·
**P3** minor refinement.

---

**UI-001 — P0 — Unsafe default CORS configuration undermines the frontend's entire trust model**
*Screen/workflow:* all — every `/api/v1/*` call the frontend makes.
*Implementation state:* Implemented and wired (as designed), but the
shipped default is unsafe.
*Description:* The API reflects any request `Origin` and sends
`Access-Control-Allow-Credentials: true` by default
(`services/api/src/server.ts:184-196`; default `corsAllowedOrigins: ["*"]`,
`packages/database/src/config.ts:67`). Combined with the documented absence
of authentication (every request resolves server-side to a single
`initial-owner`, `AGENTS.md:88-119`), any page a user's browser loads on the
same network can silently read and mutate all Nexus data through the
frontend's own origin trust.
*User impact:* Not a UI rendering defect, but it means the replacement
frontend cannot assume "if a request reaches the API, it was intentional" —
any convenience pattern that trusts the browser context implicitly
(auto-submitting forms, storing more in `localStorage` than necessary,
assuming same-origin) makes this worse, not better.
*Repository evidence:* `docs/review/2026-07-30-codebase-review.md` §4
(independent prior review, backend-owned finding; not re-derived here).
*Recommended direction:* Out of scope to fix in the replacement frontend
(this is a backend/CORS-policy fix). The replacement UI should be built
**assuming this boundary may remain weak for some time**: avoid widening the
client-side attack surface (don't cache more sensitive data in
`localStorage`/`sessionStorage` than the current app does, don't add
convenience auto-submit patterns for destructive actions). Track the actual
fix as a backend item, not a frontend one.

---

**UI-002 — P1 — Story Player has materially weaker form-labeling coverage than Nexus despite similarly dense forms**
*Screen/workflow:* Story Player — `editStateDialog` (4 tabs), `worldSetupDialog`, `userProfileDialog`, and other dialogs with form inputs.
*Implementation state:* Implemented but incomplete (accessibility depth).
*Description:* `story.html` contains only 11 `<label>` elements against
`index.html`'s 143, despite `story.html` hosting numerous form-like dialog
inputs (state editor tabs, world setup, profile settings). `sr-only` (used 3
times in `index.html` for visually-hidden labels) does not appear anywhere
in `story.html` or `story.js`.
*User impact:* Screen-reader and voice-control users of the Story Player —
the product's actual player-facing surface, not just the admin tool — are
materially more likely to encounter unlabeled or ambiguously-labeled
controls than in Nexus.
*Repository evidence:* frontend research pass, label-count grep across
`index.html`/`story.html`; `nexus.css:327` (`.sr-only` definition), absent
from `story.css`.
*Recommended direction:* Full accessibility-label audit of every Story
Player dialog in the replacement UI; see `ACCESSIBILITY_SPEC.md`.

---

**UI-003 — P1 — Image-job polling silently swallows errors, leaving the user with no failure signal**
*Screen/workflow:* Story Player — illustration generation/regeneration.
*Implementation state:* Implemented but incomplete.
*Description:* `pollImageJobs()` (`story.js:1527-1556`) self-schedules every
5 seconds and wraps its poll call in `catch (_) { /* ignore polling errors
*/ }` (`story.js:1554`) — a transient or persistent polling failure produces
no user-visible state change at all; the UI simply stops updating with no
error, timeout, or "couldn't check image status" message.
*User impact:* A user waiting on an illustration has no way to distinguish
"still generating" from "the status check itself is broken" — they can only
infer a problem by waiting indefinitely.
*Repository evidence:* `story.js:1527-1556` (poll loop), `story.js:1554`
(silent catch).
*Recommended direction:* Replace the silent catch with a bounded-retry +
visible-degraded-state pattern (see `INTERACTION_FLOWS.md` "Track analysis
progress" and `PRODUCT_UX.md` status model — treat repeated poll failure as
its own explicit state, not silence).

---

**UI-004 — P1 — Infinite Worlds import conversion progress is held in memory only and is lost on API restart**
*Screen/workflow:* World Library — Infinite Worlds legacy-document import.
*Implementation state:* Implemented but incomplete.
*Description:* `GET /api/v1/imports/progress` reads from an in-memory
`activeProgressMap` (`infinite-worlds-import-service.ts:37-50`), not a
durable store, unlike every other long-running job family in this product
(generation, illustration, Chronicle jobs are all Postgres-row-backed with
lease/recovery semantics per `REPOSITORY_UI_MAP.md` §8). If the API process
restarts mid-conversion, the frontend's progress poll simply starts
returning 404 with no way to know whether the conversion is still running
elsewhere, failed, or needs to be restarted from scratch.
*User impact:* For a potentially long AI-assisted document conversion, this
is a real risk of the user being stranded with no actionable next step.
*Repository evidence:* `infinite-worlds-import-service.ts:37-50`;
contrast with the durable, lease-based job pattern documented for every
other job family in `REPOSITORY_UI_MAP.md` §8/§9.
*Recommended direction:* Backend durability fix is out of scope here; the
replacement frontend should at minimum surface an explicit "progress
tracking is process-local; if this stalls, check whether the import
actually completed via the World Library list" fallback message rather than
presenting a silent/ambiguous stall, until the backend gap is closed. Track
the durability fix itself in `OPEN_QUESTIONS.md`.

---

**UI-005 — P2 — Two independently-implemented API clients with different error shapes and no shared conventions**
*Screen/workflow:* all — cross-cutting.
*Implementation state:* Implemented and wired, but duplicated.
*Description:* `nexus.js:266-282` and `story.js:124-139` are separately
hand-written `api()` functions with different call conventions (one expects
the caller to include `/api/v1` in the path, the other prepends it
automatically) and different error object shapes (`.name`/`.statusCode`/
`.correlationId`/`.details` vs. `.status`/`.body`). Nothing shares this
logic between the two pages.
*User impact:* Indirect — inconsistent error handling between the two pages
means a user might see a well-formed error message with a correlation ID in
one part of the app and a bare status/body dump in another, depending on
which page they're in.
*Repository evidence:* `nexus.js:266-282`, `story.js:124-139`.
*Recommended direction:* Consolidate into one shared API-client module with
one error shape in the replacement frontend (see
`FRONTEND_IMPLEMENTATION_PLAN.md` "shared foundation work").

---

**UI-006 — P2 — No visual distinction between a normal new-turn generation and a staged "replace latest" operation**
*Screen/workflow:* Story Player — turn generation / retry-latest.
*Implementation state:* Implemented and wired at the API level; UI framing not confirmed from source alone.
*Description:* `retry-latest` (ADR 0017) is a meaningfully different,
higher-stakes operation than a normal next-turn generation — it stages a
replacement of already-accepted content and only commits it after
validation — but the source evidence gathered does not show the busy-state
copy (`showBusy(...)` calls, `story.js:929` etc.) or generation UI
distinguishing "generating your next turn" from "replacing your last
accepted turn" with different visual weight or confirmation.
*User impact:* A user could underestimate that retry-latest touches
already-accepted story history, even though the backend protects them from
data loss on failure.
*Repository evidence:* `docs/architecture/0017-staged-latest-turn-replacement.md:15`;
`story.js:929-971` (`runGeneration`, shared busy-state path — no
differentiated copy found for the retry-latest variant in the evidence
gathered).
*Recommended direction:* Confirm via a runtime pass whether differentiated
copy already exists (flagged in `OPEN_QUESTIONS.md` since this audit could
not run the app); if it doesn't, add explicit "this will replace your last
turn" framing before submission in the replacement UI.

---

**UI-007 — P2 — CSS breakpoints are ad hoc and inconsistent across the four stylesheets**
*Screen/workflow:* all — responsive layout.
*Implementation state:* Implemented, but not systematized.
*Description:* 14 `@media` rules exist across `nexus.css`, `story.css`,
`navigation.css`, and `image-library-browser.css`, all `max-width`-based,
and no two files share the same breakpoint scale (340/520/760 in
`navigation.css`; 520/820 in `nexus.css`; 560/720/820/1120 in `story.css`).
`tokens.css` defines zero breakpoint tokens.
*User impact:* Layout behavior at a given viewport width is inconsistent
between the navigation bar and the page content beneath it, since they
don't share breakpoints — increases the chance of visually mismatched
responsive transitions (e.g. nav collapses at a different width than the
content below it).
*Repository evidence:* `navigation.css:150,163,179`; `nexus.css:408,439`;
`story.css:94,220,262,295,299,435`; `image-library-browser.css:34,35`.
*Recommended direction:* Define a shared breakpoint scale as design tokens
and apply it consistently — see `DESIGN_SYSTEM.md` §Breakpoints.

---

**UI-008 — P2 — Two illustration systems (legacy single-image and newer segmented) coexist in the API and, presumably, the UI**
*Screen/workflow:* Story Player — turn illustrations.
*Implementation state:* Implemented and wired (both paths); ambiguous which is user-reachable today.
*Description:* `POST /turns/:turnId/illustrations` + `PUT
.../illustration-asset` (legacy, single image per turn) coexist with the
newer segmented-illustration endpoints (ADR 0025/0033: multiple
independently-generated segments per turn, up to 2 variants each). Both are
live API routes (`server.ts:842-878`).
*User impact:* Unclear from source alone whether the legacy single-image
path is still reachable from the current UI or is vestigial backend surface
— if it is still reachable, users may encounter two different illustration
interaction models depending on which turns/campaigns they're viewing.
*Repository evidence:* `server.ts:842-849` (segmented) vs. `:869-878`
(legacy single).
*Recommended direction:* Confirm (flagged in `OPEN_QUESTIONS.md`) whether
the legacy path is still frontend-reachable; if so, consolidate to one
illustration interaction model in the replacement UI.

---

**UI-009 — P2 — The "UI test" suite cannot detect real rendering, layout, or interaction regressions**
*Screen/workflow:* all — test infrastructure, not a user-facing finding, but affects confidence in future UI changes.
*Implementation state:* Implemented but incomplete (as a safety net).
*Description:* All three `*-ui.test.ts` files (`management-ui.test.ts` 588
lines, `dashboard-ui.test.ts` 95 lines, `story-player-ui.test.ts` 419
lines) work by `readFileSync`-ing the HTML/CSS/JS source and asserting
`.toContain()` on literal substrings — no JSDOM, no rendering, no simulated
interaction. `compose.ui-test.yaml` exists but is empty scaffolding
(no application/test-runner service, unreferenced anywhere in the repo).
No Playwright/Cypress/Puppeteer exists.
*User impact:* Indirect — a real rendering bug, broken event handler, or
visual regression could ship with a fully green CI run, since nothing in
CI actually executes the frontend code.
*Repository evidence:* `tests/unit/management-ui.test.ts:1-9`; full-repo
search confirming no browser-automation dependency exists;
`.github/workflows/ci.yml` step order confirming no browser-driven step.
*Recommended direction:* See `FRONTEND_IMPLEMENTATION_PLAN.md` §Testing —
a replacement frontend (component-based) should adopt real component/DOM
testing plus a minimal E2E smoke suite for the vertical slice in
`FRONTEND_IMPLEMENTATION_PLAN.md`.

---

**UI-010 — P3 — Divergent error/status presentation idioms between the two pages**
*Screen/workflow:* all.
*Implementation state:* Implemented, inconsistent style only.
*Description:* `nexus.js` surfaces errors via persistent status-banner
helpers (`setStatus`/`worldMessage`/`campaignMessage`/`providerMessage`,
e.g. `nexus.js:446`), while `story.js` uses a transient `toast(msg,
duration)` pattern (`story.js:141+`). Neither is wrong in isolation, but a
user moving between the two pages experiences two different visual
languages for "something went wrong."
*User impact:* Minor — a consistency/polish issue, not a blocker.
*Repository evidence:* `nexus.js:446`; `story.js:141` and call sites e.g.
`story.js:965`.
*Recommended direction:* Standardize on one toast/banner/inline-alert
system per `DESIGN_SYSTEM.md` component inventory.

---

**UI-011 — P3 — No reduced-motion accommodation outside one stylesheet**
*Screen/workflow:* all.
*Implementation state:* Implemented in one place only.
*Description:* `prefers-reduced-motion: reduce` is honored only in
`image-library-browser.css:36`; `nexus.css`, `story.css`, and
`navigation.css` have no equivalent rule.
*User impact:* Users with vestibular motion sensitivity get inconsistent
protection depending on which part of the app they're in.
*Repository evidence:* grep across the four CSS files for
`prefers-reduced-motion`.
*Recommended direction:* Apply a global reduced-motion rule in the shared
design-token/base layer — see `DESIGN_SYSTEM.md` §Motion.

---

## Screenshots or screenshot references

None captured — see "Method note" above and `REPOSITORY_UI_MAP.md` §15.
This is a stated audit limitation, not an omission; a follow-up runtime pass
(Docker Compose, per `REPOSITORY_UI_MAP.md` §14) is recommended before final
visual-design sign-off, since several findings above (UI-006 especially)
depend on confirming rendered copy/emphasis that source reading alone
cannot fully settle.

## Audit scoring

Scored 1–5, no unsupported precision. "Current" frontend only (not the
proposed replacement).

| Category | Score | Rationale |
|---|---|---|
| Information architecture | 3/5 | Hash-routed views work but World Library and Imports share one hash-view, muddying separation; Nexus↔Story Player is a hard full-page navigation with no return context beyond a `localStorage` last-campaign id. |
| Dashboard usefulness | 3/5 | Real activity stats and searchable carousels exist and are wired; no cross-campaign "needs attention" surfacing (e.g., campaigns with a `recoverable`/`failed` job) was found anywhere in the dashboard evidence gathered. |
| Workflow clarity | 4/5 | Consistent preview-then-commit pattern for risky operations (transfer, backfill, import) and a real durable-job lifecycle are strong, repeatable precedents; docked for UI-006 and UI-008 ambiguity. |
| Analysis-scope clarity (staged vs. committed operations) | 4/5 | Preview/commit separation is used consistently and is a genuine strength; docked because retry-latest's "this touches accepted history" framing isn't confirmed distinct from a normal turn (UI-006). |
| Visual hierarchy | 3/5 | Reasonable, purposeful use of status/busy/empty-state patterns; undermined by two divergent error idioms (UI-010) and uncoordinated spacing (no spacing token scale). |
| Consistency | 2/5 | Two independent API clients (UI-005), two error-presentation idioms (UI-010), 14 uncoordinated breakpoints (UI-007), and a color-only token layer are the core drag on this score. |
| Accessibility | 3/5 | Real, non-decorative aria-live/dialog-semantics usage in Nexus; materially weaker labeling in Story Player (UI-002), no skip link, inconsistent reduced-motion handling (UI-011). |
| Responsive design | 2/5 | Breakpoints exist in every stylesheet but share no common scale (UI-007); no evidence of deliberate small-viewport workflow simplification was found in the source read. |
| Error handling | 3/5 | The `nexus.js` structured-error pattern (correlation IDs, typed error names) is a real strength; undercut by silent poll-error swallowing (UI-003) and non-durable import progress (UI-004). |
| Loading and analysis-progress feedback | 4/5 | SSE-first with polling fallback for the highest-stakes job type (turn generation) is a comparatively mature pattern; docked because image/Chronicle/cover jobs are poll-only with no push channel, and image polling fails silently (UI-003). |
| Finding presentation (job/turn outcome presentation) | 3/5 | `recoverable` vs. `failed` is a real, actionable distinction with retry/discard controls; no dedicated cross-campaign queue of items needing attention was found. |
| Citation and evidence presentation (state/cost traceability) | 3/5 | Cost summaries and the turns ledger carry enough structure to trace results back to their source; no dedicated "why is state X" visualization beyond the state-editor dialog and turn history was found. |
| AI uncertainty communication | 3/5 | The recoverable/failed status split itself communicates uncertainty structurally; no evidence was found that the UI explains *why* a generation needed recovery in plain language beyond a raw error-message field, or flags retry cost implications. |
| Maintainability | 2/5 | No framework, no shared component layer between the two pages, duplicated API clients, no type checking on browser JS (confirmed in `docs/development-standards.md`), and `nexus.js` is independently flagged as the repo's #1 refactor-first hotspot by the codebase's own health tooling. |
| Test coverage | 2/5 | The dedicated "UI test" suites are string-matching only and cannot catch rendering/interaction regressions (UI-009); no browser-automation framework exists at all; backend/API test coverage (integration suite, `server-security.test.ts`) is comparatively strong but is a different layer. |
| Implementation completeness | 4/5 | The Feature Implementation Matrix found the product's documented feature set is almost entirely implemented and wired; the few gaps are all deliberate, documented product deferrals, not silent omissions. |
