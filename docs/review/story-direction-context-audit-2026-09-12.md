# Story Direction generation and continuity audit

Audited revision: `43245a62c5a558a737fcb720a10ed978ec90a26c`, local checkout on 2026-09-12. Application code was clean at intake. Scope: Story Direction submission, private authority loading, historical retrieval, prompt construction, provider serialization, validation/recovery, accepted-state persistence, and next-turn replay. This is an implementation audit against the existing architecture and the platform's continuity goal, not an audit of Action resolution. One research agent independently assessed improvement techniques; implementation findings were traced and verified by the primary reviewer.

**Verdict: the platform has substantial continuity infrastructure, but it does not yet consistently supply all the context it already owns, and it does not verify that accepted narration preserves continuity.** Several relevant records never enter protected generation context. Older records can also be excluded before relevance ranking. Increasing the context window alone cannot fix these omissions.

Evidence labels below distinguish reproduced behavior, source-confirmed defects, intentional design tradeoffs, and proposed experiments. No claim is made that a particular live campaign or provider has exhibited a quantified failure rate. Production database contents, deployed image revision, active model settings, and live-model quality were not inspected.

## What the current path actually does

| Stage | Current implementation | Continuity implication |
| --- | --- | --- |
| Select policy | Campaign `flexible_scene` becomes frozen `story_only`; jobs force `scene` input. A scene submission in `flexible_action` remains on the legacy scene path. | The same visible phrase, Story Direction, does not always mean the same validation pipeline. |
| Capture authority | Load the campaign/world version, current state correction or latest accepted state, rules, and latest effective narration under a short transaction. | Browser history and provider conversation memory are not the authority. |
| Retrieve history | Use the direction plus bounded scene/entity/thread hints; scope queries to owner, campaign, world version and base turn. Use semantic/lexical/entity/static ranks and diversity where available, with fallback. | Older history is selected, not replayed in full. |
| Plan prompt | Protect one authority block; add complete optional Chronicle records according to rank while campaign and provider budgets allow; render selected history in chronology. | Protected content is not clipped to make space, but absent authority cannot be protected. |
| Dispatch | Send a complete JSON context and direction with mandatory protocol instructions. Canonical recovery is self-contained and omits response-chain IDs. | A restarted or different provider can continue from supplied state; no cross-turn provider memory is required. |
| Validate | Check complete output schema, field limits, mechanics leakage, choices, fact supersession authorization and durable generation identity. Story-only skips independent scene coverage and event/RPG stages. | Structurally valid output can still contradict or forget fiction. |
| Commit | Guard accepted-turn/state writes, preserve dormant mechanics for Story Direction, store complete replacement summary/scratchpad/threads and fact changes, and project accepted fiction into Chronicle. | Durable history exists for recovery, but the next prompt's protected facts are narrower than the accumulated fact ledger. |

Primary implementation references: [policy](../../packages/domain/src/campaign-generation-policy.ts), [enqueue repository](../../packages/database/src/generation-repository.ts), [private context loader](../../packages/database/src/chronicle-generation-context.ts), [retrieval](../../packages/database/src/chronicle-context-repository.ts), [executor](../../services/runtime/src/generation-executor-adapter.ts), [request serializer](../../packages/story-engine/src/provider-request.ts), [commit](../../packages/database/src/generation-execution-repository.ts). The architectural baselines are [story context integrity](../architecture/story-context-integrity.md), [Story-only policy](../architecture/story-only-campaign-policy.md), and [structured character profiles](../architecture/0023-structured-character-profiles.md).

## Confirmed context defects

### F1 — High: authored world entities, relationships and playable-character records are omitted from generation authority

**Reproduced at the private-loader boundary; source traced to prompt assembly.** The canonical world schema puts `world`, `playableCharacters`, `entities`, and `relationships` alongside one another. The loader selects `campaignRow.world_content.world` as `worldCanon`. The executor forwards that object. It does not add the sibling records. The separate retrieval entity catalog can help match names but does not supply the missing full world records as narrative authority.

A fresh world can therefore contain a named gate's operating condition or a character relationship, yet the first Story Direction prompt only receives the overview and rules. The facts may appear later if narration repeats them, but that is an accidental dependency and cannot cover a first encounter.

Evidence: [world schema](../../packages/contracts/src/world-library.ts), lines 134–145; [private loader](../../packages/database/src/chronicle-generation-context.ts), worldCanon assignment and returned authority; [executor](../../services/runtime/src/generation-executor-adapter.ts), `planGenerationPromptContext`, lines 752–805. The retained probe gives the loader distinct sibling canaries and confirms all are absent while the rule survives.

**Repair:** introduce a typed private world projection containing the selected playable character and relevant immutable entities/relationships. Preserve mandatory rules completely. Do not blindly serialize all 20,000 entities or raw source-material appendices; select complete relevant records and make omissions observable. Verify a first-turn direction requiring a fact found only in a world entity and a relationship, with no Chronicle history.

### F2 — High: explicitly edited campaign character context is not supplied to story generation

**Reproduced at the private-loader boundary; source-confirmed contract conflict.** The authority query does not select `character_profile` or `character_snapshot`, and prompt planning has no effective-character field. The executor uses character context for illustration visual references, but not to populate story authority. Public preview's `worldFictionCanon` does call `characterNarrativeContext`, making preview and generation materially different.

This conflicts with ADR 0023's decision that the campaign copy overrides its origin snapshot and is fixed authoritative story context. An explicit saved background, identity, motivation, or appearance change is not guaranteed to reach the next story request. Entity-name matching cannot substitute for the full effective profile.

Evidence: [private loader](../../packages/database/src/chronicle-generation-context.ts); [preview projection](../../packages/database/src/chronicle-context-repository.ts), `worldFictionCanon`, lines 289–329; [ADR 0023](../architecture/0023-structured-character-profiles.md); [character save](../../packages/database/src/campaign-transfer-character-repository.ts), lines 143–220.

**Repair:** resolve the campaign-owned effective character in the private authority transaction, project fiction-safe profile fields, and bind the relevant profile revision to prompt/checkpoint identity. Test conflicting origin and edited profiles, first generation, next generation, repair and replacement. Keep the existing prohibition on profile edits while active generation exists.

### F3 — High: structured fact updates lose protected next-turn representation and plain facts lose their IDs

**Reproduced.** Commit stores `canonicalFacts` and `canonicalFactUpdates` separately. `materializeGenerationContinuity` reads only `canonicalFacts`; it ignores the structured updates. It also maps each plain string fact to `{ id: null, content }`. Therefore a valid structured-only fact update is absent from protected next-turn continuity, and plain accepted facts lack protected supersession identities.

The facts are still projected into `campaign_canonical_facts`; this is a context-selection defect, not proof of database loss. Optional historical fact retrieval can rescue the content and its UUID. However, budget/diversity selection can omit it. A fact that was explicitly corrected in the immediately preceding turn should not depend solely on optional retrieval to become visible as an identified current fact.

Evidence: [commit snapshot](../../packages/database/src/generation-execution-repository.ts), lines 675–687; [materializer](../../packages/database/src/campaign-continuity-repository.ts), lines 37–58; [fact projection](../../packages/database/src/chronicle-repository.ts), `projectCanonicalFacts`; [sent-fact allowlist](../../services/runtime/src/generation-executor-adapter.ts), `sentCanonicalFactIds`.

**Repair:** reconcile both accepted fact forms through the same identity-preserving projection when building private current authority, respecting explicit state corrections and the generation cutoff. Test a structured-only addition and supersession with an empty/omitted Chronicle candidate set; the next request must contain the surviving fact and its real allowed ID. Do not weaken the exact-request supersession allowlist or indiscriminately pin every historical fact.

### F4 — Medium: long Story Directions can consume every retrieval-query allowance before important later beats or hints

**Reproduced.** The API permits 12,000 characters of direction. Query planning defaults to 1,000 characters for the primary query, 1,400 for entity expansion and open threads, and 1,600 for scene queries. Each expanded query starts with the original direction, then appends its hints, and truncates the combined text. Deduplication can remove the remaining variants.

The retained 4,293-character probe produced only a 975-character primary query. Its last required beat, current-scene hint and unresolved-thread hint were absent from every planned query. The full direction still reaches the story model; the problem is failure to retrieve the history needed to execute its later beats. This result specifically demonstrates chunk query planning, not that every legacy lexical signal always loses the suffix.

Evidence: [input limit](../../packages/contracts/src/generation.ts), line 82; [query planner](../../packages/domain/src/chronicle-query-plan.ts), `DEFAULT_LIMITS`, `queryFrom`, and `planChronicleQueries`; [hint assembly](../../packages/database/src/chronicle-context-repository.ts), `plannedChunkQueries`.

**Repair:** give direction clauses, current scene and open threads independent query allowances. Extract bounded searches for each material beat, including late references, then union/deduplicate candidates. Start with deterministic clause/entity decomposition; evaluate a model-assisted planner only if needed. Test suffix-only facts, long dialogue, pronouns, aliases and multiple unrelated required beats at equal total budgets.

### F5 — Medium: old valid facts can become ineligible before relevance ranking

**Source-confirmed.** The cutoff-aware fact SQL computes lexical relevance but orders the candidate pool only by `source_turn_number DESC, source_fact_index`, then limits it. At a 32k retrieval allowance it loads at most 256 historical facts; at 128k, 1,024. In this generation cutoff path, grouped canonical-fact memories/chunks are deliberately excluded and the scoped fact projection supplies their replacements.

Once more recent active facts exceed that pool, an older valid fact's exact query match cannot promote the omitted fact through later rank fusion. Narration or summary retrieval may still reproduce its prose, but does not guarantee that fact's identified record or authorized supersession ID.

Evidence: [retrieval limits](../../packages/database/src/chronicle-context-repository.ts), lines 386–410; `loadContextMemories`, lines 489–504; cutoff exclusions in the same file around lines 445, 843, 882 and 1201.

**Repair:** construct the bounded pool as a union of query-relevant facts, entity-linked facts, temporal matches and a recency slice before applying a final cap. Preserve validity-at-cutoff and owner/world/campaign checks. Add a real-PostgreSQL case with an exact relevant oldest fact behind more than 256 newer active distractors at 32k, and verify both payload inclusion and supersession authorization.

## Intentional design tradeoffs and additional continuity risks

### G1 — High-priority design decision: continuity and required-beat correctness are prompt instructions, not acceptance invariants

Story-only explicitly sets `allowSceneCoverage: false`. Its parser receives output, not the original direction and previous continuity. It checks schema/mechanics and textual choice uniqueness; it cannot establish that every beat happened, that a dead character stayed dead, or that a promise was actually resolved. An unrelated but valid narration with empty summary, scratchpad and threads passes the retained parser probe. Commit uses those complete replacement values.

Empty replacements are intentionally legal and necessary for explicit corrections. This is not a recommendation to reject all empty values or silently restore old prose. Instead, add an evidence-linked continuity check: compare important prior commitments with proposed state, require resolution/supersession evidence for disappearance, and check direction coverage separately from mechanics. Keep bounded repair and safe recoverability. A model judge is fallible and should be calibrated against human review. Changing the single-call Story Direction policy needs an explicit architecture decision. Evidence: [policy](../../packages/domain/src/campaign-generation-policy.ts), [output parser](../../packages/story-engine/src/output.ts), [Story-only parser](../../packages/story-engine/src/story-only-output.ts), [wire contract](../../packages/contracts/src/story-prompt.ts), executor scene gate at line 1817.

### G2 — Medium: only the latest accepted turn is protected verbatim; eight recent turns are not guaranteed

The private loader directly protects the latest effective action/narration. `recentTurns: 8` is a candidate-loading hint. Every older candidate is optional and competes by rank and serialized size. With missing derived memory, the system still has current authority and the last turn, but does not directly reconstruct a recent multi-turn window from the accepted ledger.

This can lose conversational adjacency: a reply may depend on a question two turns ago, or a relationship change may need both an earlier statement and its correction. Consider a small, explicitly reserved contiguous accepted-turn window, then spend remaining space on relevant older evidence. Measure the tradeoff rather than hardcoding an unbounded window. If records cannot fit, report the missing coverage instead of clipping protected content. Evidence: [private latest-turn read](../../packages/database/src/chronicle-generation-context.ts), [candidate preparation](../../packages/database/src/chronicle-context-repository.ts), lines 534–566, and [whole-record planner](../../packages/story-engine/src/context-budget.ts).

### G3 — Medium: a relevant chunk may identify a parent too large to fit

Chunk retrieval finds localized evidence, but private generation deliberately returns full selected parent content. The budget planner either includes a whole record or omits it. Thus a small relevant passage inside a large old turn can be found yet remain absent from the request. Public preview may use selected chunk excerpts, so preview recall is not a substitute for final generation-payload recall.

Keep complete protected authority. For optional history, evaluate clearly labelled, source-linked excerpts around the matching passage and necessary adjacent context; never present an excerpt as a complete replacement record. This would revise the existing whole-parent generation policy and needs corresponding tests and documentation. Evidence: [private candidates](../../packages/database/src/chronicle-context-repository.ts), lines 546–566; [public parent content](../../packages/database/src/chronicle-context-repository.ts), around lines 2546–2552; [planner](../../packages/story-engine/src/context-budget.ts), `planContext`.

### G4 — Medium: present evaluation does not establish end-to-end long-campaign continuity

The repository has valuable retrieval fixtures and composed deterministic-provider tests. The retrieval evaluator's application interface uses `buildContextPreview`, while generation has a separate private final-budget path. Synthetic vectors and expected fixture responses prove application behavior; they do not measure whether a real model retains commitments over hundreds of generated replacements.

Add evaluation at the exact serialized request and accepted-output boundaries. Distinguish: relevant evidence absent from candidates; evidence found but evicted; evidence sent but ignored; output contradicts authority; summary/thread replacement loses a commitment. Evidence: [evaluation interface](../../scripts/lib/chronicle-retrieval-evaluator.ts), lines 1–8; [fixture provider](../../scripts/evaluate-chronicle-retrieval.ts), `fixtureVectorFor` and `retrievalApplication`; [testing requirements](../workflows/testing.md).

### Smaller issues to retain in the design review

- Historical fiction memory labels every submission `Player action:` and does not preserve scene mode in that text representation. This does not remove narration, but loses the distinction between an attempted action and required story direction when old input is retrieved. [Memory builder](../../packages/story-engine/src/chronicle.ts), lines 20–31.
- Numeric trackers are removed from fiction authority regardless of whether a number expresses a fictional quantity. The existing [tracker review](../architecture/scene-context-mechanics-review.md) remains unresolved. Define a typed fiction/mechanics distinction before widening this path; no safeguard was changed during this audit.
- The context-integrity document still describes a 1,000,000 maximum, whereas current contracts/retrieval support 4,000,000. Treat code and the provider's actual supported input/output allowance as the current limits, not that stale documentation sentence.

## Safeguards worth preserving

The implementation measures serialized context and full provider requests with separate ceilings, reserves output, uses an explicit estimated-token safety allowance, and fails rather than truncating protected state. The estimate is not tokenizer-exact. Configured context allowance is capacity, not a promise to fill the prompt or retrieve all history.

Current corrected continuity, including intentional empty values, takes precedence over old prose. Generation checks campaign/base identity, supports durable bounded repairs and exact-draft reclaim, and restricts fact supersession to IDs in the producing request. Canonical recovery does not depend on `previous_response_id`. Accepted-turn persistence and derived-memory writes occur within the guarded commit path. Illustration failure is independent of narration acceptance. These are important protections even though they do not establish semantic continuity.

The relevant source paths and focused test commands are listed above and below. Preserve their isolation, failure and replay tests during remediation; do not “fix” continuity by mixing campaigns, trusting a provider chain, or letting rejected drafts establish facts.

## Recommended improvement order

| Order | Work | Evidence needed before accepting it |
| --- | --- | --- |
| 1 | Restore missing world/character authority and identified current facts (F1–F3). | First-turn and next-turn serialized canaries; corrections, supersession, replacement and repair; no foreign-scope content. |
| 2 | Retrieve across the entire direction and search old active facts before pool truncation (F4–F5). | Late-beat/old-fact recall at equal budgets on both ready and fallback paths. |
| 3 | Establish long-campaign evaluation and actual payload coverage diagnostics (G4). | Source-labelled fixtures, exact request inspection, repeated configured-model runs and human-calibrated grading. |
| 4 | Decide continuity/beat validation and explicit thread lifecycle (G1). | False-positive rate, evidence-linked closures, unresolved-thread retention, bounded repair, no authority mutation on failure. |
| 5 | Evaluate a recent-window reserve, contextual chunk indexing, reranking and optional excerpts (G2–G3). | Better accepted-turn continuity at equal or justified token/latency cost, with no loss of protected authority. |

Research supports these as experiments, not guaranteed upgrades. Contextual indexing and reranking can improve evidence retrieval; position-sensitive long-context behavior argues against assuming more tokens always help; long-term memory evaluation should separately test temporal changes, updates and missing evidence. See the [primary-source research note](./story-direction-continuity-research-2026-09-12.md), which cites [Anthropic Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval), [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/), and [LongMemEval](https://arxiv.org/abs/2410.10813). None requires replacing PostgreSQL with a new memory service.

A useful campaign evaluation matrix should include 10-, 100-, 500- and 2,000-turn histories; a first-turn world-only constraint; an edited character; a structured-only fact correction; a promise dormant for many scenes; a closed thread that must stay closed; an alias; a direction whose last clause recalls an old event; intentionally unknown details; index unavailability; output recovery; latest-turn replacement; and similar-name foreign-campaign decoys. Score retrieval recall, final-payload evidence recall, contradictions, unsupported durable facts, thread retention/closure and direction fulfillment separately. Record model/protocol/index versions, budgets, token usage and latency. Compare against an oracle supplied with the known relevant accepted passages to separate retrieval failure from model failure.

## Verification record

- **Passed:** 310 focused tests in 28 unit files, covering Story Direction policy/prompts/output, generation execution/authority, Chronicle projection/query planning/ranking/diversity, budget guards, token estimates, prompt library and client input/context settings.
- **Passed:** retained [synthetic probes](./assets/story-direction-context-audit/probes.mjs) demonstrate F1–F4 boundary behavior and G1's parser limit. Run `node --import tsx docs/review/assets/story-direction-context-audit/probes.mjs` from the repository root. These assertions document current defects/limits; they are not approval tests for desired behavior.
- **Initial integration attempt failed in setup:** sandboxed Docker configuration access, then a password mismatch in the existing shared test database. No test assertions ran in those attempts.
- **Passed on real PostgreSQL:** all 23 distinct selected integration cases across `story-only-generation.integration.test.ts` (17), `story-continuity-remediation.integration.test.ts` (1) and `generation-budget-growth.integration.test.ts` (5), using deterministic providers. The first disposable run passed 14 and failed nine before their fixtures could start because `tmp/story-only-test/database.json` was absent. A second disposable container on the fixture's required localhost port 15439, with exclusively created temporary configuration, passed those nine. Its eight name-filtered cases were already passed in the first run; they are not counted twice. The runs used PostgreSQL 18 with `pgvector/pgvector:0.8.6-pg18-trixie` and the repository's per-file isolation setup, overriding only provisioning. Test files were unchanged. Both disposable containers and the temporary credential file were removed.
- **Passed:** retained probe rerun, 42 local document links, whitespace validation and `git diff --check`. The checkout retains only audit artifacts as untracked changes; application source and tests were not edited.
- **Not run:** live-provider campaign-quality evaluation, production-state/deployment audit, browser interaction tests, full repository test suite and application build. No application or visible UI behavior was changed; rendered browser evidence would not prove model continuity.

The audit does not authorize applying fact repairs, changing saved campaigns, rebuilding production memory or implementing the recommendations. Its deliverables are this report, the cited research note and reproducible synthetic probes.
