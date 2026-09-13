# Story-direction continuity: supporting research

Date: 2026-09-12. Scope: practical experiments for a PostgreSQL-authoritative story platform with Chronicle retrieval and immutable accepted turns. This note supplements the implementation audit; it does not establish which techniques already exist. Actions and mechanics are outside scope. All linked primary-source pages were opened during this research. No production system or provider was queried.

The recommendations below are engineering hypotheses adapted to this platform, not measured improvements in its narration. Keep accepted turns as recovery evidence, campaign/world boundaries intact, and model-produced indexes and summaries rebuildable. Story direction describes desired future fiction; it must not silently become an assertion that an event already happened.

## 1. Retrieve several continuity questions from one story direction

**Evidence.** IRCoT studies multi-step question answering where useful later retrieval depends on earlier evidence, rather than a single initial search. Its experiments concern factual QA, not story continuation. [Trivedi et al., ACL 2023](https://aclanthology.org/2023.acl-long.557/)

**Proposed experiment.** Translate a direction such as returning to an earlier relationship into bounded searches for the named people, last encounter, unresolved promise, and intervening change. Union and deduplicate their results. If a retrieved turn reveals an alias or a missing linked event, permit one additional evidence search. Return typed search terms and evidence references, with a strict query and token budget; do not turn speculative search suggestions into campaign facts.

**Limits and evaluation.** Extra searches can amplify a mistaken interpretation or crowd out relevant context. Compare single-query retrieval with decomposition using evidence recall at a fixed total prompt budget, alias coverage, latency, and irrelevant-context share. Include vague directions and directions that mention facts absent from the campaign.

## 2. Contextualize chunks before indexing, then rerank candidates

**Evidence.** Anthropic prepends chunk-specific context before semantic and lexical indexing, combines results, and evaluates a separate reranking step. The reported retrieval improvements are specific to its datasets and configurations; they are not a prediction for this application. [Anthropic, Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)

**Proposed experiment.** Add compact, evidence-backed entity names, location, accepted-turn sequence, and local event context to otherwise ambiguous Chronicle chunks. Retain the original passage separately. Compare fused retrieval against a reranker that sees the current direction and scene. Reserve space for necessary predecessor or consequence passages rather than selecting many near-duplicates.

**Limits and evaluation.** Generated context may misidentify a speaker or event; reranking adds work and can prefer topical similarity over continuity. Version the derived representation and validate provenance. Measure relevant accepted-turn recall, duplicate share, contradiction coverage, prompt tokens, and end-to-end latency. Tune candidate and final counts locally rather than copying a published configuration.

## 3. Give facts and threads an explicit, evidence-linked lifecycle

**Evidence.** Zep's temporal memory design retains source episodes, links derived facts to them, and distinguishes event validity from ingestion time. Its temporal edges preserve historical states when newer information invalidates an earlier relationship. This is a first-party architecture paper, not independent proof that a graph database is required. [Rasmussen et al., Zep](https://arxiv.org/html/2501.13956v1)

**Proposed experiment.** Use PostgreSQL records or an equivalent typed projection for thread identity, status, originating turn, last supporting turn, and explicit resolution evidence. Track a fact's period of validity and supersession separately from deletion. Reconcile a proposed complete replacement summary/thread set with the previous set: explain disappearance as resolution, supersession, or an omission requiring repair. Preserve closed history so retrieval cannot accidentally reopen it. Treat future story direction as intent until accepted narration establishes an event.

**Limits and evaluation.** A character's false belief is not necessarily a contradiction in world state. Require evidence and distinguish established fiction from belief, rumor, and unresolved interpretation. Test thread survival through unrelated scenes, supported closure, re-opening only with new evidence, identity changes, and rebuilding projections from the ledger. These lifecycle rules are proposed application design, not rules asserted by the paper.

## 4. Preserve evidence beneath summaries and use temporal search deliberately

**Evidence.** LongMemEval separates indexing, retrieval, and reading. Its experiments investigate granular history values, fact-augmented search keys, and time-aware queries; compressing history entirely into extracted facts can lose useful information. [Wu et al., LongMemEval, sections 4–5](https://arxiv.org/html/2410.10813v2)

**Proposed experiment.** Let a compact summary locate evidence, then retrieve accepted passages for consequential details. Retain source-turn references and a coverage watermark on each derived summary. When a direction refers to an earlier scene, retrieve that period plus later changes to the same people or threads. Keep story chronology distinct from database timestamps, especially for flashbacks.

**Limits and evaluation.** A mistaken inferred date can exclude the correct passage. Fall back to an unfiltered scoped search when time interpretation is uncertain. Test details omitted from summaries, overwritten relationships, chronology changes, and coverage gaps after interrupted indexing. Compare the summary alone with summary plus source evidence at equal budgets.

## 5. Test prompt placement and protect a small continuity packet

**Evidence.** Lost in the Middle found position-dependent performance on document QA and key-value retrieval, with relevant material often used better at the beginning or end than in the middle. It evaluates particular models and tasks; it does not establish a universal layout for every current story model. [Liu et al., TACL 2024](https://aclanthology.org/2024.tacl-1.9/)

**Proposed experiment.** Reserve a small explicit budget for the current scene, essential established facts, and the selected unresolved threads. Present authority labels clearly, keep evidence passages attributable, and test alternative placements relative to the current direction. Deduplicate facts repeated in summaries and recent narration before spending more context.

**Limits and evaluation.** Over-pinning facts can make narration repetitive or freeze legitimate developments. Evaluate multiple placements and history lengths with the actual configured models. Score continuity separately from stylistic quality; a longer prompt should earn its cost through measured improvement.

## 6. Evaluate complete campaigns, including updates and missing evidence

**Evidence.** LongMemEval covers extraction, reasoning across sessions, time, knowledge updates, and abstention, and distinguishes retrieval metrics from answer quality. These categories offer useful evaluation dimensions; its chat-assistant benchmark is not itself a story-quality benchmark. [Wu et al., LongMemEval, sections 3.2–3.3](https://arxiv.org/html/2410.10813v2)

**Proposed evaluation.** Create sanitized, human-reviewed campaign fixtures with references to the turns that establish each expected fact. Sample short and long histories with aliases, dormant promises, resolved conflicts, changing relationships, and intentionally unknown details. Replay direction sequences through summary replacement and Chronicle rebuilding, rather than testing isolated prompts alone. Include a fresh campaign with similar names to test isolation.

Record evidence recall, unsupported assertions, contradictions, thread retention/closure, and direction fulfillment as separate outcomes. Log model/version, prompt protocol, embedding/index version, context budget, retrieval candidates, selected passages, and latency. Compare the baseline with one change at a time; include an evidence-only oracle to distinguish retrieval failure from failure to use supplied evidence. Use repeated runs for stochastic narration and human review to calibrate automated scoring. Do not call better recall proof of better prose.

## Suggested order

Start with the campaign evaluation fixtures and retrieval diagnostics. Next test bounded query decomposition and preservation of thread/source evidence, then contextual indexing and reranking. Tune prompt placement after knowing which evidence reaches the prompt. Defer a new memory service or graph store unless measured failures justify its operational cost; the proposed lifecycle and provenance concepts can first be evaluated within PostgreSQL.
