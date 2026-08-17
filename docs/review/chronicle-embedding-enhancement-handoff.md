# Chronicle Embedding Enhancement Handoff

**Status:** Feature outline for implementation planning  
**Prepared:** 2026-08-15  
**Planning constraint:** Existing accepted database turn rows must remain unchanged.

## Purpose

This document defines the complete feature scope for improving Chronicle's semantic retrieval quality, observability, and efficiency. It is intended for another agent to use as the authoritative input when producing an implementation plan.

This is not an implementation plan. It defines objectives, invariants, proposed features, lifecycle behavior, test expectations, rollout order, non-goals, and success criteria.

## Objective

Improve Chronicle's semantic retrieval quality, observability, and efficiency while preserving the current authority model:

- Existing accepted `turns` rows must remain completely unchanged.
- Enhancements may read accepted turns and their derived Chronicle projections.
- Enhancements may create, replace, or delete derived indexes.
- Improvements may affect prompts for future generations.
- They must never rewrite historical actions, narrations, mechanics, snapshots, timestamps, costs, or turn metadata.

## Mandatory invariants

These are non-negotiable requirements for the implementation plan.

### Accepted-turn immutability

The enhancement must never:

- `UPDATE` existing rows in `turns`.
- `DELETE` existing rows from `turns`.
- Add embedding or retrieval columns to `turns`.
- Add triggers that mutate turns.
- Rewrite narration to create embedding-friendly text.
- Store chunking or embedding metadata inside turn snapshots.
- Change turn timestamps or row versions during indexing.
- Treat embeddings, chunks, or retrieval rankings as authoritative campaign history.

Narration corrections remain append-only records in `turn_narration_corrections`. Chronicle consumes `effective_turn_narrations` when rebuilding, but the original turn narration remains intact.

### Derived-data isolation

All new data must be reconstructable from:

- Accepted turns.
- Effective narration corrections.
- Accepted state snapshots.
- State-correction records.
- The pinned world version and character snapshot.
- Existing fiction-safe Chronicle projections.

Dropping all new tables must not damage campaign history or prevent Chronicle from rebuilding them.

### Generation integrity

- Semantic retrieval remains optional.
- Semantic failure must fall back to lexical, entity, recency, and chronology retrieval.
- No embedding, reranking, evaluation, or cache failure may mutate campaign state.
- Only a failure of the authoritative base context path may block generation.
- Existing owner, campaign, world-version, and historical-turn cutoffs remain mandatory before ranking.

## Proposed feature set

### 1. Retrieval evaluation framework

Create a sanitized, deterministic Chronicle evaluation corpus before changing production ranking.

The corpus should cover:

- Exact historical references.
- Paraphrased references.
- Character and location aliases.
- Long-distance callbacks.
- Open-thread recall.
- Canonical facts.
- Superseded facts.
- Narration corrections.
- State corrections.
- Historical turn cutoffs.
- Branches.
- Replacements and rewinds.
- Cross-campaign decoys.
- Future-turn decoys.
- Queries that should return no historical memory.

Metrics should include:

- Recall at 5, 10, and 20.
- Mean reciprocal rank.
- Normalized discounted cumulative gain.
- Duplicate-result rate.
- Relevant memories per prompt token.
- Cross-campaign leakage count.
- Future-turn leakage count.
- Superseded-fact leakage count.
- Median and p95 retrieval latency.
- Embedding request count and cost.
- Semantic-only useful hits.
- Memories promoted or demoted relative to lexical-only retrieval.

The evaluator should call the same retrieval interface production generation uses. It must not test private ranking helpers directly.

### 2. Additive chunk projection

Introduce a new derived table such as `chronicle_memory_chunks`.

Each chunk should contain:

- New chunk UUID.
- Owner, campaign, and world-version scope.
- Parent `chronicle_memories` identity.
- Parent content hash.
- Memory kind.
- Turn ordinal or historical visibility ordinal.
- Chunk ordinal.
- Chunking protocol version.
- Fiction-safe chunk text.
- Chunk content hash.
- Estimated tokens.
- Entity IDs.
- Optional source offsets.
- Created and updated timestamps.
- Embedding metadata and vector.

The table should not reference or modify `turns` directly. Its parent is the derived Chronicle memory.

Required chunk types:

- Turn-action chunk.
- Turn-narration scene or paragraph chunks.
- Individual canonical-fact chunks.
- Individual open-thread chunks.
- Living-summary sections.
- Legacy-summary sections where applicable.

Chunking must be deterministic. The same parent content and protocol version must generate identical chunk hashes and ordering.

### 3. Provider-aware embedding limits

Add provider and model capability handling for:

- Maximum input tokens per document.
- Maximum batch items.
- Maximum batch tokens where known.
- Supported dimensions.
- Required query and document prefixes.
- Request timeout.
- Maximum safe retry count.

Before provider submission:

- Estimate or tokenize each chunk.
- Split any oversized chunk deterministically.
- Never rely on provider-side silent truncation.
- Reject incomplete batch responses.
- Verify consistent dimensions.
- Record the effective capability and profile fingerprint.

A chunk that cannot be safely embedded must be marked skipped with a sanitized reason while the remainder of the campaign continues indexing.

### 4. Versioned chunk embedding jobs

Preserve existing embedding jobs during rollout. Add a distinct versioned job path for chunk indexing rather than repurposing completed legacy jobs ambiguously.

The job must support:

- Campaign-scoped claiming.
- Existing lease and heartbeat behavior.
- Idempotent enqueue.
- Work-version increments when source Chronicle content changes.
- Content-aware upserts.
- Bounded batches.
- Resume from a durable cursor.
- Safe provider and model changes.
- Requeue when content changes during execution.
- Complete rebuild without touching turns.
- Safe cancellation or obsolescence when the campaign is deleted.

The database migration should create the new tables and queue derived work only. It must not synchronously rewrite existing campaigns or turns.

### 5. Multi-query semantic retrieval

Replace the single blended embedding query with deterministic query variants:

1. Current action only.
2. Entity-expanded current action.
3. Current action plus a bounded current-scene hint.
4. Open-thread-oriented query when active threads exist.

Requirements:

- Each query remains fiction-only.
- No additional LLM query-rewrite call is required.
- Query variants are bounded independently.
- Entity expansion uses only campaign and world-scoped entity identities.
- Historical generation never incorporates post-cutoff scene hints or entities.

Results from the variants should be fused rather than concatenated.

### 6. Calibrated hybrid rank fusion

Replace the fixed mixed-score formula with a rank-based approach such as reciprocal rank fusion.

Inputs should include:

- Semantic rank.
- Full-text rank.
- Entity-match rank.
- Recency rank.
- Chronological-coverage rank.
- Memory importance.
- Memory kind.
- Temporal validity.

Required ordering rules:

- Active canonical facts outrank contradictory historical prose.
- Superseded facts are ineligible for current-turn prompts.
- Future facts are ineligible for historical prompts.
- Current-scene continuity remains protected.
- Semantic similarity cannot override ownership or temporal eligibility.
- A high semantic score alone cannot make private or rejected data eligible.

Weights and thresholds must be set from evaluation results rather than intuition.

### 7. Result diversity and parent collapse

Prevent one turn or repeated fact from consuming most of the prompt.

Selection should:

- Collapse multiple matching chunks back to their parent memory.
- Prefer the strongest chunk as the parent's evidence.
- Optionally include adjacent chunks when needed for readability.
- Limit results per parent turn.
- Deduplicate normalized content.
- Deduplicate active canonical-fact lineage.
- Penalize highly similar already-selected results.
- Preserve variety across facts, events, characters, locations, and open threads.

The final prompt should still contain coherent parent-memory text, not an unexplained fragment.

### 8. Prompt-budget integration

Retain the existing external context interface and hard provider-owned prompt envelope.

The enhanced selector should continue returning:

- Authoritative rules.
- World canon.
- Campaign canon.
- Current scene.
- Selected Chronicle memories.
- Retrieval diagnostics.
- Compression and budget information.

Chunk details should remain internal unless required for safe diagnostics. The story model should receive coherent memory content, not vector scores or implementation metadata.

Existing removal priorities should be reviewed against the new memory kinds, but fixed authoritative scopes must continue to survive before optional historical memories.

### 9. Shadow comparison mode

Add an optional shadow mode that calculates:

- Existing lexical retrieval.
- Current legacy hybrid retrieval.
- Proposed chunked hybrid retrieval.

Only the configured production result enters the prompt. Shadow results are diagnostic.

Record only safe metadata:

- Candidate IDs and hashes.
- Parent memory IDs.
- Rank positions.
- Retrieval reason.
- Retrieval implementation version.
- Selected or not-selected outcome.
- Latency.
- Estimated prompt tokens.
- Provider and model fingerprint.
- Fallback reason.
- Cost attribution.

Do not store raw actions, narration, prompts, provider responses, or credentials in evaluation telemetry.

### 10. Query-embedding cache

Cache query embeddings for durable retries using a key composed of:

- Owner and campaign scope.
- Normalized expanded-query hash.
- Provider profile.
- Model.
- Provider fingerprint.
- Query prefix.
- Embedding protocol version.

The cache must be:

- Derived.
- Bounded by size or retention period.
- Safe to delete.
- Ineligible across campaigns.
- Invalidated automatically by provider or protocol changes.

This should optimize generation retries and context-preview repetitions without changing results.

### 11. Retrieval health and user-facing terminology

Rename the setting currently presented as memory to something explicit such as:

- Semantic Retrieval.
- Embedding Search.

Health should distinguish:

- Chronicle available.
- Semantic disabled.
- Indexing.
- Healthy.
- Partially indexed.
- Provider degraded.
- Provider unavailable.
- Retrieval fallback active.
- Chunk protocol outdated.
- Rebuild required.

The UI must make clear that Chronicle's local memory continues working while semantic retrieval is disabled.

### 12. Optional reranker

A reranker should be a later, separately gated enhancement.

If implemented, it must:

- Process only the top authorized Chronicle candidates.
- Never broaden campaign or temporal scope.
- Use an independently configured provider and model.
- Have a strict latency timeout.
- Fail open to the fused ranking.
- Run in shadow mode before affecting prompts.
- Demonstrate measurable improvement on the evaluation corpus.

It should not be required for the initial enhancement.

## Lifecycle behavior

### Existing campaigns

- Existing turns remain unchanged.
- Existing Chronicle memories remain usable during rollout.
- New chunk indexing runs asynchronously.
- Until chunk coverage is sufficient, production continues using the existing retrieval path.
- Partial chunk coverage must not produce a partially trusted mixed mode unless explicitly supported and tested.

### New accepted turns

- The existing acceptance transaction remains authoritative.
- Existing Chronicle projections continue to be written.
- Chunk and embedding work is queued as derived follow-up work.
- Failure to create chunks or embeddings must not roll back an otherwise valid accepted turn.
- The implementation plan must preserve the current stricter behavior for failure of the base Chronicle projection itself.

### Narration corrections

- Correction rows remain append-only.
- Existing turn narration remains untouched.
- Chronicle rebuild uses effective narration.
- Old chunks become ineligible by parent-content hash immediately.
- Replacement chunks are created asynchronously.

### State corrections

- Existing state-edit authority remains unchanged.
- Corrected summaries, facts, and threads produce new derived chunks.
- Superseded derived chunks become ineligible without modifying source turns.

### Branching

- Do not copy source-campaign chunks, vectors, caches, or retrieval telemetry.
- Branch authoritative history using the existing branch behavior.
- Build branch Chronicle projections using branch-owned memory IDs.
- Queue new branch chunk indexing.
- Preserve cost exclusion.
- Enforce branch campaign isolation throughout retrieval.

### Rewind or replacement

- Do not mutate historical turns outside the existing authoritative workflow.
- Invalidate or rebuild only derived Chronicle rows and chunks.
- Enforce `throughTurnNumber` before semantic ranking.
- Never retrieve a chunk beyond the historical boundary.

### Import

- Portable and legacy imports create authority through existing import paths.
- Imported turns remain unchanged after publication.
- Derived chunk indexing begins only after successful publication.
- Indexing failure does not invalidate the imported campaign.

### Export

- Do not include vectors, query caches, shadow telemetry, or chunk indexes in portable exports.
- Continue exporting authoritative and portable Chronicle information.
- Imports rebuild local derived indexes using the destination installation's provider configuration.

### Campaign deletion

- Derived chunks, caches, jobs, and telemetry cascade with the campaign.
- Shared asset or provider records remain governed by their existing lifecycles.
- No cleanup process may traverse into unrelated owner or campaign scopes.

## Module and interface direction

Keep the existing generation-facing interface small:

```ts
buildContextPreview(database, scope): Promise<ChronicleContextPreview>
```

Internally, deepen the Chronicle module with private seams for:

- Deterministic chunking.
- Candidate loading.
- Query planning.
- Semantic scoring.
- Rank fusion.
- Diversity selection.
- Prompt-budget selection.
- Evaluation recording.
- Health projection.

Do not expose every internal algorithm through `MemoryGenerationTransactionPort`. Tests should primarily exercise the existing Chronicle context interface and PostgreSQL lifecycle behavior.

Primary current implementation locations:

- `packages/database/src/chronicle-repository.ts`
- `services/runtime/src/chronicle-worker-execution.ts`
- `services/runtime/src/chronicle-platform-adapter.ts`
- `packages/application/src/memory/ports.ts`
- `packages/application/src/memory/types.ts`
- `packages/contracts/src/memory.ts`
- `database/migrations/0007_semantic_chronicle.sql`
- `database/migrations/0012_dynamic_chronicle.sql`
- `database/migrations/0024_structured_canonical_facts.sql`
- `database/migrations/0039_chronicle_entity_identity.sql`

## Required test coverage

### Immutability proof

For representative existing campaigns, snapshot every turn column and PostgreSQL row version before:

- Migration.
- Backfill.
- Reindex.
- Retrieval.
- Provider change.
- Correction rebuild.
- Branch indexing.

After each operation, prove:

- Same turn count.
- Same IDs.
- Same actions and stored narrations.
- Same private mechanics and snapshots.
- Same timestamps.
- Same costs and provenance.
- Same PostgreSQL row versions, demonstrating no hidden update.

### Derived-data behavior

Prove:

- Chunking is deterministic.
- Rebuild is idempotent.
- Stale hashes are immediately ineligible.
- Chunk deletion followed by rebuild is lossless.
- Provider and model changes invalidate only vectors.
- Partial jobs resume safely.
- Lease loss cannot commit stale batches.
- Oversized content is split rather than silently truncated.

### Retrieval quality and isolation

Prove:

- Exact and paraphrased recall.
- Alias recall.
- Active-fact precedence.
- Historical cutoff enforcement.
- Cross-campaign isolation.
- Cross-owner isolation.
- Result diversity.
- Parent collapse.
- Prompt-budget compliance.
- Lexical fallback under every semantic failure mode.

### Lifecycle compatibility

Cover:

- Existing campaigns.
- New turns.
- Narration corrections.
- State corrections.
- Branches.
- Replacements.
- Historical inspection.
- Legacy import.
- Portable import and export.
- Campaign deletion.
- Provider deletion or disablement.

Recommended existing test locations to extend or use as behavioral references:

- `tests/integration/import-memory.integration.test.ts`
- `tests/integration/chronicle-repository.integration.test.ts`
- `tests/integration/chronicle-contract-matrix.integration.test.ts`
- `tests/integration/chronicle-completion-audit.integration.test.ts`
- `tests/integration/generation.integration.test.ts`
- `tests/integration/campaign-state-corrections.integration.test.ts`
- `tests/integration/turn-narration-corrections.integration.test.ts`
- `tests/integration/campaign-authority-repository.integration.test.ts`
- `tests/integration/campaign-archive.integration.test.ts`
- `tests/integration/migrations.integration.test.ts`
- `tests/unit/chronicle-worker-execution.test.ts`
- `tests/unit/chronicle-runtime-adapter.test.ts`
- `tests/unit/chronicle-transaction-repository.test.ts`

## Rollout order for the implementation plan

1. Freeze invariants and add turn-immutability regression coverage.
2. Build the evaluation corpus and baseline existing retrieval.
3. Add the derived chunk schema with no production consumer.
4. Implement deterministic provider-aware chunking.
5. Implement versioned chunk embedding jobs and backfill.
6. Add multi-query retrieval and rank fusion behind a disabled feature flag.
7. Add diversity selection and prompt-budget integration.
8. Add shadow comparison and operational metrics.
9. Run evaluation and calibrate ranking.
10. Enable chunked retrieval for selected campaigns.
11. Add query-vector caching.
12. Consider an optional reranker only after measured results.
13. Retain legacy embeddings until a separate, explicitly approved cutover.
14. Remove legacy derived structures only in a future cleanup, not as part of this enhancement.

## Explicit non-goals

- Modifying existing turn rows.
- Rewriting accepted narration.
- Replacing PostgreSQL as authority.
- Replacing Chronicle with a vector database.
- Adding a graph-memory platform during the initial enhancement.
- Exporting embeddings as portable authority.
- Making semantic retrieval required for story generation.
- Allowing embeddings to override temporal or ownership filters.
- Adding an LLM query-rewrite dependency by default.
- Removing the current lexical fallback.
- Cleaning up legacy embeddings during the same rollout.

## Planning questions the next agent must resolve

The implementation plan should explicitly decide:

1. The final additive table and index names.
2. Whether chunk vectors live with chunk rows or in a separate vector table.
3. The deterministic chunking rules for each memory kind.
4. The chunking and embedding protocol-version strategy.
5. The provider-capability source and behavior when capabilities are unknown.
6. The new Chronicle job type and its interaction with existing work versions.
7. The exact feature flag or campaign configuration used for shadow and production selection.
8. The rank-fusion algorithm and how evaluation selects its parameters.
9. The diversity and parent-collapse policy.
10. The minimum chunk-index coverage required before production use.
11. The telemetry storage location and retention policy.
12. The query-cache size, retention, and invalidation policy.
13. Whether a reranker is excluded entirely from the first implementation plan or retained as a separately gated final phase.
14. The rollback procedure that restores legacy retrieval without touching accepted turns.

## Definition of success

The enhancement is successful when:

- Existing turn rows are demonstrably untouched.
- Existing campaigns remain fully playable during migration and indexing.
- Semantic retrieval improves the agreed evaluation metrics.
- Cross-owner, cross-campaign, future-turn, and superseded-fact leakage remain zero.
- Prompt budgets remain enforced.
- Semantic failure still produces a normal lexical Chronicle prompt.
- Branches, corrections, imports, and exports preserve current authority semantics.
- The old retrieval implementation can remain available until an independently approved cutover.

