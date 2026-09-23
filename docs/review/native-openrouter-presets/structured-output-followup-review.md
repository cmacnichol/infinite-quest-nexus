# Structured-output follow-up review

Reviewed on 2026-09-21 against the working changes on `codex/preset-admission-deployment`.

## Confirmed failures and corrections

- The legacy prompt editor reset the compatibility checkbox during rendering even when the API returned a saved acknowledgement. It now restores the acknowledgement for the effective saved content in both application and campaign scope. Editing the content invalidates the displayed acknowledgement; discarding edits restores it. Routine rendering preserves a newly checked acknowledgement.
- Production attempts reached OpenRouter with the Story JSON Schema and returned output, but identity validation rejected provider `DeepInfra` against allowed route `deepinfra`. Provider matching now ignores case for both allowed and excluded routes. Model identity remains exact. Failed attempts were not retried or modified during diagnosis.
- Current choices-only repair instructions appended the full Story fact-wire contract, requesting fields absent from the choices schema. The new versioned choices prompt omits that full-output instruction while retaining authority guidance. Historical captured prompt composition remains unchanged.
- Source-extraction catalog descriptions still requested paragraph coordinates despite the evidence-ID contract. The descriptions now request exact supplied evidence IDs.
- Story's per-turn text-selection editor has been removed. Requests use saved provider/profile selection without sending per-turn model, selection, or execution overrides. Settings retain model and preset selection.

## Prompt coverage

| Prompt family | Review result |
| --- | --- |
| Story writer, recovery, event extension, scene rewrite | Reviewed against the current Story wire contract and schema. No further concrete format contradiction identified. |
| Choices repair | Corrected the full-Story versus choices-only contradiction; retained historical composition. |
| Continuity review/repair, RPG assessment, event triggers, scene/event coverage | Reviewed operation-specific contracts and schema mappings. |
| World outline, seed/standalone character, roster supplement, organizer and recovery | Reviewed authoring composition and applicable schemas. |
| Source extraction/recovery, world and character synthesis | Corrected stale extraction descriptions; reviewed evidence-ID instructions and wire mappings. |
| Import conversion, recovery, batch and final-turn enrichment | Reviewed as legacy JSON workflows; this review does not convert them to native structured-output operations. |
| Illustration prompt refinement | Retains its JSON `image_prompt` contract. |
| Direct illustration and character reference | Image instructions rather than JSON text-generation responses; no JSON envelope added. |
| Retired turn-intent instructions | Historical behavior only. |

The configured preset's standard prompt and saved overrides were inspected read-only for format instructions. No additional explicit format contradiction was identified. Private prompt contents are intentionally absent from this report. This is a source/contract review, not proof of narrative quality or universal provider schema compatibility.

## Verification and limits

- Passed: 288 focused unit tests covering legacy management/Story UI, route identity, prompt composition, authoring and output schemas.
- Passed: 54 PostgreSQL integration tests covering prompt-library persistence and generation response-contract failures, using the dedicated feature test database.
- Passed: TypeScript check, repository boundary/data checks, legacy build and whitespace checks.
- Browser preview verified saved checkbox state in both scopes, invalidation on edits and restoration on discard. Story loaded without the per-turn selector and with action controls enabled.
- The updated automated browser test was not executed in this verification run.
- No live inference, production job mutation, deployment or prompt/preset modification was performed. The local build must be deployed before the running application receives these changes.

The default integration harness encountered a test-database credential mismatch. The successful integration run used the existing dedicated feature test database; no existing database was reset.

## 2026-09-22 prompt re-review

Rechecked the shipped catalog, effective authoring contracts, Story/choices and continuity builders, source synthesis/extraction, illustration refinement, and legacy import callers against their transport and output contracts. The native registry contains 16 output shapes; initial and repair invocations share the appropriate shape rather than the full Story envelope.

OpenRouter requires `response_format.type = json_schema` with a named schema; the serializer already includes the schema and `strict: true`. Prompt text does not replace this request setting. Endpoint enforcement and supported schema features vary, so capability checks and local output validation remain necessary. See the [OpenRouter structured-output requirements](https://openrouter.ai/docs/guides/features/structured-outputs).

One additional mismatch was confirmed: `buildStoryOnlyChoiceRepairInput` supplied a one-item `choices` example, despite the prompt and provider schema requiring exactly four. An AJV regression against the actual choices wire schema failed on `minItems: 4` before the fix. New choices-repair inputs now show four distinct slots plus a separate custom suggestion. Both reservation and dispatch use the frozen operation prompt to select the input format; historical prompts retain their previous input bytes.

The earlier fixes removing full-Story output instructions from choices repair and replacing source-extraction coordinate instructions with evidence IDs remain in place. No further concrete shape contradiction was found in the other shipped prompts. Saved custom prompts and remote preset text were not rewritten by this re-review; arbitrary future overrides cannot be certified by static source review.

Legacy import conversion/enrichment continues to request JSON objects through its existing transport. It is not newly enrolled in the native schema registry by this prompt correction. Direct image instructions remain text, as required by their separate image-generation API.

Fresh verification:

- Passed: 217 tests across 11 focused unit suites for prompt composition, schemas, authoring, preset composition and request budgets.
- Passed: 27 PostgreSQL tests in `story-only-choice-repair.integration.test.ts` and `generation-response-contract-operations.integration.test.ts`, using isolated schemas in the dedicated feature test database. These cover durable repairs, schema dispatch and rejected-output state integrity with deterministic providers.
- Passed: TypeScript, repository boundary/data checks and `git diff --check`.
- Live provider inference and deployment were not performed. No visible UI behavior changed in this follow-up.
