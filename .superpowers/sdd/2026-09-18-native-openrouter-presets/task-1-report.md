# Task 1 report: typed text selections

## Delivered

- Added the `TextModelSelection` contract with Model and OpenRouter Preset discriminators, exact legacy alias normalization, compatibility IDs, contradictory-field rejection, and safe preservation of malformed historical aliases through `defaultModel`.
- Added nullable `provider_profiles.text_selection` persistence with a strict JSON shape constraint. Writes synchronize the legacy `default_model` compatibility field; reads derive valid legacy rows without rewriting malformed historical values.
- Carried typed selection through provider commands, views, API projection, safe candidate discovery, and portable archive authority records. Archives keep selection data but still exclude credentials and cached provider state.
- New text/intent profile creation and old-client selection changes default to `textResponseFormatPolicy: required`; explicit `legacy` and `auto` values remain unchanged. New queued work with a historical omitted policy uses Required, while already queued jobs retain their persisted policy snapshot.
- Prevented a text profile selected as an embedding fallback from supplying an OpenRouter preset alias.

## TDD evidence

### RED

1. `corepack pnpm exec vitest run tests/unit/provider-selection.test.ts`
   - Failed as intended: `Cannot find module '../../packages/contracts/src/provider-selection.js'`.
2. `corepack pnpm exec vitest run tests/unit/provider-api-adapter.test.ts`
   - Failed as intended: native preset input was forwarded as `defaultModel: "model"` and omitted `textSelection`.
3. `corepack pnpm exec vitest run tests/unit/provider-selection.test.ts`
   - Failed as intended after adding the legacy-alias case: `Unsupported combined model/preset syntax.` was raised for `@preset/`, rather than preserving it for display.
4. `corepack pnpm exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/provider-postgres-adapters.integration.test.ts --reporter=dot`
   - Initially failed on the new regression because nullable `text_selection` was serialized as JSON `null`, violating the SQL shape constraint; the corrected write sends SQL NULL.

### GREEN

- `corepack pnpm exec vitest run tests/unit/provider-selection.test.ts tests/unit/provider-api-adapter.test.ts`
  - 13 passed.
- `corepack pnpm exec vitest run tests/unit/provider-selection.test.ts tests/unit/provider-api-adapter.test.ts tests/unit/provider-postgres-adapters.test.ts tests/unit/system-archive-contracts.test.ts --reporter=dot`
  - 95 passed.
- `corepack pnpm exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/provider-postgres-adapters.integration.test.ts --reporter=dot`
  - 9 real PostgreSQL tests passed, including create/reopen/update, cross-owner denial, old-client update, historical-null policy, and preset embedding-fallback denial.
- `corepack pnpm exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/system-archive.integration.test.ts -t "round-trips non-default v2 authority exactly" --reporter=dot`
  - 1 real PostgreSQL archive import round-trip passed; 52 unrelated tests skipped by the name filter.
- `corepack pnpm exec tsc -p tsconfig.json --noEmit`
  - Passed.
- `git diff --check`
  - Passed.

## Self-review

- Reviewed the changed API role boundary: image and embedding profiles keep their existing model-only paths and never receive a `textSelection` field.
- Reviewed write/read compatibility: existing null rows remain valid; malformed historical strings remain in the compatibility field and are not rewritten merely by reading.
- Reviewed persisted generation behavior: only new profile writes and selection-changing old-client writes receive the Required default. Explicit saved policies are preserved, and existing queued jobs are untouched.
- Reviewed archive scope: selection is serialized in authority records and restored into `text_selection`; credentials and runtime cache data remain excluded.

## Remaining concerns

- This task intentionally does not resolve remote OpenRouter preset metadata or execute preset aliases. Later tasks must use the typed selection to build immutable resolved execution plans before dispatch.
- No browser or live-provider verification was run because Task 1 changes contracts, persistence, and API seams only.
