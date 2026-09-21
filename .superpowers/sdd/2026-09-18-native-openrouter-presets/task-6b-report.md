# Task 6B implementation report

## Status

DONE. Task 6B adds strict safe Preset and provider views, safe v2 response-format status, a default-off native capability advertisement, a reusable pure selection editor, typed saved/unsaved Preset discovery clients, and a side-effect-free built legacy management bridge. Task 7 still owns visible legacy controls and rendered browser verification.

Approved base: `c3ca482fdc429ff7342048666357dfafaf28d5bc` (Task 6A complete and independently approved).

## Public Preset and provider views

- Preset list responses expose only slug, name, finite status, designated version ID, update timestamp, and paging totals/offsets.
- Owner-only detail exposes the configured standard prompt, name/version, ordered deduplicated candidate model IDs, the complete supported finite provider policy and exclusions, supported generation parameters, configured/effective output limits, explicit unknown context capacity, and `trusted_preset` schema assurance.
- Malformed source collections, candidate IDs, configured routing policy, parameters, or output bounds fail strict projection. They are not normalized to an empty list or partial configured intent. Existing OpenRouter discovery converts malformed upstream data to finite `invalid_response` or `preset_config_unsupported` diagnostics.
- Provider list responses use a strict complete view. Configuration is the existing safe allowlist; credentials, credential references, encryption fields, persisted raw errors, and unknown stored configuration fields are unrepresentable. Credential state is presence-only (`hasApiKey`), and `lastHealthError` is always `null`.
- Saved and request-scoped Preset list/detail routes pass through the same four safe projectors. The unsaved candidate body may contain the write-only credential required for the request; neither safe response contains it.

## v2 status semantics and safety

`generationResponseFormatProjectionSchema` is now a v1/v2 discriminated union. V1 remains compatible. V2 publishes:

- requested selection from queued authority only;
- `verified_model` for exact Model evidence or `trusted_preset` for Preset trust;
- selected format/schema/operation/streaming state;
- actual served model/provider route only from response evidence;
- `actualServedIdentity.status: "unknown"` when both supplied fields are absent, invalid, or outside public bounds.

Requested metadata is never substituted for missing actual serving identity. A response that supplies only one valid observed field is `known` with the other field `null`. TypeScript and SQL projectors use the same 500-character bounds for observed model and provider route. SQL projects only the bounded authority kind/selection, finite admission mode, safe schema metadata, latest invocation identity, and finite diagnostic code. Endpoint identity/reference, route hashes/policies, frozen schema bodies or prompts, credentials, and raw errors remain private.

The client generation machine compares both union variants without treating requested selection as returned identity. The v2 Model and Preset trust paths remain distinct, and Presets retain full-schema `json_schema` selection without a standard-JSON downgrade.

## Capability and older-server behavior

`GET /api/v1/meta` advertises `capabilities.nativeTextExecutionPlans` only when the single shared runtime setting is exactly `nativeTextExecutionPlanAdmission === true`. The normal server configuration remains false. An older server response that omits the field parses as false.

The provider-Presets client reports old list endpoints as `ProviderPresetsUnsupportedError`; detail-level 404 remains an ordinary missing-resource error. `nativePresetSupport(meta)` also returns an explicit supported/unsupported state. No second enablement flag or admission path was added.

## Selection editor and API interfaces

The pure reducer exports `createSelectionEditorState`, `reduceSelectionEditor`, and `serializeSelectionEditorPatch` plus their public input/event/state/patch types.

- Model and Preset drafts keep independent selection, response-format policy, and override intent.
- The active saved draft retains its current safe override value for display while remaining `preserve`; the inactive selection starts without that value, so switching modes cannot silently transfer settings.
- Model retains explicit historical `legacy`, `auto`, or `required`; Preset is pinned to `required`.
- Override intent serializes exactly as Task 6A requires: `preserve` omits `textExecutionOverrides`, `inherit` sends `null`, and `explicit` sends the strict approved object. Switching drafts does not transfer an explicit override to the other selection.
- List and detail requests have independent request IDs. Stale success, failure, and finally events are identity no-ops, including busy state.
- Paging preserves order and deduplicates by slug; a saved Preset missing from a complete result remains the active draft and becomes explicitly unavailable.
- Finite failures preserve edits. Profile, configuration, or credential revision changes retain drafts but invalidate all discovery evidence. Credential material never enters reducer state.

`createProviderPresetsApi` supplies typed saved list/detail and unsaved candidate list/detail operations, validates request IDs/options/slugs/candidates, attaches `AbortSignal`, and strictly parses safe responses.

## Legacy management bundle

Vite now emits `/nexus/legacy-management.js` as a stable named-export entry beside the existing Story bundle. Task 7 can import it directly:

```js
const {
  createSelectionEditorState,
  reduceSelectionEditor,
  serializeSelectionEditorPatch,
  createProviderPresetsApi,
  nativePresetSupport
} = await import("/nexus/legacy-management.js");
```

The entry only re-exports framework-free reducer and API modules. The build-contract test dynamically imports the emitted artifact and verifies its named functions; import succeeds without DOM setup or Story-player boot side effects.

## TDD and continuity evidence

### Recovered prior RED and continuity

The interrupted first Task 6B worker left test-first partial work. Its recorded focused RED had six failing files: eight behavior failures plus two missing-module suites, while 69 existing assertions passed. The missing production pieces were v2 projection, the client Preset API module, and the management bridge.

On resumption, this continuity command used the pinned toolchain:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run tests/unit/provider-presets-contract.test.ts tests/unit/client-api-contracts.test.ts tests/unit/generation-response-format-projection.test.ts tests/unit/server-security.test.ts tests/unit/provider-selection-editor.test.ts tests/unit/provider-presets-api.test.ts tests/unit/web-build-contract.test.ts`

Result: 3 failed and 4 passed files; 2 failed, 83 passed, and 5 skipped tests. Remaining behavior failures were v2 status projection; the client API module and management build entry were still absent. The web build setup also exposed that a child `pnpm` resolved managed pnpm 11 instead of repository-pinned pnpm 12.4.1.

### v2 projection RED/GREEN

Unit and PostgreSQL-first tests required requested selection and assurance to remain distinct from supplied actual identity, and prohibited private endpoint, credential, schema body, and prompt data.

The initial TypeScript and SQL unit run failed both new v2 cases. The first private PostgreSQL attempt could not connect to the stale private port, so no integration case was claimed. After the existing task-owned container was restored and its private configuration updated, the focused v2 SQL case passed.

Final edge RED command:

`& "$taskBin\pnpm.cmd" exec vitest run tests/unit/generation-response-format-projection.test.ts tests/unit/generation-response-format-sql-projection.test.ts tests/unit/provider-presets-contract.test.ts`

RED: 3 files failed; 3 failed and 7 passed. It demonstrated the 500-versus-256 served-identity mismatch and silent normalization of malformed Preset source data.

GREEN after aligning TypeScript/SQL bounds and failing strict projection: 3 files, 10 tests.

### Reducer, API, and machine

Focused reducer/API/machine command during implementation:

`& "$taskBin\pnpm.cmd" exec vitest run tests/unit/provider-selection-editor.test.ts tests/unit/provider-presets-api.test.ts tests/unit/client-core/generation-machine.test.ts`

PASS: 3 files, 31 tests. Coverage includes independent drafts, exact three-state override serialization, paging dedupe, unavailable saved choice, edit-preserving finite errors, revision invalidation, stale list/detail success/failure/finally no-ops, strict response parsing, AbortSignal, older-server behavior, and v2 generation-machine identity changes.

A final reducer self-review added a focused assertion that the current saved override value remains available only on its matching active draft. RED: 1 failed and 7 passed. GREEN after separating active saved and inactive empty `preserve` intents: 1 file, 8 tests; client-core and legacy bridge type checks also passed.

### Build entry RED/GREEN

The first build-contract attempt failed before assertions because its child process selected pnpm 11.15.1 instead of the repository-required 12.4.1. The task-private `bin` directory was prepended to `PATH` as well as used for the parent command. The final command was:

`$taskBin = (Resolve-Path '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin').Path; $env:PATH = "$taskBin;$env:PATH"; & "$taskBin\pnpm.cmd" exec vitest run tests/unit/web-build-contract.test.ts`

PASS: 1 file, 5 tests. It proves the emitted management entry, named runtime exports, dynamic import, and absence of Story-player boot side effects.

## Final verification

Complete focused Task 6B units:

`& "$taskBin\pnpm.cmd" exec vitest run tests/unit/provider-presets-contract.test.ts tests/unit/client-api-contracts.test.ts tests/unit/generation-response-format-projection.test.ts tests/unit/generation-response-format-sql-projection.test.ts tests/unit/server-security.test.ts tests/unit/provider-selection-editor.test.ts tests/unit/provider-presets-api.test.ts tests/unit/client-core/generation-machine.test.ts`

PASS: 8 files, 111 tests.

Affected private PostgreSQL files, using only the task-private URL and `vitest.integration.config.ts`:

`& "$taskBin\pnpm.cmd" exec vitest run --config '.superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts' tests/integration/provider-routes.integration.test.ts tests/integration/generation-response-contract-projection.integration.test.ts`

PASS: 2 files, 12 tests. PostgreSQL authenticated through the restored task-owned instance. No test was skipped. This is actual database/API boundary evidence for saved/unsaved safe Preset routes and SQL/TypeScript v2 projection parity; it is not live provider evidence.

Repository check:

`& "$taskBin\pnpm.cmd" check`

The first run failed one compile-only test access because the new discriminated union was not narrowed before reading `actualServedIdentity`. The test now explicitly checks/narrows version 2. Final result: PASS, including repository/data-safety checks, all affected package checks, full `tsc -p tsconfig.json --noEmit`, legacy/replacement web checks, and JavaScript syntax checks.

Full build:

`& "$taskBin\pnpm.cmd" build`

PASS: contracts/application/client package checks, server TypeScript build, legacy Vite build, and replacement Vite build. The legacy output includes `legacy-management.js` and `legacy-client.js`. Existing replacement-font resolution and large-chunk messages remained non-failing warnings.

`git diff --check` — PASS, exit 0, no output.

## Files changed

- `apps/web/package.json`
- `apps/web/vite.config.ts`
- `apps/web/src/legacy-management-entry.ts`
- `packages/client-core/src/generation/machine.ts`
- `packages/client-core/src/index.ts`
- `packages/client-core/src/providers/selection-editor.ts`
- `packages/client-web/src/index.ts`
- `packages/client-web/src/provider-presets-api.ts`
- `packages/contracts/src/client-api.ts`
- `packages/contracts/src/generation-response-format-projection.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/provider-presets.ts`
- `packages/contracts/src/provider-profile-view.ts`
- `packages/database/src/generation-response-format-projection.ts`
- `services/api/src/provider-application-adapter.ts`
- `services/api/src/server.ts`
- `tests/integration/generation-response-contract-projection.integration.test.ts`
- `tests/integration/provider-routes.integration.test.ts`
- `tests/unit/client-api-contracts.test.ts`
- `tests/unit/client-core/generation-machine.test.ts`
- `tests/unit/generation-response-format-projection.test.ts`
- `tests/unit/generation-response-format-sql-projection.test.ts`
- `tests/unit/provider-presets-api.test.ts`
- `tests/unit/provider-presets-contract.test.ts`
- `tests/unit/provider-selection-editor.test.ts`
- `tests/unit/server-security.test.ts`
- `tests/unit/web-build-contract.test.ts`
- `.superpowers/sdd/2026-09-18-native-openrouter-presets/task-6b-report.md`

## Self-review and limits

- Reviewed every production hunk against the 6B boundary and the approved 6A contract. No duplicate override persistence/resolution path, database migration, provider executor, or standard-JSON fallback was added.
- Verified all four Preset route variants use the same strict safe projectors and that public provider/status views cannot contain raw configuration, private plans/prompts, credential references, or raw errors.
- Verified v2 requested selection comes only from queued authority and actual served identity only from response evidence. Preset trust and Model verification are separate finite assurances; invalid/absent actual identity remains unknown.
- Verified both list and detail request identities protect success, failure, and finally events; authority revision changes invalidate evidence without retaining credentials or discarding drafts.
- Verified the management bridge has no boot code and its emitted named exports can be dynamically imported. Task 7 must wire those exports into visible legacy controls.
- Preset context-window capacity remains explicitly unknown because the upstream detail used here supplies no trustworthy discovered capacity. Effective output capacity is the conservative minimum of configured `max_tokens` and `max_completion_tokens` when present.
- No visible UI changed, so browser verification and screenshots were not applicable. No live or paid provider inference was performed.
- Native admission remains disabled by default. No deployment, push, PR, or main-checkout integration was performed.
- Root-owned untracked `docs/review/native-openrouter-presets/` and `scratch/` were excluded.

Independent review is required before Task 7 begins.
