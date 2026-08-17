# Chronicle Embedding Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Chronicle retrieval quality, observability, and efficiency with deterministic chunk embeddings and calibrated hybrid ranking while proving that accepted turn rows remain unchanged.

**Architecture:** Preserve `MemoryGenerationTransactionPort.buildContextPreview(database, scope)` as the sole generation-facing interface and deepen the Chronicle module behind it. Add campaign-scoped chunk, job, telemetry, and cache projections beside the existing Chronicle tables; keep legacy retrieval available, select chunked retrieval only after a complete current-protocol index, and fail open to the existing lexical/entity/recency/chronology path whenever optional semantic work fails.

**Tech Stack:** TypeScript 7, Node.js 22+, PostgreSQL 18, pgvector, Zod, Vitest, existing OpenAI-compatible embedding transport, vanilla TypeScript DOM UI.

## Global Constraints

- Existing accepted `turns` rows are immutable: never update/delete them for indexing, add embedding columns or mutation triggers to them, or place chunk metadata in turn snapshots.
- `turn_narration_corrections` remains append-only; rebuilds read `effective_turn_narrations` and never rewrite `turns.narration`.
- Every new row and query is owner-, campaign-, and world-version-scoped before ranking; `throughTurnNumber` is applied before semantic scoring and scene/entity expansion.
- Chunks, vectors, cache rows, telemetry, and jobs are derived and excluded from portable exports. Dropping them must not damage authority or prevent a rebuild.
- Semantic, cache, telemetry, evaluation, and reranking failures never mutate campaign state or block generation. The existing authoritative base-context failure behavior remains strict.
- Keep text and embedding providers independent. Never copy credentials or return provider secrets, raw prompts, actions, narration, responses, or errors in telemetry.
- Retain the legacy `embed_campaign` path and legacy vectors throughout this implementation. Their removal requires a separate approval and plan.
- Update both active browser interfaces: the packaged legacy Nexus UI at `/nexus/` (`apps/web`) and the replacement UI at `/app/` (`apps/web-next`). The root `index.html` is reference-only and remains unchanged.
- Keep both browser interfaces as thin adapters over the same shared memory config, metrics, health, context-preview, and reindex contracts. They must expose the same retrieval implementation choices, shadow setting, health meanings, fallback reason, coverage, and Chronicle-availability message.
- Perform all browser UI and UI-test changes only after the schema, domain, worker, retrieval, observability, calibration, cache, lifecycle, and documentation work is complete. The final implementation task owns both UIs and the complete verification run.
- Use two-space indentation, `camelCase` values, `PascalCase` types, `UPPER_SNAKE_CASE` constants, `const` by default, and shared Zod schemas at untrusted boundaries.
- Use strict TDD for each behavior: observe the focused test fail for the stated reason, implement the minimum change, rerun to green, then refactor.
- PostgreSQL tests count as runtime verification only when `TEST_DATABASE_URL` is present and the test output shows execution rather than skips.
- The optional reranker is excluded. Reconsider it only in a separate plan after shadow data shows a measurable corpus improvement within a separately agreed latency budget.

## Resolved Design Decisions

1. Migration names are `0072_chronicle_memory_chunks.sql`, `0073_chronicle_chunk_job_fencing.sql`, `0074_chronicle_retrieval_observability.sql`, and `0075_chronicle_query_embedding_cache.sql`. The fencing upgrade is additive: it backfills deterministic work signatures, requeues pre-token running claims, and never rewrites `0072` after it has been applied.
2. `chronicle_memory_chunks` owns both text metadata and its nullable `vector`; keeping them together makes content/vector eligibility atomic. Exact campaign-scoped pgvector scans remain in use; no ANN index is added.
3. `chronicle_memories` gains only a generated SHA-256 `content_hash`. It remains derived. `turns` receives no column, trigger, or write.
4. Chunk protocol `chronicle-chunk-v1` uses NFKC/LF normalization and deterministic ordering. Turn action is one chunk; narration is paragraph/sentence-packed; each canonical fact and open thread is one chunk; living and legacy summaries are heading/paragraph/sentence-packed.
5. Provider capabilities come from the runtime provider descriptor plus safe optional configuration overrides. Unknown batch capabilities use one item per request; unknown token capacity uses half of the configured context window capped at 8,192 tokens; unknown dimensions are learned from the first complete batch and then pinned.
6. New work uses the separate `chronicle_chunk_jobs` table with fixed job kind `index_memory_chunks_v2`. Older workers cannot see or misinterpret it. The new worker reuses lease, heartbeat, work-version, content-aware commit, and durable-cursor semantics.
7. `campaign_memory_configs` gains `retrieval_implementation` (`legacy_hybrid` or `chunked_hybrid`) and `retrieval_shadow_enabled`. Defaults are `legacy_hybrid` and `false`.
8. Chunked retrieval uses weighted reciprocal-rank fusion. The production profile is generated deterministically from the evaluation corpus; no hand-tuned weight becomes production configuration.
9. Diversity policy selects at most one parent initially, at most two parents from one turn, collapses canonical-fact lineage, removes normalized duplicates, and uses maximal-marginal-relevance only as a deterministic penalty after rank fusion.
10. Chunked production is eligible only when every current parent hash has current-protocol chunks in a terminal state (`embedded` or sanitized `skipped`), at least one chunk is embedded, and no current chunk job is queued/running/failed. Otherwise the complete legacy path is used; there is no partially trusted mixed production mode.
11. Safe shadow metadata is stored for 30 days and capped at 5,000 runs per campaign. Query embeddings are retained for 7 days and capped at 256 entries per campaign.
12. Rollback is a configuration update to `legacy_hybrid` and `retrieval_shadow_enabled=false`; no turn, parent Chronicle memory, or legacy vector changes are required.

## File and Module Map

- `packages/domain/src/chronicle-chunking.ts`: deterministic fiction-safe chunk projection and provider-aware splitting.
- `packages/domain/src/chronicle-embedding-capabilities.ts`: closed capability resolution and retry limits.
- `packages/domain/src/chronicle-query-plan.ts`: bounded fiction-only query variants.
- `packages/domain/src/chronicle-rank-fusion.ts`: rank fusion and generated profile types.
- `packages/domain/src/chronicle-diversity.ts`: parent collapse, lineage/content deduplication, and diversity selection.
- `packages/database/src/chronicle-chunk-repository.ts`: chunk-job claiming, paging, atomic batch commit, coverage, invalidation, and cleanup.
- `packages/database/src/chronicle-context-repository.ts`: extracted deep context implementation; legacy and chunked paths remain private behind `buildContextPreview`.
- `packages/database/src/chronicle-retrieval-observability-repository.ts`: safe shadow-run persistence and retention.
- `packages/database/src/chronicle-query-cache-repository.ts`: scoped derived query-vector cache and pruning.
- `services/runtime/src/chronicle-chunk-worker-execution.ts`: capability-aware batching, retry, skip, cursor, and lease handling.
- `scripts/evaluate-chronicle-retrieval.ts`: deterministic corpus runner that calls the production context interface.
- `packages/domain/src/generated/chronicle-retrieval-profile-v2.ts`: evaluator-generated, checked-in production profile with corpus hash and metrics.
- `apps/web/public/index.html`, `apps/web/public/nexus.js`, `apps/web/public/nexus.css`, and `apps/web/src/story.js`: packaged legacy `/nexus/` Chronicle controls, health projection, status styling, and cost terminology.
- `apps/web-next/src/campaign-editor-page.ts` and `apps/web-next/src/styles.css`: replacement `/app/` Chronicle controls, health projection, and status styling.

---

### Task 1: Freeze authority invariants and record the architecture decision

**Files:**
- Create: `docs/architecture/0028-chunked-chronicle-retrieval.md`
- Create: `tests/helpers/turn-row-snapshot.ts`
- Create: `tests/integration/chronicle-turn-immutability.integration.test.ts`

**Interfaces:**
- Produces `snapshotTurnRows(database, ownerUserId, campaignId): Promise<readonly TurnRowSnapshot[]>`.
- `TurnRowSnapshot` contains `id`, `data` (all ordinary columns), and PostgreSQL `xmin` as text.

- [x] **Step 1: Write the failing turn snapshot and migration tests**

Use one query so hidden updates are visible:

```ts
export async function snapshotTurnRows(database, ownerUserId: string, campaignId: string) {
  const result = await database.query(
    `SELECT turn_row.id, to_jsonb(turn_row) AS data, turn_row.xmin::text AS xmin
       FROM turns turn_row
      WHERE owner_user_id = $1 AND campaign_id = $2
      ORDER BY turn_number, id`,
    [ownerUserId, campaignId]
  );
  return result.rows;
}
```

Seed a corrected campaign, snapshot it, and assert exact equality after legacy reindex, legacy embedding, context retrieval, provider configuration change, narration rebuild, and source-campaign branch indexing. Task 3 adds the same helper to the `0071` to `0072` migration proof once that migration exists.

- [x] **Step 2: Run the focused PostgreSQL tests and verify RED**

```bash
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-turn-immutability.integration.test.ts
```

Expected: the new helper/test import fails because the files do not exist. If `TEST_DATABASE_URL` is absent, stop this task and report the integration prerequisite instead of calling a skipped run proof.

- [x] **Step 3: Implement the helper and ADR**

The ADR must record the twelve resolved decisions above, identify `buildContextPreview` as the external seam, state that internal ranking modules are not added to `MemoryGenerationTransactionPort`, and include this rollback:

```sql
UPDATE campaign_memory_configs
   SET retrieval_implementation = 'legacy_hybrid',
       retrieval_shadow_enabled = false,
       updated_at = now()
 WHERE retrieval_implementation <> 'legacy_hybrid' OR retrieval_shadow_enabled;
```

- [x] **Step 4: Rerun the focused tests and verify GREEN**

Run the command from Step 2. Expected: all cases execute and pass with identical `xmin` values.

- [x] **Step 5: Commit**

```bash
git add docs/architecture/0028-chunked-chronicle-retrieval.md tests/helpers/turn-row-snapshot.ts tests/integration/chronicle-turn-immutability.integration.test.ts
git commit -m "Freeze Chronicle turn immutability"
```

---

### Task 2: Build the deterministic retrieval corpus and legacy baseline

**Files:**
- Create: `tests/fixtures/chronicle-retrieval-evaluation.v1.json`
- Create: `scripts/lib/chronicle-retrieval-evaluator.ts`
- Create: `scripts/evaluate-chronicle-retrieval.ts`
- Create: `tests/unit/chronicle-retrieval-evaluator.test.ts`
- Create: `tests/integration/chronicle-retrieval-evaluation.integration.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `evaluateChronicleRetrieval(application, database, corpus, options): Promise<ChronicleEvaluationReport>`.
- Calls only `application.generation.buildContextPreview(database, scope)` for retrieval.
- Produces recall@5/10/20, MRR, NDCG, duplicate rate, relevant memories per prompt token, three leakage counts, latency p50/p95, embedding requests/cost, semantic-only hits, and promotion/demotion counts.

- [x] **Step 1: Write failing evaluator metric tests**

Use synthetic ranked labels and assert exact formulas:

```ts
expect(recallAt(["a", "x", "b"], new Set(["a", "b"]), 2)).toBe(0.5);
expect(reciprocalRank(["x", "b"], new Set(["b"]))).toBe(0.5);
expect(leakageCounts(results)).toEqual({ crossCampaign: 0, futureTurn: 0, supersededFact: 0 });
expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
```

The integration test must prove the evaluator reaches the production interface by spying on `buildContextPreview` and must fail if a private ranking helper is injected.

- [x] **Step 2: Run evaluator tests and verify RED**

```bash
pnpm exec vitest run tests/unit/chronicle-retrieval-evaluator.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-retrieval-evaluation.integration.test.ts
```

Expected: FAIL because the evaluator and corpus do not exist.

- [x] **Step 3: Add the sanitized corpus and runner**

The corpus must contain at least these stable case IDs: `exact-reference`, `paraphrase`, `character-alias`, `location-alias`, `long-callback`, `open-thread`, `active-fact`, `superseded-fact`, `narration-correction`, `state-correction`, `historical-cutoff`, `branch-isolation`, `replacement`, `rewind`, `cross-campaign-decoy`, `future-turn-decoy`, and `no-memory`. Each expected result uses a logical fixture label rather than a generated UUID. Include at least two relevant labels in four cases so recall and NDCG are meaningful.

Add this script contract:

```json
"evaluate:chronicle": "tsx scripts/evaluate-chronicle-retrieval.ts"
```

Default output is `tmp/chronicle-evaluation/legacy-baseline.json`; the report contains only fixture labels, hashes, ranks, metrics, latency, and cost totals.

- [x] **Step 4: Run tests and capture the baseline**

```bash
pnpm exec vitest run tests/unit/chronicle-retrieval-evaluator.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-retrieval-evaluation.integration.test.ts
pnpm evaluate:chronicle -- --implementation legacy_hybrid --output tmp/chronicle-evaluation/legacy-baseline.json
```

Expected: tests pass; the evaluator reports zero cross-campaign and future-turn leakage. Record the baseline metrics in the ADR without checking the generated report into Git.

- [x] **Step 5: Commit**

```bash
git add package.json scripts/evaluate-chronicle-retrieval.ts scripts/lib/chronicle-retrieval-evaluator.ts tests/fixtures/chronicle-retrieval-evaluation.v1.json tests/unit/chronicle-retrieval-evaluator.test.ts tests/integration/chronicle-retrieval-evaluation.integration.test.ts docs/architecture/0028-chunked-chronicle-retrieval.md
git commit -m "Add Chronicle retrieval evaluation baseline"
```

---

### Task 3: Add isolated chunk and chunk-job schema

**Files:**
- Create: `database/migrations/0072_chronicle_memory_chunks.sql`
- Modify: `packages/contracts/src/memory.ts`
- Modify: `packages/application/src/memory/types.ts`
- Modify: `packages/application/src/memory/ports.ts`
- Modify: `tests/integration/migrations.integration.test.ts`
- Modify: `tests/unit/memory-application.test.ts`

**Interfaces:**
- Adds `RetrievalImplementation = "legacy_hybrid" | "chunked_hybrid"`.
- Adds configuration fields `retrievalImplementation` and `retrievalShadowEnabled` without changing `buildContextPreview`.
- Adds chunk job type `index_memory_chunks_v2` only to the new table.

- [x] **Step 1: Write failing schema and contract tests**

Assert exact table names, columns, checks, cascades, indexes, defaults, and absence of any `turns` schema change. In a temporary database migrated only through `0071`, seed turns, capture `snapshotTurnRows`, apply `0072`, and compare count, IDs, every JSON column, and `xmin`. Test that mismatched owner/campaign/world parent scope fails and campaign deletion cascades chunks/jobs.

- [x] **Step 2: Run tests and verify RED**

```bash
pnpm exec vitest run tests/unit/memory-application.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/migrations.integration.test.ts
```

Expected: missing retrieval fields and tables.

- [x] **Step 3: Implement migration `0072`**

Create:

```sql
ALTER TABLE chronicle_memories
  ADD COLUMN content_hash text GENERATED ALWAYS AS (encode(digest(content, 'sha256'), 'hex')) STORED,
  ADD CONSTRAINT chronicle_memories_chunk_parent_scope_unique
    UNIQUE (id, owner_user_id, campaign_id, world_version_id);

ALTER TABLE campaign_memory_configs
  ADD COLUMN retrieval_implementation text NOT NULL DEFAULT 'legacy_hybrid'
    CHECK (retrieval_implementation IN ('legacy_hybrid','chunked_hybrid')),
  ADD COLUMN retrieval_shadow_enabled boolean NOT NULL DEFAULT false;
```

`chronicle_memory_chunks` must contain the columns listed in the handoff plus `chunk_kind`, `embedding_status`, `embedding_skip_reason`, `embedding_protocol_version`, and provider fingerprint fields. Use a composite FK to the new parent-scope unique constraint with `ON DELETE CASCADE`. Add unique `(parent_memory_id,parent_content_hash,chunking_protocol_version,chunk_ordinal)` and scope, GIN full-text, GIN entity, and partial embedded-scope indexes.

`chronicle_chunk_jobs` mirrors lease/work-version/progress timestamps, constrains `job_type='index_memory_chunks_v2'`, cascades with `(campaign_id,owner_user_id)`, and has one-active-job-per-campaign plus claim indexes. Queue one job for each currently enabled campaign; do not create chunks or touch turns in the migration.

- [x] **Step 4: Run tests and verify GREEN**

Run Step 2 plus:

```bash
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-turn-immutability.integration.test.ts
```

Expected: schema tests and `xmin` proof pass.

- [x] **Step 5: Commit**

```bash
git add database/migrations/0072_chronicle_memory_chunks.sql packages/contracts/src/memory.ts packages/application/src/memory/types.ts packages/application/src/memory/ports.ts tests/integration/migrations.integration.test.ts tests/unit/memory-application.test.ts
git commit -m "Add isolated Chronicle chunk schema"
```

---

### Task 4: Implement deterministic chunking and provider capabilities

**Files:**
- Create: `packages/domain/src/chronicle-chunking.ts`
- Create: `packages/domain/src/chronicle-embedding-capabilities.ts`
- Create: `tests/unit/chronicle-chunking.test.ts`
- Create: `tests/unit/chronicle-embedding-capabilities.test.ts`
- Modify: `packages/application/src/providers/types.ts`
- Modify: `packages/application/src/providers/use-cases.ts`
- Modify: `services/runtime/src/chronicle-platform-bindings.ts`
- Modify: `tests/unit/provider-application.test.ts`
- Modify: `tests/unit/chronicle-runtime-adapter.test.ts`

**Interfaces:**
- Produces `chunkChronicleMemory(parent, policy): readonly ChronicleChunkDraft[]`.
- Produces `splitChunkForCapability(chunk, capability): readonly ChronicleChunkDraft[]`.
- Produces `resolveEmbeddingCapability(provider): EmbeddingCapability`.
- `EmbeddingCapability` includes `maxInputTokens`, `maxBatchItems`, `maxBatchTokens`, `expectedDimensions`, `documentPrefix`, `queryPrefix`, `requestTimeoutMs`, and `maxRetries`.

- [x] **Step 1: Write failing chunk/capability tests**

Cover every memory kind, CRLF/NFKC normalization, repeated runs producing identical hashes/order, source offsets, paragraph packing, sentence splitting, a single overlong sentence, prefix reservation, unknown capability defaults, configured dimensions, incomplete batch rejection, and dimension mismatch.

```ts
expect(chunkChronicleMemory(parent, policy)).toEqual(chunkChronicleMemory(parent, policy));
expect(splitChunkForCapability(oversized, capability).every((chunk) =>
  chunk.estimatedTokens + capability.documentPrefixTokens <= capability.maxInputTokens
)).toBe(true);
```

- [x] **Step 2: Run tests and verify RED**

```bash
pnpm exec vitest run tests/unit/chronicle-chunking.test.ts tests/unit/chronicle-embedding-capabilities.test.ts tests/unit/provider-application.test.ts tests/unit/chronicle-runtime-adapter.test.ts
```

Expected: new modules and safe fields are missing.

- [x] **Step 3: Implement deterministic rules and closed safe overrides**

Add safe numeric configuration keys `embeddingMaxInputTokens`, `embeddingMaxBatchItems`, `embeddingMaxBatchTokens`, `embeddingDimensions`, and `embeddingMaxRetries`. Enforce ranges `128..1_000_000`, `1..128`, `128..4_000_000`, `1..16_000`, and `0..5` respectively.

Use protocol `chronicle-chunk-v1`; pack narration/summary to 384 estimated tokens with 32-token adjacency overlap, and facts/threads/actions without overlap. Reserve prefix tokens plus an 8% safety margin before submission. Unknown capability resolves to batch item count `1`, token capacity `min(8192, floor(contextWindowTokens / 2))`, no expected dimensions, the provider request timeout, and two retries.

- [x] **Step 4: Run tests and verify GREEN**

Run Step 2. Expected: all selected tests pass and provider projections contain capability values but no credentials.

- [x] **Step 5: Commit**

```bash
git add packages/domain/src/chronicle-chunking.ts packages/domain/src/chronicle-embedding-capabilities.ts packages/application/src/providers/types.ts packages/application/src/providers/use-cases.ts services/runtime/src/chronicle-platform-bindings.ts tests/unit/chronicle-chunking.test.ts tests/unit/chronicle-embedding-capabilities.test.ts tests/unit/provider-application.test.ts tests/unit/chronicle-runtime-adapter.test.ts
git commit -m "Add deterministic Chronicle chunking"
```

---

### Task 5: Add resumable versioned chunk indexing

**Files:**
- Create: `database/migrations/0073_chronicle_chunk_job_fencing.sql`
- Create: `packages/database/src/chronicle-chunk-repository.ts`
- Create: `services/runtime/src/chronicle-chunk-worker-execution.ts`
- Create: `tests/integration/chronicle-chunk-repository.integration.test.ts`
- Create: `tests/unit/chronicle-chunk-worker-execution.test.ts`
- Modify: `packages/application/src/memory/types.ts`
- Modify: `packages/application/src/memory/ports.ts`
- Modify: `packages/database/src/chronicle-repository.ts`
- Modify: `services/runtime/src/chronicle-platform-adapter.ts`
- Modify: `services/runtime/src/memory-composition.ts`
- Modify: `packages/database/src/provider-repository.ts`
- Modify: `docs/architecture/0028-chunked-chronicle-retrieval.md`
- Modify: `tests/integration/chronicle-contract-matrix.integration.test.ts`

**Interfaces:**
- Produces `ChronicleChunkJobStatePort`, `ChronicleChunkParentPort`, and `ChronicleChunkBatchPort` as worker-only interfaces.
- Produces `enqueueChunkIndex(database, scope): Promise<string | null>` on `MemoryGenerationTransactionPort`; no chunk algorithm is exposed there.
- Durable progress is `{ parentCursor, processedParents, embeddedChunks, skippedChunks, totalParents, capabilityFingerprint }`.
- Every claim has a unique lease token and deterministic work signature; all worker transitions fence the token, work version, owner/campaign/world version, and the campaign's current world version.

- [x] **Step 1: Write failing job lifecycle tests**

Test idempotent enqueue, campaign-scoped `SKIP LOCKED` claim, lease heartbeat/loss, resume without resetting the durable cursor, work-version reset on parent content change, provider/model vector-only invalidation, deterministic upsert, stale batch rejection, incomplete response rollback, bounded capability batches, retries limited to 250ms/500ms backoff, sanitized per-chunk skip reason, and cancellation by campaign cascade.

- [x] **Step 2: Run tests and verify RED**

```bash
pnpm exec vitest run tests/unit/chronicle-chunk-worker-execution.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-chunk-repository.integration.test.ts tests/integration/chronicle-contract-matrix.integration.test.ts
```

Expected: new ports/repository/executor are absent.

- [x] **Step 3: Implement job execution and atomic commits**

Create `0073_chronicle_chunk_job_fencing.sql` as the upgrade-safe companion to committed `0072`: add the lease token and deterministic work-signature columns, requeue pre-token running claims with an incremented work version and cleared progress/lease, and backfill signatures without touching turns. Keep the new repository SQL in `chronicle-chunk-repository.ts`, not the already-large legacy repository. Page parents by `(ordinal,id)`, compare `parent_content_hash` to generated `chronicle_memories.content_hash`, and commit chunks, vectors, cost, job progress, and lease extension in one transaction. An unchanged duplicate enqueue preserves its cursor/work version; a changed parent/work signature requeues with cleared cursor. Provider/model/fingerprint changes clear only chunk vector metadata and enqueue a new work version.

After a successful accepted parent-memory write/rebuild, enqueue `index_memory_chunks_v2` when semantic retrieval or shadow mode is enabled. Provider failures mark the chunk job failed and leave generation/legacy Chronicle usable.

- [x] **Step 4: Run tests and verify GREEN**

Run Step 2 plus existing worker tests:

```bash
pnpm exec vitest run tests/unit/chronicle-worker-execution.test.ts tests/unit/chronicle-runtime-adapter.test.ts tests/unit/worker-concurrency.test.ts
```

Expected: legacy jobs are unchanged; chunk jobs resume and fence stale claimants.

- [x] **Step 5: Commit**

```bash
git add database/migrations/0073_chronicle_chunk_job_fencing.sql packages/database/src/chronicle-chunk-repository.ts services/runtime/src/chronicle-chunk-worker-execution.ts packages/application/src/memory/types.ts packages/application/src/memory/ports.ts packages/database/src/chronicle-repository.ts services/runtime/src/chronicle-platform-adapter.ts services/runtime/src/memory-composition.ts packages/database/src/provider-repository.ts docs/architecture/0028-chunked-chronicle-retrieval.md tests/integration/chronicle-chunk-repository.integration.test.ts tests/unit/chronicle-chunk-worker-execution.test.ts tests/integration/chronicle-contract-matrix.integration.test.ts tests/integration/migrations.integration.test.ts tests/unit/chronicle-transaction-repository.test.ts tests/unit/memory-application.test.ts tests/unit/chronicle-runtime-adapter.test.ts
git commit -m "Add resumable Chronicle chunk indexing"
```

---

### Task 6: Add bounded multi-query retrieval and calibrated rank-fusion machinery

**Files:**
- Create: `packages/domain/src/chronicle-query-plan.ts`
- Create: `packages/domain/src/chronicle-rank-fusion.ts`
- Create: `packages/database/src/chronicle-context-repository.ts`
- Create: `tests/unit/chronicle-query-plan.test.ts`
- Create: `tests/unit/chronicle-rank-fusion.test.ts`
- Create: `tests/integration/chronicle-chunk-retrieval.integration.test.ts`
- Modify: `packages/database/src/chronicle-repository.ts`
- Modify: `tests/unit/chronicle-transaction-repository.test.ts`

**Interfaces:**
- Produces `planChronicleQueries(input): readonly ChronicleQueryVariant[]` with kinds `action`, `entity_expanded`, `scene`, and `open_thread`.
- Produces `fuseChronicleRanks(inputs, profile): readonly FusedChronicleCandidate[]`.
- Keeps `buildContextPreview` unchanged and moves its implementation into the new deep database module.

- [x] **Step 1: Write failing query and fusion tests**

Assert deterministic order, independent length bounds, no mechanics/private fields, no scene/entity data past `throughTurnNumber`, query deduplication, RRF tie-breaking by parent id, active-fact eligibility, and authorization predicates occurring before rank input creation.

```ts
expect(plan.map((variant) => variant.kind)).toEqual(["action", "entity_expanded", "scene", "open_thread"]);
expect(fuseChronicleRanks(inputs, { rrfK: 60, weights }).map((value) => value.parentMemoryId))
  .toEqual(["parent-a", "parent-b"]);
```

- [x] **Step 2: Run tests and verify RED**

```bash
pnpm exec vitest run tests/unit/chronicle-query-plan.test.ts tests/unit/chronicle-rank-fusion.test.ts tests/unit/chronicle-transaction-repository.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts
```

- [x] **Step 3: Implement feature-gated chunk candidate loading**

Load semantic, full-text, entity, recency, chronology, importance, kind, and temporal ranks as separate authorized lists. Fuse ranks; never concatenate variant results. Keep `legacy_hybrid` as production regardless of shadow setting. If `chunked_hybrid` is requested but terminal current-protocol coverage is not 100%, call the complete legacy implementation and return `fallbackReason: "chunk_index_not_ready"`.

Historical canonical facts continue through the existing validity-window query; chunk semantic candidates must satisfy parent ordinal cutoff before vector scoring, so post-cutoff scene hints/entities and future chunks never enter the rank lists.

- [x] **Step 4: Run tests and verify GREEN**

Run Step 2. Expected: exact/paraphrase/alias candidates fuse deterministically; all isolation/leakage tests pass; legacy preview shape remains compatible.

- [x] **Step 5: Commit**

```bash
git add packages/domain/src/chronicle-query-plan.ts packages/domain/src/chronicle-rank-fusion.ts packages/database/src/chronicle-context-repository.ts packages/database/src/chronicle-repository.ts tests/unit/chronicle-query-plan.test.ts tests/unit/chronicle-rank-fusion.test.ts tests/unit/chronicle-transaction-repository.test.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts
git commit -m "Add gated Chronicle rank fusion"
```

---

### Task 7: Collapse parents, enforce diversity, and preserve prompt budgets

**Files:**
- Create: `packages/domain/src/chronicle-diversity.ts`
- Create: `tests/unit/chronicle-diversity.test.ts`
- Modify: `packages/database/src/chronicle-context-repository.ts`
- Modify: `tests/integration/chronicle-chunk-retrieval.integration.test.ts`
- Modify: `tests/integration/generation.integration.test.ts`

**Interfaces:**
- Produces `selectDiverseChronicleParents(candidates, policy): ChronicleParentSelection`.
- Returns coherent parent text and safe retrieval diagnostics; chunk text/vector scores remain internal.

- [x] **Step 1: Write failing diversity and budget tests**

Cover strongest-chunk parent collapse, optional adjacent narration chunk, two-parent-per-turn limit, normalized duplicate removal, canonical lineage collapse, semantic similarity penalty, variety across kinds/entities, latest-scene protection, and authoritative rules/world/campaign/current-scene survival under a 512-token request.

- [x] **Step 2: Run tests and verify RED**

```bash
pnpm exec vitest run tests/unit/chronicle-diversity.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts tests/integration/generation.integration.test.ts
```

- [x] **Step 3: Implement selection after fusion, before rendering**

Use normalized NFKC lowercase content hashes, canonical fact IDs from parent metadata, cosine similarity only as a penalty against already-selected authorized candidates, and stable `(fusedRank, ordinal, parentMemoryId)` tie-breaking. Render the existing parent Chronicle memory (or a coherent action+narration excerpt), never a bare unexplained chunk. Apply existing compression/removal priority after parent collapse; optional historical memories shed before fixed scopes.

- [x] **Step 4: Run tests and verify GREEN**

Run Step 2. Expected: no duplicate-heavy prompt, no budget overflow, and no change to the external `scopes` structure.

- [x] **Step 5: Commit**

```bash
git add packages/domain/src/chronicle-diversity.ts packages/database/src/chronicle-context-repository.ts tests/unit/chronicle-diversity.test.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts tests/integration/generation.integration.test.ts
git commit -m "Add diverse Chronicle parent selection"
```

---

### Task 8: Add safe shadow comparison and backend health projection

**Files:**
- Create: `database/migrations/0074_chronicle_retrieval_observability.sql`
- Create: `packages/database/src/chronicle-retrieval-observability-repository.ts`
- Create: `tests/integration/chronicle-retrieval-observability.integration.test.ts`
- Modify: `packages/application/src/memory/types.ts`
- Modify: `packages/contracts/src/memory.ts`
- Modify: `packages/database/src/chronicle-context-repository.ts`
- Modify: `packages/database/src/chronicle-repository.ts`
- Modify: `services/api/src/memory-application-adapter.ts`
- Modify: `tests/integration/chronicle-completion-audit.integration.test.ts`

**Interfaces:**
- Produces `recordRetrievalComparison(database, run): Promise<void>` accepting only hashes, IDs, ranks, reasons, versions, latency, token estimates, fingerprints, fallback codes, selection flags, and cost IDs.
- Expands health states to `chronicle_available`, `semantic_disabled`, `indexing`, `healthy`, `partially_indexed`, `provider_degraded`, `provider_unavailable`, `fallback_active`, `chunk_protocol_outdated`, and `rebuild_required`.

- [x] **Step 1: Write failing telemetry, redaction, and health-contract tests**

Attempt to pass `query`, `action`, `narration`, `prompt`, `response`, and `credential` keys and assert schema rejection. Test 30-day and 5,000-run pruning, campaign cascade, safe route projection, and all health states. Keep the health response a shared discriminated contract so both UIs can render it without deriving status independently.

- [x] **Step 2: Run tests and verify RED**

```bash
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-retrieval-observability.integration.test.ts tests/integration/chronicle-completion-audit.integration.test.ts
```

- [x] **Step 3: Implement shadow mode and safe retention**

Create `chronicle_retrieval_runs` and `chronicle_retrieval_candidates`, both campaign-cascading. When shadow is enabled, calculate lexical, legacy hybrid, and proposed chunked results, but pass only `retrieval_implementation` output to prompt selection. Telemetry write failures are logged with a fixed diagnostic and ignored. Prune expired rows and rows beyond the newest 5,000 campaign runs inside the same best-effort write transaction.

- [x] **Step 4: Run tests and verify GREEN**

Run Step 2. Inspect route snapshots to confirm no raw text, endpoint, or credential fields are returned.

- [x] **Step 5: Commit**

```bash
git add database/migrations/0074_chronicle_retrieval_observability.sql packages/database/src/chronicle-retrieval-observability-repository.ts packages/application/src/memory/types.ts packages/contracts/src/memory.ts packages/database/src/chronicle-context-repository.ts packages/database/src/chronicle-repository.ts services/api/src/memory-application-adapter.ts tests/integration/chronicle-retrieval-observability.integration.test.ts tests/integration/chronicle-completion-audit.integration.test.ts
git commit -m "Add Chronicle retrieval shadow telemetry"
```

---

### Task 9: Calibrate and gate the production retrieval profile

**Files:**
- Create: `packages/domain/src/generated/chronicle-retrieval-profile-v2.ts`
- Create: `tests/unit/chronicle-retrieval-profile.test.ts`
- Modify: `scripts/lib/chronicle-retrieval-evaluator.ts`
- Modify: `scripts/evaluate-chronicle-retrieval.ts`
- Modify: `packages/domain/src/chronicle-rank-fusion.ts`
- Modify: `docs/architecture/0028-chunked-chronicle-retrieval.md`

**Interfaces:**
- Produces generated constant `CHRONICLE_RETRIEVAL_PROFILE_V2` with corpus hash, RRF `k`, signal/variant weights, candidate limits, diversity policy, metrics, and generation timestamp.

- [x] **Step 1: Write failing deterministic calibration tests**

Use the exact search grid `rrfK=[20,40,60]`, semantic variant weights `[0.5,0.75,1]`, lexical/entity weights `[0.75,1,1.25]`, recency/chronology weights `[0.25,0.5,0.75]`, and candidate limits `[32,64,96]`. Reject every profile with nonzero leakage, recall@10 below legacy, NDCG below legacy, duplicate rate above legacy, or p95 above `max(legacyP95 * 1.20, legacyP95 + 25ms)`. Among survivors maximize recall@10, NDCG, relevant/token, then minimize requests, p95, duplicate rate, with serialized profile text as final tie-breaker.

- [x] **Step 2: Run tests and verify RED**

```bash
pnpm exec vitest run tests/unit/chronicle-retrieval-profile.test.ts tests/unit/chronicle-retrieval-evaluator.test.ts
```

- [x] **Step 3: Generate the profile through the production interface**

```bash
pnpm evaluate:chronicle -- --calibrate --baseline tmp/chronicle-evaluation/legacy-baseline.json --write-profile packages/domain/src/generated/chronicle-retrieval-profile-v2.ts
```

The command must fail without writing a profile if no candidate meets every gate. It must never silently substitute default weights.

- [x] **Step 4: Verify the generated profile and opt-in gate**

```bash
pnpm exec vitest run tests/unit/chronicle-retrieval-profile.test.ts tests/unit/chronicle-rank-fusion.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-retrieval-evaluation.integration.test.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts
```

Expected: profile corpus hash matches the fixture; leakage is zero; all quality/latency gates pass. Record the selected metrics in the ADR. Do not change any campaign to `chunked_hybrid` automatically.

- [x] **Step 5: Commit**

```bash
git add packages/domain/src/generated/chronicle-retrieval-profile-v2.ts packages/domain/src/chronicle-rank-fusion.ts scripts/lib/chronicle-retrieval-evaluator.ts scripts/evaluate-chronicle-retrieval.ts tests/unit/chronicle-retrieval-profile.test.ts docs/architecture/0028-chunked-chronicle-retrieval.md
git commit -m "Calibrate Chronicle retrieval profile"
```

---

### Task 10: Add the scoped query-embedding cache

**Files:**
- Create: `database/migrations/0075_chronicle_query_embedding_cache.sql`
- Create: `packages/database/src/chronicle-query-cache-repository.ts`
- Create: `tests/integration/chronicle-query-cache.integration.test.ts`
- Modify: `packages/database/src/chronicle-context-repository.ts`
- Modify: `packages/database/src/provider-repository.ts`
- Modify: `tests/unit/chronicle-transaction-repository.test.ts`

**Interfaces:**
- Produces `getQueryEmbedding(scope, key): Promise<readonly number[] | null>` and `putQueryEmbedding(scope, key, vector): Promise<void>`.
- Key fields are owner/campaign, normalized expanded-query hash, provider profile/model/fingerprint, query-prefix hash, and embedding protocol version.

- [x] **Step 1: Write failing cache tests**

Prove same-campaign retry hit, context-preview hit, cross-campaign miss, provider/model/fingerprint/prefix/protocol miss, seven-day expiry, 256-entry LRU pruning, deletion safety, dimension validation, and identical selected results with cache on/off.

- [x] **Step 2: Run tests and verify RED**

```bash
pnpm exec vitest run tests/unit/chronicle-transaction-repository.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-query-cache.integration.test.ts
```

- [x] **Step 3: Implement cache-as-optimization**

Store only hashes, vector, dimension, timestamps, and hit count in `chronicle_query_embedding_cache`; never store query text or prefixes. Cache read/write failures return a miss and fixed diagnostic. Prune expired rows and least-recently-used rows after insert. Provider update/delete removes matching cache rows; campaign deletion cascades them.

- [x] **Step 4: Run tests and verify GREEN**

Run Step 2 and the evaluator twice. Expected: second run reduces embedding requests while rankings and metrics are byte-for-byte identical except cache/request counters and timing.

- [x] **Step 5: Commit**

```bash
git add database/migrations/0075_chronicle_query_embedding_cache.sql packages/database/src/chronicle-query-cache-repository.ts packages/database/src/chronicle-context-repository.ts packages/database/src/provider-repository.ts tests/integration/chronicle-query-cache.integration.test.ts tests/unit/chronicle-transaction-repository.test.ts
git commit -m "Cache scoped Chronicle query embeddings"
```

---

### Task 11: Prove lifecycle, correction, branch, import, export, and deletion compatibility

**Files:**
- Modify: `packages/database/src/turn-correction-repository.ts`
- Modify: `packages/database/src/campaign-state-repository.ts`
- Modify: `packages/database/src/generation-execution-repository.ts`
- Modify: `packages/database/src/campaign-transfer-character-repository.ts`
- Modify: `tests/integration/turn-narration-corrections.integration.test.ts`
- Modify: `tests/integration/campaign-state-corrections.integration.test.ts`
- Modify: `tests/integration/campaign-authority-repository.integration.test.ts`
- Modify: `tests/integration/import-memory.integration.test.ts`
- Modify: `tests/integration/campaign-archive.integration.test.ts`
- Modify: `tests/integration/chronicle-turn-immutability.integration.test.ts`

**Interfaces:**
- Lifecycle callers enqueue fresh branch/correction/import chunk work through `MemoryGenerationTransactionPort.enqueueChunkIndex`; they never copy source chunks, vectors, cache, jobs, or telemetry.

- [x] **Step 1: Add failing lifecycle tests**

Assert: new accepted turns queue derived work without changing acceptance; correction makes old parent hash chunks immediately ineligible; state correction supersedes old chunks; branch has branch-owned parent/chunk IDs and no copied operational rows/cost; rewind/replacement removes only derived post-boundary rows under existing authority; historical preview enforces cutoff; imports queue only after publication; exports contain no new table data; campaign deletion cascades only its derived rows; provider disable/delete falls back lexically; and every non-authoritative operation preserves the turn snapshot and `xmin`.

- [x] **Step 2: Run lifecycle tests and verify RED**

```bash
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/turn-narration-corrections.integration.test.ts tests/integration/campaign-state-corrections.integration.test.ts tests/integration/campaign-authority-repository.integration.test.ts tests/integration/import-memory.integration.test.ts tests/integration/campaign-archive.integration.test.ts tests/integration/chronicle-turn-immutability.integration.test.ts
```

- [x] **Step 3: Wire lifecycle enqueue/invalidation**

Keep existing base Chronicle rebuilds strict. Enqueue chunk work only after successful parent projection/publication. Branch/import paths rebuild branch/destination parents and enqueue destination-owned chunks. Corrections rely on parent cascade/content-hash eligibility immediately, then enqueue replacement work. Export allowlists remain authoritative-only. Provider deletion clears chunk vectors/cache and disables semantic retrieval without deleting parent text or legacy lexical indexes.

- [x] **Step 4: Run lifecycle tests and verify GREEN**

Run Step 2. Expected: all lifecycle cases pass, portable archives contain no vectors/cache/telemetry/chunk jobs, and `xmin` remains identical for operations that do not use the existing authoritative rewind/replacement workflow.

- [x] **Step 5: Commit**

```bash
git add packages/database/src/turn-correction-repository.ts packages/database/src/campaign-state-repository.ts packages/database/src/generation-execution-repository.ts packages/database/src/campaign-transfer-character-repository.ts tests/integration/turn-narration-corrections.integration.test.ts tests/integration/campaign-state-corrections.integration.test.ts tests/integration/campaign-authority-repository.integration.test.ts tests/integration/import-memory.integration.test.ts tests/integration/campaign-archive.integration.test.ts tests/integration/chronicle-turn-immutability.integration.test.ts
git commit -m "Harden Chronicle chunk lifecycle behavior"
```

---

### Task 12: Document rollout, rollback, and operations

**Files:**
- Modify: `docs/concepts/chronicle-memory.md`
- Modify: `docs/nexus-guide/chronicle/embeddings.md`
- Modify: `docs/nexus-guide/chronicle/retrieval-modes.md`
- Modify: `docs/nexus-guide/chronicle/context-preview.md`
- Modify: `docs/operations/recovery/chronicle-indexing.md`
- Modify: `docs/installation/provider-configuration.md`
- Modify: `docs/runbooks/deployment.md`
- Modify: `docs/architecture/0028-chunked-chronicle-retrieval.md`

**Interfaces:**
- Documents the user-visible setting, health states, capability overrides, shadow/production selection, evaluation command, rebuild, opt-in, and rollback.

- [x] **Step 1: Add failing documentation contract tests**

Extend the repository documentation/inventory test to require `Semantic Retrieval`, `index_memory_chunks_v2`, the 100% terminal-coverage gate, seven-day/256 cache policy, 30-day/5,000 telemetry policy, and the exact rollback SQL. Assert that no guide tells an operator to edit accepted turns or delete legacy embeddings.

- [x] **Step 2: Run documentation and focused checks and verify RED**

```bash
pnpm exec vitest run tests/unit/memory-inventory.test.ts
```

- [x] **Step 3: Write operations and staged rollout guidance**

Document: deploy compatible code before enabling shadow; migrations create only derived schema/jobs; leave all campaigns on legacy production; wait for terminal coverage; run corpus calibration; enable shadow on selected campaigns; compare diagnostics; opt selected campaigns into `chunked_hybrid`; rollback by config only; retain legacy vectors until separate approval. State explicitly that reranking is absent.

- [x] **Step 4: Run documentation and focused backend verification**

```bash
pnpm exec vitest run tests/unit/memory-inventory.test.ts
git diff --check
```

Expected: the documentation contract passes and `git diff --check` is clean. Complete repository verification is intentionally deferred until after both UIs are updated in Task 13.

- [x] **Step 5: Commit**

```bash
git add docs/concepts/chronicle-memory.md docs/nexus-guide/chronicle/embeddings.md docs/nexus-guide/chronicle/retrieval-modes.md docs/nexus-guide/chronicle/context-preview.md docs/operations/recovery/chronicle-indexing.md docs/installation/provider-configuration.md docs/runbooks/deployment.md docs/architecture/0028-chunked-chronicle-retrieval.md tests/unit/memory-inventory.test.ts
git commit -m "Document Chronicle chunked retrieval rollout"
```

---

### Task 13: Update both active user interfaces and run complete verification

**Files:**
- Modify: `apps/web/public/index.html`
- Modify: `apps/web/public/nexus.js`
- Modify: `apps/web/public/nexus.css`
- Modify: `apps/web/src/story.js`
- Modify: `apps/web-next/src/campaign-editor-page.ts`
- Modify: `apps/web-next/src/styles.css`
- Modify: `tests/unit/management-ui.test.ts`
- Modify: `tests/unit/web-next-campaign-editor.test.ts`
- Modify: `tests/unit/web-build-contract.test.ts`

**Interfaces:**
- The packaged legacy UI remains available at `/nexus/`; the replacement UI remains available at `/app/`. Do not modify the reference-only root `index.html`.
- Both UIs read and write the same `/api/v1/campaigns/:campaignId/memory/embedding-config` contract and consume the same `/memory/metrics`, `/memory/context-preview`, `/memory/reindex`, and `/memory/embeddings/reindex` routes.
- Both UIs expose `retrievalImplementation` (`legacy_hybrid` or `chunked_hybrid`) and `retrievalShadowEnabled`, and render the shared health states `chronicle_available`, `semantic_disabled`, `indexing`, `healthy`, `partially_indexed`, `provider_degraded`, `provider_unavailable`, `fallback_active`, `chunk_protocol_outdated`, and `rebuild_required`.

- [x] **Step 1: Write failing parity, behavior, and build-contract tests for both UIs**

Extend `management-ui.test.ts` and `web-next-campaign-editor.test.ts` to require the same visible term `Semantic Retrieval`, the same implementation and shadow controls, the same health-state meanings, coverage/job progress, production implementation, shadow status, sanitized fallback reason, and the message “Chronicle local memory remains available when semantic retrieval is off.” Assert that save requests send the shared contract fields and that context preview and both reindex operations continue to use the existing shared routes. Extend `web-build-contract.test.ts` to build both active UIs and assert their emitted assets contain the new terminology and controls. Add a source assertion that the root `index.html` is not part of the implementation file set.

- [x] **Step 2: Run focused UI tests and verify RED**

```bash
pnpm exec vitest run tests/unit/management-ui.test.ts tests/unit/web-next-campaign-editor.test.ts tests/unit/web-build-contract.test.ts
```

Expected: both UI suites fail on the missing retrieval controls, complete health projection, and updated terminology; the build-contract test identifies either built interface that is incomplete.

- [x] **Step 3: Implement the packaged legacy `/nexus/` UI**

Update the Chronicle “Memory and context” surface in `apps/web/public/index.html` and its behavior in `nexus.js`. Replace ambiguous visible “Semantic memory” wording with “Semantic Retrieval”; add accessible labeled controls for production implementation and shadow comparison; preserve provider/model/prefix/batch, context preview, rebuild, and progress features; and render every shared health state without inventing a second status model. Always distinguish optional semantic retrieval from Chronicle local memory. Update `nexus.css` with token-aligned state styles and an `aria-live` status region, and update the story cost label in `apps/web/src/story.js` to “Semantic retrieval.”

- [x] **Step 4: Implement the replacement `/app/` UI**

Update the Chronicle section in `campaign-editor-page.ts` with the same settings, meanings, health labels, fallback details, and Chronicle-availability message as `/nexus/`. Keep the DOM implementation idiomatic to the replacement UI, but do not change the shared API semantics or create UI-only defaults. Add corresponding accessible state styles in `apps/web-next/src/styles.css`.

- [x] **Step 5: Run focused UI tests and verify GREEN**

Run Step 2. Manually compare the rendered field labels, option values, health labels, disabled states, fallback copy, and button behaviors in `/nexus/` and `/app/`; layout may differ, but semantics and API payloads must match. Confirm the root `index.html` has no diff.

- [x] **Step 6: Run complete verification after all UI work**

```bash
pnpm check
pnpm build
pnpm test:unit
pnpm test:integration
pnpm evaluate:chronicle -- --implementation legacy_hybrid --output tmp/chronicle-evaluation/final-legacy.json
pnpm evaluate:chronicle -- --implementation chunked_hybrid --output tmp/chronicle-evaluation/final-chunked.json
git diff --check
```

Expected: checks, both UI builds, and tests pass; integration output proves PostgreSQL tests executed rather than skipped; both evaluation reports have zero leakage; chunked metrics meet the generated profile gates; and `git diff --check` is clean. Review the full diff for unrelated changes, confirm no accepted-turn write SQL was added outside existing authoritative workflows, and confirm the root `index.html` is unchanged.

- [x] **Step 7: Commit**

```bash
git add apps/web/public/index.html apps/web/public/nexus.js apps/web/public/nexus.css apps/web/src/story.js apps/web-next/src/campaign-editor-page.ts apps/web-next/src/styles.css tests/unit/management-ui.test.ts tests/unit/web-next-campaign-editor.test.ts tests/unit/web-build-contract.test.ts
git commit -m "Update Chronicle retrieval interfaces"
```

## Completion Gate

Do not call the enhancement complete unless all of the following are evidenced in the implementation report:

- Turn count, IDs, full row JSON, timestamps, costs/provenance, and `xmin` remain unchanged across migration/index/retrieval/provider/correction/branch-index operations.
- Chunk deletion followed by rebuild is lossless; identical parent content/protocol yields identical chunk order/hashes.
- Lease loss and work-version changes cannot commit stale chunks or cursor progress.
- Cross-owner, cross-campaign, future-turn, and superseded-fact leakage are all zero.
- Semantic/provider/cache/telemetry failures return a normal lexical Chronicle prompt and do not mutate campaign state.
- Prompt budgets preserve authoritative fixed scopes before optional history.
- Existing campaigns remain playable during backfill; no campaign is automatically switched from legacy production.
- Branches/imports build destination-owned derived rows; portable exports exclude chunks, vectors, caches, telemetry, and jobs.
- The generated retrieval profile beats or matches the legacy gates and is traceable to the checked-in corpus hash.
- Rollback to `legacy_hybrid` is demonstrated without touching turns or deleting legacy embeddings.
- The active legacy `/nexus/` and replacement `/app/` interfaces expose the same retrieval settings, health meanings, fallback/coverage information, and Chronicle-local-memory guarantee through the shared API contracts.
- UI changes are the final implementation task, both UI builds are verified after those changes, and the reference-only root `index.html` remains unchanged.
