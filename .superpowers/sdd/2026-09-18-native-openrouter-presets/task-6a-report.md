# Task 6A implementation report

## Status

DONE. Saved and per-request `textExecutionOverrides` now use one strict public contract, persist through provider configuration and portable System Archive authority, and resolve once into frozen Model/Preset execution plans. Native admission remains default-off. No discovery/status/editor/bundle work from Task 6B and no visible UI work from Task 7 is included.

Approved base: `0508ade4ca19c545ea7e38a06736998622d973eb` (Task 5C approved after re-review).

## Public contract and exact semantics

The public field is `textExecutionOverrides`:

```ts
{
  parameters?: TextGenerationParameters;
  conservativeContextWindowTokens?: number;
}
```

- `parameters` reuses the existing strict `textGenerationParametersSchema`; it does not duplicate or weaken the generation parameter contract.
- `conservativeContextWindowTokens` is a positive integer capped at `4_000_000`.
- Unknown keys, non-finite/out-of-range parameters, non-positive context caps, and context caps above the public maximum are rejected before safe projection.
- Provider create accepts the object only for `text` and `intent` roles. Provider PATCH rechecks the stored role at the repository boundary. Image and embedding create/PATCH requests reject it. Portable archive authority rejects it on non-text/non-intent roles and rejects malformed nested values.
- Saved provider PATCH omission preserves the saved override object. Explicit `null` clears the complete object. Supplying an object replaces the complete prior object.
- A semantic selection change clears saved overrides when the PATCH omits the field. An explicit object in the same selection-changing PATCH applies to the new selection. Equivalent normalized selections, including exact `@preset/<slug>` aliases, preserve saved intent.
- A generation/authoring request that omits the field inherits saved overrides only when its effective normalized selection matches the profile selection. A request object replaces saved intent for that request. Request `null` restores Preset/profile inheritance for that request.
- Clearing removes explicit parameter and conservative-cap intent. Normal selected Preset values, discovered model capacity, and ordinary legacy profile defaults remain independent inheritance sources.
- A newly created text/intent profile or a selection-changing PATCH with no explicit historical policy receives `textResponseFormatPolicy: "required"`. Explicit `legacy` or `auto` on the same PATCH remains explicit and is preserved.

## What changed

- Exported `textExecutionOverridesSchema` and `TextExecutionOverrides` from the existing text-execution contract module; generation and Infinite Worlds request schemas expose nullable optional request intent.
- Added validation-before-projection to provider create, PATCH, and candidate discovery. The API adapter retains the PATCH null/omission distinction through an internal `ProviderProfileChanges.textExecutionOverrides` marker.
- Persisted saved overrides in the existing safe provider `configuration` JSONB. No column, migration, archive format version, or JSON compatibility downgrade was added.
- Corrected immediate create responses to merge the repository's `Required` default with legitimate safe same-request echo fields. Credentials and unsafe configuration remain excluded.
- Added one shared `resolveEffectiveTextExecutionOverrides` seam before existing route preparation. Story append/replacement, direct world generation, character organization, durable world/character authoring, source extraction/synthesis/character authoring, and illustration prompt refinement receive the same mapped effective parameters/cap.
- Forwarded Infinite Worlds request overrides through the public route, portable preview composition, provider collaborator, and real world-generation preparation.
- Kept frozen route parameters, model/preset identity, context/output limits, prompt, and hashes stable through ordinary safe profile edits and reclaim. Current endpoint, credential, campaign-provider, and authority revocation still block. Stored/frozen hash substitution remains rejected; the database immutability guard still prevents post-queue route-basis mutation.
- Validated the historical append/replacement preparation seam with `readTextExecutionRouteBasis` so a malformed or substituted legacy basis fails `invalid_state`. Existing no-plan v1 behavior remains compatible.
- Added `provider_profiles.text_selection` to portable exact authority and round-tripped strict safe configuration. Archive restore now sends SQL `NULL`, rather than JSONB `null`, when the optional text selection is absent, satisfying the existing 0097 constraint.
- Classified `prepared_text_physical_attempts` as operational. Portable export excludes physical request bodies, credential references, and provider-policy sentinels while retaining logical provider authority and saved overrides.

## Runtime and prepared-byte evidence

The override resolver is called once before the existing `resolveTextExecutionPlans` path. The all-consumer plan regression covers:

- Story append and replacement persisted route bases;
- direct/durable world outline and standalone character;
- character organizer;
- source extraction, synthesis, and selected source character;
- illustration prompt refinement.

New Task 6A actual-body assertions serialize the prepared world request and invoke the real direct world and organizer prepared closures. They prove:

- saved `temperature: 0.19` reaches the JSON body;
- requested `max_tokens: 5000` is hard-capped to `1024` in the actual body;
- an unknown discovered context with explicit conservative cap `6000` yields `inputLimit: 4976` and `outputReserveTokens: 1024`;
- request `null` restores Preset `temperature: 0.8` and `max_tokens: 900`; discovered context `8192` yields `inputLimit: 7292`;
- direct world and organizer physical prepared requests both carry the mapped values.

Source and illustration override coverage uses the same resolved plan and serializer closure and asserts their operation plans receive the mapped parameters. Task 5C's approved real composed PostgreSQL/fake-wire evidence remains the physical-body proof for source extraction/synthesis/character and generated, regenerated, provisional, promoted, and reconciled illustration consumers. Task 6A did not duplicate those large lifecycle fixtures merely to re-prove the shared serializer.

## TDD evidence

### Contract, API boundary, and archive registry RED/GREEN

Command:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run tests/unit/text-execution-overrides.test.ts tests/unit/provider-api-adapter.test.ts tests/unit/system-archive-portability.test.ts`

RED: 3 files failed; 10 failed and 11 passed. Representative failures were missing public schema/fields, request `null` being lost, malformed and non-text values reaching application/runtime projection, immediate create omitting the repository `Required` default, and `prepared_text_physical_attempts` remaining unclassified.

GREEN: 3 files, 21 tests.

### Provider persistence and route semantics

Command:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/provider-postgres-adapters.integration.test.ts tests/integration/provider-routes.integration.test.ts -t "text.*overrides"`

First behavioral run: repository persistence passed; API clear returned a response without the stored repository `Required` policy because safe same-request echo replaced the stored view. The adapter now merges safe echo into the stored safe configuration.

GREEN: 2 passed, 18 filtered/skipped.

The final provider-route focused rerun also creates a valid image profile and proves a later PATCH containing text overrides returns 400:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/provider-routes.integration.test.ts -t 'round-trips strict text overrides with PATCH preserve and explicit clear semantics'`

PASS: 1 passed, 8 filtered.

### Shared preparation and actual bytes

Command:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run tests/unit/authoring-stage-adapter.test.ts -t "maps saved and request text overrides"`

RED: expected saved `temperature: 0.19` and `max_tokens: 700`; received inherited Preset `temperature: 0.8` and `max_tokens: 900` because saved/request intent had no shared preparation seam.

GREEN after adding the resolver: 1 passed, 57 filtered at that point.

Expanded command:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run tests/unit/authoring-stage-adapter.test.ts -t 'maps saved and request text overrides|serializes effective temperature|carries saved overrides'`

The first expanded run exposed two test-assumption errors: a plan assertion expected route-level capacity fields on an operation plan, and a clear case removed the only safe capacity while discovery intentionally advertised none. Assertions were moved to the route basis and the clear fixture now supplies discovered capacity; the separate explicit conservative-cap case continues to prove unknown-capacity operation. GREEN: 3 passed, 57 filtered.

Complete affected authoring file after final type corrections: 1 file, 60 tests.

### Infinite Worlds public propagation

Command:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run tests/unit/task-14e3g-production-binding.test.ts tests/unit/provider-preset-resolution.test.ts`

PASS: 2 files, 30 tests. The request field reaches `generateCyoaWorld`; the existing resolver still requires explicit conservative capacity when discovery is unknown.

### Story freezing and archive RED/GREEN

Focused Story command:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/generation-repository.integration.test.ts -t "freezes ordinary metadata-time edits|freezes typed and exact legacy preset overrides"`

PASS: 2 passed, 45 filtered. It covers saved and request Preset bases, changed-selection non-inheritance, direct Model non-inheritance, exact legacy preset aliases, append/replacement freezing, ordinary edit survival, and credential/campaign authority rejection.

Focused archive command:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/system-archive.integration.test.ts -t "exports exhaustive logical authority|removes recursive secret"`

Initial result: current migration `0100` made stale `0096` fixture expectations fail, then restore passed JSONB `null` to the optional text-selection column and violated its constraint. After narrowing fixture versions to current source and passing SQL `NULL`, PASS: 2 passed, 51 filtered. The cases prove saved override export/import plus exclusion of private attempt body, credential, and provider-policy sentinels.

### Complete affected PostgreSQL files

Command:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/generation-repository.integration.test.ts tests/integration/provider-postgres-adapters.integration.test.ts tests/integration/provider-routes.integration.test.ts tests/integration/system-archive.integration.test.ts`

First run: 3 files failed and 1 passed; 9 failed, 107 passed, 4 skipped. The failures identified four concrete categories:

- the historical preflight callback could return a hash-substituted route basis without repository validation;
- an old post-queue tamper test expected a recoverable transition even though migration 0100 correctly rejects the direct SQL mutation at the immutability fence;
- an explicit Model fixture omitted authority revision and model capability verification, while native Model preparation correctly requires both and must not call Preset metadata;
- the new selection-update path forced `Required` over an explicit historical `auto`, and archive fixtures still expected migration 0096 instead of the approved 0100 schema, causing downstream preview/import mismatches.

Narrow fixes validated the historical basis at both append/replacement seams, retained the database guard and asserted unchanged stored payload, supplied real Model authority/capability evidence without Preset calls, preserved explicit `auto`/`legacy`, and updated the archive fixture matrix to the current schema.

Final result: 4 files passed; 116 passed, 4 skipped; duration 19.47s.

The four skips are expected on this Windows host because `supportsSecureGeneratedArchiveStaging()` returns true only on Linux:

- `cleans durable private spool authority when publication fails`;
- `executes every queued post-import asset rebuild without changing Original Asset authority`;
- `consumes opaque preview authority and restores through production staging`;
- `rolls back logical authority when production Original Asset attachment fails and preserves shared bytes`.

The first two use `runIf(linux)` and the latter two use `skipIf(!linux)`; no skipped check is reported as passed.

### Current authority through real execution paths

Command:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/generation-response-contract-failures.integration.test.ts tests/integration/authoring-stage-execution.integration.test.ts -t 'rejects native preset dispatch when the current endpoint authority is revoked|rejects native preset dispatch when its current credential authority is revoked|reclaims a complete inherited-Model contract after ordinary edits and rejects current authority drift'`

PASS: 2 files; 3 passed, 69 filtered. Ordinary current-profile edits do not invalidate the frozen plan, while current endpoint, credential, and durable authoring authority drift fail through real execution paths.

The final historical preflight rerun after removing an unregistered public error-reason literal remained GREEN: 1 passed, 46 filtered.

## Covering unit and static gates

Affected unit command:

`& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run tests/unit/text-execution-overrides.test.ts tests/unit/provider-api-adapter.test.ts tests/unit/provider-application.test.ts tests/unit/system-archive-portability.test.ts tests/unit/system-archive-contracts.test.ts tests/unit/authoring-stage-adapter.test.ts tests/unit/direct-authoring-response-contract.test.ts tests/unit/task-14e3g-production-binding.test.ts tests/unit/provider-preset-resolution.test.ts tests/unit/generation-response-contract-preflight.test.ts tests/unit/provider-application-composition.test.ts tests/unit/runtime-generation-composition.test.ts`

PASS: 12 files, 228 tests.

Static checks:

- `& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec tsc --noEmit` — the first final run found six compile-only issues: two internal invalid-state reason literals not in the exhaustive public reason union, two invalid test-only budget-kind fixtures, and two zero-argument mock tuple inferences. Minimal corrections kept the internal failure generic and fixed only fixture/mock typing. Final rerun: PASS, exit 0, no diagnostics.
- `git diff --check` — PASS, exit 0, no output.

The broad unit suite was not repeated. Task 5C's report already assigns the remaining unrelated branch-wide failures to Task 8, while its archive-registry residual was owned and fixed here. No unsupported claim is made about those unrelated tests.

## Files changed

- `packages/application/src/imports/types.ts`
- `packages/application/src/providers/types.ts`
- `packages/application/src/providers/use-cases.ts`
- `packages/application/src/system-archives/portability-registry.ts`
- `packages/contracts/src/generation.ts`
- `packages/contracts/src/imports.ts`
- `packages/contracts/src/system-archives.ts`
- `packages/contracts/src/text-execution-plan.ts`
- `packages/database/src/generation-repository.ts`
- `packages/database/src/provider-repository.ts`
- `packages/database/src/system-archive-import-repository.ts`
- `services/api/src/portable-infinite-worlds-import-route.ts`
- `services/api/src/provider-application-adapter.ts`
- `services/runtime/src/api-portable-import-export-composition.ts`
- `services/runtime/src/authoring-text-execution-preparation.ts`
- `services/runtime/src/generation-api-composition.ts`
- `services/runtime/src/infinite-worlds-provider-collaborators.ts`
- `services/runtime/src/provider-application-composition.ts`
- `services/runtime/src/provider-credential-transport-adapter.ts`
- `services/runtime/src/provider-world-generation-adapter.ts`
- `services/runtime/src/text-execution-overrides.ts`
- `tests/integration/generation-repository.integration.test.ts`
- `tests/integration/provider-postgres-adapters.integration.test.ts`
- `tests/integration/provider-routes.integration.test.ts`
- `tests/integration/system-archive.integration.test.ts`
- `tests/unit/authoring-stage-adapter.test.ts`
- `tests/unit/provider-api-adapter.test.ts`
- `tests/unit/system-archive-portability.test.ts`
- `tests/unit/task-14e3g-production-binding.test.ts`
- `tests/unit/text-execution-overrides.test.ts`
- `.superpowers/sdd/2026-09-18-native-openrouter-presets/task-6a-report.md`

## Interfaces for Task 6B

- Import `textExecutionOverridesSchema` / `TextExecutionOverrides` from `@infinite-quest/contracts`; do not define a client-local parameter schema.
- Provider safe configuration views expose `configuration.textExecutionOverrides` when present. API PATCH sends `configuration.textExecutionOverrides: null` to clear and omits the key to preserve.
- Generation and Infinite Worlds request schemas accept `textExecutionOverrides?: TextExecutionOverrides | null` with the request inheritance semantics above.
- Task 6B may project/edit these existing fields while it adds discovery/status/meta/reducer/API-client/bundle support. It should preserve the nullable request/PATCH distinction rather than normalize `null` to omission.
- Task 6B still owns safe Preset list/detail projections, complete typed editor views, v2 generation status/native metadata advertisement, reducer/API client, and management bundle bridge.

## Self-review and limits

- Reviewed every production hunk for the approved 6A boundary. No discovery/status/meta/reducer/UI code, migration, provider column, archive version bump, admission enablement, retry loop, claim identity, worker fence, or second executor was added.
- Confirmed explicit historical `legacy`/`auto` remains authoritative, Presets continue using trusted full schemas, and no standard-JSON downgrade was introduced.
- Confirmed selection comparison uses normalized semantic identity, safe validation precedes allowlist projection, and saved override storage remains separate from ordinary profile defaults.
- Confirmed frozen hashes and payloads remain immutable; only ordinary current execution-revision edits stopped invalidating an already frozen plan. Endpoint, credential, campaign-provider, and authority checks remain current.
- Confirmed root-owned untracked `docs/review/native-openrouter-presets/` and `scratch/` are excluded.
- No native admission was enabled. No paid/live provider call, browser/UI verification, deployment, push, PR, or main-checkout integration was performed.

Independent review is required before Task 6B starts.
