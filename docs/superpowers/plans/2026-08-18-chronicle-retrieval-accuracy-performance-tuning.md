# Chronicle Retrieval Accuracy and Performance Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Chronicle turn accuracy under tight context budgets and reduce ready-path retrieval and rebuild latency through small, measurable changes to evaluation, selected-chunk rendering, ranking calibration, query planning, SQL execution, and embedding batching.

**Architecture:** Preserve `MemoryGenerationTransactionPort.buildContextPreview(database, scope)` as the sole generation-facing retrieval interface. Keep accepted turns and Chronicle parent memories authoritative, keep chunks and embeddings rebuildable, retain exact campaign-scoped pgvector scans, and make each optimization behind the existing interface independently measurable and reversible.

**Tech Stack:** TypeScript 7, Node.js 22+, PostgreSQL 18, pgvector, Vitest, the existing deterministic Chronicle evaluator, and the existing OpenAI-compatible embedding provider port.

**Spec:** `docs/architecture/0028-chunked-chronicle-retrieval.md`

## Global Constraints

- Existing accepted `turns` rows remain immutable. Do not update or delete accepted turns, add retrieval state to them, or rewrite accepted narration.
- `chronicle_memories` remains the derived parent ledger used to rebuild `chronicle_memory_chunks`; chunks, query vectors, generated profiles, and evaluation output remain derived.
- Preserve owner, campaign, world-version, and `throughTurnNumber` authorization predicates before every rank or selection operation.
- Keep `buildContextPreview` as the external seam. Do not expose rank loaders, query planners, or diversity helpers through `MemoryGenerationTransactionPort`.
- Keep exact campaign-scoped vector scans. Do not add ANN indexes, a reranker, LLM query rewriting, or arbitrary per-campaign chunk settings in this plan.
- Preserve the complete fallback behavior: semantic failure must retain the existing lexical path, and optional optimization failures must not mutate campaign state or block generation.
- Preserve the current prompt priority order unless Task 1 proves a specific tight-budget failure. This plan improves the density of selected optional history rather than redesigning prompt eviction.
- Use strict TDD for every behavior: run the focused test and observe the intended RED failure, implement the minimum change, rerun GREEN, then refactor.
- PostgreSQL tests count as runtime proof only when the output shows they executed against PostgreSQL. A skipped run caused by an absent `TEST_DATABASE_URL` is not a pass.
- Do not hand-select production ranking weights. Only the deterministic evaluator may generate `packages/domain/src/generated/chronicle-retrieval-profile-v2.ts`.
- Keep every task independently reviewable and commit only the files listed for that task. Preserve unrelated dirty files.

## Resolved Small-Change Decisions

1. Add a versioned evaluation corpus instead of overwriting the current corpus before the new behavior is ready. Task 3 promotes the new corpus after Tasks 1 and 2 establish and improve its baseline.
2. Render the strongest matching chunk rather than an entire long parent, except for canonical facts and open threads, which remain whole atomic facts.
3. Keep action plus adjacent narration behavior. When narration is the strongest chunk, include the action when that sibling chunk is available.
4. Add candidate limit `16` and independently calibrate `entity_expanded`, `scene`, and `open_thread` weights with a bounded coordinate grid rather than a full combinatorial search.
5. Suppress a query variant only when it adds neither a new substantive normalized term nor a new entity ID. This change lands only after a before/after evaluator ablation.
6. Batch rank SQL by signal family on the same PostgreSQL client. `Promise.all` is not used as a substitute because one transaction client cannot execute those statements concurrently.
7. Load up to eight changed parents per indexing page and batch embeddable chunks across that page, while preserving sequential per-parent fenced commits.
8. Split per-parent vector evidence from provider cost results so a provider response spanning several parents is recorded exactly once without weakening vector validation.

## File and Module Map

- `tests/fixtures/chronicle-retrieval-evaluation.v2.json`: current production calibration corpus; retained until Task 3.
- `tests/fixtures/chronicle-retrieval-evaluation.v3.json`: new tight-budget and long-parent corpus introduced by Task 1 and promoted by Task 3.
- `scripts/lib/chronicle-retrieval-evaluator.ts`: corpus types, metrics, deterministic calibration grid, gates, and generated profile rendering.
- `scripts/evaluate-chronicle-retrieval.ts`: production-interface corpus seeding, alternate-corpus baseline runs, calibration, and profile generation.
- `packages/domain/src/chronicle-diversity.ts`: strongest-parent collapse and selected-content rendering.
- `packages/domain/src/chronicle-query-plan.ts`: bounded action, entity, scene, and open-thread variants.
- `packages/domain/src/generated/chronicle-retrieval-profile-v2.ts`: evaluator-generated production profile.
- `packages/database/src/chronicle-context-repository.ts`: authorized rank SQL, rank fusion orchestration, selected-content projection, and context assembly.
- `packages/application/src/memory/types.ts`: chunk-parent page and fenced parent-commit data contracts.
- `packages/database/src/chronicle-chunk-repository.ts`: parent pagination and atomic chunk, cost, progress, and lease commit.
- `services/runtime/src/chronicle-chunk-worker-execution.ts`: chunk preparation, provider batching, vector distribution, and sequential commit execution.
- `tests/unit/chronicle-diversity.test.ts`: selected excerpt behavior.
- `tests/unit/chronicle-query-plan.test.ts`: query-variant safety and redundancy behavior.
- `tests/unit/chronicle-retrieval-profile.test.ts`: deterministic grid and generated-profile gates.
- `tests/unit/chronicle-chunk-worker-execution.test.ts`: page batching, provider calls, vector distribution, and commit order.
- `tests/integration/chronicle-chunk-retrieval.integration.test.ts`: PostgreSQL retrieval scope, rank behavior, and rank-statement count.
- `tests/integration/chronicle-chunk-repository.integration.test.ts`: fenced parent commits and transactional cost recording.
- `tests/integration/chronicle-retrieval-evaluation.integration.test.ts`: production-seam evaluation and corpus invariants.
- `docs/architecture/0028-chunked-chronicle-retrieval.md`: final measured behavior, rollback, and operating guidance.

---

### Task 1: Add tight-budget and long-parent evaluation coverage

**Improvement:** Make accuracy losses caused by whole-parent rendering visible at 1,024, 2,048, and 4,096 token budgets before changing production behavior.

**Files:**
- Create: `tests/fixtures/chronicle-retrieval-evaluation.v3.json`
- Modify: `scripts/lib/chronicle-retrieval-evaluator.ts`
- Modify: `scripts/evaluate-chronicle-retrieval.ts`
- Modify: `tests/unit/chronicle-retrieval-evaluator.test.ts`
- Modify: `tests/integration/chronicle-retrieval-evaluation.integration.test.ts`
- Create: `tmp/chronicle-evaluation/v3-before/legacy-baseline.json` (generated, do not commit)
- Create: `tmp/chronicle-evaluation/v3-before/chunked-current.json` (generated, do not commit)

**Interfaces:**
- Extends `ChronicleRetrievalCase` with optional `longParent` fixture metadata only; this is evaluator-only and does not enter application contracts.
- Adds CLI option `--corpus tests/fixtures/chronicle-retrieval-evaluation.v3.json` to run a non-production corpus without requiring its hash to match the checked-in profile.
- Uses `chunkChronicleMemory` to seed real deterministic chunks instead of treating every parent as one synthetic chunk.

- [ ] **Step 1: Write failing evaluator tests for alternate corpus loading and real chunk seeding**

Add this evaluator-only type:

```ts
export type ChronicleLongParentFixture = Readonly<{
  paragraphCount: number;
  relevantParagraphIndex: number;
  relevantParagraph: string;
}>;

export type ChronicleRetrievalCase = Readonly<{
  id: string;
  scope: MemoryGenerationContextPreviewScope;
  expectedLabels: readonly string[];
  labelByMemoryId: Readonly<Record<string, string>>;
  longParent?: ChronicleLongParentFixture;
  forbiddenLabels?: Readonly<{
    crossCampaign?: readonly string[];
    futureTurn?: readonly string[];
    supersededFact?: readonly string[];
  }>;
  excludedLabels?: Readonly<Record<string, readonly string[]>>;
  distractorCount?: number;
}>;
```

In `tests/unit/chronicle-retrieval-evaluator.test.ts`, assert that three cases with the same relevant paragraph use budgets `1_024`, `2_048`, and `4_096`, and that invalid `paragraphCount` or `relevantParagraphIndex` values are rejected before database work.

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
pnpm exec vitest run tests/unit/chronicle-retrieval-evaluator.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-retrieval-evaluation.integration.test.ts
```

Expected: FAIL because the v3 fixture metadata, alternate-corpus argument, and production chunk seeding do not exist.

- [ ] **Step 3: Create the v3 corpus with three discriminating long-parent cases**

Copy the existing v2 cases, set the corpus version to `v3`, and add:

```json
{
  "id": "long-parent-budget-1024",
  "scope": {
    "ownerUserId": "owner-fixture",
    "campaignId": "campaign-fixture",
    "worldVersionId": "world-fixture",
    "request": {
      "budgetTokens": 1024,
      "compression": "auto",
      "query": "moon sigil western gate",
      "recentTurns": 0
    }
  },
  "expectedLabels": ["long-parent-budget-1024-a"],
  "labelByMemoryId": {
    "m-long-parent-budget-1024-a": "long-parent-budget-1024-a"
  },
  "longParent": {
    "paragraphCount": 48,
    "relevantParagraphIndex": 24,
    "relevantParagraph": "The moon sigil opens the western gate at midnight."
  },
  "distractorCount": 24
}
```

Add equivalent `long-parent-budget-2048` and `long-parent-budget-4096` cases with the same long-parent shape and their respective budgets and labels.

- [ ] **Step 4: Seed long parents and their chunks through production chunking**

Build long content deterministically:

```ts
function longParentContent(fixture: ChronicleLongParentFixture): string {
  if (!Number.isSafeInteger(fixture.paragraphCount) || fixture.paragraphCount < 2) {
    throw new Error("Chronicle evaluation long parent requires at least two paragraphs.");
  }
  if (!Number.isSafeInteger(fixture.relevantParagraphIndex)
    || fixture.relevantParagraphIndex < 0
    || fixture.relevantParagraphIndex >= fixture.paragraphCount) {
    throw new Error("Chronicle evaluation relevant paragraph index is out of range.");
  }
  return Array.from({ length: fixture.paragraphCount }, (_, index) => (
    index === fixture.relevantParagraphIndex
      ? fixture.relevantParagraph
      : `Sanitized continuity filler paragraph ${index + 1} describing quiet roads and empty courtyards.`
  )).join("\n\n");
}
```

Replace the one-row-per-parent chunk seed with `chunkChronicleMemory({ id, memoryKind, content })`. Insert every returned chunk with its actual `chunkIndex`, `kind`, `content`, offsets, token estimate, content hash, and fixture vector. Keep the existing owner/campaign/world-version values and embedding compatibility fields unchanged.

- [ ] **Step 5: Add safe alternate-corpus CLI behavior**

Resolve the explicit path beneath the repository root and skip the checked-in profile hash assertion only for an explicit diagnostic corpus:

```ts
const corpusArgument = argument("--corpus");
const corpusPath = resolve(root, corpusArgument ?? "tests/fixtures/chronicle-retrieval-evaluation.v2.json");
const corpus = JSON.parse(await readFile(corpusPath, "utf8")) as ChronicleRetrievalCorpus;
const explicitDiagnosticCorpus = corpusArgument !== undefined;
```

Keep calibration hash validation strict. Only this final check is conditional:

```ts
if (implementation === "chunked_hybrid" && !explicitDiagnosticCorpus) {
  assertProfileMetricsAreCurrent(evaluated);
}
```

- [ ] **Step 6: Rerun focused tests and verify GREEN**

Run the commands from Step 2. Expected: all unit cases pass; PostgreSQL cases execute and prove v3 parents create multiple production-protocol chunks without owner, campaign, world-version, future-turn, or superseded-fact leakage.

- [ ] **Step 7: Capture the before-change baseline**

```bash
pnpm evaluate:chronicle -- --corpus tests/fixtures/chronicle-retrieval-evaluation.v3.json --implementation legacy_hybrid --output tmp/chronicle-evaluation/v3-before/legacy-baseline.json
pnpm evaluate:chronicle -- --corpus tests/fixtures/chronicle-retrieval-evaluation.v3.json --implementation chunked_hybrid --output tmp/chronicle-evaluation/v3-before/chunked-current.json
```

Record the three long-parent ranks, prompt tokens, relevant-memories-per-prompt-token, p50, p95, and leakage counts in the commit message or task log. Do not weaken an expected label to make the current implementation look successful.

- [ ] **Step 8: Commit**

```bash
git add tests/fixtures/chronicle-retrieval-evaluation.v3.json scripts/lib/chronicle-retrieval-evaluator.ts scripts/evaluate-chronicle-retrieval.ts tests/unit/chronicle-retrieval-evaluator.test.ts tests/integration/chronicle-retrieval-evaluation.integration.test.ts
git commit -m "Measure Chronicle tight-budget retrieval"
```

---

### Task 2: Render matched chunk excerpts instead of whole long parents

**Improvement:** Increase prompt information density so the most relevant history survives tight budgets without changing rank order or authoritative memory.

**Files:**
- Modify: `packages/domain/src/chronicle-diversity.ts`
- Modify: `tests/unit/chronicle-diversity.test.ts`
- Modify: `scripts/evaluate-chronicle-retrieval.ts`
- Modify: `tests/integration/chronicle-retrieval-evaluation.integration.test.ts`
- Create: `tmp/chronicle-evaluation/v3-after-excerpts/chunked.json` (generated, do not commit)

**Interfaces:**
- Keeps `selectDiverseChronicleParents(candidates, policy): ChronicleParentSelection` unchanged.
- Adds only a private `selectedContent` helper inside `chronicle-diversity.ts`.
- Does not change parent selection, fused ranks, diversity diagnostics, memory IDs, or context scope.

- [ ] **Step 1: Write failing unit tests for every chunk kind**

Add cases proving these exact rules:

```ts
expect(selected("turn_action")).toBe(
  "Player action: Open the western gate.\nNarration: Moonlight fills the court."
);
expect(selected("turn_narration")).toBe(
  "Player action: Open the western gate.\nNarration: Moonlight fills the court."
);
expect(selected("campaign_summary")).toBe("The moon sigil opens the western gate at midnight.");
expect(selected("legacy_summary")).toBe("The moon sigil opens the western gate at midnight.");
expect(selected("canonical_fact")).toBe("The complete canonical fact remains atomic.");
expect(selected("open_thread")).toBe("The complete open thread remains atomic.");
```

Also prove narration without an action sibling renders `Narration: <matched chunk>`, and action without an adjacent narration renders `Player action: <matched chunk>`.

- [ ] **Step 2: Run the diversity test and verify RED**

```bash
pnpm exec vitest run tests/unit/chronicle-diversity.test.ts
```

Expected: summary and narration-strongest cases FAIL because the current implementation returns `parentContent` unless an action chunk has adjacent narration.

- [ ] **Step 3: Implement private chunk-aware rendering**

Use the already-ranked sibling chunks from `chunksByParent`:

```ts
function selectedContent(
  candidate: ChronicleParentCandidate,
  siblings: readonly ChronicleParentCandidate[],
  includeAdjacentNarration: boolean,
): string {
  if (candidate.chunkKind === "canonical_fact" || candidate.chunkKind === "open_thread") {
    return candidate.parentContent;
  }
  if (candidate.chunkKind === "campaign_summary" || candidate.chunkKind === "legacy_summary") {
    return candidate.chunkContent;
  }
  const action = candidate.chunkKind === "turn_action"
    ? candidate
    : siblings.find((chunk) => chunk.chunkKind === "turn_action");
  const narration = candidate.chunkKind === "turn_narration"
    ? candidate
    : includeAdjacentNarration
      ? siblings.find((chunk) => chunk.chunkKind === "turn_narration"
        && chunk.chunkOrdinal === candidate.chunkOrdinal + 1)
      : undefined;
  if (action && narration) {
    return `Player action: ${action.chunkContent}\nNarration: ${narration.chunkContent}`;
  }
  if (candidate.chunkKind === "turn_action") return `Player action: ${candidate.chunkContent}`;
  return `Narration: ${candidate.chunkContent}`;
}
```

Call this helper only after the existing parent selection loop. Continue deduplicating and applying lineage rules by `parentContent`, not by excerpts.

- [ ] **Step 4: Rerun unit tests and verify GREEN**

```bash
pnpm exec vitest run tests/unit/chronicle-diversity.test.ts tests/unit/chronicle-transaction-repository.test.ts
```

Expected: excerpt cases pass, deterministic parent order and diagnostics remain unchanged, and the context repository tests show `estimatedTokens` is recalculated from rendered content.

- [ ] **Step 5: Promote the tight-budget cases to evaluation invariants**

In `assertCorpusResultInvariants`, require all three `long-parent-budget-*` cases to retrieve their expected label and require their `promptTokens` not to exceed the requested budget. Do not assert wall-clock latency as an exact value.

- [ ] **Step 6: Run PostgreSQL evaluation and compare with Task 1**

```bash
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-retrieval-evaluation.integration.test.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts
pnpm evaluate:chronicle -- --corpus tests/fixtures/chronicle-retrieval-evaluation.v3.json --implementation chunked_hybrid --output tmp/chronicle-evaluation/v3-after-excerpts/chunked.json
```

Acceptance criteria:

- all three long-parent labels are present;
- leakage remains zero in all categories;
- prompt tokens for each long-parent case decrease from Task 1;
- relevant memories per prompt token improves;
- recall@10 and NDCG do not regress from the Task 1 chunked result.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/chronicle-diversity.ts tests/unit/chronicle-diversity.test.ts scripts/evaluate-chronicle-retrieval.ts tests/integration/chronicle-retrieval-evaluation.integration.test.ts
git commit -m "Render focused Chronicle excerpts"
```

---

### Task 3: Recalibrate independent query-variant weights and candidate limit 16

**Improvement:** Let the evaluator select cheaper and more accurate ranking parameters instead of forcing entity, scene, and open-thread variants to share one weight.

**Files:**
- Modify: `scripts/lib/chronicle-retrieval-evaluator.ts`
- Modify: `scripts/evaluate-chronicle-retrieval.ts`
- Modify: `tests/unit/chronicle-retrieval-profile.test.ts`
- Modify: `packages/domain/src/generated/chronicle-retrieval-profile-v2.ts` (generated only)
- Modify: `docs/architecture/0028-chunked-chronicle-retrieval.md`
- Create: `tmp/chronicle-evaluation/v3-calibration/legacy-baseline.json` (generated, do not commit)
- Create: `tmp/chronicle-evaluation/v3-calibration/chunked-selected.json` (generated, do not commit)

**Interfaces:**
- Replaces evaluator-only `semanticVariantWeight` with `entityExpandedVariantWeight`, `sceneVariantWeight`, and `openThreadVariantWeight`.
- Keeps `ChronicleProductionRankFusionProfile` unchanged; only generated values differ.
- Changes the evaluator default corpus from v2 to v3 after successful calibration.

- [ ] **Step 1: Write failing deterministic-grid tests**

Change the profile parameter type:

```ts
export type ChronicleRetrievalProfileParameters = Readonly<{
  rrfK: number;
  entityExpandedVariantWeight: number;
  sceneVariantWeight: number;
  openThreadVariantWeight: number;
  lexicalEntityWeight: number;
  recencyChronologyWeight: number;
  candidateLimit: number;
}>;
```

Assert the candidate limits are `[16, 32, 64]`, all three variant weight fields can vary independently, every serialized profile is unique, and the grid length is exactly `567`. Update the corpus discrimination test so ordinary ranking cases still require at least 4,096 tokens while the three long-parent cases require the exact budget set `[1_024, 2_048, 4_096]` and at least 16 distractors each.

- [ ] **Step 2: Run the profile tests and verify RED**

```bash
pnpm exec vitest run tests/unit/chronicle-retrieval-profile.test.ts
```

Expected: FAIL because the current grid has 243 candidates, excludes limit 16, and uses one shared semantic-variant weight.

- [ ] **Step 3: Implement the bounded coordinate grid**

Use this exact query-variant grid to avoid a 2,187-profile Cartesian explosion:

```ts
const QUERY_VARIANT_WEIGHT_GRID = Object.freeze([
  Object.freeze({ entityExpanded: 1, scene: 1, openThread: 1 }),
  Object.freeze({ entityExpanded: 0.5, scene: 1, openThread: 1 }),
  Object.freeze({ entityExpanded: 0.75, scene: 1, openThread: 1 }),
  Object.freeze({ entityExpanded: 1, scene: 0.5, openThread: 1 }),
  Object.freeze({ entityExpanded: 1, scene: 0.75, openThread: 1 }),
  Object.freeze({ entityExpanded: 1, scene: 1, openThread: 0.5 }),
  Object.freeze({ entityExpanded: 1, scene: 1, openThread: 0.75 })
]);
const CANDIDATE_LIMIT_GRID = [16, 32, 64] as const;
```

Map the selected fields directly:

```ts
variants: Object.freeze({
  action: 1,
  entity_expanded: parameters.entityExpandedVariantWeight,
  scene: parameters.sceneVariantWeight,
  open_thread: parameters.openThreadVariantWeight
})
```

Keep the existing quality-first deterministic tie-break order. Latency and cache warmth must not choose a quality-tied production profile.

- [ ] **Step 4: Rerun unit tests and verify GREEN**

```bash
pnpm exec vitest run tests/unit/chronicle-retrieval-profile.test.ts tests/unit/chronicle-rank-fusion.test.ts
```

- [ ] **Step 5: Promote v3 and generate the profile**

Change the evaluator default path and profile tests to `tests/fixtures/chronicle-retrieval-evaluation.v3.json`, then run:

```bash
pnpm evaluate:chronicle -- --implementation legacy_hybrid --output tmp/chronicle-evaluation/v3-calibration/legacy-baseline.json
pnpm evaluate:chronicle -- --calibrate --baseline tmp/chronicle-evaluation/v3-calibration/legacy-baseline.json --write-profile packages/domain/src/generated/chronicle-retrieval-profile-v2.ts
pnpm evaluate:chronicle -- --implementation chunked_hybrid --output tmp/chronicle-evaluation/v3-calibration/chunked-selected.json
```

Acceptance criteria: zero leakage, no recall@10 or NDCG regression against the v3 legacy baseline, no duplicate-rate regression, p95 within the existing calibration gate, and all tight-budget invariants pass. The generated profile may select any candidate that satisfies the deterministic gates.

- [ ] **Step 6: Record generated evidence in the ADR**

Record corpus version and hash, selected candidate limit, all three variant weights, recall@5/10/20, MRR, NDCG, duplicate rate, relevant memories per prompt token, p50/p95, embedding requests, and leakage counts. State that the evaluator selected the values.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/chronicle-retrieval-evaluator.ts scripts/evaluate-chronicle-retrieval.ts tests/unit/chronicle-retrieval-profile.test.ts packages/domain/src/generated/chronicle-retrieval-profile-v2.ts docs/architecture/0028-chunked-chronicle-retrieval.md
git commit -m "Recalibrate Chronicle query weights"
```

---

### Task 4: Suppress redundant query variants after an evaluator ablation

**Improvement:** Avoid embeddings, cache lookups, and rank SQL for scene or open-thread expansions that add no distinct retrieval information.

**Files:**
- Modify: `packages/domain/src/chronicle-query-plan.ts`
- Modify: `tests/unit/chronicle-query-plan.test.ts`
- Modify: `scripts/lib/chronicle-retrieval-evaluator.ts`
- Modify: `tests/unit/chronicle-retrieval-evaluator.test.ts`
- Modify: `packages/domain/src/generated/chronicle-retrieval-profile-v2.ts` (generated only)
- Modify: `docs/architecture/0028-chunked-chronicle-retrieval.md`
- Create: `tmp/chronicle-evaluation/variant-ablation/before.json` (generated, do not commit)
- Create: `tmp/chronicle-evaluation/variant-ablation/after.json` (generated, do not commit)

**Interfaces:**
- Keeps `planChronicleQueries(input): readonly ChronicleQueryVariant[]` unchanged.
- Adds only private term-normalization and distinct-information helpers.
- Adds evaluator case-result field `queryVariants`, calculated as safe retrieval `queryCacheHits + queryCacheMisses`; it does not alter calibration metrics or application contracts.
- Keeps action first and preserves the existing query length and cutoff rules.

- [ ] **Step 1: Capture the pre-change ablation result**

```bash
pnpm evaluate:chronicle -- --implementation chunked_hybrid --output tmp/chronicle-evaluation/variant-ablation/before.json
```

Retain this uncommitted output for the after comparison.

- [ ] **Step 2: Write failing query-plan tests**

Add tests proving:

- an open-thread variant repeating only terms already supplied by action and scene is omitted;
- case, punctuation, Unicode normalization, and common connective words do not create false novelty;
- an `entity_expanded` variant with a new entity ID remains even when its visible terms overlap;
- vague action `Ask him about it again` retains scene and open-thread variants when they add substantive names or events;
- future-only hints remain excluded before redundancy checks.

In `tests/unit/chronicle-retrieval-evaluator.test.ts`, add a safe-metadata case proving two cache hits plus one cache miss becomes `queryVariants: 3`, while malformed or absent counts become zero.

- [ ] **Step 3: Run the query-plan tests and verify RED**

```bash
pnpm exec vitest run tests/unit/chronicle-query-plan.test.ts tests/unit/chronicle-retrieval-evaluator.test.ts
```

Expected: FAIL because the current planner deduplicates only exact normalized full-query strings.

- [ ] **Step 4: Implement conservative distinct-information pruning**

Use NFKC lowercase Unicode terms and a small fixed connective set:

```ts
const QUERY_CONNECTIVES = new Set([
  "and", "again", "about", "from", "into", "that", "the", "their", "this", "with"
]);

function substantiveTerms(value: string): ReadonlySet<string> {
  return new Set(value.normalize("NFKC").toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((term) => term.length >= 3 && !QUERY_CONNECTIVES.has(term)) ?? []);
}
```

Walk variants in their existing deterministic order. Retain action unconditionally. Retain each later variant only if its query contributes a term not present in retained variants or its `entityIds` contributes a new ID. Add retained terms and IDs to the covered sets.

- [ ] **Step 5: Rerun unit tests and verify GREEN**

```bash
pnpm exec vitest run tests/unit/chronicle-query-plan.test.ts tests/unit/chronicle-retrieval-evaluator.test.ts
```

- [ ] **Step 6: Run the after ablation and enforce the gate**

```bash
pnpm evaluate:chronicle -- --implementation chunked_hybrid --output tmp/chronicle-evaluation/variant-ablation/after.json
```

Accept only if recall@10, NDCG, MRR, all leakage counts, and every tight-budget invariant are no worse than `before.json`, while at least one cold-cache corpus case has a lower `queryVariants` value. If no corpus case exercises the suppression, add a sanitized repeated-hint v3 case and rerun both sides before accepting.

- [ ] **Step 7: Regenerate the production profile and verify it**

Because query planning changed, regenerate rather than carrying forward stale profile metrics:

```bash
pnpm evaluate:chronicle -- --implementation legacy_hybrid --output tmp/chronicle-evaluation/variant-ablation/legacy-baseline.json
pnpm evaluate:chronicle -- --calibrate --baseline tmp/chronicle-evaluation/variant-ablation/legacy-baseline.json --write-profile packages/domain/src/generated/chronicle-retrieval-profile-v2.ts
pnpm evaluate:chronicle -- --implementation chunked_hybrid --output tmp/chronicle-evaluation/variant-ablation/verified.json
```

- [ ] **Step 8: Commit**

```bash
git add packages/domain/src/chronicle-query-plan.ts tests/unit/chronicle-query-plan.test.ts scripts/lib/chronicle-retrieval-evaluator.ts tests/unit/chronicle-retrieval-evaluator.test.ts packages/domain/src/generated/chronicle-retrieval-profile-v2.ts docs/architecture/0028-chunked-chronicle-retrieval.md
git commit -m "Prune redundant Chronicle queries"
```

---

### Task 5: Batch authorized rank SQL by signal family

**Improvement:** Reduce a context preview from as many as seventeen authorized rank statements to at most four family statements without changing any per-signal candidate order or fused result.

**Files:**
- Modify: `packages/database/src/chronicle-context-repository.ts`
- Modify: `tests/unit/chronicle-transaction-repository.test.ts`
- Modify: `tests/integration/chronicle-chunk-retrieval.integration.test.ts`
- Modify: `tests/integration/chronicle-retrieval-evaluation.integration.test.ts`
- Modify: `docs/architecture/0028-chunked-chronicle-retrieval.md`

**Interfaces:**
- Replaces private `loadAuthorizedChunkRank` with private `loadAuthorizedChunkRanks`.
- Adds private `ChunkRankResult` containing the original request and its ordered rows.
- Keeps `applyChunkedRankFusion`, `buildContextPreview`, rank-fusion inputs, and public diagnostics unchanged.

- [ ] **Step 1: Write a failing PostgreSQL query-count regression**

Wrap the transaction client used by `buildContextPreview` and record SQL comment tags. Assert a fully expanded semantic case produces:

```ts
expect(statements.filter((sql) => sql.includes("chronicle_rank_batch:"))).toHaveLength(4);
expect(statements.some((sql) => sql.includes("chronicle_rank:"))).toBe(false);
expect(preview.entries.map((entry) => entry.id)).toEqual(expectedMemoryIds);
```

Also capture each batch result's request ordinal, signal, variant, candidate ID, and `signal_rank` through the wrapped client so batching cannot silently change rank semantics.

- [ ] **Step 2: Run focused PostgreSQL tests and verify RED**

```bash
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts
```

Expected: result IDs are correct, but the statement-count assertion FAILS because rank requests execute one statement at a time.

- [ ] **Step 3: Introduce an ordered internal batch result**

```ts
type ChunkRankResult = Readonly<{
  request: ChunkRankRequest;
  rows: readonly ChunkCandidateRow[];
}>;

async function loadAuthorizedChunkRanks(
  client: DatabaseClient,
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
  requests: readonly ChunkRankRequest[],
  candidateLimit: number,
): Promise<readonly ChunkRankResult[]> {
  const results = new Map<ChunkRankRequest, readonly ChunkCandidateRow[]>();
  await loadSemanticRankFamily(client, scope, requests.filter((value) => value.signal === "semantic"), candidateLimit, results);
  await loadFullTextRankFamily(client, scope, requests.filter((value) => value.signal === "full_text"), candidateLimit, results);
  await loadEntityRankFamily(client, scope, requests.filter((value) => value.signal === "entity"), candidateLimit, results);
  await loadStaticRankFamily(client, scope, requests.filter((value) => !["semantic", "full_text", "entity"].includes(value.signal)), candidateLimit, results);
  return requests.map((request) => ({ request, rows: results.get(request) ?? [] }));
}
```

Keep calls sequential on the same client. Do not use `Promise.all`.

- [ ] **Step 4: Implement four authorized SQL families**

Each family statement must place the existing authorized CTE before parameterized request rows. For the semantic family, build request positions only:

```ts
const requestValuesSql = requests.map((_request, index) => {
  const vectorParameter = 5 + index;
  return `(${index}::integer,$${vectorParameter}::vector)`;
}).join(",");
const semanticFamilyCtes = `WITH ${authorizedChunkCte()},
  request_variants(request_ordinal,query_vector) AS (VALUES ${requestValuesSql})`;
```

Full-text and entity families must use the same ordinal pattern with their respective parameter casts. The static family has no request-value interpolation and uses fixed protocol-owned branch names.

For semantic variants, use parameterized `VALUES` rows containing request ordinal, variant kind, and `$n::vector`, then `CROSS JOIN LATERAL` a candidate-limited ordered scan for each variant. Full text uses request ordinal, variant kind, and query text. Entity uses request ordinal, variant kind, and entity IDs. Static signals use five `UNION ALL` branches over the same materialized authorized CTE for recency, chronology, importance, kind, and temporal.

Every family result must include `request_ordinal` and `signal_rank`; split rows by ordinal and sort by `signal_rank`, `parent_memory_id`, and `candidate_id` before constructing `ChunkRankResult`.

Build all dynamic parameter-position lists from integer positions only. Never interpolate query text, entity IDs, vectors, owner IDs, campaign IDs, world-version IDs, or temporal anchors into SQL source.

- [ ] **Step 5: Refactor rank orchestration without changing fusion order**

After query embeddings are available, build semantic requests in `variants` order and load them as one family. Then build nonsemantic requests in this exact order:

```ts
const nonsemanticRequests: ChunkRankRequest[] = [
  ...variants.map((variant) => ({ signal: "full_text" as const, variant, query: variant.query })),
  ...variants.filter((variant) => variant.entityIds.length > 0)
    .map((variant) => ({ signal: "entity" as const, variant, entityIds: variant.entityIds })),
  { signal: "recency", variant: actionVariant },
  { signal: "chronology", variant: actionVariant },
  { signal: "importance", variant: actionVariant },
  { signal: "kind", variant: actionVariant },
  {
    signal: "temporal",
    variant: actionVariant,
    temporalAnchor: scope.request.throughTurnNumber ?? campaign.active_turn_number
  }
];
```

Feed `addRank` in this same order. Preserve the separate one-time vector load for fused candidates used by diversity.

- [ ] **Step 6: Rerun focused tests and verify GREEN**

```bash
pnpm exec vitest run tests/unit/chronicle-transaction-repository.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts tests/integration/chronicle-retrieval-evaluation.integration.test.ts
```

Expected: selected IDs, signal ranks, fused ranks, fallback behavior, cache counts, cutoff behavior, and leakage are unchanged; a fully expanded case uses no more than four rank-family statements.

- [ ] **Step 7: Benchmark and document**

Run the existing 100-turn and 200-turn retrieval benchmark described in ADR 0028. Record median and p95 before and after on the same PostgreSQL instance. The acceptance gate is no accuracy regression and fewer rank statements; wall-clock improvement is reported, not fabricated as a fixed threshold.

- [ ] **Step 8: Commit**

```bash
git add packages/database/src/chronicle-context-repository.ts tests/unit/chronicle-transaction-repository.test.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts tests/integration/chronicle-retrieval-evaluation.integration.test.ts docs/architecture/0028-chunked-chronicle-retrieval.md
git commit -m "Batch Chronicle rank queries"
```

---

### Task 6: Batch chunk embeddings across a small parent page

**Improvement:** Reduce rebuild and changed-parent indexing latency when individual parents produce fewer chunks than the provider batch capacity, without weakening per-parent commit fencing.

**Files:**
- Modify: `packages/application/src/memory/types.ts`
- Modify: `services/runtime/src/chronicle-chunk-worker-execution.ts`
- Modify: `packages/database/src/chronicle-chunk-repository.ts`
- Modify: `tests/unit/chronicle-chunk-worker-execution.test.ts`
- Modify: `tests/integration/chronicle-chunk-repository.integration.test.ts`
- Modify: `docs/architecture/0028-chunked-chronicle-retrieval.md`

**Interfaces:**
- Changes internal worker contract `ChronicleChunkBatchCommit` by replacing `results` with `embeddingEvidence` and `costResults`.
- Keeps `ChronicleChunkBatchPort.commitParentBatch(scope, input): Promise<boolean>` and its per-parent transaction boundary unchanged.
- Keeps provider batch limits, retry policy, skip reasons, lease checks, progress cursor, and content-hash fences unchanged.

- [ ] **Step 1: Write failing worker tests for page-wide provider batching**

Create a page containing three one-chunk parents with provider capacity eight. Assert:

```ts
expect(values.parents.loadForClaim).toHaveBeenCalledWith(claim, {
  batchLimit: 8,
  cursor: null
});
expect(values.embeddings.embed).toHaveBeenCalledOnce();
expect(values.batches.commitParentBatch).toHaveBeenCalledTimes(3);
expect(values.batches.commitParentBatch.mock.calls.map(([, input]) => input.parent.id))
  .toEqual(["parent-1", "parent-2", "parent-3"]);
expect(values.batches.commitParentBatch.mock.calls.map(([, input]) => input.costResults.length))
  .toEqual([1, 0, 0]);
```

Assert each parent receives only its own vectors in `embeddingEvidence`, and that each commit's `previousParentCursor` equals the preceding durable cursor.

- [ ] **Step 2: Run worker tests and verify RED**

```bash
pnpm exec vitest run tests/unit/chronicle-chunk-worker-execution.test.ts
```

Expected: FAIL because the worker requests one parent at a time and embeds inside the parent loop.

- [ ] **Step 3: Split vector evidence from cost results**

Change the internal commit type to:

```ts
export type ChronicleChunkBatchCommit = Readonly<{
  parent: ChronicleChunkParent;
  previousParentCursor: string | null;
  provider: ChronicleChunkEmbeddingProvider | null;
  providerFingerprint: string | null;
  capabilityFingerprint: string;
  embeddingProtocolVersion: string;
  chunks: readonly ChronicleChunkDraftCommit[];
  embeddingEvidence: readonly (readonly number[])[];
  costResults: readonly ChronicleChunkEmbeddingResult[];
  progress: ChronicleChunkJobProgress;
}>;
```

In `commitParentBatch`, compare `embeddingEvidence` to the embedded chunks in order. Record costs from `costResults` inside the existing fenced transaction. Do not require cost-result embeddings to equal one parent's chunks because one provider result may span several parents.

- [ ] **Step 4: Add PostgreSQL contract tests and verify RED then GREEN**

Add an integration case where `embeddingEvidence` contains one parent vector while `costResults[0].embeddings` contains vectors for two parents. Assert the first parent commit succeeds, cost recording runs once, and a second commit with `costResults: []` succeeds without another cost record.

Retain and rerun the existing rollback case where `recordCost` throws; chunk rows and progress must roll back with the first parent transaction.

```bash
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-chunk-repository.integration.test.ts
```

- [ ] **Step 5: Prepare and embed a page of up to eight parents**

Add:

```ts
const CHRONICLE_CHUNK_PARENT_PAGE_SIZE = 8;

type PreparedParent = Readonly<{
  parent: ChronicleChunkParent;
  drafts: readonly ChronicleChunkDraft[];
  oversizedIndexes: ReadonlySet<number>;
}>;

type PendingEmbedding = Readonly<{
  parentIndex: number;
  draftIndex: number;
  chunk: ChronicleChunkDraft;
}>;
```

For each loaded page:

1. prepare every parent's final chunks and oversized partition;
2. flatten embeddable chunks in parent order and chunk-index order;
3. apply the existing item and token batch limits across the flattened list;
4. embed each bounded batch with the existing retry and health behavior;
5. map returned vectors back by `parentIndex` and `draftIndex`;
6. commit parents sequentially, advancing progress after each successful commit;
7. attach all page `costResults` to the first parent commit and an empty array to later commits.

Check the lease before every provider request and every parent commit. If a later parent commit fails, retain the earlier durable cursor; a retry re-embeds only the uncommitted suffix, and every real provider call remains costed once.

- [ ] **Step 6: Rerun worker and repository tests and verify GREEN**

```bash
pnpm exec vitest run tests/unit/chronicle-chunk-worker-execution.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-chunk-repository.integration.test.ts tests/integration/chronicle-contract-matrix.integration.test.ts
```

Expected: fewer provider calls for underfilled parents, identical chunks and vectors, sequential progress, stale-content rejection, lease-loss rejection, exact cost count, and no provider diagnostics containing content or secrets.

- [ ] **Step 7: Measure changed-parent readiness**

Index eight changed one-chunk parents with provider batch capacity eight. Record parent-load calls, provider calls, total embedded chunks, committed parents, and elapsed time before and after. Acceptance requires provider calls to fall from eight to one for this controlled case; wall-clock time is reported from the same provider fixture and machine.

- [ ] **Step 8: Commit**

```bash
git add packages/application/src/memory/types.ts services/runtime/src/chronicle-chunk-worker-execution.ts packages/database/src/chronicle-chunk-repository.ts tests/unit/chronicle-chunk-worker-execution.test.ts tests/integration/chronicle-chunk-repository.integration.test.ts docs/architecture/0028-chunked-chronicle-retrieval.md
git commit -m "Batch Chronicle parent embeddings"
```

---

### Task 7: Run the complete verification gate and finalize operating guidance

**Purpose:** Verify the six independent improvements together and record current evidence without introducing another behavior change.

**Files:**
- Modify: `docs/architecture/0028-chunked-chronicle-retrieval.md`
- Modify: `docs/workflows/testing.md` only if the documented commands or prerequisites changed
- Create: `tmp/chronicle-evaluation/final/legacy-baseline.json` (generated, do not commit)
- Create: `tmp/chronicle-evaluation/final/chunked.json` (generated, do not commit)

**Interfaces:**
- No new interface.
- Confirms `buildContextPreview` is still the only generation-facing retrieval seam.

- [ ] **Step 1: Run source and unit verification**

```bash
pnpm check
pnpm build
pnpm exec vitest run tests/unit/chronicle-retrieval-evaluator.test.ts tests/unit/chronicle-diversity.test.ts tests/unit/chronicle-query-plan.test.ts tests/unit/chronicle-rank-fusion.test.ts tests/unit/chronicle-retrieval-profile.test.ts tests/unit/chronicle-transaction-repository.test.ts tests/unit/chronicle-chunk-worker-execution.test.ts
```

- [ ] **Step 2: Run PostgreSQL verification**

```bash
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/chronicle-retrieval-evaluation.integration.test.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts tests/integration/chronicle-chunk-repository.integration.test.ts tests/integration/chronicle-contract-matrix.integration.test.ts tests/integration/chronicle-turn-immutability.integration.test.ts
```

Confirm the output shows PostgreSQL tests executed. If the environment cannot provide PostgreSQL, report this gate as incomplete.

- [ ] **Step 3: Generate final evaluator evidence**

```bash
pnpm evaluate:chronicle -- --implementation legacy_hybrid --output tmp/chronicle-evaluation/final/legacy-baseline.json
pnpm evaluate:chronicle -- --implementation chunked_hybrid --output tmp/chronicle-evaluation/final/chunked.json
```

Verify the generated profile corpus hash matches v3 and recorded metrics match the final chunked run.

- [ ] **Step 4: Prove authority and scope invariants**

Snapshot accepted turn rows, including `xmin`, before and after rebuild, retrieval, and evaluation. Require exact equality. Confirm all owner, campaign, world-version, cutoff, superseded-fact, and cross-campaign leakage tests pass.

- [ ] **Step 5: Finalize ADR measurements and rollback guidance**

Record:

- v3 corpus hash and selected profile;
- tight-budget label survival and prompt token counts;
- before/after rank statement count;
- 100-turn and 200-turn p50/p95 retrieval latency;
- eight-parent indexing provider-call count and elapsed time;
- zero leakage counts;
- the exact PostgreSQL verification command and result;
- rollback: restore the prior generated profile, prior query planner, single-rank loader, or parent page size one independently; no accepted turn or Chronicle parent repair is required.

- [ ] **Step 6: Review the complete diff and formatting**

```bash
git diff --check
git status --short
```

Inspect every changed file, confirm generated evaluation JSON under `tmp/` is untracked or ignored, and confirm unrelated pre-existing dirty files were not staged.

- [ ] **Step 7: Commit documentation**

```bash
git add docs/architecture/0028-chunked-chronicle-retrieval.md docs/workflows/testing.md
git commit -m "Document Chronicle tuning evidence"
```

If `docs/workflows/testing.md` did not change, omit it from `git add`.

## Plan Self-Review Checklist

- [ ] Every improvement is isolated in its own task and has a focused RED/GREEN test path.
- [ ] No task mutates accepted turns or treats derived chunks as authority.
- [ ] Tight-budget accuracy is measured before production rendering changes.
- [ ] Ranking weights are evaluator-generated, not hand-selected.
- [ ] Query suppression is gated by a before/after ablation.
- [ ] Rank batching preserves per-signal and per-variant order.
- [ ] Cross-parent embedding batching preserves sequential per-parent fencing and records each provider result once.
- [ ] PostgreSQL verification is distinguished from skipped or source-only checks.
- [ ] No reranker, ANN index, LLM query rewriting, arbitrary chunk controls, or prompt-priority redesign entered scope.
- [ ] The final profile hash and metrics match the promoted v3 corpus.
