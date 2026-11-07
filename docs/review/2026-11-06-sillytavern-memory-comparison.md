# SillyTavern and Infinite Quest memory/context comparison

Reviewed 2026-11-06. Infinite Quest checkout: `6cd29919d419b02b846d1c53747262de1dd4c6ad`. This is source/documentation research, not a runtime benchmark or implementation proposal approved for execution. Estimates below are engineering judgment for one developer familiar with the repository, including focused verification, excluding deployment and model-quality experiments.

## Assessment

Keep Infinite Quest's authoritative, scoped Chronicle architecture. SillyTavern offers useful ideas for author-controlled lore activation, temporary reminders, and prompt inspection. Infinite Quest already implements substantial retrieval, budgeting, correction, and diagnostic functionality; adding those again would duplicate existing work. Long-story event coverage is a separate worthwhile improvement inspired by the comparison, not a claim that SillyTavern implements a superior chapter-memory system.

## SillyTavern mechanisms

Source inspection used the moving `release` branch on the review date; no immutable upstream commit was established. Reviewed [World Info implementation](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/world-info.js), [vector extension](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/vectors/index.js), and [summary extension](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/memory/index.js). Future behavior may differ.

- **Chat retrieval:** the vector extension queries the current chat collection for a bounded number of relevant messages, protects a configurable recent-message tail from rearrangement, and deduplicates retrieved messages by hash. It also retrieves file chunks. This supplies useful older material to the prompt; it is distinct from Infinite Quest's authoritative accepted-turn/correction model. [Vector extension source](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/vectors/index.js).
- **World Info:** conditionally inserts lore using keywords, with vector matching as another activation route. Entries support placement, ordering, budgets, recursive activation, and timed effects. Sticky activation keeps an entry active across messages; cooldown and delay control when it can activate. Vector matching still respects other activation conditions and the lore budget. [Official World Info documentation](https://docs.sillytavern.app/usage/core-concepts/worldinfo/).
- **Summaries:** an editable rolling summary can be updated automatically, paused, restored to a previous state, and inserted at a chosen prompt position. Summary state is attached to chat messages. The documentation explicitly warns that generated summaries can omit or invent details. [Official Summarize documentation](https://docs.sillytavern.app/extensions/summarize/).
- **Prompt controls:** the Chat Completion Prompt Manager controls prompt sections, role, relative ordering, and insertion depth. Author's Note provides a chat-specific reminder with configurable placement and frequency. These are prompt controls; they do not establish that an event actually happened. [Prompt Manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/), [Author's Note](https://docs.sillytavern.app/usage/core-concepts/authors-note/).

## Infinite Quest implementation evidence

| Area | Existing implementation | Consequence |
| --- | --- | --- |
| Authority | [Generation authority reader](../../packages/database/src/chronicle-generation-context.ts) captures owner/campaign/world-version scoped state, corrections, and accepted narration. | Preserve this boundary when borrowing prompt features. |
| Hybrid retrieval | [Query planner](../../packages/domain/src/chronicle-query-plan.ts), [rank fusion](../../packages/domain/src/chronicle-rank-fusion.ts), and [Chronicle documentation](../concepts/chronicle-memory.md) cover action, scene, entities, open threads, optional temporal hints, chunked semantic/lexical retrieval, diversity, and fallback. | Basic vectors or another vector database are not the missing capability. |
| World reference selection | [World fiction selector](../../packages/domain/src/world-fiction-reference.ts) uses names/aliases and term overlap, plus relationships connected to directly mentioned entities; it caps entity and relationship candidates at 24 and 32. | Extend authored selection controls rather than replacing Chronicle. This is a bounded selector, not a general recursive lorebook engine. |
| Summaries | [Chronicle repository](../../packages/database/src/chronicle-repository.ts) projects accepted continuity summaries and stores nonempty continuity checkpoints every eighth ordinal. | Rolling summaries/checkpoints already exist. |
| Historical coverage | [Generation planner](../../services/runtime/src/generation-context-planner.ts) separates recent turns, player-intent ledger, verified facts, world references, and retrieved memories. [ADR 0040](../architecture/0040-history-coverage-context.md) explicitly defers accepted-event synopses and chapter compaction. | Better compact coverage of actual outcomes remains a concrete opportunity. |
| Context limits | [Context planner](../../packages/story-engine/src/context-budget.ts) and [request serializer](../../packages/story-engine/src/provider-request.ts) enforce context/request limits and output reservations; uncertain token estimates receive safety allowances. | Do not recommend merely adding a token budget or increasing the context window. |
| Visibility | [Preview guide](../nexus-guide/chronicle/context-preview.md), [turn retrieval audit](../../packages/client-core/src/chronicle-retrieval-audit.ts), and [generation diagnostics](../../packages/client-core/src/generation/projection.ts) already expose selection/fallback information and omission counts. | Improve explanation and navigation; do not describe diagnostics as absent. A public preview is not the complete private generation request. |
| Evaluation | [Evaluator](../../scripts/lib/chronicle-retrieval-evaluator.ts) and [v3 corpus](../../tests/fixtures/chronicle-retrieval-evaluation.v3.json) already measure retrieval quality and include isolation/budget cases. | Extend the existing benchmark before tuning ranking. |

## Recommended improvements

| Priority | Improvement | Benefit and implementation scope | Difficulty / rough effort |
| --- | --- | --- | --- |
| 1 | Explain why context was included or omitted | Extend existing preview and diagnostics into a readable breakdown of world references, facts, recent turns, summaries, and retrieved memories. Show activation reasons, budget omissions, and links to authorized source records. Label preview vs actual-generation evidence explicitly; never reconstruct a historical result and present it as recorded. | Medium; 4–8 developer days. New retained per-source generation evidence could expand this scope. |
| 2 | Authored lore activation rules | Add typed entries with aliases, require/exclude conditions, priority, and deterministic activation from scene entities or locations. Freeze reusable rules with the world version; keep campaign overrides separate. Begin with keyword/entity rules and bounded relationship expansion, not unrestricted regex or recursive prompt injection. | Medium–high; 2–3 weeks including authoring UI, contracts, import/export, versioning, and tests. |
| 3 | Scene-scoped reminders and memory pins | Allow a user to retain an existing fact or lore reference for this scene or a specified number of accepted turns. Keep creative guidance distinct from factual assertions. Expire or invalidate pins on correction, supersession, scene change, rewind, and branch as appropriate. Preserve hard budget limits and expose conflicts rather than silently overriding current canon. | Medium; 1–2 weeks. A larger persistent scene-lifecycle model would increase effort. |
| 4 | Accepted-event synopses, then chapter summaries | Generate compact outcome records from accepted narration, with source turn IDs, hashes, correction frontier, and covered ranges. Build chapter summaries from verified sources; combine recent verbatim turns, older chapter coverage, and retrieved event details. Invalidate derived summaries after relevant corrections. Keep the intent ledger explicitly separate. | High; 3–5 weeks for a staged first version. Most effort is provenance, invalidation, replay, and quality evaluation. |
| 5 | Evaluate alternative historical-fact allocation | Current v5 selection keeps the maximal newest whole suffix; a very large newest fact can leave no selected suffix. Measure whether older scene-relevant facts or explicit pins warrant reserved capacity, while maintaining current-state authority and supersession. Start as an offline experiment. | Medium–high; 1–2 weeks for evaluation, another 1–3 weeks if a production policy change is justified. |
| 6 | Expand end-to-end memory-quality evaluation | Extend the existing corpus with long campaigns, lore-trigger precision, expiring pins, failed player intentions, old promises, corrections, and chapter boundaries. Evaluate the final packed writer context, not only retrieved candidates; separately measure model narrative contradictions and latency. | Medium; 1–2 weeks initially, then an ongoing gate. |

Recommendation 5 changes the policy explicitly adopted by ADR 0040. It requires a new decision and versioned frozen policy; it is not a safe unversioned ranking tweak. Recommendations 2–4 likewise need compatible readers and frozen job context where they alter prompt behavior.

## Suggested delivery sequence

1. Extend evaluation and context explanations together, using existing retrieval and generation evidence.
2. Add a limited set of deterministic lore controls and scene pins. Demonstrate that they improve difficult recall cases within the same context budget.
3. Deliver accepted-event synopses before chapter compaction. Test correction, rewind, branching, and rebuild behavior before using summaries broadly.
4. Revisit historical-fact allocation only with measured evidence. Reranking or a larger vector service is lower priority until current ranking is shown to be the bottleneck.

Do not copy unrestricted prompt-role editing, random activation for necessary canon, or global cross-campaign memory. All new context remains scoped, fiction-safe, source-backed where factual, and subordinate to current authoritative corrections. Summaries and vectors remain rebuildable aids.

## Verification and limits

Reviewed current local implementation and official SillyTavern documentation/source. No application behavior was changed. Local note links and whitespace are checked separately. Unit, PostgreSQL, browser, and live-provider tests are not run for this documentation-only research. No deployed Infinite Quest settings, campaign enrollment, or comparative model performance were verified. Estimates are planning ranges, not delivery commitments.
