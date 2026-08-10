# Open Questions — Infinite Quest Nexus UI Audit

Only unresolved issues that could not be settled from the product
specification, code, tests, API definitions, or existing documentation.
Each includes a recommended default so implementation isn't blocked while
waiting for an answer.

**C8 resolution ledger (2026-08-02):** Q1 and Q4 are closed implementation
contracts, not open design questions. Progressive narration is retained only
through typed `GenerationEvent.narration`; retry-latest remains visibly distinct
from append. Explicit server cancellation exists and is distinct from local
watcher detach. HTTP/Web adapters live in `packages/client-web`, endpoint
adoption is incremental, and a generic watcher for non-generation jobs remains
deferred.

---

### Q1 — Does the Story Player actually render streamed partial narration text today, or only use the SSE stream for job status?

**Why it matters:** `PRODUCT_UX.md`, `API_UI_CONTRACTS.md`, and
`INTERACTION_FLOWS.md` all depend on knowing whether incremental-narration
display is a real, shippable current feature or an explicitly deferred one
— this materially changes what the replacement Story Player's generation-
progress UI should show.

**What was searched:** `docs/reference/capabilities.md` (states streaming
drives "progressive illustration segmentation... the browser never
receives provisional narration text and always renders the authoritative
committed turn"), `docs/operations/deferred-improvements.md` (states
"Stream provisional story narration during generation — Status: Deferred"),
and direct reading of the SSE handler (`server.ts:741-780`) and its
consumer (`story.js:1188-1230`).

**Current evidence:** The two documentation sources are consistent with
each other (narration text streaming is deferred). One research pass's
description of `story.js`'s SSE handler stated it "updates a 'streaming
preview' of partial narration," which reads as contradicting the docs —
but this could equally describe an internal, non-rendered buffering step,
or a UI element that shows generic progress copy rather than actual
narration text. The prior independent review
(`docs/review/2026-07-30-codebase-review.md` §8, item 1) independently
flagged this same capabilities.md-vs-deferred-improvements.md tension as an
unresolved specification ambiguity.

**Recommended default assumption:** Trust the two documentation sources
(deferred) over the single ambiguous code-reading claim. Build the
replacement Story Player's progress UI around staged status copy
("Reading state → Resolving action → Writing scene → Saving turn"), **not**
progressive narration text rendering, until this is confirmed otherwise by
a runtime pass.

**Who should answer:** The maintainer, ideally by running the current app
and watching Story Player during a real generation, or by reading
`story.js:1188-1230` line-by-line to confirm what the SSE `onmessage`
handler actually writes to the DOM.

**RESOLVED (2026-07-31):** Streaming narration text is real and rendered
today — this reverses the recommended default. `server.ts:753` sends
`partialNarration` on every SSE tick, populated in
`generation-service.ts:1850/1880` via `extractPartialNarration(accumulated)`
as tokens stream in. `story.js:1233-1234` reads `job.partialNarration` and
calls `renderStreamingPreview()`, which (`story.js:1009-1054`) writes the
text directly into a `.streaming-narration` DOM node with a "Streaming
Live" badge, pulsing cursor, and auto-scroll-follow behavior. The two
docs previously trusted (`capabilities.md`, `deferred-improvements.md`)
are stale. **Action:** the replacement Story Player's generation-progress
UI should show live streaming narration text, not staged status copy.

**IMPLEMENTED CONTRACT (C8, 2026-08-02):** Progressive narration remains
visible, but the app no longer reads raw `partialNarration` or owns the
EventSource/poll monitor. `packages/client-web` validates transport snapshots,
`GenerationWorkflow` emits `GenerationEvent.narration`, and the Story Player
renders that typed text. Raw `partialOutput` is never parsed or rendered.

---

### Q2 — Is the legacy single-image illustration path still reachable from the current frontend, or is it vestigial backend surface?

**Why it matters:** `FEATURE_IMPLEMENTATION_MATRIX.md` and
`CURRENT_UI_AUDIT.md` (UI-008) flag that `POST /turns/:turnId/illustrations`
+ `PUT .../illustration-asset` (single image per turn) coexist with the
newer segmented-illustration endpoints (ADR 0025/0033). If both are
user-reachable, the replacement UI needs two illustration interaction
models; if only the segmented path is reachable, the legacy endpoints are a
backend-only concern.

**What was searched:** `server.ts:842-878` (both endpoint families exist
and are live), ADR 0025 and 0033 (describe the newer segmented model as the
current design direction). The initial frontend research pass did not
conclusively trace whether the then-legacy `story.js` called the
single-illustration endpoints.

**Current evidence at initial review:** Inconclusive from static reading alone
— both API routes were registered and neither was marked deprecated in code or
docs.

**Recommended default assumption:** Design the replacement UI around the
segmented illustration model only (matches current product direction per
ADR 0025/0033); do not build UI for the legacy single-image path unless a
runtime/grep pass confirms it's still called from `story.js`.

**Who should answer:** Resolved; the historical check searched the legacy Story
Player for `illustration-asset` and `/illustrations` calls.

**RESOLVED (2026-07-31):** Vestigial — the legacy path was not reachable
from the UI. At the time, `story.js` defined `regenerateIllustration()` (calls
`POST /turns/:turnId/illustrations`) and `removeIllustration()` (calls
`PUT /turns/:turnId/illustration-asset`), wired to click-handlers for
`data-action="regenerate-image"`/`"remove-image"`. But no button anywhere in
the render templates
(`renderScene`, `segmentIllustrationMarkup`, `renderStoryIllustration`)
ever emits those `data-action` values — only segmented-model actions
(`regenerate-segment-image`, `edit-segment-image-prompt`,
`why-segment-image`, `rebuild-turn-segments`, `generate-turn-segments`)
are rendered. The handlers are orphaned dead code. **Action:** proceed
with the segmented illustration model only, as recommended; the legacy
endpoints are backend-only surface (candidates for a separate cleanup,
not something the replacement UI needs to support).

---

### Q3 — Does world/campaign catalog size justify server-side search, or is client-side substring filtering sufficient long-term?

**Why it matters:** `PRODUCT_UX.md` and `DESIGN_SYSTEM.md` currently
recommend preserving the existing client-side substring-search pattern for
World Library and Campaign list screens rather than requesting a new
backend search endpoint (per the audit constraint not to propose backend
changes without evidence a workflow can't be supported). If real-world
catalogs grow into the hundreds/thousands, client-side filtering degrades.

**What was searched:** `nexus.js:573-574,648-649` (confirms current
implementation is client-side substring filtering over the full
`GET /worlds`/`GET /campaigns` result sets, with no pagination), API
endpoint definitions (no search/filter query parameters exist on either
list endpoint).

**Current evidence:** No data on typical/expected catalog size exists in
the repository — this is an operational fact about how the product is
actually used, not something derivable from code.

**Recommended default assumption:** Keep client-side filtering for the
initial replacement (matches current behavior, lowest-risk choice); flag
pagination/server-side search as a fast-follow if real usage shows list
endpoints returning hundreds+ of items.

**Who should answer:** The product owner/maintainer, based on real
deployment data (or their own usage expectations).

**RESOLVED (2026-07-31):** Maintainer confirmed the recommended default.
Re-checked `server.ts:387` (`GET /api/v1/worlds`) and `server.ts:479`
(`GET /api/v1/campaigns`) — neither has pagination or query parameters.
**Action:** keep client-side substring filtering for the initial
replacement; revisit server-side search as a fast-follow only if real
usage shows list endpoints returning hundreds+ of items.

---

### Q4 — Is retry-latest ("replace last turn") already visually distinguished from a normal new-turn generation in the current UI?

**Why it matters:** `CURRENT_UI_AUDIT.md` UI-006 and `PRODUCT_UX.md`
Principle 1 require this distinction in the replacement UI; this audit
could not confirm from static source reading alone whether the current
busy-state copy already differentiates the two cases.

**What was searched:** `story.js:929-971` (`runGeneration`, the shared
busy-state code path for both cases) — no differentiated copy string was
found in the evidence gathered, but a full manual trace of every call site
was not performed.

**Current evidence:** Inconclusive from static reading.

**Recommended default assumption:** Assume no differentiation exists today
and build it explicitly into the replacement UI (low-cost either way — if
it already exists, the replacement just preserves it more clearly).

**Who should answer:** The maintainer, via a runtime pass triggering
retry-latest and observing the exact UI copy shown.

**RESOLVED (2026-07-31):** Yes, it's already differentiated — this
reverses the recommended default. `story.js:388-394` (`renderScene`):
when `state.pendingGeneration?.operationKind === "replace_latest"`, the
affected scene renders a dedicated banner — "Replacement in progress" /
"The accepted turn is preserved until its replacement is validated." On
failure, `story.js:997` appends "The original turn was preserved." to the
failure toast for the same `operationKind`. **Action:** the replacement
UI should preserve and clarify this existing pattern rather than invent
differentiation from scratch.

**IMPLEMENTED CONTRACT (C8, 2026-08-02):** The typed workflow rewire preserves
the replacement banner and original-turn-preserved failure copy. A structured
active-job 409 resumes the authoritative job and cannot turn a replacement into
an append or mint a second idempotency key.

---

### Q5 — Does a dedicated Chronicle-management screen exist in the current UI, or is Chronicle functionality distributed across other panels?

**Why it matters:** `SCREEN_INVENTORY.md` proposes CHRONICLE-HEALTH as a
**New** screen (elevated from what the docs describe as settings-style
panels), but this audit did not find conclusive evidence of the current
UI's exact structure for Chronicle features (metrics/context-preview/
reindex/embedding-config) — whether it's one panel, several, or embedded
inside campaign settings.

**What was searched:** `docs/nexus-guide/chronicle/*.md` (describes the
workflows, not the exact current screen/dialog structure);
`index.html`/`story.html`'s dialog inventory (`REPOSITORY_UI_MAP.md` §3)
does not obviously name a Chronicle-specific dialog by ID, but the dialog
list gathered was not exhaustively cross-referenced against every
Chronicle endpoint's frontend caller.

**Current evidence:** Inconclusive — the backend endpoints definitely
exist and are callable; their current UI home is not confirmed.

**Recommended default assumption:** Proceed with CHRONICLE-HEALTH as a new,
consolidated screen regardless of the current structure — this is a
usability improvement either way (a scattered-panels current state
strengthens the case; an already-consolidated current state means this is
just a straightforward migration).

**Who should answer:** The maintainer, via a runtime pass through Campaign
detail / settings areas in the current Nexus app.

**RESOLVED (2026-07-31):** One consolidated section, not scattered, but
also not a dedicated top-level screen today. `index.html:288`
(`#campaignContextSection`, class `chronicle-settings-section`, labelled
"Chronicle") holds the semantic-memory health badge, embedding provider
selector, compression setting, "Rebuild memory" (reindex) button, and
"View context preview" disclosure all together, inside the single
Campaign Management screen (`nexus.js`). Backed by
`GET .../memory/context-preview` and `POST .../memory/reindex`
(`nexus.js:4618,4638`). **Action:** proceed with CHRONICLE-HEALTH as a new
elevated/consolidated screen as recommended — the current state is
already grouped, so this is a straightforward migration/elevation, not a
recovery from scattered panels.

---

### Q6 — Is there a cross-campaign "needs attention" indicator anywhere in the current UI (e.g., on the dashboard) for recoverable/failed jobs?

**Why it matters:** `CURRENT_UI_AUDIT.md` scored "Dashboard usefulness" at
3/5 partly because no such indicator was found in the evidence gathered.
If one already exists, that score and the corresponding
`SCREEN_INVENTORY.md` NEX-DASH spec should be revised upward/adjusted.

**What was searched:** `GET /api/v1/dashboard/stats` response shape (not
fully enumerated in the research gathered — the endpoint exists and is
called, but its exact field list wasn't captured in detail);
`dashboard-service.ts` was identified as the handler but not read in full.

**Current evidence:** Inconclusive — absence of evidence, not confirmed
evidence of absence.

**Recommended default assumption:** Design NEX-DASH to include a
"needs attention" summary (campaigns with a `recoverable`/`failed` job) as
a genuine improvement; if the current dashboard already does this via
`dashboard-service.ts`, treat it as a retained requirement rather than a
new one.

**Who should answer:** The maintainer, via reading `dashboard-service.ts`
in full or a runtime pass on the current dashboard with a deliberately
induced `recoverable` job.

**RESOLVED (2026-07-31):** Confirmed absent. Read `dashboard-service.ts`
in full — `getDashboardStats()` returns only world/campaign/turn counts
and provider cost totals; there is no field anywhere in the response
shape for recoverable/failed jobs. **Action:** design NEX-DASH to include
a "needs attention" summary as a genuine new improvement, as recommended
— this is not a retained requirement, since nothing like it exists today.

---

### Q7 — What is the correct "discard"/"give up" action for a failed or recoverable image job, given no `POST /image-jobs/:jobId/discard` endpoint was found?

**Why it matters:** `INTERACTION_FLOWS.md` Flow 8 needs a definite answer
for the image-job recovery UI — generation jobs have both `/retry` and
`/discard`; only `/retry` was confirmed for image jobs
(`server.ts:894-896`).

**What was searched:** Full endpoint inventory of `server.ts` around image
jobs (`:890-896`) — only `GET /image-jobs/:jobId` and
`POST /image-jobs/:jobId/retry` were found. Variant removal
(`DELETE /illustration-segments/:segmentId/images/:variantIndex`) exists
but operates on a specific variant, not the job itself.

**Current evidence:** No explicit image-job discard endpoint exists in the
inventory gathered.

**Recommended default assumption:** Treat "remove the failed variant" (the
existing `DELETE .../images/:variantIndex` endpoint) as the practical
equivalent of discard for image jobs in the replacement UI, and confirm
this is sufficient (vs. requiring a new backend discard endpoint) before
finalizing the illustration recovery flow.

**Who should answer:** The backend maintainer, to confirm whether this is
the intended pattern or whether a dedicated discard endpoint should be
added.

**RESOLVED (2026-07-31):** Maintainer confirmed the recommended default.
Re-checked the full `image-jobs` inventory in `server.ts`: only
`GET /campaigns/:campaignId/image-jobs`, `GET /image-jobs/:jobId`, and
`POST /image-jobs/:jobId/retry` exist — no discard endpoint. **Action:**
treat `DELETE /illustration-segments/:segmentId/images/:variantIndex` as
the practical discard equivalent for image jobs in the replacement UI; no
new backend endpoint is needed.

---

### Q8 — Should the replacement UI support a light theme, or remain dark-only by design?

**Why it matters:** `tokens.css:2` hardcodes `color-scheme: dark` and every
color role is defined only for a dark surface — this is either a
deliberate product decision or simply "nobody's built a light theme yet."
`DESIGN_SYSTEM.md` currently recommends staying dark-first without
committing to dark-only.

**What was searched:** `tokens.css` in full (31 lines, no light-mode
variables or `prefers-color-scheme: light` handling found); no design
documentation states an explicit dark-only product decision.

**Current evidence:** No stated decision either way.

**Recommended default assumption:** Preserve dark-first as the sole theme
in the initial replacement (matches current behavior, avoids scope
creep); treat light-theme support as a separate, explicitly-scoped future
decision, not an implicit requirement of this migration.

**Who should answer:** The product owner/maintainer — a product/brand
decision, not a technical one.

**RESOLVED (2026-07-31):** Maintainer decided to plan for light theme
support — this overrides the recommended default (dark-only). **Action:**
`DESIGN_SYSTEM.md` and the replacement token set (successor to
`tokens.css`) should define both dark and light color roles from the
start, rather than treating light theme as out-of-scope for this
migration. Confirm with the maintainer whether light should ship at
initial launch or as a fast-follow within the same design-system scope.

---
