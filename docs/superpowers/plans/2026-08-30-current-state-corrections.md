# Current State Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make current campaign continuity safely editable in both legacy and new UIs, with future-generation authority and incremental Chronicle indexing, while keeping prior turns immutable.

**Architecture:** Reuse the existing current-state API and append-only correction ledger. Introduce a focused transactional correction projector, protect active corrections in prompt context, and share pure editor draft/payload logic across the legacy Story dialog, new Story dialog, and new Campaign State page. Keep full replay for maintenance and lifecycle operations; ordinary saves update affected projections only.

**Tech Stack:** TypeScript/JavaScript, PostgreSQL/pgvector, existing application ports, Vitest, linkedom, Playwright, pnpm, Vite.

**Spec:** [Current-only campaign state corrections](../specs/2026-08-30-current-state-corrections-design.md). Read it before any task.

**Execution:** Tasks 1–9 are implemented. The user's subsequent instruction to use Terra subagents and keep tests reasonable replaced the exhaustive verification matrix below with focused existing suites and three browser smoke cases. See the [verification report](../../review/current-state-corrections-verification.md) for actual checks, screenshots, and limitations. Individual checklist items below preserve the original plan; they do not imply unexecuted checks passed or authorize publication.

## Global constraints

- Previous turns are not changeable; state corrections affect future generation only.
- Both the legacy and new UI must support the capability.
- Editing scope: Continuity Summary, Private Scratchpad, Open Threads, and Canonical Facts.
- Original accepted turn rows and private snapshots remain unchanged.
- Owner, campaign, and world-version scope applies to every read, projection, job, and prompt.
- Scratchpad remains excluded from Chronicle embeddings, illustrations, public streams, and routine logs.
- Keep tracker functionality; preserve mechanics and trigger values without expanding mechanics editing.
- Use one captured turn/revision baseline; reject stale or historical writes instead of silently retargeting them.
- Preserve unchanged fact IDs, Chronicle parents, chunks, and embeddings.
- Atomic database save and durable eligible job enqueue; no provider network calls inside the save transaction.
- PostgreSQL, provider-request, and rendered-browser checks must actually run before being claimed as verified.
- No production content, provider secrets, new dependency, historical migration rewrite, main-checkout change, or publication is required.
- The user subsequently authorized implementation using Terra subagents and a reasonable focused test set. Implementation is complete in the isolated worktree; the final verification report records actual checks and limitations.

## Baseline and source map

Inspected worktree: C:\Users\chris\.codex\worktrees\6256\InfiniteQuest.

Inspected HEAD: 972c5c767933caf8ca0de341b2e784e37e6620db, detached. The worktree was clean before these planning documents. Revalidate the starting SHA and unrelated edits when execution begins.

Repowise reported no index in this worktree. Use direct source until the user elects to initialize it; do not initialize it as a planning or implementation prerequisite.

| Source | Existing responsibility and relevant finding |
| --- | --- |
| packages/database/src/campaign-state-repository.ts | Current/history state reads, correction saves, rewind/branch. updateCampaignRuntimeState currently accepts historical effectiveTurnNumber. |
| packages/contracts/src/generation.ts | Complete runtime-state schemas; fact rows are { id, content }; effectiveTurnNumber is optional. |
| packages/database/src/chronicle-repository.ts | projectStateCorrection, grouped facts, full rebuild, parent embeddings. Current correction deletes broad projections; rebuild applies all edits after all turns. |
| packages/database/src/chronicle-chunk-repository.ts | Incremental parent reads, durable cursor signatures, leases, hash-fenced chunk commits. |
| packages/database/src/chronicle-context-repository.ts | Scoped retrieval and budgets; summary/threads/facts currently selected as optional Chronicle memories. |
| packages/story-engine/src/prompt.ts | Story prompt envelope/protocol; current protocol story-v12-soft-length-goal. |
| services/runtime/src/generation-executor-adapter.ts | Prompt budget, context retrieval, provider request; replacement uses an earlier base cutoff. |
| apps/web/src/story-state-editor.js | Legacy row rendering, fact identity, payload collection. Currently derives edit target from viewedTurnNumber. |
| apps/web/src/story.js and apps/web/public/story.html | Legacy dialog loading/save and static controls. Currently loads historical state for editing while browsing history. |
| apps/web-next/src/story-player-view.ts and story-player-page.ts | New Story editor currently uses JSON for lists and a complete state PATCH. |
| apps/web-next/src/campaign-editor-page.ts | New Campaign State currently flattens facts to lines and submits every ID as null. |
| packages/client-core/src | Existing shared non-DOM client logic, already consumed by both UIs. |
| tests/integration/campaign-state-corrections.integration.test.ts | Existing save, immutability, history-edit, grouped-fact, and stale-chunk tests. Historical-write success expectations must change. |
| docs/architecture/0011-editable-campaign-runtime-state.md | Existing ADR requires current-only edits but has outdated field descriptions. |

Do not reimplement the existing state ledger, add a second state endpoint, replace the retrieval engine, or convert fact groups into per-fact vectors in this scope.

## Execution topology and ownership

Each numbered task is one independently reviewed deliverable with its own RED/GREEN cycle and scoped commit. Setup, wiring, tests, and documentation that make that deliverable usable belong in that task. Subagents must receive the spec, this task's complete text, prerequisite commit IDs, and the shared interface definitions below.

| Task | Deliverable | Depends on | Primary ownership | Risk |
| --- | --- | --- | --- | --- |
| 1 | Current-only atomic save rules and shared integration fixtures | None | State save repository/contracts tests | Medium |
| 2 | Differential fact/memory projection | 1 | Chronicle correction writer, memory port, state-save call site | High |
| 3 | Durable incremental indexing for both embedding paths | 2 | Chronicle job/worker integration | High |
| 4 | Authoritative correction context and prompt budget | 1 | Correction reader, context repository, prompt/runtime | High |
| 5 | Shared client draft and payload model | None | client-core only | Low |
| 6 | Legacy current-state editor | 5 | apps/web only | Medium |
| 7 | Both new-UI editing surfaces | 5 | apps/web-next only | Medium |
| 8 | Chronological replay and lifecycle/portability compatibility | 2, 3, 4 | Replay/state lifecycle/import/export paths | High |
| 9 | Cross-surface acceptance, performance checks, and operator docs | 1–8 | Acceptance tests, docs, final fixes coordinated by owner | Medium |

~~~mermaid
flowchart LR
  T1["1 Save rules"] --> T2["2 Projection"]
  T2 --> T3["3 Index jobs"]
  T1 --> T4["4 Prompt authority"]
  T5["5 Shared editor model"] --> T6["6 Legacy UI"]
  T5 --> T7["7 New UI"]
  T2 --> T8["8 Replay and portability"]
  T3 --> T8
  T4 --> T8
  T8 --> T9["9 Acceptance and docs"]
  T6 --> T9
  T7 --> T9
~~~

Suggested schedule with three implementation slots:

1. Run 1 and 5 concurrently.
2. After 1/5 land, run 2, 6, and 7 concurrently.
3. Run 3 and 4 concurrently after 2 lands. Task 4 works on its independent production files and dedicated new tests first; it may edit the shared chronicle-transaction-repository.test.ts only after Task 3 commits and hands that file back. Its cumulative GREEN/commit gate follows that handoff.
4. Run 8 after 3 and 4; then run 9.

Do not run 2/3/8 concurrently: they share chronicle-repository.ts and parts of campaign-state-repository.ts. Task 4 owns memory context types in contracts/memory.ts; Task 2 owns application/memory/ports.ts, types.ts, index.ts, and use-cases.ts. Task 5 owns client-core/index.ts; UI workers consume it after Task 5 lands and do not edit it.

The coordinator owns conflict resolution, cumulative test runs, and final review. The one shared Task 3/4 test file has an explicit serial handoff; do not run global checks over another worker's half-written files. Shared-worktree subagents must not use git add -A or commit another worker's files. If separate worktrees are used, integrate prerequisite commits before dependent work. Never change the main checkout as part of this plan.

## Shared interfaces fixed by this plan

### Server correction projection (Task 2)

Add these to application/memory/types.ts and ports.ts, and export through application/memory/index.ts:

~~~ts
export type CampaignStateCorrectionProjectionScope =
  CampaignWorldVersionMemoryScope & Readonly<{ stateEditId: string }>;

export type CorrectionMemoryChanges = Readonly<{
  changedMemoryIds: readonly string[];
  removedMemoryIds: readonly string[];
}>;

// Additional MemoryGenerationTransactionPort method.
applyCampaignStateCorrection(
  database: MemoryTransactionContext,
  scope: CampaignStateCorrectionProjectionScope,
): Promise<CorrectionMemoryChanges>;
~~~

The method reads the persisted edit, not caller-authored replacement text. The caller holds the campaign/state lock and owns the transaction. changedMemoryIds includes created or text-changed parents; removedMemoryIds includes removed parents; unchanged rows are absent. The method does not enqueue provider work or open another transaction.

Task 2 creates the concrete implementation:

~~~ts
export async function applyPostgresStateCorrection(
  client: DatabaseClient,
  scope: CampaignStateCorrectionProjectionScope,
): Promise<CorrectionMemoryChanges>;
~~~

### Authoritative current correction (Task 4)

Define a schema/type in packages/contracts/src/memory.ts:

~~~ts
export const currentContinuitySchema = campaignRuntimeStateContentSchema.pick({
  continuitySummary: true,
  openThreads: true,
  canonicalFacts: true,
  scratchpad: true,
});
export type CurrentContinuity = z.infer<typeof currentContinuitySchema>;
~~~

Import the runtime content schema from generation.ts; the inspected generation.ts has no dependency on memory.ts. Recheck that relationship if HEAD changes, and preserve a single definition of field limits.

Create packages/database/src/campaign-continuity-repository.ts:

~~~ts
export async function loadCurrentContinuityCorrection(
  client: DatabaseClient,
  scope: CampaignWorldVersionMemoryScope,
  baseTurnNumber: number,
): Promise<CurrentContinuity | null>;
~~~

Return the highest revision whose effective_turn_number equals baseTurnNumber, not the latest edit at any earlier turn. Validate database JSON and the campaign's pinned world version. null means no active correction; an object with empty values means an explicit correction. No mechanics or operational edit metadata enter this type.

### Shared browser model (Task 5)

Create packages/client-core/src/campaign-state-editor.ts and export:

~~~ts
export type CampaignContinuityDraft = {
  continuitySummary: string;
  scratchpad: string;
  openThreads: Array<{ key: string; content: string }>;
  canonicalFacts: Array<{ key: string; id: string | null; content: string }>;
};

export function createCampaignContinuityDraft(
  base: CampaignRuntimeStateResponse,
): CampaignContinuityDraft;

export function buildCurrentStateUpdate(
  base: CampaignRuntimeStateResponse,
  draft: CampaignContinuityDraft,
  options?: Readonly<{ trackers?: CampaignRuntimeStateUpdate["trackers"] }>,
): CampaignRuntimeStateUpdate;

export function hasCampaignContinuityChanges(
  base: CampaignRuntimeStateResponse,
  draft: CampaignContinuityDraft,
): boolean;
~~~

key is a UI-only identity, stable for the life of the draft and never sent to the API. Existing fact IDs remain attached through editing/removal/reordering; new fact IDs are null. Use deterministic keys for hydration, and caller-created unique keys for added rows. The payload uses base.activeTurnNumber for both expectedTurnNumber and effectiveTurnNumber, base.revision for expectedRevision, and copies untouched mechanics/triggers from base. It throws for !base.isCurrent or a mismatched viewedTurnNumber. Optional trackers preserves the existing tracker editor without expanding this model to mechanics editing.

## Verification commands and evidence format

Use the repository's pinned pnpm via Corepack/runtime and existing package scripts. This worktree did not have node_modules or .env.test.local at planning time; that is an execution setup requirement, not a reason to label integration tests passed.

~~~powershell
$env:CI = 'true'
pnpm install --frozen-lockfile
pnpm vitest run tests/unit/campaign-state-contract.test.ts
pnpm vitest run --config vitest.integration.config.ts tests/integration/campaign-state-corrections.integration.test.ts
~~~

The integration config provisions the test service through scripts/ensure-test-database.mjs and creates a fresh database per file. Use that config, not a plain Vitest run that can skip database tests. Never run these tests against a production database. If Docker/PostgreSQL access is unavailable, complete unit work and report that acceptance is blocked on actual integration execution.

For every task record: starting SHA, files changed, exact RED command/failure, GREEN command/count, additional regression results, unrun checks, and resulting scoped commit SHA. Read stderr and skipped counts; an exit code alone does not establish that intended tests ran.

## Task 1: Enforce current-only, atomic state correction saves

**Files**

- Modify: packages/database/src/campaign-state-repository.ts, only updateCampaignRuntimeState and directly related normalization.
- Review/modify when behavior expectations change: tests/unit/campaign-state-contract.test.ts, tests/unit/campaign-state-repository.test.ts.
- Modify: tests/integration/campaign-state-corrections.integration.test.ts.
- Create: tests/helpers/campaign-state-correction-fixtures.ts.
- Review: packages/contracts/src/generation.ts, services/api/src/server.ts state routes, packages/application/src/world-campaign/use-cases.ts.

**Interfaces**

- Consumes the existing complete CampaignRuntimeStateUpdate and owner-scoped state repository.
- Produces unchanged public request/response shapes with current-only target enforcement.
- Produces reusable integration fixture helpers below. Keep helper setup limited to sanitized test fixtures.

- [ ] Add this fixture creator, moving the existing local campaign fixture setup into it:

~~~ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import {
  getCampaignRuntimeState,
  importLegacyStory,
} from "./memory-aware-services.js";

export async function createCorrectionFixture(pool: DatabasePool) {
  const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
  story.world.title = "Current correction " + crypto.randomUUID();
  const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
    sourceName: "current-correction.story",
    story,
  }));
  const before = await getCampaignRuntimeState(pool, imported.campaignId);
  return {
    campaignId: imported.campaignId,
    ownerUserId: await initialOwnerId(pool),
    before,
  };
}

export async function snapshotCorrectionEvidence(pool: DatabasePool, campaignId: string) {
  const tables = [
    "turns", "campaign_state", "campaign_state_edits",
    "campaign_canonical_facts", "chronicle_memories",
    "chronicle_memory_chunks", "chronicle_jobs", "chronicle_chunk_jobs",
    "model_chains", "summary_checkpoints",
  ] as const;
  const entries = await Promise.all(tables.map(async (table) => {
    const result = await pool.query(
      "SELECT to_jsonb(t) AS value FROM " + table +
      " t WHERE campaign_id=$1 ORDER BY to_jsonb(t)::text",
      [campaignId],
    );
    return [table, result.rows.map((row) => row.value)] as const;
  }));
  return Object.fromEntries(entries);
}
~~~

- [ ] Replace the historical-write success case with a rejection test inside the existing PostgreSQL suite:

~~~ts
const { campaignId, before } = await createCorrectionFixture(pool);
const evidence = await snapshotCorrectionEvidence(pool, campaignId);
await expect(updateCampaignRuntimeState(pool, campaignId, {
  ...before,
  expectedTurnNumber: before.activeTurnNumber,
  expectedRevision: before.revision,
  effectiveTurnNumber: before.activeTurnNumber - 1,
  continuitySummary: "A rejected historical correction.",
})).rejects.toMatchObject({
  statusCode: 409,
  details: { code: "active_turn_changed" },
});
expect(await snapshotCorrectionEvidence(pool, campaignId)).toEqual(evidence);
~~~

- [ ] Add table-driven cases for omitted/current/future targets, stale turn, stale revision, all active/recoverable generation statuses, duplicate/foreign fact IDs, cross-owner requests, unsafe fiction, repeated identical saves, and turn-zero editing. Use repository ports for owner-isolation checks; the pre-auth HTTP layer does not accept a spoofed owner.
- [ ] Run the focused contract/repository unit tests and the integration file with the integration config. RED must show historical saves currently succeed.
- [ ] Change the effective target check from greater-than to equality under the existing campaign/state lock:

~~~ts
const effectiveTurnNumber = parsed.effectiveTurnNumber ?? parsed.expectedTurnNumber;
if (effectiveTurnNumber !== current.activeTurnNumber) {
  return failure("active_turn_changed", {
    campaignId: scope.campaignId,
    expectedTurnNumber: effectiveTurnNumber,
    actualTurnNumber: current.activeTurnNumber,
  });
}
~~~

- [ ] Remove the unreachable historical-write branch from this command, retaining historical GET behavior and existing records. Keep the optional request field for current-client compatibility. Ensure no-op detection compares the effective loaded state and normalized fact IDs before revision allocation.
- [ ] Re-run focused tests. Keep existing original-turn snapshot assertions; extend them to every accepted row using snapshotTurnRows. Verify an invalid request does not remove chains or enqueue work.
- [ ] Commit only these changes: suggested summary "Restrict campaign state corrections to the current turn".

**Done:** A custom client cannot edit historical state; current saves and historical reads still work; all rejections and no-ops are non-mutating.

## Task 2: Replace broad correction rebuilds with differential projection

**Files**

- Create: packages/database/src/chronicle-state-correction-repository.ts.
- Modify: packages/database/src/chronicle-repository.ts, packages/database/src/campaign-state-repository.ts.
- Modify: packages/application/src/memory/types.ts, ports.ts, index.ts, use-cases.ts.
- Modify: tests/unit/chronicle-transaction-repository.test.ts and affected typed memory doubles.
- Create: tests/integration/campaign-state-incremental-memory.integration.test.ts.
- Review: packages/domain/src/chronicle-memory-helpers.ts, entity-references.ts, canonical-facts.ts; use their sanitization/entity/identity logic.

**Interfaces**

- Consumes Task 1's persisted current-only correction.
- Produces applyCampaignStateCorrection and CorrectionMemoryChanges exactly as defined above.
- Retains rebuildCampaignMemories for maintenance callers; no new external HTTP endpoint.

- [ ] Create the new integration suite using Task 1 fixtures and the existing migrateDatabase/beforeAll/afterAll pattern. Add RED assertions for scratchpad-only and one-fact changes:

~~~ts
const { campaignId, before } = await createCorrectionFixture(pool);
const evidence = await snapshotCorrectionEvidence(pool, campaignId);
await updateCampaignRuntimeState(pool, campaignId, {
  ...before,
  expectedTurnNumber: before.activeTurnNumber,
  expectedRevision: before.revision,
  scratchpad: "The keeper privately recognizes the traveler.",
});
const after = await snapshotCorrectionEvidence(pool, campaignId);
expect(after.turns).toEqual(evidence.turns);
expect(after.chronicle_memories).toEqual(evidence.chronicle_memories);
expect(after.chronicle_memory_chunks).toEqual(evidence.chronicle_memory_chunks);
expect(after.summary_checkpoints).toEqual(evidence.summary_checkpoints);
~~~

- [ ] Seed terminal chunks and vectors using the SQL pattern in campaign-state-corrections.integration.test.ts and chronicle-chunk-repository.integration.test.ts. Assert unrelated turn-fiction parent/chunk/vector rows are identical after editing one fact. Cover add/edit/remove/reorder, same-turn versus earlier-turn fact identity, empty summary/threads/facts, repeated edits, and transaction failure after projection starts.
- [ ] Run the new integration file; RED must demonstrate broad deletion/recreation rather than a missing dependency.
- [ ] Implement applyPostgresStateCorrection in the new module. Read the edit and campaign/world entity catalog through owner-scoped queries. Preserve the existing fact-ID reconciliation performed before the correction snapshot is written. Reconcile active facts by ID: retain unchanged, end validity of superseded earlier facts, add replacements, and handle same-turn revisions without rewriting accepted snapshots.
- [ ] Build desired summary/thread/fact-group projections and compare against existing parents. Reuse grouped canonical facts by source turn, with one manual group. Match pre-feature records by memory kind, source turn, and structuredFactIds before adopting metadata keys such as state:summary, state:threads, facts:turn:<turn-id>, and facts:manual.
- [ ] Use an update predicate that preserves unchanged rows and explicitly invalidates changed parent vectors:

~~~sql
UPDATE chronicle_memories
   SET content=$4, token_estimate=$5, entities=$6, entity_ids=$7,
       metadata=$8,
       embedding=NULL, embedding_provider_profile_id=NULL,
       embedding_model=NULL, embedding_dimensions=NULL,
       embedding_content_hash=NULL, embedding_updated_at=NULL,
       embedding_provider_fingerprint=NULL, updated_at=now()
 WHERE id=$1 AND owner_user_id=$2 AND campaign_id=$3
   AND content IS DISTINCT FROM $4;
~~~

The actual statement also pins world_version_id. Use a metadata-only update when provenance changes without text changes and preserve vectors in that case. Preserve the whole row for a true no-op. Parent deletion is allowed only for removed affected content; its child cascade is intentional.

- [ ] Collect affected fact groups before retiring facts. Remove/replace stale group content immediately so both lexical and semantic paths reject it. Do not append obsolete text as a "correction explanation" to embeddings. Do not touch turn_fiction parents, unrelated groups, or historical summary checkpoints.
- [ ] Add the memory port delegation and concrete wiring. At the state-save call site replace rebuildCampaignMemories with:

~~~ts
const memoryChanges = await collaborators.memory.applyCampaignStateCorrection(client, {
  ...memoryScope,
  stateEditId: editId,
});
~~~

Task 3 will finalize job scheduling from memoryChanges. Until then retain the existing enqueue only when changedMemoryIds or removedMemoryIds is nonempty; scratchpad-only saves must enqueue nothing.

- [ ] Ensure explicit empty canonicalFacts does not fall back to accepted snapshot facts in runtimeStateContent. Distinguish undefined projection input from an intentionally empty result. Exercise the empty state immediately after save and on a subsequent read.
- [ ] Run the new integration suite, original corrections suite, and transaction unit suite. Also run client/state contract tests after port wiring. A local literal search for MemoryGenerationTransactionPort and rebuildCampaignMemories must identify all affected typed test doubles; do not silence missing methods with broad casts.
- [ ] Commit: "Project current state corrections without rebuilding campaign history".

**Done:** One changed memory group invalidates only that group; scratchpad-only changes touch no Chronicle data; API response/fact identity matches persisted authority.

## Task 3: Make background indexing durable, incremental, and race-safe

**Files**

- Modify: packages/database/src/chronicle-repository.ts, chronicle-chunk-repository.ts, campaign-state-repository.ts.
- Modify as required for legacy embedding reuse: services/runtime/src/chronicle-worker-execution.ts.
- Review/modify only on a demonstrated gap: services/runtime/src/chronicle-chunk-worker-execution.ts.
- Modify: tests/integration/campaign-state-incremental-memory.integration.test.ts, tests/integration/chronicle-chunk-repository.integration.test.ts.
- Modify: tests/unit/chronicle-worker-execution.test.ts, tests/unit/chronicle-chunk-worker-execution.test.ts, tests/unit/chronicle-transaction-repository.test.ts.

**Interfaces**

- Consumes CorrectionMemoryChanges.
- Reuses enqueueEmbeddingReindex and enqueueChunkIndex and existing job schemas. No new queue or scheduler lane.
- Preserves existing worker public failure projections and provider-fingerprint validation.

- [ ] Add a RED test with semantic retrieval enabled, one edited fact group, and a recording mock embedding port. Assert only affected documents reach embed(), and that an unchanged turn parent keeps its vector/hash/updated timestamp.
- [ ] Add independent cases for legacy_hybrid, chunked_hybrid, shadow-only, fully disabled, unavailable provider, failed worker retry, and two successive corrections while a chunk claim is in flight. Seed an old durable cursor before the changed parent to prove it is revisited safely.
- [ ] Run focused worker unit tests and the incremental/chunk integration files.
- [ ] In the save transaction enqueue both eligible existing paths when memory text/eligibility changed:

~~~ts
const hasMemoryChanges =
  memoryChanges.changedMemoryIds.length > 0 ||
  memoryChanges.removedMemoryIds.length > 0;
if (hasMemoryChanges) {
  await collaborators.memory.enqueueEmbeddingReindex(client, memoryScope);
  await collaborators.memory.enqueueChunkIndex(client, memoryScope);
}
~~~

Refactor enqueueEmbeddingReindex so scheduling is based on persisted configuration and does not call provider discovery/network work. Disabled configuration returns null. An unavailable configured provider is handled by the worker, leaving correction text usable immediately.

- [ ] Remove swallowed enqueue failure only from this correction command. A database enqueue failure rolls back the correction; unrelated lifecycle best-effort behavior is not globally rewritten. Coalesced queued/running jobs increment work_version only for real new projection work.
- [ ] Preserve and test chunk work_signature/processed_signature behavior. Existing parent/hash/provider/lease fencing must reject stale commits after a second edit. A signature reset may rescan unchanged parents, but must not resend their documents to the embedding provider.
- [ ] Make legacy parent embedding execution skip compatible unchanged vectors by content hash, provider/model fingerprint, and dimensions. Ensure retries and cursor restarts do not re-embed unrelated parents. Reuse existing compatibility helpers, not a second provider identity rule.
- [ ] Before job completion, prove current work-version coverage; prevent a claim for the first correction from marking the second correction indexed. Keep truthful pending/fallback health in both retrieval implementations.
- [ ] Run the focused suites and the existing Chronicle worker integration coverage. Record actual embedding document counts; distinguish database signature scans from provider work.
- [ ] Commit: "Index only changed correction memories with durable job fencing".

**Done:** Save never waits for embeddings; provider outage cannot undo a saved correction; both retrieval paths converge to the latest text without re-embedding unchanged history.

## Task 4: Protect current corrections in next-turn prompt construction

**Files**

- Create: packages/database/src/campaign-continuity-repository.ts.
- Modify: packages/contracts/src/memory.ts and its existing exports if needed.
- Modify: packages/database/src/chronicle-context-repository.ts.
- Modify: packages/story-engine/src/prompt.ts.
- Modify: services/runtime/src/generation-executor-adapter.ts.
- Modify: tests/unit/prompt.test.ts, tests/unit/generation-executor-adapter.test.ts, tests/unit/chronicle-transaction-repository.test.ts only after Task 3 if shared.
- Create: tests/unit/campaign-continuity-repository.test.ts for the independent scoped reader tests.
- Create: tests/integration/campaign-state-prompt.integration.test.ts.
- Review: packages/database/src/generation-repository.ts, generation-execution-repository.ts, prompt snapshot tests and customized prompt handling.

**Interfaces**

- Produces CurrentContinuity and loadCurrentContinuityCorrection as defined above.
- Adds optional scopes.currentContinuity to existing context output; buildContextPreview remains the generation seam.
- Does not change accepted story output schemas or provider API parameters.

- [ ] Add a prompt unit test using the real envelope builder:

~~~ts
const currentContinuity = {
  continuitySummary: "The keeper is alive.",
  openThreads: [],
  canonicalFacts: [],
  scratchpad: "",
};
const input = JSON.parse(buildStoryUserPrompt({
  worldCanon: {}, campaignCanon: {}, chronicle: [],
  currentScene: null, currentContinuity,
}, "Ask the keeper about the harbor."));
expect(input.authoritative_context.currentContinuity).toEqual(currentContinuity);
expect(input.instructions.join(" ")).toContain("corrected current continuity");
~~~

- [ ] Add PostgreSQL/provider-request tests that save a correction and start append generation before any embedding worker runs. Capture the actual deterministic mock provider request and assert all four values, explicit empties, and correct fact IDs. Repeat with disabled/unavailable semantic retrieval and stale historical narration containing the prior error.
- [ ] Add tests where the context budget is tight enough to evict optional history but retain the correction, and one where fixed correction text alone exceeds the provider limit. The latter must fail before a story provider call with context_budget_exceeded and leave saved state/turns unchanged.
- [ ] Run prompt/runtime/reader unit tests and the new integration file to establish RED. While Task 3 is active, keep its shared transaction-test file untouched; adapt that file's default no-correction query fixture only after the explicit handoff.
- [ ] Implement the scoped exact-base-turn reader. Query through campaign ownership/world version, order by revision DESC, limit 1, and validate with currentContinuitySchema. Never treat an empty collection as absence. At current turn zero, use an effective zero correction without inventing a turn row.
- [ ] Reserve correction tokens before optional Chronicle ranking/selection and fixed-scope shrinking. Attach currentContinuity outside scopes.chronicle; deduplicate scratchpad in campaignCanon when the complete correction supplies it. While present, omit superseded summary/thread/fact projections from the optional selection so blank overrides are not refilled.
- [ ] Add this instruction to the generated user envelope, with parallel system-prompt guidance:

~~~ts
"Use corrected current continuity as authoritative for the next turn when it conflicts with historical narration or provider conversation memory. Empty corrected fields are intentional. Mandatory world rules still apply."
~~~

- [ ] Bump STORY_PROMPT_PROTOCOL_VERSION to story-v13-current-state-corrections if the inspected v12 is still current; if another prompt change has landed, allocate the next version and update references in this task's evidence. Preserve customized system templates. Confirm context fingerprinting includes the currentContinuity block and existing state saves invalidate model chains.
- [ ] Respect generation cutoff: append uses current base N; explicit replacement uses base_turn_number and must not pull a correction at active N into a base N-1 request. After N+1 acceptance the N correction is no longer an active override. A reader database error must not silently produce an uncorrected prompt.
- [ ] Re-run tests and check scratchpad absence from recorded embedding/image requests, public events, and sanitized logs. Keep all raw prompt inspection in synthetic test fixtures.
- [ ] Commit: "Make current state corrections authoritative in future story prompts".

**Done:** The real next-turn provider request uses saved correction authority independently of retrieval success, with no historical-cutoff or privacy leakage.

## Task 5: Introduce one shared client continuity draft model

**Files**

- Create: packages/client-core/src/campaign-state-editor.ts.
- Modify: packages/client-core/src/index.ts.
- Create: tests/unit/client-core/campaign-state-editor.test.ts.
- Create: tests/fixtures/current-state-corrections.ts.
- Read: packages/contracts/src/client-api.ts and generation.ts for response/update types.

**Interfaces**

- Produces CampaignContinuityDraft, createCampaignContinuityDraft, buildCurrentStateUpdate, and hasCampaignContinuityChanges exactly as above.
- Consumed by Tasks 6 and 7; no DOM dependency, network call, or global storage.

- [ ] Add this shared synthetic fixture for the client/UI/browser tasks; keep it separate from Task 1's database fixture:

~~~ts
import type { CampaignRuntimeStateResponse } from "../../packages/contracts/src/index.js";

export function currentStateFixture(
  overrides: Partial<CampaignRuntimeStateResponse> = {},
): CampaignRuntimeStateResponse {
  return {
    campaignId: "11111111-1111-4111-8111-111111111111",
    activeTurnNumber: 5,
    viewedTurnNumber: 5,
    isCurrent: true,
    revision: 7,
    updatedAt: "2026-08-30T12:00:00.000Z",
    recordedResolution: null,
    continuitySummary: "The keeper guards the harbor.",
    openThreads: ["Find the missing harbor chart."],
    canonicalFacts: [{
      id: "22222222-2222-4222-8222-222222222222",
      content: "The lens is moon glass.",
    }],
    scratchpad: "The keeper recognizes the visitor.",
    trackers: [],
    rpgStats: [],
    eventTriggers: [],
    pendingEventTriggers: [],
    ...overrides,
  };
}
~~~

Each call creates independent arrays. Check the synthetic fixture against scripts/check-repository-data.mjs; extend an explicit test-fixture allowlist only if the existing policy requires it.
- [ ] Add these RED test cases:

~~~ts
const base = currentStateFixture();
const draft = createCampaignContinuityDraft(base);
draft.scratchpad = "A private corrected detail.";
const unchangedFactId = base.canonicalFacts[0]!.id;
const payload = buildCurrentStateUpdate(base, draft);
expect(payload.canonicalFacts[0]!.id).toBe(unchangedFactId);
expect(payload.expectedTurnNumber).toBe(base.activeTurnNumber);
expect(payload.effectiveTurnNumber).toBe(base.activeTurnNumber);
expect(payload.expectedRevision).toBe(base.revision);
expect(payload.rpgStats).toEqual(base.rpgStats);
expect(base.scratchpad).not.toBe(draft.scratchpad);
expect(() => buildCurrentStateUpdate({
  ...base, isCurrent: false, viewedTurnNumber: base.activeTurnNumber - 1,
}, draft)).toThrow();
~~~

- [ ] Cover new/null fact IDs, blank row omission, multiline row preservation, duplicate ID rejection, unchanged save detection, row reorder identity, intentional clearing, non-mutated base data, and optional tracker override. UI row keys must not appear in the payload.
- [ ] Run pnpm vitest run tests/unit/client-core/campaign-state-editor.test.ts for RED.
- [ ] Implement normalization once: preserve summary/scratchpad text; trim list content and remove empty rows; retain provided IDs; copy other complete-state fields from the frozen base. Validate the final payload with the existing schema. Throw a clear current-state-only client error rather than substituting active turn numbers into a historical snapshot.
- [ ] Implement dirty comparison against the same normalized representation used for payloads, including order where the contract preserves it. Store no draft in shared localStorage.
- [ ] Run the suite and pnpm --filter @infinite-quest/client-core check.
- [ ] Commit: "Share current state correction drafts across web clients".

**Done:** Both UI tasks can consume identical current-only payload behavior without implementing their own fact matching or concurrency policy.

## Task 6: Complete the legacy current-state correction experience

**Files**

- Modify: apps/web/src/story.js, apps/web/src/story-state-editor.js.
- Modify: apps/web/public/story.html, apps/web/public/story.css.
- Modify: tests/unit/story-state-editor.test.ts, tests/unit/story-player-ui.test.ts.
- Review: apps/web/src/story-keyboard.js and existing managed-modal/unsaved-change handling; change only if the new inputs are not covered.

**Interfaces**

- Consumes Task 5's exported draft/payload functions through @infinite-quest/client-core.
- Uses existing composition.api.campaigns.state and updateState.
- Keeps existing historical inspector, tracker editor, and mechanics display contracts.

- [ ] Add behavioral tests proving openEditState requests current state without a viewed-turn argument, even when the Story reader is on an older turn. Replace the helper test that intentionally targets viewedTurnNumber with rejection/current-target coverage.
- [ ] Add linkedom tests that edit summary/scratchpad, add/remove multiline thread/fact rows, and retain hidden fact IDs. Extend the existing submitCampaignState success/rejection tests to include unchanged draft/baseline on 409.
- [ ] Use this row-identity assertion against the existing DOM helper:

~~~ts
const { document } = parseHTML("<div id='facts'></div>");
const container = document.getElementById("facts")!;
const id = "00000000-0000-4000-8000-000000000001";
renderEditableStateCollection(document, container, [
  { id, content: "The keeper is alive.\nThe keeper remains at the harbor." },
], "fact");
const textarea = container.querySelector("textarea")!;
textarea.value = "The keeper is alive and guards the harbor.";
expect(collectCanonicalFactEditorValues(container)).toEqual([
  { id, content: "The keeper is alive and guards the harbor." },
]);
~~~

- [ ] Run pnpm vitest run tests/unit/story-state-editor.test.ts tests/unit/story-player-ui.test.ts. Confirm RED specifically exercises the historical target and draft behavior.
- [ ] In openEditState load composition.api.campaigns.state(campaignId) without a historical turn; capture a complete base snapshot and draft scoped to that campaign. Remove the temporary substitution of historical runtimeState into the editable dialog. Keep historical inspection through its read-only path.
- [ ] Retain the existing row DOM functions as thin adapters around Task 5, removing duplicated normalization/target rules. Ensure new row keys survive rerendering and ID assignment happens only after a successful server response.
- [ ] Update the explanatory text and metadata to show the actual edited current turn and revision. A reader at turn M must not label the editor as M when it edits current N. Remove no existing history navigation action.
- [ ] Save using the captured base and draft, with tracker values from the existing tracker editor. Disable duplicate saves, preserve drafts on validation/409/network failure, and clear the draft only after the response belongs to the still-open campaign/session.
- [ ] Before accepting a response or repainting, verify both captured campaign ID and editor-session identity. If a sync reports a newer active turn/revision, mark the draft stale; do not retarget or silently retry it. Add an explicit Reload current state action using the existing unsaved-change guard.
- [ ] Add correct labels for every row/remove button; focus the new row after Add and a neighboring row after Remove. Keep Escape/cancel guards and ensure mobile textareas/buttons do not overflow.
- [ ] Run the focused suites, legacy package check, and pnpm build:web:legacy. Task 9 supplies final screenshots and cross-browser acceptance.
- [ ] Commit: "Keep legacy state editing current-only with stable continuity rows".

**Done:** Legacy users can correct the four fields from any reading position, but can edit only the current base; stale or failed saves retain their work.

## Task 7: Update both new-UI state editors

**Files**

- Create: apps/web-next/src/campaign-continuity-editor.ts.
- Modify: apps/web-next/src/story-player-view.ts, story-player-page.ts, story-player-tools.ts.
- Modify: apps/web-next/src/campaign-editor-page.ts, campaign-editor-model.ts.
- Modify: apps/web-next/src/story-player.css, styles.css.
- Create: tests/unit/web-next-campaign-continuity-editor.test.ts.
- Modify: tests/unit/web-next-story-page.test.ts, web-next-story-tools.test.ts, web-next-campaign-editor.test.ts.

**Interfaces**

- Consumes Task 5's draft/payload model.
- Produces a reusable new-UI DOM renderer/controller for the four continuity fields:

~~~ts
export function createCampaignContinuityEditor(
  document: Document,
  initial: CampaignContinuityDraft,
  options: Readonly<{ idPrefix: string; onChange: () => void }>,
): Readonly<{
  element: HTMLElement;
  readDraft(): CampaignContinuityDraft;
  setDisabled(disabled: boolean): void;
  dispose(): void;
}>;
~~~

Each instance owns its draft and event listeners. It does not fetch, save, close dialogs, or own state revisions. Use distinct idPrefix values for Story and Campaign State. The caller owns the full base snapshot and asynchronous session lifecycle.

- [ ] Add a RED behavioral test for the shared new-UI editor:

~~~ts
const { document } = parseHTML("<main></main>");
const base = currentStateFixture();
const editor = createCampaignContinuityEditor(
  document, createCampaignContinuityDraft(base),
  { idPrefix: "campaign-state", onChange: () => undefined },
);
document.querySelector("main")!.append(editor.element);
const fact = editor.element.querySelector<HTMLTextAreaElement>("[data-fact-content]")!;
fact.value = "The lens is clear glass.";
fact.dispatchEvent(new document.defaultView!.Event("input", { bubbles: true }));
expect(editor.readDraft().canonicalFacts[0]!.id).toBe(base.canonicalFacts[0]!.id);
expect(editor.readDraft().canonicalFacts[0]!.content).toBe("The lens is clear glass.");
expect(editor.element.querySelector("[data-edit-fact-id]")).toBeNull();
~~~

- [ ] Add mounted-page tests for both callers. Assert a scratchpad-only save retains all fact IDs, unchanged list rows remain intact, multiline facts do not split at newline, no raw JSON is required for the four fields, and all untouched state arrays survive.
- [ ] Add tests for dirty drafts surviving Story rerenders, Campaign State Chronicle polling, API errors, and campaign switches. Use deferred promises from web-next-story-tools.test.ts to prove late responses cannot close or overwrite another editor.
- [ ] Run the new editor unit test plus the existing three new-UI suites for RED.
- [ ] Implement the shared DOM editor with labeled row controls and stable UI keys; use textContent/value, not unescaped HTML, for user content. Keep literal newlines within one fact or thread row.
- [ ] Replace the new Story dialog's JSON fields for openThreads/canonicalFacts with the shared editor. Preserve the draft outside the view's ephemeral DOM so render() cannot erase typing or focus. Use the captured base to buildCurrentStateUpdate and pass its result to tools.saveCurrentState.
- [ ] Replace the Campaign State page's one-per-line fact field and id:null reconstruction with the same editor. Capture the original state response at form creation; remove the save-time refetch/merge of fresh state into an old draft. If verification detects a new revision, preserve the draft and show a reload conflict instead.
- [ ] Keep existing tracker controls and out-of-scope mechanics values. In the continuity save flow, pass through loaded mechanics/triggers without adding controls to edit them. Existing separate actions must not acquire implicit state-edit authority.
- [ ] Keep campaignStateInspectorMarkup historical fields read-only. Its current-state link opens the current page, not an editable historical snapshot. Story tools similarly load current state without a turn query.
- [ ] Apply the shared copy, loading/saving/disabled states, error placement, row focus, unsaved-change guard, and safe session handling. Use dedicated CSS classes for this editor; no wholesale restyle of either page.
- [ ] Run the four new-UI suites, pnpm --filter @infinite-quest/web-next check, and pnpm build:web:next.
- [ ] Commit: "Unify new UI current state editing with stable fact identities".

**Done:** Both /app Story and Campaign State expose the same four-field workflow, retain IDs and dirty drafts, and never save a viewed historical state.

## Task 8: Make replay, generation advancement, and portability preserve corrections

**Files**

- Modify: packages/database/src/chronicle-repository.ts and chronicle-state-correction-repository.ts.
- Modify where regression tests show reference/state mismatches: packages/database/src/campaign-state-repository.ts, generation-execution-repository.ts.
- Review/modify affected copy paths: packages/database/src/campaign-transfer-character-repository.ts, portable-import-family-repository.ts, campaign-archive-export-repository.ts, system-archive-import-repository.ts, system-archive-export-repository.ts.
- Create: tests/integration/campaign-state-replay.integration.test.ts.
- Modify: tests/integration/generation.integration.test.ts, campaign-transfer.integration.test.ts, campaign-archive.integration.test.ts, system-archive.integration.test.ts, chronicle-turn-immutability.integration.test.ts.
- Review: packages/contracts/src/system-archives.ts and archive classification only if the actual persisted shape changes.

**Interfaces**

- Consumes the correction projector, authoritative reader, and indexing behavior.
- Keeps rebuildCampaignMemories signature and archive formats stable.
- Produces chronological replay using the same correction semantics as live saves, including explicit empties and stable fact-reference translation.

- [ ] Add a real database trace: edit N, accept N+1 through the deterministic mock generation provider, read current state/context, rebuild, and compare. Use existing generation.integration.test.ts provider setup rather than writing a fake turn insert for this principal acceptance case.
- [ ] Add a helper in the new suite to compare logical state while ignoring transport timestamps:

~~~ts
function continuityValue(state: CampaignRuntimeState) {
  return {
    continuitySummary: state.continuitySummary,
    openThreads: state.openThreads,
    canonicalFacts: state.canonicalFacts.map(({ id, content }) => ({ id, content })),
    scratchpad: state.scratchpad,
    trackers: state.trackers,
  };
}
// Run after the suite has accepted N+1 through the mock provider.
const current = await getCampaignRuntimeState(pool, campaignId);
const accepted = await snapshotTurnRows(pool, ownerUserId, campaignId);
await rebuildCampaignMemories(pool, campaignId);
expect(continuityValue(await getCampaignRuntimeState(pool, campaignId)))
  .toEqual(continuityValue(current));
expect(await snapshotTurnRows(pool, ownerUserId, campaignId)).toEqual(accepted);
~~~

Import existing helpers from tests/helpers/memory-aware-services.ts and turn-row-snapshot.ts. Use the Task 1 fixture and existing generation test setup to define pool/campaignId/ownerUserId in each case.

- [ ] Add RED cases for two corrections at N; removal of an earlier-turn fact; N+1 superseding a manual fact; empty summary/threads/facts; turn-zero correction; historical cutoff preview; explicit replacement with base N-1; failure of that replacement; and rebuild after a successful later turn. Verify prompt/context meaning as well as runtime GET.
- [ ] Run the replay integration file and the original generation/immutability suites. RED must expose chronological replay mismatch, not just a row-ID difference intentionally allowed for full rebuilds.
- [ ] Refactor rebuild order as an explicit timeline:

~~~text
load accepted turns and edits in owner/campaign/world-version scope
lock campaign/state using the same lock order as state saves and turn commits
project turn-zero edits in revision order
for each accepted turn in increasing turn_number:
  project accepted fiction and derived state at that turn
  project edits whose effective_turn_number equals that turn, in revision order
finish with the effective latest summary/threads/facts
~~~

Load rows after acquiring locks, not before. The maintenance rebuild can reset derived data, but cannot modify accepted turns or edit records. Do not invoke the current-only PATCH command to replay historical corrections; its write guard must remain intact.

- [ ] Separate "this snapshot supplies no override" from "this snapshot explicitly clears the collection" in both replay and runtime reads. Preserve historical summaries or project them on demand for throughTurnNumber reads; an edit at N must not erase the context available at N-1.
- [ ] Reuse grouped fact reconciliation from Task 2 in replay. Never treat a complete correction fact collection at N as a replacement of facts newly established at N+1. Retired validity intervals and manual supersession references must survive the next acceptance and rebuild.
- [ ] Add branch/rewind tests before and at the correction turn. The source's snapshots/edits remain identical. The destination gets only applicable history, independently scoped derived parents/jobs, and editable current state. A historical state can be edited only after an explicit branch/rewind makes it current.
- [ ] Add export/import and cross-world transfer tests for a corrected campaign. Follow existing identity remapping contracts. When destination IDs change, translate fact IDs in copied correction snapshots and replay references consistently; preserve source accepted JSON. Use a derived source-to-destination reference map for accepted snapshot references rather than rewriting the source ledger.
- [ ] Test System Archive round trips and rebuild after import, preserving credential redaction/non-mutation behavior. Do not add derived vectors or provider secrets to exports. No new archive schema version is needed unless the implemented storage contract actually changes.
- [ ] Keep replacement generation's separate historical cutoff and user confirmation semantics. This feature must neither auto-replace N nor inject an N correction into a replacement of N with base N-1. Document any pre-existing replacement behavior left unchanged; do not silently broaden scope to the older July replacement design.
- [ ] Run replay plus generation, transfer, campaign archive, System Archive, and Chronicle immutability integration suites through vitest.integration.config.ts, one file per invocation where the isolated harness requires it. Re-run Task 2/3 incremental suites to prove maintenance changes did not restore broad save-time rebuilding.
- [ ] Commit: "Replay state corrections in chronological order across campaign lifecycles".

**Done:** The live and rebuilt campaign agree after future turns and transfers; source histories stay immutable; current-only enforcement survives every lifecycle path.

## Task 9: Verify all surfaces, measure incremental work, and document operation

**Files**

- Create: tests/e2e/current-state-corrections.e2e.test.ts.
- Reuse/extend: tests/fixtures/current-state-corrections.ts from Task 5 for synthetic browser state.
- Modify: docs/player-guide/campaign-continuity.md, docs/workflows/story-interface-smoke-test.md.
- Modify: docs/operations/recovery/chronicle-indexing.md.
- Modify: docs/architecture/0011-editable-campaign-runtime-state.md with a dated amendment linking this spec and the implemented semantics.
- Create: docs/review/current-state-corrections-verification.md.
- Modify: the task-owned implementation/tests only to fix concrete acceptance findings, coordinating with their owners.
- Review: scripts/check-repository-data.mjs fixture allowlist before adding browser fixtures.

**Interfaces**

- Consumes all completed tasks; no new production API.
- Uses existing Playwright legacy/new Vite servers on 43173/43174.
- Keeps mocked-browser evidence distinct from real PostgreSQL/provider integration and a live integrated smoke run.

- [ ] Create a Playwright API fixture with the complete response shapes from the existing Story/Campaign unit fixtures. Use synthetic records only. Implement GET current state, GET historical inspected state, PATCH state with revision/turn conflicts, campaign sync, and supporting campaign/provider routes needed to mount each surface. Reject unexpected mutation requests in the fixture.
- [ ] Add the same browser behavior cases for all three entries:

~~~ts
const surfaces = [
  { name: "legacy Story", origin: "http://127.0.0.1:43173", kind: "legacy" },
  { name: "new Story", origin: "http://127.0.0.1:43174", kind: "story" },
  { name: "new Campaign State", origin: "http://127.0.0.1:43174", kind: "campaign" },
] as const;
~~~

Use the real route helpers for Story and campaign routes and a small switch in the test to open each editor through its visible button/link. Give all fields accessible labels so the shared assertions use getByLabel("Continuity summary"), getByLabel("Private scratchpad"), and labeled fact/thread rows rather than CSS-only selectors.

- [ ] Exercise all four field edits, Add/Remove, multiline facts, IDs retained in intercepted PATCH, empty clears, cancel/Escape, unsaved-change confirmation, loading/active-generation exclusion, 400/409/network failure with draft retention, duplicate-click exclusion, reload after conflict, a second tab's newer revision, campaign switch during an in-flight request, and history inspection remaining read-only.
- [ ] Assert no accepted-turn mutation or generation request was issued by clicking Save. Reload each surface from the saved API state and verify the visible content.
- [ ] Capture desktop 1440x1000 and mobile 390x844 screenshots for each surface, including a dirty/error state. Inspect them for wrapping, focus visibility, row/remove labels, dialog scrolling, and absence of raw JSON/IDs for the four fields.
- [ ] Run:

~~~powershell
pnpm exec playwright test tests/e2e/current-state-corrections.e2e.test.ts
pnpm check
pnpm test:unit
pnpm test:integration
pnpm build
git diff --check
~~~

Install the repository's Playwright browser runtime through its documented setup if missing; do not substitute a static source test for the browser run. Keep every skipped or blocked check explicit in the verification report.

- [ ] Add an incremental-work assertion to the Task 2/3 integration suite using synthetic small and long campaigns. For a scratchpad-only save assert zero memory mutations and zero embedding documents. For a single fact-group correction assert no turn_fiction parent/chunk/vector change and provider inputs limited to affected group documents. Record SQL statement count, save latency, affected parent/chunk counts, and embedding document/token counts; do not require a fabricated universal millisecond target.
- [ ] Explain the performance limit honestly: signature/eligibility queries may scan the campaign, and a changed grouped-fact document may contain multiple facts. The guarantee is no full projection replay or unaffected embedding work on ordinary saves, not constant-time SQL or one vector per changed fact.
- [ ] Run an integrated smoke check against an isolated application/test database with mock text/embedding endpoints: edit from each UI, generate N+1, inspect the actual provider request and saved state, restart/rebuild Chronicle, and reopen both UIs. Never point this exercise at private production campaigns. Preserve screenshots and content-free evidence references in the verification report.
- [ ] Amend user docs with the current-only rule, private scratchpad handling, fact-row behavior, background indexing/fallback, conflict recovery, and what happens when a correction is too large for the configured generation context. Amend recovery docs to reserve full rebuilds for maintenance and explain chronological replay.
- [ ] Amend ADR 0011 to replace its obsolete read-only summary/facts/threads description and separate the correction ledger from derived memory. Link the new spec and record that history inspection stays read-only.
- [ ] Review the entire cumulative diff and compare acceptance evidence against the checklist below. Run Repowise update only if an index exists and refreshed context is needed; do not initialize a missing index or include generated wiki metadata in the change.
- [ ] Commit: "Verify and document current state corrections across web interfaces".

**Done:** Both UIs and all backend invariants have executed evidence, the rollout/rollback notes are accurate, and no required test is mislabeled passed.

## Release and rollback

- Deploy the API/worker and both built UIs from the same tested commit. During a rolling transition, old clients can still save current state; historical-target writes receive a conflict. Schedule the cutover so new mandatory correction context is handled by matching API/worker versions.
- Existing state edits and valid memories need no global backfill. The first edit can adopt existing affected parent metadata; it must not rebuild unrelated history.
- Integration evidence requires additive migration `0082_turn_zero_state_correction_facts.sql` to allow manual canonical facts at editable turn zero. Apply it before enabling those writes; retain its relaxed checks during application rollback. No backfill, new secret, endpoint, provider role, or archive version is needed. The story prompt protocol changes explicitly.
- Save correction authority and derived work in one transaction. A provider outage affects indexing status only; a database failure returns a failed save and retains the user's draft.
- Do not blindly roll back to the pre-feature application: that would restore historical-write access and broad rebuild behavior. Prefer a forward fix, or deploy a rollback build retaining Task 1's server guard and the compatible correction reader. Retained current-state snapshots remain recoverable.
- A last-resort feature rollback may make the four fields read-only while preserving all saved corrections and read paths. Do not delete edit rows, turn snapshots, vectors, or credentials to roll back.
- Full maintenance replay remains available after a verified fix; it is not a routine step after each save.

## Final acceptance checklist

- [ ] Legacy Story, new Story, and new Campaign State all edit the same four fields.
- [ ] Fact rows retain IDs; multiline facts remain one record; new facts receive IDs only from the server.
- [ ] A direct historical PATCH fails with no mutation, including stale multi-tab requests.
- [ ] Accepted turn rows/private snapshots remain identical after all state edits.
- [ ] Failed/no-op saves leave authority, projections, chains, and jobs unchanged.
- [ ] Scratchpad-only changes enqueue zero memory work.
- [ ] A fact/summary/thread correction invalidates only affected parents/chunks.
- [ ] Legacy and chunked embedding paths reuse unrelated compatible vectors.
- [ ] Removed/superseded content is ineligible immediately; stale workers cannot restore it.
- [ ] Next-turn provider input contains the current correction before background indexing completes.
- [ ] Explicit empties override older values; corrected state wins over conflicting historical narration.
- [ ] Mandatory correction context cannot be silently evicted; overflow is actionable and non-mutating.
- [ ] Scratchpad is absent from embeddings, illustrations, public events, and routine logs.
- [ ] N correction, N+1 acceptance, and later rebuild produce equivalent effective state.
- [ ] Branch/rewind/transfer/import/export preserve scoped corrections and leave sources unchanged.
- [ ] Replacement generation respects its separate historical base cutoff.
- [ ] Dirty drafts survive sync/polling/errors and cannot leak across campaigns/editor sessions.
- [ ] Desktop/mobile screenshots and executed unit/PostgreSQL/provider/browser results are recorded.
- [ ] Full checks/build/diff review are complete; unrun checks remain explicit release blockers.

## Handoff packet for each subagent

~~~text
Task: [the exact numbered task title from this document]
Read: this specification, shared interfaces, and the complete assigned task
Prerequisites: coordinator supplies the actual landed commit IDs
Allowed files: assigned task's ownership list; request coordination before expanding it
Deliver: scoped implementation, RED/GREEN evidence, regression results, scoped commit
Report: changed files, test commands/counts, skipped checks, interface changes, remaining risks
Do not: alter another worker's files, change main, publish, or claim unexecuted verification
~~~

The bracketed dispatch fields are supplied by the coordinator at execution time; they are not unresolved feature decisions. All behavioral decisions and task dependencies are defined above.

## Planning verification

This plan was checked against the accompanying specification, current source paths, package scripts, integration isolation config, and Playwright server config. Planning did not execute implementation tests or make application changes. Execution must begin with the baseline/setup checks above.
