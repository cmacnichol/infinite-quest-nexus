# Story preset dispatch correction

The user clarified on 2026-09-23 that Story requests must reference the OpenRouter preset with Structured Outputs, because OpenRouter applies its routing configuration. Resolving the preset into local concrete-model attempts did not satisfy that contract.

New Story preset jobs capture protocol `story-openrouter-preset-v1` and one `@preset/<slug>` dispatch target. Resolved model capacities still establish conservative context/output limits, and the preset metadata remains captured for provenance. Each operation keeps its required strict JSON Schema. The checked serializer omits the provider routing block. OpenRouter chooses the actual model/provider and handles fallback; the durable attempt records the requested preset and actual returned identities separately. Rate limits, refusals, schema errors and partial streams do not trigger local concrete-model fallback or mutate accepted state.

Application prompts, frozen ordinary parameters, output limits, credential/endpoint fences, request hashes, local output validation and campaign isolation remain active. This change does not force an explicitly selected direct Model into a preset. It does not alter world authoring, cast discovery, image generation or embedding routing.

Historical jobs retain their captured concrete candidates and exact returned-identity checks. Existing saved requests are not rewritten. The remote preset is resolved by OpenRouter at dispatch; a captured version is provenance and capacity evidence, not an API guarantee that the remote configuration is pinned. Routing changes made on OpenRouter can therefore affect a queued preset-reference request. Deploy both API and worker code together for consistent new-job admission and execution.

## Evidence

- RED: one route-resolution regression and two initial/recovery wire/executor regressions failed before implementation.
- GREEN: 228 focused unit tests across 10 files passed. This includes unchanged historical concrete-route validation, Story executor, schema binding and budget coverage.
- PostgreSQL: 102 tests across `generation-response-contract-failures`, `generation-repository` and `preset-generation-workflow` passed with the normal per-file database isolation and a deterministic HTTP provider. Coverage includes append/replacement, Story Direction, choice repair, RPG/event/continuity operations, recovery/reclaim, exact durable request evidence, costs, rejection non-mutation and owner/campaign isolation.
- TypeScript, repository `pnpm check`, `pnpm build`, documentation relative-link checks and `git diff --check` passed. Nested pnpm commands used a temporary Corepack shim for the pinned 12.4.1 version. The build retained its existing chunk-size warning.
- Independent review found no actionable correctness findings; it also passed TypeScript and 59 focused unit tests.
- Browser: not run; no UI changes.
- Live OpenRouter: not run; this does not establish live-provider dialogue quality or provider-side routing behavior.

The shared test database credentials were stale. Verification used a task-owned localhost PostgreSQL container with the same pgvector image. A temporary Vitest config retained the repository integration config and per-file isolation, replacing only automatic shared-service startup.

References: [OpenRouter presets](https://openrouter.ai/docs/guides/features/presets), [Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [implementation plan](../../superpowers/plans/2026-09-23-story-preset-schema.md).
