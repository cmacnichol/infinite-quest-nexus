# Prompt system audit — 2026-09-25

Read-only audit of InfiniteQuest's prompt infrastructure and the prompts that production currently uses. Repository `C:\Git\InfiniteQuest`, HEAD `1ce3893c`, with an uncommitted working tree (38 modified files, 8 untracked; preserved). The audit made no provider calls, prompt or setting changes, campaign edits, or accepted-turn changes. Database access used `default_transaction_read_only=on`. The report contains hashes, identifiers, and structural metrics. It contains no story prose or credentials.

Starting leads were verified rather than repeated: [Mindy dialogue audit](mindy-transferred-dialogue-audit-2026-09-25.md), [tone audit](turn-generation-tone-audit-2026-09-23.md), and [tone update](turn-generation-tone-update-2026-09-23.md).

> **Update (same day):** the authorized Step 1 probe ([structured-output escape probe](structured-output-escape-probe-2026-09-25.md)) resolved F1's mechanism and F11:
> - Schema-constrained decoding on this route produces no escapes with or without the `pattern`, and with `strict:false`. **R2's pattern removal would not fix F1.**
> - OpenRouter does inject the preset system prompt server-side.
> - A strict schema with typographic quotes and a `narration_paragraphs` array returned all fields with quoted, paragraphed dialogue in 4 of 4 samples.
>
> The findings below are otherwise unchanged.

Line references point to the current working tree. Some cited files have uncommitted changes: `story-prompt.ts`, `prompt-library.ts`, `provider-request.ts`, `context-budget.ts`, and `story-continuity-review-adapter.ts`.

---

## 1. Executive findings

Findings are ranked by severity, then confidence. Each finding is labeled with one of these classes:

- **Defect:** confirmed incorrect behavior.
- **Gap:** a demonstrated contract gap.
- **Contributor:** plausible, but needs a controlled experiment.
- **Improvement:** optional.

| # | Finding | Class | Severity | Confidence |
|---|---|---|---|---|
| F1 | Under the strict `json_schema` Story contract, the model emits **no JSON escape sequences at all**: no `\"` and no `\n`. Missing dialogue quotes are one visible result. Quotes disappeared at the first strict-schema turn in every affected campaign while the writer prompt stayed the same. | Defect (observed behavior); mechanism is a Contributor | Critical | High for the correlation; mechanism unproven |
| F2 | Acceptance cannot detect F1. The parser accepts unquoted, unbroken narration, and the paragraph formatter then synthesizes paragraphs. That hides the second symptom and splits paragraphs without regard to speaker. | Gap | High | Confirmed |
| F3 | An application-scope override of `story_system` or `event_extension` is always acknowledged under the legacy identity. Every campaign is Story Memory–enrolled, so that override **blocks generation** (HTTP 409) for any campaign without its own override. Users work around this by copying the prompt into per-campaign overrides. | Defect | High | Confirmed (code, reproduction, production log) |
| F4 | Production runs **uncommitted** prompt text. The deployed image matches the dirty working tree, not HEAD. | Defect (deployment provenance) | High | Confirmed (hashes) |
| F5 | Shipped prompt defaults no longer reach the primary writer for any active campaign. Stale campaign overrides freeze older text, including the pre-update text in four campaigns. | Gap | Medium-High | Confirmed |
| F6 | Campaign `3bb3c3e5` has a mixed override set. The writer was reset to the old HEAD text on 09-24 at 02:57Z, while six siblings from the 09-23 tone update remain. Three of those six are unreachable (see F7). | Gap | Medium | Confirmed state; cause unknown |
| F7 | The three `story_recovery_*` templates have been unreachable since `ea905754` (2026-09-18). They are still editable, frozen into snapshots, and part of the protocol hash. The 09-23 tone update's recovery overrides therefore have no effect. | Gap | Medium | Confirmed |
| F8 | The **AI refinement prompt** field in illustration settings is saved but never sent to any model. Segment jobs use the prompt-library template. The two shipped defaults also differ. | Defect | Medium | Confirmed (code) |
| F9 | Continuity repair does not receive the campaign writer prompt, the Story Memory mandatory contract, or the dialogue rules. Its request carries only the repair template, the boundary contract, and the cast contract. The path has never run in production because no review has returned `conflict`. | Gap | Medium | Confirmed (code); not exercised live |
| F10 | The prompt preview shows neither the effective runtime system prompt nor the runtime envelope. It omits the preset, the Story Memory and cast contracts, and the story-only supplement, and it has no campaign scope. It also rejects the continuity keys. | Gap | Medium | Confirmed |
| F11 | Requests use `@preset/<slug>` routing **and** compose the preset's system prompt locally. OpenRouter does not document how it merges a preset system prompt with a supplied system message, so the preset text may be applied twice. The remote preset can also change after capture without changing the request hash. | Contributor | Medium | Unverified (needs a provider probe) |
| F12 | Continuity review returned `unavailable` for 5 of 14 reviews under `json_schema`, versus 1 of 78 before. Exact-quotation citations may be impossible if escapes cannot be emitted. | Contributor | Medium | Correlation only; no reason is recorded |
| F13 | Event-coverage validation reuses the `scene_coverage` system prompt, which is framed around "a required scene direction". | Gap (instruction mismatch) | Low-Medium | Confirmed |
| F14 | The fact-wire contract appears twice in Story Memory prompts built on the shipped default or any override that copies it. `CAST_DISCOVERY` claim attribution depends on quoted dialogue, which F1 removes. | Improvement / Contributor | Low | Confirmed (duplication) |
| F15 | Dead or duplicate prompt code, and unreachable catalog entries (`recoveryInstruction`, `mechanics.ts` constants, `SCENE_COVERAGE_SYSTEM_PROMPT`, `world_roster_supplement`, and three `infinite_worlds_*` templates). `turn_intent` is still part of the protocol hash. | Improvement | Low | Confirmed |

### How this changes the Mindy incident conclusion

The previous audit concluded that the model ignored delivered instructions and that paragraph formatting was not involved. Two facts it did not examine change that conclusion.

- **The raw turn-24 response contained zero backslashes.** Job `2111ff69-229c-4962-b65c-439ee3e30c6b` produced 14,124 characters with no `\n\n` paragraph breaks and no `\"`. The prompt explicitly requires both. The stored narration's paragraphs were created by `formatNarrationParagraphs` (`packages/story-engine/src/narration-formatting.ts:36-80`).
- **Every turn this campaign ever generated used the strict schema.** Turns 19–24 are its only generated turns; turns 15–18 are transfer imports with `import_metadata` and no job. The historical contrast therefore lines up with the response-format change, not with prompt versions.

Prompt delivery is confirmed correct. The failure is most likely at the **provider structured-output decoding boundary**, not model disobedience of instructions. Acceptance policy then failed to detect it. Recent unquoted history is still a possible reinforcing factor, but it cannot explain the missing paragraph breaks, which history does not suppress.

---

## 2. What "current prompts" means: six layers compared

### 2.1 Committed source, checkout, and deployed runtime

The deployed container is `infinitequest-infinitequest-app-1`, image `infinitequest-nexus:local`, built 2026-09-24T02:27Z. It runs `dist/services/runtime/src/main.js`. HEAD `1ce3893c` was committed 2026-09-23T23:55Z.

Catalog defaults were extracted by importing each tree's modules: HEAD through `git archive`, the working tree through `tsx`, and deployed code through `/app/dist` via `docker exec`. The table shows length / SHA-256 prefix.

| Template or constant | HEAD `1ce3893c` | Deployed dist | Working tree | Max |
|---|---|---|---|---|
| `story_system` (`STORY_SYSTEM_PROMPT`) | 5148 / `10d3f89bb64a084a` | 6606 / `e7fe362d1f4e8f45` | 6606 / `e7fe362d1f4e8f45` | 16000 |
| `STORY_PROSE_GUIDANCE` | 1129 / `b19e200d11b3e6c2` | 2587 / `80de0cc6f1e468c6` | same as deployed | — |
| `story_recovery_output_limit` | 1532 / `6e217139` | 2990 / `9baaaafc` | same | 4000 |
| `story_recovery_mechanics` | 1512 / `b866bae8` | 2970 / `830ea316` | same | 4000 |
| `story_recovery_schema` | 1625 / `52680dc3` | 3083 / `7f4633a1` | same | 4000 |
| `event_extension` | 1780 / `f40214fb` | 3238 / `18d4a87d` | same | 8000 |
| `scene_coverage_rewrite` | 1622 / `af82a93a` | 3080 / `d2d01a6d` | same | 4000 |
| `story_continuity_repair` | 279 / `17c67cd1` | 3161 / `586b4ff0` | same | 8000 |
| All other 21 catalog keys, `CAST_DISCOVERY_SYSTEM_PROMPT`, the Story Memory / cast / fact-wire contracts, and the story-only supplement and choice repair | identical in all three | | | |

Other uncommitted runtime changes are also deployed:

- `context-budget.ts` `additionalRequestTokens`
- removal of the 16,384-token review output cap in `provider-request.ts`
- migration `0112_continuity_review_opt_in.sql`

The parser and formatter hashes match the Mindy audit: `output.js` `2483174f…`, `narration-formatting.js` `878ba5cc…`. **Conclusion (F4):** the deployed prompt text comes from uncommitted changes. HEAD cannot rebuild production, and a rollback to HEAD would silently revert the dialogue-quote rule and the natural-conversation guidance.

Protocol constants are the same in all three layers: `story-v16-fact-wire-distinction`, and `story-v17-campaign-cast` for cast. Template text changes still alter job identity, because template hashes are part of `prompt_protocol_version` (`prompt-repository.ts:218-221`).

### 2.2 Stored overrides

There are 19 rows in `prompt_template_overrides`, all under one owner. Hashes are SHA-256 prefixes of `content`.

| Key | Scope | Campaigns | Length / hash | Acknowledged identity | Updated (UTC) |
|---|---|---|---|---|---|
| `story_system` | application | — | 14165 / `6cd32c6248f1da19` | `…\|current-continuity-v2` (**legacy**) | 09-24 03:42 |
| `story_system` | campaign | `ccaab0b2`, `7c4d176b`, `6e77e73f` | 14165 / `6cd32c6248f1da19` | `…\|current-continuity-v3` | 09-24 03:43 – 09-25 03:58 |
| `story_system` | campaign | `3d50da66` | 13363 / `b2cdf98d88a1e651` (formatting variant of the above) | v3 | 09-24 03:36 |
| `story_system` | campaign | `bad78cd4`, `852dd4c4`, `1d8340fd`, `3bb3c3e5` | 5148 / `10d3f89bb64a084a` (**= old HEAD default**) | v3 | 09-21 – 09-24 02:57 |
| `event_extension` | campaign | `3bb3c3e5` | 3387 / `a54b5ce5` | v3 | 09-24 00:13 |
| `story_recovery_output_limit` / `_mechanics` / `_schema` | campaign | `3bb3c3e5` | 3139 / `01b992cf`; 3119 / `9a3fcd24`; 3232 / `4a79a437` | none required | 09-24 00:13 |
| `scene_coverage_rewrite` | campaign | `3bb3c3e5` | 3229 / `eefc8e36` | none required | 09-24 00:13 |
| `story_continuity_repair` | campaign | `3bb3c3e5` | 3310 / `ac7056f5` | none required | 09-24 00:13 |
| `illustration_refinement` | campaign | `b197b78e`, `28e38c87`, `05211125` | 1492 / `d718894a` (= shipped) | — | 07-24 |
| `illustration_refinement` | campaign | `eb7b0bce` | 1493 / `d8b28c9c` (differs by one character) | — | 07-24 |

All stored acknowledgement hashes match their content.

#### Effective primary-writer prompt for a newly queued job

This follows campaign → application → shipped precedence (`prompt-repository.ts:141-148`). All 55 campaigns are Story Memory–enrolled.

- **8 campaigns** use their campaign `story_system` override. Three distinct texts are in use: `6cd32c62`, `b2cdf98d`, and `10d3f89b`.
- **The other 47** resolve to the application override. Its legacy acknowledgement fails the Story Memory check, so enqueue **returns 409** (F3).
- **No campaign can currently use the deployed shipped `story_system` (`e7fe362d`).** The application override shadows it everywhere.

#### Frozen prompts in existing jobs

The latest job per active campaign froze these writer prompts:

| Campaign | Writer prompt frozen by its latest job |
|---|---|
| `6e77e73f`, `ccaab0b2`, `7c4d176b` | `6cd32c62` |
| `3d50da66` | `b2cdf98d` |
| `3bb3c3e5` | `1fe14375`, the tone-update text that no longer exists in the override table |
| `bad78cd4`, `852dd4c4`, `a077b146` | `10d3f89b` |
| Older campaigns | `3309a724`, `dba64898`, `5f376089`, `7fb37c01`, or `1ecbf471` |

Because jobs freeze snapshots, prompt edits never reach existing jobs. `readPromptSnapshot` refuses to fill missing entries from the current catalog (`prompt-library.ts:162-191`).

### 2.3 Serialized provider request (verified transport bytes)

`prepared_text_physical_attempts.request_body` stores the exact string posted by `providerFetch`: `providers.ts:770` sends `prepared.body`. Its stored `request_payload_hash` matches `sha256(request_body)`.

For job `2111ff69…`, reservation `2111ff69…:720f31ef…`, the stored body is 266,072 characters:

- **Top-level parameters:** `model:"@preset/nexus-nsfw"`, `temperature 0.8`, `max_tokens 48000`, `presence_penalty 0.1`, `repetition_penalty 1.1`, `stream:true`, and `response_format.json_schema` named `infinite_quest_story_native_v2` with `strict:true`. The schema's `narration` is `{"type":"string","minLength":1,"maxLength":200000,"pattern":"^\\S(?:[\\s\\S]*\\S)?$"}`.
- **Returned identity:** model `z-ai/glm-5.2`, provider route DeepInfra.
- **`messages[0]` (system, 18,889 characters),** in order:
  1. The preset system prompt: 700 characters, a storyteller role plus content policy, hash `4dda9330`.
  2. The campaign `story_system` override, complete and byte-identical: `6cd32c62`, 14,165 characters.
  3. The story-only supplement: `aedf7a68`.
  4. `STORY_MEMORY_MANDATORY_CONTRACT`: `a196de7a`.
  5. `CAST_STORY_AUTHORITY_CONTRACT`: `5ebf8d39`.
- **`messages[1]` (user, 241,325 characters):** a single JSON string with keys in this order:
  - `authoritative_context` (238,751): `authoritativeRules`, `worldCanon` (includes `tone`), `selectedCharacterAuthority`, `currentContinuity`, `currentScene` (15,695), `recentTurns` (31,755), `chronicle` (177,793)
  - `narration_length`
  - `instructions` (14 items)
  - `current_turn_input` (mode `scene`)
  - `task`

This request is the verified app-side transport payload. What OpenRouter does server-side with `@preset/nexus-nsfw` is not observable (F11).

---

## 3. Operation / prompt coverage matrix

Overrides: **A** = application override allowed, **C** = campaign override allowed. "Frozen" means the prompt is captured in the job's `prompt_snapshot` and bound by hash.

| Operation | Prompt source | Runtime caller | Overrides | Appended contracts / composition | Output validation | Status |
|---|---|---|---|---|---|---|
| Story generation (primary) | `story_system` (`prompt-library.ts:297`, `story-prompt.ts:65-93`) | `generation-executor-adapter.ts:2277-2290` | A, C; acknowledgement required | preset prefix (`text-execution-plan.ts:102-107`); story-only supplement (`story-only-prompt.ts:63-74`); Story Memory contract (+ cast) (`story-prompt.ts:335-348`), or the fact-wire contract for non-enrolled jobs with a non-shipped writer (`executor:2008-2014`) | strict schema → `parseStoryOutput` (`output.ts:185-203`): Zod shape, mechanics leak check, paragraph formatter | **Active**, all 55 campaigns |
| Story recovery: output limit, mechanics, schema | `story_recovery_*` (`prompt-library.ts:298-300`) | `recoveryPromptFromSnapshot` (`executor:792`) has **no callers**; removed in `ea905754` | A, C | would be the final user message; temperature 0.2 (`provider-request.ts:239`) | — | **Unreachable** (last `schema_repair` attempt 2026-09-17) |
| Structure retry | Replays the reserved primary body | `executor:3021-3040` | — | identical bytes | as primary | Active |
| Clean regeneration (over budget) | `CLEAN_REGENERATION_REQUIREMENT` (`provider-request.ts:167`) | `provider-request.ts:436` | none | drops the rejected draft | as primary | Active, conditional |
| Story Direction choice repair | `CHOICE_REPAIR_SYSTEM` (`story-only-prompt.ts:21-28`), frozen in `generation_policy` | `executor` `choiceRepairPreparedRequest` | none (hash-verified) | Story Memory contract minus fact-wire (`story-only-prompt.ts:76-89`) | `choices` schema | Active (1 job since 09-18) |
| RPG assessment | `rpg_assessment` (`:301`) | `executor:2489` | A, C | none | `rpg_assessment` schema | Legacy play mode only; no recent use |
| Event trigger (before / after) | `event_trigger` (`:302`) | `executor:1849` | A, C | none | trigger schema | Legacy play mode |
| Event extension | `event_extension` (`:303`) + prose guidance | `executor:3968` | A, C; acknowledgement required | preset | story schema + prefix preservation | Legacy play mode |
| Scene coverage validation | `scene_coverage` (`:305`) | `executor:3497, 3601` | A, C | none | coverage schema | Active (Story Direction) |
| Event coverage validation | **reuses** `scene_coverage` | `executor:3741, 3875, 4040…` | A, C | none | event coverage schema | Legacy (F13) |
| Scene coverage rewrite | `scene_coverage_rewrite` (`:306`) as `recoveryInput` | `executor:3536, 3815, 4165` | A, C | rejected draft as assistant message; validator JSON marked untrusted | story schema | Active, conditional |
| Turn intent | `turn_intent` (`:304`) | removed; the API returns 410 (`prompt-repository.ts:249`) | hidden | — | — | **Removed**, but still in `RUNTIME_KEYS` (`prompt-repository.ts:37-40`) |
| Continuity review | `story_continuity_review` (`:340`), frozen as a pair | `story-continuity-review-adapter.ts:132-146` | A, C; no acknowledgement | `CONTINUITY_REVIEW_CONTRACT` + cast | review schema | Active (92 reviews) |
| Continuity repair | `story_continuity_repair` (`:341`) | `story-continuity-review-adapter.ts:74-86` | A, C | boundary contract + cast only (F9) | story schema | Reachable; **never executed** (no `conflict` verdicts) |
| Cast discovery and backfill | `CAST_DISCOVERY_SYSTEM_PROMPT` (`prompt-library.ts:31-37`) | `campaign-cast-discovery-adapter.ts:25, 56` | none; plan-hash bound | preset | `cast-discovery-v1` schema | Active (29 physical attempts) |
| World generation / recovery / generated character / character | catalog `world_*`, `character_generation` | `authoring-composition.ts:67-72`, `provider-world-generation-adapter.ts` | A only | `appendAuthoringContract` (`authoring-prompts.ts:38-58`) | authoring schemas | Active |
| World roster supplement | `world_roster_supplement` (`:311`) | none found | A | — | — | **Unreachable** |
| Source extraction / recovery / source world | catalog `source_*` + `SOURCE_*_CONTRACT` | `authoring-composition.ts`, `authoring-stage-adapter.ts` | A | authoring contract | evidence-ID validation | Active |
| Character profile organizer / repair | catalog | `provider-character-organization-adapter.ts:252-256` | A | organizer contract | evidence substring checks | Active |
| Infinite Worlds conversion / recovery / batch | catalog (`:318-320`) | none found | A | — | — | **Unreachable** |
| Import final-turn enrichment | `infinite_worlds_final_turn` (`:321`) | `api-portable-import-export-composition.ts:302` | A | none; imported narration is sent without an untrusted-data instruction | — | Active |
| Illustration refinement (text model) | `illustration_refinement` (`:322`) from the job or campaign snapshot | `executor:2118`; `illustration-segment-job-adapter.ts:293, 1471` | A, C | preset | `{image_prompt}` schema | Active; the config field is ignored (F8) |
| Illustration direct / character reference (image endpoint) | `illustration_direct`, `illustration_character_reference` | `illustration-segment-job-adapter.ts:532, 556`; `domain/illustrations.ts:111-120` | A, C | — | — | Active |
| Chronicle, summaries, embeddings, retrieval, fact-format repair | no text-generation prompt found (grep for `systemPrompt` in memory, chronicle, and fact-repair modules) | — | — | — | deterministic | N/A |

Test coverage for these paths is concentrated in the prompt-library, prompt, story-only, preset, story-output, narration-formatting, output-schema, authoring-prompt, coverage, continuity, and budget unit tests. No test covers:

- escape emission under the strict schema
- application-scope acknowledgement for enrolled campaigns
- the illustration config prompt reaching a request
- preview-versus-runtime equivalence

---

## 4. End-to-end evidence for key findings

### F1 — the strict schema removes escape sequences

This is a cross-campaign table of completed jobs since 2026-08-20. It joins `generation_jobs` → `turns`, with the mode taken from `orchestration_private.frozenResponseContracts`.

| Story response mode | Turns | Turns with zero `"` | Mean `"` per turn |
|---|---|---|---|
| none / json_object (to 2026-09-21) | 857 | 188 (22%) | 33.2 |
| strict `json_schema` with narration `pattern` (from 2026-09-22) | 15 | **15 (100%)** | 0.0 |

The per-campaign transitions hold the writer prompt constant (`10d3f89b` on both sides). Each cell shows turn number and `"` count:

| Campaign | Before (`none`) | After (`json_schema`) |
|---|---|---|
| `bad78cd4` | 18: 62, 19: 58 | 20: **0** |
| `3d50da66` | 9: 44 | 10: **0**, 11: **0** (new prompt `b2cdf98d`) |
| `3bb3c3e5` | 37: 26, 38: 16 | 39: **0**, 40: **0**, 41–42: **0** (tone prompt `1fe14375`) |
| `7c4d176b` | 19: 16, 20: 18 | 21: **0** (prompt `6cd32c62`) |
| `ccaab0b2` | turns 15–18 were imported | 19–24: all **0** across three prompt versions |

Raw output analysis covers `generation_attempts.raw_output` since 2026-09-14, parsed field by field:

| Mode | Outputs | Narration has `"` | Narration has a newline | Scratchpad has a newline | Any backslash in raw text |
|---|---|---|---|---|---|
| none | 210 | 185 | 207 | 23 | escapes present (e.g. 16–62 `\"` and 46–174 `\n` per output) |
| `json_schema` | 22 | **0** | **0** | **0** | **0 backslashes in all 22** |

The effect is consistent across providers and model selection:

| Provider route | `@preset/nexus-nsfw` outputs | Explicit `z-ai/glm-5.2` outputs | Outputs containing a backslash |
|---|---|---|---|
| DeepInfra | 13 | 9 | 0 |
| Phala | 3 | 6 | 0 |

Before the switch, the model was requested as `@preset/nexus-nsfw` with no strict contract; the tone audit records the resolved model as `z-ai/glm-5.2` for that period.

Interpretation:

- Missing **newline** escapes rule out "the model ignored the dialogue rule" as a sufficient explanation. The prompt demands `\n\n`, historical context contained paragraph breaks, and the model produced none in 22 of 22 outputs.
- The pattern fits constrained decoding in which the string grammar does not permit escape sequences. That could be caused by how the `pattern` `^\S(?:[\s\S]*\S)?$` (`provider-output-schema.ts:96, 106, 130`, added in `13d3c16f` on 2026-09-19) is compiled, or by the providers' strict-decoding grammar in general.
- The `scratchpad` field has no pattern and also lost newlines. However, 0 of 22 has weak power at a baseline of 11%, so this sample cannot separate the two mechanisms.
- The narration `pattern` duplicates a guarantee that code already enforces locally: `z.string().trim().min(1)` (`story-prompt.ts:107`).

### F2 — acceptance masks F1

A synthetic reproduction (scratch harness, deployed-equivalent working-tree code) produced:

- `parseStoryOutput` returns `ok:true` for quoted narration with paragraphs, and for the same exchange unquoted and unbroken.
- `formatNarrationParagraphs` split a 700-character unbroken text into 4 paragraphs.

Speaker-change breaks depend on `beginsWithDialogue` (`narration-formatting.ts:27-29`), which looks for a leading quote character. Once quotes are gone, synthesized paragraphs ignore speaker changes. For turn 24, the raw output had zero newline characters, and every stored paragraph break came from the formatter.

### F3 — the application override blocks enrolled campaigns

Code path:

1. `promptCompatibilityMode` returns `"legacy"` for application scope (`prompt-repository.ts:68-76`).
2. `listPromptLibrary` therefore advertises the legacy requirement (`:289-303`).
3. The UI echoes the advertised requirement as its acknowledgement (`apps/web/public/nexus.js:1504-1514`).
4. At enqueue, `resolveStoryMemoryPromptSnapshot` → `resolveSnapshot(…, "story_memory")` throws 409 if the *effective* override lacks the Story Memory identity (`:142-146`).
5. Migration 0112's trigger enrolls every new campaign (`0112_continuity_review_opt_in.sql:2-7`), and all 55 existing campaigns are enrolled.

Reproduction (scratch harness with an in-memory database adapter):

```text
R1 application-scope listed ack identity: story-v16-fact-wire-distinction|story-output-v2|current-continuity-v2 acknowledged: true
R1 enrolled campaign enqueue snapshot FAILS: 409 prompt_override_incompatible - The effective prompt override requires compatibility acknowledgement.
R1 control (app override acked with Story Memory identity via API): source= application
```

Production evidence:

- Container log, request `37c77e9c-037c-49c4-8924-f4632f6309a7` at 2026-09-25T03:57:35Z: `POST /api/v1/campaigns/6e77e73f-…/generations` → 409 "The effective prompt override requires compatibility acknowledgement."
- A campaign copy for `6e77e73f` was created 23 seconds later (03:57:58Z), and its job was queued at 03:58.
- The same pattern appears in `created_at` order:
  - The application override was created 09-21 23:20Z.
  - Campaign copies followed at 23:29Z (`bad78cd4`), 09-22 04:24Z (`852dd4c4`, `1d8340fd`), and on 09-24 and 09-25 for the others.

The API itself accepts a Story Memory acknowledgement at application scope (`:337-340`); the UI never offers one.

### F7 — story recovery templates are unreachable

- `grep recoveryPromptFromSnapshot` finds only its definition (`generation-executor-adapter.ts:792`).
- No code dispatches the `"story_recovery"` operation.
- `git log -G` shows removal in `ea905754` ("Remove unreachable automatic recovery dispatch", 2026-09-18).
- `generation_attempts` has no `schema_repair` or `mechanics_cleanup` attempts after 2026-09-17.

The keys are nevertheless still hashed into `prompt_protocol_version` (`prompt-repository.ts:37-40, 218-221`). Editing them also invalidates model chains (`:78-87`).

### F8 — the illustration config prompt is ignored

- The web-next campaign editor exposes **AI refinement prompt** (`apps/web-next/src/campaign-editor-page.ts:304`).
- The value is persisted to `campaign_illustration_configs.refinement_prompt`: 13 rows, 2 distinct values, hashes `ea676b60`/1420 and `d18e8909`/1421.
- It is projected back in `imageConfig` (`illustration-segment-job-adapter.ts:341`).
- The only system prompts sent for refinement come from `promptContent(snapshot, "illustration_refinement")` (`:293, 1471`; `generation-executor-adapter.ts:2118`).
- `grep '\.refinementPrompt'` finds only persistence and echo sites.
- The two shipped defaults differ: `DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT` (`contracts/src/generation.ts:133`, 1420 / `ea676b60`) versus the catalog `illustration_refinement` (1492 / `d718894a`).

### F9 — continuity repair lacks the writer contract

The repair system prompt is `repairPrompt.content + "Repair boundary contract v1 … Return the complete required story JSON." + castContract` (`story-continuity-review-adapter.ts:74-76`). It does not include:

- the campaign `story_system`
- `STORY_MEMORY_MANDATORY_CONTRACT` (fact-wire and authority rules)
- the dialogue-format rules

The strict schema enforces shape, but a repaired turn would be written without the rules the original writer received. The deployed default repair template now includes `STORY_PROSE_GUIDANCE`, which carries the quotation rule; overrides may not. Production has 92 reviews with verdicts `pass` 69, `uncertain` 18, and `unavailable` 6, and no `conflict`. Repair has never run.

### F11 — preset composition and remote dispatch

- `deriveTextExecutionPlan` prefixes `presetSystemPrompt` (`text-execution-plan.ts:110-112`).
- Remote routing sends `model:"@preset/<slug>"` (`provider-request.ts:349, 495`).
- OpenRouter's preset documentation describes shallow parameter merging but not system-prompt merging. If OpenRouter also applies the preset's own system prompt, the model receives it twice. If the preset is edited remotely, the captured `presetSystemPrompt` and `configHash` no longer describe what OpenRouter applies. The [preset correction note](native-openrouter-presets/story-preset-schema-correction.md) acknowledges the second risk.
- The preset text asks the model to "drive the plot". That competes with the writer prompt's restraint instructions, such as not introducing major unrequested developments, though the writer prompt comes later.

### F14 — duplicated fact-wire contract

`composeStoryMemorySystemPrompt(shipped story_system, "", cast)` contains `STORY_FACT_DELTA_WIRE_CONTRACT` **twice**: once inside `STORY_SYSTEM_PROMPT` (`story-prompt.ts:91`) and once inside the mandatory contract (`:54`). The composed prompt is 9,998 characters. The `6cd32c62` override restates the same rules in its own words, followed by the appended contract.

---

## 5. Instruction quality and consistency

The primary effective prompt (`6cd32c62`) was read in full. It is well structured:

- an explicit five-level priority list
- "Historical facts constrain what happens. Historical prose does not dictate how to write it."
- conditional dialogue guidance that forbids forcing dialogue into solitary or nonverbal scenes
- a clear quoted/unquoted example with the JSON-escaped form
- "Thoughts and ordinary narration do not need dialogue quotation marks"

It does not require every turn to contain quotes.

Conflicts and weaknesses found:

1. **Instruction/decoder conflict (F1).** The prompt requires `\"` and `\n\n` escapes. The strict-schema path appears unable to produce them. Additional emphasis in the prompt cannot resolve a decoding constraint. The 12,178- and 14,165-character strengthening edits made in response were aimed at the wrong layer.
2. **Preset vs. writer role.** The preset says "Your job is to drive the plot". The writer and user envelope repeatedly say to end early and avoid unsupported developments. This is not the most severe conflict, but it is an unacknowledged competing objective at the top of the system message.
3. **World tone vs. presentation.** `worldCanon.tone` still requests a clinically detached narrative voice (tone audit, confirmed present in the turn-24 user payload). `6cd32c62` explicitly gives its presentation rules precedence. The old `10d3f89b` text used by four campaigns has no such precedence clause.
4. **Redundancy.** Authority rules are stated in the override, again in the Story Memory contract, and a third time in the user `instructions` array. The same applies to the fact-wire rules. Redundancy is not proven to hurt compliance, but it inflates every request by about 4,000 characters and makes the effective hierarchy hard to audit.
5. **Recovery-path divergence.** Scene rewrite and extension run under the writer's system prompt with the rewrite template as the last user message. Continuity repair gets neither the writer prompt nor the mandatory contract (F9). The `3bb3c3e5` sibling overrides embed a campaign prose direction that its current writer prompt (`10d3f89b`) does not have (F6).
6. **Event coverage framing (F13).** The validator is told it checks "a required scene direction" while the input is `required_events`.
7. **Trust boundaries.**
   - Turn intent, scene coverage, cast discovery, authoring, and source prompts explicitly mark supplied text as untrusted data.
   - The primary writer receives user and story text inside a JSON user message with authority labeling, which is appropriate.
   - `infinite_worlds_final_turn` sends imported narration with no untrusted-data instruction (`api-portable-import-export-composition.ts:302-310`). This is low risk, because output is limited to choices and an image prompt.
   - Campaign overrides are owner-authored and can fully replace creative text. Mandatory contracts are appended afterward, and schemas enforce shape. No path was found where story content gains system-prompt authority.

---

## 6. Contracts versus enforcement

| Requirement | Where stated | Enforcement |
|---|---|---|
| Output JSON shape and field types | writer prompt, schema | **Hard:** provider strict schema plus local Zod (`story-prompt.ts:106-126`) |
| Exactly 4 choices | prompt, schema | **Hard** |
| `superseded_facts` empty; supersession only for visible IDs | prompt, contract | **Hard:** schema `maxItems:0`; Zod refine; `sentCanonicalFactIds` (`executor:851-930`) |
| No mechanics leakage | prompt | **Hard, heuristic:** `mechanicsLeakErrors` |
| Dialogue in double quotes | writer prompt, prose guidance | **Prompt only;** unverified (F2) |
| Paragraph breaks | writer prompt | **Prompt only;** masked by the formatter (F2) |
| Second-person viewpoint and tense | writer prompt | Prompt only |
| Soft length range | prompt, user envelope | Prompt only (intentional) |
| Scene beats dramatized | user envelope | **Model-reviewed:** scene coverage (Story Direction) |
| Continuity with authority | contracts | **Model-reviewed:** continuity review, when enabled; `uncertain` / `unavailable` are keepable by user decision (`review-policy.ts:3-5`) |
| Extension preserves prefix | template | **Hard:** prefix comparison (`provider-request.ts` event-extension budget; executor) |
| Repair preserves unaffected narration | repair template, prose guidance | **Prompt only;** no diff bound on repair output |

---

## 7. Verification performed

**Passed: focused unit tests.** Command:

```text
node node_modules/vitest/vitest.mjs run tests/unit/prompt-library.test.ts tests/unit/prompt.test.ts tests/unit/story-only-prompt.test.ts tests/unit/preset-prompt.test.ts tests/unit/story-output.test.ts tests/unit/narration-formatting.test.ts tests/unit/provider-output-schema.test.ts tests/unit/authoring-prompts.test.ts tests/unit/scene-coverage.test.ts tests/unit/story-continuity-review-adapter.test.ts tests/unit/story-continuity-review-contracts.test.ts tests/unit/provider-request-budget.test.ts tests/unit/context-budget.test.ts tests/unit/preset-response-format.test.ts tests/unit/generation-response-contract.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
```

Result: 15 files, 210 tests passed. These tests show that instructions are delivered and contracts are shaped as intended. They say nothing about live-model compliance.

**Reproduced with a temporary scratch harness (not committed; synthetic data):**

- R1: application-override 409 for an enrolled campaign
- R2: parser accepts unquoted, unbroken narration; formatter synthesizes paragraphs
- R6: duplicated fact-wire contract

**Passed read-only runtime checks:**

- deployed-versus-HEAD-versus-worktree catalog hashes
- the override inventory
- per-job prompt snapshots
- the physical request body for `2111ff69…` (hash-verified)
- escape counts in raw outputs by mode and provider route
- review verdicts
- the Docker log for the 409

**Not run:**

- live provider generation or probes (paid; not authorized)
- browser rendering
- integration or e2e suites; no executable behavior changed

**Temporary artifacts:** a diagnostic script was copied into the app container's `/tmp` and removed afterward. Scratch files were kept outside the repository.

To reproduce the core data, run these read-only queries:

```sql
-- F1: quote counts by response mode
SELECT COALESCE(j.orchestration_private#>>'{frozenResponseContracts,contracts,story:stream,mode}',
                j.orchestration_private#>>'{frozenResponseContracts,contracts,story:nonstream,mode}','none') mode,
       count(*) turns,
       count(*) FILTER (WHERE length(t.narration)=length(replace(replace(replace(t.narration,'"',''),'“',''),'”',''))) zero_quote
FROM generation_jobs j JOIN turns t ON t.id=j.result_turn_id
WHERE j.status='completed' AND j.created_at>'2026-08-20' GROUP BY 1;

-- F1: backslashes in raw outputs by provider route
SELECT p.returned_provider_route, count(DISTINCT a.id),
       sum((position('\' in a.raw_output)>0)::int) with_backslash
FROM prepared_text_physical_attempts p JOIN generation_jobs j ON p.reservation_key LIKE j.id::text||':%'
JOIN generation_attempts a ON a.generation_job_id=j.id AND a.raw_output IS NOT NULL
WHERE p.logical_kind='story' AND p.outcome='succeeded' GROUP BY 1;

-- F3/F5: override inventory
SELECT prompt_key, campaign_id IS NULL app, left(campaign_id::text,8), length(content),
       left(encode(sha256(convert_to(content,'UTF8')),'hex'),16), compatibility_protocol_identity, created_at
FROM prompt_template_overrides ORDER BY prompt_key, created_at;
```

### Limitations and unverified operations

- **F1 mechanism:** whether the narration `pattern`, strict decoding in general, or OpenRouter's structured-output layer removes escapes needs a controlled live probe.
- **F11:** OpenRouter server-side preset merging is unobservable from stored data.
- **F12:** review `unavailable` reasons are not persisted in `orchestration_private.continuityReview`.
- **F6:** the reason for the 02:57Z writer reset on `3bb3c3e5` is unknown. No rollback artifact exists beside `tmp/turn-tone-update-plan.json`.
- **Legacy play mode operations** (RPG assessment, event triggers, event extension, event coverage) have no recent production traffic. Their verification is by code and tests only.
- **Authoring and import prompts** were verified by code path and hash. No stored authoring requests were inspected.
- **Deployment diff coverage:** only prompt modules and selected runtime modules were hash-compared.

---

## 8. Recommendations

Recommendations are listed in priority order. Each can be implemented independently.

### R1. Controlled structured-output escape probe (experiment; blocks R2's design choice)

- **Scope:** a small authorized probe with a synthetic story of about 2,000 tokens that includes dialogue. Hold the model (`z-ai/glm-5.2`), provider route (pin DeepInfra and Phala separately), and sampling fixed. Vary the response format:
  - (a) `json_object`
  - (b) strict schema with the current `pattern`
  - (c) strict schema with no `pattern` on free-text fields
  - (d) (c) plus `@preset` routing

  Use about 5 samples per arm. Count `\"`, `\n`, and parse success.
- **Benefit:** identifies the mechanism and the minimum fix.
- **Risk / cost:** about 20 paid calls. Use `scripts/probe-structured-output.ts` infrastructure and add escape metrics. No production state is touched.
- **Requirements:** a controlled model/context comparison; no deployment.

### R2. Remove the `pattern` from free-text schema fields, or route Story narration to a non-grammar mode (infrastructure)

- **Scope:** `provider-output-schema.ts` `text()` for narration, choices, and other prose fields. Keep `pattern` for UUIDs and IDs.
- **Why it's safe:** local Zod `trim().min(1)` already enforces non-blank strings, so the pattern adds no guarantee.
- **Consequences:** this changes schema hashes and the frozen response-contract identity. It requires a response-contract version bump. Queued and historical jobs keep their frozen contracts; the new schema applies only to newly queued jobs. Overrides are unaffected.
- **Tests:**
  - a schema-shape unit test asserting no `pattern` on prose fields
  - contract-hash migration tests
  - the R1 probe as acceptance evidence
- **Rollback:** restore the prior schema version. Jobs already frozen keep whatever they captured.
- **Deployment:** API and worker together.
- **If R1 shows strict decoding removes escapes regardless of pattern,** use `json_object` for Story text operations and keep local strict validation.

### R3. Make escape loss detectable before acceptance (validation)

- **Scope:** a narrow, non-blocking **formatting review** signal in `parseStoryOutput` or the generation review stage.
- **Detection logic:** flag a response when all of the following hold:
  - the raw narration has no line breaks at all and is over about 1,500 characters
  - it contains no `"`, `“`, or `”`
  - it contains a high-precision speech pattern, such as `, <Name> says.`, `? <pronoun> asks`, or a verb-of-speech after a clause ending with `?` or `,`
- **Action:** surface a keepable review reason, for example `dialogue_format_uncertain`, with the candidate preserved. Do not auto-insert quotes and do not require quotes per turn.
- **Required test fixtures:**
  - a solitary scene with no speech (pass)
  - reported speech ("She said she was leaving", pass)
  - italic or internal thought (pass)
  - mixed quoted dialogue and narration (pass)
  - already-correct quoted dialogue (pass)
  - unquoted direct speech with tags (flag)
  - a long unbroken block (flag the newline signal separately)
- **Risk:** false positives on stylized prose. Keep the result advisory and keepable.
- **Also:** record whether the formatter synthesized paragraphs, e.g. a `paragraphsSynthesized` flag in diagnostics, so F2 masking becomes visible.
- **Overrides / recovery:** unaffected.

### R4. Fix application-scope acknowledgement for Story Memory (infrastructure)

- **Scope:** `listPromptLibrary` for application scope should advertise the Story Memory requirement whenever any owner campaign is enrolled, or simply always, since the trigger enrolls every campaign. Alternatively, accept an application override that carries either acknowledgement for the same content hash in `overrideIsCompatible` Story Memory mode. The shape requirement (`story-output-v2`) is identical.
- **Tests:**
  - `prompt-repository` unit test: an application override plus an enrolled campaign yields source `application`
  - integration test for enqueue
- **Migration:** existing application rows acknowledged as legacy need a one-time re-acknowledgement in the UI; do not rewrite them silently.
- **Rollback:** code revert.
- **Deployment:** API.

### R5. Rationalize stored overrides after R4 (operational; user decision)

- **Inventory:** eight per-campaign copies of three texts.
  - `10d3f89b` is the old default, now missing the quotation rule and the natural-conversation guidance. It is used by `bad78cd4`, `852dd4c4`, `1d8340fd`, and `3bb3c3e5`.
- **Approach:** once R4 lets a single application override work, reset campaign copies that equal the application text, only with the user's approval. Keep genuinely campaign-specific text.
- **Separately, for `3bb3c3e5`:** decide whether to restore `1fe14375` or reset the six siblings. The recovery siblings are dead weight until R7.
- **Mechanics:** every change goes through the API with acknowledgement, and each change invalidates chains.

### R6. Commit or revert the deployed uncommitted prompt changes (deployment hygiene)

- **Scope:** the prompt-library and story-prompt diffs, plus the other deployed working-tree changes (context budget, review output cap, migration 0112).
- **Benefit:** production can be rebuilt from source, and a rollback no longer silently drops the quotation rule.
- **Also:** add an image label with the source commit and a dirty-tree flag.
- **Tests:** existing prompt tests already assert the new text.

### R7. Retire unreachable prompt surfaces (cleanup)

- **Remove from the editable library and from `RUNTIME_KEYS`:**
  - `story_recovery_*`
  - `world_roster_supplement`
  - `infinite_worlds_conversion`, `infinite_worlds_recovery`, `infinite_worlds_batch`
  - `turn_intent`
- Keep the snapshot schema keys for historical reads.
- Delete `recoveryInstruction`, the `mechanics.ts` prompt constants, `SCENE_COVERAGE_SYSTEM_PROMPT`, and `recoveryPromptFromSnapshot`.
- **Consequences:** changes `prompt_protocol_version` for new jobs, which invalidates chains once. Keep old snapshots readable.

### R8. Fix the illustration refinement prompt ambiguity (validation/UI)

Choose one source of truth:

- Remove the campaign-config field and use the prompt library.
- Or wire the config value into the frozen illustration snapshot.

Also unify the two shipped defaults. Test that an edited value reaches the refinement request body.

### R9. Give continuity repair the writer contract (prompt/infrastructure)

- **Scope:** compose the repair system prompt as `preset + frozen story_system + story-only supplement + Story Memory contract (+cast) + repair template + boundary contract`. Alternatively, freeze the writer text into the repair pair.
- **Also:** add a mechanical guard that measures unchanged-paragraph ratio against `rejected_final` and flags excessive rewrites.
- **Tests:** continuity-repair adapter snapshot tests.
- **Consequences:** changes the repair protocol identity (`story-continuity-repair-v2`).

### R10. Make preview match runtime (UI/infrastructure)

- Add campaign scope.
- Compose the preview through the same functions the executor uses: preset plan, Story Memory composition, story-only supplement, cast.
- Allow the continuity keys.
- Test that the preview output equals the executor's `storyBaseSystemPrompt` for fixtures.

### R11. Resolve preset double-application (experiment, then infrastructure)

- In the R1 probe, compare responses or usage for `@preset` with and without the locally composed preset prefix. Input-token usage differences reveal whether the preset system prompt is injected server-side.
- If it is, stop composing it locally for remote-routed requests, or record the remote injection in the plan hash.

### R12. Minor prompt fixes

- Give event coverage its own template or adjust the framing (F13).
- Deduplicate the fact-wire contract when the creative prompt already contains it (F14).
- Add an untrusted-data line to `infinite_worlds_final_turn`.
- Persist review `unavailable` reasons (F12).

**Not recommended:**

- another emphasis pass on the quotation paragraph
- any rule requiring quotes in every turn
- automatic quote insertion by regular expression

---

## 9. Proven, uncertain, and next steps

**Proven**

- Prompt delivery for the Mindy job was correct and complete.
- Under the strict schema, all 22 recorded Story outputs contain no escape sequences, across two provider routes and two model-selection modes. Quotes vanished at the schema switch in every affected campaign with the prompt held constant.
- The parser accepts the result, and the formatter hides the missing paragraph breaks.
- Application-scope `story_system` overrides block enrolled campaigns. This is reproduced and observed in production.
- Production runs uncommitted prompt text.
- The recovery templates and the illustration config prompt have no runtime effect.

**Uncertain**

- Whether the narration `pattern`, strict decoding in general, or OpenRouter's structured-output layer causes F1.
- Whether OpenRouter double-applies the preset system prompt.
- Whether the rise in continuity-review `unavailable` verdicts is related to F1.

**Highest-value next steps**

1. Run the R1 probe (about 20 calls).
2. Ship R2 or the `json_object` fallback according to the probe result, together with R3's advisory formatting signal.
3. Fix R4, then consolidate overrides (R5) with the user.
4. Commit the deployed prompt changes (R6).
