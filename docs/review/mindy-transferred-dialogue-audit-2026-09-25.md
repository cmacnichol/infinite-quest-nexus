# Mindy - Transferred: missing dialogue quotation marks

Read-only production audit, September 25, 2026 UTC (September 24 Eastern). No generation, retry, prompt update, campaign edit, or application change was performed. Existing working-tree changes were preserved. This report contains diagnostic metadata, not exported story content.

## Conclusion

The primary model generated direct speech without quotation marks despite receiving explicit quotation instructions and correctly escaped examples. The deployed parser accepted that response, and its parsed narration exactly equals the saved effective narration. The defect originates in model output; paragraph formatting, persistence, and display are not the cause of the missing marks in this turn.

Two distinct findings matter:

1. **Confirmed generation failure:** the model did not obey the delivered dialogue-format instructions.
2. **Confirmed acceptance gap:** quotation formatting is not enforced by the output schema or parser. Valid JSON with unquoted speech passes validation.

Repeated unquoted recent history is a plausible influence on the model, not an experimentally proven cause. This audit cannot establish the model's internal reason for ignoring the instructions.

## Audited record

| Field | Value |
| --- | --- |
| Campaign | `ccaab0b2-e93b-4a0f-a518-2e277e01c759` |
| Accepted turn | 24 |
| Turn ID | `63c39f6d-4b75-44ea-bf86-e3ee8ce174db` |
| Generation job | `2111ff69-229c-4962-b65c-439ee3e30c6b` |
| Queued | 2026-09-25 03:40:03 UTC |
| Completed | 2026-09-25 03:41:32 UTC; September 24, 11:41 p.m. Eastern |
| Provider | OpenRouter |
| Requested model | `@preset/nexus-nsfw` |
| Recorded resolved model | `z-ai/glm-5.2` |
| Attempts | One initial attempt, finish reason `stop` |
| Usage | 58,439 input tokens; 3,496 output tokens |
| Narration | 9,039 characters; 1,611 whitespace-delimited words |
| Double quotation marks | Zero straight or curly marks |
| Narration corrections | Zero |

The campaign remained on turn 24, with this job still latest, at the final database check.

## Trace through the generation pipeline

### Prompt selection and delivery

The job froze the campaign `story_system` override, 14,165 characters, SHA-256 `6cd32c6248f1da19a4b26c291106f833034a929930c6f94756ab730c2c198281`. The campaign override was updated at 03:38:39 UTC, before the job was queued. The application override currently has the same content, but campaign precedence selected the campaign copy.

The persisted primary request contains the complete updated template inside its 18,889-character system message. It explicitly requires opening and closing double quotation marks for every directly spoken utterance, says dialogue tags alone are insufficient, includes decoded and JSON-escaped examples, and warns repeatedly against copying unquoted historical speech. This is not an old-prompt, missing-override, or JSON-escaping delivery failure.

The preset precedes the writer instructions. The appended Story Direction, Story Memory, and cast authority contracts do not instruct the model to remove quotes. The current-input envelope likewise contains no instruction to omit quotation marks. The world tone still requests clinically detached narration, but the writer template explicitly gives its presentation rules precedence over conflicting tone descriptions. That tone may affect voice; it does not explain a requirement to omit quotation marks.

### Context and historical pattern

| Effective turn | Double-quote characters | Captured writer prompt |
| --- | ---: | --- |
| 17 | 48 | No linked generation job found |
| 18 | 40 | No linked generation job found |
| 19 | 0 | 5,148 characters; no explicit double-quotation rule |
| 20 | 0 | Same 5,148-character template |
| 21 | 0 | Same template; one later narration correction |
| 22 | 0 | Same template |
| 23 | 0 | 12,178 characters; explicit quotation rule present |
| 24 | 0 | 14,165 characters; stronger quotation guidance present |

The captured initial model outputs for turns 19–24 also contain zero double quotes. The issue therefore predates the latest prompt update and persisted through two stronger prompt versions. Earlier turns establish a formatting contrast, but missing linked job evidence for turns 17–18 prevents attributing the change to a specific provider or deployment change.

The turn-24 user message is 241,325 characters. It contains turn 23 as the current scene plus turns 21–22 as recent history: 43,645 characters of recent accepted narration, all unquoted. Chronicle adds 42 records, including 11 fiction records totaling 158,897 characters. Two of those fiction records contain no double quotes; nine contain some. Historical context is therefore mixed, not uniformly unquoted, but the immediate examples consistently reinforce the defective format.

This supports a style-inheritance hypothesis. It does not prove that reducing history, changing sampling, or changing models will fix the problem. No controlled provider comparison was performed.

### Provider response and runtime health

The raw response is valid JSON and already contains unquoted direct speech with explicit speaker attribution. It is not merely a scene without conversation. An in-memory replay through the deployed `parseStoryOutput` returned success; the resulting narration exactly matched the database's effective narration.

Recorded parameters were temperature 0.8, presence penalty 0.1, repetition penalty 1.1, and max output tokens 48,000. The provider completed normally in approximately 84 seconds with `outputLimited: false`. Estimated request size was 90,176 tokens against an input allowance of 115,840; actual recorded input usage was lower. There is no evidence of context overflow, truncation, or timeout causing this symptom.

Logs include a long-running-phase warning before successful completion and a cast-discovery admission warning afterward. Neither altered narration. Retrieval succeeded through semantic hybrid search; the omission diagnostic identifies 22 duplicate sources, not lost dialogue instructions.

### Validation and acceptance

The delivered JSON schema constrains `narration` to a nonempty trimmed string, at most 200,000 characters. It has no dialogue quotation requirement. JSON schema validity does not imply that speech inside a string is punctuated correctly.

[parseStoryOutput](../../packages/story-engine/src/output.ts) checks JSON, schema, and mechanics leakage, then uses [formatNarrationParagraphs](../../packages/story-engine/src/narration-formatting.ts). The formatter preserves non-whitespace content; it neither removes nor supplies dialogue marks. The underlying narration contract is in [story-prompt.ts](../../packages/contracts/src/story-prompt.ts).

The deployed parser accepted both members of a minimal in-memory control pair: the same synthetic exchange with quotes and without them. It preserved the quoted control. This isolates the acceptance gap without relying on complex campaign content.

Production validation recorded `valid: true` and zero errors. Continuity review was configured `off`; no continuity repair or other narration rewrite ran. Continuity review concerns factual consistency and would not, by itself, establish dialogue-format compliance. The completed job committed the original candidate.

### Rendering

The [legacy renderer](../../apps/web/src/story.js) splits paragraphs and escapes text through DOM `textContent`. The [replacement renderer](../../apps/web-next/src/story-player-view.ts) creates narration paragraphs from the supplied strings. Neither source path strips dialogue marks. More decisively, marks are already absent in the provider response and stored narration before either renderer runs.

No rendered-browser check was performed. This limits claims about the live UI, but does not weaken the established upstream origin of this defect.

## Verification

- **Reproduced failure:** deployed-parser replay of the actual saved raw output. Diagnostic assertion exited 1: known dialogue-bearing narration had zero double quotes despite parser acceptance.
- **Passed comparison:** parsed actual narration exactly equaled saved effective narration.
- **Passed control:** synthetic quoted dialogue survived parsing unchanged; synthetic unquoted dialogue was also accepted, demonstrating the missing check.
- **Passed focused existing tests:** `node node_modules/vitest/vitest.mjs run tests/unit/narration-formatting.test.ts tests/unit/story-output.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'` — 2 files, 38 tests. These protect parsing and formatting behavior, not model instruction compliance.
- **Passed evidence correlation:** live read-only PostgreSQL inspection, saved request/output comparison, and Docker logs for the exact job.
- **Not run:** fresh live-provider generation, model/context A/B trials, browser checks, or broader integration suites. No executable behavior changed.

Deployed parser SHA-256: `2483174f3261a78f385a5abbcd0c4edeeed79376f20ab11ec76b02cdd0d6eb64`. Deployed formatter SHA-256: `878ba5ccd846ec15ee9579173b632b923a127c71efecf241066374d56139f28b`.

## Recommended next scope

Do not treat another stronger prompt paragraph as an established fix: explicit quotation instructions already reached the model and failed in turns 23 and 24.

For prevention, design a narrow dialogue-format review before acceptance, with a bounded repair or explicit review result when confidently identified direct speech lacks quotation marks. Preserve the candidate and all unaffected wording and state. A blanket requirement that every turn contain a quote would incorrectly reject solitary or nonverbal scenes; blind regular-expression insertion cannot reliably distinguish speech, thought, and narration. Add synthetic regression coverage for these distinctions before implementation.

For causal testing, compare equivalent captured context under controlled changes to recent-history presentation and model selection, holding other parameters fixed and assessing several dialogue-bearing scenes. That experiment can distinguish history influence from model-specific compliance. It remains proposed, not performed.

Repairing the already accepted turn is a separate, explicit narration-correction operation. This audit did not alter it.
