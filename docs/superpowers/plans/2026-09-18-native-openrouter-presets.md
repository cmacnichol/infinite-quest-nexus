# Native OpenRouter Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offer native Model/Preset selection through the API and legacy UI, default both selections to Structured Outputs, preserve preset prompts and ordered routing, and execute through durable response contracts.

**Architecture:** Resolve a public typed selection to a private frozen execution plan. Reuse existing schema catalogs, provider transport, prepared request budgeting, generation ledger, and validation. Use reusable editor state/API contracts in the legacy renderer; defer all new UI implementation.

**Tech Stack:** TypeScript, Zod, PostgreSQL/node-pg-migrate, existing vanilla DOM clients, Vitest, Playwright, Node >=22.13.0 and repository-pinned pnpm via Corepack.

**Spec:** [Evaluation and design](2026-09-18-native-openrouter-presets-design.md). Read it before implementation; it defines policy and boundary decisions.

## Global Constraints

- Current scope is API, runtime, persistence, and legacy UI. Do not modify web-next pages, navigation, campaign/player labels, or add new UI feature tests. Existing new UI compatibility checks may run against shared API changes.

- Keep OpenRouter as the preset configuration source.
- Only explicit save changes the profile.
- Both Model and Preset default to Structured Outputs in the legacy UI and API. New direct-model work defaults to Required; retain explicit historical compatibility overrides and frozen v1 jobs. Direct models retain existing capability/verification checks. Presets trust Structured Outputs by default; standard-JSON fallback is deferred. Keep the schema on every preset attempt.
- Image and embedding profiles retain their existing controls.
- No paid probe runs automatically.
- Preserve existing v1 jobs and concrete-model profiles; new snapshot contracts are versioned.
- No code implementation is authorized by this planning artifact alone. Execute in an isolated `codex/` worktree when requested.

## Review Focus

1. A delayed preset response after credential/profile switching must not overwrite the new editor (tasks 2, 6, 7).
2. A valid preset containing a standard prompt must preserve it exactly once, including in budgets and auxiliary operations (tasks 3, 5, 8).
3. Both selections must default to schema mode, including omitted-policy API requests and mode switches. Model selection must retain capability verification; preset selection must bypass that gate and never silently downgrade to standard JSON (tasks 4, 5, 7).
4. Preset edits/deletion after enqueue or during an idempotent resubmission must not alter a saved job (tasks 3, 5, 8).
5. An existing alias, archived selection, or unavailable discovery must remain visible without automatic model substitution (tasks 1, 6, 7).

## Delivery sequence and review boundaries

Separate commits/patches: 1 contracts/persistence; 2 discovery; 3 resolution/prompt snapshots; 4 model verification/preset trust; 5 transport/durability; 6 reusable editor; 7 legacy UI; 8 integration/rollout. New UI work is preserved in the [deferred plan](2026-09-18-native-openrouter-presets-new-ui-deferred.md) and is not a dependency or acceptance gate for this release. Keep runtime feature admission disabled until task 5 passes; expose selectors only when the API advertises native preset execution support. Each patch has its own RED/GREEN and review gate. Fresh Terra implementation agents are suitable if the user retains the previously requested Terra execution approach; do not dispatch implementation agents during planning.

Paths listed as Create are proposed new files. Existing test suites listed under Modify must be reviewed even if their assertions remain valid. Resolve package exports using each package's current `src/index.ts` and `package.json`; do not reach across forbidden package boundaries.

## Task 1: Typed selection, persistence, and compatibility

**Files:**
- Create `packages/contracts/src/provider-selection.ts`, `tests/unit/provider-selection.test.ts`.
- Modify `packages/contracts/src/generation.ts`, `packages/application/src/providers/{types,ports,use-cases}.ts`, `packages/database/src/provider-repository.ts`, `services/api/src/provider-application-adapter.ts`.
- Add the next available numbered migration with suffix `_provider_text_selection.sql`; determine the number from current main at execution, not PR #132's occupied numbers.
- Modify `tests/unit/provider-postgres-adapters.test.ts`, `tests/unit/provider-api-adapter.test.ts`, `tests/integration/provider-postgres-adapters.integration.test.ts` and applicable archive provider serialization/validation suites.

**Interfaces:**
```ts
export type TextModelSelection =
  | Readonly<{ kind: "model"; modelId: string }>
  | Readonly<{ kind: "openrouter_preset"; slug: string }>;
export function normalizeTextSelection(input: {
  providerType: string; providerRole: string;
  defaultModel: string; textSelection?: TextModelSelection;
}): TextModelSelection;
export function selectionCompatibilityId(selection: TextModelSelection): string;
```

- [ ] Write a failing regression for exact legacy alias normalization and rejection on an embedding profile:
```ts
expect(normalizeTextSelection({ providerType: "openrouter", providerRole: "text",
  defaultModel: "@preset/nexus-nsfw" })).toEqual({ kind: "openrouter_preset", slug: "nexus-nsfw" });
expect(() => normalizeTextSelection({ providerType: "openrouter", providerRole: "embedding",
  defaultModel: "@preset/nexus-nsfw" })).toThrow();
```
- [ ] Add contract cases for plain/empty model, contradictory fields, invalid slug, old-client PATCH, omitted PATCH, and unsupported combined model/preset syntax. Preserve invalid legacy values for display with a diagnostic; do not rewrite them on read.
- [ ] Run `corepack pnpm exec vitest run tests/unit/provider-selection.test.ts tests/unit/provider-api-adapter.test.ts` and record the intended RED assertion.
- [ ] Implement Zod discriminators, create/update/view projection, `text_selection` persistence, derived `default_model`, and role/type checks. SQL shape constraints must permit existing null rows; perform no remote lookup in a migration.
- [ ] Add API/persistence tests for new profile with omitted policy => Required, old-client defaultModel selection change => Required, no-policy historical profile => Required for new work, explicit saved Legacy/Auto retention, and rename-only PATCH preserving the explicit policy. Use the default/compatibility matrix in the design; do not change already queued jobs.
- [ ] Add PostgreSQL tests for create/reopen/update, cross-owner denial, old-client writes, null historical rows, and archive round-trip without credential/cache export. Verify text-to-embedding fallback cannot use a preset.
- [ ] Run focused unit and `corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/provider-postgres-adapters.integration.test.ts`; report real DB cases separately from skipped cases. Review diff and commit `Add typed text model selections`.

## Task 2: Server-side preset discovery and detail API

**Files:**
- Create `packages/contracts/src/provider-presets.ts`, `packages/story-engine/src/openrouter-presets.ts`, `tests/unit/openrouter-presets.test.ts`.
- Modify `packages/application/src/providers/{types,ports,use-cases}.ts`, `services/runtime/src/provider-application-composition.ts`, `services/runtime/src/provider-credential-transport-adapter.ts`, `services/api/src/provider-application-adapter.ts`, `services/api/src/server.ts`.
- Modify `tests/unit/provider-ownership-inventory.test.ts`, `tests/unit/provider-transport-security.test.ts`, `tests/integration/provider-routes.integration.test.ts`.

**Interfaces:**
```ts
type PresetSummary = Readonly<{ slug: string; name: string; status: string;
  designatedVersionId: string; updatedAt: string }>;
type PresetPage = Readonly<{ presets: readonly PresetSummary[]; totalCount: number;
  offset: number; nextOffset: number | null }>;
// Private, validated result; only settings detail projects the prompt to its owner.
type ResolvedPreset = Readonly<{ slug: string; name: string; versionId: string;
  version: number; systemPrompt: string; config: Readonly<Record<string, unknown>>;
  configHash: string }>;
```
Application ports: `listPresets(request)` and `getPreset(request)` receive owner-scoped profile identity or an unsaved candidate through the same credential boundary as current model discovery. Return `PresetPage`/`ResolvedPreset`. Never pass keys in public types.

API additions: GET `/api/v1/providers/:providerId/presets?offset=0&limit=50`; GET `/api/v1/providers/:providerId/presets/:slug`; POST `/api/v1/providers/discover-presets` and `/api/v1/providers/resolve-preset` for unsaved candidates. Candidate request bodies use the current write-only credential handling; no implicit profile creation. Add typed public schemas and finite diagnostics: authentication, discovery_unavailable, preset_missing, preset_inactive, preset_config_unsupported, invalid_response.

- [ ] Write fake-transport tests for multiple pages, standard prompt retention, malformed totals/versions, inactive details, unsupported fields, and credential omission from returned errors. Use two pages and assert `nextOffset` rather than assuming all presets fit one page.
- [ ] Run `corepack pnpm exec vitest run tests/unit/openrouter-presets.test.ts` for RED.
- [ ] Implement bounded GET parsing, URL encoding, fixed resource paths, existing network policy, cancellation, 60-second identity-scoped summary cache, and fresh detail mode. Cap response at 1 MiB, config depth at 16, models at 32, provider arrays at 64, and prompt at 200,000 characters; reject over-limit values with finite diagnostics.
- [ ] Route saved and candidate requests through owner resolution and existing transport. Test one owner's credential cannot fetch another owner's profile and same-name presets do not leak across credentials. Cache invalidation must defeat older in-flight responses.
- [ ] Run discovery/security units and provider route DB integrations. Review diff and commit `Discover OpenRouter presets through provider APIs`.

## Task 3: Resolve and freeze preset prompts, limits, and configuration

**Files:**
- Create `packages/application/src/providers/text-execution-plan.ts`, `packages/story-engine/src/preset-prompt.ts`, `services/runtime/src/provider-preset-resolution.ts`, `tests/unit/provider-preset-resolution.test.ts`, `tests/unit/preset-prompt.test.ts`.
- Modify profile execution bindings in `services/runtime/src/provider-credential-transport-adapter.ts`, queue preparation in `packages/database/src/generation-repository.ts` and its runtime composition, and `packages/contracts/src/generation-response-contract.ts`.
- Review `services/runtime/src/provider-{world-generation,character-organization,turn-intent}-adapter.ts`, `infinite-worlds-provider-collaborators.ts`, text-assisted illustration adapters and direct provider text execution.

**Interfaces:**
```ts
type TextRouteCandidate = Readonly<{ modelId: string;
  providerPolicy: Readonly<Record<string, unknown>>; contextWindowTokens: number;
  maxOutputTokens: number }>;
type TextExecutionPlan = Readonly<{ version: 2; selection: TextModelSelection;
  preset: null | Readonly<{ slug: string; versionId: string; configHash: string }>;
  candidates: readonly TextRouteCandidate[]; presetSystemPrompt: string;
  parameters: Readonly<Record<string, unknown>>; planHash: string }>;
export function composePresetPrompt(input: { presetPrompt: string; operationPrompt: string }): string;
```
`resolveTextExecutionPlan` receives owner/profile revision, selection, explicit overrides, and injected preset/model discovery ports; returns `TextExecutionPlan`. Full runtime validation schemas accompany these types. Keep prompt text private; use a separate public selection summary.

- [ ] RED prompt test:
```ts
const prompt = composePresetPrompt({ presetPrompt: "Use spare prose.", operationPrompt: "Return the required Story JSON." });
expect(prompt.match(/Use spare prose\./g)).toHaveLength(1);
expect(prompt).toContain("Return the required Story JSON.");
```
- [ ] Add tests for field precedence, version/hash changes, output/context minima, unsupported tools/stop/transforms, missing model limits, preset prompt contribution to input size, and parameter inheritance versus overrides. Unknown context limits require an explicit conservative user cap; they do not become invented provider capacity.
- [ ] Run `corepack pnpm exec vitest run tests/unit/provider-preset-resolution.test.ts tests/unit/preset-prompt.test.ts` for RED; implement pure normalization/allowlists and explicit prompt framing. Export types from the correct shared package for runtime consumers.
- [ ] Add pre-enqueue resolution outside DB locks, profile revision recheck, and an early idempotency lookup. Store the resolved plan atomically with queue/prompt snapshots. Create an additive versioned private snapshot column if existing snapshot storage cannot safely hold it; use the next free migration number. Do not mutate already queued v1 jobs.
- [ ] Route all shared text consumers through the resolver. Define per-request selection overrides as replacing the inherited selection; image/embedding execution never gets this descriptor. Persist the resolved descriptor for durable authoring work before its first inference.
- [ ] Run resolver, prompt-budget, provider-consumer and queue tests; commit `Freeze preset configuration for text execution`.

## Task 4: Preserve model verification and add trusted preset admission

**Files:**
- Modify `packages/contracts/src/{text-response-format,provider-capability-identity,generation-response-contract}.ts`, `packages/application/src/providers/response-format.ts`, `services/runtime/src/{generation-response-contract,generation-worker-composition}.ts`.
- Create `tests/unit/preset-response-format.test.ts`; review existing response-format, preflight, schema-verification, cache and operation-matrix tests.

**Interfaces:** Add a versioned response contract admission discriminator `model_verified | preset_trusted`. Keep the existing direct-model eligibility resolver. Introduce `normalizeNewTextResponsePolicy` at the new-work boundary: omitted direct-model policy => `required`; explicit compatibility choice => that policy; preset admission => schema regardless of model policy. Preserve historical low-level readers. Add `presetResponseAdmission(selection)` for native preset selection, returning `{ mode: "json_schema", basis: "preset_trusted" }` without advertisement or verification inputs. The operation contract builder consumes that admission and the complete invocation closure. Persist the basis in the frozen contract and project it safely to the UI; do not represent trusted presets as verified operator records.

- [ ] RED tests for preset selection with absent alias inventory, absent concrete-model metadata, negative advertised support and no verification records. All must request schema mode without locally filtering configured routes:
```ts
expect(presetResponseAdmission({ kind: "openrouter_preset", slug: "nexus-nsfw" }))
  .toEqual({ mode: "json_schema", basis: "preset_trusted" });
```
- [ ] Add composed resolver tests proving preset admission never calls the model capability gate, covers story stream/nonstream, choices and continuity review, and carries complete schemas/open tracker shapes. A previous model Legacy/Auto policy must not cause a new native preset job to request standard JSON.
- [ ] Add default-policy RED tests for omitted direct-model policy producing Required, verified default model producing json_schema, unknown/unsupported default model blocking before inference, and both legacy UI modes defaulting to schemas. Confirm no new default path silently selects json_object.
- [ ] Retain direct-model tests for missing/unsupported advertisements, expired/mismatched verification, schema/operation/streaming mismatches and required preflight failure. Assert direct model selection still follows the existing resolver even when the same profile previously used a preset.
- [ ] Run `corepack pnpm exec vitest run tests/unit/preset-response-format.test.ts tests/unit/provider-response-format.test.ts tests/unit/generation-response-contract-preflight.test.ts` for RED.
- [ ] Implement selection-discriminated admission and versioned projections. Build preset contracts directly from the schema catalog, preserve configured routing, and bypass verification registry availability/digest gates only for preset-trusted v2 contracts. Preserve schema hashes, plan identity, budget, credential/endpoint checks and application output validation. Keep existing v1 parsing/behavior.
- [ ] Add rejection tests: unsupported-schema/provider response ends the request without `json_object` retry or schema stripping. Auto downgrade is not a native preset path. Runtime errors remain visible and must not be relabeled as verified support.
- [ ] Run GREEN and commit `Trust preset schemas while retaining model verification`.

## Task 5: Ordered dispatch, provider policy, and durable attempts

**Files:**
- Create `packages/story-engine/src/preset-route-execution.ts`, `tests/unit/preset-route-execution.test.ts`.
- Modify `packages/story-engine/src/{provider-request,providers,provider-response-format}.ts`, `services/runtime/src/{generation-executor-adapter,generation-worker-composition,generation-response-contract}.ts`, `packages/database/src/generation-execution-repository.ts` and versioned invocation contracts.
- Modify `tests/unit/provider-response-contract-transport.test.ts`, `tests/unit/provider-request-budget.test.ts`; create `tests/integration/preset-generation-workflow.integration.test.ts`.

**Interfaces:** `executePresetRoutes(plan, invoke, signal)` invokes each candidate with a prepared body and candidate-specific policy; returns actual serving identity plus a bounded physical-attempt record. Existing logical invocation reservation remains authoritative. Add physical attempt IDs beneath it, not replacement generation jobs.

- [ ] Write RED tests for first-route success, rate-limit advance before output, exhausted routes, cancellation, total deadline, schema error terminal, refusal terminal, and no switch after any emitted content.
```ts
expect(shouldAdvancePresetRoute({ reason: "rate_limit", emittedOutput: false })).toBe(true);
expect(shouldAdvancePresetRoute({ reason: "schema_invalid", emittedOutput: false })).toBe(false);
expect(shouldAdvancePresetRoute({ reason: "rate_limit", emittedOutput: true })).toBe(false);
```
Define `shouldAdvancePresetRoute` in the new module with a closed reason union and a terminal default; test Retry-After seconds/date conversion if delays are honored.
- [ ] Run route/transport tests for RED. Implement one concrete model per candidate initially, preserving preset provider `order`, `only`, `ignore`, allowed fallback policy, and `require_parameters=true` in schema mode. Do not filter preset routes using local capability verification or append routes outside the configured policy. Reject conflicting sort/order policy rather than quietly reversing priority.
- [ ] Compose prompt and parameters before canonical serialization; budget the exact body for every physical attempt. Never send the preset alias alongside the already injected prompt. Preserve application recovery temperature overrides and operation schemas.
- [ ] Persist reserved/dispatched/completed physical attempts before/after transport. A crash after dispatch without a result requires existing recovery handling, not blind fallback. Verify actual response identity against admissible candidates when identity is available; missing identity stays unknown rather than fabricated.
- [ ] Split v2 dispatch checks into frozen execution identity and current credential/endpoint authority. The current v1 profile-configuration equality check must not make a queued v2 job adopt or reject a newly edited selection merely because its preset/profile settings changed. Continue blocking revoked profiles, changed endpoint authority, or invalid credential leases; preserve v1 semantics for v1 jobs.
- [ ] Attribute reported usage/cost to each physical attempt and aggregate once into the logical invocation/job. Preserve requested preset provenance separately from returned concrete model identity. Never manufacture successful usage for attempts with absent provider accounting.
- [ ] DB tests must cover successful fallback and single commit, changed preset after enqueue, interrupted response, no fallback after partial output, and no campaign/Chronicle writes on preflight rejection. Resume from frozen plan even if remote preset lookup is unavailable.
- [ ] Run route/budget units and `corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/preset-generation-workflow.integration.test.ts`; commit `Execute frozen preset routes with durable attempts`.

## Task 6: Shared editor state, API client, and safe status projection

**Files:**
- Create `packages/client-core/src/providers/selection-editor.ts`, `packages/client-web/src/provider-presets-api.ts`, `tests/unit/provider-selection-editor.test.ts`, `tests/unit/provider-presets-api.test.ts`.
- Modify public capability/selection projections and `packages/contracts/src/generation-response-format-projection.ts`; expose the exports needed by the legacy client using its existing build entrypoints; keep the interfaces reusable without wiring the new UI.

**Interfaces:** `reduceSelectionEditor(state, event)` is pure; state contains mode, independent model/preset drafts, request identity, list page, detail status and finite error, never credentials. `createProviderPresetsApi(apiClient)` exposes saved-profile and candidate list/detail methods with AbortSignal. Renderers supply credentials to the existing write-only API boundary, not reducer persistence.

- [ ] RED state test:
```ts
const newer = reduceSelectionEditor(initialState, { type: "requestStarted", requestId: "new", mode: "preset" });
expect(reduceSelectionEditor(newer, { type: "listLoaded", requestId: "old", page: emptyPage })).toEqual(newer);
```
Define `initialState` and `emptyPage` locally from exported schemas. Add tests for model/preset draft retention, pagination deduplication by slug, unavailable saved choice, error preserving edits, and credential changes invalidating evidence.
- [ ] Run both new suites for RED; implement state transitions and typed API schema validation. Project preset name/version, configured candidates, exclusions, selected format, actual served model/provider, and missing-identity status without private prompt/raw errors.
- [ ] Verify native-preset feature support is discoverable from API; old API clients and older servers produce an explicit unsupported UI state. Run GREEN; commit `Share native preset selection state and APIs`.

## Task 7: Legacy provider editor and player integration

**Files:**
- Modify `apps/web/public/{index.html,nexus.js,nexus.css}`, `apps/web/src/story.js`, legacy client build entrypoints as needed.
- Modify `tests/unit/{management-ui,legacy-provider-modal}.test.ts`; create `tests/e2e/legacy-provider-presets.e2e.test.ts`.

**Interfaces:** Use task 6 reducer/API through the existing legacy bundle mechanism; do not import raw TypeScript from public HTML. Save task 1 `textSelection` and explicit overrides. Keep current nontext profile behavior.

- [ ] Add RED DOM tests for first-time profile creation, Model/Preset mode switch, preset detail with prompt/provider order, selection save/reopen, inherited/override values and stale discovery response. Pin actual save payload, not source-string presence.
- [ ] Implement the controls and read-only detail panel. Default preset settings to inheritance, display effective context/output limits, verified-model versus trusted-preset status, loading/empty/error states and explicit Refresh. Preserve custom model IDs in Model mode.
- [ ] In preset mode show **Structured Outputs · Trusted preset**; hide model-only format policy controls without losing explicit same-model compatibility drafts. Verify a new Model selection defaults to Required and capability checking; revisiting an explicitly overridden model draft remains visibly nondefault. Show provider schema failures without a standard-JSON retry option in this phase.
- [ ] Update legacy profile summaries and any per-request model override to preserve profile preset selection. Label served model separately in Story diagnostics. Do not edit repository-root historical `index.html`.
- [ ] Add legacy browser assertions for fresh Model => Structured Outputs on, fresh Preset => Trusted preset schemas, Model/Preset/Model switching, verified versus unknown model generation, save/reopen defaults, and explicit compatibility labeling. Assert the outgoing generation payload/contract uses json_schema for both successful default paths.
- [ ] Browser scenario:
```ts
await page.goto("/nexus/#providers");
await page.getByRole("radio", { name: "Preset", exact: true }).check();
await page.getByRole("combobox", { name: "Preset", exact: true }).selectOption("nexus-nsfw");
await expect(page.getByText("Standard prompt", { exact: true })).toBeVisible();
```
Use fixture APIs and a saved-profile/open-editor helper consistent with existing settings tests before checking controls. Assert submitted `textSelection`, reopen persistence, and no request to OpenRouter from the browser.
- [ ] Run DOM suites and `corepack pnpm exec playwright test tests/e2e/legacy-provider-presets.e2e.test.ts`; capture desktop/mobile screenshots and keyboard behavior. Commit `Add preset selection to legacy provider settings`.

## Task 8: Composed verification, documentation, and rollout

**Files:**
- Extend `tests/integration/preset-generation-workflow.integration.test.ts`, existing generation-response-contract operation/workflow/failure tests, authoring/provider integration suites and archive integration suites.
- Modify `scripts/probe-structured-output.ts`, `tests/unit/probe-structured-output.test.ts`, and operational structured-output docs under `docs/review/structured-output/`.
- Add `docs/review/native-openrouter-presets/verification.md` and `rollout.md`; document API/UI behavior and update relevant provider documentation discovered during implementation.

- [ ] Add composed PostgreSQL scenarios for append/replacement, Action/Story Direction, stream/nonstream, choice repair, continuity review/repair, explicit Keep with no new inference, and two campaigns with no context crossover. Combine preset edit, worker restart, and idempotent resubmission in a test proving the original plan remains authoritative.
- [ ] Add regression for prompt-bearing preset through world/character authoring and intent; image/embedding providers receive no preset prompt, policy, or credentials. Verify portable selection restores as unresolved until destination metadata validation succeeds.
- [ ] Extend the offline probe planner to resolve preset metadata into explicit model/provider/schema cases and print a priced plan. Default remains no inference. Live authorization is per priced probe; report candidate-level results, never infer that every preset route passed from one model's success.
- [ ] Run:
```text
corepack pnpm check
corepack pnpm build
corepack pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm test:integration
corepack pnpm exec playwright test tests/e2e/legacy-provider-presets.e2e.test.ts tests/e2e/structured-output-settings.e2e.test.ts
git diff --check
```
- [ ] Record source commit, environment, exact commands, passed/failed/skipped totals, screenshots, fake-provider coverage and separately approved live results. Unit/browser fixtures do not establish live support. Fix failures within scope before release.
- [ ] Roll out backend/contracts first with UI admission disabled, then enable native preset selection after DB/transport gates. Default new direct-model work to Required at UI/API/queue boundaries while preserving explicit historical Legacy/Auto overrides and frozen v1 jobs; native preset v2 jobs always request schema mode with preset_trusted admission. Do not use an old model policy to downgrade a preset. Prevent downlevel workers claiming v2 jobs; deployment must upgrade all workers before enabling v2 enqueue. Rollback disables new preset enqueue and drains or explicitly pauses v2 jobs; never make an old worker reinterpret them as aliases.
- [ ] Review complete diff, compatibility, migration sequence and documentation links. Commit `Verify and document native preset workflows`. Publishing or updating PR #132 is a separate user-authorized action.

## Completion evidence and plan review

The task gates cover typed selection, account-scoped discovery, private snapshots, direct-model verification, all-operation trusted preset schemas, format-preserving routing fallback, shared state, the rendered legacy UI, archives, and durable recovery. Every review-focus item maps to tests above. Implementation must list any unsupported preset configuration explicitly before save; no generic success label may conceal dropped prompt/routing settings.

Planning validation: paths and current behavior were reviewed against the stated source revision; no application behavior was changed and no live provider calls were made. Before execution, recheck main and PR #132 only for relevant changes, preserve this scope, and allocate migration numbers from the new base.



## Final plan review — 2026-09-19

Corrected the former model Legacy/Auto default ambiguity: both selection types now default to Structured Outputs. Model capability verification remains mandatory on the default path; preset admission trusts support. The design defines server-side defaults, old-client inputs, stored-policy compatibility, selection switching, and frozen-job behavior. Tasks 1, 4, 7 and 8 cover those requirements in API, unit, rendered legacy UI and composed workflow checks.

Release gate: create a fresh profile through each UI mode and directly through the API without a format policy; verify model mode requires capability evidence, preset mode requires none, and both successful paths send json_schema. Repeat after save/reopen and selection switching. Simulate schema rejection and verify no standard-JSON retry. Missing metadata on a direct model must produce a preflight explanation, not a hidden downgrade.

New UI work remains deferred. This review validates plan consistency and coverage, not implemented behavior or live endpoint compatibility.

## Final review addendum: explicit release gates

The intended API and legacy UI behavior is approved at the plan level. This is not implementation sign-off. The following refinements are mandatory parts of the existing task gates:

| Selection in legacy settings or a request override | Default | Admission | Failure behavior |
| --- | --- | --- | --- |
| Model, including a custom concrete model ID | Required Structured Outputs | Advertised capability plus matching current schema, operation and streaming verification | Missing evidence blocks before inference; no silent JSON downgrade |
| Native OpenRouter Preset | Structured Outputs, labeled Trusted preset | No local model/provider capability or verification gate | Provider schema rejection is visible; no schema stripping or standard-JSON retry |
| Use profile selection | Inherit the typed selection and its applicable policy | Apply the Model or Preset rule above | Never replace an inherited preset with its first model |

- [ ] **Task 3: preserve effective prompts.** Freeze the complete effective operation prompt, including protocol expansion and repair instructions, rather than only a raw prompt-library template. Compose the preset prompt exactly once before the earliest input-budget calculation. Request-capture tests must compare the planned, measured and dispatched initial and repair bodies for authoring, source authoring, Story and text-assisted illustration refinement.
- [ ] **Task 4: enumerate the entire schema closure.** Include RPG assessment, event-trigger decisions, scene coverage, event coverage, authoring, source extraction/world generation, organizer and refinement operations as well as Story and repairs. Scene coverage and event coverage need distinct schema identities despite their shared cost-operation label. Retain domain validation and mechanics/fiction separation. Test every active operation with preset metadata that lacks structured-output capability evidence; every provider request must still contain its complete operation schema. Direct models retain verification for those same applicable contracts.
- [ ] **Tasks 3 and 5: gate every admission boundary.** A production-default-false feature gate must cover native capture/execution in Story queueing, durable authoring, direct consumers and illustration refinement until transport and worker compatibility gates pass. A missing executor that fails after creating a v2 snapshot does not count as disabled admission. Test flag-off behavior and explicit opt-in separately.
- [ ] **Tasks 5 and 8: prevent downlevel claims.** Exercise historical claim/reclaim SQL against v2 Story, authoring and illustration work, including paired authoring parent/stage updates. Prove old workers cannot change or execute the saved v2 work. Upgrade all workers before enabling admission; rollback preserves frozen jobs.
- [ ] **Tasks 6 and 7: verify selection at both entry points.** Rendered tests must cover the native settings picker and legacy per-request selection/Use profile selection. Assert typed save and generation payloads, save/reopen, mode switching, stale discovery replies, retained custom model IDs and clearly labeled explicit historical compatibility overrides. Fresh selections and omitted-policy API requests use the defaults in the table.

Existing explicitly saved Model Legacy/Auto policies and queued v1 snapshots remain compatibility exceptions; they are not defaults for new selections and never downgrade a newly selected preset. New UI work and standard-JSON fallback remain deferred.
