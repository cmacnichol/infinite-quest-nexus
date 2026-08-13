import { WorldCampaignApplicationError, mapWorldCampaignTransitionFailure } from "./errors.js";
import type { WorldCampaignApplication, WorldCampaignApplicationDependencies } from "./ports.js";
import type {
  AppendCampaignFactInput,
  CampaignDiscoveryPromotionPlan,
  CampaignDiscoveryPromotionRequest,
  CampaignFact,
  CampaignMigrationPlan,
  CampaignMigrationPlanRequest,
  CampaignSyncStatusView,
  CampaignVersionBinding,
  DeepReadonly,
  PublishedWorldVersion,
  ReplaceCampaignFactInput,
  WorldCampaignCommandContext,
  WorldCampaignErrorDetails,
  WorldCampaignReadContext,
  WorldCampaignRepositoryResult,
  WorldDraftAggregate,
  WorldPublicationRequest
} from "./types.js";
import type { OwnerScope } from "../generation/types.js";

const SYNC_TURN_WINDOW_LIMIT = 50;

function success<T>(value: T): WorldCampaignRepositoryResult<T> {
  return { ok: true, value };
}

function failure(
  reason: Parameters<typeof mapWorldCampaignTransitionFailure>[0]["reason"],
  details?: WorldCampaignErrorDetails,
): WorldCampaignRepositoryResult<never> {
  return details === undefined ? { ok: false, failure: { reason } } : { ok: false, failure: { reason, details } };
}

function cloneAndFreeze<T>(value: T): DeepReadonly<T> {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneAndFreeze(item))) as DeepReadonly<T>;
  }
  if (value instanceof Date) {
    return value.toISOString() as DeepReadonly<T>;
  }
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) clone[key] = cloneAndFreeze(item);
    return Object.freeze(clone) as DeepReadonly<T>;
  }
  return value as DeepReadonly<T>;
}

export function publishWorldDraft<Content extends object>(
  draft: WorldDraftAggregate<Content>,
  request: WorldPublicationRequest,
): WorldCampaignRepositoryResult<PublishedWorldVersion<Content>> {
  if (draft.draftRevision !== request.expectedDraftRevision) {
    return failure("draft_revision_changed", {
      expectedDraftRevision: request.expectedDraftRevision,
      actualDraftRevision: draft.draftRevision
    });
  }
  if (draft.publishedVersions.some((version) =>
    version.worldVersionId === request.versionId || version.versionNumber === request.versionNumber)) {
    return failure("version_number_conflict", { versionNumber: request.versionNumber });
  }
  return success(Object.freeze({
    ownerUserId: draft.ownerUserId,
    worldId: draft.worldId,
    worldVersionId: request.versionId,
    versionNumber: request.versionNumber,
    publishedAt: request.publishedAt,
    content: cloneAndFreeze(draft.content)
  }));
}

export function planCampaignWorldVersionMigration(
  campaign: CampaignVersionBinding,
  request: CampaignMigrationPlanRequest,
): WorldCampaignRepositoryResult<CampaignMigrationPlan> {
  if (campaign.worldVersionId !== request.expectedWorldVersionId) {
    return failure("world_version_changed", {
      expectedWorldVersionId: request.expectedWorldVersionId,
      actualWorldVersionId: campaign.worldVersionId
    });
  }
  if (campaign.worldId !== request.targetWorldId) {
    return failure("world_transfer_required", { targetWorldId: request.targetWorldId });
  }
  if (campaign.worldVersionId === request.targetWorldVersionId) {
    return failure("already_on_world_version", { worldVersionId: campaign.worldVersionId });
  }
  return success(Object.freeze({
    ownerUserId: campaign.ownerUserId,
    campaignId: campaign.campaignId,
    sourceWorldVersionId: campaign.worldVersionId,
    targetWorldVersionId: request.targetWorldVersionId,
    activeTurnNumber: campaign.activeTurnNumber,
    stateRevision: campaign.stateRevision,
    note: request.note
  }));
}

export function planCampaignDiscoveryPromotion(
  campaign: CampaignVersionBinding,
  request: CampaignDiscoveryPromotionRequest,
): WorldCampaignRepositoryResult<CampaignDiscoveryPromotionPlan> {
  if (campaign.worldVersionId !== request.expectedWorldVersionId) {
    return failure("promotion_requires_current_version", {
      expectedWorldVersionId: request.expectedWorldVersionId,
      actualWorldVersionId: campaign.worldVersionId
    });
  }
  return success(Object.freeze({
    ownerUserId: campaign.ownerUserId,
    campaignId: campaign.campaignId,
    sourceWorldVersionId: campaign.worldVersionId,
    draftWorldId: request.draftWorldId,
    discoveryFactIds: Object.freeze([...new Set(request.discoveryFactIds)])
  }));
}

export function appendCampaignFact(
  facts: readonly CampaignFact[],
  input: AppendCampaignFactInput,
): WorldCampaignRepositoryResult<readonly CampaignFact[]> {
  if (facts.some((fact) => fact.id === input.id)) return failure("fact_id_conflict", { factId: input.id });
  const appended = Object.freeze({ ...input, replacesFactId: null });
  return success(Object.freeze([...facts, appended]));
}

export function replaceCampaignFact(
  facts: readonly CampaignFact[],
  input: ReplaceCampaignFactInput,
): WorldCampaignRepositoryResult<readonly CampaignFact[]> {
  if (facts.some((fact) => fact.id === input.id)) return failure("fact_id_conflict", { factId: input.id });
  const replaced = facts.find((fact) => fact.id === input.replacesFactId);
  if (replaced === undefined) return failure("fact_not_found", { factId: input.replacesFactId });
  if (replaced.campaignId !== input.campaignId) {
    return failure("fact_campaign_mismatch", { factId: input.replacesFactId });
  }
  if (facts.some((fact) => fact.replacesFactId === input.replacesFactId)) {
    return failure("fact_already_replaced", { factId: input.replacesFactId });
  }
  return success(Object.freeze([...facts, Object.freeze({ ...input })]));
}

function requireOwnerScope(scope: OwnerScope): void {
  if (scope.ownerUserId.trim().length === 0) {
    throw new WorldCampaignApplicationError("invalid_request", "owner_scope_required");
  }
}

function unwrap<T>(result: WorldCampaignRepositoryResult<T>): DeepReadonly<T> {
  if (!result.ok) throw mapWorldCampaignTransitionFailure(result.failure);
  return cloneAndFreeze(result.value);
}

export function createWorldCampaignApplication(
  dependencies: WorldCampaignApplicationDependencies,
): WorldCampaignApplication {
  const read = async <T>(scope: OwnerScope, work: (transaction: WorldCampaignReadContext) => Promise<T>): Promise<DeepReadonly<T>> => {
    requireOwnerScope(scope);
    return cloneAndFreeze(await dependencies.transaction.read(work));
  };
  const command = async <T>(scope: OwnerScope, work: (transaction: WorldCampaignCommandContext) => Promise<T>): Promise<T> => {
    requireOwnerScope(scope);
    return dependencies.transaction.command(work);
  };
  const transition = <T>(scope: OwnerScope, work: (transaction: WorldCampaignCommandContext) => Promise<WorldCampaignRepositoryResult<T>>): Promise<DeepReadonly<T>> =>
    command<WorldCampaignRepositoryResult<T>>(scope, work).then(unwrap);
  const collaborate = async <T>(scope: OwnerScope, work: () => Promise<T>): Promise<DeepReadonly<T>> => {
    requireOwnerScope(scope);
    return cloneAndFreeze(await work());
  };

  return {
    listWorlds: (scope) => read(scope, (database) => dependencies.worlds.listWorlds(database, scope)),
    getWorld: (scope) => read(scope, (database) => dependencies.worlds.getWorld(database, scope)),
    createWorld: (scope, request) => transition(scope, (database) => dependencies.worlds.createWorld(database, scope, request)),
    updateWorldDraft: (scope, request) => transition(scope, (database) => dependencies.worlds.updateWorldDraft(database, scope, request)),
    publishWorld: (scope, request) => transition(scope, (database) => dependencies.worlds.publishWorld(database, scope, request)),
    updateWorldStatus: (scope, request) => transition(scope, (database) => dependencies.worlds.updateWorldStatus(database, scope, request)),
    forkWorld: (scope, request) => transition(scope, (database) => dependencies.worlds.forkWorld(database, scope, request)),
    exportWorld: (scope) => read(scope, (database) => dependencies.worlds.exportWorld(database, scope)),
    previewWorldImport: (scope, request) => read(scope, (database) => dependencies.worlds.previewWorldImport(database, scope, request)),
    importWorld: (scope, request) => transition(scope, (database) => dependencies.worlds.importWorld(database, scope, request)),
    deleteWorld: (scope, request) => transition(scope, (database) => dependencies.worlds.deleteWorld(database, scope, request)),
    deleteWorldVersion: (scope, request) => transition(scope, (database) => dependencies.worlds.deleteWorldVersion(database, scope, request)),
    promoteCampaignDiscoveries: (scope, request) => transition(scope, (database) => dependencies.worlds.promoteCampaignDiscoveries(database, scope, request)),
    listCampaigns: (scope) => read(scope, (database) => dependencies.campaigns.listCampaigns(database, scope)),
    createCampaign: (scope, request) => transition(scope, (database) => dependencies.campaigns.createCampaign(database, scope, request)),
    updateCampaign: (scope, request) => transition(scope, (database) => dependencies.campaigns.updateCampaign(database, scope, request)),
    deleteCampaign: (scope, request) => transition(scope, (database) => dependencies.campaigns.deleteCampaign(database, scope, request)),
    listWorldVersionPlayableCharacters: (scope) => read(scope, (database) => dependencies.campaigns.listWorldVersionPlayableCharacters(database, scope)),
    getWorldVersionPlayableCharacterSummary: (scope) => read(scope, (database) => dependencies.campaigns.getWorldVersionPlayableCharacterSummary(database, scope)),
    migrateCampaignWorldVersion: (scope, request) => transition(scope, (database) => dependencies.campaigns.migrateCampaignWorldVersion(database, scope, request)),
    syncPlayerCampaignConfig: (scope, request) => transition(scope, (database) => dependencies.campaigns.syncPlayerCampaignConfig(database, scope, request)),
    rewindCampaign: (scope, request) => transition(scope, (database) => dependencies.campaigns.rewindCampaign(database, scope, request)),
    branchCampaign: (scope, request) => transition(scope, (database) => dependencies.campaigns.branchCampaign(database, scope, request)),
    loadEffectiveCampaignStateEdit: (scope) => read(scope, (database) => dependencies.state.loadEffectiveCampaignStateEdit(database, scope)),
    getCampaignRuntimeState: (scope, requestedTurnNumber) => read(scope, (database) => dependencies.state.getCampaignRuntimeState(database, scope, requestedTurnNumber)),
    updateCampaignRuntimeState: (scope, request) => transition(scope, (database) => dependencies.state.updateCampaignRuntimeState(database, scope, request)),
    getCampaignSyncStatus: async (scope, request): Promise<CampaignSyncStatusView> => {
      const snapshot = await read(scope, (database) => dependencies.sync.readCampaignSyncSnapshot(database, scope));
      if (request.since === snapshot.syncToken) {
        return cloneAndFreeze({ ...snapshot.projection, syncToken: snapshot.syncToken, turnWindowMode: "unchanged" as const, turns: null });
      }
      const page = await dependencies.turnPages.readTurnPage(scope, { before: undefined, limit: SYNC_TURN_WINDOW_LIMIT });
      return cloneAndFreeze({
        ...snapshot.projection,
        syncToken: snapshot.syncToken,
        turnWindowMode: "replace",
        turns: { campaignId: scope.campaignId, turns: page.turns, nextCursor: page.nextCursor }
      });
    },
    getCampaignCharacterProfile: (scope) => read(scope, (database) => dependencies.characters.getCampaignCharacterProfile(database, scope)),
    updateCampaignCharacterProfile: (scope, request) => transition(scope, (database) => dependencies.characters.updateCampaignCharacterProfile(database, scope, request)),
    organizeCampaignCharacterProfile: (scope, request) => collaborate(scope, () => dependencies.characterOrganizer.organizeCampaignCharacterProfile(scope, request)),
    organizeWorldCharacterProfile: (scope, request) => collaborate(scope, () => dependencies.characterOrganizer.organizeWorldCharacterProfile(scope, request)),
    previewCampaignWorldTransfer: (scope, request) => read(scope, (database) => dependencies.transfers.previewCampaignWorldTransfer(database, scope, request)),
    transferCampaignWorld: (scope, request) => transition(scope, (database) => dependencies.transfers.transferCampaignWorld(database, scope, request)),
    getDashboard: (scope) => read(scope, (database) => dependencies.dashboard.getDashboard(database, scope)),
    getSessionProfile: (scope) => read(scope, (database) => dependencies.sessionProfile.getSessionProfile(database, scope)),
    updateSessionProfile: (scope, request) => transition(scope, (database) => dependencies.sessionProfile.updateSessionProfile(database, scope, request)),
    generateWorldPreview: (scope, request) => collaborate(scope, () => dependencies.worldGeneration.generateWorldPreview(scope, request)),
    generatePlayableCharacterPreview: (scope, request) => collaborate(scope, () => dependencies.worldGeneration.generatePlayableCharacterPreview(scope, request)),
    generatePlayableCharacter: (scope, request) => collaborate(scope, () => dependencies.worldGeneration.generatePlayableCharacter(scope, request)),
    createWorldGenerationProgress: (scope) => transition(scope, (database) => dependencies.progress.createWorldGenerationProgress(database, scope)),
    updateWorldGenerationProgress: (scope, update) => transition(scope, (database) => dependencies.progress.updateWorldGenerationProgress(database, scope, update)),
    getWorldGenerationProgress: (scope) => read(scope, (database) => dependencies.progress.getWorldGenerationProgress(database, scope)),
    deleteExpiredWorldGenerationProgress: (scope, expiredBefore) => transition(scope, (database) => dependencies.progress.deleteExpiredWorldGenerationProgress(database, scope, expiredBefore))
  };
}
