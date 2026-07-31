# Frontend Implementation Plan — Infinite Quest Nexus

No dates or effort estimates are given — the repository contains nothing
(no velocity history, no story-pointed backlog) to support them, per the
audit template's constraint.

## Recommended frontend architecture

**Component-based SPA with TypeScript, built with Vite, added as a new
pnpm workspace package** (`pnpm-workspace.yaml` already exists —
`apps/web-next` or similar fits the existing monorepo layout without
restructuring). Grounds for this recommendation, all from repository
evidence rather than framework fashion (per the audit's constraint not to
replace working architecture just because something is trendier):

1. **The rest of the codebase is strict TypeScript with Zod-validated
   contracts** (`packages/contracts/src`) — the frontend is the *one*
   untyped surface in an otherwise fully-typed monorepo
   (`docs/development-standards.md`: "`apps/web/public/*.js` is hand-written
   browser JavaScript validated only by `node --check`. It has no type
   checking."). A TypeScript frontend closes this gap and can **import
   `packages/contracts` request/response types directly**, giving
   compile-time guarantees that the frontend matches the API — something
   the current hand-rolled `api()` helpers cannot provide.
2. **Two independent, duplicated API-client implementations exist today**
   (`CURRENT_UI_AUDIT.md` UI-005) precisely because there's no shared
   foundation to import from — a component framework's module system fixes
   this structurally, not by convention.
3. **The product's dominant UI pattern is state-machine-shaped** (job
   status transitions, preview→commit flows) — this maps naturally onto a
   component framework's reactive state model and is painful to keep
   correct in hand-rolled DOM manipulation at the current scale (`nexus.js`
   is independently flagged as the repository's #1 refactor-first hotspot
   by the codebase's own health tooling, `docs/review/2026-07-30-codebase-review.md` §9).
4. **The monorepo's tooling (`pnpm`, `vitest`, `tsc`) already supports this
   choice** — no new package manager, test runner, or type-checker needs to
   be introduced, only a bundler (Vite) and a component library.

**Do not** introduce a server-rendering framework (Next.js/Remix/SvelteKit
with SSR) — this product is entirely behind a single-owner, pre-auth API
with no SEO/content-indexing need (`docs/operations/security.md`), and the
current architecture's simple "static files served by the same Fastify
process" model is a genuine strength worth preserving (no extra deploy
target, no server-rendering complexity). A client-rendered SPA, built and
output as static files into `apps/web/public`-equivalent, keeps the exact
same deployment shape (`Dockerfile:40` already copies a static directory).

**Component library choice** is left open (React, Svelte, Solid, Vue all
fit the constraints above) — pick based on team familiarity; the
architectural requirements (TypeScript, Vite, shared `packages/contracts`
import, static-output deployment) matter more than the specific framework.

## Components and foundations to build first

Before any screen, per `CURRENT_UI_AUDIT.md` UI-005/UI-007/UI-010/UI-011 and
`DESIGN_SYSTEM.md`:

1. **Design tokens** — port `tokens.css`'s color roles as-is (avoid a
   second unnecessary rename cycle), add the new spacing/typography/
   breakpoint/motion token categories from `DESIGN_SYSTEM.md`.
2. **One shared API client** — typed against `packages/contracts`, one
   error shape (adopting the better of the two current patterns,
   `nexus.js`'s correlation-ID-aware error object), one `no-store`/
   `Cache-Control` policy, one retry/backoff policy for poll loops (fixing
   the silent-failure pattern in `CURRENT_UI_AUDIT.md` UI-003).
3. **Job-status state machine component/hook** — one implementation of the
   shared state diagram in `INTERACTION_FLOWS.md`, parameterized per job
   family (generation/image/Chronicle), covering SSE-with-poll-fallback for
   generation and poll-only for the others, with a visible degraded state
   on repeated poll failure.
4. **App shell** — persistent nav, breadcrumb region, user-context area,
   toast/notification system (retiring the separate banner idiom,
   `CURRENT_UI_AUDIT.md` UI-010), active-job indicator.
5. **Dialog/drawer primitives** — built on native `<dialog>` where
   possible (preserving the current app's correct baseline choice,
   `ACCESSIBILITY_SPEC.md`), with the accessible-name and focus-return
   behavior formalized.
6. **Status/health badge components** — job-status and provider-health
   families, per `DESIGN_SYSTEM.md`, built once and reused everywhere
   rather than the current per-page ad hoc treatment.

## Vertical implementation slices

Per the audit template's instruction to prioritize one complete vertical
slice before peripheral screens — adapted to this product's real workflow
(select/create → configure → generate → monitor → review → record a
decision):

### Slice 1 — Core play loop (highest priority; build and validate before anything else)
World creation/selection (minimal) → campaign creation (minimal) → Story
Player: submit a turn → monitor progress (SSE+poll fallback) → view
result → view turn history. This is `INTERACTION_FLOWS.md` Flows 1, 2, 6,
7 and screens NEX-WORLDS (minimal), NEX-CAMPAIGNS (minimal),
STORY-PLAYER. Depends on: foundations above.

### Slice 2 — Recovery and illustration
Recoverable/failed job recovery (Flow 8), retry-latest (Flow 2 variant),
segmented illustration generation/regeneration (Flow 3), asset library
browse. Depends on: Slice 1's job-status state machine.

### Slice 3 — World/campaign management depth
Full NEX-WORLD-DETAIL (draft editing, publish, version history, fork,
ADR 0016 character review — Flow 12), full NEX-CAMPAIGN-DETAIL (config,
state editor, cost summary, migration/transfer — Flow 5), rewind/branch.
Depends on: Slice 1's app shell and dialog primitives.

### Slice 4 — Cross-cutting management
Providers (NEX-PROVIDERS), Prompt Library (NEX-PROMPTS), Chronicle
(CHRONICLE-HEALTH, Flow 4), Dashboard (NEX-DASH), Import/Export
(NEX-IMPORTS, Flows 1/10/11). Depends on: Slice 1–3's shared components;
independent of each other, can be built in any order or parallelized.

### Slice 5 — Polish and hardening
Full accessibility pass (`ACCESSIBILITY_SPEC.md`), full responsive pass
(`PRODUCT_UX.md` §Responsive behavior), SYS-ERROR global unavailable state,
visual-regression baseline.

## API-integration sequence

Matches the slices above — integrate real endpoints slice-by-slice, in the
order listed in `API_UI_CONTRACTS.md` §Screen → endpoint index for each
slice's screens. No endpoint needs to be stubbed for longer than its own
slice, since the backend is stable and complete for every in-scope feature
(`FEATURE_IMPLEMENTATION_MATRIX.md` — almost everything is already
"Implemented and wired" server-side).

## Mock-to-live-data strategy

**There is currently no mock-data mode for this application at all** — no
seed script, no fixture-served frontend mode (`REPOSITORY_UI_MAP.md` §10).
Two consequences for the replacement build:

1. Local development against the real API (via Docker Compose,
   `REPOSITORY_UI_MAP.md` §14) is the only currently-available option — the
   replacement frontend's dev workflow should keep this as the default
   (point Vite dev server at the Compose-hosted API), not invent a
   divorced mock-backend mode that could drift from the real contract.
2. For component-level development/testing in isolation (Storybook or
   equivalent), use `packages/contracts` schemas to generate realistic
   fixture data — this keeps fixtures type-checked against the same
   contracts the real API enforces, rather than hand-maintained mocks that
   silently go stale.

## Testing requirements

Directly addresses `CURRENT_UI_AUDIT.md` UI-009 (current UI tests are
string-matching only, cannot catch rendering/interaction regressions):

- **Component/unit tests**: real rendering tests (e.g., Testing Library for
  the chosen framework) for every component in `DESIGN_SYSTEM.md`'s
  inventory, run under `vitest` (already the project's test runner —
  add a DOM environment, e.g. `happy-dom`, which the current root config
  does not have, `REPOSITORY_UI_MAP.md` §9).
- **Integration tests**: the job-status state machine (SSE + poll
  fallback + retry/discard) is the highest-value target — it's the most
  complex, most safety-critical interaction pattern in the frontend.
- **E2E smoke test**: at minimum, Slice 1's vertical slice end-to-end
  against a real (test) Compose stack — the repository has no E2E tooling
  today (`REPOSITORY_UI_MAP.md` §9); introducing Playwright for this one
  smoke path is a reasonable, scoped addition, not a full E2E rewrite of
  every flow.
- **Contract tests**: since the frontend will import `packages/contracts`
  types directly, a build-time type-check step (`tsc --noEmit` on the new
  frontend package, consistent with `pnpm check`'s existing pattern) is
  itself a meaningful contract-drift guard and should be added to CI
  alongside the existing steps in `.github/workflows/ci.yml`.
- Retire the three string-matching `*-ui.test.ts` files only once their
  real behavior is covered by the new component/integration tests covering
  the same surface — don't delete coverage before its replacement exists.

## Visual-regression strategy

No visual-regression tooling exists today. Introduce it scoped to Slice 1
first (screenshot the core play loop's key states: idle, generating,
recoverable, completed) and expand per-slice as each is built — avoid a
big-bang "screenshot everything" pass that becomes a maintenance burden
before the design system has stabilized.

## Accessibility-verification strategy

Per `ACCESSIBILITY_SPEC.md` §Testing requirements: automated axe-core
checks integrated into the same component tests introduced above (cheapest
point to catch regressions), plus a manual screen-reader + keyboard-only
pass on Slice 1 before starting Slice 2, and again before final cutover.

## Migration approach

**Reuse the exact pattern this codebase already used successfully to
retire its previous legacy client** (ADR 0020): build the new frontend at
a distinct path (e.g., `/app/`) served alongside the current `/nexus/` and
`/story` routes, reaching feature parity slice-by-slice while the old
routes remain the default and fully functional. This avoids inventing a
new migration mechanism (like a feature-flag system, which doesn't exist
anywhere in this codebase today, `REPOSITORY_UI_MAP.md` §11) and instead
reuses a pattern the team has already executed once, successfully, with a
clean server-side redirect and a regression test
(`tests/unit/server-security.test.ts:45`) as the precedent to follow at
final cutover.

Sequence:
1. Ship Slice 1 at `/app/` (or equivalent), not yet linked from the
   current nav — internal/dogfooding use only.
2. Progressively ship Slices 2–5, each individually verified against
   `SCREEN_INVENTORY.md` acceptance criteria.
3. Once parity is reached, link `/app/` from the current nav and/or flip
   the default route, keeping `/nexus/` and `/story` live for a transition
   window (mirrors how the legacy `index.html` was kept temporarily
   reachable-by-reference before full redirect).
4. At cutover, redirect `/nexus/` and `/story` to the new app's
   equivalents (308, matching the existing `/index.html` redirect
   precedent, `services/api/src/server.ts:238-239`), remove the old static
   files from the Docker image copy step (`Dockerfile:40`), and add a
   regression test for the new redirects mirroring
   `tests/unit/server-security.test.ts:45`.
5. Retain the old `apps/web/public/{index.html,nexus.js,story.html,
   story.js,*.css}` files in the repository history/reference only if the
   team wants an explicit "historical reference" allowlist entry
   (`scripts/check-repository-boundaries.mjs`), matching how the previous
   legacy client was handled — or delete them outright once confidence is
   high, since (unlike the previous legacy client) there's no browser-owned
   save data concern this time (all state is server-authoritative).

## Test strategy (summary)

Existing backend integration/unit tests (`tests/integration/*`,
non-UI `tests/unit/*`) are unaffected by this migration and continue to be
the source of truth for backend correctness — this plan only replaces the
frontend and its three string-matching UI test files.

## Cutover criteria

- Every screen in `SCREEN_INVENTORY.md` marked "Retained" or "Replaced"
  has reached its stated acceptance criteria in the new app.
- Every API integration in `API_UI_CONTRACTS.md` is wired and passing its
  contract/integration tests.
- Accessibility manual pass complete with no outstanding High-risk items
  from `ACCESSIBILITY_SPEC.md` §Screen-specific accessibility risks.
- Visual-regression baseline established for all in-scope screens.
- The new app has run in production (or a realistic staging Compose
  deployment) for a defined trial period with no unresolved P0/P1-class
  regressions (using `CURRENT_UI_AUDIT.md`'s priority model as the
  reference severity scale for any new findings during the trial).

## Old-frontend retirement criteria

- Cutover criteria above are met.
- The 308-redirect + regression-test pattern (§Migration approach step 4)
  is in place and passing.
- No open `OPEN_QUESTIONS.md` item blocks removal (in particular Q2, on
  whether the legacy single-image illustration path is still reachable —
  resolve before assuming its replacement-UI equivalent is complete).
- Team sign-off that no dogfooding/rollback need remains — then remove the
  old static files from the Docker image and, optionally, the repository.

## Definition of done

For the overall migration:
- All cutover criteria met.
- All 11 `docs/ui/*.md` documents' acceptance criteria/traceability rows
  are satisfied by the shipped implementation (spot-check against
  `SCREEN_INVENTORY.md`'s traceability table).
- CI includes: type-check of the new frontend package, component/unit
  tests, the one E2E smoke path, and automated accessibility checks —
  all green, alongside the existing backend test suite.
- `docs/ui/OPEN_QUESTIONS.md` items are either resolved or explicitly
  deferred with owner sign-off, not silently dropped.
