# Design System — Infinite Quest Nexus

No design-system or accessibility specification exists in the repository
today (confirmed by direct search, `REPOSITORY_UI_MAP.md` §1/§9). This
document is therefore a **design recommendation**, not a transcription of an
existing spec — built by extending the one real artifact that does exist,
`apps/web/public/tokens.css` (31 lines, color roles only), rather than
discarding it. Where a token name below matches `tokens.css`, that's
intentional continuity; new categories (spacing, typography, breakpoints,
motion) are new.

## Design principles

1. **One token layer, two consuming pages become one consuming app.**
   Today `nexus.css`/`story.css`/`navigation.css` each hardcode their own
   spacing/breakpoints (`CURRENT_UI_AUDIT.md` UI-007). Every new value must
   be a token, referenced, not a hardcoded literal.
2. **Status is never color-only.** Every status/health/outcome indicator
   pairs color with an icon and a text label (`PRODUCT_UX.md` §Status model).
3. **Narrative text is the product's core content and gets typographic
   priority.** Story Player narration is the "document" this product's
   users spend the most time reading — its type scale, measure (line
   length), and contrast must be tuned for sustained reading, not just
   reused from dense management-UI type styles.
4. **Dark-first, because the current product is dark-first.**
   `tokens.css:2` sets `color-scheme: dark` and every color role is defined
   for a dark surface. Preserve this as the primary theme; do not silently
   introduce a light theme without an explicit product decision (see
   `OPEN_QUESTIONS.md`).

## Design tokens

### Typography

Not currently defined as a scale (font sizes are ad hoc `clamp()`/`rem`
values per rule, e.g. `nexus.css:6`). Recommended scale (extend, don't
replace, the existing `Inter, system-ui` stack from `tokens.css`):

| Token | Use |
|---|---|
| `--font-family-base` | UI chrome, forms, labels (existing Inter/system-ui stack) |
| `--font-family-narrative` | Story Player narration — may equal `--font-family-base` initially, but named separately so it can diverge (e.g. a more readable serif/humanist face) without touching UI chrome |
| `--font-size-xs` … `--font-size-3xl` | 6-step scale for UI chrome (labels → page titles) |
| `--font-size-narrative` | Dedicated, larger-than-body size for scene narration, tuned for sustained reading |
| `--line-height-tight` / `--line-height-normal` / `--line-height-narrative` | Narrative gets its own, more generous line-height |
| `--measure-narrative` | Max character-width for narration blocks (~65–75ch), distinct from form/table content width |

### Spacing

Not currently defined at all. Recommended 8px-based scale:
`--space-1` (4px) … `--space-8` (64px), replacing every hardcoded
`padding`/`gap`/`margin` literal found throughout `nexus.css`/`story.css`.

### Layout grid / content-width rules

| Token | Value basis | Use |
|---|---|---|
| `--content-width-narrative` | ~1120px (matches current `story.css:94,220`) | Story Player reading column |
| `--content-width-management` | wider, e.g. ~1440px | World/Campaign/Provider list and table screens |
| `--radius` | `22px` (existing, `tokens.css`) | Cards, dialogs |
| `--radius-sm` | new, smaller | Buttons, badges, inputs |

### Breakpoints

Directly fixes `CURRENT_UI_AUDIT.md` UI-007 (14 uncoordinated `max-width`
values across 4 files). One shared scale, referenced everywhere:

| Token | Value | Rationale |
|---|---|---|
| `--bp-mobile` | 480px | Below: single-column, minimal chrome |
| `--bp-tablet` | 768px | Below: collapse secondary nav/tabs to accordion |
| `--bp-laptop` | 1024px | Below: management tables scroll horizontally within their container |
| `--bp-desktop` | 1280px+ | Full layout |

These four supersede all 14 current ad hoc values; every stylesheet
references the same four rather than inventing its own.

### Color roles

Extend `tokens.css`'s existing roles rather than renaming them (avoid
another rename cycle like the `--border`/`--accent` aliasing already visible
in `tokens.css:19-23`):

| Token | Current value/role | Notes |
|---|---|---|
| `--bg`, `--bg2` | page backgrounds | keep |
| `--panel`, `--panel-2` | card/dialog surfaces | keep |
| `--text`, `--muted`, `--dim` | text hierarchy | keep |
| `--line` | border color | keep; retire the `--border` alias once all call sites migrate |
| `--gold` | primary accent | keep — used for primary actions/emphasis |
| `--purple` | secondary accent | keep |
| `--success` | positive status (job `completed`) | keep |
| `--danger` | negative status (job `failed`) | keep |
| `--accent2` | tertiary accent | keep, define its semantic role explicitly (currently undocumented) |
| **new** `--status-recoverable` | distinct from both `--success` and `--danger` | `recoverable` is a decision point, not a failure — must not reuse `--danger` (see `PRODUCT_UX.md` §Status model) |
| **new** `--status-info` | neutral informational (queued, not-started) | |
| **new** `--health-healthy` / `--health-degraded` / `--health-unavailable` / `--health-unknown` | provider health (`provider-service.ts:62-85`) | Separate palette from job status — these describe a connection, not an outcome; never reuse job-status colors here (`PRODUCT_UX.md` explicitly warns against conflating the two models) |

### Status treatment

Every status/health value pairs a color token (above) with a fixed icon and
a text label — never color alone. Job-status icons should be visually
distinct enough to be legible at small badge sizes (e.g., spinner for
in-progress stages, checkmark for `completed`, a "needs decision" icon
distinct from an error icon for `recoverable`, an X for `failed`, an
archive icon for `discarded`).

### Severity treatment

**Not applicable** — no entity in this product has a severity dimension
(`PRODUCT_UX.md` §Adapting the review paradigm). Do not add a severity
token set.

### Confidence treatment

**Not applicable** as "confidence in an AI-generated finding" — the nearest
real concept, provider health, uses its own 4-value palette (above), kept
visually and terminologically separate from anything that could be
mistaken for a confidence score.

### Review-status treatment

Modeled as job status (`PRODUCT_UX.md` §Status model), not a separate
system. `recoverable` is the one state requiring an explicit human
decision and must be visually distinguishable from both `completed` and
`failed` at a glance (not just via a legend).

### Surfaces / borders / elevation

Two-level surface hierarchy already implied by `--bg`/`--bg2` and
`--panel`/`--panel-2` — formalize as: page background → panel/card surface
→ dialog/modal surface (add a third elevation step, `--panel-3`, for
dialogs so they read as "above" cards, not just a different flat color).
One `--shadow` token exists (`tokens.css`) — extend to
`--shadow-sm`/`--shadow-md`/`--shadow-lg` for card/dialog/toast elevation
respectively rather than one flat value reused everywhere.

### Icons

No icon system currently exists (no SVG sprite/icon-font/icon-component
evidence found). Recommend one consistent icon set for: status states,
provider health, navigation, and destructive-action warnings. Icons paired
with status color tokens must have accessible names (`aria-label` or
adjacent visible text) — never icon-only with no text alternative for
status meaning.

### Focus states

No dedicated focus-ring token exists today (native browser default focus
styles are relied upon based on the evidence gathered — `openManagedModal`/
dialog helpers manage `.focus()` calls but no custom focus-ring styling was
found). Add `--focus-ring` (color + width + offset) applied consistently
via `:focus-visible` (not `:focus`, to avoid showing rings on mouse clicks)
across all interactive elements — see `ACCESSIBILITY_SPEC.md`.

### Motion

`prefers-reduced-motion: reduce` is honored in exactly one of four
stylesheets today (`image-library-browser.css:36`, fixes
`CURRENT_UI_AUDIT.md` UI-011). Define motion as tokens applied globally:

| Token | Value | Use |
|---|---|---|
| `--motion-duration-fast` | ~120ms | micro-interactions (button press, toggle) |
| `--motion-duration-normal` | ~200ms | panel/dialog open-close |
| `--motion-easing-standard` | standard ease-out | default |

All of the above collapse to near-zero duration under
`prefers-reduced-motion: reduce`, applied once at the token/base-style
layer, not per-component.

### Narrative/long-form text display ("legal-text" analog)

Story Player narration is this product's long-form-reading surface
(analogous to the template's "legal-text presentation"):
- Use `--content-width-narrative`/`--measure-narrative` to bound line length.
- Use `--line-height-narrative` (more generous than UI-chrome line-height).
- Preserve paragraph structure from the API's narration text exactly —
  never reflow/strip whitespace in ways that could alter meaning.
- Player-editable free text (scratchpad, custom action) gets a monospace or
  clearly-distinct treatment from AI-authored narration, so a user never
  confuses "what I wrote" with "what the story engine wrote."

### Diff / comparison display

Used for: draft-vs-published world content (not currently a dedicated UI
per `OPEN_QUESTIONS.md`), and cross-world transfer preview (source vs.
target world). Recommend a two-column or inline-highlight diff treatment
consistent with the `--success`/`--danger` roles (added/removed) — but
distinct enough from job-status colors that a diff view is never confused
with a status indicator.

## Component inventory

For each: current state → variants/interaction states required in the
replacement.

| Component | Current evidence | Variants/states required |
|---|---|---|
| **App shell / nav** | `.universal-nav` (`navigation.css`), `@import`ed | Default, scrolled/sticky, mobile-collapsed, with/without active-job indicator |
| **Buttons** | ad hoc classes across `nexus.css`/`story.css` | Primary, secondary, destructive, disabled, loading (spinner + disabled), icon-only (with accessible name) |
| **Links** | plain `<a>` | Default, visited (if meaningful), external (import source links) |
| **Inputs / selects** | form fields throughout dialogs | Default, focused, invalid (+ inline error text, not color-only), disabled, with helper text |
| **World/campaign/provider selector** | dropdowns/cards in creation flows | Default, searchable-long-list variant (for growing catalogs) |
| **Analysis-mode control (turn-input mode)** | Action/Scene/Auto selector in Story Player | Default, resolved-from-Auto (shows which mode was chosen), disabled-while-generating |
| **File-upload control** | `clipboardImportDialog`, import file input | Idle, drag-over, uploading, error (bad format) |
| **Search control** | dashboard/world-library/campaign search inputs | Default, with results count, no-results |
| **Filters** | status filters (world/campaign) | Single-select today; keep simple unless data volume grows (`OPEN_QUESTIONS.md`) |
| **Tables** | cost summary, provider list | Sortable header (if needed), horizontally-scrollable-in-container (never page-level scroll), sticky header for long lists |
| **Data grids** | asset library grid | Grid/list toggle (existing PhotoSwipe-backed grid), facet filters |
| **Status badges** | ad hoc today | Job-status set (7 states, §Status treatment), provider-health set (4 states) — visually distinct families |
| **Severity indicators** | — | Not applicable, omit |
| **Confidence indicators** | — | Not applicable, omit |
| **Review-status indicators** | retry/discard controls | `recoverable` (actionable), `failed` (actionable), `discarded` (terminal, non-actionable) |
| **Progress trackers** | `showBusy`/`hideBusy`, staged generation copy | Indeterminate (queued), staged (assessing→generating→validating→committing), determinate where % is known (image `provider_progress`) |
| **Step indicators** | preview→commit flows (transfer, backfill, import) | 2-step (preview, commit) minimum, reusable across all 4 preview-gated operations |
| **Tabs** | dialog sub-panels today (e.g. `editStateDialog`'s 4 tabs) | True ARIA tabs (ADR-adjacent screens: World detail, Campaign detail, state editor) |
| **Accordions** | none found | Mobile/tablet collapse pattern for tabs |
| **Dialogs** | 27 native `<dialog>` elements today | Confirmation (typed-confirm for destructive), form, review (ADR 0016 character review), informational |
| **Drawers** | turn-history, activity-log (dialog-based today) | Slide-in variant for history/log, keeps context behind it visible on wide viewports |
| **Toasts** | `story.js` toast pattern | Success, error, info — adopt app-wide, retiring the separate `nexus.js` banner idiom (`CURRENT_UI_AUDIT.md` UI-010) |
| **Inline alerts** | `nexus.js` status banners | Persistent-until-dismissed, for decision-required states (`recoverable` job, blocked migration) |
| **Empty states** | dashboard/world-library carousels already have real copy | Generalize the existing "no data yet" vs. "no search matches" distinction (`nexus.js:573-574`) to every list screen |
| **Skeleton loaders** | not found (current loading state is static placeholder text) | Add for all list/card screens |
| **Error panels** | `setStatus`/toast | Retryable vs. terminal, with correlation ID display when present |
| **Job/turn outcome cards** ("finding cards" analog) | recovery UI in Story Player | Recoverable (actionable), failed (actionable), completed (informational) |
| **Job/turn outcome rows** ("finding rows" analog) | turn history list | Compact list-row variant for turn history |
| **Traceability links** ("citation links" analog) | — | Cost-line-item → source turn/job; Chronicle context entry → source turn |
| **Evidence panels** | — | Job error-detail panel (plain-language reason + raw error/correlation ID, disclosed progressively) |
| **Content viewer** | scene/narration panel | Read mode, with-illustration mode |
| **Text-diff component** | — | Draft-vs-published world diff (new), transfer preview diff |
| **Comparison components** | transfer preview, migration preview | Source vs. target side-by-side or stacked (responsive) |
| **Cross-reference components** | — | Not directly applicable; closest is "which campaigns use this world version" in version-history/delete-blocker context |
| **Scope summaries** ("analysis-scope summary" analog) | — | "You're about to generate with {provider/model}, scope: {Action/Scene}" pre-submit summary |
| **Reviewer note controls** | — | Not applicable — no note-taking feature exists in the product spec; do not invent one |
| **Decision controls** | retry/discard buttons | Paired, clearly differentiated (not just two same-weight buttons) |
| **Audit timelines** | activity log, turn history | Chronological list with type icons (turn accepted, job failed, provider changed) |
| **Export controls** | export buttons throughout | With format indicator (zip vs. JSON) shown before download starts |
| **Confirmation dialogs** | typed-delete confirmation (`nexus.js:819`) | Preserve typed-confirmation for irreversible deletes; simpler confirm for reversible actions (archive) |

## Accessibility rules

See `ACCESSIBILITY_SPEC.md` for the full spec; token-level rules that
belong here:
- Every color pairing (text/background, status-badge text/fill) meets
  WCAG 2.2 AA contrast at the token level, checked once per token pair, not
  per usage.
- `--focus-ring` must be visible against every surface token
  (`--bg`, `--panel`, `--panel-2`, `--panel-3`).
- Status/health color tokens are never the sole differentiator — enforced
  by pairing rule in §Status treatment.

## Content and terminology guidelines

- Use exactly the terms defined in `PRODUCT_UX.md` §Domain terminology —
  World, World Version, Campaign, Turn, Chronicle, Story Engine, Provider
  Profile, Action/Scene direction/Auto.
- Never use "document," "finding," "severity," or "confidence score" in UI
  copy — these have no referent in this product (§Adapting the review
  paradigm in `PRODUCT_UX.md`).
- "Recoverable" in UI copy should always be paired with a plain-language
  reason and a clear next step, not shown as a bare status word.
- Destructive-action copy always states irreversibility explicitly
  ("This deletes version 3 permanently — version numbers are never
  reused.") rather than a generic "Are you sure?".
