# Campaign-Owned Story Context Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: Use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before claiming completion. Execute the tasks in order and do not batch RED tests across later tasks.

**Goal:** Give every campaign a durable Story context-budget target selected from 32K, 64K, 128K, 256K, and 1M; edit it from both active campaign-configuration UIs; and make the server snapshot that campaign value for every newly enqueued append or retry-latest generation.

**Architecture:** Store the setting on `campaigns`, project it through the existing campaign create/list/update/sync contracts, and resolve it inside the locked generation-enqueue transaction. Browser requests remain backward compatible but are not authoritative. Existing generation jobs retain their immutable `context_options`; provider/model window discovery and runtime clamping remain unchanged.

**Tech Stack:** TypeScript, Zod, PostgreSQL migrations and repositories, Vitest unit/integration tests, legacy HTML/CSS/JavaScript, web-next TypeScript/CSS, pnpm, Docker Compose.

**Spec:** [Campaign-Owned Story Context Budget: Planning Handoff](../../review/2026-08-26-campaign-context-budget-planning-handoff.md). The decisions below resolve the open questions and supersede the browser-owned design and implementation plan dated 2026-08-26.

**Global Constraints:** Preserve the current dirty worktree and refactor it in place; never use `git reset`, `git checkout --`, or discard the prototype wholesale. Do not touch the running production Compose project, its containers, images, network, or volumes. Do not edit the root historical `index.html`. Do not couple this setting to Chronicle preview, semantic retrieval, provider discovery, or model-window clamping. Do not add a new API endpoint, archive format version, campaign revision guard, or campaign-creation control unless a failing public-contract test proves one is necessary.

## Resolved Product and Technical Decisions

1. `campaigns.story_context_budget_tokens` is the sole mutable authority.
2. Valid persisted values are exactly `32_000`, `64_000`, `128_000`, `256_000`, and `1_000_000`.
3. Existing and newly created campaigns default to `32_000`.
4. Both Story pages omit the setting entirely. They do not show an editable selector or a competing read-only badge.
5. Browser generation payloads may continue to carry the existing default context object for wire compatibility, but the enqueue repository overwrites `context.budgetTokens` with the locked campaign value.
6. A new retry-latest replacement job uses the campaign value at the time that replacement is enqueued.
7. Retrying an existing failed or recoverable job keeps that job's original `context_options` snapshot.
8. Campaign archives remain format version 3. They add optional `settings.storyContextBudgetTokens`; imports that omit or invalidate it use `32_000`.
9. Branches and cross-world transfers copy the source campaign value.
10. Campaign creation forms do not gain a selector in this change. The default is 32K and can be changed afterward in Campaign Overview / Setup Campaign.
11. The existing `PATCH /api/v1/campaigns/:campaignId` route and its current last-write behavior are sufficient.
12. Changing the setting affects only future generation jobs. It does not mutate accepted turns, current campaign state, Chronicle data, or existing jobs, and it does not enqueue reindexing.

## Agreed Test Seams

These are the public or durable seams that tests may exercise. Do not replace them with tests of private helper calls.

- Zod request/response schemas for create, update, list, create-response, and sync projections.
- PostgreSQL migration constraints and repository create/list/update/sync behavior.
- `generation_jobs.context_options` immediately after append and replacement enqueue.
- Existing generation-job retry behavior at the repository/application boundary.
- Branch, transfer, export, and import operations at their existing application/repository boundaries.
- Rendered campaign-editor DOM plus the request body sent through the existing campaign PATCH API.
- Rendered Story DOM and generation request bodies, proving the browser-local authority has been removed.
- Runtime provider-window clamping through existing generation execution tests; the clamp algorithm itself is not redesigned.

## File Ownership Map

| Concern | Production files | Primary tests |
|---|---|---|
| Shared values and schemas | `packages/contracts/src/story-settings.ts`, `packages/contracts/src/index.ts`, `packages/client-core/src/story-context-budget.ts`, `packages/client-core/src/index.ts` | `tests/unit/client-core/story-context-budget.test.ts`, `tests/unit/world-library.test.ts`, `tests/unit/client-api-contracts.test.ts` |
| Campaign contract and persistence | `packages/contracts/src/world-library.ts`, `packages/contracts/src/client-api.ts`, `packages/application/src/world-campaign/types.ts`, `database/migrations/0081_campaign_story_context_budget.sql`, `packages/database/src/world-repository.ts`, `packages/database/src/campaign-state-repository.ts` | `tests/unit/migration-order.test.ts`, `tests/unit/client-api-routes.test.ts`, `tests/integration/migrations.integration.test.ts`, `tests/integration/world-library.integration.test.ts` |
| Enqueue authority | `packages/database/src/generation-repository.ts` | `tests/integration/generation.integration.test.ts`, `tests/unit/generation.test.ts` |
| Branch and transfer | `packages/database/src/campaign-state-repository.ts`, `packages/database/src/campaign-transfer-character-repository.ts` | `tests/integration/campaign-authority-repository.integration.test.ts`, `tests/integration/campaign-transfer.integration.test.ts`, `tests/integration/campaign-transfer-character-repository.integration.test.ts` |
| Archive and imports | `services/runtime/src/campaign-archive-export-composition.ts`, `packages/database/src/portable-import-family-repository.ts` | `tests/unit/campaign-archive-service.test.ts`, `tests/integration/campaign-archive.integration.test.ts`, `tests/integration/world-library.integration.test.ts` |
| Replacement campaign UI | `apps/web-next/src/campaign-editor-api.ts`, `apps/web-next/src/campaign-editor-page.ts` | `tests/unit/web-next-campaign-editor.test.ts` |
| Legacy campaign UI | `apps/web/public/index.html`, `apps/web/public/nexus.js`, `apps/web/public/nexus.css` only if existing styles are insufficient | `tests/unit/management-ui.test.ts` |
| Story authority removal | `apps/web-next/src/story-player-model.ts`, `story-player-page.ts`, `story-player-view.ts`, `story-player-generation.ts`, `story-player.css`, `apps/web/public/story.html`, `story.css`, `apps/web/src/story.js` | `tests/unit/web-next-story-model.test.ts`, `tests/unit/web-next-story-composer.test.ts`, `tests/unit/web-next-story-generation.test.ts`, `tests/unit/story-player-ui.test.ts` |
| Documentation | `docs/concepts/context-construction.md`, `docs/player-guide/turn-input-modes.md`, old 2026-08-26 spec and plan | Source review and final link/wording checks |

## Task 0: Preserve the Worktree and Record the Starting Baseline

**Files:** No edits.

- [ ] Run `git status --short --branch` and confirm this is the detached `7a24` worktree with the known browser-local prototype changes.
- [ ] Confirm the only untracked feature files are the two 2026-08-26 design/plan documents, the planning handoff, `packages/client-core/src/story-context-budget.ts`, and its unit test.
- [ ] Run the previously green prototype suite before changing tests:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/client-core/story-context-budget.test.ts tests/unit/web-next-story-model.test.ts tests/unit/web-next-story-composer.test.ts tests/unit/web-next-story-generation.test.ts tests/unit/web-next-campaign-editor.test.ts tests/unit/story-player-ui.test.ts tests/unit/client-web/pending-submissions.test.ts tests/unit/generation.test.ts
```

- [ ] Record the result. A failure is a baseline issue to diagnose before starting Task 1; do not fold an unrelated repair into this feature.
- [ ] Do not commit the obsolete browser-owned behavior as a standalone checkpoint.

## Task 1: Establish One Shared Preset Vocabulary and Campaign API Contract

**Files:**

- Modify: `tests/unit/client-core/story-context-budget.test.ts`
- Modify: `tests/unit/world-library.test.ts`
- Modify: `tests/unit/client-api-contracts.test.ts`
- Modify: `packages/contracts/src/story-settings.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/world-library.ts`
- Modify: `packages/contracts/src/client-api.ts`
- Modify: `packages/client-core/src/story-context-budget.ts`
- Modify: `packages/client-core/src/index.ts`

### RED 1A: shared preset validation without browser storage

- [ ] Replace storage-oriented assertions in `tests/unit/client-core/story-context-budget.test.ts` with public behavior assertions that:
  - the five values are in ascending order;
  - labels remain `Standard · 32K`, `Expanded · 64K`, `Large · 128K`, `Very large · 256K`, and `Maximum available · up to 1M`;
  - normalization accepts only those five numeric values;
  - strings, arbitrary in-range integers such as `48_000`, and out-of-range values normalize to `32_000`;
  - client-core no longer exports a storage key or load/save helpers.

```ts
expect(STORY_CONTEXT_BUDGET_PRESETS.map(({ value }) => value)).toEqual([
  32_000,
  64_000,
  128_000,
  256_000,
  1_000_000
]);
expect(normalizeStoryContextBudgetTokens(256_000)).toBe(256_000);
expect(normalizeStoryContextBudgetTokens(48_000)).toBe(32_000);
expect(normalizeStoryContextBudgetTokens("256000")).toBe(32_000);
```

- [ ] Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/client-core/story-context-budget.test.ts
```

- [ ] Confirm RED because the current module still exposes browser storage and does not yet consume a shared contract schema.

### GREEN 1A: shared contract values and client labels

- [ ] Add the following public contract to `packages/contracts/src/story-settings.ts`:

```ts
export const STORY_CONTEXT_BUDGET_TOKEN_VALUES = [
  32_000,
  64_000,
  128_000,
  256_000,
  1_000_000
] as const;

export const DEFAULT_STORY_CONTEXT_BUDGET_TOKENS = 32_000;

export const storyContextBudgetTokensSchema = z.union([
  z.literal(32_000),
  z.literal(64_000),
  z.literal(128_000),
  z.literal(256_000),
  z.literal(1_000_000)
]);

export type StoryContextBudgetTokens = z.infer<typeof storyContextBudgetTokensSchema>;

export function storyContextBudgetTokensFromUnknown(value: unknown): StoryContextBudgetTokens {
  const parsed = storyContextBudgetTokensSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_STORY_CONTEXT_BUDGET_TOKENS;
}
```

- [ ] Export `story-settings.js` from `packages/contracts/src/index.ts`.
- [ ] Refactor `packages/client-core/src/story-context-budget.ts` to import the shared values/type, retain the five user-facing labels, and expose `normalizeStoryContextBudgetTokens` as a thin call to `storyContextBudgetTokensFromUnknown`.
- [ ] Remove `STORY_CONTEXT_BUDGET_STORAGE_KEY`, `StoryContextBudgetStorage`, `loadStoryContextBudgetTokens`, and `saveStoryContextBudgetTokens` from both client-core source files.
- [ ] Re-run the focused unit test and confirm GREEN.

### RED 1B: campaign request and projection schemas

- [ ] Add contract tests proving:
  - `campaignCreateSchema.parse(validCampaignCreateRequest)` defaults `storyContextBudgetTokens` to `32_000`;
  - create and update accept each preset;
  - create/update reject `31_999`, `48_000`, and `1_000_001`;
  - `campaignSummarySchema`, `campaignCreateResponseSchema`, and `campaignSyncStatusSchema` require and retain the field.
- [ ] Update existing campaign-shaped fixtures in `tests/unit/client-api-contracts.test.ts` with `storyContextBudgetTokens: 32_000`; do not make response parsing silently default a missing server field.
- [ ] Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/world-library.test.ts tests/unit/client-api-contracts.test.ts
```

- [ ] Confirm RED because the request and response schemas do not expose the campaign setting yet.

### GREEN 1B: extend existing schemas without a new route

- [ ] Import `DEFAULT_STORY_CONTEXT_BUDGET_TOKENS` and `storyContextBudgetTokensSchema` into `packages/contracts/src/world-library.ts`.
- [ ] Add this field to `campaignCreateSchema`:

```ts
storyContextBudgetTokens: storyContextBudgetTokensSchema.default(DEFAULT_STORY_CONTEXT_BUDGET_TOKENS),
```

- [ ] Add this field to `campaignUpdateSchema`:

```ts
storyContextBudgetTokens: storyContextBudgetTokensSchema.optional(),
```

- [ ] Add required `storyContextBudgetTokens: storyContextBudgetTokensSchema` projections to `campaignSummarySchema`, `campaignCreateResponseSchema`, and `campaignSyncCampaignSchema` in `packages/contracts/src/client-api.ts`.
- [ ] Keep `generationRequestSchema.context.budgetTokens` at its current broad `512..1_000_000` range. This is deliberate wire compatibility; server authority is implemented in Task 3.
- [ ] Re-run both contract tests and confirm GREEN.
- [ ] Run `pnpm --filter @infinite-quest/contracts check` and `pnpm --filter @infinite-quest/client-core check`.
- [ ] Commit only this coherent contract slice:

```powershell
git add packages/contracts/src/story-settings.ts packages/contracts/src/index.ts packages/contracts/src/world-library.ts packages/contracts/src/client-api.ts packages/client-core/src/story-context-budget.ts packages/client-core/src/index.ts tests/unit/client-core/story-context-budget.test.ts tests/unit/world-library.test.ts tests/unit/client-api-contracts.test.ts
git commit -m "Define campaign story context budgets"
```

## Task 2: Persist and Project the Campaign Setting Through Existing APIs

**Files:**

- Create: `database/migrations/0081_campaign_story_context_budget.sql`
- Modify: `tests/unit/migration-order.test.ts`
- Modify: `tests/integration/migrations.integration.test.ts`
- Modify: `tests/integration/world-library.integration.test.ts`
- Modify: `tests/unit/client-api-routes.test.ts`
- Modify: `packages/application/src/world-campaign/types.ts`
- Modify: `packages/database/src/world-repository.ts`
- Modify: `packages/database/src/campaign-state-repository.ts`
- Verify only: `services/api/src/server.ts`

### RED 2A: migration default and database constraint

- [ ] Confirm the migration-order test accepts `0081_campaign_story_context_budget.sql` after the migrations already present on the current base branch.
- [ ] Extend the migration integration test to create a pre-0078 campaign row, apply pending migrations, and assert:

```sql
SELECT story_context_budget_tokens
FROM campaigns
WHERE id = $1;
```

returns `32000`.
- [ ] In the same integration test, prove direct SQL rejects `48000` with PostgreSQL check-constraint SQLSTATE `23514` and accepts all five presets.
- [ ] Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/migration-order.test.ts
.\node_modules\.bin\vitest.cmd run --config vitest.integration.config.ts tests/integration/migrations.integration.test.ts
```

- [ ] Confirm RED because migration 0078 does not exist.

### GREEN 2A: additive migration

- [ ] Create `database/migrations/0081_campaign_story_context_budget.sql` with exactly one additive campaign column and its comment:

```sql
ALTER TABLE campaigns
  ADD COLUMN story_context_budget_tokens integer NOT NULL DEFAULT 32000,
  ADD CONSTRAINT campaigns_story_context_budget_tokens_check
    CHECK (story_context_budget_tokens IN (32000, 64000, 128000, 256000, 1000000));

COMMENT ON COLUMN campaigns.story_context_budget_tokens IS
  'Desired upper Story context target for newly enqueued generation jobs; runtime provider limits still apply.';
```

- [ ] Do not update turns, Chronicle tables, campaign state, or generation jobs in this migration.
- [ ] Re-run both migration tests and confirm GREEN with no skips.

### RED 2B: create, list, update, and sync

- [ ] Extend the existing `persists and exports the authoritative campaign story-length profile` neighborhood in `tests/integration/world-library.integration.test.ts` with a separate context-budget test that:
  - creates a campaign without the field and receives `32_000`;
  - finds `32_000` in `listCampaigns`;
  - updates it to `256_000` with `campaignUpdateSchema`;
  - receives `256_000` from update, list, and campaign sync;
  - snapshots accepted-turn count, campaign-state revision, Chronicle rows, and generation-job rows before the PATCH-equivalent repository update and proves those values do not change.
- [ ] Add or extend `tests/unit/client-api-routes.test.ts` so the existing POST, PATCH, list, and sync response-schema boundaries retain `storyContextBudgetTokens` and PATCH passes the parsed number to the injected application service.
- [ ] Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/client-api-routes.test.ts
.\node_modules\.bin\vitest.cmd run --config vitest.integration.config.ts tests/integration/world-library.integration.test.ts
```

- [ ] Confirm RED because repository projections and inserts do not include the new column.

### GREEN 2B: repository and application projections

- [ ] Add `storyContextBudgetTokens` beside `storyLengthProfile` and `turnControlStyle` in the relevant views/sources in `packages/application/src/world-campaign/types.ts`, including `CampaignUpdateView` and campaign references returned with world aggregates.
- [ ] Update `packages/database/src/world-repository.ts`:
  - create INSERT column/value;
  - create response projection;
  - list SELECT aliases;
  - update SQL `COALESCE` assignment and RETURNING projection;
  - any world aggregate campaign projection that includes Story Engine settings.
- [ ] Use the API-facing alias exactly:

```sql
c.story_context_budget_tokens AS "storyContextBudgetTokens"
```

- [ ] Update `packages/database/src/campaign-state-repository.ts` sync source schemas/types and SELECT projections so sync includes the setting.
- [ ] Inspect `services/api/src/server.ts` and confirm the existing campaign POST/PATCH/list/sync routes already parse and serialize through these shared schemas. Do not create a route or edit the server if the tests pass without it.
- [ ] Re-run the focused unit and integration tests; then run:

```powershell
pnpm --filter @infinite-quest/application check
pnpm check
```

- [ ] Commit the persistence/API slice:

```powershell
git add database/migrations/0081_campaign_story_context_budget.sql packages/application/src/world-campaign/types.ts packages/database/src/world-repository.ts packages/database/src/campaign-state-repository.ts tests/unit/migration-order.test.ts tests/unit/client-api-routes.test.ts tests/integration/migrations.integration.test.ts tests/integration/world-library.integration.test.ts
git commit -m "Persist campaign story context budgets"
```

## Task 3: Make Generation Enqueue Server-Authoritative

**Files:**

- Modify: `tests/integration/generation.integration.test.ts`
- Verify or extend: `tests/unit/generation.test.ts`
- Modify: `packages/database/src/generation-repository.ts`

### RED 3A: append snapshots the locked campaign value

- [ ] Add an integration test beside the story-length snapshot test that:
  1. imports or creates a campaign;
  2. updates `story_context_budget_tokens` to `256000`;
  3. enqueues an append whose client request says `budgetTokens: 16000`;
  4. reads `generation_jobs.context_options` immediately after enqueue;
  5. expects `budgetTokens: 256000`;
  6. updates the campaign to `64000`;
  7. reads the original job again and still expects `256000`.

```ts
const snapshot = await pool.query<{ context_options: Record<string, unknown> }>(
  "SELECT context_options FROM generation_jobs WHERE id = $1",
  [job.id]
);
expect(snapshot.rows[0]?.context_options).toMatchObject({ budgetTokens: 256_000 });
```

- [ ] Run:

```powershell
.\node_modules\.bin\vitest.cmd run --config vitest.integration.config.ts tests/integration/generation.integration.test.ts -t "campaign story context"
```

- [ ] Confirm RED: the current enqueue code copies `request.context.budgetTokens`.

### GREEN 3A: overwrite client input inside the enqueue lock

- [ ] In both append and replacement campaign-lock queries in `packages/database/src/generation-repository.ts`, select and type `story_context_budget_tokens`.
- [ ] Construct append `contextSnapshot` in this order so the campaign value always wins:

```ts
const contextSnapshot = {
  ...request.context,
  budgetTokens: campaign.story_context_budget_tokens,
  storyLengthProfile,
  narrationMinWords: storyLength.minWords,
  narrationMaxWords: storyLength.maxWords
};
```

- [ ] Make the equivalent ordering change in replacement enqueue.
- [ ] Do not mutate `request`, broaden the preset list, or change the generation request schema.
- [ ] Re-run the focused test and confirm GREEN.

### RED 3B: replacement and durable retry semantics

- [ ] Add a second integration test proving a newly enqueued retry-latest replacement uses the campaign's current setting even when the request says `16000`.
- [ ] In that test or a separate focused test:
  - enqueue a job while the campaign is `128000`;
  - force the job into the existing failed/recoverable retry path using the same fixture technique already used by nearby retry tests;
  - update the campaign to `32000`;
  - call the existing retry-by-job-id operation;
  - assert the same job ID still has `context_options.budgetTokens === 128000`.
- [ ] Run the two named tests and confirm the replacement test is RED while the existing-job retry test should already be GREEN. If the retry test fails, diagnose an unrelated snapshot mutation before changing production code.

### GREEN 3B: replacement authority only

- [ ] Apply the same locked campaign overwrite to replacement enqueue; do not change `retry(scope)` because it must reuse the existing row.
- [ ] Re-run the full generation integration file and `tests/unit/generation.test.ts`.
- [ ] Confirm existing runtime clamping tests still demonstrate that provider/model limits cap the requested target. Add only a regression assertion if the current test does not visibly cover `safeContextBudget`; do not change `services/runtime/src/generation-executor-adapter.ts` unless that existing behavior is broken.
- [ ] Commit:

```powershell
git add packages/database/src/generation-repository.ts tests/integration/generation.integration.test.ts tests/unit/generation.test.ts
git commit -m "Enforce campaign context at generation enqueue"
```

## Task 4: Preserve the Setting Across Branch and Cross-World Transfer

**Files:**

- Modify: `tests/integration/campaign-authority-repository.integration.test.ts`
- Modify: `tests/integration/campaign-transfer.integration.test.ts`
- Modify: `tests/integration/campaign-transfer-character-repository.integration.test.ts`
- Modify: `packages/database/src/campaign-state-repository.ts`
- Modify: `packages/database/src/campaign-transfer-character-repository.ts`

### RED 4A: branch preservation

- [ ] Extend the existing owner-scoped branch success test to set the source campaign to `256000`, create a branch, and query both source and branch.
- [ ] Assert the branch equals `256000` and the source remains `256000`; retain the existing owner-isolation and source-immutability assertions.
- [ ] Run:

```powershell
.\node_modules\.bin\vitest.cmd run --config vitest.integration.config.ts tests/integration/campaign-authority-repository.integration.test.ts -t "creates an owner-scoped branch"
```

- [ ] Confirm RED because the branch INSERT currently copies story length and input style but not context budget.

### GREEN 4A: branch copy

- [ ] Add the field to the branch source schema/SELECT and branch campaign INSERT in `packages/database/src/campaign-state-repository.ts`.
- [ ] Copy the locked source value directly; never read a request value.
- [ ] Re-run the named test and then the full branch integration file.

### RED 4B: transfer preservation

- [ ] In `tests/integration/campaign-transfer.integration.test.ts`, add `story_context_budget_tokens = 1_000_000` to the source setup and assert the transferred campaign retains it.
- [ ] In `tests/integration/campaign-transfer-character-repository.integration.test.ts`, extend the repository projection/clone test with the same assertion so both the orchestration and lower repository seam are covered.
- [ ] Run:

```powershell
.\node_modules\.bin\vitest.cmd run --config vitest.integration.config.ts tests/integration/campaign-transfer.integration.test.ts tests/integration/campaign-transfer-character-repository.integration.test.ts
```

- [ ] Confirm RED because the transfer source schema, SELECT, and INSERT omit the column.

### GREEN 4B: transfer copy

- [ ] Add `story_context_budget_tokens` to the Zod source-row schema, source SELECT, destination INSERT columns, and bound values in `packages/database/src/campaign-transfer-character-repository.ts`.
- [ ] Re-run both integration files and confirm GREEN without skipped tests.
- [ ] Commit:

```powershell
git add packages/database/src/campaign-state-repository.ts packages/database/src/campaign-transfer-character-repository.ts tests/integration/campaign-authority-repository.integration.test.ts tests/integration/campaign-transfer.integration.test.ts tests/integration/campaign-transfer-character-repository.integration.test.ts
git commit -m "Preserve context budgets across campaign copies"
```

## Task 5: Round-Trip the Setting Through Archives and Default Older Imports

**Files:**

- Modify: `tests/unit/campaign-archive-service.test.ts`
- Modify: `tests/integration/campaign-archive.integration.test.ts`
- Modify: `tests/integration/world-library.integration.test.ts`
- Modify: `services/runtime/src/campaign-archive-export-composition.ts`
- Modify: `packages/database/src/portable-import-family-repository.ts`

### RED 5A: export field and unchanged archive version

- [ ] Add a unit assertion that a campaign with `story_context_budget_tokens = 256000` exports:

```ts
expect(campaignJson).toMatchObject({
  format: "infinite-quest-campaign",
  formatVersion: 3,
  settings: { storyContextBudgetTokens: 256_000 }
});
```

- [ ] Keep existing redaction assertions proving credentials/provider settings are absent.
- [ ] Run `tests/unit/campaign-archive-service.test.ts` and confirm RED because the portable key is missing.

### GREEN 5A: additive optional export field

- [ ] Add this property beside `storyLength` and `turnControlStyle` in `services/runtime/src/campaign-archive-export-composition.ts`:

```ts
storyContextBudgetTokens: row.story_context_budget_tokens,
```

- [ ] Keep `formatVersion: 3`.
- [ ] Re-run the unit test and confirm GREEN.

### RED 5B: current round-trip and historic default

- [ ] Extend `tests/integration/campaign-archive.integration.test.ts` to export a `1_000_000` campaign, import it, and assert the imported database row is `1_000_000`.
- [ ] Add an older-format compatibility case with `settings.storyContextBudgetTokens` omitted and assert the imported campaign is `32_000`.
- [ ] Extend the existing legacy/portable campaign export-import coverage in `tests/integration/world-library.integration.test.ts` so both campaign INSERT paths in `portable-import-family-repository.ts` are exercised.
- [ ] Add an invalid portable value such as `48_000` and assert safe fallback to `32_000`, not a database constraint failure.
- [ ] Run:

```powershell
.\node_modules\.bin\vitest.cmd run --config vitest.integration.config.ts tests/integration/campaign-archive.integration.test.ts tests/integration/world-library.integration.test.ts
```

- [ ] Confirm RED because both import INSERT paths currently omit the field.

### GREEN 5B: normalize once at each import boundary

- [ ] Import `storyContextBudgetTokensFromUnknown` into `packages/database/src/portable-import-family-repository.ts`.
- [ ] For archive settings use:

```ts
const storyContextBudgetTokens = storyContextBudgetTokensFromUnknown(
  settings.storyContextBudgetTokens
);
```

- [ ] For the legacy campaign path, normalize `legacySettings.storyContextBudgetTokens`. `normalizeLegacyCampaign` already preserves source settings in `campaignSeed.legacySettings`, so `services/runtime/src/portable-import-export-composition.ts` does not need a production change.
- [ ] Add `story_context_budget_tokens` and the normalized value to both campaign INSERT paths near lines 1270 and 1610.
- [ ] Re-run both integration files, then the archive unit test.
- [ ] Commit only files actually changed:

```powershell
git add packages/database/src/portable-import-family-repository.ts services/runtime/src/campaign-archive-export-composition.ts tests/unit/campaign-archive-service.test.ts tests/integration/campaign-archive.integration.test.ts tests/integration/world-library.integration.test.ts
git diff --cached --name-only
git commit -m "Round-trip campaign context budgets"
```

## Task 6: Add the Setting to the Replacement Campaign Overview

**Files:**

- Modify: `tests/unit/web-next-campaign-editor.test.ts`
- Modify: `apps/web-next/src/campaign-editor-api.ts`
- Modify: `apps/web-next/src/campaign-editor-page.ts`

### RED 6A: render, select, and save a numeric preset

- [ ] Replace the current retry-localStorage test with a wire-compatibility test that builds Retry Latest without reading `Storage` and sends the fixed default request context; the server-authority integration tests are responsible for the effective campaign value.
- [ ] Add a rendered overview test that parses `overviewMarkup` and asserts:
  - exactly one select named `storyContextBudgetTokens` exists;
  - its option values are `32000`, `64000`, `128000`, `256000`, `1000000` in order;
  - the campaign's current value is selected;
  - the Chronicle preview input named `budgetTokens` remains separate.
- [ ] Add a submission test using the existing page/API harness and assert the PATCH body carries `storyContextBudgetTokens` as a number, not a string.
- [ ] Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/web-next-campaign-editor.test.ts
```

- [ ] Confirm RED because the overview has no selector and the retry builder still reads browser storage.

### GREEN 6A: replacement campaign configuration

- [ ] Type `CampaignSummary.storyContextBudgetTokens` as `StoryContextBudgetTokens` in `apps/web-next/src/campaign-editor-api.ts`.
- [ ] Import `STORY_CONTEXT_BUDGET_PRESETS`, `DEFAULT_STORY_CONTEXT_BUDGET_TOKENS`, and the type from client-core in `campaign-editor-page.ts`.
- [ ] Add a `Story context` select to the Story Engine section of `overviewMarkup` using the shared labels and numeric option values.
- [ ] In the `overview-form` submit branch, explicitly convert the form value:

```ts
await campaignApi.patch(campaign.id, "", {
  ...v,
  textProviderProfileId: v.textProviderProfileId || null,
  storyContextBudgetTokens: Number(v.storyContextBudgetTokens)
});
```

- [ ] Remove the `Storage` parameter and `loadStoryContextBudgetTokens` call from `buildRetryLatestGenerationRequest`. Keep the current request shape with `budgetTokens: DEFAULT_STORY_CONTEXT_BUDGET_TOKENS`; the repository overwrites it.
- [ ] Do not add a selector to campaign creation.
- [ ] Re-run the unit test, `pnpm --filter @infinite-quest/web-next check`, and `pnpm build:web:next`.
- [ ] Commit:

```powershell
git add apps/web-next/src/campaign-editor-api.ts apps/web-next/src/campaign-editor-page.ts tests/unit/web-next-campaign-editor.test.ts
git commit -m "Configure context budgets in campaign overview"
```

## Task 7: Add the Setting to Legacy Setup Campaign

**Files:**

- Modify: `tests/unit/management-ui.test.ts`
- Modify: `apps/web/public/index.html`
- Modify: `apps/web/public/nexus.js`
- Modify only if needed: `apps/web/public/nexus.css`

### RED 7A: legacy editor parity and persistence

- [ ] Import the shared client-core preset list into `tests/unit/management-ui.test.ts`; the test may compare it with static DOM option values even though the production legacy script cannot import the bundled workspace module.
- [ ] Add DOM/source behavior assertions that:
  - `#campaignStoryContextBudgetTokens` exists inside the selected-campaign Story Engine panel;
  - it has exactly the five shared values in the shared order;
  - there is no `#newCampaignStoryContextBudgetTokens` creation control;
  - `loadSelectedCampaign` assigns the campaign projection with a `32000` fallback;
  - `saveSelectedCampaign` sends `storyContextBudgetTokens: Number(elements.campaignStoryContextBudgetTokens.value)`;
  - the new control participates in the selected-campaign disabled/enabled control lists;
  - `#budgetTokens` under Chronicle remains preview-only and is not reused.
- [ ] Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/management-ui.test.ts
```

- [ ] Confirm RED because the selected-campaign control does not exist.

### GREEN 7A: static legacy options with enforced parity

- [ ] Add this select beside response length in `apps/web/public/index.html`:

```html
<select id="campaignStoryContextBudgetTokens" form="campaignForm" disabled>
  <option value="32000">Standard · 32K</option>
  <option value="64000">Expanded · 64K</option>
  <option value="128000">Large · 128K</option>
  <option value="256000">Very large · 256K</option>
  <option value="1000000">Maximum available · up to 1M</option>
</select>
```

- [ ] Bind it in `apps/web/public/nexus.js`, include it in selected-campaign enable/disable arrays, load with:

```js
elements.campaignStoryContextBudgetTokens.value = String(
  campaign.storyContextBudgetTokens || 32000
);
```

- [ ] Save with:

```js
storyContextBudgetTokens: Number(elements.campaignStoryContextBudgetTokens.value)
```

- [ ] Reuse existing form/select CSS. Change `nexus.css` only if rendered QA shows a real layout defect.
- [ ] Do not touch the root historical `index.html` and do not introduce a legacy bundling refactor.
- [ ] Re-run the management test, `node --check apps/web/public/nexus.js`, and `pnpm build:web:legacy`.
- [ ] Commit only files actually changed:

```powershell
git add apps/web/public/index.html apps/web/public/nexus.js apps/web/public/nexus.css tests/unit/management-ui.test.ts
git diff --cached --name-only
git commit -m "Configure context budgets in legacy campaigns"
```

If `nexus.css` is unchanged, omit it from `git add`.

## Task 8: Remove Browser-Owned Context from Both Story Players

**Files:**

- Modify: `tests/unit/web-next-story-model.test.ts`
- Modify: `tests/unit/web-next-story-composer.test.ts`
- Modify: `tests/unit/web-next-story-generation.test.ts`
- Modify: `tests/unit/story-player-ui.test.ts`
- Modify: `apps/web-next/src/story-player-model.ts`
- Modify: `apps/web-next/src/story-player-page.ts`
- Modify: `apps/web-next/src/story-player-view.ts`
- Modify: `apps/web-next/src/story-player-generation.ts`
- Modify: `apps/web-next/src/story-player.css`
- Modify: `apps/web/public/story.html`
- Modify: `apps/web/public/story.css`
- Modify: `apps/web/src/story.js`

### RED 8A: replacement Story has no setting authority

- [ ] Rewrite the affected web-next tests to assert:
  - `StoryUiState` and intent-confirmation state have no `contextBudgetTokens` member;
  - composer markup has no Story context select;
  - append/replacement submissions do not accept a context-budget argument;
  - classification does not capture or persist a budget while awaiting intent confirmation;
  - the generated wire request still uses `DEFAULT_STORY_CONTEXT_BUDGET_TOKENS` only as a compatibility default.
- [ ] Add a source/public-export assertion that no web-next Story file references the old storage key, `loadStoryContextBudgetTokens`, or `saveStoryContextBudgetTokens`.
- [ ] Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/web-next-story-model.test.ts tests/unit/web-next-story-composer.test.ts tests/unit/web-next-story-generation.test.ts
```

- [ ] Confirm RED because the prototype still owns the value in Story UI state and the composer.

### GREEN 8A: simplify replacement Story

- [ ] Remove `contextBudgetTokens` from `StoryUiState`, intent-confirmation state, initial state, validators, mutations, and storage hydration in `story-player-model.ts`.
- [ ] Remove capture/propagation arguments from `story-player-page.ts` including the Auto-classification continuation.
- [ ] Remove `storyContextBudgetControl` and its insertion from `story-player-view.ts`.
- [ ] Remove `contextBudgetTokens` from `StoryGenerationSubmission` in `story-player-generation.ts`; build the compatibility request with the fixed shared default.
- [ ] Delete only the `.story-context-budget*` CSS rules added by the prototype.
- [ ] Re-run the three focused tests and confirm GREEN.

### RED 8B: legacy Story has no editable or stored setting

- [ ] Replace the legacy test named `shares a stored Story context selection between the legacy composer and retry workflow` with assertions that:
  - neither `#turnStoryContextBudget` nor `#retryStoryContextBudget` exists;
  - no `[data-story-context-budget]` control exists;
  - the Story script does not read or write `infinite-quest.story.context-budget-tokens`;
  - append and Retry Latest still send syntactically valid generation requests using the compatibility default;
  - normal use of `localStorage` for unrelated last-campaign/profile behavior remains intact.
- [ ] Run `tests/unit/story-player-ui.test.ts` and confirm RED.

### GREEN 8B: simplify legacy Story

- [ ] Remove both context select blocks from `apps/web/public/story.html`.
- [ ] Remove only `.turn-context-budget-field` rules from `apps/web/public/story.css`.
- [ ] Remove preset option population, control synchronization, storage access helpers, change listeners, capture, and retry duplication from `apps/web/src/story.js`.
- [ ] Keep a fixed default `context.budgetTokens` in legacy append/retry request bodies until a separate API-contract change removes the field. Do not load campaign config in the Story browser merely to echo it.
- [ ] Re-run all four Story test files, then:

```powershell
pnpm --filter @infinite-quest/web-next check
node --check apps/web/src/story.js
pnpm build:web:legacy
pnpm build:web:next
```

- [ ] Commit the Story cleanup:

```powershell
git add apps/web-next/src/story-player-model.ts apps/web-next/src/story-player-page.ts apps/web-next/src/story-player-view.ts apps/web-next/src/story-player-generation.ts apps/web-next/src/story-player.css apps/web/public/story.html apps/web/public/story.css apps/web/src/story.js tests/unit/web-next-story-model.test.ts tests/unit/web-next-story-composer.test.ts tests/unit/web-next-story-generation.test.ts tests/unit/story-player-ui.test.ts
git commit -m "Remove Story-owned context preferences"
```

## Task 9: Align Documentation and Supersede the Browser-Local Design

**Files:**

- Modify: `docs/concepts/context-construction.md`
- Modify: `docs/player-guide/turn-input-modes.md`
- Modify: `docs/superpowers/specs/2026-08-26-story-context-budget-control-design.md`
- Modify: `docs/superpowers/plans/2026-08-26-story-context-budget-control.md`

- [ ] Add a prominent status line immediately below each old document title:

```md
> **Superseded:** The browser-owned design was replaced by the campaign-owned implementation plan in [2026-08-27-campaign-owned-story-context-budget.md](../plans/2026-08-27-campaign-owned-story-context-budget.md).
```

- [ ] Update `docs/concepts/context-construction.md` to say:
  - the campaign stores a desired upper target;
  - enqueue snapshots it for new jobs;
  - the runtime reserves output/protocol space and clamps to provider/model limits;
  - existing jobs are immutable;
  - Chronicle preview's budget is an ephemeral diagnostic input, not campaign configuration.
- [ ] Update `docs/player-guide/turn-input-modes.md` to direct users to Campaign Overview in the replacement UI and Setup Campaign in legacy Nexus. Remove all browser/localStorage language and all claims that the Story composer owns the choice.
- [ ] Search for stale user-facing language:

```powershell
rg -n "browser-scoped|context-budget-tokens|stored Story context|Story context selection|data-story-context-budget" docs apps packages tests
```

- [ ] Classify every remaining hit. Only superseded historical text, explicit negative regression assertions, and wire-compatibility code may remain.
- [ ] Run `git diff --check`.
- [ ] Commit:

```powershell
git add docs/concepts/context-construction.md docs/player-guide/turn-input-modes.md docs/superpowers/specs/2026-08-26-story-context-budget-control-design.md docs/superpowers/plans/2026-08-26-story-context-budget-control.md docs/superpowers/plans/2026-08-27-campaign-owned-story-context-budget.md docs/review/2026-08-26-campaign-context-budget-planning-handoff.md
git commit -m "Document campaign-owned context budgets"
```

## Task 10: Full Verification, Isolated Docker Review, and Cleanup

**Files:** No feature edits unless verification exposes a defect. Temporary QA files go under ignored `tmp/` and must be removed afterward.

### Automated verification

- [ ] Run the complete focused unit set:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/client-core/story-context-budget.test.ts tests/unit/world-library.test.ts tests/unit/client-api-contracts.test.ts tests/unit/client-api-routes.test.ts tests/unit/migration-order.test.ts tests/unit/generation.test.ts tests/unit/campaign-archive-service.test.ts tests/unit/web-next-campaign-editor.test.ts tests/unit/management-ui.test.ts tests/unit/web-next-story-model.test.ts tests/unit/web-next-story-composer.test.ts tests/unit/web-next-story-generation.test.ts tests/unit/story-player-ui.test.ts
```

- [ ] Run all affected PostgreSQL integration files through the isolated integration config:

```powershell
.\node_modules\.bin\vitest.cmd run --config vitest.integration.config.ts tests/integration/migrations.integration.test.ts tests/integration/world-library.integration.test.ts tests/integration/generation.integration.test.ts tests/integration/campaign-authority-repository.integration.test.ts tests/integration/campaign-transfer.integration.test.ts tests/integration/campaign-transfer-character-repository.integration.test.ts tests/integration/campaign-archive.integration.test.ts
```

- [ ] Confirm none of those files reports skipped tests. A missing `TEST_DATABASE_URL` is not a pass; the repository setup must successfully provision its dedicated test PostgreSQL service.
- [ ] Run repository-wide gates:

```powershell
pnpm test:unit
pnpm check
pnpm build:web:legacy
pnpm build:web:next
git diff --check
```

- [ ] Run `pnpm test:integration` if the focused integration files pass and the full suite fits the execution window. Report focused PostgreSQL proof separately from the full-suite result.

### Create a production-isolated Docker review stack

- [ ] Before starting, perform read-only checks and record the running production container IDs, published `8080` port, network IDs, and volume names. Do not stop, rebuild, rename, or attach to them.
- [ ] Create ignored `tmp/campaign-context-budget-qa.env` with:

```dotenv
APP_PORT=18088
POSTGRES_PASSWORD=context-budget-qa-only-2026-08-27
DATABASE_MAX_CONNECTIONS=8
WORKER_GENERATION_CONCURRENCY=1
```

- [ ] Create ignored `tmp/campaign-context-budget-qa.compose.yaml` with unique names for every mutable Docker resource:

```yaml
name: infinitequest-context-budget-qa

services:
  infinitequest-app:
    image: infinitequest-context-budget-qa:local

volumes:
  infinitequest-postgres:
    name: infinitequest-context-budget-qa-postgres
  infinitequest-assets:
    name: infinitequest-context-budget-qa-assets
  infinitequest-archives:
    name: infinitequest-context-budget-qa-archives
  infinitequest-secrets:
    name: infinitequest-context-budget-qa-secrets

networks:
  infinitequest-backend:
    name: infinitequest-context-budget-qa-backend
```

- [ ] Render and inspect the merged configuration before creating anything:

```powershell
docker-compose.exe --env-file tmp\campaign-context-budget-qa.env -p infinitequest-context-budget-qa -f compose.yaml -f tmp\campaign-context-budget-qa.compose.yaml config
```

- [ ] Confirm the rendered config uses host port `18088`, image `infinitequest-context-budget-qa:local`, the four `infinitequest-context-budget-qa-*` volumes, and network `infinitequest-context-budget-qa-backend`. Abort if it names the production network or production volumes.
- [ ] Build and start only the QA project:

```powershell
docker-compose.exe --env-file tmp\campaign-context-budget-qa.env -p infinitequest-context-budget-qa -f compose.yaml -f tmp\campaign-context-budget-qa.compose.yaml up -d --build
```

- [ ] Wait for `http://127.0.0.1:18088/health/ready` to return HTTP 200. Inspect QA logs by the explicit QA project name if it does not.

### Rendered browser verification of both UI versions

- [ ] Open the URL returned by `campaignEditorPath(campaign.id, "overview")` in replacement Campaign Overview, verify all five labels, select 256K, save, reload, and confirm 256K persists.
- [ ] In legacy Setup Campaign (`/nexus/`), load the same campaign, confirm 256K, change to 128K, save, reload both legacy and replacement views, and confirm both show 128K.
- [ ] Open replacement and legacy Story pages for that campaign and confirm neither has an editable Story context control in the composer or Retry Latest UI.
- [ ] Confirm the legacy Chronicle context-preview budget remains editable, is labeled as preview-only, and changing it does not change campaign configuration.
- [ ] With browser developer tools or captured requests, confirm campaign PATCH sends a numeric preset. Do not infer server authority from the browser payload; the PostgreSQL generation integration tests are the proof that stale/mismatched generation payloads are overwritten.
- [ ] Check console and QA service logs for uncaught errors, schema failures, or failed migrations.

### Cleanup without touching production

- [ ] Stop and remove only the explicitly named QA project and its volumes:

```powershell
docker-compose.exe --env-file tmp\campaign-context-budget-qa.env -p infinitequest-context-budget-qa -f compose.yaml -f tmp\campaign-context-budget-qa.compose.yaml down --volumes --remove-orphans
```

- [ ] Remove only image `infinitequest-context-budget-qa:local` after confirming no QA containers use it.
- [ ] Resolve the absolute paths of the two temporary files and confirm both are inside this worktree's `tmp` directory before deleting them with `Remove-Item -LiteralPath`.
- [ ] Re-run the production read-only checks. Confirm the original production container IDs are unchanged and `http://127.0.0.1:8080/health/ready` is still healthy.
- [ ] Run final review gates:

```powershell
git status --short --branch
git diff --check
git diff --stat
git log --oneline -10
```

- [ ] Review the complete diff against the resolved decisions above. Confirm no root `index.html`, provider discovery, Chronicle indexing, accepted-turn mutation, production Compose resource, or unrelated dirty file entered the change.

## Expected API Impact

This is an additive API contract change, not a new API surface and not a pure UI setting.

- Existing route reused: `PATCH /api/v1/campaigns/:campaignId`.
- Additive request field: `storyContextBudgetTokens` on campaign create/update schemas.
- Additive required response field: campaign list/create/sync projections.
- Backward-compatible generation request: clients may still send `context.budgetTokens`, but it is ignored as authority and overwritten at enqueue.
- Additive archive field: optional `settings.storyContextBudgetTokens` in format version 3.
- Database migration required: one non-null constrained campaign column with a 32K default.

## Estimated Execution Effort

- Contracts, migration, CRUD, and enqueue authority: 2 focused days.
- Branch, transfer, and archive/import propagation: 1.5–2 focused days.
- Both campaign editors and Story cleanup: 1.5–2 focused days.
- Full PostgreSQL, build, Docker, and rendered-browser verification: 1 focused day.

Expected total: **5–7 focused working days**. The lower end assumes existing integration fixtures accept the additive field without broad fixture churn; the upper end covers archive/transfer fixture updates and rendered cross-surface debugging.
