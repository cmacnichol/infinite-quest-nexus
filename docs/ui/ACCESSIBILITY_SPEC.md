# Accessibility Specification — Infinite Quest Nexus

No accessibility specification exists in the repository today (confirmed by
direct search — see `REPOSITORY_UI_MAP.md` §1/§9). This document is a
**design recommendation** targeting WCAG 2.2 AA, grounded in the specific
gaps found during the current-UI audit rather than a generic checklist.

## Accessibility target

**WCAG 2.2 Level AA**, applied to both the Nexus management app and the
Story Player. Story Player receives equal or greater priority since it is
the actual player-facing "Infinite Quest" experience
(`PRODUCT_UX.md` §Responsive behavior), not a secondary admin surface —
this directly counters the current asymmetry where Nexus has materially
stronger accessibility groundwork than Story Player (`CURRENT_UI_AUDIT.md`
UI-002).

## Semantic-page requirements

- Every screen has exactly one `<h1>` describing its purpose (World Library,
  Campaign detail for "{name}", Story Player for "{campaign name}", etc.).
- Dialog-based sub-screens (world detail, campaign detail, state editor)
  moving to routed screens (`SCREEN_INVENTORY.md`) must use real landmark
  regions (`<main>`, `<nav>`, `<header>`) rather than relying on `<dialog>`
  semantics alone once they're full pages.
- Tabbed sub-panels (World detail, Campaign detail, state editor's 4 panels)
  must use the WAI-ARIA Tabs pattern (`role="tablist"`, `role="tab"` with
  `aria-selected`, `role="tabpanel"`) — not currently true ARIA tabs in the
  source evidence gathered (dialogs use custom show/hide, not this pattern).

## Keyboard interaction requirements

- Every action currently reachable only by mouse (carousel navigation,
  card selection, asset-library grid items) must be reachable via Tab/Shift
  +Tab and activatable via Enter/Space.
- The existing `tabindex="0"` usage on custom-interactive elements
  (carousels, prompt-library list, generated turn-history cards) is a
  correct pattern — preserve it, and audit every new custom-interactive
  element for the same treatment.
- Native `<dialog>` (`showModal()`) is the correct base for modals — keep
  using it; native `<dialog>` provides Escape-to-close and basic focus
  containment for free. Do not replace with a custom div-based modal
  without re-implementing that behavior explicitly.
- Story Player's two `role="button"` pill spans with `tabindex="0"`
  (`story.html:74-75`) are a correct minimal pattern — but any new
  non-native interactive element must also handle Enter **and** Space key
  activation explicitly (native `<button>` is strongly preferred over
  `role="button"` spans wherever possible instead of reproducing this
  pattern further).

## Focus-management requirements

- On dialog open, focus moves to the first meaningful control (existing
  pattern: `nexus.js:759` focuses the quick-campaign name field,
  `nexus.js:819` focuses the typed-delete-confirmation input) — preserve
  and extend this to every dialog, including the Story Player dialogs where
  fewer explicit `.focus()` calls were found (5 in `story.js` vs. 17 in
  `nexus.js`).
- On dialog close, focus returns to the element that opened it (verify — not
  confirmed present in current source; treat as a requirement to add).
- Route changes (in the replacement SPA/routed model) move focus to the new
  page's `<h1>` or a dedicated skip target, matching standard SPA
  accessibility practice — the current app has no client-side routing to
  need this, but the replacement will.
- A visible `:focus-visible` ring (`DESIGN_SYSTEM.md` `--focus-ring`) is
  required on every interactive element, at a contrast ratio meeting WCAG
  2.2's non-text contrast requirement (3:1 against adjacent colors) —
  no custom focus-ring styling was found in the current source, meaning the
  browser default is relied on; make it explicit and token-driven instead
  of implicit.

## Form behavior

- Every input has a real, programmatically-associated `<label>` — this is
  the single biggest confirmed gap: `story.html` has 11 `<label>` elements
  against `index.html`'s 143 despite comparable form density
  (`CURRENT_UI_AUDIT.md` UI-002). Every Story Player dialog form (state
  editor's 4 tabs, world setup, user profile) needs a full labeling pass.
- Placeholder text is never a substitute for a label (existing
  `placeholder` usage in `nexus.js` for character fields is fine as
  supplementary hint text, but every one of those fields must also have a
  real label — confirm during implementation, don't assume the current
  placeholder-heavy fields are already labeled).
- Required fields are indicated both visually and programmatically
  (`aria-required` or `required`, plus a non-color visual indicator).

## Error-announcement behavior

- Form validation errors are associated with their field via
  `aria-describedby` and announced via a live region when they appear
  (current pattern: errors surface via `setStatus`/toast, which are
  reasonable for request-level errors but field-level validation errors
  need the tighter `aria-describedby` association too).
- The global error-envelope `issues` array (Zod validation failures,
  `API_UI_CONTRACTS.md`) must be mapped to specific field-level error
  messages wherever the UI has per-field inputs, not just shown as one
  block of text.

## Table and grid behavior

- Cost-summary and provider-list tables use real `<table>` markup with
  `<th scope="col">`/`<th scope="row">` as applicable — not div-grids.
- The asset-library grid (image-library-browser.js) — already noted in its
  own enhancement proposal as intending "Grid thumbnails remain links or
  buttons with useful labels" (`docs/architecture/image-library-enhancement-proposal.md:404-410`)
  — should have that intent verified and enforced in the replacement
  component; the proposal's Phase 1-5 scope is implemented per capabilities.md, but this
  audit did not independently re-verify the accessibility details of that
  specific proposal's claims (flagged for runtime verification).

## Dialog and drawer behavior

- Native `<dialog>` + `showModal()` provides baseline focus containment;
  confirm (at implementation time) that focus cannot escape to
  background content while open — no focus-trap library is used today
  (`REPOSITORY_UI_MAP.md` §8), which is acceptable only if native `<dialog>`
  semantics are relied on consistently and correctly.
- Every dialog has an accessible name (`aria-labelledby` pointing to its
  visible heading) — verify per-dialog at implementation time; not
  confirmed present for all 27 current dialogs from static reading alone.
- Drawers (turn-history, activity-log) get the same focus-management
  treatment as dialogs if implemented as slide-in panels rather than native
  `<dialog>`.

## Content-viewer / narrative-reading behavior

- Story narration text must be selectable, resizable via browser zoom
  (already correct — both HTML documents have proper `width=device-width,
  initial-scale=1` viewport meta tags, `REPOSITORY_UI_MAP.md` §9), and
  readable at 200% zoom without horizontal scrolling or content loss (WCAG
  1.4.10 Reflow) — verify at implementation time against
  `--content-width-narrative`/`--measure-narrative` tokens.
- Illustration images always carry meaningful `alt` text — the existing
  pattern (`story.js:502`, dynamically generated "Illustration N for turn M,
  segment K") is a reasonable baseline; extend to describe content when the
  provider/prompt data allows, not just position.

## Text-comparison / diff behavior

- Any diff/comparison view (draft-vs-published world content, transfer
  preview) must not communicate "added/removed" by color alone — pair with
  `+`/`-` symbols or explicit "added"/"removed" text, consistent with
  `DESIGN_SYSTEM.md` §Status treatment's "never color-only" rule.

## Status, severity, confidence, and review-state communication

- Per `PRODUCT_UX.md`, this product's real status models are job status
  (7–9 values depending on job family) and provider health (4 values) — no
  severity/confidence badges exist. Every status badge pairs color + icon +
  text, and every status change relevant to the current view is announced
  via an ARIA live region (`aria-live="polite"` for routine updates,
  `role="alert"`/`aria-live="assertive"` for `failed` states requiring
  immediate attention).
- Nexus already does this correctly for async content in 3 places
  (`index.html:57,64,71`) — the requirement is to extend the same density
  of live-region usage to Story Player, which currently has fewer (5
  `aria-live` occurrences in `story.html` vs. 23 in `index.html`,
  `REPOSITORY_UI_MAP.md` §8).

## Color and contrast requirements

- All token pairs in `DESIGN_SYSTEM.md` (text/background, status-badge
  text/fill) must meet WCAG 2.2 AA contrast (4.5:1 normal text, 3:1 large
  text/UI components) — verify each pairing once at the token level during
  implementation; the current dark-first palette (`tokens.css`) was not
  contrast-audited as part of this source-only review and should be
  checked with real rendering before sign-off.

## Zoom and reflow requirements

- No horizontal scrolling at 320px CSS width (WCAG 1.4.10) for any screen
  except within a deliberately-scrollable, clearly-bounded container (a
  wide table/data grid) — this directly supersedes the current ad hoc,
  non-shared breakpoint approach (`CURRENT_UI_AUDIT.md` UI-007); the
  `DESIGN_SYSTEM.md` shared breakpoint scale is a prerequisite for meeting
  this reliably.
- Text resizing to 200% via browser zoom must not truncate or clip content.

## Reduced-motion support

- `prefers-reduced-motion: reduce` must be honored globally (currently
  honored in exactly one of four stylesheets, `CURRENT_UI_AUDIT.md`
  UI-011) — implement once at the token/base-style layer per
  `DESIGN_SYSTEM.md` §Motion, not per component.

## Accessible document (campaign/world) navigation

- Breadcrumb and secondary navigation (`PRODUCT_UX.md` §Navigation model)
  use real `<nav aria-label="Breadcrumb">` semantics.
- The "which world version / campaign am I in" context
  (`PRODUCT_UX.md` Principle 5) must be programmatically available (in the
  page `<h1>`/landmark structure), not conveyed by visual placement alone,
  so screen-reader users get the same orientation sighted users do.

## Announcements for long-running progress

- Generation-job staged progress (`PRODUCT_UX.md` §Status model's
  "Reading state → Resolving action → Writing scene → Saving turn" copy)
  is announced via a single, throttled live region — not one announcement
  per SSE frame (which would be disorienting under a screen reader given
  frames arrive as often as every ~350ms per `API_UI_CONTRACTS.md`).
  Announce meaningful stage transitions only.
- Poll-based progress (image jobs, Chronicle jobs) gets the same treatment,
  and — fixing `CURRENT_UI_AUDIT.md` UI-003 — a failed/degraded poll loop
  must itself be announced, not silent.

## Testing requirements

- **No accessibility testing tooling exists today** (no axe-core, no
  Lighthouse CI step, confirmed via `.github/workflows/ci.yml` review in
  `REPOSITORY_UI_MAP.md` §9). The replacement frontend's CI should add
  automated accessibility linting (e.g., axe-core against key screens) as
  part of the same effort that adds real component/DOM testing (see
  `FRONTEND_IMPLEMENTATION_PLAN.md` §Testing) — the current UI-test suite
  cannot catch accessibility regressions any more than it can catch
  rendering ones, since it never renders anything (`CURRENT_UI_AUDIT.md`
  UI-009).
- Manual screen-reader pass (NVDA/VoiceOver at minimum) on the vertical
  slice in `FRONTEND_IMPLEMENTATION_PLAN.md` before wider rollout.
- Keyboard-only pass (no mouse) on every dialog/drawer.

## Screen-specific accessibility risks

| Screen | Risk | Priority |
|---|---|---|
| STORY-PLAYER | Weakest current label coverage (UI-002); highest-traffic player-facing screen | High — fix first |
| NEX-CAMPAIGN-DETAIL (state editor, 4 tabs) | Currently dialog-based tabs, not true ARIA tabs; dense form content | High |
| CHRONICLE-HEALTH | Poll-only progress with no confirmed live-region announcement today | Medium |
| Asset library / image picker | Grid-based selection UI, PhotoSwipe lightbox — verify keyboard/focus behavior at implementation time, not confirmed from source alone | Medium |
| NEX-PROVIDERS | Already comparatively strong labeling — lowest risk, preserve as the reference pattern | Low |
