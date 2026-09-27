# Turn generation context review — 2026-09-26

**Question:** does the next Story turn receive the most accurate and complete story history available? Or can a turn lose track of the story so far?

**Method:**
- Read the context pipeline on branch `fix/prompt-system-remediation` (commit `900df97c`).
- Ran read-only SQL against the production database (`infinitequest-postgres-1`) and read the app logs.
- Changed no settings, data, or jobs. Made no provider calls.
- Campaigns are identified by 8-character ID prefixes. No story content appears in this report.

## Pipeline as implemented

1. **Budget** (`generation-executor-adapter.ts:2284-2310`):
   - `safeContextBudget = max(512, min(campaign budget, inputTokenLimit − fixed envelope))`.
   - This value is passed to Chronicle as `retrievalBudgetTokens`.
2. **Authority capture** (`chronicle-generation-context.ts:46`, `generation-authority.ts:128`). This runs in one transaction and reads:
   - world rules and canon;
   - the character profile;
   - `currentContinuity`: the base turn's snapshot, or a state edit;
   - `latestTurn`, which becomes `currentScene`;
   - for r2/r3 only, the **two** turns before the base turn (`turn_number >= base−2 AND < base`), as `recentTurns`.
3. **Chronicle candidates** (`chronicle-context-repository.ts:550`):
   - Hybrid rank fusion (semantic, full-text, entity, static recency, importance, kind, temporal) over chunks, plus the pool of historical canonical facts.
   - Then diversity selection capped at `maximumParents = 16 × ceil(budget / 32,000)` (line 399).
   - The base turn is excluded.
4. **Planner** (`generation-context-planner.ts:161`). The authority block is protected. Then, in this order:
   - the cast (≤ 3,000 tokens, ≤ 10% of residual);
   - recent turns (≤ 30% of residual);
   - world references (≤ 15%);
   - Chronicle records in rank order until the context or input limit is reached.
   - Duplicates of protected or recent sources are removed at this stage (lines 243-248, 397).

## Production evidence

- **Chronicle index health: good.** Every campaign active in the last 30 days has one `turn_fiction` memory per accepted turn, all embedded, up to the active turn. No indexing lag was found.
- **Recent window: reliable.** In the last 130 attempts, only one recorded a recent-window gap: a context limit on a 64k campaign. Other shortfalls were early turns that have fewer than three prior turns.

Context use by campaign budget, last 130 attempts with layer diagnostics:

| Campaign budget | Attempts | Avg context tokens used | Avg records selected | Avg duplicates discarded | Budget omissions |
|---|---|---|---|---|---|
| 64,000 | 21 | 26,319 | 16 | 9.0 | 1 |
| 128,000 | 72 | 67,451 | 40 | 19.9 | 30 |
| 256,000 | 11 | 77,369 | 38 | 27.6 | 10 |
| 1,000,000 | 26 | 372,615 | 246 | 18.2 | 0 |

Budget distribution across the 55 campaigns:

| Budget | Campaigns |
|---|---|
| 32k (the default) | 29 |
| 64k | 12 |
| 128k | 9 |
| 256k | 3 |
| 1M | 2 |

Enrollment is r3 for 53 campaigns and r2 for 2.

### Worked example: campaign `ccaab0b2`, generating turn 24 (2026-09-26 15:53)

- **Budget:** campaign budget 256k; model input limit 115,840 tokens. The context used was **45,452 tokens**, less than half of what was available.
- **Full narration sent:**
  - turns 21 and 22 (recent);
  - turn 23 (current scene);
  - turns 2, 18, 19 and 20 (retrieved).
  - In total, 7 of 23 accepted turns.
  - Turns 1 and 3–17 were represented only by the continuity summary (about 1,300 characters) and some facts.
- **Canonical facts:**
  - 38 historical facts from turns 11–20 were sent.
  - The campaign has 70 active facts from turns 1–10. **None were sent.**
- **Discarded after retrieval:** 22 retrieved records were discarded as `duplicate_source`: 20 facts from turns 21–23, plus 2 others.
- **Parent cap:** 38 + 4 + 22 = 64, exactly the parent cap at this budget. Retrieval hit its **count** limit, not the token budget. A third of the slots went to records the planner then threw away.

## Findings

### F1 — High: the history selection is limited by a record count, not by tokens

**Where:** `generationChronicleRetrievalLimits` (`chronicle-context-repository.ts:399-425`).

**What happens:**
- The cap on selected parents grows in steps of 16 per 32k of budget.
- A 60-token canonical fact and a 2,300-token turn narration (the production average for `turn_fiction`) each use one slot.
- Facts are ranked alongside narration (`story-context-integrity.md`, "Budget-aware history"). A fact-dense campaign therefore fills its slots with short facts, and the planner is left with budget it cannot use.

**Evidence:**
- In the worked example, 54% of the usable input was left empty.
- On 64k campaigns, only 41% of the budget was used on average.

**Effect:** older narration that would fit is never offered to the planner.

**Recommendations:**
- Make the final token-budget planner the binding limit.
- Either give facts and narration separate parent allowances, or give the diversity selector a token budget, for example a sum of `token_estimate` of about 1.5× the residual context.
- Stop counting parents.

### F2 — High: records that duplicate protected or recent context consume retrieval slots

**Where:**
- Retrieval excludes only the base turn (`latestSceneParentMemoryId`, and the `ordinal === throughTurnNumber` filter at `chronicle-context-repository.ts:590`).
- The planner removes other duplicates later (`generation-context-planner.ts:243-248, 397`):
  - facts already in `currentContinuity`;
  - narration from the two recent turns.
- By then, the cap has already spent slots on them.

**Evidence:** retrieval discards an average of 9–28 records per turn.

**Recommendation:** give retrieval the exclusion set before diversity selection:
- the IDs of the recent-window turns;
- the IDs of the protected facts;
- or equivalently, `throughTurnNumber = base − 3` for `turn_fiction` when the layered window applies.

This is the cheapest fix and needs no ranking changes.

### F3 — High: no part of the context covers the whole story in order

**What exists today:**
- Beyond the three verbatim turns, story history reaches the model only in two ways:
  - **(a)** `continuity_summary`, which the writer model rewrites every turn as a "complete living summary" (`story-prompt.ts:102`);
  - **(b)** records retrieved by relevance to the current player direction.
- Nothing guarantees that the turns between those two are covered.

**The summary is lossy and does not grow with the story.** It is rewritten every turn and stored in each snapshot.

Length in characters:

| Campaign | Turns | Summary length | Behaviour |
|---|---|---|---|
| `8265f915` | 317 | 468–1,222 at every sampled turn | About 3 characters per turn of history |
| `ccaab0b2` | 24 | 3,128 at turn 18 → 1,313 at turn 24 | Shrank |
| `3bb3c3e5` | 42 | 5,496 at turn 33 → 2,206 at turn 36 | Shrank |

- The model condenses or drops material each time it rewrites the summary.
- The summary shares one structured output with the narration, so it is also exposed to output-length pressure. Compact mode says "Keep continuity fields concise".

**Effect:** events that the current direction doesn't mention are effectively forgotten once they leave the 3-turn window. This matches the reported symptom that the story "loses history".

**Recommendation:** add a protected, chronological story-so-far ledger.
- Each accepted turn stores a short synopsis of its own events (about 60–120 tokens). It can come from the same response, as a new field under a new schema version, or from a cheap post-acceptance job.
- Generation sends the synopses in turn order as a protected block.
- When the ledger exceeds a share of the budget, older synopses are compacted into chapter summaries. Compaction is append-only, never an in-place rewrite.
- At 100 tokens per turn, a 300-turn campaign is about 30k tokens. That fits within a 128k budget, and chapter compaction covers smaller budgets.
- Keep `continuity_summary` as "current situation" state, not as history.

### F4 — High: cast context is empty on every turn because per-turn cast discovery always fails

**Evidence:**

| Check | Result |
|---|---|
| Cast layer in sampled attempts | 19 of 19 had `estimatedTokens: 0` and `coverage.current: false` |
| Per-turn discovery jobs since 2026-09-24 | 12 of 12 failed with `admission_unavailable`, on 6 campaigns |
| Manual scan jobs, 2026-09-23 | 20 of 20 completed |
| Campaigns checked | 6 campaigns have 0–1 cast characters and 0 observations |
| App log | `cast_discovery_admission_unavailable` on every generation |

**Where:** `generation-executor-adapter.ts:4535-4543`.
- The call is `catch { admission = { status: "unavailable" } }`, which discards the error.
- The cause is therefore not recorded anywhere.
- Every affected campaign uses the same preset profile, which a manual scan handled successfully. The difference is in the per-turn admission path: it passes the story generation `provider` object rather than one resolved fresh.

**Effect:**
- No character state reaches the model.
- The cast notice tells it "Tracking is incomplete".
- Dynamic character fields are omitted (`campaign-cast-context.ts:75-76`).

**Recommendations:**
1. Log the error class and code in that `catch`.
2. Reproduce with one admission call in the container. This call only fetches provider metadata; it does not generate text.
3. Fix the admission.
4. Backfill the affected campaigns.

**Not verified:** the root cause. Finding it needs the provider metadata call, which is outside this read-only review.

### F5 — Medium: only facts from the base turn are protected; older active facts compete for retrieval slots

**Where:** `loadAcceptedGenerationContinuity` (`campaign-continuity-repository.ts:79-84`). It fills `currentContinuity.canonicalFacts` from the facts **emitted by the base turn** only: 2–10 in production snapshots.

**What happens:**
- Every other active fact, for example 147 of 152 in `ccaab0b2`, is optional Chronicle material.
- That material is subject to F1 and F2.
- `story-context-integrity.md` says "Current authoritative facts remain protected at every budget", but the code protects only the latest turn's additions (or a state edit's list).

**Recommendation:**
- Protect all active facts in a compact form (about 60 tokens each; roughly 9k tokens for 150 facts).
- If that exceeds a set share of the budget, protect the most recent or most important ones and leave the rest to retrieval.
- Either way, correct the architecture document so it matches the behaviour.

### F6 — Medium: the verbatim recent window is fixed at 3 turns whatever the budget

**Where:**
- `generation-authority.ts:128-137` loads exactly `base−2 … base−1`.
- The planner loop (`generation-context-planner.ts:366`) is hard-coded to the same range.
- Layering requires `recentTurnTarget === 3`.

**Effect:**
- A 256k campaign gets the same three turns as a 64k campaign.
- The 30% recent-turn share (`recentResidualShare`) is almost never used: 3 turns ≈ 7–11k tokens.

**Recommendation:**
- Load a larger candidate window, for example up to 12 turns.
- Fill it backwards while the recent share still has room.
- Stop at the first gap, keeping the current recent-gap behaviour.
- This needs a new policy version, because `recentWindowFingerprint` is part of the frozen base identity.

### F7 — Medium: the prompt presents history out of chronological order

**What happens:**
- `authoritative_context` serializes keys in this order: rules → canon → character → `currentContinuity` → **`currentScene`** → world references → `recentTurns` → `chronicle`.
- So the model reads:
  1. the latest scene;
  2. then the two turns before it;
  3. then older material, sorted in ascending order (`contextOrder`).
- The last thing it reads before the instructions is the oldest material.

**Recommendation:**
- Serialize history oldest to newest, ending with `currentScene` directly before `current_turn_input`.
- This is a prompt-protocol change. Gate it on a new context-policy version so frozen jobs stay byte-identical.
- Measure it with a small A/B before rollout.

### F8 — Low: the scene retrieval query uses the start of the latest turn, not its end

**Where:** `planBalancedChronicleQueries` → `addHint("scene", …)` → `queryFrom(..., 1000)`. It takes the **first** 1,000 characters of the base-turn narration (average about 9k characters).

**Effect:** the part of the scene the story is currently in, near the end, doesn't influence retrieval.

**Recommendation:** use the final 1,000 characters instead, or the last few paragraphs.

### F9 — Low: observability gaps

- The attempt diagnostics record the IDs of selected and omitted records, but not the reason the diversity selector stopped, for example "parent cap reached". F1 can only be seen by recomputing the counts, as this review did.
- Add the selector's stop reason, the parent-cap value, and each record's token total to the diagnostics layers (`layers`).
- Also record the cast admission error class (F4).

## What is working

- Authority capture and retrieval are isolated to the campaign, world version and base turn, and the frozen base identity is checked (`chronicle-generation-context.ts:56`).
- The Chronicle is complete and fully embedded for active campaigns.
- On 1M-budget campaigns, 100–115 distinct turns are retrieved per request, so history loss is mostly a problem for small and medium budgets.
- State edits correctly replace the whole continuity.
- The prompt tells the model that omitted history is unknown, not false (`prompt.ts:93`).

## Suggested order of work

1. **F4:** log the error, then fix cast admission. The feature is currently silently off.
2. **F2:** exclude protected and recent sources inside retrieval. This is small, removes no information, and immediately frees 15–40% of retrieval slots.
3. **F1:** make selection limited by tokens.
4. **F3:** add the story-so-far synopsis ledger. This is the structural fix for losing history.
5. **F5 and F6:** protect all active facts and scale the recent window with the budget. Both need a new policy version.
6. **F7 and F8:** fix prompt ordering and the scene query, verified by A/B.

Every change that alters the request body must be keyed to a new policy or protocol version, so that queued jobs re-derive identical requests. This is the same constraint the prompt-system remediation followed.
