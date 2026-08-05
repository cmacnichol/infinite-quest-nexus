import type { MemoryContextQuery } from "../../packages/contracts/src/memory.js";
import type { ChronicleMetricsView, MemoryPublicResult } from "../../packages/application/src/memory/index.js";
import { initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { createCampaign as createCampaignApplication } from "../../services/api/src/world-service.js";
import { updateCampaignRuntimeState as updateCampaignRuntimeStateApplication } from "../../services/api/src/campaign-state-service.js";
import { transferCampaignWorld as transferCampaignWorldApplication } from "../../services/api/src/campaign-transfer-service.js";
import { branchCampaign as branchCampaignApplication, rewindCampaign as rewindCampaignApplication } from "../../services/api/src/generation-service.js";
import { importLegacyStory as importLegacyStoryApplication } from "../../services/api/src/import-service.js";
import { importInfiniteWorlds as importInfiniteWorldsApplication } from "../../services/api/src/infinite-worlds-import-service.js";
import {
  createOwnerBoundPortableWorldApplicationPort,
  createWorldCampaignApplicationAdapter
} from "../../services/api/src/world-campaign-application-adapter.js";
import { createApiWorldCampaignApplication } from "../../services/runtime/src/world-campaign-composition.js";
import { memoryGeneration } from "./memory-applications.js";
import { apiMemoryApplication, workerMemoryApplication } from "./memory-applications.js";

async function campaignScope(pool: DatabasePool, campaignId: string, ownerUserId?: string) {
  const resolvedOwnerUserId = ownerUserId ?? await initialOwnerId(pool);
  const result = await pool.query<{ world_version_id: string }>(
    "SELECT world_version_id FROM campaigns WHERE id = $1 AND owner_user_id = $2",
    [campaignId, resolvedOwnerUserId]
  );
  const worldVersionId = result.rows[0]?.world_version_id;
  if (!worldVersionId) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
  return { ownerUserId: resolvedOwnerUserId, campaignId, worldVersionId };
}

function requireMemoryResult<T>(result: MemoryPublicResult<T>): T {
  if (typeof result === "object" && result !== null && "failure" in result) {
    throw new Error(result.failure.message);
  }
  return result;
}

export function createCampaign(
  pool: DatabasePool,
  request: Parameters<typeof createCampaignApplication>[1],
) {
  return createCampaignApplication(pool, request, memoryGeneration(pool));
}

export function updateCampaignRuntimeState(
  pool: DatabasePool,
  campaignId: string,
  request: Parameters<typeof updateCampaignRuntimeStateApplication>[2],
) {
  return updateCampaignRuntimeStateApplication(pool, campaignId, request, memoryGeneration(pool));
}

export function transferCampaignWorld(
  pool: DatabasePool,
  campaignId: string,
  request: Parameters<typeof transferCampaignWorldApplication>[2],
) {
  return transferCampaignWorldApplication(pool, campaignId, request, memoryGeneration(pool));
}

export function rewindCampaign(
  pool: DatabasePool,
  campaignId: string,
  request: Parameters<typeof rewindCampaignApplication>[2],
) {
  return rewindCampaignApplication(pool, campaignId, request, memoryGeneration(pool));
}

export function branchCampaign(
  pool: DatabasePool,
  campaignId: string,
  request: Parameters<typeof branchCampaignApplication>[2],
) {
  return branchCampaignApplication(pool, campaignId, request, memoryGeneration(pool));
}

export function importLegacyStory(
  pool: DatabasePool,
  request: Parameters<typeof importLegacyStoryApplication>[1],
  assetStore?: Parameters<typeof importLegacyStoryApplication>[3],
  legacyAssets?: Parameters<typeof importLegacyStoryApplication>[4],
) {
  return importLegacyStoryApplication(pool, request, memoryGeneration(pool), assetStore, legacyAssets);
}

export function importInfiniteWorlds(
  pool: DatabasePool,
  request: Parameters<typeof importInfiniteWorldsApplication>[1],
  credentialSecret: string,
  assetStore?: Parameters<typeof importInfiniteWorldsApplication>[5],
) {
  return importInfiniteWorldsApplication(
    pool,
    request,
    credentialSecret,
    memoryGeneration(pool),
    portableWorldApplicationForTest(pool, credentialSecret),
    assetStore
  );
}

export function portableWorldApplicationForTest(pool: DatabasePool, credentialSecret: string) {
  const adapter = createWorldCampaignApplicationAdapter(createApiWorldCampaignApplication(pool, { credentialSecret }));
  return createOwnerBoundPortableWorldApplicationPort(
    adapter,
    async () => adapter.ownerScope(await initialOwnerId(pool))
  );
}

export async function getChronicleMetrics(pool: DatabasePool, campaignId: string): Promise<ChronicleMetricsView> {
  const memory = apiMemoryApplication(pool);
  return requireMemoryResult(await memory.getMetrics(await campaignScope(pool, campaignId)));
}

export async function buildContextPreview(
  pool: DatabasePool,
  campaignId: string,
  request: MemoryContextQuery,
  credentialSecret = "test-credential-secret",
  costAttribution: Readonly<{ generationJobId?: string; operation?: "retrieval_embedding" | "context_preview_embedding" }> = {},
  overrides: Readonly<{ throughTurnNumber?: number; stateOverride?: Readonly<Record<string, unknown>>; scratchpadSafeForPrompt?: boolean }> = {},
  ownerUserId?: string,
): Promise<Record<string, any>> {
  const memory = apiMemoryApplication(pool, credentialSecret);
  const scope = await campaignScope(pool, campaignId, ownerUserId);
  const previewRequest = overrides.throughTurnNumber === undefined
    ? request
    : { ...request, throughTurnNumber: overrides.throughTurnNumber };
  if (!overrides.stateOverride && !Object.keys(costAttribution).length) {
    return requireMemoryResult(await memory.previewContext(scope, previewRequest)) as Record<string, any>;
  }
  const result = await withTransaction(pool, (database) => memory.generation.buildContextPreview(database, {
    ...scope,
    request: previewRequest,
    ...overrides,
    costAttribution
  }));
  return requireMemoryResult(result) as Record<string, any>;
}

export async function setCampaignEmbeddingConfig(
  pool: DatabasePool,
  campaignId: string,
  input: Parameters<ReturnType<typeof apiMemoryApplication>["setEmbeddingConfig"]>[1],
) {
  return apiMemoryApplication(pool).setEmbeddingConfig(await campaignScope(pool, campaignId), input);
}

export async function enqueueChronicleReindex(pool: DatabasePool, campaignId: string) {
  const result = await apiMemoryApplication(pool).enqueueChronicleReindex(await campaignScope(pool, campaignId));
  return result.jobId;
}

export async function enqueueEmbeddingReindex(pool: DatabasePool, campaignId: string) {
  const result = await apiMemoryApplication(pool).enqueueEmbeddingReindex(await campaignScope(pool, campaignId));
  return result?.jobId ?? null;
}

export async function rebuildCampaignMemories(pool: DatabasePool, campaignId: string) {
  const scope = await campaignScope(pool, campaignId);
  return withTransaction(pool, (database) => memoryGeneration(pool).rebuildCampaignMemories(database, scope));
}

export function runNextChronicle(
  pool: DatabasePool,
  workerId: string,
  leaseSeconds: number,
  credentialSecret = "test-credential-secret",
) {
  return workerMemoryApplication(pool, credentialSecret).runNextChronicle({
    workerId,
    leaseSeconds,
    retrieval: { batchLimit: 100 }
  });
}
