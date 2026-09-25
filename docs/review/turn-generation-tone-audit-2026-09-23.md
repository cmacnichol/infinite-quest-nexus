# Turn-generation tone audit — 2026-09-23

Audit target: **Mindy and Mike (Branch Turn 14)**. Repository: `1ce3893c`. Read-only inspection of production data and prompts; no provider requests, campaign edits, or application changes. Times below are UTC unless stated otherwise.

## Finding

The effective prompt does not clearly request natural conversation. It combines an explicit clinically detached world voice with detailed anti-repetition and continuity constraints. The September 16 instruction against imitating previous prose further weakens the earlier voice as a style reference. These are concrete prompt conflicts with the requested experience; their individual causal contributions have not been established by a controlled generation comparison.

The latest cast change did **not** replace the creative system prompt. Comparing the two captured turn-40 requests shows that the only system-message addition was the campaign-cast authority paragraph. The creative template, preset prose, and sampled generation parameters remained the same. Context and transport did change, so this does not prove the cast release had no effect.

## Ranked findings

### 1. Explicit world voice conflicts with the desired delivery

Both captured turn-40 requests contain `authoritative_context.worldCanon.tone` describing the world as bleak and darkly ironic and explicitly requesting **“A clinically detached narrative voice”**. This is a direct style instruction, not just a description of the setting. The same phrase appears in earlier captured requests, including turn 30.

The source path preserves `tone`: `packages/domain/src/world-fiction-reference.ts:98` projects the immutable world overview; `services/runtime/src/generation-context-planner.ts:204` places it in the authoritative context. It is not lost during prompt assembly.

Implication: simply adding “natural conversation” elsewhere leaves competing style directions. Preserve the world's atmosphere while explicitly separating it from narrative delivery and individual character speech. Existing campaigns are pinned to world versions; editing a world draft alone does not update this campaign. Any campaign-specific style change needs an explicit supported override or migration, not a silent immutable-world edit.

### 2. Recent anti-repetition wording suppresses style inheritance too broadly

`packages/contracts/src/story-prompt.ts:58` contains:

- “Prefer one main action or observation per sentence.”
- A structural instruction to split three or more independent clauses joined by “and.”
- “Each sentence should contribute a distinct action, perception, relevant thought, or consequence.”
- “Use previous narration and retrieved story history for facts and continuity, not as prose patterns to imitate.”
- “Express each idea once,” followed by removal of restatements without concrete development.

The first group arrived in commit `60a4aabe` on September 12. The prohibition on prose imitation arrived in `d69bf35b` on September 16; saved jobs show the updated text in use from September 16 at 03:36 UTC, before that commit timestamp.

The original target was run-on clause chains and circular repetition. The wording also discourages cadence, recurring character phrasing, emotional hesitation, conversational callbacks, and natural repetition. This is a plausible contributor, not proof that it caused the reported regression. The instruction to preserve tone exists, but does not specify which voice to preserve when historical prose and the world tone differ.

### 3. Natural dialogue is permitted, but not positively directed

The base prompt mentions natural dialogue only as an exception to conjunction guidance. It also requests new paragraphs on speaker changes. The user envelope preserves dialogue explicitly supplied by the user. None of these asks characters to converse naturally when a scene supports it.

There is no equivalent positive guidance for character-specific vocabulary, contractions, brief responses, interruptions, pauses, subtext, or exchanges mixed with physical action. The result can meet the entire output contract while remaining a long detached account of events.

A fixed dialogue percentage would be the wrong correction: solitary or nonverbal scenes may need none. The missing instruction is conditional dramatization through conversation, with voices grounded in character and situation.

### 4. Repeated containment instructions can compress scenes into factual reporting

The system prompt, user instruction list, and final task all reiterate supported consequences, early stopping, and avoiding new material facts. See `packages/contracts/src/story-prompt.ts:85` and `packages/story-engine/src/prompt.ts:33`.

Most of the length restriction dates to August 11 (`18a0c167`), so it is not a newly introduced explanation by itself. It compounds the newer prose rules. The wording needs a clearer distinction between inventing contradictory history and writing plausible present-scene speech, reactions, and connective action.

Story Direction adds “required narrative events” and allows plausible unspecified outcomes, while Story Memory says direction is intent and cannot establish its own facts. These can be reconciled as “dramatize requested events subject to continuity,” but the repeated caution receives more emphasis than creative realization. Preserve authority protections while making that distinction explicit.

### 5. Overrides will prevent a shipped-default-only fix from reaching this campaign

The database has one application-wide and seven campaign `story_system` overrides. All eight contain identical content. The target campaign uses its campaign override.

The current shipped prompt and captured campaign override are also identical: 5,148 characters, SHA-256 `10d3f89bb64a084a2f50a158069ddd350daa84756cc36fcb1eedb17ee9c6b18d`. Thus the overrides are **not currently an alternate prose style**, but they freeze the old text against future shipped-default changes.

Resolution is campaign override → application override → shipped template (`packages/database/src/prompt-repository.ts:119`). Jobs freeze template content and hashes. Any future correction must deliberately update the effective override and its compatibility acknowledgement, and verify a newly queued request. Already captured jobs retain their historical prompts.

### 6. Rewrite paths do not consistently protect conversational voice

Shared prose guidance reaches the initial writer, three recovery templates, scene-coverage rewrite, and event extension. A rewrite can therefore reinforce the same restrictive style. Event extension correctly protects the existing narration and applies prose guidance only to its appended text.

Continuity repair uses a separate template (`packages/contracts/src/prompt-library.ts:341`) asking for a complete replacement while preserving authority, but does not explicitly preserve unaffected wording, character voice, or dialogue rhythm. This is a latent risk for repaired turns, not the explanation established for the latest turn. Choice-only repair forbids narration output and does not serve as a prose rewrite.

### 7. Verification currently protects prompt delivery, not naturalness

Prompt tests assert that the exact anti-repetition instructions are present. Output validation checks structure and fiction/mechanics separation; it does not assess conversational quality. Continuity review examines evidence-supported conflicts, not the quality of character voice.

`packages/story-engine/src/narration-formatting.ts:31` changes paragraph whitespace while preserving non-whitespace content. For the latest accepted turn, the primary model narration and effective stored narration match after whitespace removal. The application did not remove dialogue or rewrite the words after primary generation in this case.

## Runtime evidence and chronology

The campaign changed during this audit. An earlier stored turn 40 had approximately 3,300 words and no double-quoted spans. The new turn 40 was accepted during the audit. Final observations below use the effective narration view after that acceptance; no exported story prose is stored in this report.

| Current effective turn | Whitespace-delimited words | Double-quoted spans |
| --- | ---: | ---: |
| 36 | 2,685 | 12 |
| 37 | 2,540 | 13 |
| 38 | 2,555 | 8 |
| 39 | 1,300 | 0 |
| 40 | 1,272 | 0 |

These turns had no narration-correction revisions at inspection. Quote spans are a rough dialogue indicator: quoted labels can count, and unquoted or single-quoted speech can be missed. Different scene content prevents treating these counts as a controlled quality experiment.

Captured jobs:

- Earlier turn 40: `64d9afc9-b70c-4248-85d3-6ac017d4dbd2`, created September 23 at 04:19 UTC. System message 9,137 characters; campaign override; Story Memory; continuity review passed.
- Latest turn 40: `87a316f0-babb-4983-98af-f5d6d0b6ce2e`, created September 23 at 23:57 UTC. System message 9,872 characters; same campaign override; cast-enabled Story Memory. Review initially returned uncertain; the job was completed at September 24 00:04:49 UTC. This audit did not initiate acceptance.
- Both had one initial generation attempt with finish reason `stop`. Both sent temperature 0.8, presence penalty 0.1, repetition penalty 1.1, max output tokens 48,000, and JSON-schema response format.
- Requested model changed from explicit `z-ai/glm-5.2` to `@preset/nexus-nsfw`; recorded resolved model remained `z-ai/glm-5.2`. Recorded Story generation usage from September 10–23 lists that same resolved model. This does not establish identical upstream serving or model internals.
- The preset begins with a storyteller/plot-driving role. It does not supply the missing natural-conversation guidance. Preset text precedes the operation prompt (`packages/contracts/src/text-execution-plan.ts:102`).
- Both sampled user messages include the same detached world-tone instruction, current continuity, scene, selected character authority, two additional recent-turn records, and Chronicle context. Chronicle entries changed from 41 to 44. No controlled context-equivalence claim is made.
- The September 18 fact-wire changes address output shape; the September 22 prompt-library change inspected addresses source extraction, not turn prose. The September 23 cast change adds authority instructions; the routing fix changes preset/schema routing. Neither replaces the creative prose block in these captured requests.

## Recommended correction scope

Start with a prompt-only change, covering the effective campaign override and relevant recovery paths. Keep provider settings, retrieval, accepted turns, canonical facts, and mechanics boundaries unchanged for the first comparison.

Proposed positive style direction, for review rather than an applied edit:

> Write natural, character-led fiction. When characters can and would speak, let the scene unfold through believable conversation mixed with action and brief observation. Give each speaker a voice consistent with their personality, relationship, and immediate situation. Use contractions, pauses, short replies, and occasional interruptions where they fit. Show emotion through speech, behavior, and specific perceptions; do not explain every gesture or restate its meaning. Preserve established voice and cadence without copying repetitive sentence patterns. Vary sentence length naturally. Remove circular restatements and excessive clause chains, but keep purposeful repetition, hesitation, and subtext. Do not force dialogue into solitary or nonverbal scenes. Preserve continuity and the requested events.

For this campaign, separately resolve the detached-narrator instruction: keep the bleak/darkly ironic setting if desired, while explicitly selecting natural delivery and character-specific speech. Do not silently reinterpret world rules as optional.

Replace overbroad anti-imitation language rather than merely appending more instructions. In repair prompts, require preservation of unaffected narration and voice. Retain JSON contracts, fact-ID rules, authority precedence, isolation, and fiction/mechanics separation.

Validate with the same captured scene context and provider settings in an isolated comparison, reviewing voice, dialogue plausibility, repetition, requested beat coverage, continuity, and output validity. Use more than one scene, including a solitary scene. Prompt-string tests alone cannot establish success. This audit made no live generation calls.

## Verification

- Passed: `node node_modules/vitest/vitest.mjs run tests/unit/prompt.test.ts tests/unit/prompt-library.test.ts tests/unit/story-only-prompt.test.ts tests/unit/preset-prompt.test.ts tests/unit/story-output.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'` — 5 files, 94 tests.
- Passed: read-only production PostgreSQL inspection of overrides, frozen requests, generation attempts, recorded provider usage, and effective narration; current shipped-template hash comparison; saved-system-message comparison.
- Passed: `git diff --check` before report creation; report checked separately afterward.
- Not run: live-provider A/B generation or browser rendering. Neither is needed to establish the delivered wording; live generation is needed to demonstrate a tonal improvement.
- Limitation: the exact first disliked turn and a preferred earlier prose sample were not specified. This audit establishes delivery, conflicts, and regression candidates, not a single experimentally proven cause.
