import type { MemoryContextQuery } from "../../packages/contracts/src/memory.js";
import type { ChronicleMetricsView, MemoryPublicResult } from "../../packages/application/src/memory/index.js";
import { initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { importLegacyStory as importLegacyStoryApplication } from "../../services/api/src/import-service.js";
import { importInfiniteWorlds as importInfiniteWorldsApplication } from "../../services/api/src/infinite-worlds-import-service.js";
import {
  createOwnerBoundPortableWorldApplicationPort,
  createWorldCampaignApplicationAdapter
} from "../../services/api/src/world-campaign-application-adapter.js";
import { createApiWorldCampaignApplication } from "../../services/runtime/src/world-campaign-composition.js";
import { memoryGeneration } from "./memory-applications.js";
import { apiMemoryApplication, workerMemoryApplication } from "./memory-applications.js";
import type { WorldCampaignApplication } from "../../packages/application/src/world-campaign/index.js";
import type { CampaignBranchRequest, CampaignRewindRequest, PlayerCampaignConfig } from "../../packages/contracts/src/generation.js";
import { apiProviderGraph } from "./provider-application-fixtures.js";

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

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

async function withWorldCampaign<T>(
  pool: DatabasePool,
  operation: (context: Readonly<{
    adapter: ReturnType<typeof createWorldCampaignApplicationAdapter>;
    ownerUserId: string;
  }>) => Promise<T>,
  credentialSecret = "test-credential-secret",
): Promise<Mutable<T>> {
  const ownerUserId = await initialOwnerId(pool);
  const providers = apiProviderGraph(pool, credentialSecret);
  const adapter = createWorldCampaignApplicationAdapter(
    createApiWorldCampaignApplication(pool, providers)
  );
  return structuredClone(await adapter.run(() => operation({ adapter, ownerUserId }))) as Mutable<T>;
}

async function worldVersionScope(
  pool: DatabasePool,
  ownerUserId: string,
  worldVersionId: string,
) {
  const result = await pool.query<{ world_id: string }>(
    "SELECT world_id FROM world_versions WHERE id = $1 AND owner_user_id = $2",
    [worldVersionId, ownerUserId]
  );
  const worldId = result.rows[0]?.world_id;
  if (!worldId) throw Object.assign(new Error("World version not found."), { statusCode: 404 });
  return { ownerUserId, worldId, worldVersionId };
}

export function listWorlds(pool: DatabasePool) {
  return withWorldCampaign(pool, async ({ adapter, ownerUserId }) => (
    await adapter.application.listWorlds(adapter.ownerScope(ownerUserId))
  ).worlds);
}

export function getWorld(pool: DatabasePool, worldId: string) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.getWorld(adapter.worldScope(ownerUserId, worldId)));
}

export function createWorld(pool: DatabasePool, request: Parameters<WorldCampaignApplication["createWorld"]>[1]) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.createWorld(adapter.ownerScope(ownerUserId), request));
}

export function updateWorldDraft(pool: DatabasePool, worldId: string, request: Parameters<WorldCampaignApplication["updateWorldDraft"]>[1]) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.updateWorldDraft(adapter.worldScope(ownerUserId, worldId), request));
}

export function publishWorld(pool: DatabasePool, worldId: string, request: Parameters<WorldCampaignApplication["publishWorld"]>[1]) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.publishWorld(adapter.worldScope(ownerUserId, worldId), request));
}

export function updateWorld(pool: DatabasePool, worldId: string, request: Parameters<WorldCampaignApplication["updateWorldStatus"]>[1]) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.updateWorldStatus(adapter.worldScope(ownerUserId, worldId), request));
}

export function forkWorld(pool: DatabasePool, worldId: string, request: Parameters<WorldCampaignApplication["forkWorld"]>[1]) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.forkWorld(adapter.worldScope(ownerUserId, worldId), request));
}

export function exportWorld(pool: DatabasePool, worldId: string, worldVersionId?: string) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.exportWorld(
    worldVersionId === undefined
      ? adapter.worldScope(ownerUserId, worldId)
      : adapter.worldVersionScope(ownerUserId, worldId, worldVersionId)
  ));
}

export function previewWorldImport(pool: DatabasePool, request: Parameters<WorldCampaignApplication["previewWorldImport"]>[1]) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.previewWorldImport(adapter.ownerScope(ownerUserId), request));
}

export function importWorld(pool: DatabasePool, request: Parameters<WorldCampaignApplication["importWorld"]>[1]) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.importWorld(adapter.ownerScope(ownerUserId), request));
}

export function listCampaigns(pool: DatabasePool) {
  return withWorldCampaign(pool, async ({ adapter, ownerUserId }) => (
    await adapter.application.listCampaigns(adapter.ownerScope(ownerUserId))
  ).campaigns);
}

export function updateCampaign(pool: DatabasePool, campaignId: string, request: Parameters<WorldCampaignApplication["updateCampaign"]>[1]) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.updateCampaign(adapter.campaignScope(ownerUserId, campaignId), request));
}

export function deleteCampaign(pool: DatabasePool, campaignId: string, request: Parameters<WorldCampaignApplication["deleteCampaign"]>[1]) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.deleteCampaign(adapter.campaignScope(ownerUserId, campaignId), request));
}

export function deleteWorld(pool: DatabasePool, worldId: string, request: Parameters<WorldCampaignApplication["deleteWorld"]>[1]) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.deleteWorld(adapter.worldScope(ownerUserId, worldId), request));
}

export function deleteWorldVersion(pool: DatabasePool, worldId: string, worldVersionId: string, request: Parameters<WorldCampaignApplication["deleteWorldVersion"]>[1]) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.deleteWorldVersion(adapter.worldVersionScope(ownerUserId, worldId, worldVersionId), request));
}

export function migrateCampaignWorld(pool: DatabasePool, campaignId: string, request: Parameters<WorldCampaignApplication["migrateCampaignWorldVersion"]>[1]) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.migrateCampaignWorldVersion(adapter.campaignScope(ownerUserId, campaignId), request));
}

export function getWorldVersionPlayableCharacterSummary(pool: DatabasePool, worldVersionId: string) {
  return withWorldCampaign(pool, async ({ adapter, ownerUserId }) => adapter.application.getWorldVersionPlayableCharacterSummary(
    await worldVersionScope(pool, ownerUserId, worldVersionId)
  ));
}

export async function listWorldVersionPlayableCharacters(pool: DatabasePool, worldVersionId: string) {
  return withWorldCampaign(pool, async ({ adapter, ownerUserId }) => adapter.application.listWorldVersionPlayableCharacters(
    await worldVersionScope(pool, ownerUserId, worldVersionId)
  ));
}

export function getCampaignRuntimeState(pool: DatabasePool, campaignId: string, requestedTurnNumber?: number) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.getCampaignRuntimeState(
    adapter.campaignScope(ownerUserId, campaignId),
    requestedTurnNumber
  ));
}

export function getCampaignCharacterProfile(pool: DatabasePool, campaignId: string) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.getCampaignCharacterProfile(adapter.campaignScope(ownerUserId, campaignId)));
}

export function updateCampaignCharacterProfile(pool: DatabasePool, campaignId: string, request: Parameters<WorldCampaignApplication["updateCampaignCharacterProfile"]>[1]) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.updateCampaignCharacterProfile(adapter.campaignScope(ownerUserId, campaignId), request));
}

export function previewCampaignWorldTransfer(pool: DatabasePool, campaignId: string, request: Parameters<WorldCampaignApplication["previewCampaignWorldTransfer"]>[1]) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.previewCampaignWorldTransfer(adapter.campaignScope(ownerUserId, campaignId), request));
}

export function getDashboardStats(pool: DatabasePool) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.getDashboard(adapter.ownerScope(ownerUserId)));
}

export function getSessionUserProfile(pool: DatabasePool) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.getSessionProfile(adapter.ownerScope(ownerUserId)));
}

export function updateSessionUserProfile(pool: DatabasePool, request: Parameters<WorldCampaignApplication["updateSessionProfile"]>[1]) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => adapter.application.updateSessionProfile(adapter.ownerScope(ownerUserId), request));
}

export async function syncPlayerCampaignConfig(pool: DatabasePool, campaignId: string, request: PlayerCampaignConfig) {
  return withWorldCampaign(pool, async ({ adapter, ownerUserId }) => {
    const scope = adapter.campaignScope(ownerUserId, campaignId);
    const state = await adapter.application.getCampaignRuntimeState(scope);
    return adapter.application.syncPlayerCampaignConfig(scope, { ...request, expectedStateRevision: state.revision });
  });
}

export function generateWorldPreview(
  pool: DatabasePool,
  request: Parameters<WorldCampaignApplication["generateWorldPreview"]>[1],
  credentialSecret: string,
) {
  return withWorldCampaign(
    pool,
    ({ adapter, ownerUserId }) => adapter.application.generateWorldPreview(adapter.ownerScope(ownerUserId), request),
    credentialSecret
  );
}

export function getWorldGenerationProgress(pool: DatabasePool, ownerUserId: string, progressKey: string) {
  const providers = apiProviderGraph(pool, "test-credential-secret");
  const adapter = createWorldCampaignApplicationAdapter(
    createApiWorldCampaignApplication(pool, providers)
  );
  return adapter.run(() => adapter.application.getWorldGenerationProgress({ ownerUserId, progressKey }));
}

function requireMemoryResult<T>(result: MemoryPublicResult<T>): T {
  if (typeof result === "object" && result !== null && "failure" in result) {
    throw new Error(result.failure.message);
  }
  return result;
}

export function createCampaign(
  pool: DatabasePool,
  request: Parameters<WorldCampaignApplication["createCampaign"]>[1],
) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => (
    adapter.application.createCampaign(adapter.ownerScope(ownerUserId), request)
  ));
}

export function updateCampaignRuntimeState(
  pool: DatabasePool,
  campaignId: string,
  request: Parameters<WorldCampaignApplication["updateCampaignRuntimeState"]>[1],
) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => (
    adapter.application.updateCampaignRuntimeState(adapter.campaignScope(ownerUserId, campaignId), request)
  ));
}

export function transferCampaignWorld(
  pool: DatabasePool,
  campaignId: string,
  request: Parameters<WorldCampaignApplication["transferCampaignWorld"]>[1],
) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => (
    adapter.application.transferCampaignWorld(adapter.campaignScope(ownerUserId, campaignId), request)
  ));
}

export async function rewindCampaign(
  pool: DatabasePool,
  campaignId: string,
  request: CampaignRewindRequest,
) {
  return withWorldCampaign(pool, async ({ adapter, ownerUserId }) => {
    const scope = adapter.campaignScope(ownerUserId, campaignId);
    const state = await adapter.application.getCampaignRuntimeState(scope);
    return adapter.application.rewindCampaign(scope, {
      ...request,
      expectedCurrentTurnNumber: request.expectedCurrentTurnNumber ?? state.activeTurnNumber,
      expectedStateRevision: state.revision
    });
  });
}

export function branchCampaign(
  pool: DatabasePool,
  campaignId: string,
  request: CampaignBranchRequest,
) {
  return withWorldCampaign(pool, ({ adapter, ownerUserId }) => (
    adapter.application.branchCampaign(adapter.campaignScope(ownerUserId, campaignId), request)
  ));
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
    apiProviderGraph(pool, credentialSecret).infiniteWorlds,
    memoryGeneration(pool),
    portableWorldApplicationForTest(pool, credentialSecret),
    assetStore
  );
}

export function portableWorldApplicationForTest(pool: DatabasePool, credentialSecret: string) {
  const adapter = createWorldCampaignApplicationAdapter(
    createApiWorldCampaignApplication(pool, apiProviderGraph(pool, credentialSecret)),
  );
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
