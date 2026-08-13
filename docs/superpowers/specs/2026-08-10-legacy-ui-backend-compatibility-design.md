# Legacy UI / New Backend Compatibility Stabilization Design

## Goal

Keep the current Nexus dashboard and Story Player usable against the new authoritative backend until the replacement UI reaches parity, using the smallest possible production change set.

## Current-state review

The legacy UI is still two distinct surfaces:

- `apps/web/public/nexus.js` is a 5,077-line browser module that calls the `/api/v1` dashboard, world, campaign, provider, prompt, import, export, Chronicle, and illustration routes directly.
- `apps/web/src/story.js` is a 2,731-line Story Player entry composed through `apps/web/src/composition.ts`. Its campaign sync and generation traffic already uses `@infinite-quest/client-web` and the headless generation workflow. Eight illustration calls remain isolated behind the validated `legacy-illustration-api.ts` adapter.

The new server continues to serve `/nexus/`, `/story`, and `/story/:campaignId`. The current route tests cover the typed Story Player contracts, and the production-composed parity tests cover the recently moved import, archive, asset, and illustration route families. A focused baseline on 2026-08-10 passed the client boundary checker and 134 tests across the API routes, client composition, illustration adapter, Story Player UI, and dashboard UI.

No missing backend route or incompatible response contract was reproduced during this review. The prior UI audit's statement that Infinite Worlds import progress is process-local is now stale: migration `0069_import_progress_status.sql` and the current production composition make that progress durable.

One concrete UI defect remains open as projectmem issue #0844. Story Player's final global Escape handler directly closes every open dialog, bypassing `requestModalDismissal()` and its unsaved-change guard. The existing keyboard assertions are mostly source-string checks, so they do not prove dispatched key behavior.

## Approaches considered

### 1. Contract characterization plus targeted client repair — selected

Add an executable inventory of the routes consumed by both legacy surfaces, assert that the current Fastify server registers each method/path pair, and add behavioral keyboard tests. Change production code only for a reproduced failure. This keeps the backend authoritative and limits the likely production patch to Story Player's Escape handling.

### 2. Add a backend legacy-compatibility facade — rejected

A facade could translate historical request and response shapes, but no translation need has been demonstrated. It would widen the server's public surface, duplicate typed contracts, and partially restore authority that the backend migration deliberately removed.

### 3. Refactor the legacy UI before replacement — rejected

Splitting or modernizing `nexus.js` and `story.js` would improve maintainability, but both are high-churn hotspots and scheduled for replacement. A broad refactor would create more regression risk than the compatibility window justifies.

## Design

### Compatibility boundary

The current backend contracts remain the source of truth. The dashboard may retain its direct `api()` calls for the transition window. Story Player must continue using the existing typed composition and illustration adapter; it must not regain a page-owned EventSource, generation polling policy, or raw generation response parser.

An executable, test-only route manifest will list every method and registered Fastify path used by:

- the dashboard's direct calls in `nexus.js`;
- the Story Player's named `NexusApiClient` methods;
- the eight `LegacyIllustrationApi` methods; and
- direct asset URLs rendered by the Story Player.

The manifest test will call `app.hasRoute({ method, url })` on an in-process server. It is a registration and method-compatibility guard, not a replacement for the existing request/response and integration tests.

### Minimal keyboard behavior

The stabilization pass will preserve only documented or already-present behavior:

- Enter submits the turn editor; Shift+Enter inserts a line break.
- Ctrl/Cmd+Enter submits the retry editor.
- Enter/Space activates custom history selectors and dashboard model selectors.
- Escape closes the topmost open overlay through its managed dismissal path and closes navigation menus. It must never close all dialogs in one pass or bypass dirty-form confirmation.
- Native buttons and links keep native Enter/Space activation. No new global shortcuts for previous, next, undo, retry, or carousel movement will be invented during this compatibility pass.

The Story Player Escape logic will be moved to a small pure browser helper so Linkedom tests can dispatch real key events without booting the entire 2,731-line page. Dashboard code changes are not planned unless the behavioral characterization test reproduces a dashboard defect.

### Error handling

The dashboard keeps its correlation-ID-aware error object. The Story Player keeps the typed client's `NexusApiError` and validated illustration schemas. The compatibility pass must not hide validation failures, synthesize caller identity, retry mutations implicitly, or convert an API failure into browser-owned state.

### Stop rules

- If every route manifest entry is registered and the focused contract suites pass, make no backend or database changes.
- If a route is missing, first confirm that the UI actually reaches the call. Prefer a one-call client mapping in `nexus.js`, `composition.ts`, or `legacy-illustration-api.ts` over a new server alias.
- Add a server compatibility route only if the client cannot translate the contract without changing durable semantics. Such a route requires a shared schema, ownership tests, and an explicit removal condition tied to legacy UI retirement.
- Do not repair unrelated accessibility, layout, styling, polling UX, or replacement-UI issues in this pass.

## Verification

Compatibility is accepted when:

1. the complete legacy route manifest matches the active server;
2. dispatched keyboard tests prove the documented keys and guarded Escape behavior;
3. the client boundary checker, focused UI/API tests, relevant route integration suites, `pnpm check`, and `pnpm build` pass;
4. a test deployment serves `/nexus/`, `/story/:campaignId`, `/nexus/nexus.js`, and `/nexus/legacy-client.js`; and
5. a manual smoke on disposable data covers dashboard navigation, world/campaign selection, Story Player load and submit, history controls, retry dialog, imports preview, provider model selectors, and managed dialog dismissal.

No credentials, provider tokens, or private exports may be added to fixtures or logs.
