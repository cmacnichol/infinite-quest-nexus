# Task 3A report: validated execution plans and pure preset resolution

Status: complete for Task 3A only. Task 3B owns queue persistence and Task 3C owns active-consumer wiring; this change performs neither.

## Delivered interfaces

- `TextExecutionPlan` and `TextRouteCandidate` have strict runtime schemas in `@infinite-quest/application`. Private plans carry selection, preset version/config hash, ordered candidates, complete routing policy, normalized ordinary parameters, one composed prompt and hash, opaque endpoint/credential revision references, profile revision, protocol version, and plan hash. The public summary omits prompt and all references.
- `resolveTextExecutionPlan(input)` in runtime is pure except for injected `resolvePreset` and `discoverModels` ports. The caller must persist the parsed version-2 plan exactly as returned; its `planHash` hashes the canonical serialization excluding only itself. Do not recompose its prompt, resolve preset aliases, or widen `parameters.max_tokens` / `max_completion_tokens`: each is normalized to the shared candidate output minimum.
- An explicit `overrides.selection` replaces profile selection entirely. Unknown route context capacity requires `overrides.conservativeContextWindowTokens`; a legacy profile scalar is not capacity evidence. Existing discovered and explicit caps are reduced to the minimum.
- `validateOpenRouterPresetConfig` is the exported Task 2 single allowlist. It now also rejects `provider.order` with `provider.sort` so routing stays deterministic.

## Verification

- RED: resolver suite initially failed because the new resolver module did not exist. The prompt suite already passed on that initial command because its helper was present before the RED run; it was not removed to manufacture failure.
- GREEN: `corepack pnpm exec vitest run tests/unit/provider-preset-resolution.test.ts tests/unit/preset-prompt.test.ts tests/unit/openrouter-presets.test.ts`
- Passed: `corepack pnpm --filter @infinite-quest/application check`; `corepack pnpm exec tsc -p tsconfig.json --noEmit`; `git diff --check`.
