# Structured-output escape probe — 2026-09-25

This probe is Step 1 (recommendation R1) of the [prompt system audit](prompt-system-audit-2026-09-25.md). It was authorized as a live run against the saved Preset Provider.

**Goal:** find a structured-output configuration that returns a predictable object containing every required field, with dialogue quotes intact in the narration.

No application code, prompt override, provider setting, campaign, or accepted turn was changed. The probe only read the database, to load the profile credential. It wrote no rows. Every request used a synthetic story context, so no campaign prose was sent or stored.

## Result

| Configuration (all through `@preset/nexus-nsfw`) | Fresh samples | All fields | Dialogue quoted | Paragraph breaks | App parser |
|---|---|---|---|---|---|
| **A.** Production strict `json_schema` (with narration `pattern`) | 4 | 4/4 | **0/4** | 0/4 | 4/4 accepted (unquoted) |
| **B.** Strict schema, prose `pattern` removed | 4 (one via explicit model, provider Wafer) | 4/4 | **0/4** | 0/4 | 4/4 accepted (unquoted) |
| **D.** Schema with `strict:false` | 3 | 3/3 | **0/3** | 0/3 | 3/3 accepted (unquoted) |
| **C.** `json_object` (pre-2026-09-22 mode) | 7 | **1/7** | yes, in all partial or complete text | yes | 1/7; 2 returned only `narration`; 4 failed mid-stream (DeepInfra 502) |
| **F.** Strict schema + typographic-quote instruction | 3 | 3/3 | 2/3 | 0/3 (formatter synthesizes) | 3/3 accepted; 1 unquoted |
| **G.** Strict schema + typographic quotes + `narration_paragraphs` array | 4 (one with unquoted history) | **4/4** | **4/4** | **4/4** | **4/4** accepted after join |

Arm G details:

- 17–25 dialogue paragraphs per turn, 46–78 typographic quote marks.
- Every paragraph had balanced opening and closing marks.
- No paragraph contained a speech tag (says, asks, replies, whispers, mutters) without quotation marks.
- Speaker changes started new array items.
- It worked the same with unquoted history.

## Conclusions

1. **The loss of escape sequences comes from structured-output decoding on this route, not the prompt, and not the `pattern`.**
   - Every schema-constrained response contained **zero backslashes**. That covers 11 fresh samples across arms A, B, and D, plus the arm E calibration calls. It held with the pattern (A), without it (B), and non-strict (D), on DeepInfra and Wafer.
   - Without a schema (C), the same model, preset, prompt, and provider emitted 144–420 escapes per response.
   - Removing the `pattern` (audit R2) **would not fix** the problem.
2. **Reverting to `json_object` does not meet the goal.** Under JSON-object mode, 4 of 7 calls failed mid-stream with an upstream 502 from DeepInfra, and 2 of the 3 completed calls returned only `narration`. The field guarantee the strict schema provides is real and worth keeping.
3. **A strict schema can carry quoted, paragraphed narration if the output needs no escapes.** Two changes do this:
   - typographic quotation marks (U+201C/U+201D), which JSON does not require escaping
   - narration as an ordered array of paragraph strings, which removes the need for `\n`

   Arm G (4/4) combines both. The instruction alone (F) is not reliable (2/3), and it cannot restore paragraph breaks.

## Additional findings

- **The preset applies OpenRouter response caching.** The route basis records `responseCache: {"enabled": true}`, and production sends `X-OpenRouter-Cache: true`. In pass 1, byte-identical requests returned identical responses with zero usage. For example, three `json_object` calls returned 124 quotes, 223 escapes, and 50 paragraphs each. The production structure retry replays the identical reserved request body (`generation-executor-adapter.ts:3021-3040`), so a cached bad response can come back unchanged on retry. Passes 2 and 3 used `X-OpenRouter-Cache: false`.
- **OpenRouter injects the preset system prompt server-side (audit F11).** The same request body, without the locally composed preset prefix, used **4,281** prompt tokens via `@preset/nexus-nsfw` and **4,164** via explicit `z-ai/glm-5.2`. The preset prefix itself adds about 147 tokens (4,428 vs. 4,281 via the preset). This indicates production sends the preset text twice. **Caveat:** the explicit call routed to Wafer rather than DeepInfra, so chat-template tokenization could differ slightly.
- **Content quality note.** Some arm G samples restated the prior scene before continuing, which the writer prompt forbids. That behavior is independent of quoting, and was not measured systematically.

## Method

- **Runtime:** a temporary script ran inside `infinitequest-infinitequest-app-1` using deployed `/app/dist` modules. It used the runtime configuration, `decryptCredential`, and `createProviderTransport` with the production network allowlist. It was removed afterwards.
- **Profile:** saved Preset Provider **OR - GLM**, `4179bbfe-0066-4d73-ae4a-ae880eb7ac19`, `@preset/nexus-nsfw`. The same credential was used for the one explicit-model calibration call.
- **System message:** byte-identical to production job `2111ff69-229c-4962-b65c-439ee3e30c6b` (18,889 characters, SHA-256 `c01c2ccda31a…`). It includes the preset prefix, `story_system` override `6cd32c62`, the story-only supplement, and the Story Memory and cast contracts. Arms F and G appended a single encoding instruction.
- **Response format:** production `infinite_quest_story_native_v2`, hash `16871a71c095…` (8 `pattern` keywords). Arm B removed the 7 prose patterns and kept the UUID pattern. Arm G replaced `narration` with `narration_paragraphs` (array of strings) and left every other field unchanged.
- **User message:** built by the deployed `buildStoryMemoryUserPrompt`, 3,849 characters. It carries a synthetic mystery scene with properly quoted recent history (or, for the robustness arms, the same history stripped of quotes). The scene direction requires conversation. The narration target was `standard`, 300–450 words.
- **Parameters:** as in production (temperature 0.8, presence penalty 0.1, repetition penalty 1.1, streaming), except `max_tokens` 8,000.
- **Acceptance check:** each response went through the deployed `parseStoryOutput`. Arm G paragraphs were joined with blank lines into `narration` first.
- **Scale and cost:**
  - Pass 1: 16 calls with the cache enabled; 9 of them were cache replays.
  - Pass 2: 11 calls, cache disabled.
  - Pass 3: 7 calls, cache disabled.
  - Total: 34 calls, 25 fresh. Reported cost was $0.0797. Streams that failed mid-way report no usage.
- **Limitations:**
  - Small samples; one model (`z-ai/glm-5.2`); one synthetic scene.
  - Routes were mostly DeepInfra.
  - Typographic quotes change the stored character set from straight to curly quotes.
  - This probe does not establish long-context behavior at production scale (about 58K input tokens).

Raw probe outputs are synthetic and were kept outside the repository.

## Recommended implementation (not performed)

Adopt arm G as a new Story response contract version:

1. **Schema.** Add `narration_paragraphs` (array of non-blank strings) to Story output schemas that produce narration: story, recovery, scene rewrite, extension, and continuity repair. Keep every other field and the strict mode.
2. **Adapter.** Normalize at the provider boundary: `narration = paragraphs.join("\n\n")` before `storyTurnOutputSchema`. Downstream consumers, persistence, and the paragraph formatter then remain unchanged. The formatter already treats `“` as a dialogue start (`narration-formatting.ts:27-29`).
3. **Encoding contract.** Append an application-owned encoding contract after overrides, the way the Story Memory contract is appended, so every existing campaign override receives it:
   - use typographic quotes for speech
   - one paragraph per array item
   - start a new item on a speaker change

   Do not rely on editing eight overrides. Two related edits:
   - The override text `6cd32c62` includes an example that requires escaped straight quotes. Updating it through the API, with acknowledgement, would remove a direct conflict.
   - Alternatively, make the appended contract state that it takes precedence.
4. **Versioning.** A new Story schema version and prompt protocol identity apply to newly queued jobs only. Frozen jobs keep their contracts.
5. **Validation.** Keep the advisory dialogue-format signal from audit R3 as a backstop. Arm F's failure mode, unquoted speech with tags, still occurs when the model ignores the instruction.
6. **Tests:**
   - schema snapshot for the new field
   - adapter join (including a single paragraph and an item containing internal whitespace)
   - parser acceptance of curly quotes
   - rejection of an empty array
   - frozen-contract compatibility for old jobs
   - regression fixtures: solitary scene, reported speech, internal thought, mixed dialogue and narration
7. **Live verification.** After deployment, run a small cache-disabled probe at production context size before enabling the contract broadly.
8. **Retry isolation.** Separately, consider sending `X-OpenRouter-Cache: false` on retry dispatches, or varying their bodies, so a retry cannot return the same cached rejected response.
