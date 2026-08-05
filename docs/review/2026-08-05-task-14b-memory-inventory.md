# Task 14b1 Chronicle memory inventory

This is the frozen direct-persistence, import, and callback inventory for the
Chronicle/embedding extraction. It is a disposition map, not a production
cutover: Task 14b1 adds only platform-free contracts and tests. Task 14b2 owns
concrete database/runtime bindings and Task 14b3 owns the one atomic consumer
cutover and deletion of `memory-service.ts` callable paths.

## Authoritative domain and boundaries

- Accepted turns and campaign state remain authoritative. `chronicle_memories`,
  `campaign_canonical_facts`, `summary_checkpoints`, and embeddings are derived,
  campaign-scoped indexes that may be rebuilt.
- Every mutable or retrieval operation is owner, campaign, and world-version
  scoped. API owner scope is resolved at Fastify; a worker obtains it solely
  from its claimed Chronicle job. No worker re-resolves the initial user.
- Public preview, metrics, and job reads project only the fixed
  `memory_unavailable` / `Chronicle memory is unavailable.` failure. Raw
  provider endpoint, credential, and diagnostics remain adapter-only logs.
- The accepted-turn transaction is caller owned. 14b2 must bind all five
  Task10d callbacks — including `buildContextPreview` — and the direct
  accepted-turn fiction write to the supplied transaction context without
  beginning another transaction or falling back to a pool. The generation
  context-preview scope carries the resolved owner/campaign/world-version,
  request, replacement snapshot fields, and cost attribution; provider
  credentials remain a runtime binding.

## Task 10d callback inventory

| Current callback | Current binding | 14b1 port | 14b3 disposition |
| --- | --- | --- | --- |
| `autoEnableCampaignEmbeddingIfAvailable` | `generation-worker-composition.ts` | `MemoryGenerationTransactionPort.autoEnableCampaignEmbedding` | Injected memory application replaces temporary callback. |
| `buildContextPreview` | `generation-worker-composition.ts` | `MemoryGenerationTransactionPort.buildContextPreview` | Injected worker memory application replaces temporary callback while preserving the caller-owned context. |
| `enqueueEmbeddingReindex` | `generation-worker-composition.ts` | `MemoryGenerationTransactionPort.enqueueEmbeddingReindex` | Injected memory application replaces temporary callback. |
| `rebuildCampaignMemories` | `generation-worker-composition.ts` and accepted-turn collaborators | `MemoryGenerationTransactionPort.rebuildCampaignMemories` | Injected memory application replaces temporary callback. |
| `storeDerivedTurnMemories` | `generation-worker-composition.ts` and accepted-turn collaborators | `MemoryGenerationTransactionPort.storeDerivedTurnMemories` | Injected memory application replaces temporary callback. |
| `accepted-turn fiction write` | `generation-execution-repository.ts` direct `chronicle_memories` insert | `MemoryGenerationTransactionPort.writeAcceptedTurnFiction` | Move into the 14b2 PostgreSQL transaction adapter; remove direct execution-repository write in 14b3. |

## Exact memory transport inventory

The six `/memory` handlers are exactly:

1. `GET /api/v1/campaigns/:campaignId/memory/metrics`
2. `GET /api/v1/campaigns/:campaignId/memory/context-preview`
3. `POST /api/v1/campaigns/:campaignId/memory/reindex`
4. `GET /api/v1/campaigns/:campaignId/memory/embedding-config`
5. `PUT /api/v1/campaigns/:campaignId/memory/embedding-config`
6. `POST /api/v1/campaigns/:campaignId/memory/embeddings/reindex`

The separate generic Chronicle-job transport handler is exactly
`GET /api/v1/jobs/:jobId`; it is not a seventh `/memory` route. Task 14b3
retains only transport parsing and safe response mapping for all seven handlers.

## Direct Chronicle/config/job/embedding inventory

| Source | Current responsibility | Disposition | Owner |
| --- | --- | --- | --- |
| `services/api/src/memory-service.ts` | configuration, metrics, preview/retrieval, reindex jobs, derived writes, state correction, rebuild, embeddings, worker job loop | Split into 14b2 Chronicle repository/runtime adapters; delete callable service in 14b3 | 14b2/14b3 |
| `services/api/src/server.ts` | six `/memory` transport routes plus generic `GET /api/v1/jobs/:jobId` | Retain transport parsing only; inject memory application in 14b3 | 14b3 |
| `services/worker/src/worker.ts` | `runChronicleJob` cross-role import | Inject `MemoryWorkerApplication`; remove memory allowlist entry | 14b3 |
| `services/runtime/src/generation-worker-composition.ts` | five temporary memory callbacks | Replace in place with runtime composition of memory application | 14b3 |
| `services/runtime/src/generation-executor-adapter.ts` | consumes the five callbacks for prompt retrieval and accepted-turn commit | Replace temporary collaborator fields with injected memory application ports | 14b3 |
| `packages/database/src/generation-execution-repository.ts` | accepted-turn rebuild/derived/fiction persistence | Move the direct fiction operation and callback calls behind supplied transaction port | 14b2/14b3 |
| `services/api/src/generation-service.ts` | branch/rewind rebuild and reindex | Inject named memory application transaction adapter | 14b3 |
| `services/api/src/campaign-state-service.ts` | state correction projection and rebuild | Inject named memory application transaction adapter | 14b3 |
| `services/api/src/campaign-transfer-service.ts` | transfer clone rebuild and embedding reindex | Inject named memory application transaction adapter | 14b3 |
| `services/api/src/import-service.ts` | legacy/archive Chronicle imports and automatic embedding configuration | Direct portable import writes remain 14e-owned; bind only auto-enable through 14b application in 14b3 | 14b3 / 14e |
| `services/api/src/world-service.ts` | campaign create automatic embedding configuration and memory-job deletion blocker | Bind auto-enable through 14b in 14b3; world/campaign responsibility stays 14c | 14b3 / 14c |
| `services/api/src/provider-service.ts` | embedding-provider job/config cleanup | Named provider lifecycle binding; provider profile/credential extraction remains 14d | 14d |
| `services/runtime/src/illustration-resolution-job-adapter.ts` | reads Chronicle entity references while resolving an illustration | Existing 14a-owned bounded read stays an illustration adapter; it must not gain Chronicle writes or provider access | 14a (already complete) |
| `services/api/src/campaign-archive-service.ts` | exports Chronicle memories and summary checkpoints | Read-only archive projection; archive I/O remains 14e | 14e |
| `services/api/src/asset-archive-service.ts` | archive ID kind `memory` provenance | Read-only portable provenance; archive I/O remains 14e | 14e |
| `services/api/src/infinite-worlds-import-service.ts` | no Chronicle persistence found | No move; keep as 14e import consumer audit evidence | 14e |

## 14b2 concrete-adapter acceptance criteria

- `chronicle-repository.ts` performs bounded owner/campaign/world-version reads
  and writes, oldest-first `SKIP LOCKED` claims, one live job per campaign,
  lease heartbeat/reclaim/fencing, work-version requeue, and atomic batch
  progress/cost updates.
- Runtime embedding ports provide profile selection, decrypted profile loading,
  pinned transport/fingerprint, health, cost, and safe logging. A dedicated
  enabled embedding profile wins; text fallback is allowed only when no enabled
  embedding profile exists; image profiles and credentials never participate.
- Rebuilds guard content hash, dimensions, model/provider fingerprint, and
  version. No private scratchpad, mechanics, rejected generation content, raw
  provider diagnostic, endpoint, or credential enters derived memory or an
  embedding input.

## 14b3 removal proof

The cutover must move server, worker, generation, campaign transfer, import,
world, state correction, rewind, and branch consumers in one atomic change.
Then it removes the `memory-service.js` `CROSS_ROLE_IMPORT_ALLOWLIST` entry,
the five temporary callbacks, and every reachable callable legacy memory path.
Task 14b4 verifies this with real Fastify/PostgreSQL routes, lease/race tests,
authority snapshots, import/transfer/rewind/branch rehome tests, and static
no-old-import/no-runtime-to-API audits.
