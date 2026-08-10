# Legacy UI / New Backend Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the legacy Nexus dashboard and Story Player functioning against the new backend until replacement, with no backend production changes unless an executable compatibility test proves one is necessary.

**Architecture:** Freeze the legacy client's actual HTTP dependencies in a test-only route manifest, compare them to the active Fastify server, then repair only reproduced client behavior. Keep Story Player on its typed `NexusApiClient`/generation workflow and its isolated illustration adapter; the only currently justified production change is guarded Escape handling.

**Tech Stack:** Browser JavaScript, TypeScript, Fastify injection/route inspection, Linkedom, Vitest, Vite, pnpm, Docker Compose or the existing disposable host-network smoke instance.

**Implementation status (2026-08-10):** Tasks 1 and 2 are complete. Task 3's automated matrix, build, and HTTP smoke checks are complete with no backend or adapter mismatch found. The disposable browser-only workflow remains a manual follow-up; no commit was requested in this dirty worktree.

## Global Constraints

- Treat the new backend and shared schemas as authoritative; do not restore retired legacy services or browser-owned authority.
- Make no database migration, deployment-topology, or new `/app/` UI change in this plan.
- Do not refactor or reformat the 5,077-line `apps/web/public/nexus.js` or 2,731-line `apps/web/src/story.js` beyond the smallest verified compatibility edits.
- Preserve server-resolved initial-user ownership; never add a caller-supplied `user_id` or identity header.
- Preserve correlation IDs and the typed error envelope.
- Keep Enter/Shift+Enter, Ctrl/Cmd+Enter, Enter/Space activation, and guarded Escape behavior; do not invent new global shortcuts.
- Add or update tests for every changed production file.
- Run `precheck_file(path)` before every edit and preserve the unrelated dirty worktree.
- Do not commit secrets, provider credentials, or private campaign data.

---

### Task 1: Freeze the legacy UI's backend route contract

**Files:**
- Create: `tests/helpers/legacy-ui-route-contracts.ts`
- Modify: `tests/unit/client-api-routes.test.ts`
- Read only: `apps/web/public/nexus.js`
- Read only: `apps/web/public/image-library-browser.js`
- Read only: `apps/web/src/story.js`
- Read only: `apps/web/src/composition.ts`
- Read only: `apps/web/src/legacy-illustration-api.ts`
- Read only: `packages/client-web/src/api-client.ts`
- Read only: `services/api/src/server.ts`
- Read only: `services/api/src/archive-routes.ts`

**Interfaces:**
- Consumes: the existing `client-api-routes.test.ts` server fixture and Fastify `app.hasRoute({ method, url })`.
- Produces: `LegacyUiRouteContract`, `legacyDashboardRouteContracts`, and `legacyStoryRouteContracts`, used only by compatibility tests.

- [x] **Step 1: Define the exact test-only contract type and route groups**

Create `tests/helpers/legacy-ui-route-contracts.ts` with this interface:

```ts
export type LegacyUiHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface LegacyUiRouteContract {
  readonly surface: "dashboard" | "story";
  readonly method: LegacyUiHttpMethod;
  readonly url: string;
  readonly owner: "direct" | "typed-client" | "illustration-adapter" | "asset-url";
}
```

Populate frozen arrays with one entry per legacy call site. Use Fastify's registered parameter spelling, not client expression names. The required groups are:

Every abbreviated path below inherits the `/api/v1` prefix.

```text
Shell/session: GET /api/v1/meta, /session, /dashboard/stats; PATCH /users/me/profile
Prompt library: GET /prompt-library; POST /prompt-library/preview; PUT/DELETE /prompt-library/overrides
Providers: GET/POST /providers; PATCH/DELETE /providers/:providerId; PUT /providers/:providerId/default; GET /providers/:providerId/models; POST /providers/discover-models
Worlds: GET/POST /worlds; GET/PATCH/DELETE /worlds/:worldId; PUT /worlds/:worldId/draft; POST /worlds/generate-preview, /worlds/playable-characters/generate-preview, /worlds/:worldId/publish, /worlds/:worldId/fork; GET /worlds/generate-progress, /worlds/:worldId/export; DELETE /worlds/:worldId/versions/:worldVersionId
World characters/covers: GET /world-versions/:worldVersionId/playable-characters, /worlds/:worldId/cover-job; POST /worlds/:worldId/draft/playable-characters/organize, /worlds/:worldId/cover; PUT /worlds/:worldId/cover-asset
Campaigns: GET/POST /campaigns; PATCH/DELETE /campaigns/:campaignId; GET/PUT /campaigns/:campaignId/character-profile; POST /campaigns/:campaignId/character-profile/organize, /campaigns/:campaignId/migrate-world, /campaigns/:campaignId/transfer-world/preview, /campaigns/:campaignId/transfer-world; GET /campaigns/:campaignId/export, /cost-summary, /sync-status, /turns, /state; PATCH /campaigns/:campaignId/state; POST /campaigns/:campaignId/rewind, /branch, /turn-input/classify
Generation: POST /campaigns/:campaignId/generations, /campaigns/:campaignId/generations/retry-latest; GET /generation-jobs/:jobId, /stream, /result; POST /generation-jobs/:jobId/retry, /discard, /cancel
Chronicle: GET /campaigns/:campaignId/memory/metrics, /context-preview, /embedding-config; PUT /campaigns/:campaignId/memory/embedding-config; POST /campaigns/:campaignId/memory/reindex; GET /jobs/:jobId
Imports: POST /imports/legacy-story/preview, /imports/legacy-story, /imports/world/preview, /imports/world, /imports/infinite-worlds/preview, /imports/infinite-worlds, /imports/campaign-archive/preview, /imports/campaign-archive; GET /imports/progress
Illustrations/assets: GET/PUT /campaigns/:campaignId/illustration-config; GET /campaigns/:campaignId/illustration-segments, /image-jobs, /assets, /assets/:assetId, /image-jobs/:jobId, /turns/:turnId/illustration-resolution; POST /campaigns/:campaignId/illustration-backfill/preview, /illustration-backfill, /image-jobs/:jobId/retry, /turns/:turnId/illustrations, /turns/:turnId/illustration-segments, /turns/:turnId/illustration-match, /illustration-segments/:segmentId/images; PATCH /assets/:assetId/library-metadata
```

When an endpoint appears in both surfaces, retain both entries so the manifest documents both consumers.

- [x] **Step 2: Write the registration compatibility test**

In `tests/unit/client-api-routes.test.ts`, add one test that constructs the server with its existing `config(storageRoot)`, `mockPool()`, and `serverOptions(...)` fixtures, then asserts every manifest entry is registered:

```ts
for (const route of [...legacyDashboardRouteContracts, ...legacyStoryRouteContracts]) {
  expect(
    app.hasRoute({ method: route.method, url: route.url }),
    `${route.surface} ${route.method} ${route.url}`
  ).toBe(true);
}
```

Also assert the manifest has no duplicate `(surface, method, url)` tuples and that each of the four owner values is represented.

- [x] **Step 3: Run the focused test and classify the result**

Run:

```bash
pnpm exec vitest run tests/unit/client-api-routes.test.ts -t "registers every route consumed by the legacy UI"
```

Expected on the reviewed tree: PASS. A failure is evidence of a real route-registration mismatch; do not add an alias yet. First verify the route still has a reachable call site in the current legacy source and record the mismatch in projectmem.

- [x] **Step 4: Run the existing contract baseline**

Run:

```bash
node scripts/check-client-boundaries.mjs
pnpm exec vitest run tests/unit/client-api-routes.test.ts tests/unit/client-boundaries.test.ts tests/unit/story-player-composition.test.ts tests/unit/legacy-illustration-api.test.ts
```

Expected: the boundary checker exits 0 and all tests pass. If they do, Task 1 makes no production change.

- [ ] **Step 5: Review and commit the characterization tests**

Run `git diff --check` and inspect only the two new test files. Then commit them separately:

```bash
git add tests/helpers/legacy-ui-route-contracts.ts tests/unit/client-api-routes.test.ts
git commit -m "test: freeze legacy UI backend routes"
```

### Task 2: Make Story Player Escape respect managed dismissal

**Files:**
- Create: `apps/web/src/story-keyboard.js`
- Create: `tests/unit/story-keyboard.test.ts`
- Modify: `apps/web/src/story.js:2696-2703`
- Modify: `tests/unit/story-player-ui.test.ts`

**Interfaces:**
- Consumes: the existing `requestModalDismissal(dialog)` and `closeNavigationMenus()` functions.
- Produces: `handleStoryEscape(event, options): boolean`, where `options` contains `document`, `requestModalDismissal`, and `closeNavigationMenus`. It returns `true` only when it handles Escape.

- [x] **Step 1: Write dispatched-event tests for the helper contract**

Create a Linkedom document with two open dialogs and a navigation menu. Test these exact cases:

```ts
const dispatchKey = (key: string) => {
  const event = new window.Event("keydown", { bubbles: true });
  Object.defineProperty(event, "key", { value: key });
  document.dispatchEvent(event);
};

document.addEventListener("keydown", (event) => {
  handleStoryEscape(event, options);
});

dispatchKey("Enter");
expect(requestModalDismissal).not.toHaveBeenCalled();

dispatchKey("Escape");
expect(requestModalDismissal).toHaveBeenCalledTimes(1);
expect(requestModalDismissal).toHaveBeenCalledWith(topmostDialog);
expect(closeNavigationMenus).toHaveBeenCalledTimes(1);
```

Add a no-dialog case that proves Escape only closes navigation menus. Do not make the helper call `dialog.close()` directly.

- [x] **Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/unit/story-keyboard.test.ts
```

Expected: FAIL because `apps/web/src/story-keyboard.js` does not exist.

- [x] **Step 3: Implement the minimal helper**

Implement only the Escape policy:

```js
export function handleStoryEscape(event, { document, requestModalDismissal, closeNavigationMenus }) {
  if (event.key !== "Escape") return false;
  const dialogs = [...document.querySelectorAll("dialog[open]")];
  const topmostDialog = dialogs.at(-1);
  if (topmostDialog) requestModalDismissal(topmostDialog);
  closeNavigationMenus();
  return true;
}
```

- [x] **Step 4: Wire the final Story Player key handler through the helper**

Import `handleStoryEscape` into `apps/web/src/story.js`. Replace the final handler that calls `document.querySelectorAll("dialog[open]").forEach(...)` with:

```js
document.addEventListener("keydown", (event) => {
  handleStoryEscape(event, { document, requestModalDismissal, closeNavigationMenus });
});
```

Remove the earlier Escape-only navigation-menu listener in `initializeNavigationMenus()` so one key event has one owner; pointer and click dismissal remain there. Do not alter Enter submission, retry submission, history-card activation, or auto-follow pausing.

- [x] **Step 5: Update the Story Player regression assertion**

In `tests/unit/story-player-ui.test.ts`, assert the Story Player imports and calls `handleStoryEscape`, and assert it no longer contains the direct close-all pattern:

```ts
expect(storyScript).toContain("handleStoryEscape(event, { document, requestModalDismissal, closeNavigationMenus })");
expect(storyScript).not.toContain('document.querySelectorAll("dialog[open]").forEach');
```

- [x] **Step 6: Run the focused UI tests**

Run:

```bash
pnpm exec vitest run tests/unit/story-keyboard.test.ts tests/unit/story-player-ui.test.ts tests/unit/dashboard-ui.test.ts
```

Expected: PASS. Confirm separately that Enter submits, Shift+Enter does not submit, Ctrl/Cmd+Enter retries, Enter/Space activates history cards, and dashboard pseudo-selectors retain Enter/Space activation.

- [ ] **Step 7: Review and commit the keyboard repair**

Run `node --check apps/web/src/story-keyboard.js`, `pnpm check:web`, and `git diff --check`. Review the four-file diff, then commit:

```bash
git add apps/web/src/story-keyboard.js apps/web/src/story.js tests/unit/story-keyboard.test.ts tests/unit/story-player-ui.test.ts
git commit -m "fix: guard legacy Story Player dismissal"
```

### Task 3: Verify the complete compatibility window without widening scope

**Files:**
- Modify only if a reproduced mismatch requires it: `apps/web/public/nexus.js`
- Modify only if a reproduced mismatch requires it: `apps/web/src/composition.ts`
- Modify only if a reproduced mismatch requires it: `apps/web/src/legacy-illustration-api.ts`
- Test alongside any conditional edit: `tests/unit/client-api-routes.test.ts` or `tests/unit/legacy-illustration-api.test.ts`

**Interfaces:**
- Consumes: the Task 1 route manifest and all existing API/application integration suites.
- Produces: a green compatibility gate and a manual smoke record. This task is expected to produce no additional production diff on the reviewed tree.

- [x] **Step 1: Run the relevant API integration matrix**

Run the repository's isolated integration runner for these existing files, using its supported file-selection mechanism:

```text
tests/integration/world-campaign-route-application.integration.test.ts
tests/integration/provider-routes.integration.test.ts
tests/integration/gameplay.integration.test.ts
tests/integration/generation-events.integration.test.ts
tests/integration/illustration-routes.integration.test.ts
tests/integration/world-generation.integration.test.ts
tests/integration/import-memory.integration.test.ts
tests/integration/cyoa-import.integration.test.ts
tests/integration/campaign-archive.integration.test.ts
tests/integration/task-14e3f-production-composed-parity.integration.test.ts
```

Expected: PASS with no skipped compatibility case. Do not replace these real-PostgreSQL tests with route-only mocks.

- [ ] **Step 2: Apply the adapter-first rule only for a reproduced mismatch**

If Task 1 or the integration matrix fails because a reachable legacy call uses the wrong path or response shape:

1. add a failing focused test for that exact method, path, request body, and response/error envelope;
2. make a one-call mapping change in `nexus.js`, `composition.ts`, or `legacy-illustration-api.ts`;
3. rerun the focused test and the owning integration suite; and
4. record the confirmed fix in projectmem.

Do not add a server alias inside this plan. If client translation would change durable semantics, stop and write a separate backend compatibility design with ownership and removal criteria.

- [x] **Step 3: Build both web clients and verify served assets**

Run:

```bash
pnpm build
pnpm exec vitest run tests/unit/web-build-contract.test.ts tests/unit/server-security.test.ts
```

Expected: PASS, with the legacy build containing `index.html`, `nexus.js`, `story.html`, and `legacy-client.js`; `/nexus/` and `/story/:campaignId` remain served by the API.

- [x] **Step 4: Start a disposable new-backend/legacy-UI instance**

Use the documented Compose test topology. If Docker bridge allocation is still exhausted, use the already validated host-network workaround with isolated container names and a disposable database. Do not change Compose manifests to work around a machine-local address-pool limit.

Verify:

```text
GET /health/ready -> 200
GET /nexus/ -> 200 and references /nexus/nexus.js
GET /nexus/nexus.js -> 200 JavaScript
GET /story/11111111-1111-4111-8111-111111111111 -> 200 and references /nexus/legacy-client.js
GET /nexus/legacy-client.js -> 200 JavaScript
GET /api/v1/meta, /session, /dashboard/stats, /worlds, /campaigns -> 200 valid JSON
```

- [ ] **Step 5: Perform the disposable manual compatibility smoke**

In a browser, use only synthetic/disposable records and check:

```text
Dashboard: load stats; navigate all five views; open/close menus with pointer and Escape.
Worlds: create a draft; edit it; publish it; open details; create a campaign.
Campaigns: select/resume the campaign; open configuration; load cost and memory panels.
Story: load /story/:id; submit with Enter; insert a newline with Shift+Enter; use previous/next/undo/retry buttons; submit retry with Ctrl/Cmd+Enter.
Dialogs: change a managed form, press Escape, and confirm the discard guard appears; verify only the topmost overlay is targeted.
Imports: preview World JSON, Legacy Story, Infinite Worlds, and campaign archive fixtures; observe durable progress where applicable; do not commit private data.
Providers: open both custom model selectors with Enter and Space; verify discover/test errors retain a correlation ID.
Illustrations: with images disabled, story remains usable; with a test image provider, load config/jobs and exercise retry without rerunning story generation.
```

Expected: no console exception, no 404/405 request, no response-schema error, no cross-owner data, and no page-owned durable state.

- [x] **Step 6: Run the final repository gate and inspect the complete diff**

Run:

```bash
pnpm test:unit
pnpm check
pnpm build
node scripts/check-client-boundaries.mjs
pjm precheck
git diff --check
git status --short
```

Expected: every command exits 0. Review the complete diff and confirm that production changes are limited to the guarded Story Player Escape path plus any separately justified adapter fix. Record the verification result in projectmem before declaring completion.

- [ ] **Step 7: Commit only an evidence-backed conditional adapter fix**

Skip this step if Task 3 produced no production diff. Otherwise commit the single adapter fix and its focused tests separately:

```bash
git add -p -- apps/web/public/nexus.js apps/web/src/composition.ts apps/web/src/legacy-illustration-api.ts tests/unit/client-api-routes.test.ts tests/unit/legacy-illustration-api.test.ts
git diff --cached --check
git commit -m "fix: preserve legacy UI backend compatibility"
```

Before committing, inspect `git diff --cached --name-only` and unstage anything outside the single reproduced adapter fix and its focused test. Never stage the unrelated dirty worktree.
