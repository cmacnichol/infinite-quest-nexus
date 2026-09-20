# Task 4A report: neutral v2 schema admission and catalog

Base: `338a6cef` on `codex/native-openrouter-presets`.

## Delivered

- Preserved every v1 response-format, queued/frozen contract, reader, hash, and projection schema unchanged.
- Added parallel v2 typed schema admission: `model_verified` carries exact v2 verification evidence, while `preset_trusted` always selects `json_schema` and has no inventory, advertisement, or verification-record input.
- Added `normalizeNewTextResponsePolicy` for new work only. Direct Models default to `required`; explicit Model `legacy` and `auto` remain explicit compatibility choices; a Preset cannot inherit a downgrade.
- Added exact v2 direct-model verification tuple checking for provider, endpoint, model, route configuration, operation, schema digest, streaming, expiry, and Story native-tracker support.
- Added an immutable v2 provider-wire catalog with strict named envelopes and stable SHA-256 digests. Existing Story, choices, and continuity envelopes are structurally identical to v1, including open tracker objects and whitespace-preserving evidence locations/quotes.
- Added v2 prepared, queued, and frozen contracts. They reject unknown operations, unknown versions, duplicate invocation keys, admission/authority mismatches, mismatched provider identity, altered schema body/digest/version/name, and non-catalog schemas. The v2 policy is always schema-only; there is no JSON-object representation or fallback.
- Added exact hash readers for route bases and plans, plus `assertPresetResponseContractAuthorityBinding`. Task 4B/4C must call that pure boundary with the saved basis and final operation plan; a hex-shaped plan hash alone is insufficient.

## V2 catalog and caller map

| Schema operation | Invocation key(s) | Current caller / initial and repair identity |
| --- | --- | --- |
| `story` | `story:nonstream`, `story:stream` | Primary Story generation, recovery, semantic repair, event extension, and scene-coverage rewrite share the complete Story envelope. |
| `choices` | `choices:nonstream` | Story choice repair. |
| `continuity_review` | `continuity_review:nonstream` | Continuity review; existing review/repair flow retains its separate Story repair envelope. |
| `rpg_assessment` | `rpg_assessment:nonstream` | RPG Action assessment. |
| `event_trigger_before` | `event_trigger_before:nonstream` | Before-generation event evaluator. |
| `event_trigger_after` | `event_trigger_after:nonstream` | After-generation event evaluator. |
| `scene_coverage` | `scene_coverage:nonstream` | Story Direction scene coverage evaluation. |
| `event_coverage` | `event_coverage:nonstream` | After-event coverage evaluation and its repair decision; deliberately distinct from scene coverage. |
| `world_outline` | `world_outline:nonstream` | World outline initial request and invalid-output repair. |
| `world_seed_character` | `world_seed_character:nonstream` | Per-seed world character expansion initial request and repair. |
| `standalone_character` | `standalone_character:nonstream` | Standalone/existing character authoring initial request and repair. |
| `character_organizer` | `character_organizer:nonstream` | Character profile organizer initial request and repair. |
| `source_extraction` | `source_extraction:nonstream` | Source chunk extraction initial and evidence/schema repair. |
| `source_synthesis` | `source_synthesis:nonstream` | `source:synthesis` initial and repair. |
| `source_character` | `source_character:nonstream` | `source:character:<fact-id>` initial and repair; intentionally reuses the source-synthesis wire envelope while retaining a distinct operation identity. |
| `illustration_prompt_refinement` | `illustration_prompt_refinement:nonstream` | Fiction-only illustration prompt refinement; one strict `{ image_prompt }` envelope. |

## TDD and verification

RED:

1. `corepack pnpm exec vitest run tests/unit/preset-response-format.test.ts` failed because the neutral v2 catalog did not yet exist.
2. The direct policy/profile integrity regression failed before the queued v2 parser bound `providerProfileId` to model authority.

GREEN:

```text
corepack pnpm exec vitest run tests/unit/preset-response-format.test.ts tests/unit/provider-response-format.test.ts tests/unit/generation-response-contract-preflight.test.ts tests/unit/provider-output-schema.test.ts
# 4 files passed, 54 tests passed

corepack pnpm --filter @infinite-quest/contracts check
corepack pnpm --filter @infinite-quest/application check
git diff --check
```

The new focused suite recomputes every catalog digest with Node crypto and an independent canonical fixture, checks Story/choices/continuity v1 envelope parity, uses AJV valid and malformed fixtures for all 16 operations, verifies trusted-preset bypass with absent/negative metadata, verifies direct-model tuple mismatch failure, and rehashes outer frozen selections before tamper cases.

No PostgreSQL, browser, worker dispatch, live provider call, paid inference, UI change, database change, or runtime feature enablement was performed.

## Pending adoption

- **Task 4B:** Build and persist a complete v2 closure for every Story call before dispatch; route both direct `model_verified` and `preset_trusted` selections through it, bind exact operation schemas, validate preset authority with the exported basis/plan binding seam, and retain v1 behavior for historical jobs.
- **Task 4C:** Adopt the same neutral contracts before every non-Story initial/repair body and source chunk budget calculation. This includes direct Models and trusted Presets for authoring, organizer, source extraction/synthesis/character, and illustration refinement.
