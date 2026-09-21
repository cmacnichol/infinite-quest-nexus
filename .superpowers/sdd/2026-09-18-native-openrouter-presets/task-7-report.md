# Task 7 implementation report

## Status

DONE. The legacy provider settings editor and legacy Story per-request selector now expose native OpenRouter Model/Preset selection through the approved Task 6B management bridge. The implementation remains gated by `capabilities.nativeTextExecutionPlans`; an absent field produces an explicit older-server state. No production native admission setting was enabled.

Approved base: `43b275ddebf8ffa513c163142c4011ee53d9a6f8`.

## User-visible behavior

### Provider settings

- OpenRouter text profiles show native Model and Preset modes. Image and embedding profiles keep their existing controls.
- New Model drafts default to Required Structured Outputs. Existing explicit Legacy/Auto choices remain visible and survive a mode round trip. Choosing a different concrete or custom model resets that new selection to Required.
- Preset mode hides the Model-only alias/control, labels its response format `Structured Outputs · Trusted preset`, and shows the owner-safe standard prompt, version, ordered candidate models, provider policy, parameters, configured/effective output limits, and unknown context status.
- The preset picker shows loading, empty, finite error, paging/Load more, and Refresh states. A saved unavailable slug remains selected and labeled unavailable; the UI never substitutes the first discovered item.
- Model and Preset drafts stay independent. Override intent preserves the Task 6 contract: preserve omits the field, inherit sends `null`, and explicit sends only the strict supported object. Clearing an explicit override restores preset inheritance.
- Only form Save sends POST/PATCH. Opening, switching, refreshing, and editing drafts do not mutate the profile.
- Profile summaries render the typed Model/Preset selection. The shared dialog backdrop helper now closes only on a real backdrop click, preserving interior and keyboard interaction.

### Story per-request selection

- The legacy Story player offers `Use profile selection`, `Model`, and `Preset` for the campaign's OpenRouter text profile.
- `Use profile selection` sends no per-request model, selection, or override keys and never replaces a preset with its first candidate.
- Model accepts a concrete/custom ID but blocks locally until the exact model, Story operation, streaming mode, current expiry, schema version, and schema hash are verified by the server capability inventory.
- Preset uses the trusted full-schema path without a local model capability gate or downgrade control. It exposes the same read-only owner-safe preset metadata as settings.
- Request overrides default to inherit. Model and Preset request drafts remain independent across mode switches. Reload returns to `Use profile selection`; request editing never writes the saved profile.
- A public provider failure remains the fixed safe message. Integration evidence below verifies that a native schema rejection sends no later compatibility inference.

## Shared bridge and served-source behavior

Both surfaces import the built `/nexus/legacy-management.js` entry and call its `createSelectionEditorState`, `reduceSelectionEditor`, `serializeSelectionEditorPatch`, `createProviderPresetsApi`, and `nativePresetSupport` exports. No reducer/request-state copy, raw TypeScript import from public HTML, or Story-booting management import was added.

Production builds continue to emit the stable `legacy-management.js` entry. Vite development serves only the exact `/nexus/legacy-management.js` pathname through `transformRequest("/src/legacy-management-entry.ts")`; other paths continue through normal middleware. The rendered Story test loads the real served Story module and this development bridge. The production build-contract dynamically imports the emitted stable entry.

## TDD evidence

The first rendered provider-settings RED failed because the Preset radio did not exist. After the settings implementation was green, the Story RED failed because its native per-request selector was absent. The real served Story module then exposed strict fixture metadata gaps; the fixture was corrected to the public contract rather than weakening production parsing.

The structured-output browser suite initially failed all four cases after the new native gate exposed legacy expectations, a capability identity mismatch, and illustration fields that author CSS made visible despite `hidden`. Production fixes restored exact capability identity behavior, old-server presentation, and reliable hidden semantics. A keyboard mode-switch RED also exposed backdrop handling that treated interior dialog clicks as backdrop clicks; the helper now requires `event.target === dialog` and the browser case covers keyboard/interior/backdrop behavior.

The combined browser run later exposed an in-flight discovery race in the custom-ID test. Both test paths now wait for the rendered picker completion before choosing a custom ID. The final Story pass also verifies that an explicit Preset override survives Preset → Model → Preset switching.

## API to prepared-request evidence

The provider-routes PostgreSQL integration creates a preset profile through the API, PATCHes strict overrides, feeds the returned safe profile into the production authoring preparation/serialization path, then clears through the API and prepares again.

- Explicit body: `model=openai/gpt-4o`, `temperature=0.31`, `max_tokens=654`, conservative input limit `9345`, output reserve `654`.
- After clear: the saved override field is absent and a fresh preparation inherits preset `temperature=0.8`, `max_tokens=900`, input limit `7292`, and output reserve `900`.
- Both bodies contain the exact complete strict `world_outline` `json_schema`, including the canonical name and full schema object.

Separate PostgreSQL generation cases prove:

- a file-verified direct Model v2 append reaches the prepared transport with the exact complete strict Story schema;
- a trusted Preset v2 append reaches the same transport with preset prompt/routing/temperature and the exact complete strict Story schema, without a Model capability gate;
- a native event-extension schema rejection records `provider_schema_invalid`, retains the exact full schema request body, performs no later inference, and does not mutate authority.

## Final verification

Every child process used the private Task 7 pnpm 12.4.1 shim directory first on `PATH`. PostgreSQL commands used only the task-private JSON URL through the explicit task Vitest config; no credential value was printed and the shared database was not reset.

### Focused DOM and bridge contract

Command:

`pnpm exec vitest run tests/unit/management-ui.test.ts tests/unit/legacy-provider-modal.test.ts tests/unit/web-build-contract.test.ts --reporter=dot`

Result: PASS — 3 files, 88 tests.

### Complete affected PostgreSQL route file

Command:

`pnpm exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/provider-routes.integration.test.ts --reporter=dot`

Result: PASS — 1 file, 10 tests. This includes the override/clear API-to-prepared-body round trip.

The earlier focused form of that same case was PASS — 1 passed and 9 filtered/skipped. It is superseded by the complete-file run above and is recorded to distinguish filtered evidence accurately.

### Prepared Model/Preset and schema-failure cases

Command:

`pnpm exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/generation-response-contract-failures.integration.test.ts -t "(direct Model v2 append|trusted preset v2 append|native event-extension schema rejection)"`

Result: PASS — 3 passed and 39 filtered/skipped (42 total).

### Rendered legacy browser suites

The dedicated Browser plugin/skill was unavailable in this session, so the `build-web-apps:frontend-testing-debugging` regular repository Playwright branch was used as directed.

Command:

`pnpm exec playwright test legacy-provider-presets.e2e.test.ts structured-output-settings.e2e.test.ts --workers=1`

Result: PASS — 9 tests. The run covers provider settings and Story, desktop/mobile layouts, keyboard interaction, real outgoing fixture payloads, save/reopen, first-profile Required default, custom IDs, unavailable/old-server states, list/detail races after credential/profile changes, exact Model verification/blocking, trusted Preset submission, override preservation/clear, reload-to-profile behavior, and relevant page/HTTP error checks. No framework overlay appeared.

### Repository checks

- `pnpm check` — PASS. Repository/data boundaries, package TypeScript, legacy and replacement web checks, root noEmit, and JavaScript syntax checks all passed.
- `pnpm build` — PASS. Legacy production output emitted stable `legacy-management.js`; replacement web build also passed. Its pre-existing unresolved-at-build-time font notices and chunk-size advisory remained warnings.
- `git diff --check` — PASS.

## Screenshot evidence

Task-owned acceptance captures:

- `.superpowers/sdd/2026-09-18-native-openrouter-presets/task-7-screenshots/settings-desktop-preset-detail.png`
- `.superpowers/sdd/2026-09-18-native-openrouter-presets/task-7-screenshots/settings-mobile-preset-detail.png`
- `.superpowers/sdd/2026-09-18-native-openrouter-presets/task-7-screenshots/settings-desktop-overrides-explicit.png`
- `.superpowers/sdd/2026-09-18-native-openrouter-presets/task-7-screenshots/settings-mobile-inherit.png`
- `.superpowers/sdd/2026-09-18-native-openrouter-presets/task-7-screenshots/story-desktop-preset-detail.png`
- `.superpowers/sdd/2026-09-18-native-openrouter-presets/task-7-screenshots/story-mobile-preset-detail.png`
- `.superpowers/sdd/2026-09-18-native-openrouter-presets/task-7-screenshots/story-desktop-model-blocked.png`
- `.superpowers/sdd/2026-09-18-native-openrouter-presets/task-7-screenshots/story-mobile-profile.png`

The four targeted detail captures visibly show loaded prompt/version/models/policy/limits; settings additionally shows parameters and explicit/inherit controls. Mobile wrapping is readable, the Model-only alias field is absent in Preset mode, and element-at-point/bounds checks prove the mobile selector remains focusable above the fixed navigation at the actual viewport. These captures contain fixture data only.

The structured-output suite intentionally refreshed these tracked reviewed baselines, which were visually inspected after the final run:

- `docs/review/assets/structured-output/settings-desktop-required.png`
- `docs/review/assets/structured-output/settings-desktop-verified.png`
- `docs/review/assets/structured-output/settings-mobile-illustration.png`

## Fixture and scope limits

Browser verification used sanitized route fixtures and made no paid/live provider calls. PostgreSQL verification used the task-private local integration database plus inert/fake provider transports; it proves API persistence and production preparation/serialization but not live OpenRouter availability or narrative quality. No deployment, production enablement, push, PR, main integration, repository-root historical `index.html`, or `apps/web-next` source change was performed. Root-owned `docs/review/native-openrouter-presets/` and `scratch/` remain untracked and untouched.

## Self-review

- Reviewed the complete diff against the Task 7 brief and final dual-entry addendum.
- Confirmed the API feature gate, older-server fallback, no direct browser OpenRouter access, no credential/raw-error rendering, no automatic first-candidate substitution, and no profile write outside explicit Save.
- Confirmed visible native selection exists at both legacy entry points and uses the shared bridge state/API contracts.
- Confirmed exact full schemas remain in the prepared Model, Preset, explicit-override, inherited-after-clear, and rejected-schema bodies.
- Confirmed all intended production/test/baseline files are explicit commit candidates and root-owned review/scratch paths are excluded.
