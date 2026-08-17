# Chronicle Turn Retrieval Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Record a versioned, privacy-safe Chronicle retrieval audit with every newly accepted turn, expose historical turns without trustworthy audit evidence as `null`/Unknown, and show whether generation used chunked or legacy retrieval, a dedicated embedding provider or the text-role fallback, a live embedding call or the query cache, and any complete lexical fallback.

**Architecture:** Keep `MemoryGenerationTransactionPort.buildContextPreview(database, scope)` as the sole generation retrieval seam. Preserve safe embedding-provider resolution provenance through the runtime/database port, build one typed audit from the actual production execution after all fallback decisions, validate and store it in existing `turns.model_metadata.chronicleRetrieval` during the accepted-turn transaction, and project it through typed APIs. Do not migrate or infer historical values: absent, malformed, and portability-imported audit data projects as `chronicleRetrieval: null`, which clients render as Unknown.

**Tech Stack:** TypeScript 7, Node.js 22+, PostgreSQL 18, Zod, Vitest, existing Chronicle legacy/chunked retrieval implementations, existing vanilla JavaScript story client, and replacement TypeScript Campaign Editor.

## Global Constraints

## Delivery Status

Tasks 1 through 7 are complete and their task evidence is recorded in the
companion SDD reports. Task 8 remains a controller-owned final matrix: the
focused final-review repair evidence is appended to `task-8-report.md`, while
the complete unit suite, full PostgreSQL suite, evaluator matrix, and final
long-campaign review remain intentionally unchecked here until that controller
verification is complete.

- Existing accepted `turns` rows are immutable. Do not backfill, update, delete, or synthesize audit metadata for an existing turn.
- Use the existing `turns.model_metadata` JSONB column. This feature adds no migration, turn column, trigger, or audit backfill.
- A missing or invalid stored audit projects as `null`. UI copy for `null` is `Unknown — this turn predates retrieval auditing or came from an import without audit metadata.`
- A known lexical-only execution is never represented by `null`; it stores a complete audit with `effectiveMode: "lexical_only"` and its sanitized fallback code.
- Record only the production execution. Shadow comparisons remain optional, retention-bound operational telemetry and never become accepted-turn authority.
- Keep configured and effective retrieval separate. Configured `chunked_hybrid` may execute effective `legacy_hybrid` after readiness or provider failure.
- Keep retrieval mode, provider resolution, provider-call outcome, and query-cache use as separate axes. A cache hit can support semantic retrieval without a live provider call.
- The only cross-role embedding resolution is the existing explicit `text_fallback`; never imply that the narration request and embedding request were the same provider call.
- Store no endpoint, credential, raw action/query/narration, provider response, raw error, candidate ID, or memory content in the audit.
- Store no provider profile ID or fingerprint in the turn audit or public projection. `resolutionSource`, `resolvedRole`, `providerType`, and `model` are sufficient for the stated audit purpose and remain meaningful after profile deletion.
- Continue complete legacy fallback whenever optional semantic/chunk retrieval fails. Audit logging is best-effort; an internal schema/invariant violation fails before turn insertion rather than committing unaudited or malformed metadata.
- New generation commits validate the audit before inserting the turn. Direct repository callers cannot write malformed audit objects for new accepted turns.
- Corrections do not rewrite the original audit. Branch/transfer copies preserve an existing audit exactly; absence remains absence. Replacement creates a new turn with a newly observed audit.
- Portable exports keep Chronicle retrieval audit metadata local by default. Imported portable turns therefore project as Unknown unless a separately approved export contract is introduced.
- Update both supported turn-information surfaces: legacy Story history under `/story` and replacement Campaign History under `/app/`. Do not edit root `index.html`.
- `/nexus/` does not render turn history and receives no audit UI; its Chronicle configuration/health controls remain unchanged.
- Perform UI and UI-test changes only after contracts, provider provenance, retrieval execution, persistence, API projection, lifecycle behavior, and documentation are complete.
- Use strict TDD: capture the focused RED for each task, implement the smallest coherent change, rerun GREEN, review, and commit only the task-owned paths.
- PostgreSQL evidence counts only when `TEST_DATABASE_URL` is set and output shows executed tests rather than skips.

## Resolved Audit Contract

`chronicleRetrieval` is a required nullable field in turn and generation-result API projections. `null` means execution provenance is not trustworthy or was never recorded. A non-null value has this exact v1 shape:

```ts
type ChronicleRetrievalAuditV1 = Readonly<{
  auditVersion: "chronicle-retrieval-audit-v1";
  configuredImplementation: "legacy_hybrid" | "chunked_hybrid";
  effectiveImplementation: "legacy_hybrid" | "chunked_hybrid";
  effectiveMode: "semantic_hybrid" | "lexical_only";
  fallbackCode:
    | "empty_query"
    | "semantic_not_configured"
    | "provider_unavailable"
    | "semantic_retrieval_unavailable"
    | "chunk_index_not_ready"
    | "incompatible_chunk_embeddings"
    | null;
  provider:
    | Readonly<{
        resolutionSource: "none";
        resolvedRole: null;
        providerType: null;
        model: null;
      }>
    | Readonly<{
        resolutionSource: "dedicated_embedding";
        resolvedRole: "embedding";
        providerType: string;
        model: string;
      }>
    | Readonly<{
        resolutionSource: "text_fallback";
        resolvedRole: "text";
        providerType: string;
        model: string;
      }>;
  queryVectorPath: "none" | "cache_only" | "provider_only" | "cache_and_provider";
  providerCallOutcome: "not_attempted" | "succeeded" | "failed" | "mixed";
  queryEmbeddingRequests: number;
  queryCacheHits: number;
  queryCacheMisses: number;
}>;
```

The schema enforces these invariants:

- `provider.resolutionSource === "none"` requires `queryVectorPath === "none"`, `providerCallOutcome === "not_attempted"`, and zero requests/cache hits.
- `queryVectorPath` is derived from requests and cache hits: neither is `none`, hits only is `cache_only`, requests only is `provider_only`, and both is `cache_and_provider`.
- `providerCallOutcome === "not_attempted"` requires zero requests; every other outcome requires at least one request.
- `providerCallOutcome === "failed"` requires `effectiveMode === "lexical_only"`; `mixed` permits a later successful semantic fallback.
- `effectiveMode === "semantic_hybrid"` requires a resolved provider and either a successful/mixed provider call or at least one cache hit.
- Historical uncertainty is represented outside the object as `null`; the object never has an `unknown` provider or implementation value.

## File and Module Map

- `packages/contracts/src/memory.ts`: canonical Zod audit contract, nullable stored-value parser, and exported TypeScript types.
- `packages/application/src/memory/types.ts`: generation-facing context preview requires a typed `chronicleRetrieval` field.
- `packages/database/src/chronicle-retrieval-audit.ts`: pure trace merge, query-vector-path derivation, and final audit builder.
- `packages/database/src/chronicle-repository.ts`: safe neutral embedding-resolution result returned by the Chronicle transaction port.
- `services/runtime/src/chronicle-platform-adapter.ts`: runtime port carries the complete neutral resolution rather than an ID.
- `services/runtime/src/chronicle-platform-bindings.ts`: maps application `EmbeddingProviderResolution` into the neutral Chronicle resolution without credentials.
- `packages/database/src/chronicle-context-repository.ts`: records only production execution trace and returns the final audit beside existing retrieval diagnostics.
- `services/runtime/src/generation-executor-adapter.ts`: validates the typed context result, passes audit to accepted commit, and emits safe completion log fields.
- `packages/database/src/generation-execution-repository.ts`: validates and atomically stores `model_metadata.chronicleRetrieval` for new accepted turns.
- `packages/database/src/play-loop-read-repository.ts`: safely parses stored audit metadata and returns `null` for absent/malformed historical values.
- `packages/database/src/generation-repository.ts`: projects the same audit on the immediate completed-generation result.
- `packages/contracts/src/client-api.ts`: makes `chronicleRetrieval` required and nullable on `TurnSummary` and `GenerationResult`.
- `packages/client-core/src/generation/projection.ts`: retains the audit when an accepted turn is first created from a generation result.
- `packages/client-core/src/chronicle-retrieval-audit.ts`: shared presentation-neutral audit label/detail formatter.
- `apps/web/src/story.js`: legacy Story history displays the audit.
- `apps/web-next/src/campaign-editor-page.ts`: replacement Campaign History displays the same audit semantics.
- `docs/architecture/0029-chronicle-turn-retrieval-audit.md`: decision, compatibility, privacy, lifecycle, and rollback record.

---

### Task 1: Freeze the versioned audit contract and historical-null rule

**Files:**
- Create: `docs/architecture/0029-chronicle-turn-retrieval-audit.md`
- Create: `tests/fixtures/chronicle-retrieval-audits.ts`
- Create: `tests/unit/chronicle-retrieval-audit-contract.test.ts`
- Modify: `packages/contracts/src/memory.ts:6-78,165-181`
- Modify: `packages/application/src/memory/types.ts:1-65`

**Interfaces:**
- Produces `chronicleRetrievalAuditSchema` and `ChronicleRetrievalAudit`.
- Produces `parseStoredChronicleRetrievalAudit(value: unknown): ChronicleRetrievalAudit | null`.
- Produces `ChronicleContextPreview = Readonly<Record<string, unknown> & { chronicleRetrieval: ChronicleRetrievalAudit }>`.
- Produces shared valid fixtures `DEDICATED_CHUNKED_AUDIT`, `TEXT_FALLBACK_LEGACY_AUDIT`, and `LEXICAL_NO_PROVIDER_AUDIT`.

- [x] **Step 1: Write failing contract tests**

Add tests that parse the three valid fixtures and reject every contradictory state:

```ts
expect(chronicleRetrievalAuditSchema.parse(DEDICATED_CHUNKED_AUDIT)).toEqual(DEDICATED_CHUNKED_AUDIT);
expect(parseStoredChronicleRetrievalAudit(undefined)).toBeNull();
expect(parseStoredChronicleRetrievalAudit({ auditVersion: "old" })).toBeNull();

expect(() => chronicleRetrievalAuditSchema.parse({
  ...DEDICATED_CHUNKED_AUDIT,
  queryVectorPath: "cache_only",
  queryEmbeddingRequests: 1,
  queryCacheHits: 0
})).toThrow();

expect(() => chronicleRetrievalAuditSchema.parse({
  ...LEXICAL_NO_PROVIDER_AUDIT,
  effectiveMode: "semantic_hybrid"
})).toThrow();
```

Also assert with a type-level assignment that `ChronicleContextPreview["chronicleRetrieval"]` is not optional.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/chronicle-retrieval-audit-contract.test.ts
```

Expected: FAIL because the audit schema, parser, type, and fixtures do not exist.

- [x] **Step 3: Implement the closed schema and compatibility parser**

Add the three provider variants and the v1 schema to `memory.ts`. Use bounded safe provider/model strings and the six closed fallback codes. Implement the compatibility parser exactly as a non-throwing stored-data boundary:

```ts
export function parseStoredChronicleRetrievalAudit(value: unknown): ChronicleRetrievalAudit | null {
  const parsed = chronicleRetrievalAuditSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
```

Implement `superRefine` using the invariant list in **Resolved Audit Contract**; do not coerce malformed historical data into an observed audit. Export the inferred types and update `ChronicleContextPreview` to require `chronicleRetrieval` while retaining the other preview fields as the existing record.

- [x] **Step 4: Write the ADR**

Record these decisions in `0029`:

1. Existing `model_metadata` is the accepted-turn authority; no migration/backfill.
2. Missing/malformed/imported audit is `null` and UI Unknown.
3. The audit records the actual production path only.
4. No profile ID, fingerprint, endpoint, credentials, raw input, memory content, or raw error is stored.
5. Operational shadow telemetry remains separate and expiring.
6. Corrections preserve, branch/transfer copy, replacement observes anew, and portable export omits the audit.
7. Rollback removes the write/read/UI projection only; existing JSONB keys are harmless and need not be deleted.

- [x] **Step 5: Rerun focused tests and verify GREEN**

Run the Step 2 command and:

```powershell
pnpm --filter @infinite-quest/contracts check
pnpm --filter @infinite-quest/application check
```

Expected: all audit contract tests and both package checks pass.

- [x] **Step 6: Commit**

```powershell
git add docs/architecture/0029-chronicle-turn-retrieval-audit.md packages/contracts/src/memory.ts packages/application/src/memory/types.ts tests/fixtures/chronicle-retrieval-audits.ts tests/unit/chronicle-retrieval-audit-contract.test.ts
git commit -m "Define Chronicle turn retrieval audit"
```

---

### Task 2: Preserve dedicated-versus-text provider provenance through Chronicle

**Files:**
- Modify: `packages/database/src/chronicle-repository.ts:95-151`
- Modify: `services/runtime/src/chronicle-platform-adapter.ts:23-113`
- Modify: `services/runtime/src/chronicle-platform-bindings.ts:13-50`
- Modify: `tests/unit/chronicle-runtime-adapter.test.ts:339-430,535-570`
- Modify: `tests/integration/provider-postgres-adapters.integration.test.ts:146-186`

**Interfaces:**
- Produces `ChronicleTransactionEmbeddingResolution`, a neutral structural equivalent of the safe application resolution.
- Changes `ChronicleTransactionEmbeddingPort.resolve(...): Promise<ChronicleTransactionEmbeddingResolution>`.
- Changes runtime dependency `resolveEmbeddingProviderId` to `resolveEmbeddingProvider` with the same neutral return type.

- [x] **Step 1: Write failing adapter tests for all resolution sources**

Exercise `createChroniclePlatformBindings(...).embeddings.resolve` for:

```ts
expect(await port.resolve(database, scope)).toEqual({
  status: "resolved",
  resolutionSource: "dedicated_embedding",
  resolvedRole: "embedding",
  providerProfileId: "embedding-profile",
  providerType: "openrouter",
  model: "embed-model"
});
```

Repeat for `text_fallback`/`resolvedRole: "text"` and for the exact unconfigured result:

```ts
{
  status: "unconfigured",
  resolutionSource: "none",
  resolvedRole: null
}
```

Keep the existing PostgreSQL provider-resolution assertions proving the selected profile is owner-scoped and the text fallback is the only allowed cross-role resolution.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/chronicle-runtime-adapter.test.ts
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/provider-postgres-adapters.integration.test.ts
```

Expected: unit FAIL because Chronicle currently returns only a provider ID. The PostgreSQL command must execute against `TEST_DATABASE_URL`; stop if it skips.

- [x] **Step 3: Implement the neutral resolution port**

Add this union beside the embedding port:

```ts
export type ChronicleTransactionEmbeddingResolution =
  | Readonly<{
      status: "resolved";
      resolutionSource: "dedicated_embedding" | "text_fallback";
      resolvedRole: "embedding" | "text";
      providerProfileId: string;
      providerType: string;
      model: string;
    }>
  | Readonly<{
      status: "unconfigured";
      resolutionSource: "none";
      resolvedRole: null;
    }>;
```

Map application resolution fields explicitly in `chronicle-platform-bindings.ts`; do not spread an application/provider object because future private fields must not cross the seam. `loadEmbeddingExecution` continues re-resolving and validating the selected ID before loading credentials.

- [x] **Step 4: Rerun focused tests and checks**

Run both Step 2 commands plus:

```powershell
pnpm check
```

Expected: all focused cases execute and pass; repository boundary checks remain green.

- [x] **Step 5: Commit**

```powershell
git add packages/database/src/chronicle-repository.ts services/runtime/src/chronicle-platform-adapter.ts services/runtime/src/chronicle-platform-bindings.ts tests/unit/chronicle-runtime-adapter.test.ts tests/integration/provider-postgres-adapters.integration.test.ts
git commit -m "Preserve Chronicle embedding provider provenance"
```

---

### Task 3: Build the audit from the actual production retrieval execution

**Files:**
- Create: `packages/database/src/chronicle-retrieval-audit.ts`
- Create: `tests/unit/chronicle-retrieval-audit-builder.test.ts`
- Modify: `packages/database/src/chronicle-context-repository.ts:134-167,538-714,758-784,1061-1260,1389-1412,1497-1733,1962-1992`
- Modify: `tests/integration/chronicle-chunk-retrieval.integration.test.ts`
- Modify: `tests/integration/chronicle-query-cache.integration.test.ts`
- Modify: `tests/integration/chronicle-retrieval-observability.integration.test.ts`
- Modify: `tests/unit/chronicle-transaction-repository.test.ts`

**Interfaces:**
- Produces `ChronicleRetrievalAuditTrace` with provider, request/cache counts, and provider-call outcome.
- Produces `mergeChronicleRetrievalAuditTraces(left, right)` for complete chunk-to-legacy fallback.
- Produces `buildChronicleRetrievalAudit(input): ChronicleRetrievalAudit`.
- `buildPostgresChronicleContextPreview` returns both existing `retrieval` diagnostics and new typed `chronicleRetrieval`.

- [x] **Step 1: Write failing pure builder tests**

Cover exact derivation:

```ts
expect(buildChronicleRetrievalAudit({
  configuredImplementation: "chunked_hybrid",
  effectiveImplementation: "legacy_hybrid",
  semanticUsed: true,
  fallbackCode: "chunk_index_not_ready",
  trace: {
    provider: { resolutionSource: "text_fallback", resolvedRole: "text", providerType: "openrouter", model: "embed-model" },
    providerCallOutcome: "succeeded",
    queryEmbeddingRequests: 1,
    queryCacheHits: 0,
    queryCacheMisses: 1
  }
})).toMatchObject({
  effectiveImplementation: "legacy_hybrid",
  effectiveMode: "semantic_hybrid",
  queryVectorPath: "provider_only"
});
```

Also prove cache-only, mixed cache/provider, failed text fallback to lexical, unconfigured semantics, and a merged trace whose first attempt failed and second succeeded yields `providerCallOutcome: "mixed"`.

- [x] **Step 2: Run the builder test and verify RED**

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/chronicle-retrieval-audit-builder.test.ts
```

Expected: FAIL because the builder module does not exist.

- [x] **Step 3: Implement the pure builder and merge rules**

Derive `queryVectorPath` only from request/cache counts:

```ts
function queryVectorPath(requests: number, cacheHits: number) {
  if (requests > 0 && cacheHits > 0) return "cache_and_provider" as const;
  if (requests > 0) return "provider_only" as const;
  if (cacheHits > 0) return "cache_only" as const;
  return "none" as const;
}
```

Merge counts by addition. Merge provider-call outcomes with this closed table: identical outcomes stay identical; `not_attempted` yields to the other outcome; any `succeeded`+`failed` or existing `mixed` becomes `mixed`. If both traces contain resolved provider values, require identical source, role, type, and model or throw an internal invariant error before turn generation.

Return `chronicleRetrievalAuditSchema.parse(...)` from the builder so production construction and stored/API validation use one contract.

- [x] **Step 4: Write failing PostgreSQL production-path tests**

Extend real-PostgreSQL retrieval coverage with these assertions on `preview.chronicleRetrieval`:

1. Ready chunks + dedicated embedding + provider request -> chunked semantic/dedicated/provider-only.
2. Ready chunks + text-role resolution -> chunked semantic/text-fallback.
3. Second identical query -> semantic with cache-only and zero requests.
4. Configured chunked + index not ready -> effective legacy semantic with `chunk_index_not_ready`.
5. Configured chunked + embedding request failure -> effective legacy lexical, resolved provider retained, failed call retained, `semantic_retrieval_unavailable`.
6. Semantic disabled/unconfigured -> effective legacy lexical, provider source none, `semantic_not_configured`.
7. Incompatible chunks -> complete effective legacy execution, not a falsely reported chunked execution.
8. Shadow execution results do not alter the production audit.

For the failure case, keep the existing assertion that no chunk-rank SQL contributes to the selected prompt and that the legacy scopes/budget remain exact.

- [x] **Step 5: Run the focused PostgreSQL tests and verify RED**

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts tests/integration/chronicle-query-cache.integration.test.ts tests/integration/chronicle-retrieval-observability.integration.test.ts
```

Expected: FAIL because the preview has no `chronicleRetrieval` and provider provenance is not carried into execution.

- [x] **Step 6: Thread trace data through legacy, chunked, and fallback executions**

Refactor internal result types so each production execution owns:

```ts
type RetrievalExecution = Readonly<{
  implementation: ChronicleRetrievalComparison["implementation"];
  effectiveImplementation: RetrievalImplementation;
  auditTrace: ChronicleRetrievalAuditTrace;
  // existing memories/retrieval/latency/telemetry fields remain
}>;
```

Specific behavior:

- Legacy resolution stores the neutral resolution before provider load/embed, so a later failure still identifies dedicated versus text fallback.
- `queryEmbeddingRequests` increments immediately before a live `embed` call; outcome becomes `succeeded` only after a complete usable response and `failed` on the caught call path.
- Cache hits/misses remain exact counts for query variants.
- Split `resolveChunkEmbeddingIdentity` into resolution followed by identity loading so load/fingerprint failures retain the resolved provider provenance.
- Chunked-to-legacy fallback merges the chunk attempt trace with the complete legacy trace and sets `effectiveImplementation: "legacy_hybrid"`.
- Successful chunk rank fusion sets `effectiveImplementation: "chunked_hybrid"`.
- The outer production savepoint catch creates an honest lexical audit with whatever resolution/call trace is known; it never fabricates a provider.
- Build the audit from `productionExecution` only and return it as top-level `chronicleRetrieval`; retain the existing raw `retrieval` object for compatibility and evaluator diagnostics.

- [x] **Step 7: Rerun focused unit/PostgreSQL tests and verify GREEN**

Run Steps 2 and 5 plus:

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/chronicle-transaction-repository.test.ts
pnpm --filter @infinite-quest/contracts check
pnpm --filter @infinite-quest/application check
pnpm exec tsc --noEmit
```

Expected: all focused tests execute and pass; existing retrieval results, selected memory IDs, budgets, and telemetry privacy assertions remain unchanged.

- [x] **Step 8: Commit**

```powershell
git add packages/database/src/chronicle-retrieval-audit.ts packages/database/src/chronicle-context-repository.ts tests/unit/chronicle-retrieval-audit-builder.test.ts tests/unit/chronicle-transaction-repository.test.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts tests/integration/chronicle-query-cache.integration.test.ts tests/integration/chronicle-retrieval-observability.integration.test.ts
git commit -m "Audit effective Chronicle retrieval"
```

---

### Task 4: Persist validated audit metadata atomically with new accepted turns

**Files:**
- Modify: `services/runtime/src/generation-executor-adapter.ts:74-90,620-642,754-776,967-987,1301-1339`
- Modify: `packages/database/src/generation-execution-repository.ts:172-185,294-445`
- Modify: `tests/unit/generation-executor-adapter.test.ts`
- Modify: `tests/integration/generation-execution-repository.integration.test.ts`
- Modify: `tests/integration/generation.integration.test.ts`

**Interfaces:**
- `GenerationContextPreview` requires `chronicleRetrieval: ChronicleRetrievalAudit`.
- `AcceptedGenerationCommit` requires `chronicleRetrieval: ChronicleRetrievalAudit` separately from opaque `contextDiagnostics`.
- New accepted turns store the parsed audit at `model_metadata.chronicleRetrieval`.

- [x] **Step 1: Write failing generation and commit tests**

Add unit proof that context retrieval audit is passed unchanged to `commitAcceptedTurn`. Add PostgreSQL cases that:

```ts
expect(stored.model_metadata.chronicleRetrieval).toEqual(DEDICATED_CHUNKED_AUDIT);
expect(stored.model_metadata.contextDiagnostics.retrieval).toEqual(existingRetrievalDiagnostics);
```

Pass a malformed audit through a direct test-only cast and assert `commitAcceptedTurn` rejects it before `INSERT INTO turns`. Snapshot all pre-existing turns, including `xmin`, and prove a later audited turn commit does not update any earlier turn.

- [x] **Step 2: Run focused tests and verify RED**

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/generation-executor-adapter.test.ts
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/generation-execution-repository.integration.test.ts tests/integration/generation.integration.test.ts
```

Expected: FAIL because the commit input and stored metadata lack the top-level audit.

- [x] **Step 3: Implement strict atomic persistence**

In the generation executor, keep raw retrieval diagnostics for compatibility but pass the typed audit separately:

```ts
const chronicleRetrieval = chronicleRetrievalAuditSchema.parse(context.chronicleRetrieval);
const contextDiagnostics = {
  // existing fields
  retrieval: context.retrieval
};

await repository.commitAcceptedTurn({
  // existing fields
  contextDiagnostics,
  chronicleRetrieval
});
```

At the start of `commitAcceptedTurn`, parse once:

```ts
const chronicleRetrieval = chronicleRetrievalAuditSchema.parse(input.chronicleRetrieval);
```

Store `chronicleRetrieval` as a top-level key in the existing model metadata JSONB. Do not catch validation failure and do not issue a follow-up update.

Add safe completion-log fields after commit:

```ts
chronicleRetrieval: {
  configuredImplementation: chronicleRetrieval.configuredImplementation,
  effectiveImplementation: chronicleRetrieval.effectiveImplementation,
  effectiveMode: chronicleRetrieval.effectiveMode,
  providerSource: chronicleRetrieval.provider.resolutionSource,
  providerType: chronicleRetrieval.provider.providerType,
  model: chronicleRetrieval.provider.model,
  queryVectorPath: chronicleRetrieval.queryVectorPath,
  providerCallOutcome: chronicleRetrieval.providerCallOutcome,
  fallbackCode: chronicleRetrieval.fallbackCode
}
```

Do not log provider profile IDs, fingerprints, queries, selected memory IDs, or raw errors in this new object.

- [x] **Step 4: Rerun focused tests and verify GREEN**

Run Step 2. Expected: all cases execute and pass, malformed audit prevents the new turn insert, rejected/incomplete generation still creates no turn, and earlier turn `xmin` values remain identical.

- [x] **Step 5: Commit**

```powershell
git add services/runtime/src/generation-executor-adapter.ts packages/database/src/generation-execution-repository.ts tests/unit/generation-executor-adapter.test.ts tests/integration/generation-execution-repository.integration.test.ts tests/integration/generation.integration.test.ts
git commit -m "Store Chronicle retrieval audit on turns"
```

---

### Task 5: Project recorded-or-unknown audit through turn and generation APIs

**Files:**
- Modify: `packages/contracts/src/client-api.ts:269-282,334-355,385-401`
- Modify: `packages/database/src/play-loop-read-repository.ts:11-25,86-122`
- Modify: `packages/database/src/generation-repository.ts:61-81,527-575`
- Modify: `services/api/src/server.ts:1017-1035`
- Modify: `packages/client-core/src/generation/projection.ts:54-68`
- Modify: `tests/unit/client-api-contracts.test.ts`
- Modify: `tests/unit/play-loop-read-repository.test.ts`
- Modify: `tests/unit/client-api-routes.test.ts`
- Modify: `tests/unit/client-core/campaign-store.test.ts`
- Modify: `tests/integration/gameplay.integration.test.ts`
- Modify: `tests/integration/turn-narration-corrections.integration.test.ts`

**Interfaces:**
- `TurnSummary.chronicleRetrieval: ChronicleRetrievalAudit | null` is required.
- `GenerationResult.chronicleRetrieval: ChronicleRetrievalAudit | null` is required.
- `turnFromGenerationResult` copies the audit, including `null`, into the immediate client turn.

- [x] **Step 1: Write failing contract and repository tests**

Test all three storage states:

1. Valid `model_metadata.chronicleRetrieval` returns the exact audit.
2. Historical row with no key returns `chronicleRetrieval: null`.
3. Malformed historical/imported value returns `chronicleRetrieval: null` without failing the page.

The API schema must require the field rather than make it optional:

```ts
expect(() => turnSummarySchema.parse({ ...turnWithoutAuditField })).toThrow();
expect(turnSummarySchema.parse({ ...turnWithoutAuditField, chronicleRetrieval: null }).chronicleRetrieval).toBeNull();
```

Add the same recorded/null cases to completed generation result tests and assert `turnFromGenerationResult` preserves the audit before the next history sync.

- [x] **Step 2: Run focused tests and verify RED**

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/client-api-contracts.test.ts tests/unit/play-loop-read-repository.test.ts tests/unit/client-api-routes.test.ts tests/unit/client-core/campaign-store.test.ts
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/gameplay.integration.test.ts tests/integration/turn-narration-corrections.integration.test.ts
```

Expected: FAIL because schemas, SQL projections, and immediate result projection do not contain the new field.

- [x] **Step 3: Implement safe database projections**

In the turn-page SQL, select only the nested audit value:

```sql
turn_row.model_metadata -> 'chronicleRetrieval' AS "storedChronicleRetrieval"
```

Map it before returning:

```ts
chronicleRetrieval: parseStoredChronicleRetrievalAudit(row.storedChronicleRetrieval)
```

Do not expose the full `model_metadata` from the bounded turn endpoint. Apply the same parser to `row.modelMetadata?.chronicleRetrieval` in `generation-repository.ts` and return a dedicated field beside the compatibility `modelMetadata` object.

- [x] **Step 4: Implement required nullable client contracts and immediate projection**

Add:

```ts
chronicleRetrieval: chronicleRetrievalAuditSchema.nullable()
```

to both `turnSummarySchema` and `generationResultSchema`. Update `turnFromGenerationResult`:

```ts
chronicleRetrieval: copyValue(result.chronicleRetrieval)
```

Update every test fixture constructing `TurnSummary` or `GenerationResult` to state either a valid audit or `null`; do not hide compatibility with `.optional()` or a schema default.

- [x] **Step 5: Rerun focused tests and verify GREEN**

Run Step 2 plus:

```powershell
pnpm --filter @infinite-quest/client-core check
pnpm --filter @infinite-quest/client-web check
pnpm check
```

Expected: recorded and unknown cases pass; narration corrections change only narration and leave the audit projection unchanged.

- [x] **Step 6: Commit**

```powershell
git add packages/contracts/src/client-api.ts packages/database/src/play-loop-read-repository.ts packages/database/src/generation-repository.ts services/api/src/server.ts packages/client-core/src/generation/projection.ts tests/unit/client-api-contracts.test.ts tests/unit/play-loop-read-repository.test.ts tests/unit/client-api-routes.test.ts tests/unit/client-core/campaign-store.test.ts tests/integration/gameplay.integration.test.ts tests/integration/turn-narration-corrections.integration.test.ts
git commit -m "Expose Chronicle retrieval audit on turn APIs"
```

---

### Task 6: Pin lifecycle, portability, documentation, and no-backfill behavior

**Files:**
- Modify: `tests/integration/campaign-authority-repository.integration.test.ts`
- Modify: `tests/integration/campaign-transfer-character-repository.integration.test.ts`
- Modify: `tests/integration/campaign-archive.integration.test.ts`
- Modify: `tests/unit/memory-inventory.test.ts`
- Modify: `docs/review/chronicle-retrieval-audit-future-enhancement.md`
- Modify: `docs/nexus-guide/chronicle/retrieval-modes.md`
- Modify: `docs/nexus-guide/chronicle/embeddings.md`
- Modify: `docs/architecture/index.md`

**Interfaces:**
- No new runtime interface.
- Freezes lifecycle semantics before UI implementation.

- [x] **Step 1: Write failing lifecycle and portability assertions**

Using a campaign with one historical null-audit turn and one recorded-audit turn, prove:

- Branch and same-owner world transfer copy the recorded audit byte-for-byte and preserve absent audit as `null` through the API.
- Rewind does not update any retained turn audit or `xmin`.
- Narration correction does not alter the original audit.
- Replacement deletes only the selected old turn under existing rules and the new replacement has a newly observed audit.
- Portable export still omits `chronicleRetrieval`, provider profile IDs, fingerprints, endpoints, and credentials.
- Re-import of that portable turn returns `chronicleRetrieval: null` rather than reconstructing a value from current campaign configuration.

- [x] **Step 2: Run focused PostgreSQL tests and verify RED**

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/campaign-authority-repository.integration.test.ts tests/integration/campaign-transfer-character-repository.integration.test.ts tests/integration/campaign-archive.integration.test.ts
```

Expected: new assertions fail until all fixtures and read projections use the nullable audit contract. No migration file is expected.

- [x] **Step 3: Make only lifecycle-compatible fixture/allowlist changes**

Do not add audit fields to `portableModelMetadata`; omission is intentional. Update internal branch/transfer fixtures only where required to prove existing full `model_metadata` copying. Do not add update/backfill SQL.

- [x] **Step 4: Update operator and architecture documentation**

Document this exact interpretation table:

| Stored/API state | Meaning |
| --- | --- |
| `chronicleRetrieval: null` | Unknown historical/imported provenance; do not infer |
| `effectiveMode: semantic_hybrid`, `resolutionSource: dedicated_embedding` | Dedicated embedding provider contributed semantic ranking |
| `effectiveMode: semantic_hybrid`, `resolutionSource: text_fallback` | Text-role provider was explicitly used through the embedding interface |
| configured chunked + effective legacy | Complete legacy fallback supplied the accepted prompt context |
| `effectiveMode: lexical_only` | No semantic rank contributed; inspect sanitized `fallbackCode` |
| cache-only | Semantic rank used cached query vectors; no live embedding call occurred |

Update the research note status to `Implementation in progress` and link ADR 0029 plus this plan. State that operational telemetry retention is not turn-history retention. Task 8 changes the status to `Implemented` only after backend, lifecycle, both UI surfaces, and final verification pass.

- [x] **Step 5: Rerun tests and docs contract**

Run Step 2 and:

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/memory-inventory.test.ts
git diff --check
```

Expected: lifecycle cases execute and pass; docs contract passes; no migration or turn-update statement exists.

- [x] **Step 6: Commit**

```powershell
git add tests/integration/campaign-authority-repository.integration.test.ts tests/integration/campaign-transfer-character-repository.integration.test.ts tests/integration/campaign-archive.integration.test.ts tests/unit/memory-inventory.test.ts docs/review/chronicle-retrieval-audit-future-enhancement.md docs/nexus-guide/chronicle/retrieval-modes.md docs/nexus-guide/chronicle/embeddings.md docs/architecture/index.md
git commit -m "Document Chronicle retrieval audit lifecycle"
```

---

### Task 7: Add audit information to both turn-history interfaces last

**Files:**
- Create: `packages/client-core/src/chronicle-retrieval-audit.ts`
- Modify: `packages/client-core/src/index.ts`
- Modify: `apps/web/src/story.js:1-25,2072-2132`
- Modify: `apps/web/public/story.css:249-260`
- Modify: `apps/web-next/package.json`
- Modify: `apps/web-next/src/campaign-editor-page.ts:1-25,115-118`
- Modify: `apps/web-next/src/styles.css`
- Create: `tests/unit/client-core/chronicle-retrieval-audit.test.ts`
- Modify: `tests/unit/story-player-ui.test.ts`
- Modify: `tests/unit/web-next-campaign-editor.test.ts`
- Modify: `tests/unit/web-build-contract.test.ts`

**Interfaces:**
- Produces `formatChronicleRetrievalAudit(audit: ChronicleRetrievalAudit | null): ChronicleRetrievalAuditPresentation`.
- Both UIs consume the same formatter and render the same semantic labels.

- [x] **Step 1: Write failing formatter tests**

The formatter returns plain text only:

```ts
type ChronicleRetrievalAuditPresentation = Readonly<{
  status: "recorded" | "unknown";
  searchPath: string;
  provider: string;
  queryVector: string;
  fallback: string | null;
}>;
```

Pin these outputs:

- Null -> Unknown compatibility copy from Global Constraints.
- Chunked semantic + dedicated -> `Chunked semantic retrieval` / `Dedicated embedding provider: <type> · <model>`.
- Chunked configured + legacy semantic + text fallback -> `Legacy semantic retrieval` / `Text-role provider used for embeddings: <type> · <model>` / `Fallback: chunk index not ready`.
- Legacy lexical after provider failure -> `Legacy lexical retrieval` / resolved provider label / `Fallback: embedding provider unavailable during retrieval`.
- Cache only -> `Query vector: cache (no live provider call)`.
- Mixed -> `Query vectors: cache and live provider call`.

- [x] **Step 2: Write failing behavior tests for both interfaces**

In legacy Story history and replacement Campaign History, render one recorded turn and one null-audit turn. Assert visible text and accessible structure (`<dl>` or labelled group), not source substrings. Provider/profile IDs and fingerprints must not appear. Add hostile provider/model strings and verify DOM text escaping.

- [x] **Step 3: Run focused UI tests and verify RED**

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/client-core/chronicle-retrieval-audit.test.ts tests/unit/story-player-ui.test.ts tests/unit/web-next-campaign-editor.test.ts tests/unit/web-build-contract.test.ts
```

Expected: FAIL because the shared formatter and UI audit blocks do not exist.

- [x] **Step 4: Implement the shared formatter**

Implement a closed fallback copy map for the six v1 codes. Never render raw fallback/provider strings as HTML. Export the formatter from `@infinite-quest/client-core`; add that workspace dependency explicitly to `apps/web-next/package.json`. The legacy web package already declares the dependency and must not receive a no-op package change.

- [x] **Step 5: Update the Legacy Story turn-history view**

Import `formatChronicleRetrievalAudit` into `apps/web/src/story.js`. Add a pure markup helper beside `populateHistoryContainer` and insert its output inside every `.history-card`, below the narration preview:

```js
function chronicleRetrievalHistoryMarkup(audit) {
  const presentation = formatChronicleRetrievalAudit(audit ?? null);
  const rows = [
    ["Search", presentation.searchPath],
    ["Provider", presentation.provider],
    ["Query vector", presentation.queryVector],
    ...(presentation.fallback ? [["Fallback", presentation.fallback]] : [])
  ];
  return `<dl class="turn-chronicle-audit" aria-label="Chronicle retrieval">
    ${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
  </dl>`;
}
```

Call `chronicleRetrievalHistoryMarkup(t.chronicleRetrieval)` for both recorded and null historical turns. `null` must visibly render the fixed Unknown compatibility copy; do not hide the audit block or infer values from current campaign settings. Style `.turn-chronicle-audit` in `apps/web/public/story.css` as secondary metadata, with wrapping values and no fixed width so it remains readable at 390px.

Extend `tests/unit/story-player-ui.test.ts` as an executed DOM behavior test: open the turn-history modal, assert the recorded and Unknown `<dl aria-label="Chronicle retrieval">` blocks, assert dedicated/text/legacy labels from the shared formatter, and prove hostile provider/model text is escaped rather than interpreted as markup.

- [x] **Step 6: Verify the Legacy Story history implementation independently**

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/client-core/chronicle-retrieval-audit.test.ts tests/unit/story-player-ui.test.ts
pnpm build:web:legacy
```

Render `/story`, open Turn History, and inspect recorded and null-audit cards at desktop and 390px. Expected: the audit is visible for every turn, Unknown is neutral rather than an error, cards remain keyboard-selectable, no provider/profile ID or fingerprint appears, there is no horizontal overflow, and the console has no errors.

- [x] **Step 7: Update the replacement Campaign History view**

Add the same shared formatter output inside each `turn-ledger` article in `apps/web-next/src/campaign-editor-page.ts`. Unknown remains visible and neutral; lexical fallback is visible but does not imply generation failed. Use `text(...)` for every formatter value, add responsive secondary-detail styles in `apps/web-next/src/styles.css`, and do not expose raw provider/profile identifiers or fingerprints.

Extend `tests/unit/web-next-campaign-editor.test.ts` with the same recorded/null/hostile-value behavior matrix used for Legacy Story.

- [x] **Step 8: Rerun both UI suites, builds, and rendered parity checks**

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/client-core/chronicle-retrieval-audit.test.ts tests/unit/story-player-ui.test.ts tests/unit/web-next-campaign-editor.test.ts tests/unit/web-build-contract.test.ts
pnpm check:web
pnpm build:web:legacy
pnpm build:web:next
```

Then render `/story` and `/app/` with sanitized recorded/null fixtures at desktop and 390px. Verify no horizontal overflow, no console errors, identical audit meaning, escaped hostile provider/model text, and root `index.html` unchanged.

- [x] **Step 9: Commit**

```powershell
git add packages/client-core/src/chronicle-retrieval-audit.ts packages/client-core/src/index.ts apps/web/src/story.js apps/web/public/story.css apps/web-next/package.json apps/web-next/src/campaign-editor-page.ts apps/web-next/src/styles.css tests/unit/client-core/chronicle-retrieval-audit.test.ts tests/unit/story-player-ui.test.ts tests/unit/web-next-campaign-editor.test.ts tests/unit/web-build-contract.test.ts
git commit -m "Show Chronicle retrieval audit on turns"
```

---

### Task 8: Run final regression, privacy, and long-campaign verification

**Files:**
- Modify: `docs/review/chronicle-retrieval-audit-future-enhancement.md`
- No planned production source changes. Any discovered defect returns to the owning task with a RED/GREEN fix and separate review.

**Interfaces:**
- Verifies the complete delivered contract.

- [ ] **Step 1: Run repository checks and the complete unit suite**

```powershell
pnpm check
pnpm test:unit
pnpm build
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 2: Run the isolated PostgreSQL suite**

```powershell
node scripts/run-isolated-integration.mjs
```

Expected: every discovered integration file completes with exit zero against real PostgreSQL. Platform capability skips must remain explicit and unrelated to Chronicle retrieval/audit cases; no audit case may skip.

- [ ] **Step 3: Re-run both production retrieval evaluators**

```powershell
pnpm evaluate:chronicle -- --implementation legacy_hybrid --output tmp/chronicle-evaluation/final-audit-legacy.json
pnpm evaluate:chronicle -- --implementation chunked_hybrid --output tmp/chronicle-evaluation/final-audit-chunked.json
```

Expected: rankings, leakage counts, and retrieval-quality gates remain within the checked-in profile/baseline contract. Audit construction must not change selected memories, prompt tokens, or fallback behavior.

- [ ] **Step 4: Verify long-campaign and provider-failure behavior explicitly**

Using the existing long-campaign retrieval fixture, assert:

1. Ready compatible chunks stay chunked semantic and report dedicated/text source accurately.
2. Query-cache reuse records cache-only without a provider request.
3. Embedded provider timeout/malformed vector/incompatible dimensions produces complete effective legacy retrieval.
4. If legacy parent embeddings also cannot be used, lexical/entity/recency/chronology retrieval still supplies the prompt and records lexical-only with a sanitized fallback.
5. Selected-memory IDs, token budget, and cross-campaign/world-version isolation match the pre-audit behavior.

- [ ] **Step 5: Review the final diff and audit privacy**

Search staged changes for forbidden data paths:

```powershell
rg -n "baseUrl|endpoint|credential|apiKey|rawQuery|rawAction|narration|providerProfileId|fingerprint" packages/contracts/src/memory.ts packages/database/src/chronicle-retrieval-audit.ts packages/database/src/chronicle-context-repository.ts services/runtime/src/generation-executor-adapter.ts apps/web/src/story.js apps/web-next/src/campaign-editor-page.ts
git diff --cached --check
git status --short
```

Manually confirm each match is either an existing non-audit path, an exclusion/assertion, or absent from the persisted/public audit object. Confirm only intended paths are staged and unrelated dirty work remains untouched.

- [ ] **Step 6: Record completion evidence**

Append executed commands, test counts, PostgreSQL database identity, evaluator metrics, rendered UI evidence, exact commits, and any platform skips to `docs/review/chronicle-retrieval-audit-future-enhancement.md`. Do not mark the enhancement implemented until all eight tasks and both UI surfaces pass.

## Completion Criteria

- Every newly accepted generated turn contains a schema-valid `chronicle-retrieval-audit-v1` object written atomically in `model_metadata`.
- Every historical, malformed, or portability-imported turn returns `chronicleRetrieval: null`; neither server nor UI infers historical execution from current configuration or old partial diagnostics.
- The audit independently identifies configured/effective implementation, semantic/lexical use, dedicated/text provider resolution, cache/live query-vector path, call outcome, and sanitized fallback.
- Complete legacy and lexical fallbacks continue working when chunk readiness or embedding calls fail, including long campaigns.
- Earlier accepted turns and corrections retain identical stored rows/`xmin`.
- Both `/story` and `/app/` show recorded and Unknown audit states with the same meaning; root `index.html` is unchanged.
- No new schema migration, provider secret, endpoint, raw prompt/query, memory content, profile ID, fingerprint, or raw error is added to the audit.
- Full check, unit, PostgreSQL integration, build, both evaluators, privacy scan, and rendered UI smoke checks pass.
